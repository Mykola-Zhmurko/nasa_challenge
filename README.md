# Fire Calendar

**NASA Space Apps Challenge 2026** — Challenge: *Harmonization of MODIS and VIIRS Hot Spots*
Team "The One" · Dnipro · 14–15 November 2026

## What it is

Two satellites watch fires on Earth: **MODIS** (1 km, since 2001) and **VIIRS** (375 m, since 2012).
They measure differently, so their data cannot be compared directly. This app turns both into
**one series**, so the user never has to think about which satellite saw a fire.

Pick an area and a period. The app shows where fires were, when they happened, and whether the
current month is above or below the normal level.

![Fire Calendar — world view with harmonized hotspots, totals and the time panel](docs/screenshots/full.png)

## What you can do

- Pick an area: draw a rectangle on the map, type coordinates, or search for a city
- See hotspots on the map, coloured by fire power (MW)
- Read the burning calendar: year by month, then day by day, with the peak day
- Compare the selected month with the median of the same days in earlier years
- Download exactly what you see as a CSV file

## Only the data that is needed

- **H3 cells, not single points.** Every detection gets an H3 cell (level 8, ~0.74 km²) when it is
  imported, and the map asks for cells instead of detections: one shape per cell, carrying the number of
  detections and the mean fire power, at a resolution that follows the zoom. A worldwide week is about
  17,700 shapes instead of 291,000 points, and the number stays bounded however far the map is zoomed out.
- **Polygons for areas.** The area you draw is a polygon: the server keeps only what lies inside it — an
  exact box for the map, an H3 polygon fill for cell and calendar queries — so a query touches the cells
  of that area, never the whole table.
- **Detections on request only.** Individual rows are never drawn on the map; the CSV export is the one
  place that returns them.

## How two sensors become one series

| Step | Rule |
| --- | --- |
| Confidence | VIIRS "low" is dropped; "nominal" becomes 50, "high" becomes 90. MODIS below 50 is dropped |
| Duplicates | Same ~1 km cell on the same day → one record, the stronger detection wins |
| Provenance | Every record keeps a note whether MODIS, VIIRS or both saw it |

## Data

Fire data: **NASA FIRMS** — MODIS C6.1 and VIIRS C2 (NOAA-20), <https://firms.modaps.eosdis.nasa.gov>.
The public download covers the last 7 days; older years need a free FIRMS API key (`FIRMS_MAP_KEY`).
The database holds **8.7 million detections from 2001 to November 2026**; the historical years cover
Europe, the current window is worldwide. Days without data are marked as such.

## Run it

```bash
python3 -m venv .venv && .venv/bin/pip install pandas duckdb h3 pyarrow requests fastapi uvicorn
.venv/bin/python -m pipeline.build                              # raw CSVs → data/fires.duckdb
.venv/bin/python -m uvicorn api.app:app --port 8100             # API
cd web && npm install && npm run dev                            # http://127.0.0.1:5173
```

The database file is not in this repository (210 MB) — the pipeline rebuilds it.

## Documentation

Developer documentation lives in [`docs/`](docs/README.md): architecture, data model, API, frontend,
development, UI copy rules.

## Credits

Fire data: NASA FIRMS / LANCE. Imagery: Esri, OpenStreetMap contributors. City search: Open-Meteo
(GeoNames). Built with DuckDB, FastAPI, React and Leaflet.
