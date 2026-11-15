# UI copy rules

Agreed on 14 Nov 2026. Applies to every string the user can see: `web/src/App.tsx`,
`web/src/components/*.tsx`, `web/lib/ramp.ts` (labels), `index.html`.

## Never show internal vocabulary

The interface speaks about **fires, area and time** — not about how the data is stored.

| Don't write | Why | Write instead |
|---|---|---|
| `H3`, `hexagon`, `Hexagons`, `H3 cells`, `resolution-8` | storage detail, meaningless to a firefighter | `area`, `cell` only inside a popup |
| `size = detections`, `Viridis ramp encodes …` | describes the implementation, not the data | nothing — the legend numbers are enough |
| `FRP` | acronym | `fire power (MW)` |
| counts of intermediate objects (hexagon totals) | nobody acts on them | `Hotspots`, `Mean power`, `Area (km²)` |

## Keep

- Sensor names and resolution — `MODIS 1 km`, `VIIRS NOAA-20 375 m` — that is domain information.
- The safety disclaimer, complete: it is the reason responders can trust the numbers.
- Plain-language notes in the calendar and trends: `Hotspots by year and month`, `Fewer` / `More`,
  `4 of 26 years with data`.
- The MODE-panel comparison box: `November 2026 — far above normal` plus
  `291,287 hotspots in the first 14 days · +4,282 % vs the same days of the 25 earlier years (median 6,648)`.
  A percentage against the **same days** of the earlier years is allowed; a rank ("1 of 26 years") is not
  shown, and a running month is never measured against full months.

## Changes made on 14 Nov 2026

- `Hexagons` KPI removed from the MODE panel; the panel now shows `Hotspots` and `Mean power` only.
- Cell popup: `Hexagon area (km²)` → `Area (km²)`.
- About sheet: `MODIS + VIIRS in one series` → `MODIS + VIIRS combined`;
  `Zooming in replaces the hexagons with individual detections` → `Zooming in shows individual detections`.
- Map legend: the `… H3 cells, size = detections` caption is gone.
- City search: populated places only (Open-Meteo / GeoNames), never countries or regions.

## Changes made on 15 Nov 2026

- The fire-power classes are **fixed** (`FRP_CUTS` in `web/lib/ramp.ts`: 2.5 / 5 / 10 / 25 / 100 MW) and used by
  the map colours, the map legend and the panel legend. Do not derive them from the loaded or visible cells again:
  quantile cuts collapsed to the same number in small areas (`8.4 / 8.4 / 8.4`) and the two legends disagreed.

## If you want to reintroduce a term

Explain in the pull request why the target user (firefighter, land manager, scientist) needs the
internal word, and add it to the table above. Otherwise keep it out.
