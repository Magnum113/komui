# Review

Статус: GO для data/schema restore и isolated legacy-runtime recovery из
точного post-drain archive. P0/P1 в выполненном drill не осталось.

Независимые reviews до запуска проверили checksum parsing, free-space gates,
TOC/table expectations, root-only dump access, `pg_restore` flags, database and
workdir cleanup markers, deploy/prune locks, signal semantics, secret-free
runtime env and outbound network isolation. Финальный server log и отдельный
post-cleanup probe подтверждают `RESULT restore_drill=ok cleanup=ok`.

Этот результат не следует называть полным production disaster-recovery test:

1. Backup dumps создаются с `--no-owner --no-acl`. Drill воспроизвёл
   temporary grants только в drill DB, но сам архив их не восстанавливает.
2. `runtime-config.tar.gz` staging-centric: он не включает полный набор
   production Nginx/systemd/frontend release/root artifacts.
3. Проверены локальная копия и read-only presence/size внешних объектов, но не
   download/decrypt с Yandex Object Storage и не off-server key escrow.
4. Snapshot содержит legacy schema до payment-consistency migration. Он
   проверен как rollback archive с соответствующими legacy backends; это не
   restore test текущей migrated staging schema.
5. Более свежий scheduled archive `20260901T002703Z` существует, но в этом drill
   не восстанавливался.

Неблокирующие ограничения самого one-off runner: root-only plaintext workdir
может сохраниться после `SIGKILL` или reboot до ручной уборки; socket auth имеет
`session_user=postgres` с startup `SET ROLE komui_app`; temporary grants шире
read-only smoke; сбой database comment сразу после `createdb` оставит exact
fail-closed DB для ручной проверки; shutdown Node не имеет отдельного hard
timeout. Успешный run завершился штатно, и ни один из этих сценариев не
реализовался.
