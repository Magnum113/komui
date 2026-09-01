# Review

Статус: GO. Backup v2 установлен, новый exact archive восстановлен в изоляции,
production не изменён.

## Independent review

- Backup SHA
  `0c0d158f94cd71a60f8e18f78a7d1ca3838aeb4c784fa74febc7b0f20990d578`:
  GO после исправления membership predicate и fail-closed запрета
  невосстанавливаемых `ALTER ROLE ALL`/predefined-role settings.
- Restore runner SHA
  `954809b5dcbbceba98582af539f61aee7ec08c394b3df55fa7e7bc48617816ee`:
  GO для logic/schema/canonical comparator; adversarial review также GO.
- Финальный pin-only runner SHA
  `d83a4012dec6017b4379cec5114ab50f4720ff36dff8f70a66047dbddd536dbe`
  получен только заменой backup ID/SHA/size. Обратная замена воспроизводит
  reviewed SHA `954809...`: GO.
- Финальный wrapper SHA
  `6684248f911fe672d1e56227a503afbba0f42a410db12910cb33e2f352152fe1`
  отличается от reviewed `18f5a7...` только backup ID; reverse hash: PASS.

## Verification

- `bash -n`: backup, runner, namespace wrapper — PASS.
- Embedded Python compile: backup `5/5`; runner `9` heredoc + `3` inline — PASS.
- Focused backup tests: `15/15`.
- Full `ops/server/tests`: `94/94` (включая unrelated existing xray tests).
- Generated per-DB and cluster inventory SQL executed read-only on live
  PostgreSQL: roles `9`, memberships `2`, scoped settings `7`, unsupported `0`.
- Exact offsite download, portable checksum, ciphertext SHA/size, decrypt,
  gzip, outer layout, 19 internal checksums and 8,140-member runtime inventory:
  PASS.
- Both DB restores, exact per-DB security inventory, canonical cluster security,
  catalog/index/constraint checks, row-count checks, app/backup permission
  probes: PASS.
- Cleanup and live invariants: PASS. No restore-user processes, socket,
  `/dev/shm` workdir or private package runtime remained. Service state/PID,
  activation symlinks, live DB OID/owners and readiness were unchanged.

## Residual scope

- Independent off-server escrow and recovery test of `/etc/komui/backup.key`
  is still not established. The key is intentionally absent from archives.
- The shared cluster's GetoMerch databases/runtime are explicitly outside this
  KOMUI backup contract.
- Live PostgreSQL is still 17.10. Updating it to 17.11 remains a separate
  high-priority controlled maintenance step with a short PostgreSQL restart.
- Backend Node/provider smokes were intentionally not run against the isolated
  database; this drill's declared scope is DB security/catalog/data/permissions
  and runtime archive integrity.
