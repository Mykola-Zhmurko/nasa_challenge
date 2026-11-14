# UI BRIEF — NASA Fire Calendar (frontend)

Read this file completely before writing code. Also read `/root/nasa-hotspots/SPEC.md`
and the design direction in `/root/nasa-hotspots/.taste-skill/app/direction.json`.

## What the product is

A burning-activity calendar for emergency responders, land managers and scientists.
Two satellite sensors (MODIS, VIIRS) are already merged into one series, so the user never
sees a sensor split. The user marks an area of interest and reads, month by month, how
burning in that area compares to its own normal.

Audience: a fire-duty officer at 03:00 and a scientist checking a season. Dense data, quiet
chrome, one thing that carries the colour.

## Stack (fixed, do not change)

- React 19 + Vite + TypeScript
- Leaflet + react-leaflet (no Mapbox, no token, OSM tiles)
- `h3-js` for polygon → H3 cells in the browser
- Plain CSS with the tokens below (no Tailwind, no UI kit, no component library)

## Design direction — "Framed sheet" (dealt, adopt as given)

The app chrome is one tinted L-shaped frame; the work sits on a white sheet with a hairline
edge and soft corners, so depth comes from a single tone step and no shadow.
One tinted frame holds the sidebar and a 48px top bar with no rule between them; the page is
a white sheet inset 8px from the window's right and bottom edges, 1px edge, 16px corners, no
shadow. The active tab is a 2px underline in ink or the accent; everything else in the chrome
is grey. Colour budget under 3 %: the data carries the chroma.

Tokens (use exactly these, from direction.json):

```css
--ground:#f9fbfc; --surface:#ffffff; --raised:#f4f6f8; --active:#ebedee; --border:#e8eaec;
--rule:#f0f1f2; --control:#cdced1; --text:#131416; --muted:#5d5f60; --accent:#1b6c80;
--positive:#1e7b4f; --negative:#c4242a; --warning:#92400e;
--chart-1:#1b6c80; --chart-2:#2f70bb; --chart-3:#a86f0c;
--radius-card:8px; --radius-control:6px; --radius-sheet:16px; --sheet-inset:8px;
--row-height:48px; --sidebar-width:228px; --gap:24px; --pad:24px; --control-height:32px;
--fs-title:22px; --fs-section:16px; --fs-kpi:28px; --fs-body:14px; --fs-small:12px;
```

Type: IBM Plex Sans (400/500/600) for the interface, IBM Plex Mono (400/500) only for
figures in tables and IDs.

House rules that must hold: no gradients, no glows, no shadows at rest, no emoji, no
icon-topped feature cards, no tiny uppercase tracked labels, no hairline dividers as
decoration, one accent only, numbers in `tabular-nums`, sentence case everywhere.

## Screens and behaviour

One screen (a workspace), not a marketing page.

1. **Top bar (48px)** — product name "Fire Calendar" left, the active date range as quiet text,
   right: a "Download CSV" control and a reset control.
2. **Sidebar (228px)** — the area of interest:
   - either draw a rectangle/polygon on the map, or type min/max lat/lon,
   - a preset list of regions (Europe, Mediterranean, Ukraine, Amazon, California) that fills the bbox,
   - the resolution control (H3 level 4–7) that changes how coarse the hexagons are.
3. **Map (main, top half)** — Leaflet with OSM tiles, hexagons drawn as `h3-js` polygons
   coloured on one sequential ramp of `--chart-1` (5 steps by detection count), a legend with
   real numbers, and the drawn area outlined. Clicking a hexagon filters the calendar to it.
4. **Calendar heatmap (main, bottom half)** — the core of the challenge: a grid of
   year (rows) × month (columns) coloured by detections, so a season reads at a glance.
   Under it one line of plain text stating the finding, e.g. "July 2026 ran 2.4× the 20-year
   July normal in this area". The current month gets the accent.
5. **Side panel / strip** — totals: detections, distinct hexagons, share by sensor (MODIS vs
   VIIRS) as one stacked bar, mean FRP. Numbers real, `tabular-nums`.

Empty state: before an area is chosen, the map shows the world and the calendar shows the
global monthly series, with one sentence saying what to do.

## API contract (backend is being fixed in parallel; code against this exact contract)

Base URL from `VITE_API_BASE`, default `/api` with a Vite dev proxy to `http://127.0.0.1:8100`.

- `GET /api/health` → `{"status":"ok","rows":291288,"min_ts":"2026-11-07","max_ts":"2026-11-14","cells":258540}`
  or HTTP 503 `{"error":"data_not_ready"}`.
- `GET /api/cells?res=5&from=2026-11-07&to=2026-11-14&bbox=minlon,minlat,maxlon,maxlat`
  → `{"cells":[{"h3":"851f...","detections":12,"mean_frp":8.4}],"truncated":false}`
- `POST /api/calendar` body `{"bbox":[minlon,minlat,maxlon,maxlat],"from":"2026-11-01","to":"2026-11-30","res":4}`
  or `{"h3_cells":["851f..."],"from":"...","to":"...","res":4}`
  → `{"months":[{"year":2026,"month":11,"detections":120}],"climatology":[{"month":11,"mean_detections":50.1}],"anomaly":[{"year":2026,"month":11,"ratio":2.4}],"totals":{"detections":120,"cells":14,"sensors":{"MODIS":30,"VIIRS":90}}}`
- `GET /api/export.csv?bbox=...&from=...&to=...` → CSV file download.

When the API answers 503, show a quiet inline notice ("data not ready") instead of an error
page. Every fetch has a loading state and a failure state.

## Acceptance

- `npm install && npm run build` succeeds in `/root/nasa-hotspots/web`.
- Dev server runs on port 5173 with the proxy; every fetch works against the real API on 8100.
- Real data only: no invented numbers in the UI, no placeholder charts, no lorem.
- Works at 1440 and at 390 px wide (the sidebar collapses into a drawer on mobile).
- Accessibility: every control has a label, keyboard reachable, visible focus ring.

Create files ONLY inside `/root/nasa-hotspots/web/`. Do not touch `api/`, `pipeline/`,
`importer-rs/`, `data/`, `SPEC.md`, or `.taste-skill/`.
