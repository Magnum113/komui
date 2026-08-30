# Staging payment-consistency release — inputs

## User request

Proceed to the next step after the first three P1 payment/fulfillment fixes were
implemented and tested locally: form a release, deploy it to staging, verify it,
and leave production unchanged.

## Scope

- Build and deploy only the staging backend/frontend and staging PostgreSQL
  schema required by `20260830143000_harden_payment_consistency.sql`.
- Use an immutable release from a dedicated `codex/` branch.
- Run a fresh encrypted backup and a closed-write migration window.
- Verify services, schema, health, static pages, API, logs, monitoring, and
  non-provider-mutating payment/reconciliation behavior.
- Do not switch, restart, migrate, or otherwise mutate production.

## Safety constraints

- Never print credentials, connection strings, customer PII, or order IDs.
- Do not create real CDEK shipments during routine smoke checks.
- Do not treat a successful staging deploy as production cutover approval.
- Do not run the old backend against a migrated staging DB after writes reopen;
  prefer a forward fix or a coordinated restore while ingress remains closed.
