# Context

- The archive was created after staging payment/webhook ingress was closed and
  the old staging backend was stopped, but before the payment-consistency
  migration was applied.
- It contains custom-format dumps for both `komui_staging` and
  `komui_production`, PostgreSQL globals, runtime config, manifest and internal
  SHA-256 checksums.
- The encrypted archive checksum and external upload were already verified.
- Active staging now has the new schema; active production still has the legacy
  schema. The archive is expected to contain the pre-migration legacy schema
  for both databases.
- Backup dumps omit owner and ACL replay. The nested runtime archive captures
  staging artifacts and shared `/etc/komui`, but omits key production
  Nginx/systemd/frontend release/root paths; a successful DB drill therefore
  cannot be described as complete production DR.
- Newer scheduled archives exist, but this task intentionally targets the
  exact pre-migration post-drain rollback point.
- Existing user worktree changes are unrelated and must not be modified.
