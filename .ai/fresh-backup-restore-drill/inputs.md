# Inputs

- User request: proceed to the next safe step after the staging
  payment-consistency rollout.
- Selected step: restore-drill the exact post-drain encrypted archive
  `/var/backups/komui/daily/komui-backup-20260830T180555Z.tar.gz.gpg`.
- Constraints:
  - do not migrate, restart, stop, or switch production/staging runtime;
  - do not call T-Bank/CDEK or create provider-side entities;
  - restore only into uniquely named temporary PostgreSQL databases;
  - preserve all unrelated local worktree changes;
  - delete only drill-created databases/files after verification.
