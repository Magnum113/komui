# Implementation

Status: complete on production.

## Accepted runner

- Final runner SHA-256:
  `69c8b96ecf6002b1e0877ea8e3aa65513cfb9192510748cb1c6ddb4ca9340cb0`.
- Server path: `/usr/local/sbin/komui-postgresql-17.11-upgrade`.
- Execution unit: `komui-postgresql-17-11-upgrade-20260901T1425Z.service`.
- Successful run ID: `20260901T142507Z.GR0SSd`.
- Root-only log:
  `/var/log/komui/postgresql-upgrades/postgresql-17.11-20260901T142507Z.GR0SSd.log`.

The runner pins host/system ID/package versions and artifact hashes, takes
project and apt guards, snapshots original unit state, closes write methods at
Nginx, quiesces every shared-cluster client, checks queue/job/session gates,
captures a broad catalog/config/data fingerprint, performs the exact package
transaction, validates the real PostgreSQL log, starts frontends before
workers, and reopens ingress only after full acceptance. Exact 17.10 rollback
stays armed through internal application acceptance.

## Safe pre-mutation aborts

Two earlier invocations proved the fail-safe boundary and did not reach app
stop or apt:

1. `20260901T141355Z.ZkfCAD` stopped in `safety-preflight` because systemd
   expanded JavaScript template expressions in the authenticated GetoMerch
   probe. The probe was changed to equivalent string concatenation and added
   to read-only self-test.
2. `20260901T142014Z.vMrbmL` stopped at `nginx -t` because Perl interpreted the
   regex anchor `$)` as its effective-GID variable. Original Nginx files and all
   auxiliary units were restored exactly. The three anchors were escaped and
   the exact generated candidates then passed marker-count checks and
   `nginx -t` against a complete temporary clone of `/etc/nginx`.

Both fixes received three independent exact-delta GO verdicts before retry.

## Successful production run

- `14:25:08Z`: automation/timers paused after project locks were acquired.
- `14:25:19Z`: fresh online physical backup completed and
  `pg_verifybackup --exit-on-error` passed.
- `14:25:21Z`: write methods returned validated HTTP 503; original Nginx GET
  behavior remained configured.
- `14:25:21Z`–`14:25:22Z`: all seven app units stopped; both Komui gates were
  `0|0|0|0|0|0`, GetoMerch running jobs `0|0`, client sessions zero.
- `14:25:24Z`: rollback armed and exact two-package update started.
- PostgreSQL cleanly stopped and restarted on 17.11 at `14:25:30Z`.
- `14:25:37Z`–`14:25:39Z`: admin/backends and then workers started.
- `14:25:51Z`: internal acceptance passed, sessions `3|3|2|1`; post-start
  queues/jobs remained zero and rollback was disarmed.
- `14:25:51Z`–`14:25:52Z`: original auxiliary state restored and global
  healthcheck passed.
- `14:25:55Z`: exact original Nginx files restored, write ingress reopened,
  runner exited 0.

Write-ingress maintenance lasted 34 seconds. Backend stop to frontend start was
about 15–18 seconds. Automatic rollback was not used.

## Retained physical backup

- Path:
  `/var/backups/komui/maintenance/postgresql-17.11-20260901/runs/20260901T142507Z.GR0SSd/postgresql-17-main-20260901T142507Z.GR0SSd.physical.tar.gz.gpg`
- Size: `46,305,321` bytes.
- Mode/owner: `0600 root:root`.
- SHA-256:
  `7fe966acb03d1cac917c198a36747202e89a9bab1af07b268698d897f3542abc`.
- The plain backup manifest was checked by `pg_verifybackup`; the encrypted
  archive was checksum-verified and decrypt/list-verified before acceptance.
