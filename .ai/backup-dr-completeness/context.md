# Context

- An earlier rollback-archive drill restored rows but suppressed native owner
  and ACL replay, omitted active production runtime paths, and never downloaded
  the Object Storage object back for decryption.
- This task closes those gaps for the two KOMUI databases and active KOMUI
  runtime without switching or restarting staging/production.
- The PostgreSQL host is shared with GetoMerch. The backup contract is therefore
  explicitly scoped to `komui_staging` and `komui_production`; it does not claim
  full recovery of every database in the shared cluster.
- Global roles and non-system memberships remain in scope because archived
  KOMUI ownership and privileges depend on them. Database-specific settings are
  scoped to the two database dumps. Unsupported `ALTER ROLE ALL` or predefined
  role settings make backup creation fail closed.
- `postgres-globals.sql` contains password verifiers. It may be replayed only in
  a disposable isolated PostgreSQL cluster and must never be printed or applied
  to the live cluster.
- Exact owners confirmed on 2026-09-01:
  - `komui_staging`: `komui_owner`;
  - `komui_production`: `komui_app`.
- Live PostgreSQL remains 17.10. The drill used verified PostgreSQL 17.11
  packages only inside a private mount namespace; a live 17.11 security update
  is a separate maintenance action because it requires a short DB restart.
- Concurrent user work in unrelated xray files/directories must not enter this
  task's commit.
