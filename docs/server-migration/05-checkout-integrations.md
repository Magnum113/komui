# Этап 5. Checkout, Т-Банк, СДЭК, промокоды и admin jobs

Статус на 26 июня 2026 года: частично завершён.

Checkout-контур перенесён в собственный Fastify backend и развёрнут на
`stage.komui.ru` в mock-staging режиме. Production Supabase/Vercel/webhook/DNS
не изменялись.

Полный этап 5 пока нельзя считать закрытым, потому что не реализован Ozon
dual-write admin job и не переданы реальные/demo credentials для внешних
интеграций. Это не блокирует следующий frontend/staging этап, но блокирует
production cutover.

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
POST /supabase-function?name=<old-name>
POST /api/supabase-function?name=<old-name>

POST /admin/ozon/products/import-preview
POST /admin/ozon/products/import
GET  /admin/jobs/:id
```

Реализованы и проверены:

- `POST /v1/delivery/points`;
- `POST /v1/delivery/quote`;
- `POST /v1/promos/validate`;
- `POST /v1/payments`;
- `POST /v1/payments/status`;
- `POST /v1/webhooks/tbank`;
- compatibility route для старого frontend:
  `POST /api/supabase-function?name=<old-name>`.

Не реализованы:

- `POST /admin/ozon/products/import-preview`;
- `POST /admin/ozon/products/import`;
- `GET /admin/jobs/:id`.

Причина: для корректной реализации нужны Ozon credentials, server-only
Supabase write credential и утверждённые правила маппинга Ozon → storefront
schema. Без этого безопасная “одна кнопка” будет имитацией, а не рабочим
механизмом.

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

Фактическое состояние:

- исторический frontend до этапа 6 использовал `data/supabase-config.js`;
- исторический `functionsProxyUrl` указывал на `/api/supabase-function`;
- backend сохраняет compatibility-route для старого frontend до production cutover;
- поддержаны имена:
  - `cdek-delivery-points`;
  - `cdek-delivery-quote`;
  - `promo-validate`;
  - `tbank-create-payment`;
  - `tbank-payment-status`.

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

- повторный `client_request_id` — реализован в коде, ручной smoke не повторялся;
- параллельное использование последнего промокода — требует отдельного
  concurrency-теста;
- неверная подпись webhook — реализована проверка, нужен отдельный тест;
- повторный webhook — event hash идемпотентен, нужен отдельный тест;
- webhook с другой суммой — реализован перевод в `payment_review`, нужен
  отдельный тест;
- timeout Т-Банка — реализована controlled failure ветка, нужен отдельный тест;
- timeout СДЭК — controlled failure зависит от real credentials, в mock не
  проверялся;
- повторное создание CDEK shipment — создание shipment на staging отключено;
- запрет реального shipment при staging feature flag — `CDEK_CREATE_SHIPMENTS=false`;
- status с неверным access token — реализована hash/constant-time проверка;
- недоверенная цена в browser payload — backend пересчитывает цены из DB;
- DB rollback при частичной ошибке — создание заказа и payment attempt находятся
  в короткой transaction до внешнего вызова.

Автоматические тесты backend:

- `npm --prefix server run build` — OK;
- `npm --prefix server test` — 13 tests OK.

Staging smoke:

- `/v1/delivery/points` — OK, mock PVZ;
- `/v1/delivery/quote` — OK, mock tariff 136, 390 ₽;
- `/v1/promos/validate` — OK, `KOMUI10`;
- `/v1/payments` — OK, создан mock payment/order в `komui_staging`;
- `/v1/payments/status` — OK, `pending_payment` / `MOCK_INIT`;
- `/api/supabase-function?name=promo-validate` через `stage.komui.ru` — OK.

## Результат

Checkout-контур работает в mock-staging без Supabase Edge Functions.

Текущее staging-состояние:

- release: `/opt/komui/releases/20260626121442-stage5-checkout`;
- backend: `komui-backend.service`, active;
- домен: `https://stage.komui.ru`;
- TLS: Let’s Encrypt certificate for `stage.komui.ru`, expires 2026-09-24;
- Basic Auth: включён;
- noindex headers: включены;
- backend bind: `127.0.0.1:3000`;
- PostgreSQL bind: `127.0.0.1:5432`;
- T-Bank: `TBANK_MOCK_PAYMENTS=true`;
- CDEK: `CDEK_MOCK=true`, `CDEK_CREATE_SHIPMENTS=false`;
- production smoke: `komui.ru=200`, `www.komui.ru=200`, `api.komui.ru=404`.

## GO

GO только для перехода к этапу 6 в staging.

Причина: checkout API готов к подключению frontend на staging, но реальные
payment/CDEK/Ozon side effects отключены.

Full Stage 5 GO ещё не достигнут.

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

Текущие NO-GO для production:

- T-Bank/CDEK credentials на сервере распознаны, но полный payment/webhook E2E
  ещё не пройден владельцем;
- `TBANK_MOCK_PAYMENTS=false`, T-Bank mode — `demo`;
- `CDEK_MOCK=false`, но `CDEK_CREATE_SHIPMENTS=false`;
- Ozon import admin job не реализован;
- не пройдены реальные webhook/CDEK shipment тесты;
- не реализован admin UI для переключения fallback/traffic mode.

## Rollback

Production продолжает использовать старые Edge Functions. Не переключать webhook до этапа 8.
