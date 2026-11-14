# SPEC — NASA Space Apps 2026: Harmonization of MODIS and VIIRS Hot Spots

Event: 2026 NASA Space Apps Challenge, 14–15 Nov 2026. Team "The One", Dnipro local event.
Deadline submission: 15 Nov 2026, 22:59 (local event end).

## Challenge requirement (official excerpt)
"Satellites have tracked active fire hotspots for more than two decades, but the record is split
across sensors whose data cannot be compared directly. Build a web application that harmonizes
these records into a burning activity calendar based on active fire hotspots, enabling early warning
and emergency responders, scientists and land managers to examine historical fire patterns,
unusual conditions and critical periods within a selected area of interest."

Must-haves:
1. Harmonized single series from MODIS (2000+) and VIIRS (2012+) — user must not see sensor split.
2. Area of interest selection: draw polygon on map AND/OR enter lat/lon.
3. Burning activity calendar: monthly heatmap / seasonality + current vs 20-year normal.
4. CSV export of the filtered data.
5. At least one resource from the challenge Resources tab must be used.

## Data
Source: NASA FIRMS (https://firms.modaps.eosdis.nasa.gov).
- MODIS C6.1: 1 km, confidence 0–100, column `brightness`, `bright_t31`.
- VIIRS C2 (Suomi-NPP, NOAA-20): 375 m, confidence nominal|low|high, column `bright_ti4`.
- Public 7-day CSVs (no key): `/data/active_fire/<product>/csv/<NAME>_Global_7d.csv`.
- Historical bulk (2000+/2012+): FIRMS API area endpoint with free MAP_KEY
  `https://firms.modaps.eosdis.nasa.gov/api/area/csv/<MAP_KEY>/<SOURCE>/<AREA>/<DAY_RANGE>/<START_DATE>`
  (max 5 days per call) or archive download (needs Earthdata login).
- Raw files already present: `data/raw/*.csv` (MODIS global 7d, VIIRS J1 global 7d, MODIS Europe 7d).

## Harmonization rules (must be implemented and documented)
- Drop VIIRS confidence `low`; keep `nominal` and `high`. Drop MODIS confidence < 50, flag < 80.
- Normalize to a common schema: `ts` (date), `sensor` (MODIS|VIIRS), `satellite`, `lat`, `lon`,
  `confidence_pct` (MODIS 0-100, VIIRS nominal→50/high→90), `frp_mw`, `daynight`.
- Deduplicate cross-sensor duplicates: same H3 cell (res 8) within the same UTC day → keep one,
  prefer the higher-confidence / higher-FRP detection, mark `sources` bitmask.
- Harmonized intensity value `intensity` = 1 per retained detection (count-based calendar), plus
  mean FRP as secondary metric.
- H3: store `h3_r8` (edge ≈ 0.53 km, ~1 km pixel scale) as INTEGER/BIGINT. Parent levels derived
  on the fly with `h3_to_parent` (DuckDB h3 community extension) — never stored per level.

## Architecture
- `pipeline/` Python 3: download → harmonize → enrich with H3 → write `data/fires.parquet`
  + `data/fires.duckdb` (table `fires`) + precomputed monthly aggregates table
  `calendar_monthly(h3_r8, month, detections, mean_frp)`.
- `pipeline/import.py` Python 3: streaming, out-of-core import of additional raw FIRMS CSV
  files (7-day download or multi-year archive download, any region, MODIS C6.1 or VIIRS C2)
  into the existing `fires` table. Pure DuckDB SQL (`read_csv` + h3 extension) with
  `memory_limit` and `temp_directory`, no pandas/pyarrow: peak RSS ~220 MB on 0.5 M rows and
  ~340 MB on 3 M rows, i.e. bounded independent of file size. Idempotent (same file twice →
  same row count), merges existing cell-days (`sources` bitmask OR), rebuilds
  `calendar_monthly`/`calendar_global`, writes into a temporary copy and swaps it in atomically
  so the running API keeps serving. Usage: `python -m pipeline.import --input <csv> [...]`
  or `--dir <folder>`; details in `pipeline/README.md`.
- `api/` Python FastAPI (uvicorn, 127.0.0.1:8100): endpoints
  - `GET /api/health`
  - `POST /api/calendar` {h3_cells[] | bbox, from, to, res} → monthly counts + climatology + anomaly
  - `GET /api/cells?res=&from=&to=&bbox=` → hexagon aggregates for the map
  - `GET /api/export.csv?...` → CSV download of filtered detections
- `web/` React + Vite + Leaflet (no Mapbox token) + `h3-js`: polygon draw (leaflet-draw or manual),
  hexagon layer, calendar heatmap (month × year), anomaly badge, CSV button.
- No Postgres/PostGIS: DuckDB + h3 extension instead (2 GB VPS, h3-pg would need compiling).

## Non-negotiables
- Real NASA data only. No fabricated numbers in the UI; sample data must be real FIRMS rows.
- UI must pass the `unslop` skill (audit → direction → 9 passes → checklist) and
  `design-taste-frontend`. No purple gradients, no glows, no emoji labels.
- Node 22 available. Keep each service's RAM peak low; never run two heavy agents at once.
- Python deps allowed: pandas, pyarrow, duckdb, requests, h3, fastapi, uvicorn.
