"""Streaming, out-of-core NASA FIRMS CSV import into DuckDB."""

import argparse
from collections.abc import Sequence
import csv
from dataclasses import dataclass
import os
from pathlib import Path
import shutil
import sys
import time
from typing import Literal

import duckdb

from pipeline.config import (
    DUCKDB_PATH,
    H3_RESOLUTION,
    MODIS_MIN_CONFIDENCE,
    SOURCE_MASK_MODIS,
    SOURCE_MASK_VIIRS,
)

SensorName = Literal["MODIS", "VIIRS"]

DEFAULT_MEMORY_LIMIT: str = "256MB"
DEFAULT_THREADS: int = 2


@dataclass
class CsvFileSpec:
    """Validated metadata and column mapping for an input FIRMS CSV file.

    Attributes:
        path: Resolved path to the CSV file.
        sensor: Detected sensor type ('MODIS' or 'VIIRS').
        lat_col: Header column name for latitude.
        lon_col: Header column name for longitude.
        ts_col: Header column name for acquisition date.
        conf_col: Header column name for confidence.
        sat_col: Optional header column name for satellite.
        frp_col: Optional header column name for fire radiative power (FRP).
        dn_col: Optional header column name for day/night flag.
    """

    path: Path
    sensor: SensorName
    lat_col: str
    lon_col: str
    ts_col: str
    conf_col: str
    sat_col: str | None = None
    frp_col: str | None = None
    dn_col: str | None = None


@dataclass
class ImportSummary:
    """Verification metrics collected during an out-of-core import run.

    Attributes:
        files: Number of CSV files imported.
        rows_read: Total raw rows read across all input CSV files.
        dropped_invalid_coords_date: Rows dropped due to invalid/missing lat, lon, or date.
        dropped_confidence: Valid-coord rows dropped by sensor confidence rules.
        dedupe_groups: Distinct (h3_r8, ts) cell-day keys in the imported batch.
        rows_inserted: Net-new (h3_r8, ts) keys inserted into fires.
        rows_replaced: Existing (h3_r8, ts) keys in fires merged/replaced by this import.
        total_rows_in_fires: Total row count in fires after the import completes.
        min_ts: Minimum acquisition date in fires (YYYY-MM-DD) or None.
        max_ts: Maximum acquisition date in fires (YYYY-MM-DD) or None.
        elapsed_sec: Wall-clock duration in seconds.
        vmhwm_kb: Peak resident set size (VmHWM) in kilobytes from /proc/self/status.
        peak_rss_mb: Peak resident set size in MiB.
    """

    files: int = 0
    rows_read: int = 0
    dropped_invalid_coords_date: int = 0
    dropped_confidence: int = 0
    dedupe_groups: int = 0
    rows_inserted: int = 0
    rows_replaced: int = 0
    total_rows_in_fires: int = 0
    min_ts: str | None = None
    max_ts: str | None = None
    elapsed_sec: float = 0.0
    vmhwm_kb: int = 0
    peak_rss_mb: float = 0.0


class ImportValidationError(Exception):
    """Raised when an input CSV file is unreadable or missing required columns."""


def get_vmhwm_rss() -> tuple[int, float]:
    """Read peak resident set size (VmHWM) from `/proc/self/status`.

    Returns:
        Tuple of `(vmhwm_kb, peak_rss_mb)`.
    """
    status_path = Path("/proc/self/status")
    if status_path.exists():
        try:
            with status_path.open("r", encoding="utf-8") as f:
                for line in f:
                    if line.startswith("VmHWM:"):
                        parts = line.split()
                        if len(parts) >= 2 and parts[1].isdigit():
                            kb = int(parts[1])
                            return kb, kb / 1024.0
        except OSError:
            pass
    return 0, 0.0


def _quote_ident(ident: str) -> str:
    """Quote a SQL identifier safely for DuckDB."""
    escaped = ident.replace('"', '""')
    return f'"{escaped}"'


def _quote_literal(val: str) -> str:
    """Quote a SQL string literal safely for DuckDB."""
    escaped = val.replace("'", "''")
    return f"'{escaped}'"


def detect_sensor_from_header(
    columns: Sequence[str],
    source_name: str = "",
    sample_conf_values: Sequence[str] = (),
) -> SensorName:
    """Detect whether a CSV file belongs to MODIS or VIIRS from header and filename.

    Args:
        columns: Normalized (lowercase) CSV header column names.
        source_name: Filename or path string used as fallback hint.
        sample_conf_values: Optional sample values from the confidence column.

    Returns:
        Sensor identifier ('MODIS' or 'VIIRS').
    """
    col_set = {c.strip().lower() for c in columns}
    if "bright_ti4" in col_set or "bright_ti5" in col_set:
        return "VIIRS"
    if "brightness" in col_set or "bright_t31" in col_set:
        return "MODIS"

    upper_name = source_name.upper()
    if "VIIRS" in upper_name or "J1" in upper_name or "SNPP" in upper_name:
        return "VIIRS"
    if "MODIS" in upper_name:
        return "MODIS"

    for val in sample_conf_values:
        cleaned = val.strip().lower()
        if cleaned in {"low", "nominal", "high", "l", "n", "h"}:
            return "VIIRS"

    return "MODIS"


def validate_and_inspect_csv(csv_path: Path) -> CsvFileSpec:
    """Validate that a CSV file is readable and contains required FIRMS columns.

    Reads only the header row and at most a handful of sample rows using Python's
    built-in `csv` module, keeping memory usage O(1).

    Args:
        csv_path: Path to the candidate CSV file.

    Returns:
        Populated `CsvFileSpec` for the file.

    Raises:
        ImportValidationError: If the file does not exist, is unreadable, is empty,
            or lacks required columns (`latitude`/`lat`, `longitude`/`lon`,
            `acq_date`/`ts`, `confidence`/`confidence_pct`).
    """
    if not csv_path.exists():
        raise ImportValidationError(f"Input file does not exist: {csv_path}")
    if not csv_path.is_file():
        raise ImportValidationError(f"Input path is not a regular file: {csv_path}")
    if not os.access(csv_path, os.R_OK):
        raise ImportValidationError(f"Input file is not readable: {csv_path}")

    try:
        with csv_path.open("r", encoding="utf-8-sig", errors="replace", newline="") as f:
            reader = csv.reader(f)
            try:
                raw_header = next(reader)
            except StopIteration as exc:
                raise ImportValidationError(
                    f"Input CSV file is empty (missing header): {csv_path}"
                ) from exc

            # Map lowercase column name -> exact original header name
            col_map: dict[str, str] = {}
            for col in raw_header:
                cleaned = col.strip()
                if cleaned:
                    col_map[cleaned.lower()] = cleaned

            if not col_map:
                raise ImportValidationError(
                    f"Input CSV file has an empty header row: {csv_path}"
                )

            lat_col = col_map.get("latitude") or col_map.get("lat")
            lon_col = col_map.get("longitude") or col_map.get("lon")
            ts_col = col_map.get("acq_date") or col_map.get("ts")
            conf_col = col_map.get("confidence") or col_map.get("confidence_pct")

            missing: list[str] = []
            if not lat_col:
                missing.append("latitude (or lat)")
            if not lon_col:
                missing.append("longitude (or lon)")
            if not ts_col:
                missing.append("acq_date (or ts)")
            if not conf_col:
                missing.append("confidence (or confidence_pct)")

            if missing:
                missing_str = ", ".join(missing)
                raise ImportValidationError(
                    f"Missing required column(s) [{missing_str}] in {csv_path}"
                )

            sat_col = col_map.get("satellite")
            frp_col = col_map.get("frp") or col_map.get("frp_mw")
            dn_col = col_map.get("daynight")

            # Read up to 10 rows only if needed for fallback sensor detection
            conf_idx = [c.strip().lower() for c in raw_header].index(conf_col.lower())
            sample_confs: list[str] = []
            for _ in range(10):
                try:
                    row = next(reader)
                except StopIteration:
                    break
                if conf_idx < len(row) and row[conf_idx]:
                    sample_confs.append(row[conf_idx])
    except ImportValidationError:
        raise
    except (OSError, csv.Error) as exc:
        raise ImportValidationError(
            f"Failed to read CSV file {csv_path}: {exc}"
        ) from exc

    sensor = detect_sensor_from_header(
        list(col_map.keys()),
        source_name=csv_path.name,
        sample_conf_values=sample_confs,
    )

    assert lat_col is not None
    assert lon_col is not None
    assert ts_col is not None
    assert conf_col is not None

    return CsvFileSpec(
        path=csv_path,
        sensor=sensor,
        lat_col=lat_col,
        lon_col=lon_col,
        ts_col=ts_col,
        conf_col=conf_col,
        sat_col=sat_col,
        frp_col=frp_col,
        dn_col=dn_col,
    )


def resolve_input_files(
    inputs: Sequence[Path] | None,
    directory: Path | None,
) -> list[CsvFileSpec]:
    """Resolve and validate all input CSV files from `--input` or `--dir`.

    Args:
        inputs: Explicit CSV file paths passed via `--input`.
        directory: Directory path passed via `--dir`.

    Returns:
        List of validated `CsvFileSpec` objects.

    Raises:
        ImportValidationError: If no files are found or any file fails validation.
    """
    candidate_paths: list[Path] = []
    if inputs:
        for p in inputs:
            candidate_paths.append(p)
    if directory is not None:
        if not directory.exists():
            raise ImportValidationError(f"Input directory does not exist: {directory}")
        if not directory.is_dir():
            raise ImportValidationError(f"Path is not a directory: {directory}")
        if not os.access(directory, os.R_OK):
            raise ImportValidationError(f"Directory is not readable: {directory}")
        dir_csvs = sorted(directory.glob("*.csv"))
        if not dir_csvs:
            raise ImportValidationError(f"No *.csv files found in directory: {directory}")
        candidate_paths.extend(dir_csvs)

    if not candidate_paths:
        raise ImportValidationError("No input CSV files specified.")

    return [validate_and_inspect_csv(p) for p in candidate_paths]


def _stage_file_sql(spec: CsvFileSpec) -> str:
    """Build the DuckDB SQL `INSERT INTO _staging_raw` statement for one CSV file."""
    lat_ident = _quote_ident(spec.lat_col)
    lon_ident = _quote_ident(spec.lon_col)
    ts_ident = _quote_ident(spec.ts_col)
    conf_ident = _quote_ident(spec.conf_col)

    sat_expr = (
        f"COALESCE(TRIM(CAST({_quote_ident(spec.sat_col)} AS VARCHAR)), '')"
        if spec.sat_col
        else "''"
    )
    frp_expr = (
        f"COALESCE(TRY_CAST({_quote_ident(spec.frp_col)} AS DOUBLE), 0.0)"
        if spec.frp_col
        else "0.0"
    )
    dn_expr = (
        f"UPPER(COALESCE(TRIM(CAST({_quote_ident(spec.dn_col)} AS VARCHAR)), ''))"
        if spec.dn_col
        else "''"
    )

    if spec.sensor == "VIIRS":
        conf_sql = """
        CASE
            WHEN LOWER(TRIM(conf_str)) IN ('nominal', 'n') THEN 50
            WHEN LOWER(TRIM(conf_str)) IN ('high', 'h') THEN 90
            WHEN TRY_CAST(conf_str AS DOUBLE) = 50 THEN 50
            WHEN TRY_CAST(conf_str AS DOUBLE) = 90 THEN 90
            ELSE NULL
        END
        """
    else:
        conf_sql = f"""
        CASE
            WHEN TRY_CAST(conf_str AS DOUBLE) >= {MODIS_MIN_CONFIDENCE}
             AND TRY_CAST(conf_str AS DOUBLE) <= 100
            THEN CAST(TRY_CAST(conf_str AS DOUBLE) AS INTEGER)
            ELSE NULL
        END
        """

    csv_path_lit = _quote_literal(str(spec.path))
    sensor_lit = _quote_literal(spec.sensor)

    return f"""
    INSERT INTO _staging_raw (
        sensor,
        ts,
        lat,
        lon,
        valid_coords_ts,
        confidence_pct,
        satellite,
        frp_mw,
        daynight
    )
    SELECT
        {sensor_lit} AS sensor,
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
        {conf_sql} AS confidence_pct,
        sat_val AS satellite,
        frp_val AS frp_mw,
        dn_val AS daynight
    FROM (
        SELECT
            TRY_CAST({lat_ident} AS DOUBLE) AS lat_val,
            TRY_CAST({lon_ident} AS DOUBLE) AS lon_val,
            COALESCE(
                TRY_CAST({ts_ident} AS DATE),
                TRY_CAST(TRY_STRPTIME(TRIM(CAST({ts_ident} AS VARCHAR)), '%Y-%m-%d') AS DATE)
            ) AS ts_val,
            CAST({conf_ident} AS VARCHAR) AS conf_str,
            {sat_expr} AS sat_val,
            {frp_expr} AS frp_val,
            {dn_expr} AS dn_val
        FROM read_csv(
            {csv_path_lit},
            header=true,
            ignore_errors=true,
            all_varchar=true
        )
    )
    """


def run_import(
    file_specs: Sequence[CsvFileSpec],
    db_path: Path = DUCKDB_PATH,
    memory_limit: str = DEFAULT_MEMORY_LIMIT,
    threads: int = DEFAULT_THREADS,
) -> ImportSummary:
    """Execute the streaming out-of-core import into a temporary copy of `db_path`.

    Copies `db_path` to a sibling temporary file, applies staging, harmonization,
    H3 enrichment, cross-sensor deduplication, and calendar table rebuilds in a
    single transaction, checkpoints and closes the connection, and atomically
    replaces `db_path`.

    Args:
        file_specs: Validated CSV file specifications to import.
        db_path: Target DuckDB database path.
        memory_limit: DuckDB memory limit (e.g. '256MB').
        threads: Number of DuckDB execution threads.

    Returns:
        `ImportSummary` with counts, date range, elapsed time, and peak RSS.
    """
    t0 = time.monotonic()
    db_path = Path(db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)

    pid = os.getpid()
    tmp_db_path = db_path.with_name(f".{db_path.name}.import-{pid}.tmp")
    tmp_wal_path = Path(f"{tmp_db_path}.wal")
    tmp_spill_dir = db_path.parent / f".{db_path.name}.spill-{pid}.tmp"

    for p in (tmp_db_path, tmp_wal_path):
        if p.exists():
            p.unlink()
    if tmp_spill_dir.exists():
        shutil.rmtree(tmp_spill_dir, ignore_errors=True)

    if db_path.exists():
        shutil.copy2(db_path, tmp_db_path)
        live_wal = Path(f"{db_path}.wal")
        if live_wal.exists():
            shutil.copy2(live_wal, tmp_wal_path)

    con: duckdb.DuckDBPyConnection | None = None
    try:
        con = duckdb.connect(str(tmp_db_path))
        con.execute(f"SET memory_limit={_quote_literal(memory_limit)}")
        con.execute(f"SET threads={int(threads)}")
        con.execute(f"SET temp_directory={_quote_literal(str(tmp_spill_dir))}")
        con.execute("SET enable_progress_bar=false")

        try:
            con.execute("LOAD h3")
        except duckdb.Error:
            con.execute("INSTALL h3 FROM community")
            con.execute("LOAD h3")

        con.execute("BEGIN TRANSACTION")

        con.execute(
            "CREATE OR REPLACE MACRO h3_to_parent(cell, res) AS h3_cell_to_parent(cell, res)"
        )
        con.execute(
            """
            CREATE TABLE IF NOT EXISTS fires (
                h3_r8 BIGINT,
                ts DATE,
                sensor VARCHAR,
                satellite VARCHAR,
                lat DOUBLE,
                lon DOUBLE,
                confidence_pct INTEGER,
                frp_mw DOUBLE,
                daynight VARCHAR,
                sources INTEGER
            )
            """
        )

        # Clean up any leftover staging objects if present
        con.execute("DROP TABLE IF EXISTS _staging_overlap")
        con.execute("DROP TABLE IF EXISTS _staging_deduped")
        con.execute("DROP TABLE IF EXISTS _staging_raw")
        con.execute("DROP SEQUENCE IF EXISTS _staging_seq")

        con.execute("CREATE SEQUENCE _staging_seq START 1")
        con.execute(
            """
            CREATE TABLE _staging_raw (
                row_id BIGINT DEFAULT nextval('_staging_seq'),
                sensor VARCHAR,
                ts DATE,
                lat DOUBLE,
                lon DOUBLE,
                valid_coords_ts BOOLEAN,
                confidence_pct INTEGER,
                satellite VARCHAR,
                frp_mw DOUBLE,
                daynight VARCHAR
            )
            """
        )

        for spec in file_specs:
            con.execute(_stage_file_sql(spec))

        # Allow DuckDB to reorder partitions freely during out-of-core aggregations
        con.execute("SET preserve_insertion_order=false")

        raw_counts = con.execute(
            """
            SELECT
                COUNT(*) AS rows_read,
                COUNT(*) FILTER (WHERE NOT valid_coords_ts) AS dropped_coords_date,
                COUNT(*) FILTER (WHERE valid_coords_ts AND confidence_pct IS NULL) AS dropped_conf
            FROM _staging_raw
            """
        ).fetchone()
        rows_read = int(raw_counts[0]) if raw_counts else 0
        dropped_coords_date = int(raw_counts[1]) if raw_counts else 0
        dropped_conf = int(raw_counts[2]) if raw_counts else 0

        # Deduplicate imported batch per (h3_r8, ts)
        con.execute(
            f"""
            CREATE TABLE _staging_deduped AS
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
                            s: CASE WHEN sensor = 'MODIS' THEN 2 ELSE 1 END,
                            r: -row_id
                        }}
                    ) AS winner,
                    CAST(BIT_OR(sources) AS INTEGER) AS sources
                FROM (
                    SELECT
                        row_id,
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
                    FROM _staging_raw
                    WHERE valid_coords_ts AND confidence_pct IS NOT NULL
                )
                GROUP BY h3_r8, ts
            )
            """
        )

        con.execute("DROP TABLE _staging_raw")
        con.execute("DROP SEQUENCE _staging_seq")

        dedupe_row = con.execute("SELECT COUNT(*) FROM _staging_deduped").fetchone()
        dedupe_groups = int(dedupe_row[0]) if dedupe_row else 0

        # For (h3_r8, ts) keys that already exist in fires, dedupe over the UNION
        # of the existing fires rows and the new rows.
        con.execute(
            """
            CREATE TABLE _staging_overlap AS
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
                        {
                            sensor: sensor,
                            satellite: satellite,
                            lat: lat,
                            lon: lon,
                            confidence_pct: confidence_pct,
                            frp_mw: frp_mw,
                            daynight: daynight
                        },
                        {
                            c: confidence_pct,
                            f: frp_mw,
                            s: CASE WHEN sensor = 'MODIS' THEN 2 ELSE 1 END,
                            p: priority
                        }
                    ) AS winner,
                    CAST(BIT_OR(sources) AS INTEGER) AS sources
                FROM (
                    SELECT
                        f.h3_r8,
                        f.ts,
                        f.sensor,
                        f.satellite,
                        f.lat,
                        f.lon,
                        f.confidence_pct,
                        f.frp_mw,
                        f.daynight,
                        f.sources,
                        1 AS priority
                    FROM fires f
                    SEMI JOIN _staging_deduped n
                        ON f.h3_r8 = n.h3_r8 AND f.ts = n.ts
                    UNION ALL
                    SELECT
                        n.h3_r8,
                        n.ts,
                        n.sensor,
                        n.satellite,
                        n.lat,
                        n.lon,
                        n.confidence_pct,
                        n.frp_mw,
                        n.daynight,
                        n.sources,
                        0 AS priority
                    FROM _staging_deduped n
                    SEMI JOIN fires f
                        ON f.h3_r8 = n.h3_r8 AND f.ts = n.ts
                )
                GROUP BY h3_r8, ts
            )
            """
        )

        replaced_row = con.execute("SELECT COUNT(*) FROM _staging_overlap").fetchone()
        rows_replaced = int(replaced_row[0]) if replaced_row else 0
        rows_inserted = dedupe_groups - rows_replaced

        if rows_replaced > 0:
            con.execute(
                """
                DELETE FROM fires
                USING _staging_overlap o
                WHERE fires.h3_r8 = o.h3_r8 AND fires.ts = o.ts
                """
            )
            con.execute(
                """
                DELETE FROM _staging_deduped
                USING _staging_overlap o
                WHERE _staging_deduped.h3_r8 = o.h3_r8 AND _staging_deduped.ts = o.ts
                """
            )
            con.execute(
                """
                INSERT INTO fires (
                    h3_r8, ts, sensor, satellite, lat, lon,
                    confidence_pct, frp_mw, daynight, sources
                )
                SELECT
                    h3_r8, ts, sensor, satellite, lat, lon,
                    confidence_pct, frp_mw, daynight, sources
                FROM _staging_overlap
                """
            )

        con.execute("DROP TABLE _staging_overlap")

        if rows_inserted > 0:
            con.execute(
                """
                INSERT INTO fires (
                    h3_r8, ts, sensor, satellite, lat, lon,
                    confidence_pct, frp_mw, daynight, sources
                )
                SELECT
                    h3_r8, ts, sensor, satellite, lat, lon,
                    confidence_pct, frp_mw, daynight, sources
                FROM _staging_deduped
                """
            )

        con.execute("DROP TABLE _staging_deduped")

        # Rebuild calendar_monthly, calendar_median, and calendar_global tables
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

        fires_stats = con.execute(
            """
            SELECT
                COUNT(*) AS total_rows,
                CAST(MIN(ts) AS VARCHAR) AS min_ts,
                CAST(MAX(ts) AS VARCHAR) AS max_ts
            FROM fires
            """
        ).fetchone()
        total_rows = int(fires_stats[0]) if fires_stats else 0
        min_ts = fires_stats[1] if fires_stats else None
        max_ts = fires_stats[2] if fires_stats else None

        con.execute("COMMIT")
        con.execute("CHECKPOINT")
        con.close()
        con = None

        if tmp_wal_path.exists():
            tmp_wal_path.unlink()

        os.replace(tmp_db_path, db_path)

        live_wal_path = Path(f"{db_path}.wal")
        if live_wal_path.exists():
            live_wal_path.unlink()

    except Exception:
        if con is not None:
            try:
                con.close()
            except Exception:
                pass
        for p in (tmp_db_path, tmp_wal_path):
            if p.exists():
                p.unlink(missing_ok=True)
        raise
    finally:
        if tmp_spill_dir.exists():
            shutil.rmtree(tmp_spill_dir, ignore_errors=True)

    elapsed_sec = time.monotonic() - t0
    vmhwm_kb, peak_rss_mb = get_vmhwm_rss()

    return ImportSummary(
        files=len(file_specs),
        rows_read=rows_read,
        dropped_invalid_coords_date=dropped_coords_date,
        dropped_confidence=dropped_conf,
        dedupe_groups=dedupe_groups,
        rows_inserted=rows_inserted,
        rows_replaced=rows_replaced,
        total_rows_in_fires=total_rows,
        min_ts=min_ts,
        max_ts=max_ts,
        elapsed_sec=elapsed_sec,
        vmhwm_kb=vmhwm_kb,
        peak_rss_mb=peak_rss_mb,
    )


def format_import_summary(summary: ImportSummary) -> str:
    """Format the import verification summary for stdout.

    Args:
        summary: Populated `ImportSummary` instance.

    Returns:
        Multi-line human-readable summary report.
    """
    lines = [
        "=== NASA Hotspots Out-of-Core Import Summary ===",
        f"files: {summary.files}",
        f"rows read: {summary.rows_read}",
        f"dropped by invalid coords/date: {summary.dropped_invalid_coords_date}",
        f"dropped by confidence: {summary.dropped_confidence}",
        f"dedupe groups: {summary.dedupe_groups}",
        f"rows inserted: {summary.rows_inserted}",
        f"rows replaced: {summary.rows_replaced}",
        f"total rows in fires: {summary.total_rows_in_fires}",
        f"min/max ts: {summary.min_ts} .. {summary.max_ts}",
        f"elapsed: {summary.elapsed_sec:.2f}s",
        f"peak RSS (VmHWM): {summary.peak_rss_mb:.2f} MB ({summary.vmhwm_kb} kB)",
    ]
    return "\n".join(lines)


def build_parser() -> argparse.ArgumentParser:
    """Construct the CLI argument parser for `python -m pipeline.import`."""
    parser = argparse.ArgumentParser(
        prog="python -m pipeline.import",
        description=(
            "Streaming, out-of-core import of NASA FIRMS MODIS C6.1 and VIIRS C2 "
            "CSV files into DuckDB with bounded RAM."
        ),
    )
    source_group = parser.add_mutually_exclusive_group(required=True)
    source_group.add_argument(
        "--input",
        dest="inputs",
        action="extend",
        nargs="+",
        type=Path,
        metavar="<file.csv>",
        help="One or more raw FIRMS CSV files to import (may be repeated).",
    )
    source_group.add_argument(
        "--dir",
        dest="directory",
        type=Path,
        metavar="<folder>",
        help="Directory containing raw FIRMS *.csv files to import.",
    )
    parser.add_argument(
        "--db",
        type=Path,
        default=Path("data/fires.duckdb"),
        metavar="data/fires.duckdb",
        help="Path to the target DuckDB database (default: data/fires.duckdb).",
    )
    parser.add_argument(
        "--memory-limit",
        type=str,
        default=DEFAULT_MEMORY_LIMIT,
        metavar="256MB",
        help=f"DuckDB memory limit before spilling to disk (default: {DEFAULT_MEMORY_LIMIT}).",
    )
    parser.add_argument(
        "--threads",
        type=int,
        default=DEFAULT_THREADS,
        metavar="2",
        help=f"Number of DuckDB worker threads (default: {DEFAULT_THREADS}).",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """CLI entry point for streaming FIRMS CSV import."""
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.threads < 1:
        print("Error: --threads must be >= 1.", file=sys.stderr)
        return 1

    try:
        file_specs = resolve_input_files(args.inputs, args.directory)
        summary = run_import(
            file_specs=file_specs,
            db_path=args.db,
            memory_limit=args.memory_limit,
            threads=args.threads,
        )
    except ImportValidationError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    except duckdb.Error as exc:
        print(f"Database error during import: {exc}", file=sys.stderr)
        return 1
    except OSError as exc:
        print(f"OS error during import: {exc}", file=sys.stderr)
        return 1

    print(format_import_summary(summary))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
