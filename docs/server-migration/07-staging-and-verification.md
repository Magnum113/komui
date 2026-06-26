# Этап 7. Изолированный staging, backup и тестовая приёмка

## Цель

Развернуть полностью рабочую тестовую реализацию на сервере, дать владельцу
возможность проверить её и доказать, что она не влияет на текущие Supabase/Vercel.

## Зависимости

- Этапы 2–6 завершены.
- Есть staging hostname и TLS. Целевой hostname: `stage.komui.ru`.
- Используются только test/demo payment credentials.
- Production DNS, webhook и Vercel deployment не изменяются.
- Staging не имеет доступа на запись в Supabase по умолчанию.
- Исключение — отдельно подтверждённая владельцем admin-команда dual-write для
  импорта новых товаров Ozon. Эта команда не относится к обычной staging
  проверке и требует отдельного включения server-only секретов.

## Действия

### 7.1. Staging deployment

- Развернуть release через production-подобный deploy script.
- Запустить backend через systemd.
- Раздать frontend через Nginx.
- Проверить restart/reboot.
- Использовать `stage.komui.ru`.
- До DNS-записи `stage.komui.ru -> 89.111.152.112` использовать технический
  hostname `staging-89-111-152-112.sslip.io`.
- Защитить staging Basic Auth и/или IP allowlist.
- Запретить индексацию через headers, robots и meta.
- Не использовать `komui.ru`/`www.komui.ru` как staging endpoint.

### 7.2. Проверка изоляции

Доказать:

- production `komui.ru` по-прежнему обслуживается Vercel;
- production API по-прежнему использует Supabase Edge Functions;
- production webhook Т-Банка не изменён;
- Supabase row counts не меняются из-за staging-тестов;
- Supabase row counts могут меняться только при отдельном ручном запуске
  подтверждённого Ozon dual-write job;
- тестовые заказы появляются только в staging PostgreSQL;
- staging использует demo terminal Т-Банка;
- реальное создание CDEK shipment заблокировано feature flag;
- staging cookies/storage не конфликтуют с production.

### 7.3. Backup

Настроить:

- ежедневный локальный dump;
- зашифрованную внешнюю копию;
- retention: 7 daily, 4 weekly, 6 monthly;
- алерт при ошибке;
- backup конфигураций и assets.

### 7.4. Restore drill

- Создать пустую БД.
- Восстановить последний backup.
- Запустить backend на восстановленной БД.
- Проверить каталог и тестовый checkout.
- Зафиксировать длительность и ошибки.

### 7.5. Monitoring

- uptime staging endpoint;
- `/health/live`;
- `/health/ready`;
- disk >80%;
- available RAM;
- swap growth;
- systemd failures;
- backup failures;
- HTTP 5xx;
- ошибки Т-Банка/СДЭК;
- зависшие `pending_payment`;
- необработанные webhook.

### 7.6. Полный E2E

1. Каталог.
2. Фильтры и карточки.
3. Корзина.
4. Город и ПВЗ.
5. Расчёт доставки.
6. Промокод.
7. Demo-платёж.
8. Webhook.
9. Payment status.
10. Mock CDEK shipment без реальной отправки.
11. SEO page и sitemap.
12. Admin Ozon import dry-run.
13. Admin Ozon import в режиме server-only без записи в Supabase.

### 7.7. Нагрузка

- 50–100 параллельных static connections.
- 20–50 catalog API requests.
- 5–10 checkout requests в test environment.
- 30–60 минут наблюдения памяти/connections.

### 7.8. Ручная тестовая приёмка владельца

Владелец получает:

- отдельный URL staging;
- логин/пароль staging вне Git;
- список сценариев проверки;
- список известных ограничений;
- подтверждение, что production не переключён.

После проверки возможны три решения:

1. Доработать staging.
2. Оставить staging работающим и не переносить production.
3. Отдельно разрешить подготовку этапа 8.

Отсутствие ответа или успешный staging-тест не считается разрешением на cutover.

### 7.9. Cutover runbook

Подготовить точные:

- команды;
- ответственных;
- временные оценки;
- контрольные SQL;
- DNS действия;
- webhook действия;
- критерии rollback;
- способ синхронизации заказов при rollback;
- способ traffic fallback с нового сервера на текущий Vercel/Supabase;
- способ ручного DNS-rollback, если новый сервер недоступен.

## Проверки

- Успешный reboot test.
- Успешный restore из внешнего backup.
- Все E2E сценарии проходят.
- Нет утечки секретов/PII в логах.
- Ресурсы стабильны.
- Rollback отрепетирован до появления production writes.
- Traffic fallback на Vercel/Supabase отрепетирован без изменения production
  DNS.
- Production DNS, Vercel, Supabase и webhook остались без изменений.
- Владелец вручную проверил staging URL.

## Результат

Рабочая тестовая версия на сервере, отчёт изоляции и финальный cutover runbook.

## GO

`GO` на готовность staging выдаётся, если backup восстановлен, E2E пройден,
rollback проверен и production не затронут. Этот `GO` не является разрешением
на этап 8.

## NO-GO

- backup существует, но не восстанавливается;
- webhook/платёж не прошёл E2E;
- сервер не переживает reboot;
- диск/RAM находятся у предела;
- нет внешнего мониторинга;
- cutover зависит от непроверенной ручной команды.
- staging создаёт реальные платежи/отправления;
- staging способен писать в production Supabase без отдельной owner-команды,
  dry-run, audit log и retry;
- для просмотра staging потребовалось переключить production DNS.

## Rollback

Удалить staging deployment или переключить staging symlink на предыдущий
release. Production продолжает работать на Supabase/Vercel и не требует rollback.

## Обязательная остановка

После завершения этапа работа останавливается. Этап 8 начинается только после
отдельного явного сообщения владельца о разрешении production cutover.
