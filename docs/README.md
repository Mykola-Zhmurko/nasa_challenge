# Developer documentation — Fire Calendar (NASA hotspots)

Technical reference for everyone who has to change this codebase. Written to be read in 10 minutes,
then used as a lookup table.

## What this app does

Two satellites report fires with different sensors. **MODIS** sees a 1 km pixel, **VIIRS** a 375 m pixel,
and they rate confidence differently. The app merges both into **one** series, so a user never has to
think about sensors: they pick an area and a period and get hotspots, a burning calendar and a CSV.

## Read in this order

| Doc | Answers |
|---|---|
| [architecture.md](architecture.md) | What are the parts, how does a request travel, where does it run? |
| [data.md](data.md) | Where does the data come from, how are MODIS and VIIRS merged, what is in the database? |
| [api.md](api.md) | Which endpoints exist, which parameters, which response shapes? |
| [frontend.md](frontend.md) | How is the UI built, where does state live, how do map tiles and search work? |
| [development.md](development.md) | How do I run, test and deploy it? Which pitfalls cost time? |
| [ui-copy-rules.md](ui-copy-rules.md) | Which words may appear in the interface, which must never appear? |
| [firms-comparison.md](firms-comparison.md) | What we take from the NASA FIRMS map, what we skip, and why |

Product-facing text lives in [`../README.md`](../README.md), the challenge requirements in
[`../SPEC.md`](../SPEC.md), UI rules in [`../UI-BRIEF.md`](../UI-BRIEF.md).

## The whole system on one screen

```
NASA FIRMS CSV  ──►  pipeline/  ──►  data/fires.duckdb  ──►  api/  ──►  web/  ──►  browser
 (raw downloads)      harmonize        one DuckDB file       FastAPI     React
                      + dedupe         (read-only at runtime)  :8100      Vite
```

- **Pipeline (Python):** downloads, cleans, merges, adds H3 cells, writes DuckDB + Parquet.
- **API (FastAPI):** five read endpoints over that DuckDB file (`health`, `cells`, `points`, `calendar`,
  `export.csv`). Never writes.
- **Web (React + Leaflet):** map, calendar, trends, CSV download. No map key, no login.

> **Data gap, not a bug:** the database currently carries **4 of 26 years** (2001, 2002, 2020, 2026).
> The history files on disk are complete; the import step has to run — see
> [data.md → Disk vs database](data.md#disk-vs-database-the-4-of-26-years-gap).

## Vocabulary

| Term | Meaning here |
|---|---|
| **Hotspot / detection** | One satellite observation of a thermal anomaly. Not a confirmed fire. |
| **Harmonization** | Turning MODIS and VIIRS rows into the same columns with the same meaning. |
| **H3 cell** | Hexagon ID from Uber's H3 grid. Level 8 ≈ 0.74 km² — the MODIS pixel scale. |
| **`sources` bitmask** | `1` = MODIS saw it, `2` = VIIRS saw it, `3` = both saw the same cell on the same day. |
| **Climatology** | Median of the same calendar month over all loaded years. |
| **Anomaly ratio** | Current month ÷ climatology. `1.0` = exactly the multi-year median. |
| **AOI** | Area of interest — the drawn rectangle or the bbox from the coordinate fields. |

## Where do I change …?

| I want to change | File |
|---|---|
| Area presets ("Overlays") | `web/src/App.tsx` → `PRESETS` |
| Labels in the right-hand panel | `web/src/components/ControlPanel.tsx` |
| Map layers, hexagons, popups, measure, capture | `web/src/components/MapView.tsx` |
| Basemap URLs / tile gaps | `web/lib/tiles.ts` + tile block in `MapView.tsx` |
| City search | `web/lib/geocode.ts` |
| Colour ramp, number formatting | `web/lib/ramp.ts` |
| Calendar sheet | `web/src/components/CalendarSheet.tsx` |
| Trend charts | `web/src/components/TrendCharts.tsx` + `web/lib/trends.ts` |
| From/To date picker | `web/src/components/DateRangePicker.tsx` + `web/lib/dategrid.ts` |
| Zoom limits, hexagon level per zoom, wheel zoom | `web/lib/zoom.ts` + `SmoothWheelZoom.tsx` |
| API calls from the UI | `web/lib/api.ts` |
| Harmonization rules | `pipeline/harmonize.py` + `pipeline/config.py` |
| Duplicate handling | `pipeline/dedupe.py` |
| Endpoint parameters | `api/app.py` |
| How data gets in | `pipeline/build.py`, `pipeline/import.py` |
