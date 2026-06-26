#!/usr/bin/env bash
set -Eeuo pipefail

ENCRYPTED_SNAPSHOT=${1:?Encrypted API snapshot path is required}
TARGET_DB=${2:-komui_staging}
SCHEMA_REPLAY=${SCHEMA_REPLAY:-/opt/komui/migration/schema-replay.sql}
POST_RESTORE_SQL=${POST_RESTORE_SQL:-/opt/komui/migration/staging-post-restore.sql}
ENC_KEY=/etc/komui/backup-encryption.key
WORK_JSON="/dev/shm/${TARGET_DB}-source-snapshot.json"

test -r "$ENCRYPTED_SNAPSHOT"
test -r "$ENCRYPTED_SNAPSHOT.sha256"
test -r "$ENC_KEY"
test -r "$SCHEMA_REPLAY"
test -r "$POST_RESTORE_SQL"

sha256sum -c "$ENCRYPTED_SNAPSHOT.sha256"

cleanup() {
  rm -f "$WORK_JSON"
}
trap cleanup EXIT

openssl enc -d -aes-256-cbc -pbkdf2 \
  -pass file:"$ENC_KEY" \
  -in "$ENCRYPTED_SNAPSHOT" \
  -out "$WORK_JSON"
chown postgres:postgres "$WORK_JSON"
chmod 600 "$WORK_JSON"

runuser -u postgres -- dropdb --force --if-exists "$TARGET_DB"
runuser -u postgres -- createdb \
  --owner=komui_owner \
  --encoding=UTF8 \
  --template=template0 \
  "$TARGET_DB"

runuser -u postgres -- psql \
  --dbname="$TARGET_DB" \
  --set=ON_ERROR_STOP=1 \
  < "$SCHEMA_REPLAY"

runuser -u postgres -- psql \
  --dbname="$TARGET_DB" \
  --set=ON_ERROR_STOP=1 \
  --set=snapshot_path="$WORK_JSON" <<'SQL'
CREATE TEMP TABLE stage3_import (payload jsonb NOT NULL);
INSERT INTO stage3_import(payload)
VALUES (pg_read_file(:'snapshot_path')::jsonb);

CREATE TEMP TABLE stage3_foreign_keys AS
SELECT
  n.nspname AS schema_name,
  c.relname AS table_name,
  con.conname AS constraint_name,
  pg_get_constraintdef(con.oid, true) AS definition
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN ('public', 'private')
  AND con.contype = 'f';

DO $drop_foreign_keys$
DECLARE
  item record;
BEGIN
  FOR item IN SELECT * FROM stage3_foreign_keys
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I DROP CONSTRAINT %I',
      item.schema_name,
      item.table_name,
      item.constraint_name
    );
  END LOOP;
END
$drop_foreign_keys$;

DO $truncate_tables$
DECLARE
  tables_sql text;
BEGIN
  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ')
  INTO tables_sql
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public', 'private')
    AND c.relkind IN ('r', 'p');

  IF tables_sql IS NOT NULL THEN
    EXECUTE 'TRUNCATE TABLE ' || tables_sql || ' RESTART IDENTITY CASCADE';
  END IF;
END
$truncate_tables$;

SET session_replication_role = replica;

DO $import_tables$
DECLARE
  item record;
  schema_name text;
  table_name text;
BEGIN
  FOR item IN
    SELECT key AS qualified_name, value AS rows
    FROM jsonb_each((SELECT payload->'tables' FROM stage3_import))
    ORDER BY key
  LOOP
    schema_name := split_part(item.qualified_name, '.', 1);
    table_name := split_part(item.qualified_name, '.', 2);

    IF schema_name NOT IN ('public', 'private')
       OR table_name = ''
       OR to_regclass(format('%I.%I', schema_name, table_name)) IS NULL THEN
      RAISE EXCEPTION 'Unexpected snapshot table: %', item.qualified_name;
    END IF;

    EXECUTE format(
      'INSERT INTO %I.%I OVERRIDING SYSTEM VALUE
       SELECT * FROM jsonb_populate_recordset(NULL::%I.%I, $1)',
      schema_name,
      table_name,
      schema_name,
      table_name
    )
    USING item.rows;
  END LOOP;
END
$import_tables$;

SET session_replication_role = origin;

DO $restore_foreign_keys$
DECLARE
  item record;
BEGIN
  FOR item IN SELECT * FROM stage3_foreign_keys
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I ADD CONSTRAINT %I %s NOT VALID',
      item.schema_name,
      item.table_name,
      item.constraint_name,
      item.definition
    );
    EXECUTE format(
      'ALTER TABLE %I.%I VALIDATE CONSTRAINT %I',
      item.schema_name,
      item.table_name,
      item.constraint_name
    );
  END LOOP;
END
$restore_foreign_keys$;

DO $sync_sequences$
DECLARE
  item record;
  sequence_name text;
  max_value bigint;
BEGIN
  FOR item IN
    SELECT table_schema, table_name, column_name
    FROM information_schema.columns
    WHERE table_schema IN ('public', 'private')
      AND (
        is_identity = 'YES'
        OR column_default LIKE 'nextval(%'
      )
  LOOP
    sequence_name := pg_get_serial_sequence(
      format('%I.%I', item.table_schema, item.table_name),
      item.column_name
    );
    IF sequence_name IS NULL THEN CONTINUE; END IF;

    EXECUTE format(
      'SELECT max(%I)::bigint FROM %I.%I',
      item.column_name,
      item.table_schema,
      item.table_name
    )
    INTO max_value;

    IF max_value IS NULL THEN
      PERFORM setval(sequence_name::regclass, 1, false);
    ELSE
      PERFORM setval(sequence_name::regclass, max_value, true);
    END IF;
  END LOOP;
END
$sync_sequences$;
SQL

runuser -u postgres -- psql \
  --dbname="$TARGET_DB" \
  --set=ON_ERROR_STOP=1 \
  < "$POST_RESTORE_SQL"

echo "API_RESTORE_OK database=$TARGET_DB"
