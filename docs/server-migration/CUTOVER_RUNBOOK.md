# KOMUI production cutover runbook draft

Статус: черновик. Не выполнять без отдельного явного разрешения владельца.

Production cutover относится к этапу 8 и не входит в staging-проверку.

## Предусловия

- [ ] Владелец вручную принял staging.
- [ ] Есть свежий encrypted backup.
- [ ] Restore drill прошёл после последнего существенного изменения.
- [ ] External backup target работает.
- [ ] Monitoring/alerting работает.
- [ ] T-Bank demo payment/webhook E2E пройден.
- [ ] Production candidate backend `komui-production-backend` active.
- [ ] Production candidate отвечает на `127.0.0.1:3001/health/ready`.
- [ ] Production candidate отвечает через Nginx по Host header `komui.ru`.
- [ ] Production DB `komui_production` обновлена свежим snapshot или явно
  принята как есть.
- [ ] Production T-Bank mode/credentials/webhook подтверждены.
- [ ] CDEK quote и production shipment policy подтверждены.
- [ ] Ozon import dry-run/job готов или явно исключён из cutover.
- [ ] Подготовлен rollback window.
- [ ] Подтверждены текущие DNS TTL.
- [ ] Подтверждены production webhook настройки Т-Банка.

## Freeze перед cutover

1. Зафиксировать время freeze.
2. Не запускать Ozon import.
3. Не менять каталог вручную.
4. Снять свежий backup:

```bash
sudo systemctl start komui-backup.service
sudo systemctl status komui-backup.service --no-pager -l
```

5. Проверить backup:

```bash
sudo find /var/backups/komui/daily -type f -name 'komui-backup-*.tar.gz.gpg' | sort | tail -1
```

## Финальные проверки staging

```bash
curl -fsS http://127.0.0.1:3000/health/ready
sudo systemctl is-active postgresql nginx komui-backend komui-backup.timer komui-healthcheck.timer
```

Проверить публично:

```text
https://stage.komui.ru/
https://stage.komui.ru/checkout
https://stage.komui.ru/api/v1/products?limit=1
```

## Финальные проверки production candidate

Эти проверки не переключают live `komui.ru`; они используют loopback и Host
header на сервере.

```bash
curl -fsS http://127.0.0.1:3001/health/ready
curl -fsS -H 'Host: komui.ru' http://127.0.0.1/ >/dev/null
curl -fsS -H 'Host: komui.ru' http://127.0.0.1/checkout >/dev/null
curl -fsS -H 'Host: komui.ru' 'http://127.0.0.1/api/v1/products?limit=1' >/dev/null
sudo systemctl is-active komui-production-backend
```

Проверить non-secret env:

```bash
sudo awk -F= '$1 ~ /^(NODE_ENV|RUNTIME_MODE|HOST|PORT|SITE_URL|PUBLIC_API_BASE_URL|TBANK_MODE|TBANK_MOCK_PAYMENTS|CDEK_MOCK|CDEK_CREATE_SHIPMENTS)$/ {print $1"="$2}' /etc/komui/backend-production.env
```

Текущие safe defaults production candidate:

```text
TBANK_MODE=demo
CDEK_CREATE_SHIPMENTS=false
```

Перед реальным cutover эти значения нужно подтвердить или заменить.

## DNS cutover

Не выполнять в staging.

Планируемые действия:

1. Уменьшить TTL заранее.
2. Переключить `komui.ru` на `89.111.152.112`.
3. Если используется `www.komui.ru`, переключить его согласно текущей DNS
   модели: A/AAAA/CNAME.
4. Дождаться propagation.
5. Выпустить/проверить production TLS certificate на новом сервере:

```bash
sudo /usr/local/sbin/komui-production-issue-cert-and-enable
```

6. Проверить `https://komui.ru`.

Скрипт выпуска TLS откажется работать, если `komui.ru` и `www.komui.ru` ещё не
резолвятся в `89.111.152.112`.

## Webhook cutover

Не выполнять до DNS/HTTPS готовности.

1. В T-Bank dashboard заменить webhook URL на новый production endpoint:

```text
https://komui.ru/api/v1/webhooks/tbank
```

2. Отправить test webhook.
3. Проверить backend logs и DB status.
4. Зафиксировать timestamp.

## Контрольные проверки после cutover

- [ ] `https://komui.ru` отвечает с нового сервера.
- [ ] `https://komui.ru/api/v1/products?limit=1` отвечает HTTP 200.
- [ ] Checkout открывается.
- [ ] Payment init работает в согласованном режиме.
- [ ] Webhook меняет статус заказа.
- [ ] CDEK shipment policy соблюдена.
- [ ] No 5xx в Nginx/backend logs.
- [ ] RAM/disk стабильны.

## Rollback

Если проблема до появления production writes:

1. Вернуть DNS на Vercel.
2. Вернуть T-Bank webhook на старый endpoint.
3. Проверить `komui.ru` на Vercel.

Если проблема после появления production writes:

1. Остановить новые checkout на новом сервере или включить maintenance.
2. Экспортировать новые orders/payments из server PostgreSQL.
3. Решить, переносить эти записи в Supabase или обрабатывать вручную.
4. Только после этого возвращать DNS/webhook.

## Traffic fallback

Fallback на текущий Vercel/Supabase может работать только если:

- новый сервер доступен;
- Nginx/backend умеет проксировать legacy origin;
- `LEGACY_ORIGIN` и `ENABLE_TRAFFIC_SWITCH` настроены.

Это не заменяет DNS rollback, если сам сервер недоступен.

## Стоп-условия

- Backup не создан или не восстанавливается.
- Monitoring/alerts не работают.
- Payment/webhook E2E не пройден.
- Неясно, как обработать rollback после новых заказов.
- Нет владельца на связи для решения.
