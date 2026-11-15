# Data model and harmonization

Everything here is implemented in `pipeline/`; the database is the single source of truth for the API.

## Where the data comes from

**NASA FIRMS** — Fire Information for Resource Management System (NASA Earthdata).

| Product | Sensor | Pixel | Confidence column | Value range |
|---|---|---|---|---|
| MODIS C6.1 | MODIS (Terra/Aqua) | 1 km | `confidence` | 0–100 |
| VIIRS C2 | VIIRS (NOAA-20, Suomi-NPP) | 375 m | `confidence` | `low` / `nominal` / `high` |

Two ways in:

1. **Public 7-day CSV** (no key): `https://firms.modaps.eosdis.nasa.gov/data/active_fire/...` → `data/raw/`
2. **Archive API** (free key required): `pipeline/fetch.py` and `pipeline/fetch_history.py` use
   `/api/area/csv/<MAP_KEY>/<SOURCE>/<BBOX>/<DAYS>/<START_DATE>` and store gzip files in `data/history/`.

`FIRMS_MAP_KEY` lives in `.env` at the repository root. Without a key only the 7-day window works.

## Harmonization rules (the part that matters)

Defined in `pipeline/harmonize.py`, thresholds in `pipeline/config.py`:

| Rule | Effect |
|---|---|
| VIIRS `low` confidence | **dropped** — too unreliable |
| VIIRS `nominal` | becomes `confidence_pct = 50` |
| VIIRS `high` | becomes `confidence_pct = 90` |
| MODIS `confidence < 50` | **dropped** |
| MODIS `confidence >= 50` | kept as-is |
| Rows without valid lat/lon/date | dropped |

After that, both sensors have exactly the same columns, so the rest of the system never branches on
sensor again — except for display labels.

## Duplicate handling (`pipeline/dedupe.py`)

Two sensors can see the same fire on the same day, often a few hundred metres apart.

- Group key: **`(h3_r8, ts)`** — same ~0.74 km² cell, same UTC day.
- Keep **one** row: the one with the highest confidence, then the highest FRP.
- Merge the provenance into `sources`:

| `sources` | Meaning |
|---|---|
| `1` | MODIS only |
| `2` | VIIRS only |
| `3` | both sensors saw this cell-day |

This is what makes the series *one* series: a user counts fires, not sensor observations.

## Database schema (`data/fires.duckdb`)

```sql
fires(
  h3_r8          BIGINT,   -- H3 level 8 as 64-bit integer (display via h3_h3_to_string)
  ts             DATE,     -- UTC day of the acquisition
  sensor         VARCHAR,  -- 'MODIS' | 'VIIRS'
  satellite      VARCHAR,  -- e.g. 'Terra', 'Aqua', 'N20', 'N'
  lat            DOUBLE,
  lon            DOUBLE,
  confidence_pct INTEGER,  -- 0-100 after harmonization
  frp_mw         DOUBLE,   -- fire radiative power in megawatts
  daynight       VARCHAR,  -- 'D' | 'N'
  sources        INTEGER   -- bitmask: 1 = MODIS, 2 = VIIRS
)

calendar_monthly(h3_r8 BIGINT, year INT, month INT, detections BIGINT, mean_frp DOUBLE)
calendar_global (month INT, detections BIGINT, mean_frp DOUBLE)
calendar_median (h3_r8 BIGINT, month INT, median_detections DOUBLE)
```

The `calendar_*` tables are precomputed so the calendar endpoint does not scan `fires` for every
climatology request: `/api/calendar` reads its median/mean per month from `calendar_monthly`.
`calendar_median` (median per cell and month) is built as well but no endpoint queries it today.

**H3 levels:** only level 8 is stored. Coarser hexagons (levels 4–7) are derived at query time with
`h3_cell_to_parent(h3_r8, n)`. Never add a second H3 column — it doubles the file and the build time.

## Size of the current dataset

As of 2026-11-14 17:00 UTC (`/api/health` + the query below):

```
rows: 594,017        range: 2001-01-01 … 2026-11-14        distinct days: 994
MODIS: 360,937       VIIRS: 233,080 (7-day window)
sources: 1 → 350,025   2 → 232,189   3 → 11,803 (both sensors, same cell-day)
```

The history download is incremental: `data/history/` fills up year by year, so **the calendar can
legitimately show fewer years than 2001–today** while a download is running. The UI states the number
of loaded years instead of pretending the record is complete.

## Disk vs database: the "4 of 26 years" gap

Downloading is not importing. `pipeline/fetch_history.py` only writes `data/history/*.csv.gz`; the app
serves what is in DuckDB. Compare the two before looking for a UI bug:

```bash
.venv/bin/python -c "import duckdb; c=duckdb.connect('data/fires.duckdb', read_only=True); \
print(c.sql('select year(ts) as y, count(*) as n from fires group by 1 order by 1').fetchall())"
ls -la data/history/*.csv.gz | wc -l
```

Current state: **78 history files** (26 years × `MODIS_SP`, `VIIRS_SNPP_SP`, `VIIRS_NOAA20_SP`) but the
database holds **4 years** — 2001, 2002, 2020, 2026 — because it was built at 11:04 UTC, before most of
the downloads finished (the last one landed 16:53 UTC). A `pipeline.build` run closes the gap; no
re-download is needed. `VIIRS_NOAA20_SP` files before 2018 (and SNPP before 2012) are 144-byte empties —
the satellite did not exist yet; `build.py` skips files ≤ 20 bytes.

**`pipeline.import` cannot read the history files.** It globs plain `*.csv` (`--dir` → `*.csv` only), so
`--dir data/history` fails with `No *.csv files found in directory`; `.csv.gz` is read by
`pipeline.build` (which also salvages a gzip file whose trailer is missing).

## Rebuilding

```bash
# full rebuild from data/raw/*.csv AND data/history/*.csv.gz  (≈350 MB peak RAM)
.venv/bin/python -m pipeline.build

# append plain CSV files to the existing database (streaming, atomic swap)
.venv/bin/python -m pipeline.import --input data/raw/MODIS_C6_1_Global_7d.csv
.venv/bin/python -m pipeline.import --dir data/raw

# download history through the FIRMS area API (needs FIRMS_MAP_KEY)
.venv/bin/python -m pipeline.fetch_history --sources MODIS_SP,VIIRS_NOAA20_SP \
    --start 2001-01-01 --end 2026-11-14 --bbox -25,34,45,72
```

The API keeps serving during an import: `import.py` writes a temporary copy and swaps it in.

## Rules that must not be broken

- **Never invent values.** Every number in the UI comes from `fires` or a `calendar_*` table.
- Confidence mapping and the dedupe key are part of the challenge spec — changing them changes the
  meaning of every historical number, so both need a rebuild *and* a note in the changelog.
- `sources` is a bitmask, not a list. `3` means both sensors, not "three detections".
