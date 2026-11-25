"""Sankhya Oracle metadata MCP — local stdio, test environment only."""
import os
import logging
import oracledb
from mcp.server.fastmcp import FastMCP
from queries import prepare

mcp = FastMCP("sankhya-oracle-victorferreira")
log = logging.getLogger(__name__)

def read(kind, name=None):
    if os.environ.get("ORACLE_ENV") != "TESTE":
        raise RuntimeError("Set ORACLE_ENV=TESTE only for an approved test database")
    if kind == "source" and os.environ.get("ORACLE_ALLOW_SOURCE") != "1":
        raise RuntimeError("Source inspection disabled")
    sql, binds = prepare(kind, os.environ.get("ORACLE_SCHEMA", "SANKHYA"), name)
    try:
        with oracledb.connect(user=os.environ["ORACLE_USER"], password=os.environ["ORACLE_PASSWORD"],
                              dsn=os.environ["ORACLE_DSN"], tcp_connect_timeout=10) as conn:
            conn.call_timeout = 15000
            with conn.cursor() as cur:
                cur.execute("SET TRANSACTION READ ONLY")
                cur.execute(sql, binds)
                columns = [d[0] for d in cur.description]
                rows = [dict(zip(columns, row)) for row in cur.fetchmany(200)]
                return {"rows": rows, "limit": 200}
    except oracledb.Error:
        log.warning("Oracle metadata query failed: %s", kind)
        raise RuntimeError("Oracle connection or metadata query failed") from None

@mcp.tool()
def list_tables() -> dict:
    """List up to 200 accessible tables in the configured test schema."""
    return read("tables")

@mcp.tool()
def describe_table(table: str) -> dict:
    """Inspect columns and data types, without reading business records."""
    return read("columns", table)

@mcp.tool()
def table_relationships(table: str) -> dict:
    """Inspect declared foreign keys for a table."""
    return read("relationships", table)

@mcp.tool()
def object_source(name: str) -> dict:
    """Inspect up to 200 lines of approved PL/SQL source when enabled."""
    return read("source", name)

if __name__ == "__main__":
    mcp.run(transport="stdio")
