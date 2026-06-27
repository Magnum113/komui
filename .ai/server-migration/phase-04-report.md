# Этап 4 — итоговый отчёт

Дата: 26 июня 2026 года.

Решение: **GO к этапу 5**.

## Результат

На сервере развернут собственный staging backend для каталога:

- release: `/opt/komui/releases/20260626-stage4-backend`;
- current symlink: `/opt/komui/current`;
- systemd: `komui-backend.service`;
- runtime user: `komui`;
- bind address: `127.0.0.1:3000`;
- database: `komui_staging`;
- DB role: `komui_app`;
- public staging path через Nginx: `/api/*`.

Production Supabase, Vercel, DNS, `komui.ru`, `www.komui.ru`, `api.komui.ru`
и webhooks не изменялись.

## Реализовано

Backend:

- TypeScript;
- Fastify;
- `pg`;
- Zod env validation;
- structured logging;
- graceful shutdown;
- request IDs;
- DB pool max 6;
- statement timeout 3000 ms;
- connection timeout 2000 ms;
- body/request limits.

Routes:

```text
GET /health/live
GET /health/ready
GET /healthz
GET /readyz
GET /v1/products
GET /v1/products/:slug
GET /v1/catalog/stats
GET /admin/runtime
POST /admin/runtime/fallback
```

Через Nginx staging:

```text
GET /api/health/live
GET /api/health/ready
GET /api/v1/products
GET /api/v1/products/:slug
GET /api/v1/catalog/stats
```

## Публичный catalog contract

`GET /v1/products` возвращает массив, совместимый с текущим Supabase REST
потребителем витрины и build script.

Из ответа намеренно исключены внутренние поля:

- `source_payload`;
- `ozon_attributes`;
- `sales_6m_units`;
- `sales_6m_revenue`;
- `sales_6m_rank`;
- `sales_6m_period_*`;
- `ozon_product_ids`;
- `ozon_skus`;
- `ozon_offer_ids`;
- `created_at`;
- `updated_at`.

В `offers` оставлен только публичный subset:

- `sku`;
- `offer_id`;
- `name`;
- `size`;
- `price`;
- `images`;
- `primary_image`;
- `archived`;
- `visible`.

Из `offers` исключены:

- `attributes`;
- `raw_name`;
- `product_id`;
- `min_price`;
- `old_price`.

## Admin foundation

Добавлена закрытая admin-заготовка:

- `GET /admin/runtime` требует `Authorization: Bearer <server-only token>`;
- token хранится только в `/etc/komui/backend.env`;
- без token endpoint возвращает `401`;
- действия пишутся в `/var/lib/komui/admin-audit.log`;
- `POST /admin/runtime/fallback` пока возвращает `501`, потому что traffic
  fallback должен быть реализован и проверен ближе к cutover.

## Проверки

Локально:

- `npm --prefix server run build` — успешно;
- `npm --prefix server test` — 5/5 tests passed.

На сервере:

- `komui-backend.service` — active/running;
- backend memory около 23 MB;
- `GET /health/live` — `ok: true`;
- `GET /health/ready` — подключается к `komui_staging`;
- `GET /v1/catalog/stats`:
  - active products: 31;
  - products with offers: 31;
- `GET /v1/products?limit=2` — 2 товара;
- `GET /v1/products/var16-print-tshirt-washed-grey` — товар найден, 4 offer;
- неизвестный slug — `404`;
- leak-check внутренних полей — успешно;
- admin без token — `401`;
- admin с token — runtime status;
- audit log создаётся с правами `640 komui:komui`;
- Nginx без Basic Auth — `401`;
- Nginx с Basic Auth — `/api/health/live` и `/api/v1/products` работают;
- `nginx -t` — successfully;
- backend слушает только `127.0.0.1:3000`;
- внешний `3000` закрыт;
- внешний `5432` закрыт.

Production smoke:

- `https://api.komui.ru/` — 404;
- `https://komui.ru/` — 200;
- `https://www.komui.ru/` — 200.

Ресурсы:

- disk `/`: 20 GB total, 12 GB used, 7.2 GB free, 62%;
- RAM available: около 2.6 GB;
- swap: 2 GB, почти не используется.

## Ограничения

- `stage.komui.ru` пока не резолвится публично. До появления DNS-записи
  используется `staging-89-111-152-112.sslip.io`.
- Frontend ещё не переключён на новый API. Это относится к этапу 6.
- Checkout, Т-Банк, СДЭК, промокоды и compatibility route
  `/api/supabase-function` ещё не перенесены. Это этап 5.
- Traffic fallback на Vercel/Supabase только заложен как admin foundation; сама
  безопасная смена upstream ещё не включена.
- Backend использует staging snapshot от 26 июня 2026, 00:47 MSK; это не
  финальная production DB.

## Следующий этап

Этап 5: перенос checkout, Т-Банк, СДЭК, промокодов и admin jobs, включая
безопасный Ozon import design.
