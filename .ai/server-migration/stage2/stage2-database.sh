#!/usr/bin/env bash
set -Eeuo pipefail

APP_PASSWORD=$(openssl rand -hex 24)
MIGRATOR_PASSWORD=$(openssl rand -hex 24)
BACKUP_PASSWORD=$(openssl rand -hex 24)

sudo -u postgres psql \
  --set=ON_ERROR_STOP=1 \
  --set=app_password="$APP_PASSWORD" \
  --set=migrator_password="$MIGRATOR_PASSWORD" \
  --set=backup_password="$BACKUP_PASSWORD" <<'SQL'
SELECT 'CREATE ROLE komui_owner NOLOGIN'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'komui_owner')
\gexec

SELECT 'CREATE ROLE komui_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 3'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'komui_migrator')
\gexec

SELECT 'CREATE ROLE komui_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 15'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'komui_app')
\gexec

SELECT 'CREATE ROLE komui_backup LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 2'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'komui_backup')
\gexec

SELECT format(
  'ALTER ROLE komui_migrator PASSWORD %L',
  :'migrator_password'
)
\gexec
SELECT format('ALTER ROLE komui_app PASSWORD %L', :'app_password')
\gexec
SELECT format('ALTER ROLE komui_backup PASSWORD %L', :'backup_password')
\gexec

GRANT komui_owner TO komui_migrator;

SELECT 'CREATE DATABASE komui_staging OWNER komui_owner ENCODING ''UTF8'' TEMPLATE template0'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'komui_staging')
\gexec

REVOKE ALL ON DATABASE komui_staging FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE komui_staging
  TO komui_owner, komui_migrator, komui_app, komui_backup;

ALTER ROLE komui_app SET statement_timeout = '30s';
ALTER ROLE komui_app SET lock_timeout = '5s';
ALTER ROLE komui_app SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE komui_migrator SET statement_timeout = '15min';
ALTER ROLE komui_backup SET statement_timeout = '30min';

\connect komui_staging

ALTER SCHEMA public OWNER TO komui_owner;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO komui_app, komui_backup;
GRANT USAGE, CREATE ON SCHEMA public TO komui_owner;

ALTER DEFAULT PRIVILEGES FOR ROLE komui_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO komui_app;
ALTER DEFAULT PRIVILEGES FOR ROLE komui_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO komui_app;
ALTER DEFAULT PRIVILEGES FOR ROLE komui_owner IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO komui_app;
ALTER DEFAULT PRIVILEGES FOR ROLE komui_owner IN SCHEMA public
  GRANT SELECT ON TABLES TO komui_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE komui_owner IN SCHEMA public
  GRANT SELECT ON SEQUENCES TO komui_backup;
SQL

install -m 640 -o root -g komui /dev/null /etc/komui/backend.env
printf '%s\n' \
  'NODE_ENV=staging' \
  'HOST=127.0.0.1' \
  'PORT=3000' \
  "DATABASE_URL=postgresql://komui_app:${APP_PASSWORD}@127.0.0.1:5432/komui_staging" \
  'TBANK_MODE=demo' \
  'CDEK_CREATE_SHIPMENTS=false' \
  > /etc/komui/backend.env

install -m 600 -o root -g root /dev/null /etc/komui/database-admin.env
printf '%s\n' \
  "KOMUI_MIGRATOR_DATABASE_URL=postgresql://komui_migrator:${MIGRATOR_PASSWORD}@127.0.0.1:5432/komui_staging" \
  "KOMUI_BACKUP_DATABASE_URL=postgresql://komui_backup:${BACKUP_PASSWORD}@127.0.0.1:5432/komui_staging" \
  > /etc/komui/database-admin.env

systemctl restart postgresql

pg_isready -h 127.0.0.1 -p 5432 -d komui_staging
PGPASSWORD="$APP_PASSWORD" psql \
  -h 127.0.0.1 -U komui_app -d komui_staging \
  --set=ON_ERROR_STOP=1 \
  -Atc "select current_database(), current_user, has_schema_privilege(current_user, 'public', 'CREATE');"

printf 'DATABASE_BASELINE_OK\n'
