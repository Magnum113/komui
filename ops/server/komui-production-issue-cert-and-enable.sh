#!/usr/bin/env bash
set -Eeuo pipefail

server_ip="${KOMUI_PRODUCTION_SERVER_IP:-89.111.152.112}"
http_site="/etc/nginx/sites-enabled/komui-production-http-precutover"
tls_site="/etc/nginx/sites-enabled/komui-production-switch"

require_dns() {
  local name="$1"
  if ! getent ahostsv4 "$name" | awk '{print $1}' | grep -qx "$server_ip"; then
    echo "DNS for $name does not resolve to $server_ip yet. Do not issue certificate." >&2
    return 1
  fi
}

require_dns komui.ru
require_dns www.komui.ru

install -d -m 0755 /var/lib/komui/acme
certbot certonly --webroot -w /var/lib/komui/acme \
  -d komui.ru -d www.komui.ru \
  --non-interactive --agree-tos --keep-until-expiring

rm -f "$http_site"
ln -sfn /etc/nginx/sites-available/komui-production-switch "$tls_site"
nginx -t
systemctl reload nginx
curl -fsS --resolve komui.ru:443:127.0.0.1 https://komui.ru/api/v1/products?limit=1 >/dev/null
printf 'KOMUI production TLS enabled for komui.ru/www.komui.ru\n'
