# Implementation record

Дата: 30 августа 2026. Изменения подготовлены локально; commit, migration
apply, staging/production deploy и внешние provider mutations не выполнялись.

## Зафиксированные инварианты

1. Финансовая истина меняется только подписанным T-Bank webhook или
   reconciliation-ответом, совпавшим с сохранённой boundary по terminal,
   merchant order, payment id и amount.
2. Inbox event, payment attempt, order status, promo transition и CDEK intent
   коммитятся одной PostgreSQL-транзакцией. CDEK network I/O выполняется после
   webhook ACK отдельным durable worker.
3. Один `clientRequestId` не может отправить второй `/Init`, пока первый вызов
   неоднозначен. Новый платёж допустим только после подтверждённого terminal
   failure/cancellation.
4. После появления строки CDEK shipment автоматический второй create `POST`
   запрещён. Такая строка может только reconciliate exact provider order либо
   перейти в operator review.
5. Полный refund/reversal не зависит от доступности CDEK: финансовый статус
   коммитится, а отмена доставки сохраняется как retryable outbox effect.

## P1.1 — webhook consistency

- Добавлена явная provider/order state machine с монотонными переходами и
  безопасным восстановлением после позднего `CONFIRMED`.
- После проверки terminal key и подписи требуются непустые `PaymentId`,
  `OrderId`, `Status` и положительный safe-integer `Amount`.
- Amount сверяется с order и payment attempt до привязки PaymentId и до любых
  state mutations. Несовпадение остаётся audit event и блокирует исполнение
  через `payment_review`, в том числе если доставка уже могла начаться; тогда
  в той же транзакции сохраняется causal `cdek_cancel`.
- Duplicate `event_hash` не повторяет переходы. Out-of-order status не
  перезаписывает более окончательный факт.
- Direct `PARTIAL_REFUNDED` без локально подтверждённой оплаты переводит заказ
  в review; поздний lower-rank `CONFIRMED` игнорируется и не может запустить
  fulfillment. Разрешена только exact replay-healing или более финальный факт.
- Promo transition и CDEK create/cancel intent выполняются внутри webhook
  transaction. HTTP `OK` возвращается только после commit и без ожидания CDEK.

## P1.2 — ambiguous `/Init`

- Полная очищенная и подписанная Init request boundary сохраняется вместе с
  order/payment attempt до provider call.
- Provider request имеет timeout. Timeout/network/invalid boundary/ошибка
  сохранения успешного ответа оставляют durable `INIT_UNKNOWN` или stale
  `INITIATING`, а order — `payment_unknown`; повторный checkout с тем же key не
  создаёт второй order/payment.
- Background reconciler использует signed `CheckOrder` и `GetState`, lease,
  `SKIP LOCKED`, bounded retry/backoff и `INIT_REVIEW` после исчерпания.
- Поскольку opaque `PaymentURL` нельзя восстановить этими status methods,
  найденный orphan `NEW` отменяется signed `Cancel`; fresh retry разрешается
  только после terminal cancellation. Processed/mismatching result сохраняет
  финансовую истину или переводит заказ в review.
- До HTTP `Cancel` короткая транзакция повторно блокирует attempt/order,
  проверяет lease generation, OrderId, amount, terminal и глобальное владение
  PaymentId, привязывает найденный PaymentId, очищает `payment_url` и сохраняет
  durable cancel-intent. При CAS/conflict запрос `Cancel` не отправляется.
  Поэтому crash после intent или уже отправленного `Cancel` не открывает форму
  оплаты и не позволяет позднему fulfillment обойти `payment_review`.
- Checkout сохраняет recovery session и перенаправляет ambiguous request на
  payment status page вместо автоматического создания нового платежа.
- Shutdown ожидает активные T-Bank и CDEK worker runs.

## P1.3 — refund/CDEK cancellation

- Добавлена таблица `merch_order_effects` и worker с stable dedupe key,
  claim/lease, exponential backoff, max attempts и `needs_review`.
- `cdek_create` повторно читает order непосредственно перед provider request и
  допускается только для `paid` или подтверждённого `partially_refunded`, если
  частичный refund следует за локально подтверждённой оплатой. Прямой
  `PARTIAL_REFUNDED` без предшествующего `CONFIRMED` остаётся в review.
- Любая существующая shipment row запускает только reconciliation по exact
  UUID/merchant order number. Пустой lookup повторяется без второго create
  `POST`, затем требует ручной проверки.
- `accepted` — промежуточное состояние: create effect завершается только на
  `created`; invalid/исчерпанные попытки становятся `needs_review`.
- Shipment writes защищены compare-and-set, поэтому конкурентный create не
  может перезаписать `deleting`/`deleted` или спрятать refund race.
- Cancel использует provider UUID. Provider absence считается terminal success
  только после ранее зафиксированной попытки DELETE; до неё 404/пустой lookup
  остаётся retryable. Async DELETE сверяется до terminal success, а
  неоднозначности переводятся в retry/review. Новая реальная
  refund/reversal-цепочка rearm-ит terminal cancel effect с очищенными
  attempts/lease/outcome.
- Monitor считает доставку выполненной только при shipment status `created` и
  отдельно сигнализирует `INIT_UNKNOWN`/`payment_review`/effect `needs_review`.

## Migration и совместимость

- Forward-only migration добавляет `payment_unknown`, reconciliation columns
  and index, CDEK `deleting`, durable effects table/indexes/backfill.
- RLS/grants условны по наличию roles: managed Supabase использует
  `service_role`, self-hosted PostgreSQL — `komui_app`. Отсутствующие Supabase
  roles не ломают migration; `komui_app` получает DML и sequence access плюс
  разрешающую RLS policy.
- Production read-only проверка подтвердила: backend login role — `komui_app`,
  `BYPASSRLS=false`, Supabase `service_role` отсутствует. Именно поэтому
  portability была проверена до deploy.

## Проверка

Финальный локальный прогон:

- server tests: 228/228;
- focused T-Bank/checkout: 99/99;
- focused CDEK effects: 38/38;
- TypeScript build: passed;
- Python order-monitor tests: 17/17;
- Python `py_compile`: passed;
- inline JavaScript в `checkout.html` и `payment-result.html`: parsed;
- обычный и untracked-aware whitespace diff-check: clean.

Независимый cross-review и остаточные ограничения записаны в `review.md`.
