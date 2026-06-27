# Этап 7 — staging, backup, restore и operational verification

Дата: 27 июня 2026 года.

Статус: `частично завершён — infra/external backup/alerting GO`.

Полный Stage 7 GO ожидает:

- ручную приёмку владельцем;
- Ozon admin import dry-run/job;
- отдельное ручное решение по T-Bank demo payment/webhook E2E.

## Что сделано

### Backup

- Установлен `/usr/local/sbin/komui-backup`.
- Включён `komui-backup.timer`.
- Создан root-only encryption key `/etc/komui/backup.key`.
- Создан первый encrypted backup:

```text
/var/backups/komui/daily/komui-backup-20260627T120725Z.tar.gz.gpg
```

- Размер: `8 898 575 bytes`.
- Timer включён и active.
- Retention в скрипте:
  - 7 daily;
  - 4 weekly;
  - 6 monthly.

Временная off-server копия:

```text
.ai/server-migration/runtime/backups/komui-backup-20260627T120725Z.tar.gz.gpg
```

Checksum локальной копии совпал:

```text
1034afdded3099dff344a7574f65e45260c74824db1dc5a7948d82b48716db61
```

Постоянный external backup в Yandex Object Storage настроен:

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

Restore выполнен из encrypted backup в отдельную временную БД:

```text
komui_restore_drill_20260627121243
```

Результат:

- checksum OK;
- public tables: `29`;
- storefront products: `31`;
- active storefront products: `31`;
- временный backend на restored DB вернул `/health/ready`;
- `/v1/products?limit=1` вернул `1` товар;
- restore duration: около `2 sec`;
- временная БД удалена.

### Restart / rollback / reboot

Проверено:

- restart `komui-backend`;
- reload `nginx`;
- rollback symlink `/var/lib/komui/staging-root`;
- возврат symlink на active release;
- reboot сервера.

После reboot:

- PostgreSQL cluster online;
- `postgresql`, `nginx`, `komui-backend`, `komui-backup.timer` active;
- `stage.komui.ru` root/checkout/payment-result/catalog API отвечают;
- Basic Auth сохранён;
- noindex header сохранён.

### Monitoring

- Установлен `/usr/local/sbin/komui-healthcheck`.
- Включён `komui-healthcheck.timer`.
- Первый healthcheck: `SUMMARY OK`.

Проверяются:

- services;
- backend `/health/ready`;
- stage root/catalog;
- disk;
- RAM;
- backup freshness;
- failed units;
- stale pending payments.

Telegram alerting:

- установлен `/usr/local/sbin/komui-alert`;
- env: `/etc/komui/telegram-alerts.env`;
- `chat_id=741679125`;
- proxy: `socks5h://127.0.0.1:10808`;
- тестовый Telegram alert отправлен успешно;
- healthcheck вызывает Telegram alert при `SUMMARY FAIL`;
- backup вызывает Telegram warning, если не найден `external_upload=ok`.

### Load smoke

Без создания платежей/отправлений:

- 100 static requests / parallel 20 — HTTP 200;
- 50 catalog API requests / parallel 10 — HTTP 200;
- 10 validation POST requests — ожидаемые HTTP 400.

Ресурсы после:

- disk: `63%`, available `7.1G`;
- memory available: `3.1Gi`;
- swap used: `0B`.

### Изоляция production

- `komui.ru` DNS: `76.76.21.21`.
- `komui.ru` server header: `Vercel`.
- `stage.komui.ru` DNS: `89.111.152.112`.
- `stage.komui.ru` server header: `nginx`.
- `OZON_IMPORT_WRITE_SUPABASE=false`.
- `cdekCreateShipments=false`.
- `trafficSwitchEnabled=false`.
- active frontend не содержит Supabase runtime key/URL.

## Что не закрыто

1. Ozon admin import:
   - backend job ещё не реализован;
   - Supabase dual-write требует настоящий `service_role` / `sb_secret_...`.
2. Ручная приёмка владельца:
   - чеклист создан отдельно.
3. T-Bank demo E2E:
   - не запускался автоматически, чтобы не создавать платёж без ручного
     решения владельца.

## Production impact

Production не изменялся:

- DNS `komui.ru` не менялся;
- Vercel deployment не менялся;
- Supabase не менялся;
- production webhooks не менялись.

## Решение

Staging-инфраструктура готова к ручной проверке.

Этап 8 запрещён до отдельного явного разрешения production cutover.
