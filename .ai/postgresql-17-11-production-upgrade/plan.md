# Plan

Status: complete.

1. [completed] Capture exact package, cluster, config, service, database and
   application baselines; audit official 17.11 migration notes.
2. [completed] Create and verify a fresh encrypted physical backup; verify the
   retained offsite backups and ensure locks,
   disk, apt state and package candidates are safe.
3. [completed] Cache exact target/rollback packages and perform a controlled minor
   package update with bounded application downtime.
4. [completed] Verify package/server/client versions, cluster/config/extensions,
   DB identities and data, services/readiness/reconnection and error logs.
5. [completed] Complete three independent preflight/delta reviews and three
   independent read-only postflight reviews; document exact evidence without
   touching unrelated worktree changes.
