"""Optional historical hotspot download via the NASA FIRMS area API endpoint."""

import argparse
from collections.abc import Sequence
from datetime import date, datetime, timedelta
import logging
import os
from pathlib import Path
import time

import requests

from pipeline.config import (
    FIRMS_AREA_API_URL_TEMPLATE,
    FIRMS_DEFAULT_AREA,
    FIRMS_DEFAULT_SOURCES,
    FIRMS_MAP_KEY_ENV,
    FIRMS_MAX_DAYS_PER_CALL,
    FIRMS_REQUEST_SLEEP_SEC,
    RAW_DIR,
)

logger = logging.getLogger(__name__)


def get_map_key(explicit_key: str | None = None) -> str | None:
    """Retrieve the NASA FIRMS MAP_KEY from an argument or `FIRMS_MAP_KEY` env var.

    Args:
        explicit_key: Optional explicitly provided API key.

    Returns:
        Trimmed API key string, or None if absent/empty.
    """
    key = explicit_key if explicit_key is not None else os.environ.get(FIRMS_MAP_KEY_ENV)
    if not key:
        return None
    cleaned = key.strip()
    return cleaned if cleaned else None


def iter_date_windows(
    start_date: date,
    end_date: date,
    max_days: int = FIRMS_MAX_DAYS_PER_CALL,
) -> list[tuple[date, int]]:
    """Split a date range into contiguous chunks of at most `max_days` days.

    Args:
        start_date: Inclusive start date.
        end_date: Inclusive end date.
        max_days: Maximum days per API request (clamped to 1..5 per FIRMS spec).

    Returns:
        List of `(window_start_date, day_range)` tuples.
    """
    if end_date < start_date:
        raise ValueError(f"end_date ({end_date}) must be >= start_date ({start_date})")

    step = max(1, min(int(max_days), FIRMS_MAX_DAYS_PER_CALL))
    windows: list[tuple[date, int]] = []
    cur = start_date
    while cur <= end_date:
        remaining = (end_date - cur).days + 1
        span = min(step, remaining)
        windows.append((cur, span))
        cur += timedelta(days=span)
    return windows


def build_area_url(
    map_key: str,
    source: str,
    area: str,
    day_range: int,
    start_date: date | str,
) -> str:
    """Format a NASA FIRMS area CSV request URL.

    Args:
        map_key: NASA FIRMS MAP_KEY.
        source: FIRMS product source (e.g., 'MODIS_NRT', 'VIIRS_NOAA20_NRT').
        area: Area string ('world' or 'west,south,east,north').
        day_range: Number of days (1 to 5).
        start_date: Start date as `date` or 'YYYY-MM-DD' string.

    Returns:
        Formatted FIRMS API URL string.
    """
    if day_range < 1 or day_range > FIRMS_MAX_DAYS_PER_CALL:
        raise ValueError(
            f"day_range must be between 1 and {FIRMS_MAX_DAYS_PER_CALL}, got {day_range}"
        )
    start_str = (
        start_date.strftime("%Y-%m-%d")
        if isinstance(start_date, date)
        else str(start_date)
    )
    return FIRMS_AREA_API_URL_TEMPLATE.format(
        map_key=map_key,
        source=source,
        area=area,
        day_range=day_range,
        start_date=start_str,
    )


def fetch_historical(
    sources: Sequence[str] = FIRMS_DEFAULT_SOURCES,
    area: str = FIRMS_DEFAULT_AREA,
    start_date: date | str | None = None,
    end_date: date | str | None = None,
    output_dir: Path = RAW_DIR,
    map_key: str | None = None,
    sleep_sec: float = FIRMS_REQUEST_SLEEP_SEC,
    timeout_sec: float = 60.0,
) -> list[Path]:
    """Download historical FIRMS CSV data in <=5-day batches.

    If `FIRMS_MAP_KEY` is not set and `map_key` is None, logs a message and
    returns an empty list without raising an exception.

    Args:
        sources: Sequence of FIRMS source identifiers to fetch.
        area: Target bounding box ('west,south,east,north') or 'world'.
        start_date: Inclusive start date (defaults to 5 days ago).
        end_date: Inclusive end date (defaults to today UTC).
        output_dir: Directory where downloaded CSV files are saved.
        map_key: Optional explicit MAP_KEY; falls back to env `FIRMS_MAP_KEY`.
        sleep_sec: Delay in seconds between consecutive API calls (min 1.5 s).
        timeout_sec: HTTP request timeout in seconds.

    Returns:
        List of paths to saved CSV files.
    """
    resolved_key = get_map_key(map_key)
    if not resolved_key:
        logger.warning(
            "Environment variable %s is not set; skipping FIRMS API fetch.",
            FIRMS_MAP_KEY_ENV,
        )
        return []

    today = datetime.utcnow().date()
    end_dt = (
        datetime.strptime(end_date, "%Y-%m-%d").date()
        if isinstance(end_date, str)
        else (end_date or today)
    )
    start_dt = (
        datetime.strptime(start_date, "%Y-%m-%d").date()
        if isinstance(start_date, str)
        else (start_date or (end_dt - timedelta(days=FIRMS_MAX_DAYS_PER_CALL - 1)))
    )

    windows = iter_date_windows(start_dt, end_dt, max_days=FIRMS_MAX_DAYS_PER_CALL)
    output_dir.mkdir(parents=True, exist_ok=True)
    saved_paths: list[Path] = []
    effective_sleep = max(float(sleep_sec), FIRMS_REQUEST_SLEEP_SEC)

    call_idx = 0
    for source in sources:
        for win_start, day_range in windows:
            if call_idx > 0:
                time.sleep(effective_sleep)
            call_idx += 1

            url = build_area_url(
                map_key=resolved_key,
                source=source,
                area=area,
                day_range=day_range,
                start_date=win_start,
            )
            try:
                response = requests.get(url, timeout=timeout_sec)
                response.raise_for_status()
            except requests.RequestException as exc:
                logger.warning(
                    "FIRMS request failed for source=%s start=%s (%d days): %s",
                    source,
                    win_start,
                    day_range,
                    exc,
                )
                continue

            text = response.text.strip()
            lines = text.splitlines()
            if len(lines) <= 1 or "Invalid MAP_KEY" in text:
                logger.warning(
                    "No valid CSV records returned for source=%s start=%s.",
                    source,
                    win_start,
                )
                continue

            safe_area = area.replace(",", "_").replace(" ", "")
            filename = f"{source}_{safe_area}_{win_start.strftime('%Y%m%d')}_{day_range}d.csv"
            out_path = output_dir / filename
            out_path.write_text(text + "\n", encoding="utf-8")
            saved_paths.append(out_path)
            logger.info("Saved %s (%d lines)", out_path, len(lines) - 1)

    return saved_paths


def main(argv: Sequence[str] | None = None) -> int:
    """CLI entry point for optional FIRMS historical data downloads."""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
    )
    parser = argparse.ArgumentParser(
        description="Fetch historical hotspots from NASA FIRMS area API."
    )
    parser.add_argument(
        "--sources",
        nargs="+",
        default=list(FIRMS_DEFAULT_SOURCES),
        help="FIRMS sources to query (e.g. MODIS_NRT VIIRS_NOAA20_NRT).",
    )
    parser.add_argument(
        "--area",
        default=FIRMS_DEFAULT_AREA,
        help="Area ('world' or 'west,south,east,north').",
    )
    parser.add_argument(
        "--start-date",
        default=None,
        help="Start date in YYYY-MM-DD format.",
    )
    parser.add_argument(
        "--end-date",
        default=None,
        help="End date in YYYY-MM-DD format.",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=RAW_DIR,
        help="Directory to write downloaded CSV files.",
    )
    args = parser.parse_args(argv)

    saved = fetch_historical(
        sources=args.sources,
        area=args.area,
        start_date=args.start_date,
        end_date=args.end_date,
        output_dir=args.output_dir,
    )
    logger.info("Fetch complete. Files downloaded: %d", len(saved))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
