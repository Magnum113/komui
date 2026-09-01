# Context

- Pre-maintenance live state was PostgreSQL server/client
  `17.10-1.pgdg24.04+1`, SQL version `170010`, cluster `17/main`, system
  identifier `7655433644737020698`.
- Target server/client package was exact `17.11-1.pgdg24.04+2`. Cached target
  and rollback DEBs were verified by SHA-256 and package metadata.
- The cluster contained seven non-template databases. It had no replication
  slots, prepared transactions, subscriptions, custom tablespaces, held
  packages, pending restart settings or failed systemd units.
- All database clients bind through loopback. The complete consumer set was
  seven application units: Komui staging/production backends and email workers,
  plus GetoMerch admin and two workers.
- Fresh retained backup evidence before mutation:
  - Komui offsite backup `20260901T130932Z`, SHA-256
    `e9d395ec25c9e64477f1c6ee1e65fc02d60d7c43f094957c60c496a7e923d531`;
  - GetoMerch offsite backup `20260901T130000Z`, SHA-256
    `624f732506a99bd78176b00853b55070bd9f41ea31a27bf421b1dfbd105c1cf7`.
- PostgreSQL 17.11 fixes CVE-2026-18408 and other release issues affecting
  17.10. The official 17.11 release notes permit an in-place 17.x minor update
  without dump/restore. `btree_gist` and `ltree` are absent, so release-specific
  REINDEX work was not required.
- Official references:
  - https://www.postgresql.org/support/security/CVE-2026-18408/
  - https://www.postgresql.org/docs/17/release-17-11.html
  - https://www.postgresql.org/about/news/postgresql-186-1711-1615-1519-1424-and-19-beta-3-released-3365/
- Concurrent email/xray worktree changes belong to the user and are outside
  this task.
