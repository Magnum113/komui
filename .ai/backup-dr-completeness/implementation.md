# Implementation log

Статус: завершено. Backup v2 установлен; exact archive скачан из Object
Storage, расшифрован и полностью восстановлен в изолированный PostgreSQL.

## Backup v2

Изменён `ops/server/komui-backup.sh` и добавлены focused tests. Формат v2:

- сохраняет native owner, ACL и default ACL через `pg_dump -Fc --create` без
  suppressing flags;
- включает checksummed database/cluster security inventories и owner metadata;
- включает staging и production Nginx, TLS, systemd, active backend/frontend
  releases, `/var/lib/komui`, PostgreSQL host config и control-plane tools;
- исключает текущий encryption key динамически и содержит UID/GID mapping;
- требует existing root-only key и Object Storage credentials; ключ больше не
  создаётся автоматически;
- публикует checksum в S3 только после exact GET + SHA-256 проверки archive;
- публикует локальный `.gpg` последним, после успешной offsite проверки;
- очищает exact stale plaintext/partial state под backup lock.

Локальные проверки перед установкой:

- `bash -n`: OK;
- focused backup tests: `14/14`;
- полный `ops/server/tests`: `69/69`;
- обе security SQL inventory выполняются на PostgreSQL 17.10;
- три независимых review: GO для controlled canary.

## Initial installation and canary

Исходная установленная версия:

- SHA-256: `28b1aafd4e35b914e271b5851623ec96467fcb31aec75769672b683aa6745bd0`;
- rollback copy:
  `/usr/local/sbin/komui-backup.pre-v2-20260901T103307Z`.

Первый canary `20260901T103316Z` fail-closed до dump/archive: `postgres` не мог
прочитать inventory SQL через `psql -f` внутри root-only workdir. Workdir и
partials были очищены, live services не менялись. Исправление оставило workdir
`0700`, но передаёт `psql` открытый root файловый дескриптор stdin. Exact server
probe и два повторных review дали GO.

Установленный итоговый script:

- SHA-256: `29257d92aa879d786688c2c7e096aa301afd25ca1484104f51dee01d42199801`;
- rejected-candidate copy:
  `/usr/local/sbin/komui-backup.pre-v2-failed-20260901T103316Z`.

Успешный exact canary:

- backup id: `20260901T103533Z`;
- local archive:
  `/var/backups/komui/daily/komui-backup-20260901T103533Z.tar.gz.gpg`;
- bytes: `120539381`;
- SHA-256: `edff4807248c4b43ac6b7b673ee910eb1ceed04339ab082b0f77c03fe35b88e8`;
- mode/owner: `0600 root:root`;
- `external_upload=ok`, `external_download_verify=ok`;
- exact remote GET, portable sidecar parse, decrypt, outer/internal checksums:
  OK;
- outer members: `20` including `SHA256SUMS`;
- runtime members: `8052`, inventory exact-match, encryption key absent;
- staging TOC: `47` ACL + `6` default ACL;
- production TOC: `4` ACL + `0` default ACL.

После canary staging/prod PID, four activation symlinks, live DB OID/owners,
readiness and service states matched the preflight baseline; stale workdirs and
partials: `0`; backup/deploy/prune locks: free.

## Explicit PostgreSQL recovery scope

Первый полный restore обнаружил, что старый `cluster-security.json` смешивал
KOMUI scope с двумя настройками GetoMerch DB и сортировал settings по
нестабильным PostgreSQL OID. Это не было разрешено фильтром в restore-runner.
Контракт исправлен в источнике:

- manifest явно содержит `fullClusterRecovery=false` и
  `fullPostgresCluster=false`;
- cluster inventory содержит global role settings и settings только баз из
  manifest (`komui_staging`, `komui_production`);
- сортировка ролей/settings выполняется по именам, внутренние settings также
  канонизированы;
- membership predicate зеркалит PostgreSQL 17 `pg_dumpall`: исключаются только
  built-in `pg_*` ↔ `pg_*`, обе cross-direction связи остаются проверяемыми;
- наличие `ALTER ROLE ALL` либо settings predefined-роли блокирует публикацию
  архива, потому что `pg_dumpall --globals-only` их не гарантирует;
- restore comparator требует exact manifest scope, строгую JSON schema,
  отсутствие duplicate/out-of-scope записей и семантическое равенство всех
  ролей, membership options/grantor и recoverable settings.

Финальная production-версия backup script:

- SHA-256: `0c0d158f94cd71a60f8e18f78a7d1ca3838aeb4c784fa74febc7b0f20990d578`;
- rollback:
  `/usr/local/sbin/komui-backup.pre-scope-20260901T122852Z`;
- rollback SHA-256:
  `29257d92aa879d786688c2c7e096aa301afd25ca1484104f51dee01d42199801`.

Финальный canary:

- backup id: `20260901T122859Z`;
- local:
  `/var/backups/komui/daily/komui-backup-20260901T122859Z.tar.gz.gpg`;
- Object Storage:
  `s3://komui-backups/komui/stage/komui-backup-20260901T122859Z.tar.gz.gpg`;
- bytes: `134431938`;
- SHA-256: `adedcb9421c535df98b0e8ec59bedeec07276b057b8d7508a9ecc1bef2304a67`;
- owner/mode/link count: `root:root 0600 1`;
- backup log:
  `/var/backups/komui/logs/komui-backup-20260901T122859Z.log`, SHA-256
  `49fa75d03707ad49a4c62e61ded265e0a6d5492c24a44665b932565d0c38a9fc`.

## Fail-closed restore iterations

Четыре предварительных запуска завершились безопасно до финального GO:

1. Locale-dependent order в `runtime-paths.txt` ошибочно проверялся Python
   codepoint sort; inventory при этом был unique/non-empty и intact.
2. PostgreSQL 17.11 потребовал explicit `pg_restore --file=-` для offline SQL
   rendering.
3. `GRANTED BY postgres` потребовал bootstrap isolated cluster от роли
   `postgres`; duplicate `CREATE ROLE postgres;` теперь удаляется ровно один
   раз из root-only derived replay file.
4. Full cluster JSON выявил нестабильную OID-сортировку и две реально
   out-of-scope GetoMerch DB settings; это привело к явному scoped contract и
   новому canary, а не к ослаблению проверки старого архива.

Каждая ошибка оставила live services/readiness, activation symlinks и DB
OID/owners неизменными; cleanup завершился. Root-only логи сохранены в
`/var/backups/komui/logs/restore-v2-drill-*`.

## Successful exact offsite restore

Одноразовый runner:

- runner SHA-256:
  `d83a4012dec6017b4379cec5114ab50f4720ff36dff8f70a66047dbddd536dbe`;
- private namespace wrapper SHA-256:
  `6684248f911fe672d1e56227a503afbba0f42a410db12910cb33e2f352152fe1`;
- PostgreSQL package/runtime: verified 17.11 debs, extracted and read-only
  bind-mounted only in a private namespace; host packages remained 17.10.

Final run `20260901T123323Z-904805`:

- exact S3 download/hash/size/decrypt: PASS;
- outer entries: `20`; internal checksums: `19`; runtime members: `8140`;
- globals replay: isolated cluster only, bootstrap `postgres`;
- both restores: owner/ACL suppression `false`, role override `false`;
- per-DB security inventories: exact;
- cluster recoverable security scope: exact, expected/restored out-of-scope
  settings `0/0`;
- staging: 38 user tables, products 31, orders 13, payment attempts 13,
  payment events 14, shipments 3;
- production: 38 user tables, products 38, orders 79, payment attempts 79,
  payment events 18, shipments 5;
- catalog owners, five critical relations, valid indexes/constraints, app role
  query and backup-role effective read/no-DML/no-create checks: PASS;
- runtime archive was never extracted over `/`; live restore targets were never
  used.

Permanent audit log:

- `/var/backups/komui/logs/restore-v2-drill-20260901T122859Z-20260901T123323Z-904805.log`;
- SHA-256:
  `8c6a469f086372d0f4535744fd6a0505b4e1d96a6965ebe8c78353668693c28d`;
- `root:root`, mode `0600`, size `14098`, link count `1`.

После success удалены 10 exact staged candidate/runner/wrapper/upload файлов
из `/var/tmp` после SHA/link/open-file validation. Locked OS user
`komui-dr-restore` оставлен намеренно для повторяемых drills; у него нет home,
login shell, supplementary groups или процессов.
