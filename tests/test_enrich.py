from datetime import date

import h3
from h3.api.basic_int import latlng_to_cell
import pandas as pd

from pipeline.enrich import enrich_dataframe


def test_h3_r8_and_date_parts_derived_correctly():
    lat, lon = 37.9838, 23.7275  # Athens
    df = pd.DataFrame(
        {
            "ts": [date(2026, 11, 14), "2020-08-05"],
            "sensor": ["MODIS", "VIIRS"],
            "satellite": ["T", "N"],
            "lat": [lat, 50.4501],
            "lon": [lon, 30.5234],
            "confidence_pct": [85, 90],
            "frp_mw": [25.0, 18.5],
            "daynight": ["D", "N"],
        }
    )

    out = enrich_dataframe(df)

    expected_h3_int = latlng_to_cell(lat, lon, 8)
    assert int(out.loc[0, "h3_r8"]) == expected_h3_int
    assert h3.int_to_str(int(out.loc[0, "h3_r8"])) == h3.latlng_to_cell(lat, lon, 8)

    assert list(out["year"]) == [2026, 2020]
    assert list(out["month"]) == [11, 8]
    assert list(out["day"]) == [14, 5]
