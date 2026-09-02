# Inputs

## Goal

Install a production-safe Xray subscription updater for the KOMUI server so
Telegram traffic can use a VPN configuration that refreshes from the same URL
used by v2RayTun.

## Constraints

- Subscription URL is stored outside the repository in a local secret file
  with mode `0600`.
- Never print or commit the URL, node credentials, UUIDs, subscription PIN, or
  full downloaded configuration.
- Keep the Xray proxy bound to loopback (`127.0.0.1:10808` SOCKS and `10809`
  HTTP); do not route the whole server through the VPN.
- Validate a candidate and probe Telegram through an isolated canary before
  touching the production Xray configuration.
- Preserve and automatically restore the last-known-good configuration on any
  validation, restart, or post-switch probe failure.
- The subscription advertises a two-hour refresh interval and HWID device
  limiting.

## Current incident

The order monitor was retrying a production order; its durable cursor had not
advanced because Telegram delivery through the old Xray configuration timed
out.
