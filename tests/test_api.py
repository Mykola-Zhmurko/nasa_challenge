from fastapi.testclient import TestClient
import h3
import pytest

from api.app import app
from api.db import DB_PATH

pytestmark = pytest.mark.skipif(
    not DB_PATH.exists(),
    reason=f"DuckDB file {DB_PATH} does not exist",
)

client = TestClient(app)


def test_health_endpoint():
    resp = client.get("/api/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"
    assert data["rows"] > 0
    assert data["min_ts"] is not None
    assert data["max_ts"] is not None
    assert data["min_ts"] <= data["max_ts"]


def test_cells_europe_bbox():
    resp = client.get("/api/cells", params={"bbox": "-10,35,30,60", "res": 5})
    assert resp.status_code == 200
    data = resp.json()
    assert "cells" in data
    cells = data["cells"]
    assert len(cells) > 0
    for c in cells:
        assert isinstance(c["h3"], str)
        assert h3.is_valid_cell(c["h3"])
        assert c["detections"] >= 1


def test_calendar_bbox():
    health = client.get("/api/health").json()
    resp = client.post(
        "/api/calendar",
        json={
            "bbox": [-10, 35, 30, 60],
            "from": health["min_ts"],
            "to": health["max_ts"],
            "res": 4,
        },
    )
    assert resp.status_code == 200
    data = resp.json()
    assert "months" in data
    assert "climatology" in data
    assert "anomaly" in data
    assert "totals" in data

    assert len(data["climatology"]) > 0
    for clim in data["climatology"]:
        assert "median_detections" in clim

    months_sum = sum(m["detections"] for m in data["months"])
    assert data["totals"]["detections"] == months_sum
    assert data["totals"]["detections"] > 0


def test_calendar_malformed_body_returns_422():
    resp_bad_bbox = client.post(
        "/api/calendar",
        json={
            "bbox": [-10, 35, 30],
            "from": "2026-11-01",
            "to": "2026-11-14",
        },
    )
    assert resp_bad_bbox.status_code == 422

    resp_bad_dates = client.post(
        "/api/calendar",
        json={
            "bbox": [-10, 35, 30, 60],
            "from": "2026-11-14",
            "to": "2026-11-01",
        },
    )
    assert resp_bad_dates.status_code == 422


def test_export_csv():
    resp = client.get(
        "/api/export.csv",
        params={"bbox": "10,38,25,45", "from": "2026-11-07", "to": "2026-11-14"},
    )
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/csv")
    lines = resp.text.splitlines()
    assert len(lines) >= 1
    assert (
        lines[0].strip()
        == "ts,lat,lon,sensor,satellite,confidence_pct,frp_mw,daynight,h3_r8"
    )


def test_points_ordered_by_frp_desc_and_honours_limit():
    limit = 15
    resp = client.get(
        "/api/points",
        params={"bbox": "-10,35,30,60", "limit": limit},
    )
    assert resp.status_code == 200
    data = resp.json()
    points = data["points"]
    assert 0 < len(points) <= limit
    frps = [p["frp_mw"] for p in points]
    assert frps == sorted(frps, reverse=True)
