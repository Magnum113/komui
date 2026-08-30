# Plan

Статус: выполнено для staging; production вне scope и не изменялась.

1. Выполнить read-only preflight локального release и staging-инфраструктуры.
2. Повторно запустить полную локальную верификацию frozen diff.
3. Создать отдельную `codex/` ветку, commit и push release candidate.
4. Собрать immutable backend/frontend release без активации и провести
   migration rehearsal на полной временной копии staging DB.
5. Закрыть staging checkout/webhook writes, дренировать запросы и остановить
   старый backend.
6. Повторить семь SQL preflight counters; при любом ненулевом значении — NO-GO.
7. После gate/drain снять согласованный encrypted backup и проверить checksum
   и external upload.
8. Применить migration в одной транзакции; до старта backend перевести две
   historical CDEK cancellation строки в явный `needs_review` и доказать, что
   due/processing provider effects и T-Bank reconciliation candidates равны 0.
9. Активировать заранее подготовленный immutable staging backend/frontend
   release без
   автоматического возврата старого backend.
10. Проверить schema, services, readiness, static/API smoke, structured logs,
   monitoring и отсутствие provider-side mutations.
11. Установить и проверить fail-closed source/schema guard для штатного Git и
   Telegram deploy flow.
12. Зафиксировать deployment evidence, rollback boundary и неизменность
   production в документации.
