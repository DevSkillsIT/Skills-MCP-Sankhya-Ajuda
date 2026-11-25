"""Fixed, bind-only metadata queries. No arbitrary SQL interface."""
import re

def identifier(value):
    value = value.upper()
    if not re.fullmatch(r"[A-Z][A-Z0-9_$#]{0,127}", value):
        raise ValueError("Invalid Oracle identifier")
    return value

QUERIES = {
    "tables": "SELECT table_name FROM (SELECT table_name FROM all_tables WHERE owner=:owner ORDER BY table_name) WHERE ROWNUM <= 200",
    "columns": "SELECT column_name, data_type, data_length, data_precision, data_scale, nullable FROM (SELECT * FROM all_tab_columns WHERE owner=:owner AND table_name=:table_name ORDER BY column_id) WHERE ROWNUM <= 200",
    "relationships": """SELECT * FROM (SELECT c.constraint_name, a.column_name, r.owner referenced_owner, r.table_name referenced_table, b.column_name referenced_column
FROM all_constraints c JOIN all_cons_columns a ON a.owner=c.owner AND a.constraint_name=c.constraint_name
JOIN all_constraints r ON r.owner=c.r_owner AND r.constraint_name=c.r_constraint_name
JOIN all_cons_columns b ON b.owner=r.owner AND b.constraint_name=r.constraint_name AND b.position=a.position
WHERE c.owner=:owner AND c.table_name=:table_name AND c.constraint_type='R' ORDER BY c.constraint_name,a.position) WHERE ROWNUM <= 200""",
    "source": "SELECT line, text FROM (SELECT line,text FROM all_source WHERE owner=:owner AND name=:table_name AND type IN ('PROCEDURE','FUNCTION','TRIGGER','PACKAGE','PACKAGE BODY') ORDER BY type,line) WHERE ROWNUM <= 200",
}
def prepare(kind, owner, name=None):
    binds = {"owner": identifier(owner)}
    if kind != "tables":
        binds["table_name"] = identifier(name)
    return QUERIES[kind], binds
