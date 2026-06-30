# API ведения заказов витрины KOMUI

Документ для внедрения раздела заказов в отдельной админке. Визуал можно делать любым, но читать и менять заказы нужно через Komui backend `/admin/...`, а не напрямую из браузера в базу.

В проекте есть два контура данных:

- server PostgreSQL на отдельном сервере, подключается Komui backend через `DATABASE_URL`;
- Supabase project `bkxpzfnglihxpbnhtjjq`, исторический/legacy контур и источник Edge Functions.

Этот API заказов работает с server PostgreSQL. Миграцию из этого документа нужно применить к той базе, которую реально читает Komui backend. Если production-заказы всё ещё создаются/читаются через Supabase Edge Functions напрямую, такой же schema change нужен и в Supabase, либо нужно сначала перевести checkout на Komui backend `/api`.

## Что уже было в заказах

До этой правки у заказа уже было поле `merch_customer_orders.status`, но это **payment status**, то есть состояние оплаты:

- `created` - заказ создан до обращения в Т-Банк;
- `pending_payment` - платёж создан, клиент ещё не оплатил;
- `authorized` - платёж авторизован;
- `paid` - платёж подтверждён;
- `payment_failed` - платёж не прошёл;
- `payment_review` - нужна ручная проверка, например сумма webhook не совпала;
- `canceled`;
- `partially_refunded`;
- `refunded`.

Этим статусом управляют checkout и webhook Т-Банка в `server/src/stage5.ts`. Админка не должна использовать его как “отправлено”, иначе можно сломать платёжную логику.

Также есть отдельная таблица `merch_cdek_shipments` со статусами создания накладной СДЭК:

- `pending`;
- `creating`;
- `accepted`;
- `created`;
- `invalid`;
- `failed`;
- `deleted`;
- `unknown`.

Это статус CDEK-заказа/накладной, а не ручной статус “я отправил клиенту”.

## Что добавлено для админки

Добавлена миграция:

```text
supabase/migrations/20260630130000_add_storefront_order_fulfillment.sql
```

Она добавляет в `public.merch_customer_orders` отдельные поля обработки заказа:

| колонка | тип | смысл |
|---|---|---|
| `fulfillment_status` | text | ручной статус обработки заказа |
| `fulfillment_note` | text nullable | внутренняя заметка админа |
| `shipped_at` | timestamptz nullable | когда нажали “отправил” |
| `delivered_at` | timestamptz nullable | когда отметили доставленным |

Значения `fulfillment_status`:

- `new` - новый, ещё не обрабатывался;
- `processing` - в работе/собирается;
- `shipped` - отправлено;
- `delivered` - доставлено;
- `canceled` - отменено по обработке;
- `returned` - возвращено.

Важно: `paymentStatus` и `fulfillmentStatus` в API разные поля.

## Авторизация

Все endpoints защищены тем же admin token:

```http
Authorization: Bearer <ADMIN_API_TOKEN>
```

или:

```http
x-komui-admin-token: <ADMIN_API_TOKEN>
```

Не класть `ADMIN_API_TOKEN` в браузер. В отдельной админке лучше сделать свой server-side BFF, который хранит токен в env и ходит в Komui backend.

## Endpoints

### 1. Список заказов

```http
GET /admin/storefront/orders?limit=50&offset=0&paymentStatus=paid&fulfillmentStatus=new&q=KOM-123
```

Query:

| поле | тип | описание |
|---|---|---|
| `limit` | number | 1-200, default `50` |
| `offset` | number | default `0` |
| `q` | string | поиск по номеру заказа, телефону, имени, фамилии, городу, коду ПВЗ |
| `paymentStatus` | enum | фильтр по оплате |
| `status` | enum | alias для `paymentStatus` |
| `fulfillmentStatus` | enum | фильтр по обработке |
| `dateFrom` | ISO/date string | `created_at >= dateFrom` |
| `dateTo` | ISO/date string | `created_at <= dateTo` |

Ответ:

```json
{
  "orders": [
    {
      "id": "7c169f01-b459-4e25-b74f-a4909a1b4149",
      "orderNumber": "KOM-123456789",
      "paymentStatus": "paid",
      "fulfillmentStatus": "new",
      "fulfillmentNote": null,
      "customer": {
        "firstName": "Иван",
        "lastName": "Иванов",
        "phone": "+79995330015",
        "marketingConsent": true
      },
      "delivery": {
        "provider": "cdek",
        "pointCode": "KOMUI-STAGE-PVZ",
        "city": "Москва",
        "address": "ул. Тестовая, 1",
        "hours": "10:00-21:00",
        "eta": "2-3 дня"
      },
      "amounts": {
        "subtotal": 290000,
        "discount": 0,
        "delivery": 35000,
        "total": 325000,
        "currency": "RUB"
      },
      "promoCode": null,
      "source": "storefront",
      "itemCount": 2,
      "lineCount": 1,
      "latestPayment": {
        "providerStatus": "CONFIRMED",
        "errorCode": null,
        "errorMessage": null
      },
      "cdek": {
        "status": "created",
        "uuid": "cdek-uuid",
        "number": "10288069122",
        "errorMessage": null
      },
      "paidAt": "2026-06-30T09:05:00.000Z",
      "shippedAt": null,
      "deliveredAt": null,
      "createdAt": "2026-06-30T09:00:00.000Z",
      "updatedAt": "2026-06-30T09:05:00.000Z"
    }
  ],
  "pagination": {
    "limit": 50,
    "offset": 0,
    "total": 13
  },
  "statuses": {
    "payment": ["created", "pending_payment", "authorized", "paid", "payment_failed", "payment_review", "canceled", "partially_refunded", "refunded"],
    "fulfillment": ["new", "processing", "shipped", "delivered", "canceled", "returned"]
  }
}
```

Деньги в ответе в копейках, как в таблицах заказов. Для UI делить на 100.

### 2. Карточка заказа

```http
GET /admin/storefront/orders/:orderId
```

Ответ содержит:

- `order` - тот же summary-объект, что в списке;
- `items` - товары заказа;
- `paymentAttempts` - попытки платежа Т-Банк;
- `paymentEvents` - последние webhook-события оплаты;
- `cdekShipment` - накладная/заказ СДЭК, если создана;
- `cdekEvents` - последние события СДЭК, если есть.

### 3. Кнопка “отправил”

```http
POST /admin/storefront/orders/:orderId/mark-shipped
Content-Type: application/json
Authorization: Bearer <ADMIN_API_TOKEN>
```

Payload необязательный:

```json
{
  "note": "Передано в СДЭК"
}
```

Что делает сервер:

- проверяет, что `paymentStatus` заказа `paid` или `authorized`;
- не трогает `merch_customer_orders.status`;
- ставит `fulfillment_status = 'shipped'`;
- ставит `shipped_at = now()`, если он ещё пустой;
- сохраняет `fulfillment_note`, если передали `note`;
- пишет admin audit event.

Ответ:

```json
{
  "order": {
    "id": "7c169f01-b459-4e25-b74f-a4909a1b4149",
    "orderNumber": "KOM-123456789",
    "paymentStatus": "paid",
    "fulfillmentStatus": "shipped",
    "shippedAt": "2026-06-30T10:00:00.000Z"
  }
}
```

Если заказ не оплачен:

```json
{
  "error": {
    "code": "order_not_ready_to_ship",
    "message": "Only paid or authorized orders can be marked as shipped",
    "details": {
      "paymentStatus": "pending_payment"
    }
  }
}
```

### 4. Универсальное изменение обработки

```http
PATCH /admin/storefront/orders/:orderId/fulfillment
Content-Type: application/json
Authorization: Bearer <ADMIN_API_TOKEN>
```

Payload:

```json
{
  "status": "processing",
  "note": "Собираем заказ"
}
```

Можно ставить статусы:

```text
new, processing, shipped, delivered, canceled, returned
```

Если поставить `shipped`, логика такая же, как у кнопки “отправил”.
Если поставить `delivered`, сервер также заполнит `shipped_at`, если он был пустой, и заполнит `delivered_at`.

## Рекомендации для UI

1. В списке заказов показывать два статуса отдельно: `paymentStatus` и `fulfillmentStatus`.
2. Кнопку “отправил” показывать только если `paymentStatus` равен `paid` или `authorized` и `fulfillmentStatus` не `shipped`/`delivered`.
3. В карточке заказа показывать CDEK номер из `order.cdek.number` или `cdekShipment.number`.
4. Не менять `paymentStatus` вручную из админки. Он должен приходить от Т-Банк webhook.
5. Для фильтра “к отправке” использовать `paymentStatus=paid&fulfillmentStatus=new`.
6. Для фильтра “отправлено” использовать `fulfillmentStatus=shipped`.
7. Если нужно создать/повторить СДЭК накладную, использовать уже существующий endpoint `POST /admin/cdek/shipments/create` с `confirm: true`.

## Минимальный сценарий внедрения

1. Добавить экран “Заказы Komui”.
2. Загрузить `GET /admin/storefront/orders?limit=50&offset=0`.
3. Показать номер заказа, дату, клиента, телефон, сумму, `paymentStatus`, `fulfillmentStatus`, CDEK номер.
4. По клику открыть `GET /admin/storefront/orders/:id`.
5. В карточке показать товары, доставку, платежи и CDEK.
6. Кнопка “отправил” вызывает `POST /admin/storefront/orders/:id/mark-shipped`.
7. После успешного ответа заменить заказ в UI объектом `order` из ответа.
