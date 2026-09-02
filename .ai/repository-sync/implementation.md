# Implementation

## Git consolidation and history

- Refreshed the remote refs and created `codex/repository-sync` from the exact
  then-current `origin/main` revision `10da49f`.
- Cherry-picked the PostgreSQL evidence in its original order. The resulting
  local commits are `f81caf1` (from `e10f2ae`) and `e8c3d3c` (from `fef444d`).
  The already-pushed historical feature branch was not rewritten.

## Xray source of truth

- Added the production updater, systemd service/timer, full regression test,
  two sets of task evidence, and secret-safe diagnostic helpers to source
  control scope.
- Removed the provider hostname, absolute Mac secret paths, and a production
  order number from the unpublished task evidence. No credential value was
  present in the files.
- Fixed bounded failover availability edges found during the pre-commit
  review. Three slots are reserved for the alternate provider even if the
  proxy starts the refresh healthy; unused slots are reclaimed by deferred
  candidates from the active provider. The rule is symmetric for primary and
  secondary while preserving the 32-profile cap, preferred ordering, global
  deadline, canary validation, atomic activation, and rollback behavior.

## Operational command hardening

- Made `komui-deploy-status` tolerate an unavailable GitHub lookup by using
  the exact local tracking ref as an explicitly labelled cached fallback, and
  updated its service inventory to the current application/control-plane
  units.
- Reproduced a server-only Git protocol v2 failure against the public GitHub
  remote. The same unauthenticated request succeeds with protocol v0/v1, so
  status, clone, and fetch now pin protocol v1; stage and production
  compatibility-only runs both fetched the exact current `main` successfully.
- Removed staging Basic Auth credentials from `curl` process arguments in the
  status, deploy, healthcheck, and manual release-activation scripts. The
  credentials are validated, escaped, sent through a `curl --config -` stdin
  stream, and unset on success or failure.
- Added contract coverage for all four scripts and an executable fake-curl
  regression proving the sample credential reaches curl through stdin only,
  not argv or the child environment.

## Canonical documentation

- Updated the root README/overview and migration, cutover, monitoring, email,
  backend, admin, and legacy Supabase documentation to separate current state
  from dated migration evidence.
- Added `docs/server-migration/XRAY_SUBSCRIPTION_UPDATER.md` as the durable
  operational runbook. Historical `.ai` and phase reports were not rewritten
  except for sanitizing the previously untracked Xray evidence and recording
  the source-review hardening above.

## Local validation

- Focused Xray suite: 56/56 passed.
- Full `ops/server/tests` suite: 110/110 passed.
- Full backend suite: 288/288 passed.
- TypeScript build passed.
- Yandex Metrika suite passed.
- Python compile checks for the updater and secret-safe diagnostic helpers
  passed.
- Secret-signature and Xray evidence hygiene scans passed.
- Markdown links/fences, route references, and `git diff --check` passed.
