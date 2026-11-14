from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

from pipeline.harmonize import harmonize, harmonize_chunk

EXPECTED_COLUMNS = [
    "ts",
    "sensor",
    "satellite",
    "lat",
    "lon",
    "confidence_pct",
    "frp_mw",
    "daynight",
]


def test_modis_confidence_filtering_and_mapping():
    df = pd.DataFrame(
        {
            "latitude": [45.0, 46.0],
            "longitude": [10.0, 11.0],
            "brightness": [310.0, 325.0],
            "acq_date": ["2026-11-10", "2026-11-10"],
            "satellite": ["Terra", "Aqua"],
            "confidence": [40, 85],
            "frp": [12.5, 45.0],
            "daynight": ["D", "N"],
        }
    )
    out = harmonize_chunk(df, sensor="MODIS")
    assert list(out.columns) == EXPECTED_COLUMNS
    assert len(out) == 1
    row = out.iloc[0]
    assert row["sensor"] == "MODIS"
    assert row["confidence_pct"] == 85
    assert row["lat"] == 46.0
    assert row["lon"] == 11.0
    assert row["frp_mw"] == 45.0
    assert row["daynight"] == "N"
    assert row["ts"] == date(2026, 11, 10)


def test_viirs_confidence_mapping_and_filtering():
    df = pd.DataFrame(
        {
            "latitude": [38.0, 39.0, 40.0],
            "longitude": [21.0, 22.0, 23.0],
            "bright_ti4": [330.0, 340.0, 355.0],
            "acq_date": ["2026-11-11", "2026-11-11", "2026-11-11"],
            "satellite": ["N", "N20", "N"],
            "confidence": ["low", "nominal", "high"],
            "frp": [3.0, 8.5, 22.0],
            "daynight": ["D", "N", "D"],
        }
    )
    out = harmonize_chunk(df, sensor="VIIRS")
    assert list(out.columns) == EXPECTED_COLUMNS
    assert len(out) == 2
    assert list(out["confidence_pct"]) == [50, 90]
    assert list(out["lat"]) == [39.0, 40.0]
    assert (out["sensor"] == "VIIRS").all()


def test_missing_coordinates_or_acq_date_dropped(tmp_path: Path):
    df = pd.DataFrame(
        {
            "latitude": [np.nan, 45.0, 45.5, 46.0],
            "longitude": [10.0, np.nan, 11.5, 12.0],
            "brightness": [315.0, 315.0, 315.0, 320.0],
            "acq_date": ["2026-11-12", "2026-11-12", None, "2026-11-12"],
            "satellite": ["T", "T", "T", "A"],
            "confidence": [90, 90, 90, 75],
            "frp": [10.0, 10.0, 10.0, 15.0],
            "daynight": ["D", "D", "D", "N"],
        }
    )
    csv_path = tmp_path / "MODIS_sample.csv"
    df.to_csv(csv_path, index=False)

    out = harmonize(csv_path)
    assert list(out.columns) == EXPECTED_COLUMNS
    assert len(out) == 1
    assert out.iloc[0]["lat"] == 46.0
    assert out.iloc[0]["lon"] == 12.0
    assert out.iloc[0]["confidence_pct"] == 75


def test_normalized_columns_on_empty_dataframe():
    empty_df = pd.DataFrame(
        columns=["latitude", "longitude", "acq_date", "confidence", "frp"]
    )
    out = harmonize_chunk(empty_df, sensor="MODIS")
    assert list(out.columns) == EXPECTED_COLUMNS
    assert len(out) == 0
