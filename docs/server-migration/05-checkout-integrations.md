# Этап 5. Checkout, Т-Банк, СДЭК, промокоды и admin jobs

## Цель

Перенести шесть Supabase Edge Functions в собственный backend без изменения финансовой логики и гарантий идемпотентности.

Дополнительно: реализовать admin job для импорта новых товаров из Ozon с
возможностью безопасного dual-write в текущий Supabase и новую серверную БД.

## Зависимости

- Backend foundation готов.
- Test PostgreSQL содержит полную схему.
- Есть demo/test credentials Т-Банка и СДЭК.
- Production credentials не сохраняются в Git.

До production cutover backend запускается только в staging mode:

- Т-Банк — только demo/test terminal;
- webhook — отдельный staging endpoint;
- СДЭК — поиск ПВЗ и расчёт допускаются, создание реального shipment отключено;
- production callback URLs не меняются;
- test orders сохраняются только в staging PostgreSQL;
- запись в текущий Supabase запрещена по умолчанию;
- dual-write в Supabase разрешается только отдельной admin-командой владельца
  и только для явно поддержанных операций, начиная с импорта новых товаров Ozon.

## Маршруты

```text
POST /v1/delivery/points
POST /v1/delivery/quote
POST /v1/promos/validate
POST /v1/payments
POST /v1/payments/status
POST /v1/webhooks/tbank

POST /admin/ozon/products/import-preview
POST /admin/ozon/products/import
GET  /admin/jobs/:id
```

## Действия

### 5.1. Общий перенос

- Перенести чистые функции расчёта.
- Заменить `Deno.env.get` на config module.
- Заменить `supabase-js` на repositories.
- Заменить `Deno.serve` на Fastify routes.
- Сохранить совместимую форму JSON.
- Добавить input schemas и rate limits.

### 5.2. Платёж

Сохранить:

- серверный пересчёт цен;
- проверку доступности товара;
- пересчёт СДЭК;
- применение промокода на сервере;
- `client_request_id`;
- access token hash;
- payment attempts;
- подпись Т-Банка;
- отсутствие доверия redirect пользователя.

Внешний вызов Т-Банка не держать внутри долгой SQL-транзакции.

### 5.3. Webhook

- В staging используется отдельный тестовый URL.
- Будущий production URL: `https://api.komui.ru/v1/webhooks/tbank`.
- Проверять подпись constant-time сравнением.
- Сравнивать amount/payment/order.
- Хранить уникальный event hash.
- Повторный webhook должен быть безопасным.
- Только валидный webhook переводит заказ в `paid`.

### 5.4. СДЭК

- Перенести OAuth cache.
- Проверять город и ПВЗ.
- Пересчитывать тариф при создании платежа.
- Не повторять создание отправления вслепую.
- Сохранять shipment единственным по `order_id`.
- Настроить timeouts и безопасные retries.
- Добавить явный feature flag `CDEK_CREATE_SHIPMENTS=false` для staging.
- Тест создания shipment проводить через mock/fixture, если API СДЭК не предоставляет безопасный sandbox.

### 5.5. Промокоды

- Нормализация.
- Даты активности.
- Общий и per-phone limit.
- Reservation/redeem/release.
- Защита от гонок через transaction/row lock.

### 5.6. Compatibility route

Временно поддержать:

```text
POST /api/supabase-function?name=<old-name>
```

Это позволяет сначала заменить инфраструктуру, затем frontend.

### 5.7. Admin job: импорт новых товаров из Ozon

Цель: владелец нажимает одну кнопку в админке, backend получает новые товары из
Ozon и дополняет две базы:

1. текущий production Supabase;
2. новую PostgreSQL на сервере.

Обязательная модель:

- `import-preview` сначала показывает diff без записи;
- `import` запускает job, а не долгий HTTP request;
- job идемпотентен по Ozon identifiers / offer IDs / SKU;
- повторный запуск не создаёт дубли;
- каждая запись имеет audit event: кто запустил, когда, source payload hash,
  какие строки созданы/обновлены/пропущены;
- partial failure не скрывается: статус должен показывать, какая база успела
  обновиться, а какая требует retry;
- retry должен дописывать только отсутствующую сторону;
- raw Ozon payload хранится только в server-side таблицах и не отдаётся в
  публичный API;
- Supabase service credential хранится только на сервере, root-only, не в Git;
- в staging по умолчанию доступен dry-run и запись только в серверную БД.

Техническое ограничение: PostgreSQL на сервере и Supabase — две разные базы.
Настоящей distributed transaction между ними не будет. Поэтому используется
saga/outbox-подход: шаги фиксируются по отдельности, а консистентность
достигается идемпотентностью, retry и audit log.

Перед включением real dual-write нужны:

- Ozon Client-Id/API-Key;
- Supabase write credential для текущего проекта;
- точные правила маппинга Ozon → `merch_products`,
  `merch_storefront_products`, inventory и images;
- решение, какие товары автоматически публиковать на витрину, а какие
  оставлять в draft/manual review.

## Обязательные тесты

- повторный `client_request_id`;
- параллельное использование последнего промокода;
- неверная подпись webhook;
- повторный webhook;
- webhook с другой суммой;
- timeout Т-Банка;
- timeout СДЭК;
- повторное создание CDEK shipment;
- запрет реального shipment при staging feature flag;
- status с неверным access token;
- недоверенная цена в browser payload;
- DB rollback при частичной ошибке.

## Результат

Полный checkout-контур работает в demo/staging без Supabase Edge Functions.

## GO

Полный E2E от корзины до подтверждённого webhook и записи shipment проходит повторяемо.

## NO-GO

- заказ может стать paid по redirect;
- возможен двойной shipment;
- нет защиты промокода от гонок;
- browser price влияет на итог;
- webhook не идемпотентен;
- тесты выполняются только вручную;
- Ozon import может создать дубли;
- Ozon import пишет только в одну из двух баз без явного статуса и retry;
- admin job использует browser-exposed Supabase key вместо server-only
  credential.

## Rollback

Production продолжает использовать старые Edge Functions. Не переключать webhook до этапа 8.
