# Inputs

- User authorization: update live PostgreSQL 17.10 to 17.11 with a short,
  controlled restart.
- Production host: `89.111.152.112`, SSH user `codex-migrate`, root via sudo.
- Scope: PostgreSQL 17 server/client minor packages and the shared existing
  `17/main` cluster only.
- Constraints:
  - preserve all seven non-template databases, including both active Komui
    databases, GetoMerch, rehearsal and archived/previous databases;
  - do not deploy application code or touch unrelated worktree changes;
  - retain independently verified logical/offsite backups and create a fresh,
    verified encrypted physical backup before package mutation;
  - minimize downtime and verify application reconnection after restart;
  - never print secrets or password verifiers;
  - close write ingress before stopping clients;
  - automatically downgrade to exact 17.10 packages on any failure before full
    PostgreSQL and internal application acceptance;
  - stop on unexpected package, config, cluster, queue or service state.
