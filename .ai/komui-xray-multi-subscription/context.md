# Context

## Initial state before multi-provider work

- Production Xray is managed by
  `ops/server/komui-xray-subscription-update` and a 15-minute systemd timer.
- The current provider has 29 profiles but none presently passes the network
  canary from the production VPS.
- The updater currently accepts one URL/HWID pair and prioritizes the last
  successful profile inside that subscription.
- The current active configuration is retained when every candidate fails.
- A second provider is a separate failure domain with its own URL, refresh
  metadata, last-success state, and bounded candidate list. The same stable
  server HWID is intentionally reused because both providers see the same
  physical client and the secondary accepts it.
- The secondary returns `text/plain`: a Base64-encoded list containing exactly
  three VLESS/REALITY URIs using gRPC, XHTTP, and TCP.
- Xray 26.2.6 could parse these configs but its REALITY handshake was rejected;
  the latest official stable release, 26.3.27, passes XHTTP/TCP canaries.
