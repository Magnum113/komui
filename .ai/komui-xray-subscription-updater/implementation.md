# Implementation

## Repository files

- `ops/server/komui-xray-subscription-update`: root-only updater with HTTPS
  fetch, stable HWID headers, bounded JSON parsing, outbound sanitization,
  isolated Xray canary tests, atomic activation, and rollback.
- `ops/server/komui-xray-subscription-update.service`: systemd oneshot with
  credential loading and filesystem/kernel hardening.
- `ops/server/komui-xray-subscription-update.timer`: persistent 15-minute
  health and refresh timer.
- `ops/server/tests/test_komui_xray_subscription_update.py`: parsing, safety,
  loopback, state, and candidate-order tests.

## Installed server state

- Subscription URL: `/etc/komui-xray/subscription.url`, `0600 root:root`.
- Stable HWID: `/etc/komui-xray/subscription.hwid`, `0600 root:root`.
- Updater: `/usr/local/sbin/komui-xray-subscription-update`.
- Units: `/etc/systemd/system/komui-xray-subscription-update.{service,timer}`.
- State and last-known-good data: `/var/lib/komui/xray-subscription`.
- Production Xray config remains `0640 root:nogroup` and inbounds remain bound
  only to `127.0.0.1`.

## Runtime behavior

1. A timer run first checks the existing SOCKS proxy.
2. If refresh is due or the proxy is unhealthy, it fetches the subscription
   without exposing the URL or HWID in process arguments.
3. It ignores provider inbounds/routing and constructs fixed loopback inbounds.
4. It tries the previously successful provider profile first.
5. A temporary Xray running as `nobody` must pass syntax, Cloudflare, and
   Telegram probes, with supplementary groups cleared.
6. The live config is atomically replaced and probed again after restart.
7. Any activation failure restores the exact prior config and restarts Xray.

The download is capped at 5 MiB by curl before the body is fully written. The
service has a 40-minute hard timeout so even a worst-case bounded scan of 32
slow-failing profiles can complete; normal runs use the previously successful
profile first and complete in seconds.

XHTTP and xmux numeric ranges are bounded before the canary starts. Hostname
endpoints must resolve exclusively to public addresses and are replaced with a
validated literal IP while the original hostname is retained for SNI and the
transport Host/authority field, preventing a DNS rebind between validation and
Xray startup.
