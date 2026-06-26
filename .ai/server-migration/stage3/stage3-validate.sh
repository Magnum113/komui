#!/usr/bin/env bash
set -Eeuo pipefail

DATABASE=${1:-komui_staging}
VALIDATION_SQL=${VALIDATION_SQL:-/opt/komui/migration/stage3-validate.sql}
OUT=${2:-/var/backups/komui/database/${DATABASE}-validation-$(date +%Y%m%d-%H%M%S).txt}

install -d -m 700 -o root -g root "$(dirname "$OUT")"
runuser -u postgres -- psql \
  --dbname="$DATABASE" \
  --set=ON_ERROR_STOP=1 \
  < "$VALIDATION_SQL" \
  > "$OUT"
chmod 600 "$OUT"

runuser -u postgres -- pg_dump --dbname="$DATABASE" \
  --schema-only \
  --no-owner \
  --no-privileges \
  --schema=public \
  --schema=private |
sed -E \
  -e '/^-- Dumped from database version/d' \
  -e '/^-- Dumped by pg_dump version/d' \
  -e '/^\\restrict /d' \
  -e '/^\\unrestrict /d' |
sha256sum |
awk '{print "normalized_schema_dump_sha256=" $1}' >> "$OUT"

echo "$OUT"
