#!/usr/bin/env bash
set -euo pipefail

mode="${1:-}"
reason="${2:-manual}"

if [[ "$mode" != "server" && "$mode" != "legacy" ]]; then
  echo "Usage: sudo /usr/local/sbin/komui-traffic-switch server|legacy [reason]" >&2
  exit 2
fi

state_dir="${KOMUI_TRAFFIC_SWITCH_STATE_DIR:-/var/lib/komui/traffic-switch}"
mkdir -p "$state_dir"

python3 - "$state_dir/request.json" "$mode" "$reason" <<'PY'
import json
import os
import sys
import uuid
from datetime import datetime, timezone

path, mode, reason = sys.argv[1:]
payload = {
    "requestId": str(uuid.uuid4()),
    "mode": mode,
    "target": "production",
    "requestedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    "reason": reason,
    "requestedBy": "manual-cli",
}
tmp = f"{path}.{os.getpid()}.tmp"
with open(tmp, "w") as f:
    json.dump(payload, f, ensure_ascii=False, indent=2)
    f.write("\n")
os.replace(tmp, path)
os.chmod(path, 0o640)
print(payload["requestId"])
PY

/usr/local/sbin/komui-traffic-switch-apply
cat "$state_dir/status.json"
