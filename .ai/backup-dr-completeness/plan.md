# Plan

Статус: завершено 2026-09-01; production backup v2 и exact offsite restore
drill проверены end-to-end.

1. [done] Audit exact PostgreSQL archive semantics and inventory active production
   runtime paths read-only.
2. [done] Design a versioned backup manifest and fail-closed runtime path capture.
3. [done] Implement backup-script changes and focused automated tests.
4. [done] Verify locally and obtain independent safety/code reviews.
5. [done] Install the exact reviewed script on the server with hash verification and
   a recoverable previous copy.
6. [done] Create a new encrypted backup and verify local checksum/upload.
7. [done] Download the exact new archive and checksum from Object Storage into a
   root-only temporary location and verify/decrypt it.
8. [done] Restore both database dumps into an isolated socket-only PostgreSQL cluster,
   validate owners/ACL/data/runtime bundle, and run outbound-isolated read
   smokes where safe.
9. [done] Prove cleanup and active-runtime invariants, document residual key-escrow
   scope, commit and push only task-owned changes.
