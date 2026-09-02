# Review

## Verification completed

- `python3 -m py_compile ops/server/komui-xray-subscription-update`
- `python3 -m unittest discover -s ops/server/tests -p 'test_*.py' -v`
  passed all 48 tests after the final parser, resource-limit, DNS-pinning, and
  credential-path hardening.
- `git diff --check` passed.
- Remote `systemd-analyze verify` passed for the new units; its only warning
  concerned the pre-existing Xray unit using the special `nobody` account.
- A full remote service cycle selected final safe profile 24 and passed both
  isolated and production probes.
- A later timer-triggered run completed successfully and scheduled the next
  check.
- Telegram root endpoint returned HTTP 302 through SOCKS, bot `getMe` returned
  `ok=true`, `xray.service` remained active, and `komui-deploy-bot.service` was
  active after restart.
- `komui-order-monitor` logged `Order monitor alert sent`; the corresponding
  production order ID is recorded in the durable notified set.

## Operational notes

- A new provider response that contains no safe, reachable profile leaves the
  current production Xray config untouched.
- Five prior config backups are retained for rollback.
- Subscription responses are capped at 5 MiB during transfer, and canary Xray
  processes run as `nobody:nogroup` without inherited supplementary groups.
- XHTTP, TLS, and REALITY fields are rebuilt from nested allowlists;
  `downloadSettings`, socket controls, key-log paths, server keys, private
  endpoints, and plaintext VLESS/Trojan candidates are rejected.
- XHTTP/xmux allocation and concurrency values are bounded, and any hostname
  endpoint is pinned to the globally routable IP that passed validation.
- A remote audit found zero forbidden keys in the active config and confirmed
  that neither the subscription URL nor HWID appears in the updater journal.
- The timer checks every 15 minutes, while actual subscription downloads obey
  `profile-update-interval` (currently two hours) unless proxy health fails.
