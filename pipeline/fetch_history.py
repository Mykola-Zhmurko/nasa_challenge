"""Historical hotspot downloader for the NASA FIRMS area API."""

import argparse
from collections.abc import Sequence
import csv
from datetime import date, datetime, timedelta, timezone
import gzip
import logging
import os
from pathlib import Path
import re
import sys
import time

import requests

logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent.parent
ENV_PATH = BASE_DIR / ".env"
HISTORY_DIR = BASE_DIR / "data" / "history"
DONE_DIR = HISTORY_DIR / ".done"

FIRMS_MAP_KEY_ENV = "FIRMS_MAP_KEY"
DEFAULT_SOURCES = "MODIS_SP,VIIRS_SNPP_SP,VIIRS_NOAA20_SP"
DEFAULT_START = "2001-01-01"
DEFAULT_END = "today"
DEFAULT_BBOX = "-25,34,45,72"

CHUNK_DAYS = 5
REQUEST_SLEEP_SEC = 3.0
MAX_RETRIES = 3
RETRY_BACKOFF_SEC = 5.0
RATE_LIMIT_MAX_RETRIES = 8
RATE_LIMIT_BASE_SLEEP_SEC = 60
RATE_LIMIT_MAX_SLEEP_SEC = 300
REQUEST_TIMEOUT_SEC = 60.0


def _redact(text: str, key: str) -> str:
    """Remove any occurrence of the API key from log or error messages."""
    if not key:
        return text
    return text.replace(key, "***")


def load_map_key(env_path: Path = ENV_PATH) -> str:
    """Load FIRMS_MAP_KEY from environment or project .env without printing it."""
    env_val = os.environ.get(FIRMS_MAP_KEY_ENV, "").strip()
    if env_val:
        return env_val

    if env_path.exists():
        try:
            for raw_line in env_path.read_text(encoding="utf-8").splitlines():
                line = raw_line.strip()
                if not line or line.startswith("#"):
                    continue
                if line.startswith("export "):
                    line = line[len("export ") :].strip()
                if "=" not in line:
                    continue
                k, v = line.split("=", 1)
                if k.strip() == FIRMS_MAP_KEY_ENV:
                    cleaned = v.strip().strip("\"'").strip()
                    if cleaned:
                        return cleaned
        except OSError as exc:
            raise RuntimeError(f"Failed to read {env_path}: {exc}") from exc

    raise RuntimeError(
        f"{FIRMS_MAP_KEY_ENV} not found in environment or {env_path}"
    )


def parse_date_arg(value: str) -> date:
    """Parse 'today' or a YYYY-MM-DD date string."""
    cleaned = value.strip().lower()
    if cleaned == "today":
        return datetime.now(timezone.utc).date()
    return datetime.strptime(cleaned, "%Y-%m-%d").date()


def parse_sources_arg(raw_sources: str | Sequence[str]) -> list[str]:
    """Parse comma- or space-separated FIRMS source names."""
    if isinstance(raw_sources, str):
        tokens = [raw_sources]
    else:
        tokens = list(raw_sources)
    sources: list[str] = []
    for token in tokens:
        for part in token.split(","):
            s = part.strip()
            if s and s not in sources:
                sources.append(s)
    if not sources:
        raise ValueError("At least one FIRMS source must be specified.")
    return sources


def iter_year_chunks(
    year_start: date,
    year_end: date,
    chunk_days: int = CHUNK_DAYS,
) -> list[tuple[date, int]]:
    """Split [year_start, year_end] into contiguous windows of up to chunk_days."""
    windows: list[tuple[date, int]] = []
    cur = year_start
    while cur <= year_end:
        remaining = (year_end - cur).days + 1
        span = min(chunk_days, remaining)
        windows.append((cur, span))
        cur += timedelta(days=span)
    return windows


def inspect_partial_year_file(
    year_file: Path,
) -> tuple[bool, int, date | None]:
    """Inspect an existing incomplete year .csv.gz file for safe mid-year resume.

    Returns:
        Tuple of (has_header, row_count, max_acq_date).
        If the file is empty or corrupted, removes it and returns (False, 0, None).
    """
    if not year_file.exists():
        return False, 0, None

    try:
        with gzip.open(year_file, "rt", encoding="utf-8", newline="") as gz:
            first_line = gz.readline().rstrip("\r\n")
            if not first_line:
                year_file.unlink(missing_ok=True)
                return False, 0, None

            header_cols = next(csv.reader([first_line]))
            if "latitude" not in header_cols or "acq_date" not in header_cols:
                year_file.unlink(missing_ok=True)
                return False, 0, None

            acq_idx = header_cols.index("acq_date")
            max_dt: date | None = None
            data_count = 0
            for raw_line in gz:
                row_line = raw_line.rstrip("\r\n")
                if not row_line:
                    continue
                fields = next(csv.reader([row_line]))
                if len(fields) <= acq_idx:
                    continue
                dt = datetime.strptime(fields[acq_idx].strip(), "%Y-%m-%d").date()
                if max_dt is None or dt > max_dt:
                    max_dt = dt
                data_count += 1
    except (EOFError, gzip.BadGzipFile, OSError, UnicodeDecodeError, csv.Error, ValueError):
        year_file.unlink(missing_ok=True)
        return False, 0, None

    return True, data_count, max_dt


def fetch_chunk_csv(
    session: requests.Session,
    map_key: str,
    source: str,
    bbox: str,
    day_range: int,
    start_date: date,
) -> list[str] | None:
    """Fetch a single 5-day chunk from the FIRMS area API with retries and backoff.

    Returns:
        List of non-empty CSV lines (index 0 is header), or None if skipped due to error.
    """
    url = (
        f"https://firms.modaps.eosdis.nasa.gov/api/area/csv/"
        f"{map_key}/{source}/{bbox}/{day_range}/{start_date.isoformat()}"
    )

    attempt = 0
    rate_limit_retries = 0
    while True:
        try:
            resp = session.get(url, timeout=REQUEST_TIMEOUT_SEC)
        except requests.RequestException as exc:
            safe_err = _redact(str(exc), map_key)
            if attempt < MAX_RETRIES:
                attempt += 1
                logger.warning(
                    "Network error on %s %s (attempt %d/%d), retrying in %.1fs: %s",
                    source,
                    start_date,
                    attempt,
                    MAX_RETRIES + 1,
                    RETRY_BACKOFF_SEC,
                    safe_err,
                )
                time.sleep(RETRY_BACKOFF_SEC)
                continue
            logger.error(
                "Skipping chunk %s %s after %d retries due to network error: %s",
                source,
                start_date,
                MAX_RETRIES,
                safe_err,
            )
            return None

        status = resp.status_code
        if 400 <= status < 500:
            body = resp.text or ""
            if status == 429 or "transaction limit" in body.lower():
                if rate_limit_retries < RATE_LIMIT_MAX_RETRIES:
                    rate_limit_retries += 1
                    wait_sec = min(
                        RATE_LIMIT_BASE_SLEEP_SEC * rate_limit_retries,
                        RATE_LIMIT_MAX_SLEEP_SEC,
                    )
                    logger.warning(
                        "rate limit on %s %s, waiting %ds (try %d/%d)",
                        source,
                        start_date,
                        wait_sec,
                        rate_limit_retries,
                        RATE_LIMIT_MAX_RETRIES,
                    )
                    time.sleep(wait_sec)
                    continue
                logger.error(
                    "Skipping chunk %s %s after %d rate-limit retries (HTTP %d).",
                    source,
                    start_date,
                    RATE_LIMIT_MAX_RETRIES,
                    status,
                )
                return None

            logger.warning(
                "HTTP %d on %s %s (%d days); skipping chunk.",
                status,
                source,
                start_date,
                day_range,
            )
            return None

        if status >= 500:
            if attempt < MAX_RETRIES:
                attempt += 1
                logger.warning(
                    "HTTP %d on %s %s (attempt %d/%d), retrying in %.1fs.",
                    status,
                    source,
                    start_date,
                    attempt,
                    MAX_RETRIES + 1,
                    RETRY_BACKOFF_SEC,
                )
                time.sleep(RETRY_BACKOFF_SEC)
                continue
            logger.error(
                "Skipping chunk %s %s after %d retries due to HTTP %d.",
                source,
                start_date,
                MAX_RETRIES,
                status,
            )
            return None

        text = resp.text.strip()
        if not text:
            return []

        if "Invalid MAP_KEY" in text or "Exceeding" in text:
            safe_msg = _redact(text.splitlines()[0][:120], map_key)
            logger.error(
                "API error response for %s %s: %s",
                source,
                start_date,
                safe_msg,
            )
            return None

        lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
        if not lines or "," not in lines[0]:
            logger.warning(
                "Unexpected non-CSV response for %s %s; skipping chunk.",
                source,
                start_date,
            )
            return None

        return lines


def download_history(
    sources: Sequence[str],
    start_date: date,
    end_date: date,
    bbox: str = DEFAULT_BBOX,
    history_dir: Path = HISTORY_DIR,
    done_dir: Path = DONE_DIR,
    map_key: str | None = None,
) -> tuple[int, int]:
    """Download FIRMS historical hotspots per source and per year.

    Returns:
        Tuple of (total_rows_written, files_written).
    """
    if end_date < start_date:
        raise ValueError(f"end_date ({end_date}) must be >= start_date ({start_date})")

    resolved_key = map_key if map_key is not None else load_map_key()
    history_dir.mkdir(parents=True, exist_ok=True)
    done_dir.mkdir(parents=True, exist_ok=True)

    total_rows = 0
    files_written = 0
    request_count = 0
    interrupted = False

    session = requests.Session()
    try:
        for source in sources:
            if interrupted:
                break

            for year in range(start_date.year, end_date.year + 1):
                if interrupted:
                    break

                year_file = history_dir / f"{source}_{year}.csv.gz"
                done_marker = done_dir / f"{source}_{year}"

                # RESUME: skip year if both year file and .done marker exist
                if year_file.exists() and done_marker.exists():
                    continue

                year_t0 = time.monotonic()
                year_start = max(start_date, date(year, 1, 1))
                year_end = min(end_date, date(year, 12, 31))
                chunks = iter_year_chunks(year_start, year_end, CHUNK_DAYS)

                has_header, existing_rows, max_acq_date = (
                    inspect_partial_year_file(year_file)
                )
                year_rows = existing_rows
                last_seen_header: str | None = None
                gz_handle = None

                try:
                    for chunk_start, day_range in chunks:
                        if max_acq_date is not None and chunk_start <= max_acq_date:
                            continue

                        try:
                            if request_count > 0:
                                time.sleep(REQUEST_SLEEP_SEC)
                            request_count += 1

                            lines = fetch_chunk_csv(
                                session=session,
                                map_key=resolved_key,
                                source=source,
                                bbox=bbox,
                                day_range=day_range,
                                start_date=chunk_start,
                            )
                        except KeyboardInterrupt:
                            interrupted = True
                            break

                        if not lines:
                            continue

                        header_line = lines[0]
                        last_seen_header = header_line
                        data_lines = lines[1:]
                        if not data_lines:
                            continue

                        # Defer KeyboardInterrupt while writing the fetched chunk
                        stop_after_write = False
                        try:
                            if gz_handle is None:
                                mode = "at" if has_header else "wt"
                                gz_handle = gzip.open(
                                    year_file, mode, encoding="utf-8", newline="\n"
                                )
                            if not has_header:
                                gz_handle.write(header_line + "\n")
                                has_header = True
                            gz_handle.write("\n".join(data_lines) + "\n")
                            gz_handle.flush()
                            chunk_row_count = len(data_lines)
                            year_rows += chunk_row_count
                            total_rows += chunk_row_count
                        except KeyboardInterrupt:
                            stop_after_write = True
                        if stop_after_write:
                            interrupted = True
                            break

                    if not interrupted and not has_header and not year_file.exists():
                        with gzip.open(
                            year_file, "wt", encoding="utf-8", newline="\n"
                        ) as empty_gz:
                            if last_seen_header:
                                empty_gz.write(last_seen_header + "\n")
                finally:
                    if gz_handle is not None:
                        gz_handle.close()

                if interrupted:
                    logger.info(
                        "Interrupted during %s %d; flushed %d rows to %s.",
                        source,
                        year,
                        year_rows,
                        year_file,
                    )
                    break

                done_marker.write_text(f"rows={year_rows}\n", encoding="utf-8")
                files_written += 1
                year_elapsed = time.monotonic() - year_t0
                print(
                    f"{source} {year} rows={year_rows} elapsed={year_elapsed:.1f}s",
                    flush=True,
                )
    finally:
        session.close()

    print(
        f"Summary: total_rows={total_rows} files_written={files_written}",
        flush=True,
    )
    return total_rows, files_written


def build_arg_parser() -> argparse.ArgumentParser:
    """Create CLI argument parser for pipeline.fetch_history."""
    parser = argparse.ArgumentParser(
        description="Download multi-year NASA FIRMS hotspot history into gzipped yearly CSVs."
    )
    # Allow negative coordinates in --bbox -25,34,45,72 without requiring '='
    parser._negative_number_matcher = re.compile(r"^-\d")
    parser.add_argument(
        "--sources",
        default=DEFAULT_SOURCES,
        help=f"Comma-separated FIRMS sources (default: {DEFAULT_SOURCES}).",
    )
    parser.add_argument(
        "--start",
        default=DEFAULT_START,
        help=f"Inclusive start date YYYY-MM-DD (default: {DEFAULT_START}).",
    )
    parser.add_argument(
        "--end",
        default=DEFAULT_END,
        help=f"Inclusive end date YYYY-MM-DD or 'today' (default: {DEFAULT_END}).",
    )
    parser.add_argument(
        "--bbox",
        default=DEFAULT_BBOX,
        help=f"Bounding box WEST,SOUTH,EAST,NORTH (default: {DEFAULT_BBOX}).",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """CLI entry point."""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        stream=sys.stderr,
    )
    parser = build_arg_parser()
    args = parser.parse_args(argv)

    try:
        sources = parse_sources_arg(args.sources)
        start_date = parse_date_arg(args.start)
        end_date = parse_date_arg(args.end)
        bbox = args.bbox.strip()
        download_history(
            sources=sources,
            start_date=start_date,
            end_date=end_date,
            bbox=bbox,
        )
    except KeyboardInterrupt:
        return 0
    except Exception as exc:
        logger.error("%s", exc)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
