"""Cross-sensor hotspot deduplication by H3 resolution-8 cell and UTC date."""

import numpy as np
import pandas as pd

from pipeline.config import SOURCE_MASK_MODIS, SOURCE_MASK_VIIRS


def sensor_to_source_mask(sensors: pd.Series) -> np.ndarray:
    """Map sensor names ('MODIS' or 'VIIRS') to integer source bitmasks.

    Args:
        sensors: Series of sensor name strings.

    Returns:
        NumPy int32 array where 1=MODIS and 2=VIIRS.
    """
    sensor_upper = sensors.astype(str).str.strip().str.upper()
    return np.where(
        sensor_upper == "MODIS",
        SOURCE_MASK_MODIS,
        np.where(sensor_upper == "VIIRS", SOURCE_MASK_VIIRS, 0),
    ).astype(np.int32)


def dedupe_dataframe(df: pd.DataFrame) -> pd.DataFrame:
    """Deduplicate hotspots within the same `(h3_r8, ts)` cell-day group.

    Rules from SPEC:
    - Group by `(h3_r8, ts)` (same H3 resolution-8 cell and same UTC day).
    - Keep a single representative row per `(h3_r8, ts)`, preferring higher
      `confidence_pct` first, then higher `frp_mw`.
    - Record `sources` bitmask (`1=MODIS`, `2=VIIRS`, `3=MODIS|VIIRS`) across
      all detections in that cell and day.

    Args:
        df: Enriched hotspot dataframe containing `h3_r8`, `ts`, `sensor`,
            `confidence_pct`, and `frp_mw`.

    Returns:
        Deduplicated dataframe with the `sources` bitmask column populated.
    """
    if df.empty:
        out = df.copy()
        out["sources"] = pd.Series(dtype="int32")
        return out

    work = df.copy()
    sensor_bits = sensor_to_source_mask(work["sensor"])
    if "sources" in work.columns:
        existing_bits = (
            pd.to_numeric(work["sources"], errors="coerce")
            .fillna(0)
            .astype(np.int32)
            .to_numpy()
        )
        work["sources"] = (existing_bits | sensor_bits).astype(np.int32)
    else:
        work["sources"] = sensor_bits

    # Sort deterministically: h3_r8 ASC, ts ASC, confidence_pct DESC, frp_mw DESC
    sorted_df = work.sort_values(
        by=["h3_r8", "ts", "confidence_pct", "frp_mw", "sensor"],
        ascending=[True, True, False, False, True],
        kind="mergesort",
    )

    # Compute groupwise bitwise OR across all source masks in the cell-day group.
    grouped = sorted_df.groupby(["h3_r8", "ts"], sort=False)["sources"]
    grp_mask = grouped.transform(lambda s: np.bitwise_or.reduce(s.to_numpy()))
    sorted_df = sorted_df.assign(sources=grp_mask.astype(np.int32))

    deduped = sorted_df.drop_duplicates(
        subset=["h3_r8", "ts"], keep="first"
    ).reset_index(drop=True)

    return deduped


dedupe = dedupe_dataframe
deduplicate = dedupe_dataframe
