# Final review

Дата: 30 августа 2026.

## Verdict

- Remaining P0: **none**.
- Remaining P1 по первым трём пунктам аудита: **none**.
- Независимый cross-review отдельно проверил transactional webhook,
  ambiguous Init/reconciliation, pre-Cancel crash window, stale lease races,
  refund/reversal → CDEK cancellation и запрет повторного CDEK create.

Критический crash-инвариант закрыт: до HTTP `Cancel` короткая транзакция под
row/advisory locks проверяет generation, OrderId, amount, terminal и
глобального владельца PaymentId, затем CAS-привязывает PaymentId, очищает URL и
сохраняет durable cancel-intent. Без успешно закоммиченного intent `Cancel` не
вызывается. Любой последующий fulfillable provider fact переводится в
`INIT_REVIEW`/`payment_review` и создаёт causal `cdek_cancel`, в том числе после
crash, stale lease или для уже находящегося в review заказа.

## Проверки

- server tests: **228/228**;
- focused T-Bank/checkout/migration: **99/99**;
- focused CDEK effects: **38/38**;
- TypeScript build: passed;
- Python order-monitor: **17/17**, `py_compile` passed;
- inline JavaScript в `checkout.html` и `payment-result.html`: parsed;
- `git diff --check` и отдельная проверка untracked T-Bank-файлов: clean;
- changed/untracked high-confidence secret scan: clean.

## Production read-only validation

Production не изменялась. Read-only SSH/SQL-проверка подтвердила self-hosted
backend role `komui_app` без `BYPASSRLS`, отсутствие Supabase `service_role` и
нулевые значения семи payment migration preflight counters на момент аудита:
исторические `PARTIAL_REVERSED`/`AUTH_FAIL`, amount mismatch на fulfillable
заказах, full cancel/refund с живой доставкой, direct partial refund без более
раннего `CONFIRMED` и `AUTH_FAIL`, ошибочно спроецированный в
`payment_failed`. Эти counters обязательно повторяются после остановки writes
в maintenance window; прежний ноль не является разрешением на deploy.

## P2 и операционные ограничения

1. Невозможное по provider-контракту cross-order противоречие, когда
   `PaymentId` уже принадлежит заказу X, а подписанный webhook содержит другой
   `OrderId`, обрабатывается fail-closed: транзакция откатывается, HTTP получает
   `409`, мутаций нет, событие остаётся в structured logs. Отдельная durable
   anomaly/inbox-запись для такого случая — полезный follow-up.
2. Migration
   `supabase/migrations/20260830143000_harden_payment_consistency.sql`
   проверена статически и regression-тестом, но не применялась и не парсилась
   реальным PostgreSQL в этой локальной задаче. Staging/live provider E2E также
   не выполнялся.
3. `INIT_REVIEW` намеренно является absorbing manual-review состоянием:
   одиночный поздний provider status не может автоматически разрешить конфликт
   нескольких PaymentId/boundary.

## Явно принятая бизнес-политика

- Нормальный переход `paid -> partially_refunded` остаётся fulfillable: без
  line-item refund semantics система не может автоматически решить, надо ли
  отменять всю доставку. Direct `PARTIAL_REFUNDED` без ранее подтверждённого
  `CONFIRMED` блокируется в `payment_review`.
- Полный refund/reversal и causal review-конфликты отменяют доставку через
  durable effect независимо от доступности CDEK.

Commit, migration apply, staging/production deploy и внешние provider mutations
не выполнялись.
