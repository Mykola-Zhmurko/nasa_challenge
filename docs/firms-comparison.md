# Fire Calendar vs. NASA FIRMS Map — what we adopt, what we skip

Basis: the feature comparison of 15 Nov 2026 (Fire Calendar vs.
<https://firms.modaps.eosdis.nasa.gov/map/>). This page records the decisions, so nobody re-opens the
same list every week.

## Where we stand

Fire Calendar is **not** a FIRMS clone and should not become one. The challenge asks for a
*Burning Activity Calendar* built from **harmonized MODIS + VIIRS** hotspots. Everything that serves
that question is in scope; everything that turns the page into a data portal is not.

The dataset now covers the full record, so the harmonization claim holds end to end:

| | Value |
|---|---|
| Rows | 8,666,844 |
| Range | 2001-01-01 → 2026-11-14 |
| MODIS | 2,642,666 detections (from 2001) |
| VIIRS | 6,024,178 detections (from 2012-01-20) |
| H3 cells | 2,812,044 |

## Adopted from the comparison (done)

| Item | What changed |
|---|---|
| Timeline total disagreed with the panel (291,641 vs 291,287) and listed days outside the window | The strip now filters to the active window; total, per-day counts and arrows all use the same set |
| Calendar header claimed a span it did not cover | Header and subtitle now state how many years carry data |
| "Overlays" were continent shortcuts, not map overlays | Renamed to **Quick areas** — the label matches the behaviour |
| No explanation for the VIIRS platform choice | **About → Data and credit**: source, citation, and why only NOAA-20 is listed |
| Missing attribution/citation | About now names NASA FIRMS / LANCE and links the source |

## Deliberately skipped (and why)

| FIRMS feature | Why not |
|---|---|
| Landsat OLI 8/9 (30 m) | Different product family, ~30× the data volume, needs its own ingestion and a licence review. Not needed for a calendar of MODIS+VIIRS hotspots. |
| Geostationary (GOES, Himawari, MSG, MTG) | Sub-daily cadence changes the data model from "day" to "timestamp"; the calendar is day-based by definition. |
| Burned area (MCD64A1 / VNP64A1) | Answers "what burned", not "what is burning" — a different question and a different dataset. |
| Smoke / aerosols, static thermal anomalies, HLS imagery | Separate NASA products, each with its own pipeline. Out of scope for a 36-hour challenge. |
| Advanced mode with 100+ layers | Every layer is a dataset we would have to ingest, verify and explain. Depth over breadth: our differentiator is the calendar and the anomaly, not layer count. |
| Swath outlines, orbit tracks, overpass prediction | Requires orbital data (TLE) and a rendering budget we do not have on a 2 GB VPS. |
| Downloads as SHP/JSON, archive portal, NRT-vs-standard switch | CSV of the filtered view is the requirement. More formats are cheap to add later (`/api/export.csv` already streams). |
| Social sharing, announcements, feedback, view modes | Portal furniture; no analytical value. |

## Worth doing next (realistic, in order)

1. **NOAA-21 and Suomi-NPP as additional VIIRS platforms.** Same FIRMS CSV schema, so it is an import
   plus a sensor list in the panel — the biggest honest gain in data coverage.
2. **Per-layer opacity** for the imagery layer (one slider, one prop).
3. **JSON export** next to CSV (same query, `application/json`).
4. **Saved locations / "use my location"** — small, useful for responders.
5. **Layer information popover**: coverage, latency and the meaning of each field, so the numbers are
   auditable without reading this repository.
6. **Sub-daily view** only if a geostationary product is ever added.

## Rule of thumb

Before adding a FIRMS feature, answer: *does it help a firefighter, land manager or scientist read the
burning history of an area faster?* If the answer is "it makes the map look more like FIRMS", skip it.
