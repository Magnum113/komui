# Этап 5. Checkout, Т-Банк, СДЭК, промокоды и admin jobs

Статус на 30 июня 2026 года: частично завершён.

Checkout-контур перенесён в собственный Fastify backend и развёрнут на
`stage.komui.ru`. Production Supabase/Vercel/webhook/DNS не изменялись.

Checkout, T-Bank demo payment/webhook и CDEK shipment creation проверены на
staging. Полный этап 5 пока нельзя считать закрытым для production, потому что
Ozon dual-write в Supabase выключен флагом и требует отдельной финальной
приёмки маппинга/импорта. Это не блокирует staging, но блокирует production
cutover.

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
- СДЭК — поиск ПВЗ, расчёт и создание shipment включены на staging по явному
  разрешению владельца;
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
GET  /admin/ozon/jobs/:jobId
POST /admin/cdek/shipments/create
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
- `POST /admin/ozon/products/import-preview`;
- `POST /admin/ozon/products/import`;
- `GET /admin/ozon/jobs/:jobId`;
- `POST /admin/cdek/shipments/create`.

Текущее ограничение Ozon import: запись в текущий Supabase выключена флагом
`OZON_IMPORT_WRITE_SUPABASE=false`. Backend умеет preview/import/job status, но
финальный режим dual-write нужно включать только отдельным решением владельца
после проверки маппинга Ozon → storefront schema.

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
- Управлять созданием shipment через явный feature flag
  `CDEK_CREATE_SHIPMENTS`.
- На staging флаг включён: `CDEK_CREATE_SHIPMENTS=true`.
- Тестовые paid-заказы на staging теперь создают реальные CDEK shipment.

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
- повторное создание CDEK shipment — защищено единственной записью по order_id
  и ручным retry endpoint;
- запрет реального shipment при staging feature flag — реализован кодом, но
  текущий staging работает с `CDEK_CREATE_SHIPMENTS=true` по разрешению
  владельца;
- status с неверным access token — реализована hash/constant-time проверка;
- недоверенная цена в browser payload — backend пересчитывает цены из DB;
- DB rollback при частичной ошибке — создание заказа и payment attempt находятся
  в короткой transaction до внешнего вызова.

Автоматические тесты backend:

- `npm --prefix server run build` — OK;
- `npm --prefix server test` — 13 tests OK.

Staging smoke / E2E:

- `/v1/delivery/points` — OK через real CDEK API;
- `/v1/delivery/quote` — OK через real CDEK API;
- `/v1/promos/validate` — OK;
- `/v1/payments` — OK через T-Bank demo terminal;
- `/v1/payments/status` — OK;
- `/v1/webhooks/tbank` — OK, successful demo payment переводит заказ в
  `paid`;
- CDEK shipment после paid webhook — OK;
- заказ `KOM-879480584` создан в CDEK с номером `10288069122`;
- `/api/supabase-function?name=promo-validate` через `stage.komui.ru` — OK;
- `/admin/ozon/products/import-preview` — реализован, используется админкой;
- `/admin/ozon/products/import` и `/admin/ozon/jobs/:jobId` — реализованы,
  требуют отдельной финальной приёмки import/dual-write сценария.

## Результат

Checkout/payment/CDEK контур работает на staging без Supabase Edge Functions.

Текущее staging-состояние:

- active backend release: `/opt/komui/releases/20260630-cdek-number-sync-backend`;
- backend: `komui-backend.service`, active;
- домен: `https://stage.komui.ru`;
- TLS: Let’s Encrypt certificate for `stage.komui.ru`, expires 2026-09-24;
- Basic Auth: включён;
- noindex headers: включены;
- backend bind: `127.0.0.1:3000`;
- PostgreSQL bind: `127.0.0.1:5432`;
- T-Bank: `TBANK_MODE=demo`, `TBANK_MOCK_PAYMENTS=false`;
- CDEK: `CDEK_MOCK=false`, `CDEK_CREATE_SHIPMENTS=true`;
- Ozon: `OZON_IMPORT_WRITE_SUPABASE=false`;
- production smoke: `komui.ru=200`, `www.komui.ru=200`, `api.komui.ru=404`.

## GO

GO для checkout/payment/CDEK в staging.

Причина: checkout API подключён к frontend, T-Bank demo payment/webhook
проверен, CDEK shipment создаётся и номер подтягивается follow-up запросом.

Full Stage 5 GO для production ещё не достигнут из-за Ozon dual-write/final
import acceptance и отсутствия разрешения на production cutover.

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

- production cutover не разрешён владельцем;
- T-Bank всё ещё в demo mode для staging;
- production webhook Т-Банка не переключался;
- `komui.ru` DNS не переключался;
- Ozon Supabase dual-write выключен: `OZON_IMPORT_WRITE_SUPABASE=false`;
- финальная приёмка Ozon import/dual-write сценария не закрыта;
- часть failure/concurrency тестов промокодов, webhook и внешних API остаётся
  ручной и не автоматизирована.

## Rollback

Production продолжает использовать старые Edge Functions. Не переключать webhook до этапа 8.
