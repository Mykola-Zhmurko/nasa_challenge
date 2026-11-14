# NASA Hotspots Data Pipeline (`pipeline/`)

Harmonizes active fire hotspot records from **MODIS Collection 6.1** (1 km) and **VIIRS Collection 2** (375 m) into a unified H3 resolution-8 spatial-temporal dataset stored in Apache Parquet (`data/fires.parquet`) and DuckDB (`data/fires.duckdb`).

## How to Run the Pipeline

From `/root/nasa-hotspots`, execute the build CLI using the project virtual environment:

```bash
cd /root/nasa-hotspots
./.venv/bin/python -m pipeline.build
```

### What `pipeline.build` Does

1. **Chunked CSV Ingestion & Harmonization (`pipeline/harmonize.py`)**:
   - Streams every `*.csv` file in `data/raw/` in 50,000-row chunks (`CSV_CHUNK_SIZE`) so peak RSS stays well below 400 MB.
   - Detects sensor type (`MODIS` vs `VIIRS`) from schema/filename.
   - Drops rows missing valid `latitude`, `longitude`, or `acq_date`.
   - Applies SPEC confidence harmonization rules:
     - **VIIRS**: drops `low` confidence; maps `nominal -> 50` and `high -> 90`.
     - **MODIS**: drops `confidence < 50` (retains `50..100`).
   - Normalizes columns to `(ts, sensor, satellite, lat, lon, confidence_pct, frp_mw, daynight)`.

2. **Spatial & Temporal Enrichment (`pipeline/enrich.py`)**:
   - Computes 64-bit integer H3 cell indices at resolution 8 (`h3_r8`, ~0.53 km edge length) via vectorized `h3.api.basic_int.latlng_to_cell`.
   - Extracts `year`, `month`, `day`, and `doy` (day of year).

3. **Cross-Sensor Deduplication (`pipeline/dedupe.py`)**:
   - Collapses multiple detections occurring in the same `(h3_r8, ts)` cell and UTC day into a single representative detection.
   - Retains the detection with the highest `confidence_pct`, breaking ties by highest `frp_mw`.
   - Records the `sources` bitmask across all detections in that cell-day (`1 = MODIS`, `2 = VIIRS`, `3 = MODIS + VIIRS`).

4. **Atomic Output Generation (`pipeline/build.py`)**:
   - Writes `data/fires.parquet` atomically via a temporary file.
   - Builds `data/fires.duckdb` with `INSTALL h3 FROM community; LOAD h3;` and populates:
     - `fires(h3_r8, ts, sensor, satellite, lat, lon, confidence_pct, frp_mw, daynight, sources)`
     - `calendar_monthly(h3_r8, year, month, detections, mean_frp)`
     - `calendar_global(month, detections, mean_frp)`
   - Prints a verification summary of row counts across filters, sensor and source bitmask counts, distinct H3 cells, top 5 months by detections, and peak RSS.

## Optional Historical Download (`MAP_KEY` Fetch Mode)

`pipeline/fetch.py` downloads historical CSV batches from the NASA FIRMS Area API endpoint:

```text
https://firms.modaps.eosdis.nasa.gov/api/area/csv/<MAP_KEY>/<SOURCE>/<AREA>/<DAY_RANGE>/<START_DATE>
```

### How `FIRMS_MAP_KEY` Mode Works

- Reads the API key from the `FIRMS_MAP_KEY` environment variable.
- Splits the requested `[start_date, end_date]` interval into windows of at most **5 days per call** (the FIRMS Area API maximum).
- Sleeps **1.5 seconds** between consecutive requests to respect FIRMS rate limits.
- Saves non-empty CSV responses into `data/raw/`, which are then picked up by `python -m pipeline.build`.
- **Safe when key is absent**: If `FIRMS_MAP_KEY` is unset or empty, `pipeline.fetch` logs a warning and exits cleanly with code `0` without crashing.

### Running `pipeline.fetch`

```bash
cd /root/nasa-hotspots
export FIRMS_MAP_KEY="your_firms_map_key_here"
./.venv/bin/python -m pipeline.fetch \
  --sources MODIS_NRT VIIRS_NOAA20_NRT \
  --area world \
  --start-date 2026-11-01 \
  --end-date 2026-11-10
```

## Streaming Out-of-Core Import (`pipeline.import`)

For multi-year regional or full NASA FIRMS archive CSV files (several GB to 50+ GB) on a low-RAM host, `pipeline/import.py` provides a pure DuckDB SQL + Python stdlib out-of-core import path with no `pandas` or `pyarrow` in memory.

### CLI Usage

```bash
# Import one or more explicit FIRMS CSV files (7-day or archive downloads)
/root/nasa-hotspots/.venv/bin/python -m pipeline.import \
  --input data/raw/MODIS_C6_1_Global_7d.csv \
  --input data/raw/J1_VIIRS_C2_Global_7d.csv \
  --db data/fires.duckdb \
  --memory-limit 256MB \
  --threads 2

# Or import all *.csv files in a directory
/root/nasa-hotspots/.venv/bin/python -m pipeline.import \
  --dir data/raw \
  --db data/fires.duckdb
```

### How `pipeline.import` Works

1. **Header & Schema Validation**:
   - Inspects only the CSV header row via Python's `csv` module to verify required columns (`latitude`/`lat`, `longitude`/`lon`, `acq_date`/`ts`, `confidence`/`confidence_pct`) and detect the sensor (`VIIRS` from `bright_ti4`/`bright_ti5`, `MODIS` from `brightness`/`bright_t31`, with filename fallback).
   - Exits with a clear error message and non-zero status without touching the live database if any file is unreadable or missing required columns.
2. **Disk-Spilling DuckDB Staging**:
   - Copies the target database to a sibling temporary file and configures `SET memory_limit`, `SET temp_directory`, and `SET threads` so DuckDB spills intermediate state to disk and keeps peak RSS below 400 MB regardless of input size.
   - Streams each CSV directly into a persistent staging table via `read_csv(..., header=true, ignore_errors=true, all_varchar=true)`.
3. **Harmonization, H3 Enrichment & Cross-Sensor Deduplication**:
   - Applies identical harmonization rules to `pipeline.build` (MODIS confidence `50..100`; VIIRS `nominal`/`n` -> `50`, `high`/`h` -> `90`, drops `low`/`l`) and computes resolution-8 H3 indices via `h3_latlng_to_cell(lat, lon, 8)`.
   - Deduplicates `(h3_r8, ts)` groups over the `UNION` of existing `fires` rows and newly imported rows, keeping the highest `confidence_pct` (then highest `frp_mw`) and combining `sources` via bitwise OR (`1 = MODIS`, `2 = VIIRS`, `3 = MODIS + VIIRS`).
4. **Atomic Swap**:
   - Applies the merge and rebuilds `calendar_monthly` and `calendar_global` inside a single transaction on the temporary database, runs `CHECKPOINT`, closes the connection, atomically replaces `data/fires.duckdb` via `os.replace`, and removes any `-wal` file.

