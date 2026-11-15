# Development

## Setup

Requirements: Python 3.12, Node 22, DuckDB CLI not needed (the `duckdb` wheel is enough).

```bash
cd /root/nasa-hotspots

# Python: virtualenv in the repo root (there is no requirements.txt — the list below is the full set)
python3 -m venv .venv
.venv/bin/pip install pandas duckdb h3 pyarrow requests fastapi uvicorn python-dotenv pytest httpx

# Frontend
cd web && npm install
```

`pipeline/config.py` hardcodes `BASE_DIR = /root/nasa-hotspots`, so the pipeline must run from that path.

Optional: `FIRMS_MAP_KEY` in `.env` at the repository root. Only `pipeline/fetch.py` and
`pipeline/fetch_history.py` need it; the public 7-day files and everything else work without a key.

## Run

```bash
# API  (127.0.0.1:8100, read-only DuckDB)
.venv/bin/python -m uvicorn api.app:app --host 127.0.0.1 --port 8100

# Frontend dev server (127.0.0.1:5173, HMR, proxies /api to 8100 — see web/vite.config.ts)
cd web && npm run dev
```

Production runs the same uvicorn command through systemd:

```bash
systemctl status nasa-hotspots-api
systemctl restart nasa-hotspots-api   # required after every change to api/
```

## Tests

```bash
# Python: pipeline maths + API endpoints (skips itself when data/fires.duckdb is missing)
.venv/bin/python -m pytest tests/ -q

# Frontend: 9 files, 67 tests, ~1 s
cd web && npx --no-install vitest run
```

- `vitest` is **not** in `web/devDependencies`; `npx --no-install vitest run` resolves the installed
  binary and is the command that works. A bare `npx vitest` would try to download a second copy.
- `tsc --noEmit` exits **2** on this repo even on an untouched tree (pre-existing errors in
  `h3-js` typings used by `ControlPanel`/`MapView`, and missing vitest types). Read the error list and
  check whether it names your file — the exit code alone says nothing.
- `pytest` needs the DuckDB file: `tests/test_api.py` is skipped (not failed) without it.

## Build and deploy

```bash
cd web && npm run build          # -> web/dist/
rsync -a --delete web/dist/ /var/www/nasa-hotspots/
chown -R www-data:www-data /var/www/nasa-hotspots
```

- Live is `/var/www/nasa-hotspots`, nginx vhost `/etc/nginx/sites-available/nasa-hotspots`, domain
  `nasa.217.154.10.11.sslip.io`. `/api/` is proxied to `127.0.0.1:8100` with `proxy_read_timeout 180s`.
- The vhost answers only its own `server_name`: `curl http://127.0.0.1/` returns 404. Check a deploy with
  `curl -sk -H "Host: nasa.217.154.10.11.sslip.io" https://127.0.0.1/ | grep -o 'assets/[^"]*'`.
- **Static files do not deploy the backend.** An `api/app.py` change is only live after
  `systemctl restart nasa-hotspots-api`.
- After publishing, compare the asset hash the live HTML asks for with `ls web/dist/assets` — a different
  name proves the new build shipped.

## Data pipeline

```bash
# full rebuild from data/raw/*.csv and data/history/*.csv.gz (≈350 MB peak RSS)
.venv/bin/python -m pipeline.build

# append files to the existing database (streaming, 256 MB DuckDB memory limit, 2 threads)
.venv/bin/python -m pipeline.import --input data/history/MODIS_SP_2019.csv.gz
.venv/bin/python -m pipeline.import --dir data/history

# download history through the FIRMS area API (needs FIRMS_MAP_KEY)
.venv/bin/python -m pipeline.fetch_history --sources MODIS_SP,VIIRS_NOAA20_SP \
    --start 2001-01-01 --end 2026-11-14 --bbox -25,34,45,72
```

`fetch_history` only **downloads** into `data/history/`; the years appear in the app only after
`pipeline.import` ran. See [data.md](data.md) for the disk-vs-database check.

## Conventions

- **Everything in the repository is English** — code, comments, docs, UI copy, commit messages. German
  only in chat replies to the project owner.
- **Never invent a value.** Every number in the UI comes from `fires` or a `calendar_*` table; a missing
  day is "no data", not zero.
- **H3 level 8 only** in storage; coarser levels are derived with `h3_cell_to_parent(h3_r8, n)`.
- **RAM budget** (VPS has 2 GB): API ~50–80 MB, Vite dev ~35 MB, full build ~350 MB, streaming import
  bounded by `--memory-limit 256MB`. Run **one heavy job at a time** — never a full build while an import
  or a coding agent is running.
- DuckDB reserves `days` as a keyword: alias it (`... AS d`) in SQL, or the query dies with a
  `ParserException` that looks like a broken database.
- `data/` is git-ignored: never commit `fires.duckdb`, `fires.parquet`, `data/raw`, `data/history`.

## Pitfalls that cost time

| Symptom | Cause / fix |
|---|---|
| Map is grey with "Map data not yet available" | Esri answers HTTP 200 with a placeholder tile over open water. Not an error — the OSM under-layer must stay (`lib/tiles.ts`, `.under-osm`). |
| Tiles read "API KEY REQUIRED" | CARTO (`basemaps.cartocdn.com`) now needs a key. Use Esri World Dark Gray or OSM instead. |
| A component vanished after an agent run | A coding agent (`agy`) rewrote a file and dropped JSX. Check `git diff -w` and symbol counts per file against `HEAD`; restore what disappeared. |
| Two agents edited the same file | Parallel runs overwrite each other. Check `ps aux \| grep agy` and file mtimes before and after, and never run a build/publish while another run is in flight. |
| `vitest: command not found` / wrong version | `vitest` is not a devDependency — use `npx --no-install vitest run`. |
| `tsc --noEmit` exits 2 | Pre-existing typing errors (see Tests). Judge the errors, not the exit code. |
| Build "succeeds" but the page is unchanged | `web/dist` and `/var/www` can carry different hashes built minutes apart. Compare the hash in the live HTML with `ls web/dist/assets`. |
| Calendar shows 4 of 26 years | The history CSVs were downloaded but never imported — `pipeline.import --dir data/history`. Not a UI bug. |
| A probe reports `ERR_CONNECTION_REFUSED` on 5173 | The dev server is not running. Do not start it as a side effect; build and use `vite preview`, or test the live domain. |
