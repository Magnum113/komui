# Этап 3 — итоговый отчёт

Дата: 26 июня 2026 года.

Решение: **GO к этапу 4**.

## Результат

Текущая прикладная база Supabase перенесена в изолированную базу
`komui_staging` на сервере как обычный PostgreSQL 17. Target не использует
Supabase Auth, API, роли, RLS, Realtime, Storage или другие runtime-сервисы
Supabase.

Production Supabase, Vercel, `komui.ru`, DNS и платёжные webhook не изменялись.

## Способ получения снимка

На тарифе source-проекта не было скачиваемого backup, а database password не
был доступен. Сбрасывать пароль или создавать временную production-роль не
потребовалось.

После разрешения владельца использован уже авторизованный Supabase Dashboard:

- через SQL Editor выполнен один read-only запрос;
- запрос сформировал согласованный JSONB-снимок всех 29 прикладных таблиц;
- отдельно экспортирована история из 31 миграции;
- DDL/DML в source не выполнялись;
- снимок передан по SSH, проверен SHA-256 и зашифрован AES-256;
- локальная открытая копия после передачи удалена.

Время снимка: `2026-06-25 21:47:15.589375+00`
(`26 июня 2026 года, 00:47:15 MSK`).

## Source

- PostgreSQL 17.6;
- 29 таблиц;
- 3500 строк;
- 368 колонок;
- 133 constraints;
- 99 индексов;
- 5 sequences;
- 4 функции;
- 9 triggers;
- 39 RLS policies;
- 31 миграция.

Основные контрольные показатели:

- products: 151;
- inventory: 101 строк, quantity 134;
- Ozon orders: 502;
- Ozon items: 505;
- Ozon finance operations: 1450, сумма 426304.88;
- storefront products: 31, active 31;
- customer orders: 6, сумма 3042000;
- payment attempts: 6;
- transactions: 353.

## Restore и очистка

Схема воспроизводится из migration history с отдельным созданием двух
операционных backup-таблиц, отсутствовавших в истории миграций. Из target
намеренно исключены Supabase/Vercel-specific части:

- `notify_vercel_storefront_changed`;
- `storefront_products_redeploy`;
- Supabase internal roles и grants;
- 39 RLS policies;
- доступы `anon`, `authenticated`, `service_role`.

После загрузки данных:

- синхронизированы sequences;
- проверены и валидированы foreign keys;
- владельцем объектов назначен `komui_owner`;
- `komui_app` выданы минимальные DML-права;
- `komui_backup` выданы read-only права;
- выполнен `VACUUM ANALYZE`.

## Проверки

Выполнены два последовательных восстановления с нуля:

1. `komui_restore_verify`;
2. `komui_staging`.

Результаты:

- row counts всех 29 таблиц совпали с source;
- контрольные агрегаты совпали;
- нормализованные hashes всех таблиц совпали в обоих restore;
- общий нормализованный data SHA-256:
  `fdd9dde152b91aa4ad9da26158d70a4c86da2d8a476d3c158c9273a1490ac733`;
- нормализованный schema dump SHA-256 в обоих restore:
  `436a5936f828094892819c429ddd29a90e4f094dc6709315a2e34155a7b98a32`;
- fingerprints колонок, constraints и индексов совпали с source;
- все 39 foreign keys валидны;
- все 5 sequences присутствуют и синхронизированы;
- identity insert выдаёт следующее корректное значение;
- `komui_app` может DML и не может DDL;
- `komui_backup` не может изменять данные;
- Supabase roles, policies и Vercel automation в target отсутствуют.

Временная `komui_restore_verify` после сравнения удалена. Сохранена только
`komui_staging`.

## Безопасность и изоляция

- PostgreSQL слушает только localhost.
- Внешние порты 3000 и 5432 закрыты.
- HTTPS staging hostname отвечает `401` без Basic Auth, как предусмотрено.
- Source connection string на сервере отсутствует.
- Plaintext snapshot на локальном компьютере и сервере отсутствует.
- Backup зашифрован, ключ хранится отдельно в root-only файле.
- Staging не имеет технического пути записи обратно в Supabase.
- Production health checks после работ не изменились.

## Артефакты на сервере

- `/var/backups/komui/database/supabase-api-snapshot-20260626.json.enc`;
- `/var/backups/komui/database/supabase-api-snapshot-20260626.json.enc.sha256`;
- `/var/backups/komui/database/supabase-api-snapshot-20260626.metadata.json`;
- `/var/backups/komui/database/komui_restore_verify-validation.txt`;
- `/var/backups/komui/database/komui_staging-validation.txt`;
- `/opt/komui/migration/schema-replay.sql`;
- `/opt/komui/migration/stage3-api-restore.sh`;
- `/opt/komui/migration/staging-post-restore.sql`;
- `/opt/komui/migration/stage3-validate.sql`;
- `/opt/komui/migration/stage3-validate.sh`.

## Остаточные ограничения

- Этот снимок предназначен только для staging. Перед production cutover нужен
  новый финальный снимок и короткое окно записи/дельта-синхронизация.
- Auth и Storage не переносились, поскольку проект их фактически не использует.
- Off-server backup и автоматическое расписание будут настроены на этапе 7.
- Обычный password SSH authentication пока сохраняется до проверки личного
  ключа владельца.
- Перезагрузка сервера и пакетные обновления остаются на maintenance window.

## Следующий этап

Этап 4: собственный Node.js/TypeScript backend и API каталога, подключённые
только к `komui_staging`.
