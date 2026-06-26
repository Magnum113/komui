#!/usr/bin/env bash
set -Eeuo pipefail

DUMP_FILE=${1:?Encrypted dump path is required}
TARGET_DB=${2:-komui_staging}
ENC_KEY=/etc/komui/backup-encryption.key
WORK_DUMP="/dev/shm/${TARGET_DB}-restore.dump"
POST_RESTORE_SQL=${POST_RESTORE_SQL:-/opt/komui/migration/staging-post-restore.sql}

test -r "$DUMP_FILE"
test -r "$ENC_KEY"
test -r "$POST_RESTORE_SQL"
sha256sum -c "$DUMP_FILE.sha256"

cleanup() {
  rm -f "$WORK_DUMP"
}
trap cleanup EXIT

openssl enc -d -aes-256-cbc -pbkdf2 \
  -pass file:"$ENC_KEY" \
  -in "$DUMP_FILE" \
  -out "$WORK_DUMP"
chown postgres:postgres "$WORK_DUMP"
chmod 600 "$WORK_DUMP"

runuser -u postgres -- dropdb --force --if-exists "$TARGET_DB"
runuser -u postgres -- createdb \
  --owner=komui_owner \
  --encoding=UTF8 \
  --template=template0 \
  "$TARGET_DB"

runuser -u postgres -- psql \
  --dbname="$TARGET_DB" \
  --set=ON_ERROR_STOP=1 <<'SQL'
CREATE SCHEMA IF NOT EXISTS extensions AUTHORIZATION komui_owner;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
DROP SCHEMA public CASCADE;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END
$roles$;
SQL

PGOPTIONS='-c check_function_bodies=false' \
runuser -u postgres -- pg_restore \
  --dbname="$TARGET_DB" \
  --no-owner \
  --no-privileges \
  --role=komui_owner \
  --exit-on-error \
  --verbose \
  "$WORK_DUMP"

runuser -u postgres -- psql \
  --dbname="$TARGET_DB" \
  --set=ON_ERROR_STOP=1 \
  < "$POST_RESTORE_SQL"

echo "RESTORE_OK database=$TARGET_DB"
