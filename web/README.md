# NASA Fire Calendar — Frontend

## Overview

A burning-activity calendar for emergency responders, land managers and scientists.
Displays MODIS/VIIRS hotspot data harmonized into a single series, with area-of-interest
selection, month-by-month burning activity, and anomaly detection.

## Stack

- React 19 + Vite + TypeScript
- Leaflet + react-leaflet (OSM tiles, no Mapbox token)
- `h3-js` for polygon → H3 cells in the browser
- Plain CSS with design tokens (no Tailwind, no UI kit)

## Design Tokens

Tokens defined in `styles/tokens.css` and applied in `styles/app.css`:

| Token | Value | Description |
|---|---|---|
| `--ground` | `#f9fbfc` | Page background |
| `--surface` | `#ffffff` | Card/sheet surface |
| `--raised` | `#f4f6f8` | Raised element background |
| `--active` | `#ebedee` | Active state |
| `--border` | `#e8eaec` | Default border |
| `--rule` | `#f0f1f2` | Rule/divider color |
| `--control` | `#cdced1` | Control background |
| `--text` | `#131416` | Main text color |
| `--muted` | `#5d5f60` | Muted/secondary text |
| `--accent` | `#1b6c80` | Accent/primary interactive color |
| `--positive` | `#1e7b4f` | Positive change indicator |
| `--negative` | `#c4242a` | Negative change indicator |
| `--warning` | `#92400e` | Warning indicator |
| `--chart-1` | `#1b6c80` | Chart color 1 (hexagon detection ramp) |
| `--chart-2` | `#2f70bb` | Chart color 2 |
| `--chart-3` | `#a86f0c` | Chart color 3 |
| `--radius-card` | `8px` | Card border radius |
| `--radius-control` | `6px` | Form control border radius |
| `--radius-sheet` | `16px` | Sheet/panel border radius |
| `--sheet-inset` | `8px` | Page inset from viewport |
| `--row-height` | `48px` | Top bar / row height |
| `--sidebar-width` | `228px` | Fixed sidebar width |
| `--gap` | `24px` | General gap/spacing |
| `--pad` | `24px` | Page padding |
| `--control-height` | `32px` | Form control height |
| `--fs-title` | `22px` | Title font size |
| `--fs-section` | `16px` | Section heading font size |
| `--fs-kpi` | `28px` | KPI value font size |
| `--fs-body` | `14px` | Body text font size |
| `--fs-small` | `12px` | Small/supporting text font size |

## Available Scripts

| Command | Description |
|---|---|
| `npm install` | Install dependencies |
| `npm run dev` | Start development server at `http://127.0.0.1:5173` |
| `npm run build` | Build for production (Vue 3 + TypeScript) |

## Development

1. Install dependencies: `npm install`
2. Start dev server: `npm run dev`
3. Open browser at `http://127.0.0.1:5173/`
4. The dev server proxies `/api` to `http://127.0.0.1:8100`

### API Proxy

The Vite dev server proxies `/api` requests to `http://127.0.0.1:8100`, which is the
FastAPI backend. This allows fetch calls like `fetch('/api/health')` to work without
CORS issues.

### API Endpoints

| Endpoint | Description |
|---|---|
| `GET /api/health` | Health check with row count and date range. Returns 503 if data not ready. |
| `GET /api/cells` | Hexagon aggregates for the map. Parameters: `res`, `from`, `to`, `bbox` |
| `POST /api/calendar` | Calendar data for the selected area. Body: `{bbox, from, to, res}` |
| `GET /api/export.csv` | CSV download of filtered detection data |

### 503 Handling

When the API returns HTTP 503, the UI displays a quiet inline notice: `"data not ready"`
instead of an error page. Every fetch has loading, error, and not-ready states.

## Responsive

- **1440px+**: Full layout with fixed sidebar (228px) and main content area
- **390px (mobile)**: Sidebar collapses; interface adapts to single-column layout

## Acceptance Criteria

- `npm install && npm run build` succeeds with zero TypeScript errors
- Dev server runs on port 5173 with the `/api` proxy working
- Real NASA data only — no placeholder numbers in the UI
- Works at 1440px and 390px width
- Accessibility: labeled controls, keyboard-reachable, visible focus ring