# Этап 3. Тестовый перенос PostgreSQL

Статус: **завершён — GO**.

Дата контрольного снимка: 26 июня 2026 года, 00:47 MSK.

## Цель

Получить воспроизводимую полную копию текущей базы в обычном PostgreSQL 17 без Supabase-компонентов.

Источник используется только для чтения. Все тестовые изменения выполняются
только в отдельной staging-БД на сервере.

## Зависимости

- PostgreSQL 17 готов.
- Есть доступ к source Supabase.
- Security cleanup и полный backup выполнены.

## Действия

### 3.1. Снимок source

Зафиксировать:

- PostgreSQL version;
- список 29 таблиц;
- row counts;
- размеры;
- extensions;
- functions;
- triggers;
- indexes;
- foreign keys;
- sequences/identity;
- grants и RLS;
- историю 31 миграции.

### 3.2. Снимок

Предпочтительный способ — `pg_dump` PostgreSQL 17. В выполненной репетиции
пароль source database не был доступен, а тариф Supabase не предоставлял
скачиваемый backup. Поэтому применён безопасный эквивалент:

- авторизованный Supabase SQL Editor;
- один read-only SQL-запрос, сформировавший согласованный JSONB-снимок;
- отдельный экспорт полной истории из 31 миграции;
- SHA-256 и AES-256 шифрование снимка сразу после передачи на сервер.

Production database password не сбрасывался, временные роли не создавались,
DDL/DML в source не выполнялись.

Не переносить как рабочую инфраструктуру:

- пустой Auth;
- пустой Storage;
- Realtime;
- Supabase internal roles;
- `pg_net`/Vercel redeploy trigger.

Снимок не требует остановки production Supabase. Он используется только для
staging-проверки, а не для будущего финального cutover.

### 3.3. Restore

- Восстановить в отдельную тестовую БД.
- Не затрагивать будущую production-БД.
- Проверить владельцев объектов.
- Синхронизировать sequences.
- Выполнить `VACUUM ANALYZE`.

### 3.4. Очистка Supabase-зависимостей

- Удалить `notify_vercel_storefront_changed`.
- Удалить `storefront_products_redeploy`.
- Удалить Supabase-specific grants.
- Создать минимальные grants для `komui_app`.
- Сохранить только необходимые extensions.
- Проверить RLS и решить, какие policies сохраняются как дополнительная защита.

### 3.5. Сравнение

Сравнить source/target:

- row counts каждой таблицы;
- storefront products;
- Ozon orders/items/finance totals;
- orders/payment attempts/events;
- inventory totals;
- foreign key integrity;
- sequences;
- функции, индексы и constraints;
- выборочные записи без публикации PII.

## Проверки

- Все 29 таблиц присутствуют.
- Нет пропущенных строк.
- Нет orphaned foreign keys.
- Identity insert после restore выдаёт новое значение.
- `komui_app` может выполнять нужные операции и не может DDL/superuser actions.
- Target не зависит от Supabase roles/services.
- Ни один staging connection string не указывает на production Supabase.
- Запись из staging в Supabase технически отсутствует.
- Restore повторяется с нуля по документированной процедуре.

## Результат

- Зашифрованный согласованный снимок всех 29 прикладных таблиц.
- Экспорт 31 миграции и воспроизводимый schema replay.
- Скрипт/инструкция restore.
- SQL post-restore cleanup.
- Отчёт сравнения source/target.

Серверные артефакты:

- `/var/backups/komui/database/supabase-api-snapshot-20260626.json.enc`;
- `/var/backups/komui/database/supabase-api-snapshot-20260626.json.enc.sha256`;
- `/var/backups/komui/database/supabase-api-snapshot-20260626.metadata.json`;
- `/opt/komui/migration/schema-replay.sql`;
- `/opt/komui/migration/stage3-api-restore.sh`;
- `/opt/komui/migration/staging-post-restore.sql`;
- `/opt/komui/migration/stage3-validate.sh`.

Ключ шифрования находится отдельно в root-only файле
`/etc/komui/backup-encryption.key`.

## Фактическая проверка

- В source зафиксировано 29 таблиц и 3500 строк.
- Выполнены два последовательных восстановления с нуля:
  `komui_restore_verify` и `komui_staging`.
- Нормализованный hash всех данных совпал в обоих restore.
- Row counts всех 29 таблиц и контрольные агрегаты совпали.
- Fingerprints колонок, constraints и индексов совпали.
- Все 39 foreign keys валидны.
- Все 5 sequences синхронизированы.
- `komui_app` имеет DML-доступ к прикладным таблицам, но не может DDL.
- `komui_backup` имеет только необходимый read-only доступ.
- Удалены Supabase roles/grants/RLS policies и Vercel deploy trigger/function.
- PostgreSQL слушает только localhost, внешний порт 5432 закрыт.
- Временная проверочная БД удалена; сохранена только `komui_staging`.
- Открытых source connection strings и plaintext-снимков на сервере нет.

Подробный результат: [отчёт этапа 3](../../.ai/server-migration/phase-03-report.md).

## GO

Выполнено: два последовательных тестовых restore дали одинаковый проверенный
результат. Разрешён переход к этапу 4.

## NO-GO

- расхождение row counts;
- потеря constraints/indexes/sequences;
- target требует Supabase internal service;
- нет минимальной роли приложения;
- restore нельзя воспроизвести.

## Rollback

Удалить только тестовую target-БД. Source остаётся неизменным.
