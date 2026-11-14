"""Configuration constants, paths, thresholds, and URL templates for the pipeline."""

from pathlib import Path
from typing import Final

# Directory and file paths
BASE_DIR: Final[Path] = Path("/root/nasa-hotspots")
DATA_DIR: Final[Path] = BASE_DIR / "data"
RAW_DIR: Final[Path] = DATA_DIR / "raw"
HISTORY_DIR: Final[Path] = DATA_DIR / "history"
PARQUET_PATH: Final[Path] = DATA_DIR / "fires.parquet"
DUCKDB_PATH: Final[Path] = DATA_DIR / "fires.duckdb"

# H3 spatial indexing configuration
H3_RESOLUTION: Final[int] = 8

# Harmonization rules and confidence thresholds
MODIS_MIN_CONFIDENCE: Final[int] = 50
MODIS_FLAG_CONFIDENCE: Final[int] = 80

VIIRS_CONFIDENCE_MAP: Final[dict[str, int]] = {
    "nominal": 50,
    "n": 50,
    "high": 90,
    "h": 90,
}
VIIRS_DROPPED_CONFIDENCE: Final[frozenset[str]] = frozenset({"low", "l"})

# Sensor bitmask values for cross-sensor deduplication
SOURCE_MASK_MODIS: Final[int] = 1
SOURCE_MASK_VIIRS: Final[int] = 2

# Chunked CSV reading size to keep peak RSS < 400 MB
CSV_CHUNK_SIZE: Final[int] = 50_000

# Harmonized schema column names
HARMONIZED_COLUMNS: Final[tuple[str, ...]] = (
    "ts",
    "sensor",
    "satellite",
    "lat",
    "lon",
    "confidence_pct",
    "frp_mw",
    "daynight",
)

ENRICHED_COLUMNS: Final[tuple[str, ...]] = (
    "h3_r8",
    "ts",
    "sensor",
    "satellite",
    "lat",
    "lon",
    "confidence_pct",
    "frp_mw",
    "daynight",
    "year",
    "month",
    "day",
    "doy",
)

FIRES_TABLE_COLUMNS: Final[tuple[str, ...]] = (
    "h3_r8",
    "ts",
    "sensor",
    "satellite",
    "lat",
    "lon",
    "confidence_pct",
    "frp_mw",
    "daynight",
    "sources",
)

# NASA FIRMS URL templates and API settings
FIRMS_PUBLIC_7D_URL_TEMPLATE: Final[str] = (
    "https://firms.modaps.eosdis.nasa.gov/data/active_fire/{product}/csv/{name}_Global_7d.csv"
)
FIRMS_AREA_API_URL_TEMPLATE: Final[str] = (
    "https://firms.modaps.eosdis.nasa.gov/api/area/csv/"
    "{map_key}/{source}/{area}/{day_range}/{start_date}"
)
FIRMS_MAP_KEY_ENV: Final[str] = "FIRMS_MAP_KEY"
FIRMS_MAX_DAYS_PER_CALL: Final[int] = 5
FIRMS_REQUEST_SLEEP_SEC: Final[float] = 1.5
FIRMS_DEFAULT_AREA: Final[str] = "world"
FIRMS_DEFAULT_SOURCES: Final[tuple[str, ...]] = (
    "MODIS_NRT",
    "VIIRS_SNPP_NRT",
    "VIIRS_NOAA20_NRT",
)
