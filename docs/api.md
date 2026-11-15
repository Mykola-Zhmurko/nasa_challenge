# HTTP API

FastAPI app in `api/app.py`, served by uvicorn on `127.0.0.1:8100` (systemd unit `nasa-hotspots-api`,
one worker). All routes are prefixed `/api`. The database is opened **read-only** per request
(`api/db.py`); the API never writes.

Interactive schema: `http://127.0.0.1:8100/docs` (Swagger) and `/openapi.json`.

| Method | Path | Returns |
|---|---|---|
| GET | `/api/health` | dataset readiness + totals |
| GET | `/api/cells` | hexagon aggregates for the map |
| GET | `/api/points` | single detections, paginated |
| POST | `/api/calendar` | months, days, climatology, anomaly, totals |
| GET | `/api/export.csv` | CSV download of the filtered rows |

## Conventions

- **Dates** are ISO `YYYY-MM-DD` and **inclusive** on both ends. A bad date is rejected with `422`.
- **`bbox`** is always `minlon,minlat,maxlon,maxlat` = `[west, south, east, north]`. In query strings it is
  comma-separated: `bbox=-25,34,45,72`. Longitudes must satisfy `-180 <= minlon <= maxlon <= 180`,
  latitudes `-90 <= minlat <= maxlat <= 90`.
- **`from` / `from_date`** are aliases — send either; `from` wins when both are present.
- All filters are optional unless the table says "required". Without filters an endpoint answers for the
  whole dataset (slow and large — always send a `bbox` and a date window from the UI).
- Errors:

| Status | Body | Cause |
|---|---|---|
| `422` | `{"detail": "<message>"}` on GET, `{"detail": [{...}]}` on POST | unparseable date, invalid bbox, `from > to`, unknown body field |
| `503` | `{"error": "data_not_ready"}` | `data/fires.duckdb` missing, empty, or `fires` / `calendar_monthly` / `calendar_global` not queryable |

---

## GET /api/health

Readiness probe and the dataset window. The frontend calls it on load and uses `min_ts`/`max_ts` as the
dataset limits for the date pickers.

| Param | Type | Default | Notes |
|---|---|---|---|
| — | — | — | no parameters |

```json
{"status": "ok", "rows": 594017, "min_ts": "2001-01-01", "max_ts": "2026-11-14", "cells": 511396}
```

`cells` is `COUNT(DISTINCT h3_r8)` over the whole table. `503` instead of a body when the data is not ready.

```bash
curl -s http://127.0.0.1:8100/api/health
```

---

## GET /api/cells

Hexagon aggregates for the map layer: detections and mean FRP per parent H3 cell.

| Param | Type | Default | Range | Notes |
|---|---|---|---|---|
| `res` | int | `5` | 0–15 | **grouping is capped at 8** (`min(res, 8)`) — 9…15 behave like 8 |
| `from` | date | — | — | inclusive lower bound on `ts` |
| `from_date` | date | — | — | alias for `from` |
| `to` | date | — | — | inclusive upper bound on `ts` |
| `bbox` | string | — | 4 floats | filters the **raw** `lat`/`lon` columns, not H3 cells |

```json
{"cells": [{"h3": "842c12dffffffff", "detections": 129, "mean_frp": 13.85}], "truncated": false}
```

- Rows are ordered `detections DESC` and the query fetches `LIMIT 20001`; when more than **20,000** cells
  match, the response keeps the top 20,000 and sets `"truncated": true`. The panel shows a hint when that
  flag is set. Measured on the default 7-day window: `res=4` world → 17,732 cells, not truncated;
  `res=5` world → 20,000 cells, `truncated: true`; `res=5` Europe → 957 cells.
- `mean_frp` is rounded to 2 decimals, `0.0` when FRP is missing.

```bash
curl -s "http://127.0.0.1:8100/api/cells?res=4&from=2026-11-07&to=2026-11-14&bbox=-25,34,45,72"
```

---

## GET /api/points

Individual detections, ordered by fire power. Used by the map above zoom 8 and by clients that need the
raw rows rather than hexagons.

| Param | Type | Default | Range | Notes |
|---|---|---|---|---|
| `bbox` | string | — | 4 floats | filters `lat`/`lon` |
| `from` | date | — | — | inclusive |
| `from_date` | date | — | — | alias |
| `to` | date | — | — | inclusive |
| `limit` | int | `5000` | 1–20000 | page size |
| `offset` | int | `0` | ≥ 0 | rows to skip |

```json
{
  "points": [
    {"ts": "2026-11-12", "time_utc": null, "lat": 36.62791, "lon": 6.9827, "sensor": "MODIS",
     "satellite": "A", "confidence_pct": 100, "frp_mw": 287.01, "daynight": "D",
     "h3_r8": "8838620183fffff"}
  ],
  "total": 2525,
  "truncated": true
}
```

- **Pagination:** `total` is `COUNT(*)` for the same filters; `truncated` is
  `offset + len(points) < total`. Page through with `offset += limit` until `truncated` is `false`.
  `limit` above 20,000 is a `422`.
- Order is `frp_mw DESC, ts DESC, h3_r8 ASC`, so the strongest fires come first, not the newest.
- `time_utc` is `null` in the current schema: the column is only filled when `fires` carries `time_utc` or
  `acq_time`, and today it carries neither.
- `h3_r8` is the hex string (`h3_h3_to_string`), not the integer stored in the table.

```bash
curl -s "http://127.0.0.1:8100/api/points?bbox=-25,34,45,72&from=2026-11-07&to=2026-11-14&limit=100&offset=0"
```

---

## POST /api/calendar

The burning calendar and everything derived from it. This is the only endpoint with a JSON body, because
the area can be given as an H3 cell list.

| Body field | Type | Default | Notes |
|---|---|---|---|
| `bbox` | float[4] | `null` | `[minlon, minlat, maxlon, maxlat]`, expanded to H3 cells at `res` |
| `h3_cells` | string[] | `null` | hex strings or integer strings; cells finer than 8 are reduced to their level-8 parent |
| `from` | date | — | **required** (alias `from_date` also accepted) |
| `to` | date | — | **required**, must be `>= from` |
| `res` | int | `4` | 0–15; used for the bbox → H3 expansion and the `totals.cells` count, effective max 8 |

- Unknown body fields are rejected (`extra="forbid"` → `422`), so a typo never silently changes the result.
- With neither `bbox` nor `h3_cells` the query runs over the whole world.
- The bbox expansion uses `h3.polygon_to_cells_experimental` with overlap containment, split into 60°
  longitude strips. If the bbox at `res` would need more than 120,000 cells, `res` is lowered until it fits.

```json
{
  "months": [{"year": 2020, "month": 12, "detections": 58, "mean_frp": 25.65}],
  "days": [
    {"date": "2020-12-01", "detections": 34, "mean_frp": 17.85},
    {"date": "2020-12-02", "detections": 24, "mean_frp": 36.7}
  ],
  "climatology": [{"month": 12, "median_detections": 919.5, "mean_detections": 919.5}],
  "anomaly": [{"year": 2020, "month": 12, "ratio": 0.2}],
  "totals": {"detections": 58, "cells": 20, "sensors": {"MODIS": 58, "VIIRS": 0}}
}
```

- `months` and `days` cover **only** the `from`/`to` window — a one-week window returns one month row.
- `climatology` does **not** follow the window: it is read from the precomputed `calendar_monthly` table
  (median and mean per calendar month over all loaded years), filtered only by the spatial filter. This is
  why a partial history produces a median from few years — see [data.md](data.md).
- `anomaly` has one row per month in `months`: `detections / median_detections`, `0.0` when the median is
  missing or zero. It is **not** normalised for a partial month.
- `totals.cells` is the distinct parent cell count at `min(res, 8)`; `totals.sensors` counts the rows whose
  `sensor` column is `MODIS` or `VIIRS`.

```bash
curl -s -X POST http://127.0.0.1:8100/api/calendar \
  -H 'Content-Type: application/json' \
  -d '{"bbox":[-25,34,45,72],"from":"2020-12-01","to":"2020-12-05","res":4}'
```

Error example (`from` after `to`):

```json
{"detail": [{"type": "value_error", "loc": ["body"],
  "msg": "Value error, 'from' date must be on or before 'to' date", "input": {...}}]}
```

---

## GET /api/export.csv

CSV download of the filtered rows. The UI builds the `href` from the active filters, so the file always
matches what the map shows.

| Param | Type | Default | Notes |
|---|---|---|---|
| `bbox` | string | — | filters `lat`/`lon` |
| `from` | date | — | inclusive |
| `from_date` | date | — | alias |
| `to` | date | — | inclusive |
| `h3_cells` | string[] | — | repeatable (`?h3_cells=a&h3_cells=b`) or comma-separated |

- Response is `text/csv; charset=utf-8` with
  `Content-Disposition: attachment; filename="fires_export.csv"`.
- Header: `ts,lat,lon,sensor,satellite,confidence_pct,frp_mw,daynight,h3_r8`, ordered by `ts, h3_r8`.
- **No pagination and no row cap** — the whole result set is built in memory and sent as one chunk. The
  nginx `/api/` block raises `proxy_read_timeout` to 180 s, which is what lets a large export finish.

```bash
curl -s "http://127.0.0.1:8100/api/export.csv?bbox=-25,34,45,72&from=2020-12-01&to=2020-12-01" | head -3
# ts,lat,lon,sensor,satellite,confidence_pct,frp_mw,daynight,h3_r8
# 2020-12-01,52.5427,39.6355,MODIS,Aqua,97,0.0,N,88119eb463fffff
```

---

## Client usage (`web/lib/api.ts`)

The frontend never hardcodes a host: `API_BASE = import.meta.env.VITE_API_BASE || '/api'`, and the Vite
dev server / nginx proxy `/api` to port 8100. Each call returns `{status, data, error}` with `status` one
of `idle | loading | ok | error | not-ready`; `503` becomes `not-ready` and is shown as "data not ready"
instead of an error.
