# NASA Hotspots HTTP API (`api/`)

FastAPI service backed by a read-only DuckDB connection (`data/fires.duckdb`) with the DuckDB `h3` extension and Python `h3` library.

## How to Run

From `/root/nasa-hotspots`:

```bash
./.venv/bin/python -m uvicorn api.app:app --host 127.0.0.1 --port 8100
```

## Endpoints

### `GET /api/health`
Returns dataset readiness and summary counts (`200 OK`), or `503 {"error": "data_not_ready"}` if the DuckDB database or required tables are missing.

```bash
curl -s http://localhost:8100/api/health
```

### `GET /api/cells`
Aggregates detections and mean FRP into parent H3 cells (`h3_cell_to_parent(h3_r8, res)`) returned as standard H3 hex strings. Caps results at 20,000 cells (`truncated: true` if exceeded).

Query parameters:
- `res` (int, 0–15, default `5`)
- `from` (`YYYY-MM-DD`)
- `to` (`YYYY-MM-DD`)
- `bbox` (`minlon,minlat,maxlon,maxlat`)

```bash
curl -s "http://localhost:8100/api/cells?res=5&from=2026-11-07&to=2026-11-14&bbox=-10,35,30,60"
```

### `POST /api/calendar`
Computes monthly hotspot detections, mean FRP, climatology, anomaly ratios, and sensor totals (`MODIS` vs `VIIRS`) for a bounding box (`bbox` expanded to H3 cells at `res`) or explicit `h3_cells`.

```bash
curl -s -X POST http://localhost:8100/api/calendar \
  -H "Content-Type: application/json" \
  -d '{"bbox":[-10,35,30,60],"from":"2026-11-01","to":"2026-11-30","res":4}'
```

### `GET /api/export.csv`
Streams filtered hotspot records as a `text/csv` attachment with columns `ts,lat,lon,sensor,satellite,confidence_pct,frp_mw,daynight,h3_r8`.

```bash
curl -s "http://localhost:8100/api/export.csv?bbox=-10,35,30,60&from=2026-11-07&to=2026-11-14" | head -3
```
