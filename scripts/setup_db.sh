#!/usr/bin/env bash
#
# Idempotent provisioning of the sankhya_ajuda role + database.
#
# Usage:
#   PG_PASSWORD='<password>' ./scripts/setup_db.sh
#
# Optional env vars (defaults shown):
#   PG_CONTAINER   = postgres       # Docker container name running PostgreSQL
#   PG_SUPERUSER   = postgres       # PG superuser to create the role/db with
#   PG_ROLE        = sankhya_ajuda  # Role to create (LOGIN, password rotatable)
#   PG_DB          = sankhya_ajuda  # Database name to create
#
# Requires:
#   - Docker (any container exposing the named PostgreSQL service)
#   - Superuser with privileges to CREATE ROLE / CREATE DATABASE / CREATE EXTENSION
#
set -euo pipefail

CONTAINER="${PG_CONTAINER:-postgres}"
SUPERUSER="${PG_SUPERUSER:-postgres}"
ROLE="${PG_ROLE:-sankhya_ajuda}"
DB="${PG_DB:-sankhya_ajuda}"

if [[ -z "${PG_PASSWORD:-}" ]]; then
  echo "error: PG_PASSWORD env var required" >&2
  exit 1
fi

echo "[setup_db] container=${CONTAINER} role=${ROLE} db=${DB}"

# 1. Create role if missing (idempotent via DO block)
docker exec -i "${CONTAINER}" psql -v ON_ERROR_STOP=1 -U "${SUPERUSER}" -d postgres <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${ROLE}') THEN
    CREATE ROLE ${ROLE} LOGIN PASSWORD '${PG_PASSWORD}';
    RAISE NOTICE 'role ${ROLE} created';
  ELSE
    ALTER ROLE ${ROLE} WITH PASSWORD '${PG_PASSWORD}';
    RAISE NOTICE 'role ${ROLE} password rotated';
  END IF;
END
\$\$;
SQL

# 2. Create database if missing (CREATE DATABASE cannot run inside a transaction)
DB_EXISTS=$(docker exec -i "${CONTAINER}" psql -tA -U "${SUPERUSER}" -d postgres \
  -c "SELECT 1 FROM pg_database WHERE datname = '${DB}'")
if [[ "${DB_EXISTS}" != "1" ]]; then
  docker exec -i "${CONTAINER}" psql -v ON_ERROR_STOP=1 -U "${SUPERUSER}" -d postgres \
    -c "CREATE DATABASE ${DB} OWNER ${ROLE} ENCODING 'UTF8' TEMPLATE template0;"
  echo "[setup_db] database ${DB} created"
else
  echo "[setup_db] database ${DB} already exists"
fi

# 3. Ensure extensions exist inside the target DB
docker exec -i "${CONTAINER}" psql -v ON_ERROR_STOP=1 -U "${SUPERUSER}" -d "${DB}" <<SQL
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
GRANT ALL PRIVILEGES ON SCHEMA public TO ${ROLE};
SQL

echo "[setup_db] done. extensions: vector, unaccent, pg_trgm"
