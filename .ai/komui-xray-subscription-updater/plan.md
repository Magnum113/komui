# Plan

1. Implement a root-only updater that fetches the subscription with a stable
   server HWID and v2RayTun-compatible request headers.
2. Validate response shape, force safe loopback inbounds, and test the Xray
   candidate syntactically.
3. Run a canary Xray on alternate ports and require successful Cloudflare and
   Telegram probes.
4. Back up the production config, atomically install the candidate, restart
   Xray, and require successful production proxy probes.
5. Roll back automatically on any failure and leave the prior config active.
6. Install a hardened systemd oneshot and a 15-minute health timer that honors
   the provider's two-hour subscription refresh interval.
7. Verify the updater, Xray, Telegram bot transport, and pending order monitor
   delivery; document results and review findings.
