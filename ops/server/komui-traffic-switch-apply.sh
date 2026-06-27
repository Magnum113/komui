#!/usr/bin/env bash
set -euo pipefail

STATE_DIR="${KOMUI_TRAFFIC_SWITCH_STATE_DIR:-/var/lib/komui/traffic-switch}"
REQUEST_PATH="$STATE_DIR/request.json"
STATUS_PATH="$STATE_DIR/status.json"
LOCK_PATH="/run/komui-traffic-switch.lock"
RUNTIME_SNIPPET="/etc/nginx/snippets/komui-production-runtime.conf"
PRODUCTION_SITE_LINK="/etc/nginx/sites-enabled/komui-production-switch"
CONFIG_PATH="/etc/komui/traffic-switch.env"

write_status() {
  local state="$1"
  local mode="$2"
  local message="$3"
  local nginx_test="${4:-skipped}"
  local error="${5:-}"

  python3 - "$REQUEST_PATH" "$STATUS_PATH" "$state" "$mode" "$message" "$nginx_test" "$error" "$PRODUCTION_SITE_LINK" "$CONFIG_PATH" <<'PY'
import json
import os
import shlex
import sys
from datetime import datetime, timezone

request_path, status_path, state, mode, message, nginx_test, error, site_link, config_path = sys.argv[1:]
try:
    request = json.load(open(request_path))
except Exception:
    request = {}

legacy_origin_configured = False
if os.path.exists(config_path):
    for raw in open(config_path):
        if raw.strip().startswith("LEGACY_ORIGIN="):
            value = raw.split("=", 1)[1].strip().strip('"').strip("'")
            legacy_origin_configured = bool(value)

payload = {
    "requestId": request.get("requestId"),
    "state": state,
    "mode": mode or request.get("mode"),
    "target": request.get("target", "production"),
    "message": message,
    "productionVhostEnabled": os.path.islink(site_link) or os.path.exists(site_link),
    "nginxTest": nginx_test,
    "legacyOriginConfigured": legacy_origin_configured,
    "updatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
}
if state in ("applied", "prepared"):
    payload["appliedAt"] = payload["updatedAt"]
if error:
    payload["error"] = error

tmp = f"{status_path}.{os.getpid()}.tmp"
with open(tmp, "w") as f:
    json.dump(payload, f, ensure_ascii=False, indent=2)
    f.write("\n")
os.replace(tmp, status_path)
os.chmod(status_path, 0o640)
PY

  chgrp komui "$STATUS_PATH" 2>/dev/null || true
}

read_request_field() {
  local field="$1"
  python3 - "$REQUEST_PATH" "$field" <<'PY'
import json
import sys
path, field = sys.argv[1:]
with open(path) as f:
    data = json.load(f)
value = data.get(field, "")
if value is None:
    value = ""
print(value)
PY
}

legacy_origin_from_config() {
  if [[ ! -f "$CONFIG_PATH" ]]; then
    return 1
  fi
  python3 - "$CONFIG_PATH" <<'PY'
import sys
path = sys.argv[1]
for raw in open(path):
    line = raw.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    key, value = line.split("=", 1)
    if key.strip() == "LEGACY_ORIGIN":
        print(value.strip().strip('"').strip("'"))
        raise SystemExit(0)
raise SystemExit(1)
PY
}

legacy_host() {
  python3 - "$1" <<'PY'
from urllib.parse import urlparse
import sys
parsed = urlparse(sys.argv[1])
if parsed.scheme not in ("http", "https") or not parsed.netloc:
    raise SystemExit(1)
print(parsed.netloc)
PY
}

legacy_origin_reachable() {
  local origin="$1"
  curl -fsSIL --max-time 8 "$origin" >/dev/null
}

write_server_snippet() {
  install -o root -g root -m 0644 /dev/stdin "$RUNTIME_SNIPPET" <<'NGINX'
root /var/lib/komui/staging-root;
index index.html;

auth_basic off;
client_max_body_size 2m;
server_tokens off;

add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header X-Frame-Options "SAMEORIGIN" always;

location ^~ /.well-known/acme-challenge/ {
    root /var/lib/komui/acme;
    default_type text/plain;
}

location /api/ {
    proxy_pass http://127.0.0.1:3000/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_connect_timeout 3s;
    proxy_read_timeout 30s;
    proxy_send_timeout 30s;
}

location / {
    try_files $uri $uri.html $uri/ /index.html;
}
NGINX
}

write_legacy_snippet() {
  local origin="$1"
  local host="$2"
  python3 - "$origin" "$host" "$RUNTIME_SNIPPET" <<'PY'
import sys
origin, host, path = sys.argv[1:]
content = f'''resolver 1.1.1.1 8.8.8.8 valid=300s ipv6=off;
set $komui_legacy_origin "{origin}";

client_max_body_size 2m;
server_tokens off;

location ^~ /.well-known/acme-challenge/ {{
    root /var/lib/komui/acme;
    default_type text/plain;
}}

location / {{
    proxy_pass $komui_legacy_origin;
    proxy_http_version 1.1;
    proxy_ssl_server_name on;
    proxy_ssl_name {host};
    proxy_set_header Host {host};
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_connect_timeout 5s;
    proxy_read_timeout 30s;
    proxy_send_timeout 30s;
}}
'''
with open(path, "w") as f:
    f.write(content)
PY
  chown root:root "$RUNTIME_SNIPPET"
  chmod 0644 "$RUNTIME_SNIPPET"
}

main() {
  mkdir -p "$STATE_DIR" /etc/nginx/snippets
  if [[ ! -f "$REQUEST_PATH" ]]; then
    write_status "rejected" "" "No traffic switch request file found" "skipped" "missing_request"
    return 0
  fi

  local mode target
  mode="$(read_request_field mode)"
  target="$(read_request_field target)"

  if [[ "$target" != "production" ]]; then
    write_status "rejected" "$mode" "Only production target is supported" "skipped" "unsupported_target"
    return 0
  fi

  case "$mode" in
    server)
      write_server_snippet
      ;;
    legacy)
      local origin host
      origin="$(legacy_origin_from_config || true)"
      if [[ -z "$origin" ]]; then
        write_status "rejected" "$mode" "LEGACY_ORIGIN is not configured in /etc/komui/traffic-switch.env" "skipped" "legacy_origin_not_configured"
        return 0
      fi
      host="$(legacy_host "$origin" || true)"
      if [[ -z "$host" ]]; then
        write_status "rejected" "$mode" "LEGACY_ORIGIN must be a valid http(s) URL" "skipped" "invalid_legacy_origin"
        return 0
      fi
      if ! legacy_origin_reachable "$origin"; then
        write_status "rejected" "$mode" "LEGACY_ORIGIN is configured but unreachable from this server" "skipped" "legacy_origin_unreachable"
        return 0
      fi
      write_legacy_snippet "$origin" "$host"
      ;;
    *)
      write_status "rejected" "$mode" "Mode must be server or legacy" "skipped" "invalid_mode"
      return 0
      ;;
  esac

  if ! nginx -t >/tmp/komui-traffic-switch-nginx-test.log 2>&1; then
    local err
    err="$(tail -n 20 /tmp/komui-traffic-switch-nginx-test.log | tr '\n' ' ' | cut -c1-500)"
    write_status "failed" "$mode" "nginx -t failed; traffic was not switched" "failed" "$err"
    return 0
  fi

  if [[ -e "$PRODUCTION_SITE_LINK" ]]; then
    systemctl reload nginx
    write_status "applied" "$mode" "Production Nginx runtime switched to $mode" "passed"
  else
    write_status "prepared" "$mode" "Runtime snippet prepared, but production vhost is not enabled yet" "passed"
  fi
}

(
  flock -n 9 || exit 0
  main
) 9>"$LOCK_PATH"
