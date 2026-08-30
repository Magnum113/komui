# Implementation log

Статус: staging rollout завершён; production не изменялась.

## Local verification

- server tests: 228/228;
- TypeScript build: passed;
- ops Python tests after deploy-guard addition: 20/20;
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

## Release candidate

- branch: `codex/payment-consistency-hardening`;
- commit: `ac2567bb42aefcc0f75d9bb31fa915fd373954f6`;
- `origin/main` оставлен на `5a36b6c`;
- immutable backend/frontend release:
  `20260830T175312Z-stage-ac2567bb42ae`;
- server-side build повторно выполнил 228/228 тестов, TypeScript build,
  product media sync и strict static build.

## PostgreSQL rehearsal

Migration выполнена на полной временной копии `komui_staging`. Подтверждены:

- новые table/columns/indexes;
- validated order/CDEK constraints;
- RLS и policy для `komui_app`;
- table/sequence privileges;
- ожидаемый backfill из двух `cdek_cancel`.

Временная БД и dump удалены после проверки.

## Closed rollout

- все staging POST и отдельный webhook location были закрыты на Nginx;
- старый `komui-backend` остановлен, порт 3000 и pool sessions дренированы;
- семь payment preflight counters: `0|0|0|0|0|0|0`;
- T-Bank reconciliation candidates: `0`;
- неизвестные order/CDEK statuses: `0`;
- post-drain encrypted backup:
  `komui-backup-20260830T180555Z.tar.gz.gpg`, checksum и external upload OK;
- migration применена к `komui_staging` одной транзакцией;
- две historical CDEK cancellation строки переведены в terminal
  `needs_review` до старта worker; provider calls не выполнялись;
- backend активирован без auto-rollback старой версии, затем отдельно
  активирован frontend и открыт исходный Nginx ingress.

Первый gate-probe дважды завершался до остановки backend: сначала из-за Basic
Auth, затем из-за проверки сразу после Nginx reload. В обоих случаях trap
вернул исходный config/backend; schema и данные не менялись. Финальный rollout
использовал authenticated check, exact webhook gate и drain после reload.

## Post-deploy verification

- stage backend/frontend symlinks указывают на новый release;
- staging root, checkout, payment-result, products API и readiness: HTTP 200;
- unauthenticated staging root: HTTP 401; `X-Robots-Tag` сохранён;
- invalid payment/webhook POST: HTTP 400/403 без новых orders/events;
- non-terminal CDEK effects: 0;
- `INIT_REVIEW` и `payment_review`: 0;
- worker failures/activity по quarantined rows: 0;
- candidate order monitor прошёл staging `--bootstrap --dry-run`;
- global healthcheck: `SUMMARY OK`; failed units: 0;
- deployment registry содержит successful backend/frontend events.

Production backend/frontend symlinks, production service PID, production schema
и глобальный order-monitor binary не изменились. Production всё ещё не имеет
`merch_order_effects` и reconciliation columns.

## Post-rollout deploy safety

Independent review обнаружил, что Telegram stage action всё ещё запрашивал
`origin/main` (`5a36b6c`) и без дополнительной проверки мог вернуть legacy
backend на migrated staging DB. В `ops/server/komui-deploy-from-git` добавлен
fail-closed compatibility gate до build/activation:

- полный legacy source допускается только на legacy schema;
- payment-consistency source допускается только при полном schema signature;
- partial source/schema и обе mismatch-комбинации блокируются;
- `--check-compatibility-only` проверяет branch/DB без build, restart или
  переключения release symlink.

Guard commit `b2c7337b8173b42647a4b476748a3c4bc2e5df78` установлен в
`/usr/local/sbin/komui-deploy-from-git`; installed SHA-256
`28122349aadda67e1be543d6e749cfce8e8ad24a63dd27c07d9a5690332e0559`
совпал с committed source. Четыре server-side probe дали ожидаемую матрицу:

```text
stage + main legacy source       -> blocked (exit 1)
stage + hardening source         -> allowed (exit 0)
prod  + main legacy source       -> allowed (exit 0)
prod  + hardening source         -> blocked (exit 1)
```

До/после совпали staging/production symlinks, service PID, release counts и DB
row counters; build, restart и activation не выполнялись. Ops config event
`deploy-guard-b2c7337` записан в deployment registry с `--no-notify`. Guard не
применяет migration и не заменяет maintenance/drain runbook. Повторный guard
перед activation и общий `/run/komui-deploy.lock` закрывают TOCTOU между ранней
проверкой, build и migration window.

Ошибочный metadata marker активного staging release исправлен с
`prepared_only=true` на `activated=true`, добавлен фактический
`activated_at=2026-08-30T18:06:07Z`; исходный marker сохранён root-only в
`/var/lib/komui/release-metadata-backups/`.

Новый post-drain archive прошёл checksum и external upload verification.
Migration rehearsal на полной временной DB-копии является отдельной проверкой;
restore drill именно архива `komui-backup-20260830T180555Z.tar.gz.gpg` не
выполнялся и остаётся production gate.
