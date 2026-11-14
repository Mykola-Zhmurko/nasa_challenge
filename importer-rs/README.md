# NASA Hotspots Rust Importer (`importer-rs`)

Streaming, flat-memory Rust implementation of the NASA FIRMS active fire hotspot harmonization pipeline (`MODIS Collection 6.1` + `VIIRS Collection 2` -> H3 resolution-8 cross-sensor deduplicated CSV).

## Build

Ensure `/root/.cargo/bin` is on your `PATH`, then build the release binary:

```bash
export PATH="/root/.cargo/bin:$PATH"
cd /root/nasa-hotspots/importer-rs
cargo build --release
```

The compiled binary is written to `./target/release/import-firms`.

## Usage

```bash
./target/release/import-firms \
  --input ../data/raw/MODIS_C6_1_Global_7d.csv \
  --input ../data/raw/J1_VIIRS_C2_Global_7d.csv \
  --input ../data/raw/MODIS_C6_1_Europe_7d.csv \
  --out ../data/fires_rs.csv \
  --res 8
```

### CLI Options

- `--input <csv>` (repeatable, required): Path to one or more raw NASA FIRMS MODIS C6.1 or VIIRS C2 CSV files. Each file is streamed row by row via `BufReader` and the `csv` crate without loading whole files into memory.
- `--out <path.csv>` (required): Output harmonized CSV path.
- `--res <u8>` (optional, default `8`): Target H3 spatial index resolution.

### Output Schema

`import-firms` writes a CSV with the exact header:

```text
ts,sensor,satellite,lat,lon,confidence_pct,frp_mw,daynight,h3_r8,sources
```

- `ts`: UTC acquisition date (`YYYY-MM-DD`)
- `sensor`: `MODIS` or `VIIRS` (auto-detected from CSV header columns)
- `satellite`: Satellite identifier (`T`, `A`, `N20`, `SNPP`, etc.)
- `lat`, `lon`: Geographic coordinates in decimal degrees
- `confidence_pct`: Harmonized confidence (`50..=100`; MODIS `< 50` dropped; VIIRS `low` dropped, `nominal -> 50`, `high -> 90`)
- `frp_mw`: Fire Radiative Power in MW
- `daynight`: `D` or `N`
- `h3_r8`: 64-bit H3 cell index at resolution 8 formatted as a decimal integer
- `sources`: Cross-sensor bitmask for the `(h3_r8, ts)` cell-day group (`1 = MODIS`, `2 = VIIRS`, `3 = both`)

## DuckDB Ingestion Note

To keep compilation times fast and memory consumption minimal on the 2 GB VPS, `importer-rs` deliberately avoids `arrow`, `parquet`, and `duckdb` Rust crates and outputs `data/fires_rs.csv` directly.

The resulting harmonized CSV output (`data/fires_rs.csv`) is loaded into DuckDB (`data/fires.duckdb`, including the `fires`, `calendar_monthly`, and `calendar_global` tables with the `h3` community extension) by the Python side (`pipeline/`).
