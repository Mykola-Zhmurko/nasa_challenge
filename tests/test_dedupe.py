from datetime import date

import pandas as pd

from pipeline.dedupe import dedupe_dataframe


def test_same_cell_same_day_collapses_and_higher_confidence_wins():
    df = pd.DataFrame(
        {
            "h3_r8": [613200000000000001, 613200000000000001],
            "ts": [date(2026, 11, 10), date(2026, 11, 10)],
            "sensor": ["MODIS", "VIIRS"],
            "satellite": ["T", "N"],
            "lat": [45.0, 45.001],
            "lon": [10.0, 10.001],
            "confidence_pct": [60, 90],
            "frp_mw": [50.0, 20.0],
            "daynight": ["D", "D"],
        }
    )
    out = dedupe_dataframe(df)
    assert len(out) == 1
    row = out.iloc[0]
    assert row["confidence_pct"] == 90
    assert row["frp_mw"] == 20.0
    assert row["sensor"] == "VIIRS"
    assert row["sources"] == 3


def test_equal_confidence_higher_frp_wins():
    df = pd.DataFrame(
        {
            "h3_r8": [613200000000000002, 613200000000000002],
            "ts": [date(2026, 11, 10), date(2026, 11, 10)],
            "sensor": ["MODIS", "MODIS"],
            "satellite": ["T", "A"],
            "lat": [45.1, 45.1],
            "lon": [10.1, 10.1],
            "confidence_pct": [80, 80],
            "frp_mw": [14.2, 38.7],
            "daynight": ["D", "N"],
        }
    )
    out = dedupe_dataframe(df)
    assert len(out) == 1
    row = out.iloc[0]
    assert row["confidence_pct"] == 80
    assert row["frp_mw"] == 38.7
    assert row["satellite"] == "A"
    assert row["sources"] == 1


def test_sources_bitmask_modis_viirs_and_both():
    cell_modis = 613200000000000010
    cell_viirs = 613200000000000020
    cell_both = 613200000000000030
    d = date(2026, 11, 11)

    df = pd.DataFrame(
        {
            "h3_r8": [cell_modis, cell_viirs, cell_both, cell_both],
            "ts": [d, d, d, d],
            "sensor": ["MODIS", "VIIRS", "MODIS", "VIIRS"],
            "satellite": ["T", "N", "A", "N20"],
            "lat": [40.0, 41.0, 42.0, 42.0],
            "lon": [20.0, 21.0, 22.0, 22.0],
            "confidence_pct": [70, 50, 85, 50],
            "frp_mw": [10.0, 12.0, 15.0, 25.0],
            "daynight": ["D", "D", "D", "N"],
        }
    )
    out = dedupe_dataframe(df).set_index("h3_r8")
    assert len(out) == 3
    assert out.loc[cell_modis, "sources"] == 1
    assert out.loc[cell_viirs, "sources"] == 2
    assert out.loc[cell_both, "sources"] == 3


def test_different_days_in_same_cell_stay_separate():
    cell = 613200000000000099
    df = pd.DataFrame(
        {
            "h3_r8": [cell, cell],
            "ts": [date(2026, 11, 10), date(2026, 11, 11)],
            "sensor": ["MODIS", "VIIRS"],
            "satellite": ["T", "N"],
            "lat": [45.0, 45.0],
            "lon": [10.0, 10.0],
            "confidence_pct": [75, 90],
            "frp_mw": [10.0, 20.0],
            "daynight": ["D", "N"],
        }
    )
    out = dedupe_dataframe(df)
    assert len(out) == 2
    assert list(out["ts"]) == [date(2026, 11, 10), date(2026, 11, 11)]
    assert list(out["sources"]) == [1, 2]
