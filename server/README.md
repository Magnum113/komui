# KOMUI backend

Stage 4 backend for the server migration.

## Runtime

- Node.js 22+
- Fastify
- PostgreSQL via `pg`

Required environment:

```text
DATABASE_URL=postgresql://...
HOST=127.0.0.1
PORT=3000
```

Optional environment:

```text
ADMIN_API_TOKEN=<server-only token>
RUNTIME_MODE=staging
LEGACY_ORIGIN=https://...
ENABLE_TRAFFIC_SWITCH=false
AUDIT_LOG_PATH=/var/lib/komui/admin-audit.log
```

## Public routes

```text
GET /health/live
GET /health/ready
GET /v1/products
GET /v1/products/:slug
GET /v1/catalog/stats
GET /v1/feeds/yandex-direct.yml
```

`/v1/feeds/yandex-direct.yml` формирует YML-фид из всех активных товаров без
лимита публичного catalog API. Каждый товар, отображаемый на витрине, получает
`available="true"`; идентификатор offer совпадает с UUID товара в e-commerce
Метрики. Source-controlled production nginx публикует endpoint по внешнему URL
`/feeds/yandex-direct.yml`; активный server snippet обновляется при production
применении конфигурации.

Проверки фида:

```bash
npm --prefix server test
npm run audit:yandex-feed
```

Вторая команда собирает backend, генерирует YML на данных публичного production
каталога и проверяет XML, product pages, изображения и соответствие offer UUID.

When exposed through the staging Nginx config, these routes are available under
`/api/...` because Nginx strips the `/api/` prefix.

## Admin foundation

```text
GET  /admin/runtime
POST /admin/runtime/fallback
```

Admin routes require `Authorization: Bearer $ADMIN_API_TOKEN`. Traffic fallback
is deliberately not implemented in stage 4; the route returns `501` and writes an
audit event.
