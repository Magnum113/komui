# Review

## Review result

Implementation logic and deployment are complete. No unresolved code defect was found in the changed scripts.

## Findings addressed

1. **Order cursor race** — A pure timestamp cursor could miss a transaction committed after the monitor snapshot with an earlier `created_at`. Fixed with a two-minute overlap and durable `notifiedOrderIds` deduplication.
2. **Duplicate partial sends** — New orders and simultaneous incidents are sent as one alert before state advances, avoiding partial-progress duplication.
3. **Telegram chat clutter** — Inline navigation edits one message and only falls back to a new message when editing is unavailable.
4. **Accidental destructive actions** — Production deploy, admin deploy, and admin rollback retain explicit confirmation.
5. **Personal-data exposure** — Notifications exclude name/email/full phone and expose only the last four phone digits.
6. **Unsafe alert actions** — The generic alert script accepts only HTTPS action URLs and JSON-encodes URL/button text.
7. **Excessive query load** — The new query uses the indexed order timestamp and a two-minute overlap; one local query per minute is proportionate for the current order volume.

## Telegram transport history

The original production Telegram transport could not be verified end-to-end
because every then-configured Xray VLESS/REALITY upstream failed Telegram TLS.
The same failure was visible in bot logs from before this implementation.

The implementation failed safely while blocked:

- the bot remains active and retries Telegram initialization;
- no artificial order or test alert was sent;
- new-order state advances only after successful Telegram delivery;
- order monitoring continues once per minute.

## Supplied VPN candidate check (2026-08-21)

The user supplied a replacement Xray JSON configuration. It passed `xray run
-test` on the production server and could start on isolated localhost ports.
However, Telegram `getMe` timed out through its balancer, and isolated probes of
all four supplied VLESS/REALITY outbounds failed with TLS connect error 35. The
candidate was therefore not installed and production Xray was not restarted.

An exhaustive retry later the same day tested the current production config,
the saved server backup, and the supplied config. Each complete config received
two Telegram attempts, followed by two isolated attempts for every VLESS
outbound (nine nodes total). Complete configs timed out or failed TLS; every
individual node failed both attempts with curl TLS error 35. Only the original
production Xray process remained afterward, and the uploaded candidate was
deleted from `/tmp`.

The same exhaustive matrix was repeated on 2026-08-23: three attempts for each
complete config and two attempts for every individual VLESS outbound. Results
were unchanged—balancers timed out or failed TLS, and all nine individual nodes
returned TLS error 35. Production Xray remained untouched.

## Resolution (2026-08-23)

A second user-supplied configuration differed from the first and passed both
the Xray validator and isolated Telegram tests. Its `nlch` node worked; the
other three nodes still failed, but the configured observatory/balancer selected
the healthy route.

The new config was deployed with a timestamped rollback copy of the former
production config. After correcting read permissions for the existing
`User=nobody` service (`root:nogroup 0640`), Xray started successfully.
Production verification passed 10/10 `getMe` requests. Komui Alert updated its
eight commands and entered the `getUpdates` long-poll loop. The external blocker
is resolved.
