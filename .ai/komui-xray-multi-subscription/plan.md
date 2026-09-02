# Plan

1. Read the secondary URL from the local root-owned secret without logging it.
2. Fetch only into a protected temporary directory and identify its content
   type and bounded response shape.
3. Extend the updater with an ordered provider list and per-provider state,
   while preserving the existing single-provider credential layout during
   migration.
4. When the active proxy is unhealthy, test the last-known-good candidate for
   each provider first, then the remaining bounded candidates.
5. Activate only a candidate that passes isolated Cloudflare and Telegram
   probes; roll back on any post-switch failure.
6. Add tests for provider ordering, failover, failback hysteresis, malformed
   secondary responses, secret isolation, and state migration.
7. Deploy credentials and units, force one full safe scan, and verify bot API
   connectivity without exposing secrets.

## Status

All seven steps are complete. The primary provider is healthy and remains
active; the secondary provider is installed and its XHTTP/TCP candidates were
validated as failover paths under the production systemd sandbox.
