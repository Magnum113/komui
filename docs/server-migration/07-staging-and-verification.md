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

## Фактический результат этапа 7

Статус: `частично завершён — infra/external backup/alerting GO, полный Stage 7
GO ожидает ручную приёмку и Ozon job`.

Дата выполнения технической части: 27 июня 2026 года.

Production не изменялся:

- `komui.ru` остался на Vercel;
- DNS `komui.ru` указывает на `76.76.21.21`;
- DNS `stage.komui.ru` указывает на `89.111.152.112`;
- текущий Supabase project не изменялся;
- production webhooks не изменялись.

### Backup

Установлено:

- `/usr/local/sbin/komui-backup`;
- `komui-backup.service`;
- `komui-backup.timer`.

Параметры:

- запуск ежедневно около `03:17 MSK` с randomized delay;
- encryption key: `/etc/komui/backup.key`, root-only;
- retention в скрипте:
  - 7 daily;
  - 4 weekly;
  - 6 monthly;
- backup archive root-only.

Первый backup:

```text
/var/backups/komui/daily/komui-backup-20260627T120725Z.tar.gz.gpg
```

Размер: `8 898 575 bytes`.

Содержимое:

- custom `pg_dump` базы `komui_staging`;
- Postgres globals;
- Nginx/systemd configs;
- `/etc/komui`;
- backend releases;
- frontend releases;
- manifest и SHA256SUMS.

Временная off-server копия скачана на локальную машину:

```text
.ai/server-migration/runtime/backups/komui-backup-20260627T120725Z.tar.gz.gpg
```

Checksum локальной копии совпал с серверным SHA256.

Постоянная внешняя backup-автоматизация настроена:

```text
bucket: komui-backups
prefix: komui/stage/
endpoint: https://storage.yandexcloud.net
tool: s3cmd
```

Root-only credentials:

```text
/etc/komui/yandex-backup.env
```

Проверенный uploaded object:

```text
s3://komui-backups/komui/stage/komui-backup-20260627T143747Z.tar.gz.gpg
s3://komui-backups/komui/stage/komui-backup-20260627T143747Z.tar.gz.gpg.sha256
```

### Restore drill

Restore выполнен в отдельную временную БД:

```text
komui_restore_drill_20260627121243
```

Результат:

- encrypted backup расшифрован;
- `SHA256SUMS` проверен;
- восстановлено `29` public tables;
- `merch_storefront_products`: `31` rows;
- active storefront products: `31`;
- временный backend на restored DB вернул `/health/ready`;
- временный backend вернул `1` товар на `/v1/products?limit=1`;
- длительность drill: около `2 sec`;
- временная БД удалена после проверки.

### Restart, rollback и reboot

Проверено:

- `systemctl restart komui-backend`;
- `systemctl reload nginx`;
- rollback symlink `/var/lib/komui/staging-root` на предыдущий root;
- возврат symlink на active frontend release;
- `/checkout` после rollback-return вернул HTTP 200;
- reboot сервера.

После reboot:

- PostgreSQL cluster `17/main` online;
- `postgresql`, `nginx`, `komui-backend`, `komui-backup.timer` active;
- frontend release:
  `/opt/komui/frontend-releases/20260627114138-stage6-frontend`;
- `https://stage.komui.ru/` с Basic Auth — HTTP 200;
- `https://stage.komui.ru/checkout` — HTTP 200;
- `https://stage.komui.ru/payment-result` — HTTP 200;
- `https://stage.komui.ru/api/v1/products?limit=1` — HTTP 200;
- без Basic Auth — HTTP 401.

### Monitoring

Установлено:

- `/usr/local/sbin/komui-healthcheck`;
- `komui-healthcheck.service`;
- `komui-healthcheck.timer`.

Периодичность: каждые 5 минут.

Проверяет:

- active `postgresql`, `nginx`, `komui-backend`, `komui-backup.timer`;
- `/health/ready`;
- `stage.komui.ru` root и catalog API через Basic Auth;
- disk `<80%`;
- available RAM `>=256 MB`;
- свежесть backup `<=36h`;
- отсутствие failed systemd units;
- отсутствие stale `pending_payment` старше 2 часов.

Первый запуск: `SUMMARY OK`.

Внешние уведомления настроены через Telegram bot.

Параметры:

```text
env: /etc/komui/telegram-alerts.env
chat_id: 741679125
proxy: socks5h://127.0.0.1:10808
```

Telegram API недоступен с сервера напрямую, поэтому alerting использует уже
установленный Xray local SOCKS proxy. Тестовый alert отправлен успешно.

### Load smoke

Без создания платежей и отправлений:

- 100 static requests, parallel 20 — все HTTP 200;
- 50 catalog API requests, parallel 10 — все HTTP 200;
- 10 validation POST requests — все ожидаемо HTTP 400 из-за пустой корзины.

После нагрузки:

- disk: `63%`, available `7.1G`;
- memory available: `3.1Gi`;
- swap used: `0B`;
- services active.

### Изоляция

Проверено:

- `komui.ru` отвечает с `server: Vercel`;
- `x-vercel-cache: HIT`;
- `stage.komui.ru` отвечает с `server: nginx` и Basic Auth;
- `X-Robots-Tag: noindex, nofollow, noarchive`;
- backend public config:
  - `runtimeMode=staging`;
  - `legacyFallbackConfigured=false`;
  - `trafficSwitchEnabled=false`;
  - `siteUrl=https://stage.komui.ru`;
  - `tbankMode=demo`;
  - `cdekCreateShipments=false`;
- `OZON_IMPORT_WRITE_SUPABASE=false`;
- active frontend release не содержит runtime Supabase key/URL.

### Оставшиеся блокеры полного GO этапа 7

- Нужна ручная приёмка владельцем по checklist.
- Ozon admin import dry-run/job не реализован в backend.
- Supabase dual-write для Ozon заблокирован до настоящего `service_role` /
  `sb_secret_...` key.
- Полный платёжный E2E с T-Bank demo payment/webhook не запускался
  автоматически, чтобы не создавать платёж без ручного решения владельца.

### Решение

Техническая staging-инфраструктура готова к ручной проверке владельцем.

Это не является разрешением на production cutover. Этап 8 остаётся
заблокированным до отдельного явного сообщения владельца.
