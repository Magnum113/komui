# Payment consistency fixes — inputs

## User request

Correctly plan, implement, and test the first three P1 findings from the 2026-08-30 audit:

1. Make T-Bank webhook processing transactional, idempotent, and monotonic under duplicate, concurrent, and out-of-order notifications.
2. Remove the double-payment window after an ambiguous T-Bank `/Init` result or a failure while persisting a successful provider response.
3. Cancel or otherwise reconcile the CDEK shipment when a payment is refunded/reversed, without making the payment webhook depend on a slow provider call.

## Constraints

- Preserve current public API compatibility unless a safer response is required.
- Do not deploy or mutate production during implementation.
- Do not expose credentials or production customer/order identifiers.
- Prefer durable state and retryable jobs over network calls inside payment transactions or webhooks.
- Add regression tests for duplicate/concurrent/out-of-order events and provider failure boundaries.
- Update project documentation after implementation.

## External contracts checked

- T-Bank `/v2/CheckOrder` accepts the merchant `OrderId` and is the recovery path when `/Init` may have succeeded but its response was lost.
- T-Bank `/v2/GetState` accepts a known `PaymentId`.
- T-Bank expects an HTTP webhook acknowledgement within 10 seconds.
- CDEK v2 cancels a created order with `DELETE /v2/orders/{uuid}`; cancellation may fail after the shipment has advanced and must remain visible for operator action.
