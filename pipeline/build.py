"""CLI pipeline builder: harmonize -> enrich -> dedupe -> Parquet & DuckDB."""

import argparse
from collections.abc import Sequence
from dataclasses import dataclass, field
import gc
from pathlib import Path
import resource
from typing import Any

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
    PARQUET_PATH,
    RAW_DIR,
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


def build_duckdb(
    parquet_path: Path = PARQUET_PATH,
    duckdb_path: Path = DUCKDB_PATH,
) -> BuildSummary:
    """Build `data/fires.duckdb` tables from `data/fires.parquet` and query stats.

    Creates tables:
    - `fires(h3_r8, ts, sensor, satellite, lat, lon, confidence_pct, frp_mw, daynight, sources)`
    - `calendar_monthly(h3_r8, year, month, detections, mean_frp)`
    - `calendar_global(month, detections, mean_frp)`

    Args:
        parquet_path: Input Parquet file path.
        duckdb_path: Output DuckDB file path.

    Returns:
        BuildSummary populated with database verification metrics.
    """
    duckdb_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_db_path = duckdb_path.with_name(f"{duckdb_path.name}.tmp")
    tmp_wal_path = Path(f"{tmp_db_path}.wal")
    for p in (tmp_db_path, tmp_wal_path):
        if p.exists():
            p.unlink()

    con = duckdb.connect(str(tmp_db_path))
    try:
        con.execute("SET memory_limit='256MB'")
        con.execute("INSTALL h3 FROM community")
        con.execute("LOAD h3")

        # Provide convenience alias macro h3_to_parent -> h3_cell_to_parent per SPEC
        con.execute(
            "CREATE OR REPLACE MACRO h3_to_parent(cell, res) AS h3_cell_to_parent(cell, res)"
        )

        parquet_sql_path = str(parquet_path).replace("'", "''")
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
    return summary


def run_build(
    raw_dir: Path = RAW_DIR,
    parquet_path: Path = PARQUET_PATH,
    duckdb_path: Path = DUCKDB_PATH,
    chunk_size: int = CSV_CHUNK_SIZE,
) -> BuildSummary:
    """Execute the full idempotent hotspot pipeline and return verification stats.

    Args:
        raw_dir: Directory containing raw FIRMS CSV files.
        parquet_path: Target Parquet file path.
        duckdb_path: Target DuckDB database file path.
        chunk_size: Rows per chunk when streaming CSV files.

    Returns:
        BuildSummary with row counts, sensor breakdowns, and peak RSS.
    """
    deduped_df, harm_stats, num_files = process_raw_csvs(
        raw_dir=raw_dir, chunk_size=chunk_size
    )
    write_parquet_atomic(deduped_df, parquet_path=parquet_path)
    del deduped_df
    gc.collect()

    summary = build_duckdb(parquet_path=parquet_path, duckdb_path=duckdb_path)
    summary.files_processed = num_files
    summary.rows_in = harm_stats.rows_in
    summary.rows_after_valid_coords_ts = harm_stats.rows_after_valid_coords_ts
    summary.rows_after_confidence = harm_stats.rows_after_confidence
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
    )
    print(format_verification_summary(summary))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
