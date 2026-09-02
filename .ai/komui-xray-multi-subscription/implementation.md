# Implementation

- Added a strict bounded parser for Base64 VLESS/REALITY URI subscriptions.
  Only the observed TCP, gRPC, and XHTTP shapes are accepted; duplicates,
  unknown fields, unsafe endpoints, malformed encoding, and mismatched XHTTP
  duplicate settings are rejected.
- Added primary/secondary provider isolation, a combined profile budget with
  three slots reserved for the secondary, provider-specific preferred profile
  fingerprints and refresh intervals, and sticky healthy-provider behavior.
- Migrated updater state in memory from v1 to v2. Activation writes v2 only
  after syntax, isolated Cloudflare/Telegram, and production probes pass.
- Made rollback config/state atomic through a pending marker that contains the
  previous state backup. A safely rejected production candidate is rolled back
  and the outage scan continues.
- Added explicit `0750 root:nogroup` provider directories so canary Xray
  processes can read configs despite the updater's `0077` umask.
- Installed the secondary URL through a systemd credential and retained the
  existing stable HWID for both subscription providers.
- Upgraded `/usr/local/bin/xray` from 26.2.6 to the official stable 26.3.27
  after SHA-256 verification and isolated canary testing. The old binary and
  pre-change config/state/unit/updater are retained in a root-only deployment
  backup.
- The production scan activated primary profile 1. Secondary XHTTP and TCP
  were independently verified under the same systemd sandbox and remain ready
  for a primary outage.

## Repository-sync hardening

During the 2 September source-of-truth review, the bounded scanner was updated
to reserve capacity for whichever alternate provider has not yet been scanned
and to reclaim unused capacity for deferred candidates from the first
provider. The rule is symmetric during healthy primary and secondary refreshes,
so a proxy that becomes unhealthy mid-run can still fail over without exceeding
the existing 32-profile limit or global deadline.
