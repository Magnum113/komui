# Этап 4. Backend и API каталога

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

## GO

Каталог и SEO build получают те же активные товары, что source Supabase, с допустимым публичным набором полей.

Admin foundation считается готовым на этом этапе, если закрытые маршруты,
аудит и runtime config работают в staging, но production traffic switch ещё не
включён.

## NO-GO

- расхождение цен/размеров/активности;
- утечка внутренних полей;
- backend требует DB superuser;
- отсутствуют integration tests;
- неконтролируемый рост connections или памяти.

## Rollback

Frontend продолжает использовать Supabase REST. Новый backend можно остановить без влияния на production.
