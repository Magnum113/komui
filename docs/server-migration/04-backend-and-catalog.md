# Этап 4. Backend и API каталога

Статус: **завершён — GO**.

Дата завершения: 26 июня 2026 года.

## Цель

Создать собственный backend, который безопасно работает с PostgreSQL и заменяет Supabase REST для каталога.

Backend также должен заложить основу admin/BFF-контура: закрытые маршруты,
аудит операций и feature flags для будущего управляемого переключения runtime.

## Зависимости

- Схема target PostgreSQL проверена.
- Определены все клиенты и нужные операции.

## Стек

- Node.js LTS;
- TypeScript;
- Fastify;
- `pg`;
- Zod или JSON Schema;
- Pino;
- systemd.

Staging hostname: `stage.komui.ru` после DNS-настройки. До появления DNS-записи
используется технический hostname `staging-89-111-152-112.sslip.io`.

## Действия

### 4.1. Каркас

Создать:

```text
server/
├── src/
│   ├── config
│   ├── db
│   ├── repositories
│   ├── modules
│   ├── integrations
│   ├── routes
│   └── middleware
├── migrations
└── test
```

Добавить:

- строгую проверку env;
- DB pool;
- graceful shutdown;
- request IDs;
- structured logging;
- error mapping;
- body/time limits.

### 4.2. Health endpoints

- `GET /health/live` проверяет процесс.
- `GET /health/ready` проверяет БД и обязательную конфигурацию.
- Ответы не раскрывают секреты и внутренние connection strings.

### 4.2a. Admin control foundation

Заложить, но не включать для production cutover:

- закрытую admin-аутентификацию;
- audit log для административных действий;
- feature flags/runtime config;
- read-only endpoint текущего runtime mode;
- безопасный механизм будущего переключения `server -> legacy`.

Ограничение: admin-переключатель может вернуть трафик на Vercel/Supabase
только если production DNS уже направлен на новый сервер и сам сервер доступен.
Если сервер полностью недоступен, нужен ручной DNS-rollback у DNS-провайдера.

Запрещено:

- хранить production secrets в Git;
- давать backend произвольный `sudo`;
- менять DNS из приложения;
- делать переключение без `nginx -t`, audit log и rollback-команды.

### 4.3. Каталог

Реализовать:

- `GET /v1/products`;
- `GET /v1/products/:slug`.

API отдаёт только публичные поля. Запрещено отдавать:

- cost price;
- внутренние остатки;
- Ozon raw payload;
- финансовые данные;
- служебные metadata;
- персональные данные.

### 4.4. DB repositories

- Только параметризованные SQL.
- Query timeout.
- Ограниченный pool.
- Отдельные transaction helpers.
- Никакого SQL из пользовательских идентификаторов.

### 4.5. Совместимость

На переходный период сохранить форму ответов, ожидаемую текущей витриной и build script.

## Проверки

- Unit tests config/validation.
- Integration tests с тестовой PostgreSQL.
- Публичный API не раскрывает внутренние поля.
- Нет SQL injection через slug/filter/sort.
- Backend корректно завершает соединения.
- `/health/ready` падает при недоступной БД.
- Память стабильна при повторных запросах.

## Результат

Собственный API каталога, готовый к staging.

Фактически развернуто:

- `server/` TypeScript/Fastify backend;
- systemd service `komui-backend`;
- DB pool через `pg`, максимум 6 соединений;
- statement timeout 3000 ms;
- health endpoints:
  - `GET /health/live`;
  - `GET /health/ready`;
  - compatibility: `GET /healthz`, `GET /readyz`;
- catalog endpoints:
  - `GET /v1/products`;
  - `GET /v1/products/:slug`;
  - `GET /v1/catalog/stats`;
- admin foundation:
  - `GET /admin/runtime`;
  - `POST /admin/runtime/fallback` возвращает `501` на этапе 4;
  - Bearer-token auth;
  - audit log `/var/lib/komui/admin-audit.log`.

Через Nginx staging API доступен с префиксом `/api/`, например:

```text
https://staging-89-111-152-112.sslip.io/api/v1/products
```

После появления DNS-записи `stage.komui.ru -> 89.111.152.112` staging можно
перевести на:

```text
https://stage.komui.ru/api/v1/products
```

## Фактические проверки

- `npm --prefix server run build` — успешно.
- `npm --prefix server test` — 5/5 тестов успешно.
- `komui-backend.service` — active/running.
- Backend слушает только `127.0.0.1:3000`.
- Внешний порт `3000` закрыт.
- Внешний порт `5432` закрыт.
- `/health/live` возвращает `ok: true`.
- `/health/ready` проверяет `komui_staging`.
- `/v1/catalog/stats` вернул:
  - active products: 31;
  - products with offers: 31.
- `/v1/products?limit=2` возвращает массив из 2 товаров.
- `/v1/products/var16-print-tshirt-washed-grey` возвращает товар и 4 offer.
- неизвестный slug возвращает `404`.
- Проверена отсечка внутренних полей:
  - `source_payload`;
  - `ozon_attributes`;
  - `sales_6m_*`;
  - `ozon_product_ids`;
  - `ozon_skus`;
  - `ozon_offer_ids`;
  - `created_at`;
  - `updated_at`;
  - offer `attributes`;
  - offer `raw_name`;
  - offer `product_id`;
  - offer `min_price`;
  - offer `old_price`.
- Admin endpoint без token возвращает `401`.
- Admin endpoint с server-only token возвращает runtime status.
- Admin actions пишутся в audit log.
- Nginx staging без Basic Auth возвращает `401`.
- Nginx staging с Basic Auth отдаёт `/api/health/live` и `/api/v1/products`.
- `nginx -t` успешно.
- Production smoke checks не изменились:
  - `https://api.komui.ru/` — 404;
  - `https://komui.ru/` — 200;
  - `https://www.komui.ru/` — 200.
- Ресурсы после запуска:
  - backend memory около 23 MB;
  - диск `/`: 62% used, около 7.2 GB free;
  - available RAM около 2.6 GB.

## GO

Каталог и SEO build получают те же активные товары, что source Supabase, с допустимым публичным набором полей.

Admin foundation считается готовым на этом этапе, если закрытые маршруты,
аудит и runtime config работают в staging, но production traffic switch ещё не
включён.

GO выдан: backend и catalog API работают в staging, production-контур не
изменён.

Ограничение: `stage.komui.ru` пока не резолвится публично, поэтому тестовый
доступ остаётся через `staging-89-111-152-112.sslip.io`. После появления DNS
нужно добавить hostname в Nginx и выпустить TLS-сертификат.

## NO-GO

- расхождение цен/размеров/активности;
- утечка внутренних полей;
- backend требует DB superuser;
- отсутствуют integration tests;
- неконтролируемый рост connections или памяти.

## Rollback

Frontend продолжает использовать Supabase REST. Новый backend можно остановить без влияния на production.
