# Plan

Статус: завершён 1 сентября 2026 года.

1. Read-only preflight archive, checksum/log, free space, services, symlinks,
   PIDs and absence of conflicting drill databases.
2. Create an explicit root-only temporary directory under the backup root.
3. Verify outer checksum, decrypt the exact archive and validate its tar layout
   before extracting.
4. Extract only into the drill directory and verify every internal
   `SHA256SUMS` entry.
5. Inspect both custom dumps with `pg_restore --list`.
6. Create two uniquely named empty drill databases from `template0`, restore
   staging and production dumps with `--exit-on-error`, and collect aggregate
   schema/data/privilege evidence.
7. Verify active databases, services, symlinks and PIDs are unchanged.
8. Drop only the two drill databases and remove only the validated drill
   directory; prove cleanup completed.
9. Record evidence, update restore status documentation and obtain an
   independent final review.

Все девять шагов выполнены. Активные staging/production runtime и базы не
изменялись.
