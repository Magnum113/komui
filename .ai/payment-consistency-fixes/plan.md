# Implementation plan

Статус этой implementation-задачи: выполнено локально и проверено;
migration/deploy в её рамках не выполнялись. Последующий staging rollout
зафиксирован в `.ai/staging-payment-consistency-deploy/`; production не
изменялась.

## Phase 1 — freeze state-machine invariants

1. Define provider-status and order-status transition helpers with explicit terminal and monotonic rules.
2. Define which mismatches move an order to `payment_review` rather than silently changing financial state.
3. Add unit tests for the transition matrix before routing production code through it.

## Phase 2 — transactional webhook inbox

1. Validate terminal key and signature before opening a transaction.
2. In one short transaction, resolve and lock the payment attempt and order.
3. Insert the canonical event with `ON CONFLICT ... DO NOTHING RETURNING`; acknowledge an existing event without reprocessing it.
4. Validate `PaymentId`, `OrderId`, and amount against the locked records.
5. Apply provider/order status with guarded monotonic updates.
6. Enqueue fulfillment/promo work in a durable outbox inside the same transaction.
7. Commit and immediately return `OK`; never wait for CDEK inside the webhook.

## Phase 3 — ambiguous Init and reconciliation

1. Keep the merchant order number stable and persist the full request boundary before `/Init`.
2. On timeout/network/response-persistence uncertainty, use `payment_unknown`/`INIT_UNKNOWN`, keep the promo reservation, and return a non-retryable-for-new-order response.
3. Add a signed `/CheckOrder` provider call by merchant `OrderId`; use `/GetState` when `PaymentId` is known.
4. Add a bounded reconciler that adopts a terminal/financial payment fact discovered at the provider. Because `CheckOrder`/`GetState` cannot recover the opaque payment-form URL, cancel a discovered orphan in `NEW` and permit a fresh order only after T-Bank confirms a terminal canceled state.
5. Make repeated browser requests return the recovered payment or a clear "still reconciling" response instead of creating another order.

## Phase 4 — refund-to-CDEK cancellation

1. Add an idempotent CDEK cancellation operation using the persisted CDEK UUID.
2. Enqueue cancellation on refund/reversal in the payment transaction.
3. Process cancellation outside the webhook with a lease/claim, retry metadata, and an operator-review state for non-retryable provider rejection.
4. Preserve payment truth even when CDEK is unavailable.

## Phase 5 — migration and compatibility

1. Add only forward-compatible schema changes with safe defaults and indexes.
2. Ensure existing paid/refunded orders can be reconciled without rewriting historical financial facts.
3. Keep existing public checkout/payment-status response fields, adding machine-readable recovery state where required.

## Phase 6 — verification

1. Unit tests for state transitions, signing, CheckOrder/GetState mapping, CDEK cancel mapping, retry classification, and duplicate events.
2. DB-backed or transaction-aware tests for duplicate/out-of-order webhook and outbox uniqueness where the repository test harness permits.
3. Failure injection for Init timeout, successful Init followed by persistence failure, CDEK timeout, and duplicate refund.
4. Run server tests, TypeScript build/typecheck, migration/static checks, and the existing root/ops regression suites.
5. Independent review; fix material findings and record any deferred operational step.
