"""CLI pipeline builder: harmonize -> enrich -> dedupe -> Parquet & DuckDB."""

import argparse
from collections.abc import Sequence
from dataclasses import dataclass, field
import gc
import os
from pathlib import Path
import resource
import shutil
from typing import Any, Final
import zlib

import duckdb
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

from pipeline.config import (
    CSV_CHUNK_SIZE,
    DUCKDB_PATH,
    ENRICHED_COLUMNS,
    FIRES_TABLE_COLUMNS,
    H3_RESOLUTION,
    HISTORY_DIR,
    MODIS_MIN_CONFIDENCE,
    PARQUET_PATH,
    RAW_DIR,
    SOURCE_MASK_MODIS,
    SOURCE_MASK_VIIRS,
)
from pipeline.dedupe import dedupe_dataframe
from pipeline.enrich import enrich_dataframe
from pipeline.harmonize import HarmonizeStats, iter_harmonized_csv


@dataclass
class BuildSummary:
    """Verification metrics collected during a pipeline build run."""

    files_processed: int = 0
    rows_in: int = 0
    rows_after_valid_coords_ts: int = 0
    rows_after_confidence: int = 0
    rows_out: int = 0
    min_ts: str | None = None
    max_ts: str | None = None
    counts_per_sensor: dict[str, int] = field(default_factory=dict)
    counts_per_sources_mask: dict[int, int] = field(default_factory=dict)
    distinct_h3_cells: int = 0
    top_months: list[tuple[int, int, float]] = field(default_factory=list)
    peak_rss_mb: float = 0.0


def get_peak_rss_mb() -> float:
    """Return peak resident set size (RSS) of the current process in MiB."""
    ru = resource.getrusage(resource.RUSAGE_SELF)
    # On Linux ru_maxrss is reported in kilobytes.
    return ru.ru_maxrss / 1024.0


def process_raw_csvs(
    raw_dir: Path = RAW_DIR,
    chunk_size: int = CSV_CHUNK_SIZE,
    h3_res: int = H3_RESOLUTION,
) -> tuple[pd.DataFrame, HarmonizeStats, int]:
    """Read all CSVs in `raw_dir` in chunks, harmonize, enrich, and deduplicate.

    Each chunk is harmonized, enriched with H3 resolution-8 cells and calendar
    fields, and pre-deduplicated in memory before final cross-file deduplication
    to keep peak RSS well below 400 MB.

    Args:
        raw_dir: Directory containing raw FIRMS CSV files.
        chunk_size: Number of CSV rows per chunk.
        h3_res: H3 resolution (default 8).

    Returns:
        Tuple of `(deduped_dataframe, harmonize_stats, num_files)`.
    """
    csv_files = sorted(raw_dir.glob("*.csv"))
    stats = HarmonizeStats()
    partial_frames: list[pd.DataFrame] = []

    for csv_path in csv_files:
        for harm_chunk in iter_harmonized_csv(
            csv_path, chunk_size=chunk_size, stats=stats
        ):
            enriched_chunk = enrich_dataframe(harm_chunk, res=h3_res)
            deduped_chunk = dedupe_dataframe(enriched_chunk)
            partial_frames.append(deduped_chunk)

    if not partial_frames:
        empty = pd.DataFrame(
            columns=list(ENRICHED_COLUMNS) + ["sources"]
        )
        return empty, stats, len(csv_files)

    combined = pd.concat(partial_frames, ignore_index=True)
    del partial_frames
    gc.collect()

    deduped = dedupe_dataframe(combined)
    del combined
    gc.collect()

    # Order columns cleanly with FIRES_TABLE_COLUMNS first, followed by calendar cols
    front_cols = [c for c in FIRES_TABLE_COLUMNS if c in deduped.columns]
    extra_cols = [c for c in deduped.columns if c not in front_cols]
    deduped = deduped[front_cols + extra_cols]
    return deduped, stats, len(csv_files)


def write_parquet_atomic(df: pd.DataFrame, parquet_path: Path = PARQUET_PATH) -> None:
    """Write the deduplicated fires dataframe to Parquet atomically.

    Args:
        df: Deduplicated hotspot dataframe.
        parquet_path: Destination `.parquet` file path.
    """
    parquet_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = parquet_path.with_suffix(".parquet.tmp")
    if tmp_path.exists():
        tmp_path.unlink()

    table = pa.Table.from_pandas(df, preserve_index=False)
    pq.write_table(table, tmp_path, compression="zstd")
    tmp_path.replace(parquet_path)


def _salvage_gzip_stream(gz_path: Path, dest_csv: Path) -> bool:
    """Stream-decompress complete lines from a possibly-incomplete .csv.gz file in 64 KB chunks."""
    decompressor = zlib.decompressobj(16 + zlib.MAX_WBITS)
    remainder = b""
    wrote_any = False
    try:
        with gz_path.open("rb") as src, dest_csv.open("wb") as dst:
            while True:
                chunk = src.read(65536)
                if not chunk:
                    break
                try:
                    data = decompressor.decompress(chunk)
                except zlib.error:
                    break
                if not data:
                    continue
                buf = remainder + data
                last_nl = buf.rfind(b"\n")
                if last_nl >= 0:
                    dst.write(buf[: last_nl + 1])
                    remainder = buf[last_nl + 1 :]
                    wrote_any = True
                else:
                    remainder = buf
                if decompressor.unused_data:
                    # Handle concatenated gzip members if present
                    unused = decompressor.unused_data
                    decompressor = zlib.decompressobj(16 + zlib.MAX_WBITS)
                    try:
                        extra = decompressor.decompress(unused)
                    except zlib.error:
                        break
                    if extra:
                        buf2 = remainder + extra
                        last_nl2 = buf2.rfind(b"\n")
                        if last_nl2 >= 0:
                            dst.write(buf2[: last_nl2 + 1])
                            remainder = buf2[last_nl2 + 1 :]
                            wrote_any = True
                        else:
                            remainder = buf2
    except OSError:
        return wrote_any
    return wrote_any


def _prepare_history_files_sql(
    con: duckdb.DuckDBPyConnection,
    history_dir: Path | None,
    spill_dir: Path,
) -> tuple[list[str], int]:
    """Return SQL-ready file paths for `data/history/*.csv.gz` and count of files."""
    if history_dir is None or not history_dir.exists() or not history_dir.is_dir():
        return [], 0

    gz_files = sorted(
        p for p in history_dir.glob("*.csv.gz") if p.is_file() and p.stat().st_size > 20
    )
    if not gz_files:
        return [], 0

    done_dir = history_dir / ".done"
    usable_paths: list[str] = []
    for p in gz_files:
        stem = p.name[:-7] if p.name.endswith(".csv.gz") else p.stem
        is_marked_done = not done_dir.exists() or (done_dir / stem).exists()
        if is_marked_done:
            try:
                con.execute(
                    "SELECT COUNT(*) FROM read_csv_auto(?, union_by_name=true, filename=true, all_varchar=true, ignore_errors=true)",
                    [[str(p)]],
                ).fetchone()
                usable_paths.append(str(p))
                continue
            except duckdb.Error:
                pass

        # File is mid-download or missing gzip trailer: salvage complete lines in chunks
        spill_dir.mkdir(parents=True, exist_ok=True)
        salvaged_name = p.name[:-3] if p.name.endswith(".gz") else f"{p.name}.csv"
        salvaged_path = spill_dir / salvaged_name
        if _salvage_gzip_stream(p, salvaged_path) and salvaged_path.stat().st_size > 0:
            try:
                con.execute(
                    "SELECT COUNT(*) FROM read_csv_auto(?, union_by_name=true, filename=true, all_varchar=true, ignore_errors=true)",
                    [[str(salvaged_path)]],
                ).fetchone()
                usable_paths.append(str(salvaged_path))
            except duckdb.Error:
                pass

    return usable_paths, len(usable_paths)


HISTORY_STAGE_BATCH: Final[int] = 4


def _history_stage_select_sql() -> str:
    """Return the staging SELECT over one batch of history CSVs (single `?` parameter)."""
    return f"""
                SELECT
                    sensor,
                    ts_val AS ts,
                    lat_val AS lat,
                    lon_val AS lon,
                    (
                        lat_val IS NOT NULL
                        AND lon_val IS NOT NULL
                        AND ts_val IS NOT NULL
                        AND lat_val >= -90.0
                        AND lat_val <= 90.0
                        AND lon_val >= -180.0
                        AND lon_val <= 180.0
                    ) AS valid_coords_ts,
                    CASE
                        WHEN sensor = 'VIIRS' THEN
                            CASE
                                WHEN LOWER(TRIM(conf_str)) IN ('nominal', 'n') THEN 50
                                WHEN LOWER(TRIM(conf_str)) IN ('high', 'h') THEN 90
                                WHEN TRY_CAST(conf_str AS DOUBLE) = 50 THEN 50
                                WHEN TRY_CAST(conf_str AS DOUBLE) = 90 THEN 90
                                ELSE NULL
                            END
                        ELSE
                            CASE
                                WHEN TRY_CAST(conf_str AS DOUBLE) >= {MODIS_MIN_CONFIDENCE}
                                 AND TRY_CAST(conf_str AS DOUBLE) <= 100
                                THEN CAST(TRY_CAST(conf_str AS DOUBLE) AS INTEGER)
                                ELSE NULL
                            END
                    END AS confidence_pct,
                    sat_val AS satellite,
                    frp_val AS frp_mw,
                    dn_val AS daynight
                FROM (
                    SELECT
                        CASE
                            WHEN UPPER(filename) LIKE '%VIIRS%'
                              OR UPPER(filename) LIKE '%J1%'
                              OR UPPER(filename) LIKE '%SNPP%' THEN 'VIIRS'
                            WHEN UPPER(filename) LIKE '%MODIS%' THEN 'MODIS'
                            WHEN LOWER(TRIM(CAST(confidence AS VARCHAR))) IN ('low', 'nominal', 'high', 'l', 'n', 'h') THEN 'VIIRS'
                            ELSE 'MODIS'
                        END AS sensor,
                        TRY_CAST(latitude AS DOUBLE) AS lat_val,
                        TRY_CAST(longitude AS DOUBLE) AS lon_val,
                        COALESCE(
                            TRY_CAST(acq_date AS DATE),
                            TRY_CAST(TRY_STRPTIME(TRIM(CAST(acq_date AS VARCHAR)), '%Y-%m-%d') AS DATE)
                        ) AS ts_val,
                        CAST(confidence AS VARCHAR) AS conf_str,
                        COALESCE(TRIM(CAST(satellite AS VARCHAR)), '') AS sat_val,
                        COALESCE(TRY_CAST(frp AS DOUBLE), 0.0) AS frp_val,
                        UPPER(COALESCE(TRIM(CAST(daynight AS VARCHAR)), '')) AS dn_val
                    FROM read_csv_auto(
                        ?,
                        union_by_name=true,
                        filename=true,
                        all_varchar=true,
                        ignore_errors=true
                    )
                )
    """


def _stage_history_batches(
    con: duckdb.DuckDBPyConnection,
    history_paths: list[str],
    batch_size: int = HISTORY_STAGE_BATCH,
) -> None:
    """Stage history CSVs into `_hist_staged` in small batches.

    Reading all year files in one `read_csv_auto` call allocates per-file reader
    buffers at once and ran out of memory on a 2 GB VPS; four files per batch stay
    well inside the limit and the result is identical.
    """
    select_sql = _history_stage_select_sql()
    for start in range(0, len(history_paths), batch_size):
        batch = history_paths[start : start + batch_size]
        prefix = "CREATE TEMP TABLE _hist_staged AS" if start == 0 else "INSERT INTO _hist_staged"
        con.execute(f"{prefix} {select_sql}", [batch])


def build_duckdb(
    parquet_path: Path = PARQUET_PATH,
    duckdb_path: Path = DUCKDB_PATH,
    history_dir: Path | None = HISTORY_DIR,
) -> tuple[BuildSummary, HarmonizeStats, int]:
    """Build `data/fires.duckdb` tables from `data/fires.parquet` + `data/history/*.csv.gz`.

    Creates tables:
    - `fires(h3_r8, ts, sensor, satellite, lat, lon, confidence_pct, frp_mw, daynight, sources)`
    - `calendar_monthly(h3_r8, year, month, detections, mean_frp)`
    - `calendar_median(h3_r8, month, median_detections)`
    - `calendar_global(month, detections, mean_frp)`

    Args:
        parquet_path: Input/output Parquet file path.
        duckdb_path: Output DuckDB file path.
        history_dir: Optional directory containing historical `.csv.gz` FIRMS files.

    Returns:
        Tuple of `(BuildSummary, history_harmonize_stats, history_files_count)`.
    """
    duckdb_path.parent.mkdir(parents=True, exist_ok=True)
    pid = os.getpid()
    tmp_db_path = duckdb_path.with_name(f"{duckdb_path.name}.{pid}.tmp")
    tmp_wal_path = Path(f"{tmp_db_path}.wal")
    tmp_spill_dir = duckdb_path.parent / f".{duckdb_path.name}.spill-{pid}.tmp"
    for p in (tmp_db_path, tmp_wal_path):
        if p.exists():
            p.unlink()
    if tmp_spill_dir.exists():
        shutil.rmtree(tmp_spill_dir, ignore_errors=True)

    hist_stats = HarmonizeStats()
    hist_files_count = 0

    con = duckdb.connect(str(tmp_db_path))
    try:
        # Staging the whole history (about 20M rows) does not fit in 256 MB; the
        # limit stays overridable so a smaller VPS can lower it again.
        memory_limit = os.environ.get("BUILD_MEMORY_LIMIT", "700MB")
        con.execute(f"SET memory_limit='{memory_limit}'")
        con.execute("SET threads=2")
        con.execute("SET preserve_insertion_order=false")
        con.execute(f"SET temp_directory='{str(tmp_spill_dir).replace(chr(39), chr(39)*2)}'")
        try:
            con.execute("LOAD h3")
        except duckdb.Error:
            con.execute("INSTALL h3 FROM community")
            con.execute("LOAD h3")

        # Provide convenience alias macro h3_to_parent -> h3_cell_to_parent per SPEC
        con.execute(
            "CREATE OR REPLACE MACRO h3_to_parent(cell, res) AS h3_cell_to_parent(cell, res)"
        )

        parquet_sql_path = str(parquet_path).replace("'", "''")
        history_paths, hist_files_count = _prepare_history_files_sql(
            con, history_dir, tmp_spill_dir
        )

        if history_paths:
            # Stage history CSVs via streaming DuckDB read_csv_auto with union_by_name
            _stage_history_batches(con, history_paths)

            h_counts = con.execute(
                """
                SELECT
                    COUNT(*) AS rows_in,
                    COUNT(*) FILTER (WHERE valid_coords_ts) AS rows_valid,
                    COUNT(*) FILTER (WHERE valid_coords_ts AND confidence_pct IS NOT NULL) AS rows_conf
                FROM _hist_staged
                """
            ).fetchone()
            if h_counts:
                hist_stats.rows_in = int(h_counts[0] or 0)
                hist_stats.rows_after_valid_coords_ts = int(h_counts[1] or 0)
                hist_stats.rows_after_confidence = int(h_counts[2] or 0)

            con.execute(
                f"""
                CREATE OR REPLACE TABLE fires AS
                SELECT
                    h3_r8,
                    ts,
                    winner.sensor AS sensor,
                    winner.satellite AS satellite,
                    winner.lat AS lat,
                    winner.lon AS lon,
                    winner.confidence_pct AS confidence_pct,
                    winner.frp_mw AS frp_mw,
                    winner.daynight AS daynight,
                    sources
                FROM (
                    SELECT
                        h3_r8,
                        ts,
                        ARG_MAX(
                            {{
                                sensor: sensor,
                                satellite: satellite,
                                lat: lat,
                                lon: lon,
                                confidence_pct: confidence_pct,
                                frp_mw: frp_mw,
                                daynight: daynight
                            }},
                            {{
                                c: confidence_pct,
                                f: frp_mw,
                                s: CASE WHEN sensor = 'MODIS' THEN 2 ELSE 1 END
                            }}
                        ) AS winner,
                        CAST(BIT_OR(sources) AS INTEGER) AS sources
                    FROM (
                        SELECT
                            CAST(h3_r8 AS BIGINT) AS h3_r8,
                            CAST(ts AS DATE) AS ts,
                            CAST(sensor AS VARCHAR) AS sensor,
                            CAST(satellite AS VARCHAR) AS satellite,
                            CAST(lat AS DOUBLE) AS lat,
                            CAST(lon AS DOUBLE) AS lon,
                            CAST(confidence_pct AS INTEGER) AS confidence_pct,
                            CAST(frp_mw AS DOUBLE) AS frp_mw,
                            CAST(daynight AS VARCHAR) AS daynight,
                            CAST(sources AS INTEGER) AS sources
                        FROM read_parquet('{parquet_sql_path}')
                        UNION ALL
                        SELECT
                            CAST(h3_latlng_to_cell(lat, lon, {H3_RESOLUTION}) AS BIGINT) AS h3_r8,
                            ts,
                            sensor,
                            satellite,
                            lat,
                            lon,
                            confidence_pct,
                            frp_mw,
                            daynight,
                            CASE
                                WHEN sensor = 'MODIS' THEN {SOURCE_MASK_MODIS}
                                WHEN sensor = 'VIIRS' THEN {SOURCE_MASK_VIIRS}
                                ELSE 0
                            END AS sources
                        FROM _hist_staged
                        WHERE valid_coords_ts AND confidence_pct IS NOT NULL
                    )
                    GROUP BY h3_r8, ts
                )
                ORDER BY ts, h3_r8
                """
            )
            con.execute("DROP TABLE _hist_staged")

            # Keep fires.parquet updated with the full deduplicated record via streaming COPY
            tmp_pq = parquet_path.with_name(f"{parquet_path.name}.{pid}.tmp")
            if tmp_pq.exists():
                tmp_pq.unlink()
            tmp_pq_sql = str(tmp_pq).replace("'", "''")
            con.execute(
                f"COPY fires TO '{tmp_pq_sql}' (FORMAT PARQUET, COMPRESSION ZSTD)"
            )
            tmp_pq.replace(parquet_path)
        else:
            con.execute(
                f"""
                CREATE OR REPLACE TABLE fires AS
                SELECT
                    CAST(h3_r8 AS BIGINT) AS h3_r8,
                    CAST(ts AS DATE) AS ts,
                    CAST(sensor AS VARCHAR) AS sensor,
                    CAST(satellite AS VARCHAR) AS satellite,
                    CAST(lat AS DOUBLE) AS lat,
                    CAST(lon AS DOUBLE) AS lon,
                    CAST(confidence_pct AS INTEGER) AS confidence_pct,
                    CAST(frp_mw AS DOUBLE) AS frp_mw,
                    CAST(daynight AS VARCHAR) AS daynight,
                    CAST(sources AS INTEGER) AS sources
                FROM read_parquet('{parquet_sql_path}')
                ORDER BY ts, h3_r8
                """
            )

        con.execute(
            """
            CREATE OR REPLACE TABLE calendar_monthly AS
            SELECT
                CAST(h3_r8 AS BIGINT) AS h3_r8,
                CAST(EXTRACT(YEAR FROM ts) AS INTEGER) AS year,
                CAST(EXTRACT(MONTH FROM ts) AS INTEGER) AS month,
                CAST(COUNT(*) AS BIGINT) AS detections,
                CAST(AVG(frp_mw) AS DOUBLE) AS mean_frp
            FROM fires
            GROUP BY h3_r8, year, month
            ORDER BY year, month, h3_r8
            """
        )

        con.execute(
            """
            CREATE OR REPLACE TABLE calendar_median AS
            SELECT
                CAST(h3_r8 AS BIGINT) AS h3_r8,
                CAST(month AS INTEGER) AS month,
                CAST(MEDIAN(detections) AS DOUBLE) AS median_detections
            FROM calendar_monthly
            GROUP BY h3_r8, month
            ORDER BY month, h3_r8
            """
        )

        con.execute(
            """
            CREATE OR REPLACE TABLE calendar_global AS
            SELECT
                CAST(EXTRACT(MONTH FROM ts) AS INTEGER) AS month,
                CAST(COUNT(*) AS BIGINT) AS detections,
                CAST(AVG(frp_mw) AS DOUBLE) AS mean_frp
            FROM fires
            GROUP BY month
            ORDER BY month
            """
        )

        row_Stats: Any = con.execute(
            """
            SELECT
                COUNT(*) AS rows_out,
                CAST(MIN(ts) AS VARCHAR) AS min_ts,
                CAST(MAX(ts) AS VARCHAR) AS max_ts,
                COUNT(DISTINCT h3_r8) AS distinct_h3
            FROM fires
            """
        ).fetchone()

        sensor_rows = con.execute(
            """
            SELECT sensor, COUNT(*) AS cnt
            FROM fires
            GROUP BY sensor
            ORDER BY cnt DESC, sensor ASC
            """
        ).fetchall()

        source_mask_rows = con.execute(
            """
            SELECT sources, COUNT(*) AS cnt
            FROM fires
            GROUP BY sources
            ORDER BY sources ASC
            """
        ).fetchall()

        top_month_rows = con.execute(
            """
            SELECT month, detections, mean_frp
            FROM calendar_global
            ORDER BY detections DESC, month ASC
            LIMIT 5
            """
        ).fetchall()

        con.execute("CHECKPOINT")
    finally:
        con.close()
        if tmp_spill_dir.exists():
            shutil.rmtree(tmp_spill_dir, ignore_errors=True)

    if tmp_wal_path.exists():
        tmp_wal_path.unlink()
    wal_path = Path(f"{duckdb_path}.wal")
    if wal_path.exists():
        wal_path.unlink()
    tmp_db_path.replace(duckdb_path)

    summary = BuildSummary(
        rows_out=int(row_Stats[0]) if row_Stats else 0,
        min_ts=row_Stats[1] if row_Stats else None,
        max_ts=row_Stats[2] if row_Stats else None,
        distinct_h3_cells=int(row_Stats[3]) if row_Stats else 0,
        counts_per_sensor={str(r[0]): int(r[1]) for r in sensor_rows},
        counts_per_sources_mask={int(r[0]): int(r[1]) for r in source_mask_rows},
        top_months=[(int(r[0]), int(r[1]), float(r[2])) for r in top_month_rows],
    )
    return summary, hist_stats, hist_files_count


def run_build(
    raw_dir: Path = RAW_DIR,
    parquet_path: Path = PARQUET_PATH,
    duckdb_path: Path = DUCKDB_PATH,
    chunk_size: int = CSV_CHUNK_SIZE,
    history_dir: Path | None = HISTORY_DIR,
) -> BuildSummary:
    """Execute the full idempotent hotspot pipeline and return verification stats.

    Args:
        raw_dir: Directory containing raw FIRMS CSV files.
        parquet_path: Target Parquet file path.
        duckdb_path: Target DuckDB database file path.
        chunk_size: Rows per chunk when streaming CSV files.
        history_dir: Optional directory containing historical `.csv.gz` FIRMS files.

    Returns:
        BuildSummary with row counts, sensor breakdowns, and peak RSS.
    """
    deduped_df, harm_stats, num_files = process_raw_csvs(
        raw_dir=raw_dir, chunk_size=chunk_size
    )
    write_parquet_atomic(deduped_df, parquet_path=parquet_path)
    del deduped_df
    gc.collect()

    summary, hist_stats, hist_files = build_duckdb(
        parquet_path=parquet_path,
        duckdb_path=duckdb_path,
        history_dir=history_dir,
    )
    summary.files_processed = num_files + hist_files
    summary.rows_in = harm_stats.rows_in + hist_stats.rows_in
    summary.rows_after_valid_coords_ts = (
        harm_stats.rows_after_valid_coords_ts + hist_stats.rows_after_valid_coords_ts
    )
    summary.rows_after_confidence = (
        harm_stats.rows_after_confidence + hist_stats.rows_after_confidence
    )
    summary.peak_rss_mb = get_peak_rss_mb()
    return summary


def format_verification_summary(summary: BuildSummary) -> str:
    """Format the pipeline verification summary for console output.

    Args:
        summary: Populated BuildSummary instance.

    Returns:
        Multi-line human-readable verification report.
    """
    sensor_str = ", ".join(
        f"{sensor}: {count}" for sensor, count in summary.counts_per_sensor.items()
    )
    mask_labels = {1: "1 (MODIS only)", 2: "2 (VIIRS only)", 3: "3 (MODIS+VIIRS)"}
    sources_str = ", ".join(
        f"{mask_labels.get(k, str(k))}: {v}"
        for k, v in sorted(summary.counts_per_sources_mask.items())
    )
    top_months_lines = [
        f"  - month={month:02d}: detections={detections}, mean_frp={mean_frp:.2f} MW"
        for month, detections, mean_frp in summary.top_months
    ]
    top_months_block = "\n".join(top_months_lines) if top_months_lines else "  (none)"

    lines = [
        "=== NASA Hotspots Pipeline Verification Summary ===",
        f"CSV files processed: {summary.files_processed}",
        f"rows in: {summary.rows_in}",
        "rows after each filter:",
        f"  - after valid lat/lon/ts filter: {summary.rows_after_valid_coords_ts}",
        f"  - after confidence filter (drop VIIRS low, drop MODIS < 50): {summary.rows_after_confidence}",
        f"  - after cross-sensor deduplication (same h3_r8 + same day): {summary.rows_out}",
        f"rows out: {summary.rows_out}",
        f"min/max ts: {summary.min_ts} .. {summary.max_ts}",
        f"counts per sensor: {sensor_str}",
        f"counts per sources mask: {sources_str}",
        f"distinct h3 cells: {summary.distinct_h3_cells}",
        "top 5 months by detections:",
        top_months_block,
        f"peak RSS: {summary.peak_rss_mb:.2f} MB",
    ]
    return "\n".join(lines)


def main(argv: Sequence[str] | None = None) -> int:
    """CLI entry point for building `data/fires.parquet` and `data/fires.duckdb`."""
    parser = argparse.ArgumentParser(
        description="Build harmonized NASA FIRMS hotspot Parquet and DuckDB datasets."
    )
    parser.add_argument(
        "--raw-dir",
        type=Path,
        default=RAW_DIR,
        help="Input directory containing raw FIRMS CSV files.",
    )
    parser.add_argument(
        "--history-dir",
        type=Path,
        default=HISTORY_DIR,
        help="Input directory containing historical .csv.gz FIRMS files.",
    )
    parser.add_argument(
        "--parquet-path",
        type=Path,
        default=PARQUET_PATH,
        help="Output Parquet file path.",
    )
    parser.add_argument(
        "--duckdb-path",
        type=Path,
        default=DUCKDB_PATH,
        help="Output DuckDB database path.",
    )
    parser.add_argument(
        "--chunk-size",
        type=int,
        default=CSV_CHUNK_SIZE,
        help="Chunk size for reading CSV files.",
    )
    args = parser.parse_args(argv)

    summary = run_build(
        raw_dir=args.raw_dir,
        parquet_path=args.parquet_path,
        duckdb_path=args.duckdb_path,
        chunk_size=args.chunk_size,
        history_dir=args.history_dir,
    )
    print(format_verification_summary(summary))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
