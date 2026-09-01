#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

usage() {
  cat <<'USAGE'
Usage:
  sudo /usr/local/sbin/komui-backup
  /usr/local/sbin/komui-backup --help

Creates a format-v2 encrypted KOMUI disaster-recovery backup, uploads the
archive and its portable checksum to the configured Object Storage location,
and applies the existing local retention policy only after upload validation.

The routine backup never creates or rotates its encryption key. Provision
/etc/komui/backup.key separately and escrow it outside this server.
USAGE
}

if (( $# == 1 )) && [[ "$1" == "-h" || "$1" == "--help" ]]; then
  usage
  exit 0
fi
if (( $# != 0 )); then
  echo "komui-backup does not accept arguments." >&2
  usage >&2
  exit 64
fi

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo: sudo /usr/local/sbin/komui-backup" >&2
  exit 1
fi

BACKUP_ROOT="${KOMUI_BACKUP_ROOT:-/var/backups/komui}"
KEY_FILE="${KOMUI_BACKUP_KEY_FILE:-/etc/komui/backup.key}"
EXTERNAL_ENV_FILE="${KOMUI_BACKUP_EXTERNAL_ENV_FILE:-/etc/komui/yandex-backup.env}"
MIN_FREE_KB="${KOMUI_BACKUP_MIN_FREE_KB:-1048576}"
BACKUP_LOCK_PATH="${KOMUI_BACKUP_LOCK_PATH:-$BACKUP_ROOT/.backup.lock}"

if [[ -n "${KOMUI_BACKUP_DBS:-}" ]]; then
  DB_LIST="$KOMUI_BACKUP_DBS"
elif [[ -n "${KOMUI_BACKUP_DB:-}" ]]; then
  # Backward compatibility for installations that explicitly configured one DB.
  DB_LIST="$KOMUI_BACKUP_DB"
else
  DB_LIST="komui_staging komui_production"
fi
read -r -a DB_NAMES <<< "$DB_LIST"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command is unavailable: $1"
}

validate_absolute_path() {
  local label="$1"
  local path="$2"
  [[ "$path" == /* && "$path" != "/" && "$path" != *$'\n'* && \
     "$path" != *$'\t'* && "$path" != *'/../'* && "$path" != *'/./'* ]] ||
    fail "$label must be a safe absolute path: $path"
}

validate_secret_file() {
  local label="$1"
  local path="$2"
  local owner mode links
  [[ -f "$path" && ! -L "$path" && -s "$path" ]] ||
    fail "$label is missing, empty, or not a regular file: $path"
  owner="$(stat -c %u "$path")"
  mode="$(stat -c %a "$path")"
  links="$(stat -c %h "$path")"
  [[ "$owner" == "0" ]] || fail "$label must be owned by root: $path"
  [[ "$mode" == "400" || "$mode" == "600" ]] ||
    fail "$label must have mode 0400 or 0600, got $mode: $path"
  [[ "$links" == "1" ]] || fail "$label must not have hard links: $path"
}

validate_absolute_path "KOMUI_BACKUP_ROOT" "$BACKUP_ROOT"
validate_absolute_path "KOMUI_BACKUP_KEY_FILE" "$KEY_FILE"
validate_absolute_path "KOMUI_BACKUP_EXTERNAL_ENV_FILE" "$EXTERNAL_ENV_FILE"
validate_absolute_path "KOMUI_BACKUP_LOCK_PATH" "$BACKUP_LOCK_PATH"

if [[ "${#DB_NAMES[@]}" -eq 0 ]]; then
  fail "No databases configured for backup."
fi
for db_name in "${DB_NAMES[@]}"; do
  [[ "$db_name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] ||
    fail "Unsafe database name: $db_name"
done
[[ "$MIN_FREE_KB" =~ ^[0-9]+$ ]] && (( MIN_FREE_KB >= 262144 )) ||
  fail "KOMUI_BACKUP_MIN_FREE_KB must be an integer of at least 262144."

for command_name in \
  awk chmod cmp cp date df dpkg-query find flock gpg grep gzip hostname install mktemp mv \
  pg_dump pg_dumpall pg_restore psql python3 readlink runuser sed sha256sum \
  sort stat systemctl tar tee tr rmdir rm; do
  require_command "$command_name"
done

# A routine backup must never silently create or rotate the only decryption key.
validate_secret_file "Backup encryption key" "$KEY_FILE"
validate_secret_file "Object Storage environment" "$EXTERNAL_ENV_FILE"
KEY_FILE="$(readlink -f "$KEY_FILE")"
EXTERNAL_ENV_FILE="$(readlink -f "$EXTERNAL_ENV_FILE")"

# shellcheck disable=SC1090
. "$EXTERNAL_ENV_FILE"

[[ -n "${YANDEX_S3_BUCKET:-}" ]] || fail "YANDEX_S3_BUCKET is not configured."
[[ -n "${YANDEX_S3_ENDPOINT:-}" ]] || fail "YANDEX_S3_ENDPOINT is not configured."
[[ -n "${AWS_ACCESS_KEY_ID:-}" ]] || fail "AWS_ACCESS_KEY_ID is not configured."
[[ -n "${AWS_SECRET_ACCESS_KEY:-}" ]] || fail "AWS_SECRET_ACCESS_KEY is not configured."
export -n AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
export -n AWS_DEFAULT_REGION AWS_SESSION_TOKEN 2>/dev/null || true
[[ "$YANDEX_S3_BUCKET" =~ ^[a-z0-9][a-z0-9.-]*[a-z0-9]$ ]] ||
  fail "YANDEX_S3_BUCKET has an unsafe value."
[[ "$YANDEX_S3_ENDPOINT" =~ ^https://[A-Za-z0-9._:-]+/?$ ]] ||
  fail "YANDEX_S3_ENDPOINT must be a simple HTTPS origin."

S3_PREFIX="${YANDEX_S3_PREFIX:-}"
S3_PREFIX="${S3_PREFIX#/}"
S3_PREFIX="${S3_PREFIX%/}"
[[ "$S3_PREFIX" != *".."* && "$S3_PREFIX" != *$'\n'* && "$S3_PREFIX" != *$'\t'* ]] ||
  fail "YANDEX_S3_PREFIX has an unsafe value."

if command -v aws >/dev/null 2>&1; then
  S3_TOOL="awscli"
elif command -v s3cmd >/dev/null 2>&1; then
  S3_TOOL="s3cmd"
else
  fail "Neither aws nor s3cmd is installed; external upload is mandatory."
fi

run_aws() (
  AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-ru-central1}"
  export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION
  if [[ -n "${AWS_SESSION_TOKEN:-}" ]]; then
    export AWS_SESSION_TOKEN
  else
    unset AWS_SESSION_TOKEN
  fi
  command aws "$@"
)

DAILY_DIR="$BACKUP_ROOT/daily"
WEEKLY_DIR="$BACKUP_ROOT/weekly"
MONTHLY_DIR="$BACKUP_ROOT/monthly"
LOG_DIR="$BACKUP_ROOT/logs"

install -d -m 0700 "$BACKUP_ROOT" "$DAILY_DIR" "$WEEKLY_DIR" "$MONTHLY_DIR" "$LOG_DIR"
install -d -m 0700 "$BACKUP_ROOT/.gnupg"
export GNUPGHOME="$BACKUP_ROOT/.gnupg"

# Serialize backup runs. Do not acquire the deploy/prune locks here: controlled
# rollout tooling can invoke a backup while already holding the deploy lock.
# Exact active targets are archived and compared before/after instead.
exec 9>"$BACKUP_LOCK_PATH"
chmod 0600 "$BACKUP_LOCK_PATH"
flock -n 9 || fail "Another KOMUI backup is already running."

# A killed process cannot run its EXIT trap. Once the backup lock is held, it
# is safe to remove only exact, root-owned workdirs left by interrupted runs.
shopt -s nullglob
for stale_workdir in "$BACKUP_ROOT"/.tmp-*; do
  stale_basename="${stale_workdir##*/}"
  [[ "$stale_basename" =~ ^\.tmp-[0-9]{8}T[0-9]{6}Z\.[A-Za-z0-9]{6}$ ]] || continue
  [[ -d "$stale_workdir" && ! -L "$stale_workdir" ]] ||
    fail "Refusing cleanup of suspicious stale workdir: $stale_workdir"
  [[ "$(stat -c %u "$stale_workdir")" == "0" && \
     "$(stat -c %a "$stale_workdir")" == "700" ]] ||
    fail "Refusing cleanup of stale workdir with unexpected ownership/mode: $stale_workdir"
  find "$stale_workdir" -xdev -mindepth 1 -delete
  rmdir "$stale_workdir"
  printf 'stale_workdir_removed=%s\n' "$stale_workdir"
done
shopt -u nullglob

shopt -s nullglob
for stale_partial in \
  "$DAILY_DIR"/.komui-backup-*.tar.gz.gpg.partial.* \
  "$DAILY_DIR"/.komui-backup-*.tar.gz.gpg.sha256.partial.*; do
  stale_basename="${stale_partial##*/}"
  [[ "$stale_basename" =~ ^\.komui-backup-[0-9]{8}T[0-9]{6}Z\.tar\.gz\.gpg(\.sha256)?\.partial\.[0-9]+$ ]] || continue
  [[ -f "$stale_partial" && ! -L "$stale_partial" && \
     "$(stat -c %u "$stale_partial")" == "0" && \
     "$(stat -c %a "$stale_partial")" == "600" && \
     "$(stat -c %h "$stale_partial")" == "1" ]] ||
    fail "Refusing cleanup of suspicious partial backup: $stale_partial"
  rm -f -- "$stale_partial"
  printf 'stale_partial_removed=%s\n' "$stale_partial"
done
for orphan_checksum in "$DAILY_DIR"/komui-backup-*.tar.gz.gpg.sha256; do
  orphan_basename="${orphan_checksum##*/}"
  [[ "$orphan_basename" =~ ^komui-backup-[0-9]{8}T[0-9]{6}Z\.tar\.gz\.gpg\.sha256$ ]] || continue
  paired_archive="${orphan_checksum%.sha256}"
  [[ -e "$paired_archive" ]] && continue
  [[ -f "$orphan_checksum" && ! -L "$orphan_checksum" && \
     "$(stat -c %u "$orphan_checksum")" == "0" && \
     "$(stat -c %a "$orphan_checksum")" == "600" && \
     "$(stat -c %h "$orphan_checksum")" == "1" ]] ||
    fail "Refusing cleanup of suspicious orphan checksum: $orphan_checksum"
  rm -f -- "$orphan_checksum"
  printf 'orphan_checksum_removed=%s\n' "$orphan_checksum"
done
shopt -u nullglob

available_kb="$(df -Pk "$BACKUP_ROOT" | awk 'NR == 2 {print $4}')"
[[ "$available_kb" =~ ^[0-9]+$ ]] || fail "Could not determine free backup space."
(( available_kb >= MIN_FREE_KB )) ||
  fail "Insufficient backup space: ${available_kb} KiB available, ${MIN_FREE_KB} KiB required."

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
HOST_FQDN="$(hostname -f 2>/dev/null || hostname)"
ARCHIVE_BASENAME="komui-backup-${RUN_ID}.tar.gz.gpg"
FINAL_ARCHIVE="$DAILY_DIR/$ARCHIVE_BASENAME"
FINAL_CHECKSUM="$FINAL_ARCHIVE.sha256"
FINAL_ARCHIVE_PARTIAL="$DAILY_DIR/.${ARCHIVE_BASENAME}.partial.$$"
FINAL_CHECKSUM_PARTIAL="$DAILY_DIR/.${ARCHIVE_BASENAME}.sha256.partial.$$"
LOG_FILE="$LOG_DIR/komui-backup-${RUN_ID}.log"

[[ ! -e "$FINAL_ARCHIVE" && ! -e "$FINAL_CHECKSUM" ]] ||
  fail "Backup id collision: $RUN_ID"

touch "$LOG_FILE"
chmod 0600 "$LOG_FILE"
exec > >(tee "$LOG_FILE") 2>&1

TMP_DIR=""
cleanup() {
  local original_status="$?"
  local final_status="$original_status"
  trap - EXIT

  rm -f -- "$FINAL_ARCHIVE_PARTIAL" "$FINAL_CHECKSUM_PARTIAL"
  if [[ -n "$TMP_DIR" && -d "$TMP_DIR" ]]; then
    case "$TMP_DIR" in
      "$BACKUP_ROOT"/.tmp-"$RUN_ID".*)
        if ! find "$TMP_DIR" -xdev -mindepth 1 -delete || ! rmdir "$TMP_DIR"; then
          printf 'ERROR: failed to remove backup workdir: %s\n' "$TMP_DIR" >&2
          final_status=1
        fi
        ;;
      *)
        printf 'ERROR: refusing cleanup of unexpected workdir: %s\n' "$TMP_DIR" >&2
        final_status=1
        ;;
    esac
  fi

  if (( original_status != 0 )); then
    printf 'backup_id=%s\nresult=failed\nexit_status=%s\n' "$RUN_ID" "$original_status" >&2
    if command -v /usr/local/sbin/komui-alert >/dev/null 2>&1; then
      /usr/local/sbin/komui-alert \
        "KOMUI backup failed" \
        "Backup $RUN_ID failed with status $original_status. See $LOG_FILE." || true
    fi
  fi
  exit "$final_status"
}
trap cleanup EXIT

TMP_DIR="$(mktemp -d "$BACKUP_ROOT/.tmp-${RUN_ID}.XXXXXX")"
chmod 0700 "$TMP_DIR"

run_psql() {
  runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 "$@"
}

write_security_inventory_sql() {
  local cluster_database_scope=""
  local scoped_database

  for scoped_database in "${DB_NAMES[@]}"; do
    if [[ -n "$cluster_database_scope" ]]; then
      cluster_database_scope+=", "
    fi
    # Database names passed the strict identifier allowlist before this point.
    cluster_database_scope+="'${scoped_database}'"
  done

  cat > "$TMP_DIR/security-inventory.sql" <<'SQL'
WITH database_inventory AS (
  SELECT jsonb_build_object(
    'name', d.datname,
    'owner', pg_get_userbyid(d.datdba),
    'encoding', pg_encoding_to_char(d.encoding),
    'localeProvider', d.datlocprovider,
    'collate', d.datcollate,
    'ctype', d.datctype,
    'locale', d.datlocale,
    'icuRules', d.daticurules,
    'collationVersion', d.datcollversion,
    'connectionLimit', d.datconnlimit,
    'acl', CASE WHEN d.datacl IS NULL THEN NULL ELSE COALESCE(
      (SELECT jsonb_agg(a::text ORDER BY a::text) FROM unnest(d.datacl) AS a),
      '[]'::jsonb
    ) END
  ) AS value
  FROM pg_database AS d
  WHERE d.datname = current_database()
), schema_inventory AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'schema', n.nspname,
    'owner', pg_get_userbyid(n.nspowner),
    'acl', CASE WHEN n.nspacl IS NULL THEN NULL ELSE COALESCE(
      (SELECT jsonb_agg(a::text ORDER BY a::text) FROM unnest(n.nspacl) AS a),
      '[]'::jsonb
    ) END
  ) ORDER BY n.nspname), '[]'::jsonb) AS value
  FROM pg_namespace AS n
  WHERE n.nspname <> 'information_schema'
    AND n.nspname !~ '^pg_'
), relation_inventory AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'schema', n.nspname,
    'name', c.relname,
    'kind', c.relkind,
    'owner', pg_get_userbyid(c.relowner),
    'rowSecurity', c.relrowsecurity,
    'forceRowSecurity', c.relforcerowsecurity,
    'acl', CASE WHEN c.relacl IS NULL THEN NULL ELSE COALESCE(
      (SELECT jsonb_agg(a::text ORDER BY a::text) FROM unnest(c.relacl) AS a),
      '[]'::jsonb
    ) END
  ) ORDER BY n.nspname, c.relname, c.relkind), '[]'::jsonb) AS value
  FROM pg_class AS c
  JOIN pg_namespace AS n ON n.oid = c.relnamespace
  WHERE n.nspname <> 'information_schema'
    AND n.nspname !~ '^pg_'
    AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
), routine_inventory AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'schema', n.nspname,
    'name', p.proname,
    'identityArguments', pg_get_function_identity_arguments(p.oid),
    'kind', p.prokind,
    'owner', pg_get_userbyid(p.proowner),
    'securityDefiner', p.prosecdef,
    'acl', CASE WHEN p.proacl IS NULL THEN NULL ELSE COALESCE(
      (SELECT jsonb_agg(a::text ORDER BY a::text) FROM unnest(p.proacl) AS a),
      '[]'::jsonb
    ) END
  ) ORDER BY n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)), '[]'::jsonb) AS value
  FROM pg_proc AS p
  JOIN pg_namespace AS n ON n.oid = p.pronamespace
  WHERE n.nspname <> 'information_schema'
    AND n.nspname !~ '^pg_'
), column_acl_inventory AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'schema', n.nspname,
    'relation', c.relname,
    'column', a.attname,
    'acl', COALESCE(
      (SELECT jsonb_agg(item::text ORDER BY item::text) FROM unnest(a.attacl) AS item),
      '[]'::jsonb
    )
  ) ORDER BY n.nspname, c.relname, a.attnum), '[]'::jsonb) AS value
  FROM pg_attribute AS a
  JOIN pg_class AS c ON c.oid = a.attrelid
  JOIN pg_namespace AS n ON n.oid = c.relnamespace
  WHERE n.nspname <> 'information_schema'
    AND n.nspname !~ '^pg_'
    AND a.attnum > 0
    AND NOT a.attisdropped
    AND a.attacl IS NOT NULL
), type_inventory AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'schema', n.nspname,
    'name', t.typname,
    'kind', t.typtype,
    'owner', pg_get_userbyid(t.typowner),
    'acl', CASE WHEN t.typacl IS NULL THEN NULL ELSE COALESCE(
      (SELECT jsonb_agg(a::text ORDER BY a::text) FROM unnest(t.typacl) AS a),
      '[]'::jsonb
    ) END
  ) ORDER BY n.nspname, t.typname, t.typtype), '[]'::jsonb) AS value
  FROM pg_type AS t
  JOIN pg_namespace AS n ON n.oid = t.typnamespace
  WHERE n.nspname <> 'information_schema'
    AND n.nspname !~ '^pg_'
    AND (
      t.typrelid = 0
      OR EXISTS (
        SELECT 1 FROM pg_class AS composite_relation
        WHERE composite_relation.oid = t.typrelid
          AND composite_relation.relkind = 'c'
      )
    )
    AND t.typelem = 0
), default_acl_inventory AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'role', pg_get_userbyid(d.defaclrole),
    'schema', CASE WHEN d.defaclnamespace = 0 THEN NULL ELSE n.nspname END,
    'objectType', d.defaclobjtype,
    'acl', COALESCE(
      (SELECT jsonb_agg(a::text ORDER BY a::text) FROM unnest(d.defaclacl) AS a),
      '[]'::jsonb
    )
  ) ORDER BY pg_get_userbyid(d.defaclrole), n.nspname NULLS FIRST, d.defaclobjtype), '[]'::jsonb) AS value
  FROM pg_default_acl AS d
  LEFT JOIN pg_namespace AS n ON n.oid = d.defaclnamespace
), extension_inventory AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'name', e.extname,
    'schema', n.nspname,
    'owner', pg_get_userbyid(e.extowner),
    'version', e.extversion
  ) ORDER BY e.extname), '[]'::jsonb) AS value
  FROM pg_extension AS e
  JOIN pg_namespace AS n ON n.oid = e.extnamespace
  WHERE e.extname <> 'plpgsql'
), policy_inventory AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'schema', n.nspname,
    'relation', c.relname,
    'name', p.polname,
    'permissive', p.polpermissive,
    'command', p.polcmd,
    'roles', COALESCE((
      SELECT jsonb_agg(CASE WHEN r = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END
                       ORDER BY CASE WHEN r = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END)
      FROM unnest(p.polroles) AS r
    ), '[]'::jsonb),
    'using', pg_get_expr(p.polqual, p.polrelid),
    'withCheck', pg_get_expr(p.polwithcheck, p.polrelid)
  ) ORDER BY n.nspname, c.relname, p.polname), '[]'::jsonb) AS value
  FROM pg_policy AS p
  JOIN pg_class AS c ON c.oid = p.polrelid
  JOIN pg_namespace AS n ON n.oid = c.relnamespace
), large_object_inventory AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'oid', l.oid,
    'owner', pg_get_userbyid(l.lomowner),
    'acl', CASE WHEN l.lomacl IS NULL THEN NULL ELSE COALESCE(
      (SELECT jsonb_agg(item::text ORDER BY item::text) FROM unnest(l.lomacl) AS item),
      '[]'::jsonb
    ) END
  ) ORDER BY l.oid), '[]'::jsonb) AS value
  FROM pg_largeobject_metadata AS l
), database_setting_inventory AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'role', CASE WHEN s.setrole = 0 THEN NULL ELSE pg_get_userbyid(s.setrole) END,
    'settings', COALESCE((
      SELECT jsonb_agg(setting ORDER BY setting)
      FROM unnest(s.setconfig) AS setting
    ), '[]'::jsonb)
  ) ORDER BY CASE WHEN s.setrole = 0 THEN 0 ELSE 1 END,
             pg_get_userbyid(s.setrole) NULLS FIRST,
             s.setconfig::text), '[]'::jsonb) AS value
  FROM pg_db_role_setting AS s
  WHERE s.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())
)
SELECT jsonb_pretty(jsonb_build_object(
  'database', (SELECT value FROM database_inventory),
  'schemas', (SELECT value FROM schema_inventory),
  'relations', (SELECT value FROM relation_inventory),
  'routines', (SELECT value FROM routine_inventory),
  'columnPrivileges', (SELECT value FROM column_acl_inventory),
  'types', (SELECT value FROM type_inventory),
  'defaultPrivileges', (SELECT value FROM default_acl_inventory),
  'extensions', (SELECT value FROM extension_inventory),
  'policies', (SELECT value FROM policy_inventory),
  'largeObjects', (SELECT value FROM large_object_inventory),
  'databaseSettings', (SELECT value FROM database_setting_inventory)
));
SQL

  cat > "$TMP_DIR/cluster-security-inventory.sql" <<SQL
WITH role_inventory AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'name', r.rolname,
    'superuser', r.rolsuper,
    'inherit', r.rolinherit,
    'createRole', r.rolcreaterole,
    'createDb', r.rolcreatedb,
    'canLogin', r.rolcanlogin,
    'replication', r.rolreplication,
    'bypassRls', r.rolbypassrls,
    'connectionLimit', r.rolconnlimit,
    'validUntil', r.rolvaliduntil::text,
    'settings', CASE WHEN r.rolconfig IS NULL THEN NULL ELSE COALESCE(
      (SELECT jsonb_agg(setting ORDER BY setting) FROM unnest(r.rolconfig) AS setting),
      '[]'::jsonb
    ) END
  ) ORDER BY r.rolname), '[]'::jsonb) AS value
  FROM pg_roles AS r
  WHERE r.rolname !~ '^pg_'
    AND r.rolname <> 'postgres'
    AND r.rolname <> current_user
), membership_inventory AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'role', pg_get_userbyid(m.roleid),
    'member', pg_get_userbyid(m.member),
    'grantor', pg_get_userbyid(m.grantor),
    'adminOption', m.admin_option,
    'inheritOption', m.inherit_option,
    'setOption', m.set_option
  ) ORDER BY pg_get_userbyid(m.roleid), pg_get_userbyid(m.member),
             pg_get_userbyid(m.grantor), m.admin_option, m.inherit_option, m.set_option),
    '[]'::jsonb) AS value
  FROM pg_auth_members AS m
  WHERE NOT (
    pg_get_userbyid(m.roleid) ~ '^pg_'
    AND pg_get_userbyid(m.member) ~ '^pg_'
  )
), global_setting_inventory AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'database', CASE WHEN s.setdatabase = 0 THEN NULL ELSE d.datname END,
    'role', CASE WHEN s.setrole = 0 THEN NULL ELSE pg_get_userbyid(s.setrole) END,
    'settings', COALESCE((
      SELECT jsonb_agg(setting ORDER BY setting)
      FROM unnest(s.setconfig) AS setting
    ), '[]'::jsonb)
  ) ORDER BY CASE WHEN s.setdatabase = 0 THEN 0 ELSE 1 END,
             d.datname NULLS FIRST,
             CASE WHEN s.setrole = 0 THEN 0 ELSE 1 END,
             pg_get_userbyid(s.setrole) NULLS FIRST,
             s.setconfig::text), '[]'::jsonb) AS value
  FROM pg_db_role_setting AS s
  LEFT JOIN pg_database AS d ON d.oid = s.setdatabase
  WHERE s.setdatabase = 0
     OR d.datname IN (${cluster_database_scope})
)
SELECT jsonb_pretty(jsonb_build_object(
  'roles', (SELECT value FROM role_inventory),
  'memberships', (SELECT value FROM membership_inventory),
  'roleAndDatabaseSettings', (SELECT value FROM global_setting_inventory)
));
SQL
}

capture_activation_links() {
  local output="$1"
  local path allowed_root raw_target resolved
  : > "$output"
  while IFS=$'\t' read -r path allowed_root; do
    [[ -L "$path" ]] || fail "Required activation link is missing: $path"
    raw_target="$(readlink "$path")"
    resolved="$(readlink -f "$path")"
    [[ -d "$resolved" ]] || fail "Activation target is not a directory: $path -> $resolved"
    [[ "$resolved" == "$allowed_root"/* ]] ||
      fail "Activation target escapes its release root: $path -> $resolved"
    [[ "$path$raw_target$resolved" != *$'\n'* && "$path$raw_target$resolved" != *$'\t'* ]] ||
      fail "Activation link contains an unsafe character: $path"
    printf '%s\t%s\t%s\n' "$path" "$raw_target" "$resolved" >> "$output"
  done <<'LINKS'
/opt/komui/current	/opt/komui/releases
/opt/komui/production-current	/opt/komui/releases
/var/lib/komui/staging-root	/opt/komui/frontend-releases
/var/lib/komui/production-root	/opt/komui/production-frontend-releases
LINKS
}

add_runtime_path() {
  local path="$1"
  [[ "$path" == /* && "$path" != "/" ]] || fail "Unsafe runtime path: $path"
  [[ "$path" != *$'\n'* && "$path" != *$'\t'* ]] ||
    fail "Runtime path contains an unsafe character: $path"
  [[ -e "$path" || -L "$path" ]] || fail "Required runtime path is missing: $path"
  printf '%s\0' "${path#/}" >> "$RUNTIME_PATHS_UNSORTED"
}

write_security_inventory_sql

ACTIVATION_LINKS="$TMP_DIR/activation-links.tsv"
ACTIVATION_LINKS_AFTER="$TMP_DIR/activation-links-after.tsv"
capture_activation_links "$ACTIVATION_LINKS"

RUNTIME_PATHS_UNSORTED="$TMP_DIR/runtime-paths.unsorted.nul"
RUNTIME_PATHS_NUL="$TMP_DIR/runtime-paths.nul"
RUNTIME_PATHS_TXT="$TMP_DIR/runtime-paths.txt"
: > "$RUNTIME_PATHS_UNSORTED"

for required_path in \
  /etc/nginx \
  /etc/letsencrypt \
  /var/lib/letsencrypt \
  /etc/komui \
  /etc/komui-xray \
  /etc/postgresql \
  /etc/postgresql-common \
  /etc/logrotate.d/komui \
  /etc/sysctl.d/60-komui.conf \
  /opt/komui/current \
  /opt/komui/production-current \
  /opt/komui/shared \
  /opt/komui/migration \
  /var/lib/komui \
  /usr/local/bin/xray \
  /usr/local/etc/xray/config.json \
  /usr/local/share/xray \
  /etc/systemd/system/xray.service \
  /etc/systemd/system/xray.service.d \
  /etc/systemd/system/multi-user.target.wants/xray.service; do
  add_runtime_path "$required_path"
done

# Archive the four exact immutable releases referenced by the activation links,
# not every historical or concurrently-building release in their parent roots.
while IFS=$'\t' read -r _activation_path _raw_target resolved_target; do
  add_runtime_path "$resolved_target"
done < "$ACTIVATION_LINKS"

DYNAMIC_SBIN_PATHS="$TMP_DIR/runtime-sbin-paths.nul"
find /usr/local/sbin -mindepth 1 -maxdepth 1 -type f -name 'komui-*' \
  ! -name '*.bak-*' ! -name '*.pre-*' -print0 | sort -z > "$DYNAMIC_SBIN_PATHS"
while IFS= read -r -d '' runtime_path; do
  add_runtime_path "$runtime_path"
done < "$DYNAMIC_SBIN_PATHS"

DYNAMIC_SYSTEMD_PATHS="$TMP_DIR/runtime-systemd-paths.nul"
find /etc/systemd/system -mindepth 1 -maxdepth 2 \( -type f -o -type l -o -type d \) \
  -name 'komui-*' ! -name '*.bak-*' -print0 | sort -z > "$DYNAMIC_SYSTEMD_PATHS"
while IFS= read -r -d '' runtime_path; do
  add_runtime_path "$runtime_path"
done < "$DYNAMIC_SYSTEMD_PATHS"

sort -zu "$RUNTIME_PATHS_UNSORTED" > "$RUNTIME_PATHS_NUL"
tr '\0' '\n' < "$RUNTIME_PATHS_NUL" > "$RUNTIME_PATHS_TXT"
[[ -s "$RUNTIME_PATHS_TXT" ]] || fail "Runtime path inventory is empty."

printf 'backup_id=%s\n' "$RUN_ID"
printf 'backup_format_version=2\n'
printf 'host=%s\n' "$HOST_FQDN"
printf 'databases=%s\n' "${DB_NAMES[*]}"
printf 'started_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf 'external_upload_required=yes\n'

CLUSTER_SECURITY_BEFORE="$TMP_DIR/cluster-security.before.json"
CLUSTER_SECURITY="$TMP_DIR/cluster-security.json"
run_psql -qAt -d postgres < "$TMP_DIR/cluster-security-inventory.sql" > "$CLUSTER_SECURITY_BEFORE"
python3 - "$CLUSTER_SECURITY_BEFORE" "${DB_NAMES[@]}" <<'PY'
import json
import pathlib
import sys

inventory = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
database_scope = set(sys.argv[2:])
if set(inventory) != {"roles", "memberships", "roleAndDatabaseSettings"}:
    raise SystemExit("cluster security inventory schema mismatch")
settings = inventory["roleAndDatabaseSettings"]
if not isinstance(settings, list):
    raise SystemExit("cluster security settings inventory must be an array")
for index, entry in enumerate(settings):
    if not isinstance(entry, dict) or set(entry) != {"database", "role", "settings"}:
        raise SystemExit(f"cluster security setting row {index} schema mismatch")
    database = entry["database"]
    role = entry["role"]
    values = entry["settings"]
    if database is not None and database not in database_scope:
        raise SystemExit("cluster security inventory escaped the database scope")
    if role is not None and not isinstance(role, str):
        raise SystemExit(f"cluster security setting row {index} role type mismatch")
    if not isinstance(values, list) or any(not isinstance(value, str) for value in values):
        raise SystemExit(f"cluster security setting row {index} values type mismatch")
    # pg_dumpall --globals-only does not emit ALTER ROLE ALL SET. Refuse to
    # publish a backup that would claim this cluster-wide setting is restorable.
    if database is None and role is None:
        raise SystemExit("unsupported ALTER ROLE ALL setting exists in PostgreSQL")
    if role is not None and role.startswith("pg_"):
        raise SystemExit("unsupported predefined-role setting exists in PostgreSQL")
PY
printf 'cluster_security_scope=global_roles_memberships_and_scoped_database_settings\n'

GLOBALS_DUMP="$TMP_DIR/postgres-globals.sql"
runuser -u postgres -- pg_dumpall --globals-only > "$GLOBALS_DUMP"
[[ -s "$GLOBALS_DUMP" ]] || fail "PostgreSQL globals dump is empty."

DATABASE_METADATA_JSONL="$TMP_DIR/database-metadata.jsonl"
DATABASE_OWNERS_JSON="$TMP_DIR/database-owners.json"
DUMP_STATS_TSV="$TMP_DIR/database-dump-stats.tsv"
: > "$DATABASE_METADATA_JSONL"
printf 'database\tdump\tsha256\ttoc_entries\towner_commands\tacl_entries\tdefault_acl_entries\tgrant_revoke_commands\tsecurity_inventory\tsecurity_sha256\n' > "$DUMP_STATS_TSV"

dump_basenames=()
security_basenames=()
for db_name in "${DB_NAMES[@]}"; do
  dump_basename="${db_name}.dump"
  security_basename="security-${db_name}.json"
  security_before="$TMP_DIR/security-${db_name}.before.json"
  dump_path="$TMP_DIR/$dump_basename"
  dump_list="$TMP_DIR/${db_name}.toc"
  dump_schema="$TMP_DIR/${db_name}.schema.sql"

  run_psql -qAt -d "$db_name" < "$TMP_DIR/security-inventory.sql" > "$security_before"
  runuser -u postgres -- pg_dump -Fc --create "$db_name" > "$dump_path"
  [[ -s "$dump_path" ]] || fail "Database dump is empty: $db_name"
  pg_restore --list "$dump_path" > "$dump_list"
  pg_restore --create --schema-only --file="$dump_schema" "$dump_path"
  run_psql -qAt -d "$db_name" < "$TMP_DIR/security-inventory.sql" > "$TMP_DIR/$security_basename"
  cmp -s "$security_before" "$TMP_DIR/$security_basename" ||
    fail "Database security metadata changed during dump: $db_name"

  python3 - "$TMP_DIR/$security_basename" >> "$DATABASE_METADATA_JSONL" <<'PY'
import json
import sys

print(json.dumps(json.load(open(sys.argv[1], encoding="utf-8"))["database"],
                 ensure_ascii=False, sort_keys=True, separators=(",", ":")))
PY

  dump_sha="$(sha256sum "$dump_path" | awk '{print $1}')"
  security_sha="$(sha256sum "$TMP_DIR/$security_basename" | awk '{print $1}')"
  toc_entries="$(grep -Ec '^[0-9]+;' "$dump_list" || true)"
  default_acl_entries="$(grep -Ec ' DEFAULT ACL ' "$dump_list" || true)"
  all_acl_entries="$(grep -Ec ' ACL ' "$dump_list" || true)"
  acl_entries=$((all_acl_entries - default_acl_entries))
  owner_commands="$(grep -Ec '^ALTER .* OWNER TO ' "$dump_schema" || true)"
  grant_revoke_commands="$(grep -Ec '^(GRANT|REVOKE) ' "$dump_schema" || true)"
  (( toc_entries > 0 )) || fail "Database TOC is empty: $db_name"
  (( owner_commands > 0 )) || fail "Database dump has no owner commands: $db_name"

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$db_name" "$dump_basename" "$dump_sha" "$toc_entries" \
    "$owner_commands" "$acl_entries" "$default_acl_entries" \
    "$grant_revoke_commands" "$security_basename" "$security_sha" >> "$DUMP_STATS_TSV"
  dump_basenames+=("$dump_basename")
  security_basenames+=("$security_basename")
done

python3 - "$DATABASE_METADATA_JSONL" "$DATABASE_OWNERS_JSON" <<'PY'
import json
import sys
from pathlib import Path

metadata_path, output_path = sys.argv[1:]
owners = [
    {"database": entry["name"], "owner": entry["owner"]}
    for entry in (
        json.loads(line)
        for line in Path(metadata_path).read_text(encoding="utf-8").splitlines()
    )
]
Path(output_path).write_text(
    json.dumps({"formatVersion": 1, "databases": owners}, ensure_ascii=False,
               indent=2, sort_keys=True) + "\n",
    encoding="utf-8",
)
PY

run_psql -qAt -d postgres < "$TMP_DIR/cluster-security-inventory.sql" > "$CLUSTER_SECURITY"
cmp -s "$CLUSTER_SECURITY_BEFORE" "$CLUSTER_SECURITY" ||
  fail "PostgreSQL role or membership metadata changed during backup."

CONFIG_ARCHIVE="$TMP_DIR/runtime-config.tar.gz"
tar --create --gzip --file="$CONFIG_ARCHIVE" \
  --directory=/ \
  --acls --xattrs --numeric-owner \
  --exclude="${KEY_FILE#/}" \
  --exclude='etc/komui/backup.key' \
  --exclude='etc/komui/backup-encryption.key' \
  --exclude='var/lib/komui/deploy-home' \
  --exclude='var/lib/komui/deploy-home/**' \
  --exclude='var/lib/komui/*.lock' \
  --exclude='var/lib/komui/staging-root.backup-*' \
  --exclude='var/lib/komui/deploy-source-before-*.patch' \
  --null --files-from="$RUNTIME_PATHS_NUL"
[[ -s "$CONFIG_ARCHIVE" ]] || fail "Runtime archive is empty."

RUNTIME_INVENTORY="$TMP_DIR/runtime-inventory.json"
RUNTIME_IDENTITIES="$TMP_DIR/runtime-identities.json"
python3 - "$CONFIG_ARCHIVE" "$RUNTIME_INVENTORY" "$RUNTIME_IDENTITIES" \
  "$ACTIVATION_LINKS" "${KEY_FILE#/}" <<'PY'
import grp
import json
import pathlib
import pwd
import sys
import tarfile

archive, output, identities_output, activation_path, key_member = sys.argv[1:]
seen = set()
inventory = []
member_by_name = {}
with tarfile.open(archive, mode="r:gz") as bundle:
    for member in bundle:
        name = member.name
        path = pathlib.PurePosixPath(name)
        if not name or name.startswith("/") or ".." in path.parts:
            raise SystemExit(f"unsafe runtime archive member: {name!r}")
        if name in seen:
            raise SystemExit(f"duplicate runtime archive member: {name!r}")
        seen.add(name)
        if member.isdev() or member.isfifo():
            raise SystemExit(f"unsupported runtime archive member type: {name!r}")
        if member.isfile():
            kind = "file"
        elif member.isdir():
            kind = "directory"
        elif member.issym():
            kind = "symlink"
        elif member.islnk():
            kind = "hardlink"
        else:
            raise SystemExit(f"unsupported runtime archive member: {name!r}")
        entry = {
            "name": name,
            "type": kind,
            "mode": format(member.mode, "04o"),
            "uid": member.uid,
            "gid": member.gid,
            "size": member.size,
            "linkTarget": member.linkname or None,
        }
        inventory.append(entry)
        member_by_name[name] = entry

required = {
    "etc/nginx",
    "etc/letsencrypt",
    "etc/komui",
    "etc/postgresql",
    "opt/komui/current",
    "opt/komui/production-current",
    "var/lib/komui",
    "usr/local/sbin/komui-backup",
    "etc/systemd/system/komui-backend.service",
    "etc/systemd/system/komui-production-backend.service",
}
with open(activation_path, encoding="utf-8") as handle:
    for line in handle:
        link_path, raw_target, resolved_target = line.rstrip("\n").split("\t")
        link_member_name = link_path.lstrip("/")
        required.add(link_member_name)
        required.add(resolved_target.lstrip("/"))
        link_member = member_by_name.get(link_member_name)
        if not link_member or link_member["type"] != "symlink":
            raise SystemExit(f"activation member is not a symlink: {link_member_name}")
        if link_member["linkTarget"] != raw_target:
            raise SystemExit(
                f"activation link changed while archived: {link_member_name} "
                f"expected={raw_target!r} archived={link_member['linkTarget']!r}"
            )
missing = sorted(required - seen)
if missing:
    raise SystemExit("missing required runtime members: " + ", ".join(missing))
for forbidden in {key_member, "etc/komui/backup.key", "etc/komui/backup-encryption.key"}:
    if forbidden in seen:
        raise SystemExit(f"encryption key leaked into runtime archive: {forbidden}")

with open(output, "w", encoding="utf-8") as handle:
    json.dump({"formatVersion": 1, "members": inventory}, handle,
              ensure_ascii=False, indent=2, sort_keys=True)
    handle.write("\n")

uids = sorted({entry["uid"] for entry in inventory})
gids = sorted({entry["gid"] for entry in inventory})
users = []
groups = []
for uid in uids:
    try:
        name = pwd.getpwuid(uid).pw_name
    except KeyError:
        name = None
    users.append({"uid": uid, "name": name})
for gid in gids:
    try:
        name = grp.getgrgid(gid).gr_name
    except KeyError:
        name = None
    groups.append({"gid": gid, "name": name})
with open(identities_output, "w", encoding="utf-8") as handle:
    json.dump({"formatVersion": 1, "users": users, "groups": groups}, handle,
              ensure_ascii=False, indent=2, sort_keys=True)
    handle.write("\n")
PY

capture_activation_links "$ACTIVATION_LINKS_AFTER"
cmp -s "$ACTIVATION_LINKS" "$ACTIVATION_LINKS_AFTER" ||
  fail "Application activation links changed while runtime files were archived."

PACKAGE_VERSIONS="$TMP_DIR/package-versions.tsv"
dpkg-query -W -f='${binary:Package}\t${Version}\n' | LC_ALL=C sort > "$PACKAGE_VERSIONS"

SYSTEMD_UNITS="$TMP_DIR/systemd-units.txt"
systemctl list-unit-files --no-legend --no-pager | \
  awk '$1 ~ /^komui-/ || $1 == "xray.service" {print}' | LC_ALL=C sort > "$SYSTEMD_UNITS"

MANIFEST="$TMP_DIR/manifest.json"
python3 - \
  "$RUN_ID" "$HOST_FQDN" "$DUMP_STATS_TSV" "$DATABASE_METADATA_JSONL" "$DATABASE_OWNERS_JSON" \
  "$GLOBALS_DUMP" "$CLUSTER_SECURITY" "$CONFIG_ARCHIVE" "$RUNTIME_INVENTORY" \
  "$RUNTIME_IDENTITIES" "$RUNTIME_PATHS_TXT" "$ACTIVATION_LINKS" "$PACKAGE_VERSIONS" "$SYSTEMD_UNITS" \
  "$KEY_FILE" "$MANIFEST" <<'PY'
import csv
import hashlib
import json
import subprocess
import sys
from pathlib import Path

(
    run_id,
    host,
    stats_path,
    metadata_path,
    owners_path,
    globals_path,
    cluster_security_path,
    runtime_archive_path,
    runtime_inventory_path,
    runtime_identities_path,
    runtime_paths_path,
    activation_path,
    package_versions_path,
    systemd_units_path,
    key_file,
    output_path,
) = sys.argv[1:]

def digest(path):
    hasher = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()

metadata = [json.loads(line) for line in Path(metadata_path).read_text(encoding="utf-8").splitlines()]
metadata_by_name = {entry["name"]: entry for entry in metadata}
databases = []
with open(stats_path, newline="", encoding="utf-8") as handle:
    for row in csv.DictReader(handle, delimiter="\t"):
        database = dict(metadata_by_name[row["database"]])
        database.update({
            "dump": row["dump"],
            "dumpSha256": row["sha256"],
            "securityInventory": row["security_inventory"],
            "securityInventorySha256": row["security_sha256"],
            "toc": {
                "entries": int(row["toc_entries"]),
                "ownerCommands": int(row["owner_commands"]),
                "aclEntries": int(row["acl_entries"]),
                "defaultAclEntries": int(row["default_acl_entries"]),
                "grantRevokeCommands": int(row["grant_revoke_commands"]),
            },
        })
        databases.append(database)

activation_links = []
with open(activation_path, encoding="utf-8") as handle:
    for line in handle:
        path, target, resolved = line.rstrip("\n").split("\t")
        activation_links.append({"path": path, "target": target, "resolved": resolved})

manifest = {
    "formatVersion": 2,
    "backupId": run_id,
    "host": host,
    "createdAt": subprocess.check_output(
        ["date", "-u", "+%Y-%m-%dT%H:%M:%SZ"], text=True
    ).strip(),
    "databases": databases,
    "databaseOwnersFile": Path(owners_path).name,
    "securityInventoryQuery": "security-inventory.sql",
    "clusterSecurity": {
        "inventory": Path(cluster_security_path).name,
        "inventorySha256": digest(cluster_security_path),
        "query": "cluster-security-inventory.sql",
        "scope": {
            "databases": [entry["name"] for entry in databases],
            "fullClusterRecovery": False,
            "globalRolesAndMemberships": True,
            "settings": "global-and-scoped-databases",
        },
    },
    "postgresGlobals": {
        "file": Path(globals_path).name,
        "sha256": digest(globals_path),
        "containsPasswordVerifiers": True,
        "restorePolicy": "isolated PostgreSQL cluster only; never replay on an active cluster",
    },
    "runtime": {
        "archive": Path(runtime_archive_path).name,
        "archiveSha256": digest(runtime_archive_path),
        "inventory": Path(runtime_inventory_path).name,
        "inventorySha256": digest(runtime_inventory_path),
        "identities": Path(runtime_identities_path).name,
        "identitiesSha256": digest(runtime_identities_path),
        "paths": Path(runtime_paths_path).name,
        "pathsSha256": digest(runtime_paths_path),
        "excluded": [
            key_file.lstrip("/"),
            "etc/komui/backup.key",
            "etc/komui/backup-encryption.key",
            "var/lib/komui/deploy-home",
            "var/lib/komui/*.lock",
            "var/lib/komui/staging-root.backup-*",
            "var/lib/komui/deploy-source-before-*.patch",
        ],
    },
    "activationLinks": activation_links,
    "packageVersions": {
        "file": Path(package_versions_path).name,
        "sha256": digest(package_versions_path),
    },
    "systemdUnits": {
        "file": Path(systemd_units_path).name,
        "sha256": digest(systemd_units_path),
    },
    "capabilities": {
        "ownerMetadata": True,
        "objectPrivileges": True,
        "defaultPrivileges": True,
        "productionRuntime": True,
        "fullPostgresCluster": False,
        "externalUploadRequired": True,
        "encryptionKeyIncluded": False,
        "independentKeyEscrowVerified": False,
    },
    "tools": {
        "postgres": subprocess.check_output(
            ["runuser", "-u", "postgres", "--", "psql", "-X", "-At", "-d", databases[0]["name"], "-c", "select version()"],
            text=True,
        ).strip(),
        "pgDump": subprocess.check_output(["pg_dump", "--version"], text=True).strip(),
        "pgRestore": subprocess.check_output(["pg_restore", "--version"], text=True).strip(),
        "gpg": subprocess.check_output(["gpg", "--version"], text=True).splitlines()[0],
        "tar": subprocess.check_output(["tar", "--version"], text=True).splitlines()[0],
    },
}
Path(output_path).write_text(
    json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
    encoding="utf-8",
)
PY

payload_files=(
  "${dump_basenames[@]}"
  "${security_basenames[@]}"
  postgres-globals.sql
  database-owners.json
  database-metadata.jsonl
  database-dump-stats.tsv
  security-inventory.sql
  cluster-security-inventory.sql
  cluster-security.json
  runtime-config.tar.gz
  runtime-inventory.json
  runtime-identities.json
  runtime-paths.txt
  activation-links.tsv
  package-versions.tsv
  systemd-units.txt
  manifest.json
)

(
  cd "$TMP_DIR"
  sha256sum "${payload_files[@]}" > SHA256SUMS
)

PLAIN_ARCHIVE="$TMP_DIR/komui-backup-${RUN_ID}.tar.gz"
tar --create --gzip --file="$PLAIN_ARCHIVE" --directory="$TMP_DIR" \
  "${payload_files[@]}" SHA256SUMS
[[ -s "$PLAIN_ARCHIVE" ]] || fail "Plain backup archive is empty."

gpg --batch --yes --pinentry-mode loopback \
  --passphrase-file "$KEY_FILE" \
  --symmetric --cipher-algo AES256 \
  --output "$FINAL_ARCHIVE_PARTIAL" "$PLAIN_ARCHIVE"
[[ -s "$FINAL_ARCHIVE_PARTIAL" ]] || fail "Encrypted backup archive is empty."

# Validate that the just-produced ciphertext can be fully decrypted and that
# the decrypted payload is a valid gzip stream before publishing it by rename.
gpg --batch --quiet --pinentry-mode loopback \
  --passphrase-file "$KEY_FILE" \
  --decrypt "$FINAL_ARCHIVE_PARTIAL" | gzip -t

chmod 0600 "$FINAL_ARCHIVE_PARTIAL"
archive_sha="$(sha256sum "$FINAL_ARCHIVE_PARTIAL" | awk '{print $1}')"
printf '%s  %s\n' "$archive_sha" "$ARCHIVE_BASENAME" > "$FINAL_CHECKSUM_PARTIAL"
chmod 0600 "$FINAL_CHECKSUM_PARTIAL"

if [[ -n "$S3_PREFIX" ]]; then
  object_key="$S3_PREFIX/$ARCHIVE_BASENAME"
else
  object_key="$ARCHIVE_BASENAME"
fi
destination_archive="s3://${YANDEX_S3_BUCKET}/${object_key}"
destination_checksum="${destination_archive}.sha256"

remote_size() {
  local destination="$1"
  if [[ "$S3_TOOL" == "awscli" ]]; then
    local key="${destination#s3://${YANDEX_S3_BUCKET}/}"
    run_aws --endpoint-url "$YANDEX_S3_ENDPOINT" s3api head-object \
      --bucket "$YANDEX_S3_BUCKET" --key "$key" \
      --query ContentLength --output text
  else
    s3cmd -c "$S3CMD_CONFIG" info "$destination" |
      awk '/File size:/ {print $3}'
  fi
}

download_remote() {
  local destination="$1"
  local output="$2"
  [[ ! -e "$output" ]] || fail "Refusing to overwrite offsite verification file: $output"
  if [[ "$S3_TOOL" == "awscli" ]]; then
    run_aws --endpoint-url "$YANDEX_S3_ENDPOINT" s3 cp \
      "$destination" "$output" --only-show-errors
  else
    s3cmd -c "$S3CMD_CONFIG" --no-progress get "$destination" "$output" >/dev/null
  fi
  chmod 0600 "$output"
}

if [[ "$S3_TOOL" == "awscli" ]]; then
  run_aws --endpoint-url "$YANDEX_S3_ENDPOINT" s3 cp \
    "$FINAL_ARCHIVE_PARTIAL" "$destination_archive" --only-show-errors
else
  endpoint_host="${YANDEX_S3_ENDPOINT#https://}"
  endpoint_host="${endpoint_host%/}"
  S3CMD_CONFIG="$TMP_DIR/s3cmd.cfg"
  cat > "$S3CMD_CONFIG" <<S3CFG
[default]
access_key = ${AWS_ACCESS_KEY_ID}
secret_key = ${AWS_SECRET_ACCESS_KEY}
host_base = ${endpoint_host}
host_bucket = %(bucket)s.${endpoint_host}
use_https = True
signature_v2 = False
S3CFG
  chmod 0600 "$S3CMD_CONFIG"
  s3cmd -c "$S3CMD_CONFIG" --no-progress put \
    "$FINAL_ARCHIVE_PARTIAL" "$destination_archive" >/dev/null
fi

local_archive_size="$(stat -c %s "$FINAL_ARCHIVE_PARTIAL")"
local_checksum_size="$(stat -c %s "$FINAL_CHECKSUM_PARTIAL")"
remote_archive_size="$(remote_size "$destination_archive")"
[[ "$remote_archive_size" == "$local_archive_size" ]] ||
  fail "Uploaded archive size mismatch: local=$local_archive_size remote=$remote_archive_size"

OFFSITE_ARCHIVE="$TMP_DIR/offsite-$ARCHIVE_BASENAME"
download_remote "$destination_archive" "$OFFSITE_ARCHIVE"
offsite_archive_sha="$(sha256sum "$OFFSITE_ARCHIVE" | awk '{print $1}')"
[[ "$offsite_archive_sha" == "$archive_sha" ]] ||
  fail "Downloaded archive checksum mismatch: expected=$archive_sha actual=$offsite_archive_sha"

# The checksum object is the remote commit marker, so publish it only after an
# exact GET + SHA-256 validation of the archive object.
if [[ "$S3_TOOL" == "awscli" ]]; then
  run_aws --endpoint-url "$YANDEX_S3_ENDPOINT" s3 cp \
    "$FINAL_CHECKSUM_PARTIAL" "$destination_checksum" --only-show-errors
else
  s3cmd -c "$S3CMD_CONFIG" --no-progress put \
    "$FINAL_CHECKSUM_PARTIAL" "$destination_checksum" >/dev/null
fi

remote_checksum_size="$(remote_size "$destination_checksum")"
[[ "$remote_checksum_size" == "$local_checksum_size" ]] ||
  fail "Uploaded checksum size mismatch: local=$local_checksum_size remote=$remote_checksum_size"
OFFSITE_CHECKSUM="$TMP_DIR/offsite-${ARCHIVE_BASENAME}.sha256"
download_remote "$destination_checksum" "$OFFSITE_CHECKSUM"
cmp -s "$FINAL_CHECKSUM_PARTIAL" "$OFFSITE_CHECKSUM" ||
  fail "Downloaded checksum object differs from the local commit marker."

# Only a remotely committed and size-validated backup becomes visible to the
# local freshness check. Publish the sidecar first and the archive last, so the
# archive filename itself is the local completion marker.
mv -- "$FINAL_CHECKSUM_PARTIAL" "$FINAL_CHECKSUM"
mv -- "$FINAL_ARCHIVE_PARTIAL" "$FINAL_ARCHIVE"
chmod 0600 "$FINAL_ARCHIVE" "$FINAL_CHECKSUM"

printf 'external_upload_tool=%s\n' "$S3_TOOL"
printf 'external_upload=ok\n'
printf 'external_download_verify=ok\n'
printf 'external_destination=%s\n' "$destination_archive"
printf 'external_archive_size_bytes=%s\n' "$remote_archive_size"
printf 'external_checksum_size_bytes=%s\n' "$remote_checksum_size"

# Existing retention policy: 7 daily, 4 weekly, 6 monthly. Retention runs only
# after the external archive and checksum commit marker have passed HEAD checks.
find "$DAILY_DIR" -type f -name 'komui-backup-*.tar.gz.gpg' -mtime +7 -delete
find "$DAILY_DIR" -type f -name 'komui-backup-*.tar.gz.gpg.sha256' -mtime +7 -delete

if [[ "$(date -u +%u)" == "7" ]]; then
  cp -p "$FINAL_ARCHIVE" "$WEEKLY_DIR/"
  cp -p "$FINAL_CHECKSUM" "$WEEKLY_DIR/"
fi
find "$WEEKLY_DIR" -type f -name 'komui-backup-*.tar.gz.gpg' -mtime +35 -delete
find "$WEEKLY_DIR" -type f -name 'komui-backup-*.tar.gz.gpg.sha256' -mtime +35 -delete

if [[ "$(date -u +%d)" == "01" ]]; then
  cp -p "$FINAL_ARCHIVE" "$MONTHLY_DIR/"
  cp -p "$FINAL_CHECKSUM" "$MONTHLY_DIR/"
fi
find "$MONTHLY_DIR" -type f -name 'komui-backup-*.tar.gz.gpg' -mtime +190 -delete
find "$MONTHLY_DIR" -type f -name 'komui-backup-*.tar.gz.gpg.sha256' -mtime +190 -delete

printf 'archive=%s\n' "$FINAL_ARCHIVE"
printf 'archive_sha256=%s\n' "$archive_sha"
printf 'archive_size_bytes=%s\n' "$local_archive_size"
printf 'finished_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf 'result=ok\n'
