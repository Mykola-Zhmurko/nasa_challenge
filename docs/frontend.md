# Frontend

React 19 + Vite 5 + Leaflet 1.9 (`react-leaflet` 5), no state library, no CSS framework, no chart
library. `src/main.tsx` renders `<App />`; `src/App.tsx` owns all state and every data fetch.

| Path | Role |
|---|---|
| `src/App.tsx` | state, fetching, filters, URL state, sheets and dock buttons |
| `src/components/` | one file per screen area (table below) |
| `lib/` | framework-free logic (maths, API client, tiles, geocoding) — unit tested |
| `src/lib/*.test.ts` | vitest suites for `lib/` |
| `styles/tokens.css`, `styles/app.css` | design tokens, then all layout and component CSS |

`lib/` is imported from components as `../../lib/...`; the alias `@lib` also exists in `vite.config.ts`.

## State in `App.tsx`

One component holds everything; children are presentational and get props.

| Group | State |
|---|---|
| Dataset | `health` (min/max date, rows), `cells`, `cellsStatus`, `cellsError`, `truncated` |
| Calendar | `calendar` (months, days, climatology, anomaly, totals), `calendarStatus`, `rangeSensors` |
| Area | `bbox`, `areaId`, `zoom`, `pinnedRes` |
| Time | `rangePreset` (`24h`/`3d`/`7d`/`day`/`custom`), `day`, `customRange` |
| Display | `basemap`, `sensorsEnabled`, `modeTab`, `panelOpen` |
| Tools | `drawing`, `measuring`, `measureMode`, `measurePoints`, `captureToken`, `captureState`, `playing` |
| Sheets | `calendarOpen`, `timelineOpen`, `helpOpen`, `disclaimerOpen` |
| Misc | `reload` (retry counter), `cursor`, `shareCopied` |

Derived values are `useMemo`s:

- `res = pinnedRes ?? resForZoom(zoom)` — hexagon level 4…7 follows the map zoom (`lib/zoom.ts`).
- `from`/`to` = dataset window from `health` (`min_ts`/`max_ts`), with a fallback constant.
- `rangeFrom`/`rangeTo` = the **active** window: `day` wins, then `customRange`, then the presets
  (`24h` = `to`…`to`, `3d` = `to-2`…`to`, `7d` = `to-7`…`to`).
- `totals` = hotspots, hexagons, mean FRP, peak — filtered by the active sensors. The fire-power classes are
  fixed (`FRP_CUTS`), not derived from the view, so panel legend and map legend always show the same numbers.
- `insights` = `{comparison, activity, areaKm2}` from `lib/insights.ts`, passed to the panel.

Fetch effects (each with an `AbortController`):

| Effect | Depends on | Note |
|---|---|---|
| health | `reload` | once per load |
| cells | `bbox, res, rangeFrom, rangeTo, reload, zoom` | **skipped at `zoom >= 8`** — the map draws points there, hexagons are invisible |
| calendar (full window) | `bbox, from, to, res, reload` | feeds the calendar sheet and the trends |
| calendar (active range) | `bbox, rangeFrom, rangeTo, res` | only for the per-sensor totals; skipped when the range equals the dataset window |
| day playback | `playing` | advances `day` through `calendar.days` every 900 ms |

## Components

| Component | What it draws |
|---|---|
| `TopBar.tsx` | title, hotspot total, cursor lat/lon readout, city search, CSV link, panel toggle |
| `ControlPanel.tsx` | right-hand **MODE** panel: two tabs (`simple`, `time`), ranges + date pickers, Sensors, Layers (basemaps), Overlays (area presets), coordinates W/S/E/N, totals block, Reset |
| `MapView.tsx` | the Leaflet map: basemap + under-layer + borders, hexagon layer, point layer, popups, legend, measure tool, capture runner, `ZoomSync`, `AreaOutline` |
| `TimelineBar.tsx` | last 14 days as bars, click a day, play/pause, preset buttons |
| `CalendarSheet.tsx` | burning calendar: annual × monthly heatmap, month grid for one month, trend section |
| `TrendCharts.tsx` | three hand-drawn SVG charts (see below) |
| `DateRangePicker.tsx` | custom From/To calendar popover (portal, keyboard, range band) |
| `SmoothWheelZoom.tsx` | fractional, interruptible wheel zoom (replaces Leaflet's `scrollWheelZoom`) |

Dock buttons in `App.tsx` open the sheets: `CALENDAR`, `MEASURE`, `LAYERS`, `TIMELINE`, `CAPTURE`,
`SHARE`, `HELP`. `SHARE` writes the URL state to the address bar and the clipboard.

### MapView details that matter

- Hexagons are `L.circleMarker` on one `L.canvas` renderer: radius from `sqrt(detections)`, colour from
  the FRP ramp. At most `MAX_CELLS = 20000` are drawn; tooltips only while ≤ `TOOLTIP_LIMIT = 2000`.
- From `zoom >= 8` (or ≤ `FEW_CELLS_THRESHOLD = 150` cells) the layer switches to single detections.
- `ZoomSync` reports the zoom only when the **band** changes (`resForZoom(z)` or cells↔points) and the
  view bbox only when the pan is large enough — that throttle is what keeps a flick smooth. Do not turn
  it into a per-step report.
- `AreaOutline` draws the active bbox; `MeasureTool` collects clicks (the `measuring` class disables
  pointer events on the marker panes so a click on a fire is still a map click); `CaptureRunner`
  composites tiles + canvases + measure geometry into a PNG.
- `maxBounds`/`maxBoundsViscosity` come from `MAP_MAX_BOUNDS` in `lib/zoom.ts` (±85° latitude, ±720°
  longitude), so the map cannot be dragged off the world.

## `web/lib/` — one sentence each

| Module | Purpose |
|---|---|
| `api.ts` | typed fetch wrappers (`fetchHealth`, `fetchCells`, `fetchPoints`, `fetchCalendar`, `exportCsvHref`) and the `Result<T>` status shape |
| `ramp.ts` | Viridis 5-step ramp, the fixed FRP classes (`FRP_CUTS`) and their labels, number/date/confidence formatting |
| `zoom.ts` | zoom limits, `MAP_MAX_BOUNDS`, native tile depths, `resForZoom`, wheel maths (`WHEEL_PX_PER_LEVEL`) |
| `tiles.ts` | detects Esri "Map data not yet available" placeholder tiles (`greyShare`, `hideNoDataTiles`) |
| `geocode.ts` | city search via Open-Meteo: populated places only, ASCII labels, coordinate parsing, bbox by population |
| `insights.ts` | panel maths: `bboxAreaKm2`, `monthComparison`, `rangeActivity` |
| `measure.ts` | great-circle distance and spherical ring area for the measure tool |
| `range.ts` | `isIsoDate`, `clampRange` — order a picked window and clamp it to the dataset |
| `trends.ts` | chart maths: `yearsOnRecord`, `monthlySeries`, `seriesTotal`, `otherYear`, `currentMonthWindow` |
| `capture.ts` | composites the map into a PNG (tiles by `getBoundingClientRect`, canvases, measure geometry, footer) |
| `dategrid.ts` | calendar-grid maths for the date picker (month matrix, weekday offset, day arithmetic, all UTC) |

## Map tiles

Three basemaps, all keyless (`MapView.tsx`, tile block):

| `basemap` | Layer | URL |
|---|---|---|
| `satellite` (default) | Esri World Imagery | `server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/...` |
| `dark` | Esri Dark Gray Canvas | `.../Canvas/World_Dark_Gray_Base/...` |
| `blue-marble` | NASA GIBS Blue Marble | `gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/...` |

- **Every basemap has an OpenStreetMap under-layer at `zIndex={0}`** (`className="under-osm"`, darkened
  with a CSS filter). Esri answers HTTP 200 with a light-grey "Map data not yet available" tile over open
  water and remote areas — without the under-layer the map looks broken while the network tab is clean.
- `hideNoDataTiles` reads each imagery tile through a canvas and hides it when more than half of the
  pixels are placeholder grey (`#CCCCCC`); the under-layer then shows through. The thresholds live in
  `lib/tiles.ts` (`PLACEHOLDER_GREY`, `PLACEHOLDER_MIN_SHARE`).
- Only hosts with a checked CORS header carry `crossOrigin="anonymous"` (OSM, Esri, GIBS) — a tile
  without that header would taint the capture canvas.
- **Never use CARTO** (`basemaps.cartocdn.com`): it now returns tiles stamped "API KEY REQUIRED".

## Place search

`TopBar.tsx` + `lib/geocode.ts`, debounce 220 ms, minimum 2 characters, `AbortController` per keystroke.

- Geocoder is **Open-Meteo** (`geocoding-api.open-meteo.com/v1/search`, GeoNames data, no key). Only rows
  whose `feature_code` starts with `PPL` are kept, so countries (`PCLI`), regions (`ADM1`/`ADM2`),
  streets and buildings never appear.
- Every label is plain ASCII: umlauts expand (`ü→ue`, `ö→oe`, `ä→ae`, `ß→ss`) and other accents are
  stripped, on the city name and on the region/country line.
- Three query variants are fired in parallel (digraph-collapsed first, then raw, then accent-folded)
  because the geocoder does not know `ae/oe/ue` — "Wuerzburg", "Würzburg" and "Wurzburg" all resolve to
  the same city.
- A typed `lat, lon` pair becomes a single "Coordinates" row.
- Keyboard: ↑/↓ move, Enter picks, Escape closes; a click outside closes. Picking a row sets the bbox and
  the list closes (a `skipFetchRef` stops it from reopening on the query change).

## Calendar and trends

`CalendarSheet.tsx` (heatmap + month grid) and `TrendCharts.tsx` (three charts) are fed by the same
`calendar` response:

1. **Annual × monthly heatmap** — one row per loaded year, one cell per month, Viridis ramp, click a cell
   to focus that year/month.
2. **Month grid** — the days of the focused month; days without data are `disabled` and titled
   "No data loaded for this day". A month-cell click first drops the day filter (`onSelect(null)`), then
   sets the focus, so no year stays locked.
3. **Trends** — monthly bars for a picked year, the season curve of a second year against the dashed
   median, and the daily bars of the current month. Both year charts share one y-scale (`ticks`/`top`
   from the maximum of both series plus the median); hovering a month sets one `hoverMonth` that lights up
   the same month in both charts and turns the `.trend-readout` line to ink. The year picks follow the
   inspected period (clicked heatmap cell → that year, plus the nearest other year on record).

- A partial year has no total: the readout says "N hotspots in <year> · X of 12 months loaded".
- Days with no row are unknown, not zero — no bar is drawn and the caption states "N of 31 days loaded".
- The header states the data gap ("4 of 26 years loaded", `yearsExpected = maxYear - 2001 + 1`), because
  a median over four years is not a climatology.
- Charts follow the **selected period** for their year, never `to`; `from`/`to` are the dataset window and
  are only used for the sheet header.

## Date range picker

`DateRangePicker.tsx` renders two buttons (`From`/`To`, `DD Mon YYYY`) and a popover with a month/year
`<select>` pair, ‹ › arrows and a Mon-first grid. The popover is portalled into `document.body` with
`position: fixed` (the panel scrolls, so an absolutely positioned child would be clipped) and re-measured
on `resize`/`scroll`.

- Picking a day on the other end **swaps** the pair instead of collapsing it (`clampRange` in `lib/range.ts`).
- The two fields always show the active window — a preset moves them too, so they double as the readout.
- Keyboard: arrows ±1/±7 days, PageUp/Down a month, Home/End the week edge, Enter picks, Escape closes;
  one cell carries `tabIndex=0` (roving tabindex), moves are clamped to `min`/`max`.

## URL state and Reset

`readInitialUrlState()` parses the query string once on mount; `handleShare()` is the **only** writer.

| Param | Meaning |
|---|---|
| `bbox` | `west,south,east,north`, 2 decimals; becomes `areaId: 'custom'` unless it matches a preset |
| `range` | `24h` / `3d` / `7d` |
| `day` | single day, wins over `range` and `from`/`to` |
| `from`, `to` | custom window (`rangePreset = 'custom'`) |
| `res` | `auto` or a pinned 4…7 (clamped on read) |
| `basemap` | `satellite` / `dark` / `blue-marble` |
| `sensors` | `MODIS,VIIRS` — empty value means none |

- A preset click calls `clearCustomWindowFromUrl()` (deletes `from`/`to` with `history.replaceState`), so
  a reload cannot restore the window the user just left.
- `reset()` restores World, auto resolution, satellite, both sensors, `7d`, stops playback **and clears
  the whole query string** — without that, the next reload re-applies the old link state.
- Drawing a rectangle or picking a preset never writes the URL; only `SHARE` does.
