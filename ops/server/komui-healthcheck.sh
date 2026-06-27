#!/usr/bin/env bash
set -Eeuo pipefail

LOG_FILE="${KOMUI_HEALTHCHECK_LOG:-/var/log/komui/healthcheck.log}"
DB_NAME="${KOMUI_HEALTHCHECK_DB:-komui_staging}"
DISK_WARN_PERCENT="${KOMUI_HEALTHCHECK_DISK_WARN_PERCENT:-80}"
BACKUP_MAX_AGE_HOURS="${KOMUI_HEALTHCHECK_BACKUP_MAX_AGE_HOURS:-36}"

mkdir -p "$(dirname "$LOG_FILE")"

timestamp() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

failures=()

check() {
  local name="$1"
  shift
  if "$@"; then
    echo "$(timestamp) OK $name"
  else
    local status=$?
    echo "$(timestamp) FAIL $name status=$status"
    failures+=("$name")
  fi
}

check postgresql_active systemctl is-active --quiet postgresql
check nginx_active systemctl is-active --quiet nginx
check backend_active systemctl is-active --quiet komui-backend
check backup_timer_active systemctl is-active --quiet komui-backup.timer

check backend_ready curl -fsS --max-time 5 http://127.0.0.1:3000/health/ready -o /dev/null

check stage_root_https bash -c '
  set -euo pipefail
  . /etc/komui/staging-access.env
  code=$(curl -sS --max-time 8 -o /dev/null -w "%{http_code}" -u "$STAGING_USER:$STAGING_PASSWORD" https://stage.komui.ru/)
  test "$code" = "200"
'

check stage_products_https bash -c '
  set -euo pipefail
  . /etc/komui/staging-access.env
  code=$(curl -sS --max-time 8 -o /dev/null -w "%{http_code}" -u "$STAGING_USER:$STAGING_PASSWORD" "https://stage.komui.ru/api/v1/products?limit=1")
  test "$code" = "200"
'

check disk_under_threshold bash -c '
  set -euo pipefail
  used=$(df -P / | awk "NR==2{gsub(/%/,\"\",\$5); print \$5}")
  test "$used" -lt "'"$DISK_WARN_PERCENT"'"
'

check memory_available bash -c '
  set -euo pipefail
  available_mb=$(free -m | awk "/Mem:/{print \$7}")
  test "$available_mb" -ge 256
'

check backup_fresh bash -c '
  set -euo pipefail
  latest=$(find /var/backups/komui/daily -type f -name "komui-backup-*.tar.gz.gpg" -printf "%T@ %p\n" 2>/dev/null | sort -n | tail -1 | awk "{print \$2}")
  test -n "$latest"
  now=$(date +%s)
  modified=$(stat -c %Y "$latest")
  age_hours=$(( (now - modified) / 3600 ))
  test "$age_hours" -le "'"$BACKUP_MAX_AGE_HOURS"'"
'

check no_failed_units bash -c '
  set -euo pipefail
  test "$(systemctl --failed --no-legend | wc -l)" -eq 0
'

check no_stale_pending_payments bash -c '
  set -euo pipefail
  exists=$(runuser -u postgres -- psql -X -At -d "'"$DB_NAME"'" -c "select to_regclass('"'public.merch_checkout_payments'"') is not null")
  if [ "$exists" != "t" ]; then exit 0; fi
  count=$(runuser -u postgres -- psql -X -At -d "'"$DB_NAME"'" -c "select count(*) from public.merch_checkout_payments where status = '"'pending_payment'"' and created_at < now() - interval '"'2 hours'"'")
  test "${count:-0}" -eq 0
'

if ((${#failures[@]})); then
  echo "$(timestamp) SUMMARY FAIL failures=${failures[*]}" | tee -a "$LOG_FILE"
  logger -t komui-healthcheck "FAIL failures=${failures[*]}"
  if command -v /usr/local/sbin/komui-alert >/dev/null 2>&1; then
    /usr/local/sbin/komui-alert "KOMUI healthcheck failed" "failures=${failures[*]}" || true
  fi
  exit 1
fi

echo "$(timestamp) SUMMARY OK" | tee -a "$LOG_FILE"
logger -t komui-healthcheck "OK"
