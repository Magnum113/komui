#!/usr/bin/env bash
set -Eeuo pipefail

LOG_FILE="${KOMUI_HEALTHCHECK_LOG:-/var/log/komui/healthcheck.log}"
DB_NAME="${KOMUI_HEALTHCHECK_DB:-komui_staging}"
PRODUCTION_DB_NAME="${KOMUI_HEALTHCHECK_PRODUCTION_DB:-komui_production}"
DISK_WARN_PERCENT="${KOMUI_HEALTHCHECK_DISK_WARN_PERCENT:-80}"
BACKUP_MAX_AGE_HOURS="${KOMUI_HEALTHCHECK_BACKUP_MAX_AGE_HOURS:-36}"
EMAIL_STALE_MINUTES="${KOMUI_HEALTHCHECK_EMAIL_STALE_MINUTES:-10}"
YANDEX_FEED_URL="${KOMUI_HEALTHCHECK_YANDEX_FEED_URL:-https://komui.ru/feeds/yandex-direct.yml}"

export YANDEX_FEED_URL

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

curl_config_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '%s' "$value"
}

staging_curl() {
  local url="$1"
  shift
  unset staging_user staging_password
  local staging_user="${STAGING_USER:-}"
  local staging_password="${STAGING_PASSWORD:-}"
  export -n staging_user staging_password
  unset STAGING_USER STAGING_PASSWORD

  [[ -n "$staging_user" && -n "$staging_password" ]] || return 2
  [[ "$staging_user" != *:* ]] || return 2
  if printf '%s%s' "$staging_user" "$staging_password" | LC_ALL=C grep -q '[[:cntrl:]]'; then
    return 2
  fi
  {
    printf 'user = "'
    curl_config_escape "${staging_user}:${staging_password}"
    printf '"\n'
  } | curl -q --config - "$@" "$url"
}

stage_root_https() {
  # shellcheck disable=SC1091
  unset STAGING_USER STAGING_PASSWORD
  if ! . /etc/komui/staging-access.env; then
    unset STAGING_USER STAGING_PASSWORD
    return 1
  fi
  local code
  if ! code="$(staging_curl https://stage.komui.ru/ -sS --max-time 8 -o /dev/null -w '%{http_code}')"; then
    unset STAGING_USER STAGING_PASSWORD
    return 1
  fi
  unset STAGING_USER STAGING_PASSWORD
  [[ "$code" == "200" ]]
}

stage_products_https() {
  # shellcheck disable=SC1091
  unset STAGING_USER STAGING_PASSWORD
  if ! . /etc/komui/staging-access.env; then
    unset STAGING_USER STAGING_PASSWORD
    return 1
  fi
  local code
  if ! code="$(staging_curl 'https://stage.komui.ru/api/v1/products?limit=1' -sS --max-time 8 -o /dev/null -w '%{http_code}')"; then
    unset STAGING_USER STAGING_PASSWORD
    return 1
  fi
  unset STAGING_USER STAGING_PASSWORD
  [[ "$code" == "200" ]]
}

no_relevant_failed_units() {
  local unit

  while read -r unit _; do
    [[ -z "$unit" ]] && continue

    # This oneshot is expected to remain in failed state while it is reporting
    # the current healthcheck failure. systemd-run also leaves failed run-u*.service
    # units behind after interrupted manual diagnostics; neither is a production
    # service failure.
    [[ "$unit" == "komui-healthcheck.service" ]] && continue
    [[ "$unit" =~ ^run-u[0-9]+\.service$ ]] && continue

    return 1
  done < <(
    systemctl list-units \
      --state=failed \
      --type=service \
      --no-legend \
      --no-pager \
      --plain
  )

  return 0
}

email_worker_flag() {
  local ready_url="$1"
  local require_allowlist="${2:-0}"
  curl -fsS --max-time 5 "$ready_url" | python3 -c '
import json
import sys

config = json.load(sys.stdin).get("config", {})
require_allowlist = sys.argv[1] == "1"
worker_enabled = config.get("emailWorkerEnabled") is True
if worker_enabled and (
    config.get("emailEnabled") is not True
    or config.get("emailConfigured") is not True
):
    raise SystemExit(2)
if worker_enabled and require_allowlist:
    if config.get("emailTestMode") is not True:
        raise SystemExit(3)
    if config.get("emailAllowlistConfigured") is not True:
        raise SystemExit(4)
print("1" if worker_enabled else "0")
' "$require_allowlist"
}

email_workers_active() {
  local ready_url unit require_allowlist enabled

  while read -r ready_url unit require_allowlist; do
    enabled="$(email_worker_flag "$ready_url" "$require_allowlist")" || return 1
    if [[ "$enabled" == "1" ]]; then
      systemctl is-active --quiet "$unit" || return 1
    fi
  done <<'TARGETS'
http://127.0.0.1:3000/health/ready komui-email-worker 1
http://127.0.0.1:3001/health/ready komui-production-email-worker 0
TARGETS
}

email_queue_is_healthy() {
  local ready_url="$1"
  local database="$2"
  local require_allowlist="${3:-0}"
  local enabled exists count

  [[ "$EMAIL_STALE_MINUTES" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ "$database" =~ ^[A-Za-z0-9_]+$ ]] || return 1
  enabled="$(email_worker_flag "$ready_url" "$require_allowlist")" || return 1
  [[ "$enabled" == "1" ]] || return 0

  exists="$(
    runuser -u postgres -- psql -X -At -d "$database" \
      -c "select to_regclass('public.merch_email_outbox') is not null"
  )" || return 1
  [[ "$exists" == "t" ]] || return 1

  count="$(
    runuser -u postgres -- psql -X -At -d "$database" -c "
      select count(*)
      from public.merch_email_outbox
      where status = 'failed'
         or (
           status in ('pending', 'retry')
           and coalesce(next_attempt_at, scheduled_at) <=
             now() - interval '$EMAIL_STALE_MINUTES minutes'
         )
         or (
           status = 'processing'
           and coalesce(locked_at, updated_at, created_at) <=
             now() - interval '$EMAIL_STALE_MINUTES minutes'
         )
    "
  )" || return 1
  [[ "${count:-}" =~ ^[0-9]+$ ]] || return 1
  [[ "$count" -eq 0 ]]
}

email_queues_healthy() {
  email_queue_is_healthy http://127.0.0.1:3000/health/ready "$DB_NAME" 1 &&
    email_queue_is_healthy http://127.0.0.1:3001/health/ready "$PRODUCTION_DB_NAME" 0
}

check postgresql_active systemctl is-active --quiet postgresql
check nginx_active systemctl is-active --quiet nginx
check backend_active systemctl is-active --quiet komui-backend
check production_backend_active systemctl is-active --quiet komui-production-backend
check backup_timer_active systemctl is-active --quiet komui-backup.timer
check order_monitor_timer_active systemctl is-active --quiet komui-order-monitor.timer

check backend_ready curl -fsS --max-time 5 http://127.0.0.1:3000/health/ready -o /dev/null
check production_backend_ready curl -fsS --max-time 5 http://127.0.0.1:3001/health/ready -o /dev/null
check email_worker_active email_workers_active
check email_failed_or_stale_jobs email_queues_healthy
check tbank_ca_readable runuser -u komui -- test -r /etc/komui/certs/komui-node-ca-bundle.pem

check stage_root_https stage_root_https
check stage_products_https stage_products_https

check production_yandex_feed bash -c '
  set -euo pipefail
  feed_file=$(mktemp)
  headers_file=$(mktemp)
  stats_file=$(mktemp)
  trap '\''rm -f "$feed_file" "$headers_file" "$stats_file"'\'' EXIT

  code=$(curl -sS --max-time 15 -D "$headers_file" -o "$feed_file" -w "%{http_code}" "$YANDEX_FEED_URL")
  test "$code" = "200"
  grep -Eiq '\''^content-type:[[:space:]]*application/xml([;[:space:]]|$)'\'' "$headers_file"
  curl -fsS --max-time 8 http://127.0.0.1:3001/v1/catalog/stats -o "$stats_file"

  python3 - "$feed_file" "$stats_file" <<'\''PY'\''
import json
import sys
import xml.etree.ElementTree as ET

feed_path, stats_path = sys.argv[1:]
root = ET.parse(feed_path).getroot()
if root.tag != "yml_catalog":
    raise SystemExit("unexpected feed root")

offers = root.findall("./shop/offers/offer")
if not offers:
    raise SystemExit("feed has no offers")
ids = [offer.get("id", "") for offer in offers]
if any(not offer_id for offer_id in ids) or len(ids) != len(set(ids)):
    raise SystemExit("feed contains missing or duplicate offer IDs")
if any(offer.get("available") != "true" for offer in offers):
    raise SystemExit("feed contains an unavailable offer")

with open(stats_path, encoding="utf-8") as source:
    active_products = int(json.load(source).get("activeProducts", 0))
if len(offers) != active_products:
    raise SystemExit(
        f"feed offer count {len(offers)} differs from active products {active_products}"
    )

with open(feed_path, encoding="utf-8") as source:
    if "ir.ozone.ru" in source.read().lower():
        raise SystemExit("feed contains an external Ozon URL")
PY
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

check no_failed_units no_relevant_failed_units

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
