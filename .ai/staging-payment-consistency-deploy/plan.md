# Plan

Статус: выполняется.

1. Выполнить read-only preflight локального release и staging-инфраструктуры.
2. Повторно запустить полную локальную верификацию frozen diff.
3. Создать отдельную `codex/` ветку, commit и push release candidate.
4. Снять свежий encrypted backup и проверить его статус.
5. Закрыть staging checkout/webhook writes, дренировать запросы и остановить
   старый backend.
6. Повторить семь SQL preflight counters; при любом ненулевом значении — NO-GO.
7. Применить migration в одной транзакции; до старта backend перевести две
   historical CDEK cancellation строки в явный `needs_review` и доказать, что
   due/processing provider effects и T-Bank reconciliation candidates равны 0.
8. Развернуть новый immutable staging backend/frontend release без
   автоматического возврата старого backend.
9. Проверить schema, services, readiness, static/API smoke, structured logs,
   monitoring и отсутствие provider-side mutations.
10. Зафиксировать deployment evidence, rollback boundary и неизменность
   production в документации.
