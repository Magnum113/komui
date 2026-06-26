# Этап 3 — промежуточный отчёт (закрыт)

Дата: 26 июня 2026 года.

Статус: **завершён**.

Этот документ фиксирует состояние до получения разрешения на авторизованный
Supabase Dashboard. Итоговые результаты находятся в
[`phase-03-report.md`](phase-03-report.md).

## Выполнено

- Проверена официальная процедура Supabase backup/restore.
- Подтверждён source PostgreSQL 17.6, регион `eu-west-1`.
- Зафиксирован source manifest:
  - 29 таблиц;
  - 31 миграция;
  - 368 колонок;
  - 133 constraints;
  - 99 индексов;
  - 5 sequences;
  - 4 функции;
  - 9 triggers;
  - 39 RLS policies.
- Зафиксированы точные row counts и контрольные агрегаты.
- Подготовлен read-only dump:
  - только схемы `public` и `private`;
  - `default_transaction_read_only=on`;
  - custom PostgreSQL format;
  - AES-256 шифрование;
  - root-only файлы и SHA-256.
- Подготовлен воспроизводимый restore в чистую БД.
- Подготовлена staging cleanup:
  - удаление Vercel trigger/function;
  - удаление Supabase policies/roles;
  - отключение RLS в неэкспонируемой standalone-БД;
  - смена владельцев;
  - минимальные grants;
  - валидация foreign keys;
  - `VACUUM ANALYZE`.
- Подготовлена проверка row counts, totals, schema fingerprints и cleanup.
- Полный pipeline dump → encryption → restore → cleanup успешно проверен на
  одноразовых mock-базах сервера.

## Source snapshot до dump

Контрольное время: `2026-06-25T21:30:49Z`
(`26 июня 2026 года, 00:30:49 MSK`).

Основные значения:

- products: 151;
- inventory rows: 101, quantity total: 134;
- Ozon orders: 502;
- Ozon items: 505;
- Ozon finance operations: 1450, amount total: 426304.88;
- storefront products: 31, active: 31;
- customer orders: 6;
- payment attempts: 6;
- transactions: 353.

Production продолжает принимать записи. Поэтому этот manifest является
предварительным ориентиром, а восстановленный consistent dump станет
авторитетным снимком этапа.

## Блокирующее условие

Для `pg_dump` нужен PostgreSQL connection string с паролем базы. Он:

- не хранится в репозиториях;
- не найден в локальных env/history;
- не может быть получен из Supabase publishable/service API keys;
- не выдаётся Supabase MCP connector.

Без отдельного разрешения не выполнялись:

- reset production database password;
- создание временной LOGIN-роли в production;
- управление Supabase Dashboard через Chrome.

## Текущее состояние сервера

- `/etc/komui/source-supabase.env` отсутствует;
- `komui_staging` остаётся пустой;
- production Supabase не изменён;
- свободно около 7,2 ГБ;
- failed systemd units: 0.

## Следующее действие

Один из безопасных вариантов:

1. владелец разрешает использовать уже авторизованный Chrome для скачивания
   официального backup из Supabase Dashboard;
2. владелец самостоятельно сохраняет DB connection string в root-only файле
   `/etc/komui/source-supabase.env`, не передавая пароль в чат.

После этого dump, два restore и сравнение выполняются без дополнительных
production-изменений.

## Артефакты

- `.ai/server-migration/stage3/source-manifest-20260626.json`;
- `.ai/server-migration/stage3/stage3-dump.sh`;
- `.ai/server-migration/stage3/stage3-restore.sh`;
- `.ai/server-migration/stage3/staging-post-restore.sql`;
- `.ai/server-migration/stage3/stage3-validate.sql`;
- `.ai/server-migration/stage3/stage3-validate.sh`.

Серверная копия: `/opt/komui/migration`.

## Официальные источники

- [Supabase backup/restore](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore)
- [Postgres migration guidance](https://supabase.com/docs/guides/platform/migrating-to-supabase/postgres)
