# Phase 05 report — checkout/integrations staging

Дата: 26 июня 2026 года.

## Итог

Stage 5 частично выполнен.

Собственный backend теперь покрывает checkout-интеграции, которые раньше
обслуживались Supabase Edge Functions:

- CDEK delivery points;
- CDEK delivery quote;
- promo validation;
- T-Bank payment init;
- T-Bank payment status;
- T-Bank webhook handler;
- compatibility route `/api/supabase-function?name=<old-name>`.

Реальные внешние side effects отключены. Staging работает в mock mode.

## Production isolation

Не изменялись:

- `komui.ru`;
- `www.komui.ru`;
- `api.komui.ru`;
- Vercel deployment;
- Supabase production data;
- production T-Bank webhook/callback URL.

Production smoke после работ:

```text
komui.ru      -> 200
www.komui.ru  -> 200
api.komui.ru  -> 404
```

## Сервер

Активный release:

```text
/opt/komui/releases/20260626121442-stage5-checkout
```

Сервис:

```text
komui-backend.service -> active
```

Порты:

```text
127.0.0.1:3000  backend
127.0.0.1:5432  PostgreSQL
```

Внешние 3000/5432 не открыты.

## Домен stage.komui.ru

DNS:

```text
stage.komui.ru A 89.111.152.112
```

Nginx:

- HTTP redirects to HTTPS;
- HTTPS vhost добавлен;
- Let’s Encrypt certificate выпущен для `stage.komui.ru`;
- expires: 2026-09-24;
- Basic Auth включён;
- `X-Robots-Tag: noindex, nofollow, noarchive`.

Проверки:

```text
http://stage.komui.ru/api/health/live   -> 301
https://stage.komui.ru/api/health/live  -> 401 без Basic Auth
https://stage.komui.ru/api/health/live  -> 200 с Basic Auth
https://stage.komui.ru/api/v1/products  -> 200 с Basic Auth
```

## Реализованные backend routes

```text
POST /v1/delivery/points
POST /v1/delivery/quote
POST /v1/promos/validate
POST /v1/payments
POST /v1/payments/status
POST /v1/webhooks/tbank
POST /supabase-function?name=<old-name>
POST /api/supabase-function?name=<old-name>
```

Compatibility route поддерживает:

```text
cdek-delivery-points
cdek-delivery-quote
promo-validate
tbank-create-payment
tbank-payment-status
```

## Проверки

Локально:

```text
npm --prefix server run build -> OK
npm --prefix server test      -> 13 tests OK
```

Staging smoke через backend localhost:

```json
{
  "product": {
    "id": "7c169f01-b459-4e25-b74f-a4909a1b4149",
    "size": "S"
  },
  "points": 1,
  "quote": {
    "amount": 39000,
    "tariffCode": 136
  },
  "promo": {
    "valid": true,
    "discountAmount": 29000
  },
  "payment": {
    "orderNumber": "KOM-260626-1CRNSNY",
    "amount": 300000,
    "paymentId": "mock-KOM-260626-1CRNSNY",
    "mockUrl": true
  },
  "status": {
    "status": "pending_payment",
    "providerStatus": "MOCK_INIT"
  },
  "compat": {
    "valid": true,
    "discountAmount": 29000
  }
}
```

Staging smoke через `stage.komui.ru` с Basic Auth:

```text
/api/health/live -> 200
/api/v1/products?limit=1 -> 200
/api/supabase-function?name=promo-validate -> 200
```

## Ограничения

Текущий режим:

```text
TBANK_MODE=demo
TBANK_MOCK_PAYMENTS=true
CDEK_MOCK=true
CDEK_CREATE_SHIPMENTS=false
```

Это означает:

- реальные платежи не создаются;
- реальные CDEK тарифы не запрашиваются;
- реальные CDEK отправления не создаются;
- webhook можно проверить только синтетически, пока нет T-Bank credentials;
- все созданные заказы остаются только в `komui_staging`.

## Что требуется от владельца

Для завершения полного этапа 5:

1. T-Bank demo terminal key/password.
2. T-Bank production terminal key/password — позже, только перед cutover.
3. CDEK API credentials.
4. Решение, есть ли безопасный CDEK sandbox; если нет — shipment creation
   оставлять feature-flagged до production rehearsal.
5. Ozon Client-Id/API-Key.
6. Server-only Supabase write credential для текущего проекта, если нужен
   dual-write импорт товаров до production cutover.
7. Правила маппинга Ozon → KOMUI catalog/storefront/inventory/images.
8. Решение по публикации новых Ozon товаров: auto-publish или draft/manual
   review.

## Решение

GO к этапу 6 для frontend/staging wiring.

NO-GO для production cutover и полного закрытия Stage 5 до передачи credentials,
реальных интеграционных тестов и реализации Ozon dual-write admin job.
