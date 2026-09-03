# KOMUI backend

Production backend self-hosted витрины KOMUI. Один Fastify/TypeScript codebase
обслуживает staging и production с разными systemd units, env-файлами, портами
и PostgreSQL databases.

Актуальная серверная архитектура и эксплуатационные пути описаны в
[`SERVER_PROJECT_OVERVIEW.md`](../SERVER_PROJECT_OVERVIEW.md).

## Runtime

- Node.js 22+;
- Fastify;
- PostgreSQL через `pg`;
- TypeScript build в `dist/`;
- отдельный email outbox worker.

Минимальные переменные окружения:

```text
DATABASE_URL=postgresql://...
HOST=127.0.0.1
PORT=3000
```

Полная валидация конфигурации находится в `src/config.ts`. Секреты T-Bank,
CDEK, Unisender Go, Ozon и admin API должны оставаться только в защищённых
server env-файлах; их нельзя помещать в Git или frontend.

## Локальные команды

```bash
npm ci
npm test
npm run build
npm run dev
```

Systemd units запускают собранные процессы напрямую через
`node dist/server.js` и `node dist/emailWorker.js` внутри immutable release.

## Основные публичные маршруты

Health и каталог:

```text
GET  /health/live
GET  /health/ready
GET  /v1/products
GET  /v1/products/:slug
GET  /v1/products/:slug/reviews
GET  /v1/catalog/stats
GET  /v1/feeds/yandex-direct.yml
```

Checkout, доставка и оплата:

```text
GET  /delivery-config
POST /v1/delivery/points
POST /v1/delivery/quote
POST /v1/promos/validate
POST /v1/payments
POST /v1/payments/status
POST /v1/webhooks/tbank
```

Email:

```text
POST /v1/email/subscribe
POST /v1/email/confirm
GET  /v1/webhooks/unisender-go
POST /v1/webhooks/unisender-go
```

`POST /v1/email/subscribe` реализует Single Opt-In: два явных согласия сразу
активируют подписку и append-only consent event, не создавая
confirmation-письмо. `/v1/email/confirm` временно сохранён для ранее выданных
Double Opt-In ссылок.

При публикации через Nginx маршруты доступны под внешним префиксом `/api`;
Nginx удаляет этот префикс перед передачей запроса Fastify.

## Admin API

Admin routes включают runtime status, storefront products/orders, Ozon import
jobs и ручной CDEK retry. Они требуют server-side
`ADMIN_API_TOKEN`; токен нельзя передавать браузерному приложению. Контракты
редактирования описаны в:

- [`docs/admin-storefront-products-api.md`](../docs/admin-storefront-products-api.md);
- [`docs/admin-storefront-orders-api.md`](../docs/admin-storefront-orders-api.md);
- [`docs/server-migration/ADMIN_SERVER_DEPLOYMENT_PLAN.md`](../docs/server-migration/ADMIN_SERVER_DEPLOYMENT_PLAN.md).

Runtime status только сообщает текущий self-hosted режим. Переключение трафика
на прежний hosting через backend не поддерживается.

## Yandex Direct feed

`GET /v1/feeds/yandex-direct.yml` формирует YML из всех активных товаров без
лимита публичного catalog API. Source-controlled production Nginx публикует его
как `/feeds/yandex-direct.yml`.

Проверки:

```bash
npm test
npm run build
npm --prefix .. run audit:yandex-feed
```

Последняя команда запускается из `server/`; она использует root script проекта.
Production deploy и полный postflight выполняются через
`ops/server/komui-deploy-from-git`, а не ручной заменой active symlink.
