#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE_ENV=${1:-/etc/komui/source-supabase.env}
BACKUP_DIR=${2:-/var/backups/komui/database}
STAMP=${STAMP:-$(date +%Y%m%d-%H%M%S)}
ENC_KEY=/etc/komui/backup-encryption.key
DUMP_FILE="$BACKUP_DIR/supabase-public-private-$STAMP.dump.enc"
LOG_FILE="$BACKUP_DIR/supabase-public-private-$STAMP.dump.log"
META_FILE="$BACKUP_DIR/supabase-public-private-$STAMP.meta"

if [[ ! -r "$SOURCE_ENV" ]]; then
  echo "Missing root-readable source environment: $SOURCE_ENV" >&2
  exit 2
fi

set -a
# shellcheck disable=SC1090
source "$SOURCE_ENV"
set +a

: "${SOURCE_DATABASE_URL:?SOURCE_DATABASE_URL is required}"

install -d -m 700 -o root -g root "$BACKUP_DIR"
if [[ ! -f "$ENC_KEY" ]]; then
  umask 077
  openssl rand -hex 32 > "$ENC_KEY"
fi
chmod 600 "$ENC_KEY"

export PGAPPNAME=komui_stage3_readonly_dump
export PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=0'

{
  echo "started_at=$(date --iso-8601=seconds)"
  echo "source_project=bkxpzfnglihxpbnhtjjq"
  echo "schemas=public,private"
  pg_dump --version
} > "$META_FILE"
chmod 600 "$META_FILE"

pg_dump "$SOURCE_DATABASE_URL" \
  --format=custom \
  --compress=zstd:6 \
  --no-owner \
  --no-privileges \
  --schema=public \
  --schema=private \
  --serializable-deferrable \
  --verbose \
  2> "$LOG_FILE" |
openssl enc -aes-256-cbc -salt -pbkdf2 \
  -pass file:"$ENC_KEY" \
  -out "$DUMP_FILE"

chmod 600 "$DUMP_FILE" "$LOG_FILE"
sha256sum "$DUMP_FILE" > "$DUMP_FILE.sha256"
chmod 600 "$DUMP_FILE.sha256"

{
  echo "completed_at=$(date --iso-8601=seconds)"
  stat -c 'encrypted_bytes=%s' "$DUMP_FILE"
  echo "encrypted_sha256=$(cut -d' ' -f1 "$DUMP_FILE.sha256")"
} >> "$META_FILE"

unset SOURCE_DATABASE_URL
echo "$DUMP_FILE"
