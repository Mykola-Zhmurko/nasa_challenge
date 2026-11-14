"""Harmonization of raw NASA FIRMS MODIS C6.1 and VIIRS C2 CSV records."""

from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import numpy as np
import pandas as pd

from pipeline.config import (
    CSV_CHUNK_SIZE,
    HARMONIZED_COLUMNS,
    MODIS_MIN_CONFIDENCE,
    VIIRS_CONFIDENCE_MAP,
)

SensorName = Literal["MODIS", "VIIRS"]


@dataclass
class HarmonizeStats:
    """Row counters across harmonization filtering stages.

    Attributes:
        rows_in: Total raw CSV rows read before any filtering.
        rows_after_valid_coords_ts: Rows remaining after dropping missing or
            out-of-range latitude, longitude, or timestamp.
        rows_after_confidence: Rows remaining after applying sensor-specific
            confidence filtering rules (drop VIIRS low, drop MODIS < 50).
    """

    rows_in: int = 0
    rows_after_valid_coords_ts: int = 0
    rows_after_confidence: int = 0


def detect_sensor(df: pd.DataFrame, source_name: str = "") -> SensorName:
    """Detect whether a raw FIRMS dataframe belongs to MODIS or VIIRS.

    Args:
        df: Raw FIRMS dataframe or chunk.
        source_name: Optional filename or source identifier hint.

    Returns:
        Sensor identifier string ('MODIS' or 'VIIRS').
    """
    cols = set(df.columns)
    if "bright_ti4" in cols or "bright_ti5" in cols:
        return "VIIRS"
    if "brightness" in cols or "bright_t31" in cols:
        return "MODIS"

    upper_name = source_name.upper()
    if "VIIRS" in upper_name or "J1" in upper_name or "SNPP" in upper_name:
        return "VIIRS"
    if "MODIS" in upper_name:
        return "MODIS"

    if "confidence" in cols and not df.empty:
        sample = df["confidence"].dropna().astype(str).str.strip().str.lower()
        if sample.isin({"low", "nominal", "high", "l", "n", "h"}).any():
            return "VIIRS"

    return "MODIS"


def _empty_harmonized_df() -> pd.DataFrame:
    """Create an empty dataframe conforming to the harmonized schema."""
    return pd.DataFrame(
        {
            "ts": pd.Series(dtype="object"),
            "sensor": pd.Series(dtype="str"),
            "satellite": pd.Series(dtype="str"),
            "lat": pd.Series(dtype="float64"),
            "lon": pd.Series(dtype="float64"),
            "confidence_pct": pd.Series(dtype="int32"),
            "frp_mw": pd.Series(dtype="float64"),
            "daynight": pd.Series(dtype="str"),
        }
    )[list(HARMONIZED_COLUMNS)]


def harmonize_chunk(
    df: pd.DataFrame,
    sensor: SensorName | None = None,
    source_name: str = "",
    stats: HarmonizeStats | None = None,
) -> pd.DataFrame:
    """Normalize a raw FIRMS dataframe chunk into the unified hotspot schema.

    Applies SPEC harmonization rules:
    - Coerces latitude, longitude, and acquisition date (`acq_date` or `ts`),
      dropping rows with missing or invalid values.
    - For VIIRS: drops `low` confidence, maps `nominal` -> 50 and `high` -> 90.
    - For MODIS: drops confidence < 50.
    - Normalizes columns to `(ts, sensor, satellite, lat, lon, confidence_pct,
      frp_mw, daynight)`.

    Args:
        df: Input raw FIRMS dataframe chunk.
        sensor: Explicit sensor type ('MODIS' or 'VIIRS'); auto-detected if None.
        source_name: Optional file path or name for sensor auto-detection.
        stats: Optional counter object updated in place with filter counts.

    Returns:
        Harmonized dataframe with standardized schema and types.
    """
    n_in = len(df)
    if stats is not None:
        stats.rows_in += n_in

    if df.empty:
        return _empty_harmonized_df()

    resolved_sensor: SensorName = sensor or detect_sensor(df, source_name=source_name)

    lat_col = "latitude" if "latitude" in df.columns else "lat"
    lon_col = "longitude" if "longitude" in df.columns else "lon"
    ts_col = "acq_date" if "acq_date" in df.columns else "ts"
    conf_col = "confidence" if "confidence" in df.columns else "confidence_pct"
    frp_col = "frp" if "frp" in df.columns else "frp_mw"

    if lat_col not in df.columns or lon_col not in df.columns or ts_col not in df.columns:
        return _empty_harmonized_df()

    lat = pd.to_numeric(df[lat_col], errors="coerce")
    lon = pd.to_numeric(df[lon_col], errors="coerce")
    ts_dt = pd.to_datetime(df[ts_col], format="%Y-%m-%d", errors="coerce")
    if ts_dt.isna().all() and df[ts_col].notna().any():
        ts_dt = pd.to_datetime(df[ts_col], errors="coerce")

    valid_coords_ts = (
        lat.notna()
        & lon.notna()
        & ts_dt.notna()
        & (lat >= -90.0)
        & (lat <= 90.0)
        & (lon >= -180.0)
        & (lon <= 180.0)
    )

    df_valid = df.loc[valid_coords_ts]
    lat_valid = lat.loc[valid_coords_ts]
    lon_valid = lon.loc[valid_coords_ts]
    ts_valid = ts_dt.loc[valid_coords_ts]

    if stats is not None:
        stats.rows_after_valid_coords_ts += len(df_valid)

    if df_valid.empty or conf_col not in df_valid.columns:
        return _empty_harmonized_df()

    if resolved_sensor == "VIIRS":
        raw_conf = df_valid[conf_col]
        conf_str = raw_conf.astype(str).str.strip().str.lower()
        mapped_conf = conf_str.map(VIIRS_CONFIDENCE_MAP)
        # Fallback if already numeric (e.g. 50 or 90)
        if mapped_conf.isna().any():
            num_conf = pd.to_numeric(raw_conf, errors="coerce")
            num_valid = num_conf.where(num_conf.isin([50, 90]))
            mapped_conf = mapped_conf.fillna(num_valid)
        keep_mask = mapped_conf.notna()
        conf_pct = mapped_conf.loc[keep_mask].astype(np.int32)
    else:
        num_conf = pd.to_numeric(df_valid[conf_col], errors="coerce")
        keep_mask = (
            num_conf.notna()
            & (num_conf >= MODIS_MIN_CONFIDENCE)
            & (num_conf <= 100)
        )
        conf_pct = num_conf.loc[keep_mask].astype(np.int32)

    df_kept = df_valid.loc[keep_mask]
    if stats is not None:
        stats.rows_after_confidence += len(df_kept)

    if df_kept.empty:
        return _empty_harmonized_df()

    ts_kept = ts_valid.loc[keep_mask].dt.date
    lat_kept = lat_valid.loc[keep_mask].astype(np.float64)
    lon_kept = lon_valid.loc[keep_mask].astype(np.float64)

    if "satellite" in df_kept.columns:
        satellite = df_kept["satellite"].fillna("").astype(str).str.strip()
    else:
        satellite = pd.Series("", index=df_kept.index, dtype="str")

    if frp_col in df_kept.columns:
        frp_mw = (
            pd.to_numeric(df_kept[frp_col], errors="coerce")
            .fillna(0.0)
            .astype(np.float64)
        )
    else:
        frp_mw = pd.Series(0.0, index=df_kept.index, dtype="float64")

    if "daynight" in df_kept.columns:
        daynight = df_kept["daynight"].fillna("").astype(str).str.strip().str.upper()
    else:
        daynight = pd.Series("", index=df_kept.index, dtype="str")

    result = pd.DataFrame(
        {
            "ts": ts_kept.to_numpy(),
            "sensor": resolved_sensor,
            "satellite": satellite.to_numpy(),
            "lat": lat_kept.to_numpy(dtype=np.float64),
            "lon": lon_kept.to_numpy(dtype=np.float64),
            "confidence_pct": conf_pct.to_numpy(dtype=np.int32),
            "frp_mw": frp_mw.to_numpy(dtype=np.float64),
            "daynight": daynight.to_numpy(),
        }
    )
    return result[list(HARMONIZED_COLUMNS)]


def iter_harmonized_csv(
    csv_path: str | Path,
    chunk_size: int = CSV_CHUNK_SIZE,
    stats: HarmonizeStats | None = None,
) -> Iterator[pd.DataFrame]:
    """Read and harmonize a FIRMS CSV file in memory-bounded chunks.

    Args:
        csv_path: Path to the FIRMS CSV file.
        chunk_size: Number of rows per chunk.
        stats: Optional HarmonizeStats accumulator updated across chunks.

    Yields:
        Harmonized dataframe for each non-empty chunk.
    """
    path = Path(csv_path)
    for chunk in pd.read_csv(path, chunksize=chunk_size, low_memory=False):
        harmonized = harmonize_chunk(chunk, source_name=path.name, stats=stats)
        if not harmonized.empty:
            yield harmonized


def load_and_harmonize_csv(
    csv_path: str | Path,
    chunk_size: int = CSV_CHUNK_SIZE,
    stats: HarmonizeStats | None = None,
) -> pd.DataFrame:
    """Load an entire FIRMS CSV via chunked reading and return harmonized rows.

    Args:
        csv_path: Path to the FIRMS CSV file.
        chunk_size: Number of rows per chunk.
        stats: Optional HarmonizeStats accumulator.

    Returns:
        Concatenated harmonized dataframe.
    """
    chunks = list(iter_harmonized_csv(csv_path, chunk_size=chunk_size, stats=stats))
    if not chunks:
        return _empty_harmonized_df()
    return pd.concat(chunks, ignore_index=True)


def harmonize(
    source: pd.DataFrame | str | Path,
    chunk_size: int = CSV_CHUNK_SIZE,
    stats: HarmonizeStats | None = None,
) -> pd.DataFrame:
    """Harmonize either a CSV file path or an in-memory DataFrame.

    Args:
        source: Path to a FIRMS CSV file or a raw DataFrame.
        chunk_size: Chunk size when reading from a CSV file.
        stats: Optional HarmonizeStats accumulator.

    Returns:
        Harmonized DataFrame.
    """
    if isinstance(source, pd.DataFrame):
        return harmonize_chunk(source, stats=stats)
    return load_and_harmonize_csv(source, chunk_size=chunk_size, stats=stats)


harmonize_dataframe = harmonize_chunk
harmonize_csv = load_and_harmonize_csv
