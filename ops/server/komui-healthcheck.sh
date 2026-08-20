#!/usr/bin/env bash
set -Eeuo pipefail

LOG_FILE="${KOMUI_HEALTHCHECK_LOG:-/var/log/komui/healthcheck.log}"
DB_NAME="${KOMUI_HEALTHCHECK_DB:-komui_staging}"
DISK_WARN_PERCENT="${KOMUI_HEALTHCHECK_DISK_WARN_PERCENT:-80}"
BACKUP_MAX_AGE_HOURS="${KOMUI_HEALTHCHECK_BACKUP_MAX_AGE_HOURS:-36}"
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

check postgresql_active systemctl is-active --quiet postgresql
check nginx_active systemctl is-active --quiet nginx
check backend_active systemctl is-active --quiet komui-backend
check production_backend_active systemctl is-active --quiet komui-production-backend
check backup_timer_active systemctl is-active --quiet komui-backup.timer
check order_monitor_timer_active systemctl is-active --quiet komui-order-monitor.timer

check backend_ready curl -fsS --max-time 5 http://127.0.0.1:3000/health/ready -o /dev/null
check production_backend_ready curl -fsS --max-time 5 http://127.0.0.1:3001/health/ready -o /dev/null
check tbank_ca_readable runuser -u komui -- test -r /etc/komui/certs/komui-node-ca-bundle.pem

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
