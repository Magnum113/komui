# Ozon Delivery: KOMUI + GetoMerch

Orders placed on komui.ru remain `source=storefront` in `merch_customer_orders`. Delivery provider is `ozon`; management is **GetoMerch → Админка Komui → Заказы сайта**, `/komui/orders`. Marketplace `/orders` and `merch_ozon_orders` are independent.

## Buyer and fulfillment flow

1. Runtime `/api/delivery-config` exposes Ozon only after configuration and point-cache readiness. Buyer enters their Ozon account phone, chooses PVZ; server checks account, point availability, package dimensions and current delivery + insurance price.
2. Before bank initialization the backend recalculates delivery and compares the integer kopeck amount accepted by the browser. A changed price requires a new selection. No automatic increase is charged.
3. The signed bank webhook/reconciliation changes the financial state. The PostgreSQL trigger queues `ozon_create` in the same transaction as `paid`; browser return does not initiate delivery.
4. Worker persists a UUID idempotency key and exact request before the Ozon call. Ambiguous responses retry the same key/body. Shipment numbers and status history are separate tables.
5. Manager packs the order, checks displayed dimensions/weight, then confirms readiness in the KOMUI order card. Confirmation is asynchronous and may fail if balance/parameters are invalid. Ready-for-shipping is not a physical handover. Download/print PDF only when available.
6. Polling derives physical shipping/delivery from Ozon statuses. Transactional emails use Ozon wording and app pickup instructions; obsolete notifications are suppressed.
7. Cancellation is durable even before creation; cancellation after handover can initiate a physical return. A refund at T-Bank is a separate operation. Return `received` means received by the merchant, distinct from cancellation.

Initial release: PVZ and one parcel per order. T-shirts: 300×230×40 mm, 250 g each. Other products use existing package profiles; parcel height/weight sum quantities. If actual packaging differs, do not approve blindly; inspect in the Ozon cabinet. Preparation allowance defaults to 48 hours and is configurable. No automated marketplace product/order synchronization is added.

## Production configuration

KOMUI service: `komui-production-backend.service`; env `/etc/komui/backend-production.env` (server-only). Credentials must never be committed, logged, passed to the browser or entered in marketplace settings.

- `OZON_DELIVERY_CLIENT_ID`, `OZON_DELIVERY_CLIENT_SECRET`: existing private-app credentials.
- `OZON_DELIVERY_SHIPMENT_METHOD_ID=1020005031453430`: verified active method on 2026-09-28, dropoff/return Махачкала, улица Сурикова, 36а.
- `OZON_DELIVERY_ENABLED=false`: initial rollout; true only after point-cache warmup and both applications deployed.
- `OZON_DELIVERY_WORKER_ENABLED=true`: process existing orders even if new checkout selection is disabled.
- `OZON_DELIVERY_STATUS_EMAILS_SINCE=<launch UTC ISO timestamp>`: prevents historical status notifications.
- `OZON_DELIVERY_PREPARATION_HOURS=48`; `OZON_DELIVERY_SYNC_INTERVAL_MS=600000`; request timeout default 15000 ms.

Apply additive `db/migrations/20260928190000_add_ozon_delivery.sql` with backup and error-on-first-failure. It creates dedicated tables, effect kinds and the financial-state trigger. Deploy storefront/backend and GetoMerch independently using their existing release drivers. Stage must not run real Ozon fulfillment with production credentials.

From the backend release directory, with the existing protected service environment loaded, run `node dist/ozonDeliveryReadiness.js --warm-points`. It authenticates, verifies configured method, reads Ozon point data and writes only the local PVZ cache. It never creates/approves/cancels shipments. Keep ENABLED=false during warmup; then enable checkout selection and restart backend. Cache must have a completed scan no older than three days; normal worker refresh starts after one day.

## Monitoring and rollback

Check service health, runtime delivery providers, public city/PVZ search, admin provider filter and shipping card. Inspect effect status/attempts/errors and worker logs without dumping payloads/phones/tokens. `needs_review` requires an operator; do not blindly create another Ozon order. Retry retains the persisted request identity.

To pause new Ozon orders, set ENABLED=false while leaving WORKER_ENABLED=true. Existing shipments continue status/cancellation processing. After actual Ozon orders exist, prefer disabling new selection over reverting to pre-Ozon backend. Do not remove delivery tables/jobs while orders remain active. Preserve previous immutable release and env backup for rollback.

Real shipment creation/approval is not used as a deployment health check. First real order still requires normal packing, label and physical acceptance validation by the merchant.

Official API: https://docs.ozon.ru/api/ozon-delivery/
