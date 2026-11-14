"""FastAPI NASA Fire Hotspots API."""

from datetime import date
import io
import math
from typing import Dict, List, Optional, Tuple

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
import h3
import pandas as pd
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .db import get_connection

app = FastAPI(title="NASA Hotspots API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def parse_iso_date(val: str, field_name: str = "date") -> str:
    """Validate and normalize an ISO YYYY-MM-DD date string."""
    try:
        parsed = date.fromisoformat(val.strip())
        return parsed.isoformat()
    except Exception as exc:
        raise ValueError(f"Invalid {field_name} '{val}': must be YYYY-MM-DD") from exc


def validate_bbox_list(bbox: List[float]) -> Tuple[float, float, float, float]:
    """Validate [minlon, minlat, maxlon, maxlat] bounding box."""
    if len(bbox) != 4:
        raise ValueError("bbox must have 4 elements: [minlon, minlat, maxlon, maxlat]")
    minlon, minlat, maxlon, maxlat = [float(x) for x in bbox]
    if any(math.isnan(x) or math.isinf(x) for x in (minlon, minlat, maxlon, maxlat)):
        raise ValueError("bbox coordinates must be finite numbers")
    if minlon < -180.0 or maxlon > 180.0 or minlon > maxlon:
        raise ValueError("bbox longitudes must satisfy -180 <= minlon <= maxlon <= 180")
    if minlat < -90.0 or maxlat > 90.0 or minlat > maxlat:
        raise ValueError("bbox latitudes must satisfy -90 <= minlat <= maxlat <= 90")
    return minlon, minlat, maxlon, maxlat


def parse_bbox_str(bbox_str: str) -> Tuple[float, float, float, float]:
    """Parse comma-separated 'minlon,minlat,maxlon,maxlat' string."""
    parts = [p.strip() for p in bbox_str.split(",")]
    if len(parts) != 4:
        raise ValueError("bbox must have 4 comma-separated numbers: minlon,minlat,maxlon,maxlat")
    try:
        coords = [float(p) for p in parts]
    except ValueError as exc:
        raise ValueError("bbox values must be valid numbers") from exc
    return validate_bbox_list(coords)


def parse_h3_cell(cell_str: str) -> Tuple[int, int]:
    """Parse an H3 cell (hex string or integer string) into (resolution, int_index)."""
    s = cell_str.strip()
    if not s:
        raise ValueError("Empty H3 cell string")
    try:
        if h3.is_valid_cell(s):
            return h3.get_resolution(s), h3.str_to_int(s)
    except Exception:
        pass
    try:
        val = int(s)
        if h3.is_valid_cell(val):
            hex_str = h3.int_to_str(val)
            return h3.get_resolution(hex_str), val
    except Exception:
        pass
    raise ValueError(f"Invalid H3 cell identifier: '{cell_str}'")


def expand_bbox_to_h3_ints(
    bbox: Tuple[float, float, float, float], res: int
) -> Tuple[int, List[int]]:
    """Expand [minlon, minlat, maxlon, maxlat] to H3 integer cell IDs at resolution `res`.

    Uses h3 polygon fill (`polygon_to_cells_experimental` with overlap containment)
    across longitude segments so wide bounding boxes follow parallels cleanly,
    plus corner cell lookups for sub-cell bounding boxes.
    """
    minlon, minlat, maxlon, maxlat = bbox
    eff_res = max(0, min(int(res), 8))

    # Keep cell expansion bounded if a caller passes a near-global bbox with high res
    lon_span = max(0.0, maxlon - minlon)
    lat_span = max(0.0, maxlat - minlat)
    area_fraction = max(1e-6, (lon_span / 360.0) * (lat_span / 180.0))
    while eff_res > 2 and h3.get_num_cells(eff_res) * area_fraction > 120_000:
        eff_res -= 1

    clamped_minlat = max(-89.9, min(89.9, minlat))
    clamped_maxlat = max(-89.9, min(89.9, maxlat))
    clamped_minlon = max(-179.999, min(179.999, minlon))
    clamped_maxlon = max(-179.999, min(179.999, maxlon))

    cells = set()
    if clamped_maxlon > clamped_minlon and clamped_maxlat > clamped_minlat:
        span = clamped_maxlon - clamped_minlon
        n_chunks = max(1, int(span // 60.0) + 1)
        for i in range(n_chunks):
            l0 = clamped_minlon + (span * i) / n_chunks
            l1 = clamped_minlon + (span * (i + 1)) / n_chunks
            top_edge = [
                (clamped_maxlat, l0 + (l1 - l0) * k / 12.0) for k in range(13)
            ]
            bottom_edge = [
                (clamped_minlat, l1 - (l1 - l0) * k / 12.0) for k in range(13)
            ]
            poly = h3.LatLngPoly(top_edge + bottom_edge)
            cells.update(
                h3.polygon_to_cells_experimental(poly, eff_res, contain="overlap")
            )

    for lat in (clamped_minlat, clamped_maxlat, (clamped_minlat + clamped_maxlat) / 2.0):
        for lon in (clamped_minlon, clamped_maxlon, (clamped_minlon + clamped_maxlon) / 2.0):
            cells.add(h3.latlng_to_cell(lat, lon, eff_res))

    return eff_res, [h3.str_to_int(c) for c in cells]


def build_h3_sql_filter(
    h3_cells: Optional[List[str]],
    bbox: Optional[Tuple[float, float, float, float]],
    res: int,
) -> Tuple[str, List[object]]:
    """Build SQL predicate and parameters for H3 cells or bbox expanded to H3 cells."""
    if h3_cells:
        grouped: Dict[int, List[int]] = {}
        for raw_item in h3_cells:
            for part in raw_item.split(","):
                part = part.strip()
                if not part:
                    continue
                cell_res, cell_int = parse_h3_cell(part)
                parent_res = min(cell_res, 8)
                if cell_res > 8:
                    cell_int = h3.str_to_int(
                        h3.cell_to_parent(h3.int_to_str(cell_int), 8)
                    )
                grouped.setdefault(parent_res, []).append(cell_int)
        if not grouped:
            raise ValueError("h3_cells list cannot be empty")
        clauses = []
        params: List[object] = []
        for r, ints in grouped.items():
            if r == 8:
                clauses.append("h3_r8 IN (SELECT UNNEST(?::BIGINT[]))")
            else:
                clauses.append(
                    f"h3_cell_to_parent(h3_r8, {r}) IN (SELECT UNNEST(?::BIGINT[]))"
                )
            params.append(ints)
        if len(clauses) == 1:
            return clauses[0], params
        return "(" + " OR ".join(clauses) + ")", params

    if bbox is not None:
        eff_res, cell_ints = expand_bbox_to_h3_ints(bbox, res)
        if eff_res == 8:
            return "h3_r8 IN (SELECT UNNEST(?::BIGINT[]))", [cell_ints]
        return (
            f"h3_cell_to_parent(h3_r8, {eff_res}) IN (SELECT UNNEST(?::BIGINT[]))",
            [cell_ints],
        )

    return "", []


# ---- Pydantic models ----


class CalendarRequest(BaseModel):
    """Request body for POST /api/calendar."""

    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    h3_cells: Optional[List[str]] = Field(
        default=None, description="List of H3 cell IDs (hex strings)"
    )
    bbox: Optional[List[float]] = Field(
        default=None, description="[minlon, minlat, maxlon, maxlat]"
    )
    from_: Optional[str] = Field(
        default=None, alias="from", description="Start date inclusive, ISO YYYY-MM-DD"
    )
    from_date: Optional[str] = Field(
        default=None, description="Fallback alias for start date, ISO YYYY-MM-DD"
    )
    to: str = Field(..., description="End date inclusive, ISO YYYY-MM-DD")
    res: int = Field(default=4, ge=0, le=15, description="H3 resolution")

    @model_validator(mode="after")
    def validate_request(self) -> "CalendarRequest":
        start_raw = self.from_ if self.from_ is not None else self.from_date
        if not start_raw:
            raise ValueError("Field 'from' is required (ISO YYYY-MM-DD)")
        start_iso = parse_iso_date(start_raw, "from")
        end_iso = parse_iso_date(self.to, "to")
        if start_iso > end_iso:
            raise ValueError("'from' date must be on or before 'to' date")
        self.from_ = start_iso
        self.to = end_iso

        if self.bbox is not None:
            validate_bbox_list(self.bbox)

        if self.h3_cells is not None:
            if len(self.h3_cells) == 0:
                raise ValueError("h3_cells cannot be an empty list")
            for c in self.h3_cells:
                parse_h3_cell(c)

        return self


# ---- Endpoints ----


@app.get("/api/health")
async def health():
    """Health check with dataset statistics."""
    con, ready = get_connection()
    if not ready or con is None:
        return JSONResponse(
            status_code=503,
            content={"error": "data_not_ready"},
        )

    try:
        row = con.execute(
            """
            SELECT
                COUNT(*) AS rows,
                CAST(MIN(ts) AS VARCHAR) AS min_ts,
                CAST(MAX(ts) AS VARCHAR) AS max_ts,
                COUNT(DISTINCT h3_r8) AS cells
            FROM fires
            """
        ).fetchone()
        return {
            "status": "ok",
            "rows": int(row[0]) if row and row[0] is not None else 0,
            "min_ts": str(row[1]) if row and row[1] is not None else None,
            "max_ts": str(row[2]) if row and row[2] is not None else None,
            "cells": int(row[3]) if row and row[3] is not None else 0,
        }
    finally:
        con.close()


@app.get("/api/cells")
async def cells(
    res: int = Query(5, ge=0, le=15),
    from_: Optional[str] = Query(None, alias="from"),
    from_date: Optional[str] = Query(None),
    to: Optional[str] = Query(None),
    bbox: Optional[str] = Query(None),
):
    """Hexagon cell aggregates for the map."""
    con, ready = get_connection()
    if not ready or con is None:
        return JSONResponse(
            status_code=503,
            content={"error": "data_not_ready"},
        )

    try:
        conditions: List[str] = []
        params: List[object] = []

        start_raw = from_ if from_ is not None else from_date
        start_iso: Optional[str] = None
        end_iso: Optional[str] = None

        try:
            if start_raw:
                start_iso = parse_iso_date(start_raw, "from")
                conditions.append("ts >= ?")
                params.append(start_iso)
            if to:
                end_iso = parse_iso_date(to, "to")
                conditions.append("ts <= ?")
                params.append(end_iso)
            if start_iso and end_iso and start_iso > end_iso:
                raise ValueError("'from' date must be on or before 'to' date")
            if bbox:
                minlon, minlat, maxlon, maxlat = parse_bbox_str(bbox)
                conditions.append("lat >= ? AND lat <= ? AND lon >= ? AND lon <= ?")
                params.extend([minlat, maxlat, minlon, maxlon])
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

        where_sql = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        parent_res = min(res, 8)

        query = f"""
            SELECT
                h3_h3_to_string(h3_cell_to_parent(h3_r8, {parent_res})) AS h3,
                COUNT(*) AS detections,
                AVG(frp_mw) AS mean_frp
            FROM fires
            {where_sql}
            GROUP BY h3
            ORDER BY detections DESC
            LIMIT 20001
        """
        rows = con.execute(query, params).fetchall()
        truncated = len(rows) > 20000
        if truncated:
            rows = rows[:20000]

        result_cells = [
            {
                "h3": str(r[0]),
                "detections": int(r[1]),
                "mean_frp": round(float(r[2]), 2) if r[2] is not None else 0.0,
            }
            for r in rows
        ]
        return {"cells": result_cells, "truncated": truncated}
    finally:
        con.close()


@app.get("/api/points")
async def points(
    bbox: Optional[str] = Query(None),
    from_: Optional[str] = Query(None, alias="from"),
    from_date: Optional[str] = Query(None),
    to: Optional[str] = Query(None),
    limit: int = Query(5000, ge=1, le=20000),
    offset: int = Query(0, ge=0),
):
    """Individual hotspot detections ordered by FRP descending."""
    con, ready = get_connection()
    if not ready or con is None:
        return JSONResponse(
            status_code=503,
            content={"error": "data_not_ready"},
        )

    try:
        conditions: List[str] = []
        params: List[object] = []

        start_raw = from_ if from_ is not None else from_date
        start_iso: Optional[str] = None
        end_iso: Optional[str] = None

        try:
            if start_raw is not None:
                start_iso = parse_iso_date(start_raw, "from")
                conditions.append("ts >= ?")
                params.append(start_iso)
            if to is not None:
                end_iso = parse_iso_date(to, "to")
                conditions.append("ts <= ?")
                params.append(end_iso)
            if start_iso and end_iso and start_iso > end_iso:
                raise ValueError("'from' date must be on or before 'to' date")
            if bbox is not None:
                minlon, minlat, maxlon, maxlat = parse_bbox_str(bbox)
                conditions.append("lat >= ? AND lat <= ? AND lon >= ? AND lon <= ?")
                params.extend([minlat, maxlat, minlon, maxlon])
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

        where_sql = f"WHERE {' AND '.join(conditions)}" if conditions else ""

        count_row = con.execute(
            f"SELECT COUNT(*) FROM fires {where_sql}",
            params,
        ).fetchone()
        total = int(count_row[0]) if count_row and count_row[0] is not None else 0

        col_rows = con.execute("PRAGMA table_info('fires')").fetchall()
        col_names = {str(c[1]).lower() for c in col_rows}
        time_expr = (
            "CAST(time_utc AS VARCHAR)"
            if "time_utc" in col_names
            else ("CAST(acq_time AS VARCHAR)" if "acq_time" in col_names else "NULL")
        )

        query = f"""
            SELECT
                CAST(ts AS VARCHAR) AS ts,
                {time_expr} AS time_utc,
                lat,
                lon,
                sensor,
                satellite,
                confidence_pct,
                frp_mw,
                daynight,
                h3_h3_to_string(h3_r8) AS h3_r8
            FROM fires
            {where_sql}
            ORDER BY frp_mw DESC, ts DESC, h3_r8 ASC
            LIMIT ? OFFSET ?
        """
        rows = con.execute(query, [*params, limit, offset]).fetchall()

        result_points = [
            {
                "ts": str(r[0]),
                "time_utc": str(r[1]) if r[1] is not None else None,
                "lat": round(float(r[2]), 5) if r[2] is not None else 0.0,
                "lon": round(float(r[3]), 5) if r[3] is not None else 0.0,
                "sensor": str(r[4]) if r[4] is not None else "",
                "satellite": str(r[5]) if r[5] is not None else "",
                "confidence_pct": int(r[6]) if r[6] is not None else 0,
                "frp_mw": round(float(r[7]), 2) if r[7] is not None else 0.0,
                "daynight": str(r[8]) if r[8] is not None else "",
                "h3_r8": str(r[9]),
            }
            for r in rows
        ]
        truncated = (offset + len(result_points)) < total
        return {
            "points": result_points,
            "total": total,
            "truncated": truncated,
        }
    finally:
        con.close()


@app.post("/api/calendar")
async def calendar(req: CalendarRequest):
    """Monthly burning activity calendar with climatology, anomaly, and sensor totals."""
    con, ready = get_connection()
    if not ready or con is None:
        return JSONResponse(
            status_code=503,
            content={"error": "data_not_ready"},
        )

    try:
        bbox_tuple = validate_bbox_list(req.bbox) if req.bbox is not None else None
        try:
            spatial_sql, spatial_params = build_h3_sql_filter(
                req.h3_cells, bbox_tuple, req.res
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

        conditions = ["ts >= ?", "ts <= ?"]
        params: List[object] = [req.from_, req.to]
        if spatial_sql:
            conditions.append(spatial_sql)
            params.extend(spatial_params)

        where_sql = " AND ".join(conditions)

        # Monthly aggregations across the filtered region and time window
        months_rows = con.execute(
            f"""
            SELECT
                CAST(EXTRACT(YEAR FROM ts) AS INTEGER) AS year,
                CAST(EXTRACT(MONTH FROM ts) AS INTEGER) AS month,
                COUNT(*) AS detections,
                AVG(frp_mw) AS mean_frp
            FROM fires
            WHERE {where_sql}
            GROUP BY year, month
            ORDER BY year, month
            """,
            params,
        ).fetchall()

        months = [
            {
                "year": int(r[0]),
                "month": int(r[1]),
                "detections": int(r[2]),
                "mean_frp": round(float(r[3]), 2) if r[3] is not None else 0.0,
            }
            for r in months_rows
        ]

        # Daily aggregation for the timeline strip
        days_rows = con.execute(
            f"""
            SELECT
                CAST(ts AS VARCHAR) AS day,
                COUNT(*) AS detections,
                AVG(frp_mw) AS mean_frp
            FROM fires
            WHERE {where_sql}
            GROUP BY day
            ORDER BY day
            """,
            params,
        ).fetchall()

        days = [
            {
                "date": str(r[0]),
                "detections": int(r[1]),
                "mean_frp": round(float(r[2]), 2) if r[2] is not None else 0.0,
            }
            for r in days_rows
        ]

        # Climatology from calendar_monthly (filtered spatially) or calendar_global
        if spatial_sql:
            clim_rows = con.execute(
                f"""
                SELECT
                    month,
                    SUM(detections)::DOUBLE / GREATEST(COUNT(DISTINCT year), 1)::DOUBLE AS mean_detections
                FROM calendar_monthly
                WHERE {spatial_sql}
                GROUP BY month
                ORDER BY month
                """,
                spatial_params,
            ).fetchall()
        else:
            clim_rows = con.execute(
                """
                SELECT
                    month,
                    detections::DOUBLE / (
                        SELECT GREATEST(COUNT(DISTINCT year), 1)::DOUBLE FROM calendar_monthly
                    ) AS mean_detections
                FROM calendar_global
                ORDER BY month
                """
            ).fetchall()

        clim_map: Dict[int, float] = {
            int(r[0]): float(r[1]) for r in clim_rows if r[1] is not None
        }
        climatology = [
            {"month": int(r[0]), "mean_detections": round(float(r[1]), 2)}
            for r in clim_rows
            if r[1] is not None
        ]

        anomaly = []
        for m in months:
            base = clim_map.get(m["month"], 0.0)
            ratio = round(m["detections"] / base, 2) if base > 0 else 0.0
            anomaly.append(
                {
                    "year": m["year"],
                    "month": m["month"],
                    "ratio": ratio,
                }
            )

        parent_res = min(req.res, 8)
        totals_row = con.execute(
            f"""
            SELECT
                COUNT(*) AS detections,
                COUNT(DISTINCT h3_cell_to_parent(h3_r8, {parent_res})) AS cells,
                COALESCE(SUM(CASE WHEN sensor = 'MODIS' THEN 1 ELSE 0 END), 0) AS modis,
                COALESCE(SUM(CASE WHEN sensor = 'VIIRS' THEN 1 ELSE 0 END), 0) AS viirs
            FROM fires
            WHERE {where_sql}
            """,
            params,
        ).fetchone()

        totals = {
            "detections": int(totals_row[0]) if totals_row and totals_row[0] else 0,
            "cells": int(totals_row[1]) if totals_row and totals_row[1] else 0,
            "sensors": {
                "MODIS": int(totals_row[2]) if totals_row and totals_row[2] else 0,
                "VIIRS": int(totals_row[3]) if totals_row and totals_row[3] else 0,
            },
        }

        return {
            "months": months,
            "days": days,
            "climatology": climatology,
            "anomaly": anomaly,
            "totals": totals,
        }
    finally:
        con.close()


@app.get("/api/export.csv")
async def export_csv(
    bbox: Optional[str] = Query(None),
    from_: Optional[str] = Query(None, alias="from"),
    from_date: Optional[str] = Query(None),
    to: Optional[str] = Query(None),
    h3_cells: Optional[List[str]] = Query(None),
):
    """CSV export of filtered hotspot detections."""
    con, ready = get_connection()
    if not ready or con is None:
        return JSONResponse(
            status_code=503,
            content={"error": "data_not_ready"},
        )

    try:
        conditions: List[str] = []
        params: List[object] = []

        start_raw = from_ if from_ is not None else from_date
        start_iso: Optional[str] = None
        end_iso: Optional[str] = None

        try:
            if start_raw:
                start_iso = parse_iso_date(start_raw, "from")
                conditions.append("ts >= ?")
                params.append(start_iso)
            if to:
                end_iso = parse_iso_date(to, "to")
                conditions.append("ts <= ?")
                params.append(end_iso)
            if start_iso and end_iso and start_iso > end_iso:
                raise ValueError("'from' date must be on or before 'to' date")

            if h3_cells:
                h3_sql, h3_params = build_h3_sql_filter(h3_cells, None, 8)
                if h3_sql:
                    conditions.append(h3_sql)
                    params.extend(h3_params)

            if bbox:
                minlon, minlat, maxlon, maxlat = parse_bbox_str(bbox)
                conditions.append("lat >= ? AND lat <= ? AND lon >= ? AND lon <= ?")
                params.extend([minlat, maxlat, minlon, maxlon])
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

        where_sql = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        query = f"""
            SELECT ts, lat, lon, sensor, satellite, confidence_pct, frp_mw, daynight, h3_r8
            FROM fires
            {where_sql}
            ORDER BY ts, h3_r8
        """
        df = con.execute(query, params).df()
    finally:
        con.close()

    csv_buffer = io.StringIO()
    df.to_csv(csv_buffer, index=False)
    csv_bytes = csv_buffer.getvalue().encode("utf-8")

    return StreamingResponse(
        iter([csv_bytes]),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="fires_export.csv"'},
    )
