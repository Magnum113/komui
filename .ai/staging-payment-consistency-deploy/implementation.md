# Implementation log

Статус: preflight выполняется; серверные изменения ещё не начаты.

## Local verification

- server tests: 228/228;
- TypeScript build: passed;
- ops Python tests: 17/17;
- Python bytecode compile: passed;
- deployment/healthcheck/backup shell syntax: passed;
- `git diff --check`: clean.

## Read-only staging preflight

- `komui-backend`, Nginx, PostgreSQL, backup timer and healthcheck timer:
  active;
- active staging backend/frontend release:
  `20260821T130943Z-stage-94e9946cf5a4`;
- readiness: HTTP 200 against `127.0.0.1:3000`;
- database: `komui_staging`;
- new `merch_order_effects` table and reconciliation columns: absent, as
  expected before migration;
- staging T-Bank: demo, non-mock; CDEK: production API, non-mock, real shipment
  creation enabled;
- root filesystem usage: 71%, approximately 5.7 GiB free;
- production was inspected read-only only and remains out of deployment scope.

## Rollout decision

The stock `/usr/local/sbin/komui-deploy-from-git` is not sufficient for this
release because it activates the backend immediately and has no schema migration
step. The candidate will be built as immutable backend/frontend directories
before maintenance. Activation will occur only after POST ingress is closed,
the old backend is stopped, the seven SQL counters are zero, a fresh encrypted
backup succeeds, and the migration commits.
