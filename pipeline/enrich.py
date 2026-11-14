"""Spatial H3 resolution-8 and temporal decomposition enrichment for hotspots."""

from h3.api.basic_int import latlng_to_cell
import numpy as np
import pandas as pd

from pipeline.config import ENRICHED_COLUMNS, H3_RESOLUTION

_vectorized_latlng_to_cell = np.vectorize(latlng_to_cell, otypes=[np.int64])


def compute_h3_cells(
    lats: np.ndarray | pd.Series,
    lons: np.ndarray | pd.Series,
    res: int = H3_RESOLUTION,
) -> np.ndarray:
    """Compute H3 integer cell indices for arrays of latitudes and longitudes.

    Args:
        lats: 1D array or Series of latitudes in degrees (-90 to 90).
        lons: 1D array or Series of longitudes in degrees (-180 to 180).
        res: Target H3 resolution (default 8).

    Returns:
        1D NumPy int64 array of H3 cell indices.
    """
    lat_arr = np.asarray(lats, dtype=np.float64)
    lon_arr = np.asarray(lons, dtype=np.float64)
    if lat_arr.size == 0:
        return np.empty(0, dtype=np.int64)
    return _vectorized_latlng_to_cell(lat_arr, lon_arr, res)


def enrich_dataframe(
    df: pd.DataFrame,
    res: int = H3_RESOLUTION,
) -> pd.DataFrame:
    """Enrich a harmonized hotspot dataframe with `h3_r8` and calendar fields.

    Adds:
    - `h3_r8`: 64-bit integer H3 index at resolution 8.
    - `year`: 4-digit year (int32).
    - `month`: Calendar month 1-12 (int32).
    - `day`: Day of month 1-31 (int32).
    - `doy`: Day of year 1-366 (int32).

    Args:
        df: Harmonized dataframe containing `lat`, `lon`, and `ts`.
        res: H3 resolution (defaults to 8).

    Returns:
        New dataframe including `h3_r8`, `year`, `month`, `day`, and `doy`.
    """
    out = df.copy()
    if out.empty:
        out["h3_r8"] = pd.Series(dtype="int64")
        out["year"] = pd.Series(dtype="int32")
        out["month"] = pd.Series(dtype="int32")
        out["day"] = pd.Series(dtype="int32")
        out["doy"] = pd.Series(dtype="int32")
        ordered = [c for c in ENRICHED_COLUMNS if c in out.columns]
        extra = [c for c in out.columns if c not in ordered]
        return out[ordered + extra]

    out["h3_r8"] = compute_h3_cells(out["lat"], out["lon"], res=res)

    ts_dt = pd.to_datetime(out["ts"])
    out["year"] = ts_dt.dt.year.astype(np.int32)
    out["month"] = ts_dt.dt.month.astype(np.int32)
    out["day"] = ts_dt.dt.day.astype(np.int32)
    out["doy"] = ts_dt.dt.day_of_year.astype(np.int32)

    ordered = [c for c in ENRICHED_COLUMNS if c in out.columns]
    extra = [c for c in out.columns if c not in ordered]
    return out[ordered + extra]


enrich_chunk = enrich_dataframe
enrich = enrich_dataframe
