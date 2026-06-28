#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

BACKUP_ROOT="${KOMUI_BACKUP_ROOT:-/var/backups/komui}"
DB_NAME="${KOMUI_BACKUP_DB:-komui_staging}"
KEY_FILE="${KOMUI_BACKUP_KEY_FILE:-/etc/komui/backup.key}"
EXTERNAL_ENV_FILE="${KOMUI_BACKUP_EXTERNAL_ENV_FILE:-/etc/komui/yandex-backup.env}"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
HOSTNAME="$(hostname -f 2>/dev/null || hostname)"

DAILY_DIR="$BACKUP_ROOT/daily"
WEEKLY_DIR="$BACKUP_ROOT/weekly"
MONTHLY_DIR="$BACKUP_ROOT/monthly"
LOG_DIR="$BACKUP_ROOT/logs"
TMP_DIR="$(mktemp -d "$BACKUP_ROOT/.tmp-${RUN_ID}.XXXXXX")"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

install -d -m 0700 "$BACKUP_ROOT" "$DAILY_DIR" "$WEEKLY_DIR" "$MONTHLY_DIR" "$LOG_DIR"
install -d -m 0700 "$(dirname "$KEY_FILE")"
install -d -m 0700 "$BACKUP_ROOT/.gnupg"
export GNUPGHOME="$BACKUP_ROOT/.gnupg"

if [[ ! -s "$KEY_FILE" ]]; then
  openssl rand -base64 48 > "$KEY_FILE"
  chmod 0600 "$KEY_FILE"
fi

run_psql() {
  runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 "$@"
}

DB_DUMP="$TMP_DIR/${DB_NAME}.dump"
GLOBALS_DUMP="$TMP_DIR/postgres-globals.sql"
CONFIG_ARCHIVE="$TMP_DIR/runtime-config.tar.gz"
PLAIN_ARCHIVE="$TMP_DIR/komui-backup-${RUN_ID}.tar.gz"
FINAL_ARCHIVE="$DAILY_DIR/komui-backup-${RUN_ID}.tar.gz.gpg"
LOG_FILE="$LOG_DIR/komui-backup-${RUN_ID}.log"

{
  echo "backup_id=$RUN_ID"
  echo "host=$HOSTNAME"
  echo "database=$DB_NAME"
  echo "started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  runuser -u postgres -- pg_dump -Fc --no-owner --no-acl "$DB_NAME" > "$DB_DUMP"
  runuser -u postgres -- pg_dumpall --globals-only > "$GLOBALS_DUMP"

  tar -C / -czf "$CONFIG_ARCHIVE" --ignore-failed-read \
    etc/nginx/sites-available/komui-staging \
    etc/nginx/komui-staging.htpasswd \
    etc/systemd/system/komui-backend.service \
    etc/systemd/system/komui-backup.service \
    etc/systemd/system/komui-backup.timer \
    etc/komui \
    opt/komui/releases \
    opt/komui/frontend-releases \
    var/lib/komui/deployments.jsonl \
    var/lib/komui/deployment-current.json \
    var/lib/komui/staging-root 2>/dev/null || true

  cat > "$TMP_DIR/manifest.json" <<MANIFEST
{
  "backupId": "$RUN_ID",
  "host": "$HOSTNAME",
  "database": "$DB_NAME",
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "frontendRelease": "$(readlink -f /var/lib/komui/staging-root 2>/dev/null || true)",
  "backendService": "$(systemctl show komui-backend -p ActiveState -p SubState --value 2>/dev/null | paste -sd ' ' - || true)",
  "postgresVersion": "$(run_psql -d "$DB_NAME" -Atc 'select version()' | sed 's/"/\\"/g')"
}
MANIFEST

  (
    cd "$TMP_DIR"
    sha256sum "${DB_NAME}.dump" postgres-globals.sql runtime-config.tar.gz manifest.json > SHA256SUMS
  )

  tar -C "$TMP_DIR" -czf "$PLAIN_ARCHIVE" \
    "${DB_NAME}.dump" \
    postgres-globals.sql \
    runtime-config.tar.gz \
    manifest.json \
    SHA256SUMS

  gpg --batch --yes --pinentry-mode loopback \
    --passphrase-file "$KEY_FILE" \
    --symmetric --cipher-algo AES256 \
    --output "$FINAL_ARCHIVE" "$PLAIN_ARCHIVE"

  sha256sum "$FINAL_ARCHIVE" > "$FINAL_ARCHIVE.sha256"
  chmod 0600 "$FINAL_ARCHIVE" "$FINAL_ARCHIVE.sha256"

  if [[ -f "$EXTERNAL_ENV_FILE" ]]; then
    # shellcheck disable=SC1090
    set -a
    . "$EXTERNAL_ENV_FILE"
    set +a

    if [[ -z "${YANDEX_S3_BUCKET:-}" || -z "${YANDEX_S3_ENDPOINT:-}" ]]; then
      echo "external_upload=skipped_missing_bucket_or_endpoint"
    else
      prefix="${YANDEX_S3_PREFIX:-}"
      prefix="${prefix#/}"
      prefix="${prefix%/}"
      if [[ -n "$prefix" ]]; then
        destination_base="s3://${YANDEX_S3_BUCKET}/${prefix}/$(basename "$FINAL_ARCHIVE")"
      else
        destination_base="s3://${YANDEX_S3_BUCKET}/$(basename "$FINAL_ARCHIVE")"
      fi
      if command -v aws >/dev/null 2>&1; then
        aws --endpoint-url "$YANDEX_S3_ENDPOINT" s3 cp \
          "$FINAL_ARCHIVE" "$destination_base" --only-show-errors
        aws --endpoint-url "$YANDEX_S3_ENDPOINT" s3 cp \
          "$FINAL_ARCHIVE.sha256" "$destination_base.sha256" --only-show-errors
        echo "external_upload_tool=awscli"
      elif command -v s3cmd >/dev/null 2>&1; then
        s3_host="${YANDEX_S3_ENDPOINT#https://}"
        s3_host="${s3_host#http://}"
        s3_host="${s3_host%/}"
        s3cfg="$TMP_DIR/s3cmd.cfg"
        cat > "$s3cfg" <<S3CFG
[default]
access_key = ${AWS_ACCESS_KEY_ID}
secret_key = ${AWS_SECRET_ACCESS_KEY}
host_base = ${s3_host}
host_bucket = %(bucket)s.${s3_host}
use_https = True
signature_v2 = False
S3CFG
        chmod 0600 "$s3cfg"
        s3cmd -c "$s3cfg" --no-progress put "$FINAL_ARCHIVE" "$destination_base" >/dev/null
        s3cmd -c "$s3cfg" --no-progress put "$FINAL_ARCHIVE.sha256" "$destination_base.sha256" >/dev/null
        echo "external_upload_tool=s3cmd"
      else
        echo "external_upload=skipped_s3_client_missing"
        echo "external_destination=${destination_base}"
        exit 0
      fi
      echo "external_upload=ok"
      echo "external_destination=${destination_base}"
    fi
  else
    echo "external_upload=skipped_no_env_file"
  fi

  # Retention: 7 daily, 4 weekly, 6 monthly.
  find "$DAILY_DIR" -type f -name 'komui-backup-*.tar.gz.gpg' -mtime +7 -delete
  find "$DAILY_DIR" -type f -name 'komui-backup-*.tar.gz.gpg.sha256' -mtime +7 -delete

  if [[ "$(date -u +%u)" == "7" ]]; then
    cp -p "$FINAL_ARCHIVE" "$WEEKLY_DIR/"
    cp -p "$FINAL_ARCHIVE.sha256" "$WEEKLY_DIR/"
  fi
  find "$WEEKLY_DIR" -type f -name 'komui-backup-*.tar.gz.gpg' -mtime +35 -delete
  find "$WEEKLY_DIR" -type f -name 'komui-backup-*.tar.gz.gpg.sha256' -mtime +35 -delete

  if [[ "$(date -u +%d)" == "01" ]]; then
    cp -p "$FINAL_ARCHIVE" "$MONTHLY_DIR/"
    cp -p "$FINAL_ARCHIVE.sha256" "$MONTHLY_DIR/"
  fi
  find "$MONTHLY_DIR" -type f -name 'komui-backup-*.tar.gz.gpg' -mtime +190 -delete
  find "$MONTHLY_DIR" -type f -name 'komui-backup-*.tar.gz.gpg.sha256' -mtime +190 -delete

  echo "archive=$FINAL_ARCHIVE"
  echo "archive_size_bytes=$(stat -c %s "$FINAL_ARCHIVE")"
  echo "finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} | tee "$LOG_FILE"

chmod 0600 "$LOG_FILE"

if ! grep -q '^external_upload=ok$' "$LOG_FILE"; then
  if command -v /usr/local/sbin/komui-alert >/dev/null 2>&1; then
    /usr/local/sbin/komui-alert "KOMUI backup warning" "Backup finished, but external_upload=ok was not found in $LOG_FILE." || true
  fi
fi
