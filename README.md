# Fire Calendar — harmonized MODIS + VIIRS burning-activity calendar

NASA Space Apps Challenge 2026 · Challenge: *Harmonization of MODIS and VIIRS Hot Spots*
Team "The One" · Local Event Dnipro · 14–15 November 2026

## The problem the challenge names

Satellites have recorded active fire hotspots for more than two decades, but the record is split
across sensors that cannot be compared directly: MODIS (1 km, confidence 0–100) and VIIRS
(375 m, confidence nominal/low/high). Fire managers therefore have no consistent picture of when
and where burning happened in a given area.

## What this project does

1. **Harmonizes the two sensors into one series.** MODIS and VIIRS detections are mapped onto one
   common schema and one common confidence scale, then cross-sensor duplicates are collapsed.
   A user never has to know which sensor produced a detection.
2. **Lets a user pick an area of interest** by drawing a rectangle on the map, by typing
   min/max latitude and longitude, or by choosing a region preset.
3. **Builds a burning-activity calendar** for that area: which months carry the burning, which
   day is the peak, and how the current window compares with the climatology of the loaded record.
4. **Exports exactly what is on screen** as CSV.

## Harmonization rules (single source: `pipeline/harmonize.py`, `pipeline/dedupe.py`)

| Rule | Detail |
| --- | --- |
| Drop VIIRS low confidence | `nominal` → 50, `high` → 90 on the shared 0–100 scale |
| Drop MODIS below 50 | values under 80 are treated as uncertain, under 50 as unusable |
| Drop rows without coordinates or date | — |
| Cross-sensor dedupe | same H3 cell (resolution 8) + same UTC day → one record; higher confidence wins, then higher FRP |
| Source bitmask | `1` = MODIS, `2` = VIIRS, `3` = both sensors saw it |
| Output schema | `ts, sensor, satellite, lat, lon, confidence_pct, frp_mw, daynight, h3_r8, sources` |

Result of the current run: **473,000 rows in → 410,215 after the confidence filter → 291,288 after
dedupe**, covering 258,540 distinct H3 cells. 11,803 of those records were seen by both sensors.

## Spatial index

Every detection is stored once at H3 resolution 8 (≈1 km, the scale of a MODIS pixel). Coarser
views are derived at query time with `h3_cell_to_parent`, so no parent level is stored twice and
zooming never needs a new table.

## Architecture

```
data/raw/*.csv            public FIRMS 7-day CSVs (MODIS C6.1, VIIRS C2)
        │
        ├── pipeline/     Python: harmonize → enrich (H3) → dedupe → Parquet + DuckDB
        └── importer-rs/  Rust: same rules, streaming, ~0.6 s and 53 MB peak for 473k rows
        │
data/fires.duckdb         fires, calendar_monthly, calendar_global
        │
api/                      FastAPI: /api/health, /api/cells, /api/calendar, /api/export.csv
        │
web/                      React + Vite + Leaflet + h3-js: map, calendar, totals, CSV
```

- **DuckDB instead of PostgreSQL** because the workload is read-only analytics over one file:
  no server process, no port, no credentials, and the H3 community extension provides
  `h3_latlng_to_cell` / `h3_cell_to_parent` without compiling anything.
- **Rust only in the import path.** The query path is the engine's own C++, so Rust in front of it
  would change nothing measurable; the bulk import is where it pays (0.55 s and 53 MB against
  340 MB for the Python run).

## Map scale

The map uses the same zoom range as the NASA FIRMS web map: levels 2–16, so the scale bar reaches
200 m / 500 ft at level 16, like FIRMS. The Blue Marble tiles are native to level 8 and are
upscaled beyond that, exactly as on the FIRMS map; the dark basemap is sharp up to level 16.
The hexagon level follows the zoom (4 at world scale down to 8, the ~1 km MODIS pixel scale),
so zooming in reveals finer hotspots instead of the same coarse cells; `Auto` in the Layers panel
keeps that link, a fixed level overrides it.

## Data

NASA FIRMS (Fire Information for Resource Management System), `firms.modaps.eosdis.nasa.gov`.
The public endpoints serve the most recent 7 days without credentials; older records need a free
FIRMS MAP_KEY (set `FIRMS_MAP_KEY` in `.env` and use `pipeline/fetch.py`). The current build uses
the public window, so the calendar shows a short but real record and says so in the interface
instead of inventing a baseline.

## Run it

```bash
# data
python3 -m venv .venv && .venv/bin/pip install pandas duckdb h3 pyarrow requests fastapi uvicorn
.venv/bin/python -m pipeline.build           # writes data/fires.parquet + data/fires.duckdb

# api
.venv/bin/python -m uvicorn api.app:app --host 127.0.0.1 --port 8100

# web
cd web && npm install && npm run dev          # http://127.0.0.1:5173, proxies /api to :8100
```

Optional, Rust importer: `cd importer-rs && cargo build --release && ./target/release/import-firms
--input ../data/raw/MODIS_C6_1_Global_7d.csv --input ../data/raw/J1_VIIRS_C2_Global_7d.csv
--out ../data/fires_rs.csv`

## Credits

Fire data: NASA FIRMS / LANCE. Base imagery: NASA GIBS Blue Marble. Interface design direction:
`design-taste-frontend` (Framed sheet) and the `unslop` review.
