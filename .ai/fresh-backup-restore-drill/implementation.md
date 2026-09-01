# Implementation log

Статус: restore drill завершён успешно 1 сентября 2026 года; active runtime не
изменялся.

## Exact input

- archive:
  `/var/backups/komui/daily/komui-backup-20260830T180555Z.tar.gz.gpg`;
- size: `52 584 372` bytes;
- outer SHA-256:
  `d99db650d4b747fa4eab59126cb9f6a980f9cab5a0c7221108673b7116624f40`;
- manifest databases: `komui_staging`, `komui_production`;
- local checksum: OK;
- Yandex Object Storage archive and companion checksum: present with the
  expected sizes;
- backup log: `external_upload=ok`.

Decrypted archive layout was restricted to six exact members:

```text
komui_staging.dump
komui_production.dump
postgres-globals.sql
runtime-config.tar.gz
manifest.json
SHA256SUMS
```

All internal SHA-256 entries and the nested runtime-config gzip stream passed.
`postgres-globals.sql` was not executed and `runtime-config.tar.gz` was not
expanded into `/`.

## Guarded runner

Runner:

```text
.ai/fresh-backup-restore-drill/runtime/restore-drill.sh
SHA-256: 2e23a6f718a48221d7dd545acf08ec349ad85559bca0c9c6f554b2efb1e3ef25
```

It held restore, deploy and release-prune locks; required at least 512 MiB on
the backup and PostgreSQL filesystems; generated exact-regex temporary DB
names; marked each DB with an exact database comment; restored with
`--single-transaction --exit-on-error`; and allowed cleanup only for matching
name + marker pairs. The plaintext workdir used an exact root-only prefix and
marker. The uploaded `/tmp` runner was hash-verified before execution and
deleted afterward.

The first controlled invocation at `2026-09-01T08:26:51Z` intentionally does
not count as a successful drill: `cat dump | pg_restore` caused the producer to
exit `141` after `pg_restore` stopped reading, and `pipefail` correctly made the
runner fail. The error log was empty. Both generated databases and the workdir
were removed. A separate post-failure probe, rather than that invocation's
permanent log, confirmed active PIDs/releases were unchanged. Another read-only
reproduction proved `pipe_status=141` and `seekable stdin=0`. The runner was
corrected to let the root shell open the root-only regular file as seekable
stdin before `runuser`.

## Successful restore

Successful run id: `20260901t082839z`.

Both custom dumps restored into unique databases owned by `komui_owner`:

```text
komui_restore_20260830_stage_20260901t082839z
komui_restore_20260830_prod_20260901t082839z
```

Common validation for both snapshots:

- `35` public tables;
- invalid indexes: `0`;
- unvalidated public/private constraints: `0`;
- legacy payment schema confirmed: no `merch_order_effects` and no
  reconciliation columns;
- temporary recovery grants replayed only inside each drill DB;
- `SET ROLE komui_app` selected the expected product rows.

Aggregate snapshot evidence:

| Snapshot | Products | Orders | Attempts | Events | CDEK shipments |
|---|---:|---:|---:|---:|---:|
| staging | 31 | 13 | 13 | 14 | 3 |
| production | 38 | 78 | 78 | 16 | 4 |

Production additionally contained `163` reviews and `29` review-media rows.

Legacy runtime compatibility was checked with immutable releases matching the
legacy schema:

- staging snapshot: `94e9946cf5a4` release;
- production snapshot: `5a36b6c11d66` release.

Each backend ran with `env -i`, Unix-socket PostgreSQL and startup
`role=komui_app` inside a fresh `unshare --net` namespace. Provider settings
were mock/disabled, no outbound route existed, and only GET
`/health/ready` plus `/v1/products?limit=1` were called. Both smokes passed and
readiness named the exact temporary database.

## Cleanup and live invariants

Permanent evidence log:

```text
/var/backups/komui/logs/restore-drill-20260830T180555Z-20260901t082839z.log
mode 0600, root:root
SHA-256: edffe934dfab8ff6a2733883f9874f1e0c3dcff80384133e631846c6ee1da299
RESULT restore_drill=ok cleanup=ok
```

Independent post-cleanup checks:

- matching temporary databases: `0`;
- matching PostgreSQL sessions: `0`;
- restore workdirs: `0`;
- transient backend processes: `0`;
- restore/deploy/prune locks: free;
- staging/production backend, Nginx and PostgreSQL: active;
- staging PID: `793815`, production PID: `793805`, unchanged;
- active backend/frontend symlinks: unchanged;
- active database OID/owner identity: unchanged;
- active readiness: port `3000` -> `komui_staging`, port `3001` ->
  `komui_production`.

The scheduled backup timer has since created newer archives, including
`komui-backup-20260901T002703Z.tar.gz.gpg`; its checksum and external upload are
OK, but this task deliberately drilled the exact post-drain rollback archive.
