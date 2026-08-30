# Context

## Existing payment flow

- `server/src/stage5.ts` owns checkout creation, T-Bank `/Init`, customer payment status, and the T-Bank webhook.
- The order, items, promo reservation, and payment attempt are committed before the external `/Init` call.
- A network exception currently records `NETWORK_ERROR`, sets the order to `payment_failed`, releases the promo, and allows the browser to create a new merchant order.
- The webhook currently inserts an event, updates the payment attempt and order in separate statements, then synchronously redeems/releases promo state and calls CDEK before replying `OK`.
- `server/src/cdekShipments.ts` persists shipments and performs CDEK create/retry work.

## Existing invariants worth preserving

- Prices, delivery, discounts, and receipt lines are calculated server-side.
- T-Bank tokens are verified with a constant-time comparison.
- `client_request_id`, order number, external payment id, payment event hash, and shipment order id already have uniqueness constraints.
- CDEK and T-Bank calls have bounded request timeouts.

## Failure modes to close

- Two valid webhook notifications can read the same old order status and apply incompatible writes.
- A duplicate event still performs downstream work after `ON CONFLICT DO NOTHING`.
- A successful `/Init` whose HTTP response is lost is indistinguishable from a provider rejection.
- A successful provider response followed by a local persistence failure leaves the merchant without a payment URL even though the payment exists.
- A refund changes payment state but does not cancel an already-created CDEK shipment.
- Slow CDEK calls before webhook acknowledgement cause retries and amplify webhook races.

## Target model

- Persist payment facts in a short transaction; perform external side effects through durable jobs.
- Treat an ambiguous provider boundary as `payment_unknown`, never as a retry-safe terminal failure.
- Reconcile by stable merchant `OrderId` using `/CheckOrder`, and by `PaymentId` using `/GetState` once known.
- Process every webhook event at most once and enforce a monotonic order/payment transition graph.
- Model CDEK cancellation as an idempotent durable job with explicit success, retry, and operator-review outcomes.
