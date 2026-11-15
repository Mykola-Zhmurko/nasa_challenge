# Architecture

## The four parts

| Part | Technology | Runs as | Writes |
|---|---|---|---|
| `pipeline/` | Python 3.12, pandas, DuckDB, h3 | CLI, on demand | `data/fires.duckdb`, `data/fires.parquet` |
| `api/` | FastAPI + uvicorn | `127.0.0.1:8100`, one worker, five routes (`health`, `cells`, `points`, `calendar`, `export.csv`) | nothing (read-only DuckDB) |
| `web/` | React 19, Vite 5, Leaflet 1.9 | static files served by nginx | nothing |
| nginx | — | `:443` | — |

## Request path in production

```
browser ──GET /──────────────► nginx ──► /var/www/nasa-hotspots/index.html + assets/
        └─GET /api/...──────► nginx (proxy_pass) ──► uvicorn 127.0.0.1:8100 ──► DuckDB (read_only)
```

- Static build lives in `/var/www/nasa-hotspots` (a copy of `web/dist`).
- `/api/` is proxied to the API; `proxy_read_timeout 180s` covers large CSV exports.
- TLS certificate is issued by certbot for the `*.sslip.io` hostname.

## Request path in development

```
browser ──► Vite dev server :5173 ──► (proxy /api) ──► uvicorn :8100 ──► DuckDB
```

`web/vite.config.ts` holds the proxy target, so the frontend code always calls `/api/...` — the same
path in dev and in production. No CORS configuration is needed anywhere.

## Data flow of the pipeline

```
data/raw/*.csv                (7-day public downloads, or archive files)
      │
      ├─ harmonize.py   detect sensor, map confidence, keep common columns
      ├─ enrich.py      add h3_r8, split ts into year/month
      ├─ dedupe.py      one row per (h3_r8, ts), set the sources bitmask
      ▼
data/fires.parquet  +  data/fires.duckdb
      │
      └─ tables: fires, calendar_monthly, calendar_global, calendar_median
```

`pipeline/import.py` appends more CSVs to an existing database without a full rebuild (streaming,
bounded memory, atomic swap of the database file).

## Why these choices

| Decision | Reason |
|---|---|
| DuckDB instead of Postgres/PostGIS | Single file, no server, no login, works in 2 GB RAM. The H3 work happens in SQL/extension, not in a service. |
| H3 level 8 stored, parents computed | One column instead of six; `h3_cell_to_parent()` is cheap and keeps aggregates consistent. |
| Parquet next to DuckDB | DuckDB can be rebuilt from Parquet; Parquet is the durable artefact. |
| Leaflet + Esri/OSM tiles | No API key, no billing, works offline-ish, tiny bundle. |
| Viridis ramp | Perceptually uniform and colour-vision-deficiency safe — required by the challenge. |
| City search via Open-Meteo geocoding | Free, no key, and restricted to populated places (the NASA map behaviour). |

## Runtime budget (2 GB VPS)

| Process | Peak RSS |
|---|---|
| uvicorn + DuckDB query | ~50–80 MB |
| Vite dev server | ~35 MB |
| Full pipeline build | ~350 MB (chunked CSV, see `CSV_CHUNK_SIZE`) |
| Streaming import | bounded by `--memory-limit` (default `256MB`) and `--threads 2` |

Only one heavy job at a time: never run a full build while a coding agent is running.

## Repository layout

```
api/            FastAPI app (app.py, db.py) + its README
data/           fires.duckdb, fires.parquet, raw/ and history/ CSV downloads (git-ignored)
docs/           this documentation + screenshots
importer-rs/    Rust re-implementation of the importer (faster, ~53 MB RAM)
pipeline/       download → harmonize → enrich → dedupe → build/import
tests/          pytest suite for pipeline + API
web/            React app; lib/ holds framework-free logic, src/ the components
```
