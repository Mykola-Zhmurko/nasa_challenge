"""Read-only DuckDB connection helper with H3 community extension.

- Opens `/root/nasa-hotspots/data/fires.duckdb` strictly in `read_only=True` mode.
- Loads the `h3` extension on connect.
- Verifies that required tables (`fires`, `calendar_monthly`, `calendar_global`) exist and are queryable.
"""

from pathlib import Path
from typing import Optional, Tuple
import duckdb

DB_PATH = Path("/root/nasa-hotspots/data/fires.duckdb")


def get_connection() -> Tuple[Optional[duckdb.DuckDBPyConnection], bool]:
    """Open a read-only DuckDB connection with the H3 extension loaded.

    Returns:
        Tuple of `(con, ready)`. When `ready` is False, `con` is None (or closed).
    """
    if not DB_PATH.exists():
        return None, False

    con: Optional[duckdb.DuckDBPyConnection] = None
    try:
        con = duckdb.connect(str(DB_PATH), read_only=True)
        con.execute("SET memory_limit='1GB'")
        try:
            con.execute("LOAD h3")
        except Exception:
            con.execute("INSTALL h3 FROM community")
            con.execute("LOAD h3")

        rows = con.execute("SELECT COUNT(*) FROM fires").fetchone()
        con.execute("SELECT 1 FROM calendar_monthly LIMIT 1").fetchall()
        con.execute("SELECT 1 FROM calendar_global LIMIT 1").fetchall()
        ready = bool(rows and rows[0] > 0)
        if not ready:
            con.close()
            return None, False
        return con, True
    except Exception:
        if con is not None:
            try:
                con.close()
            except Exception:
                pass
        return None, False


def check_readiness() -> bool:
    """Return True if the DuckDB file exists and required tables are queryable."""
    con, ready = get_connection()
    if con is not None:
        try:
            con.close()
        except Exception:
            pass
    return ready
