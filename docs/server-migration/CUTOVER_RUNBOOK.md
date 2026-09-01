# KOMUI production migration and cutover runbook

Статус: DNS/TLS cutover выполнен 30 июня 2026 года. Следующий controlled step —
payment-consistency migration/release; его не выполнять без отдельного явного
разрешения владельца.

Разделы про первоначальный DNS/Vercel cutover сохранены как historical
procedure. Они не описывают текущий live routing: production уже обслуживается
self-hosted Nginx/backend.

## Предусловия

- [ ] Владелец вручную принял staging.
- [ ] Есть свежий encrypted backup.
- [ ] Restore drill прошёл после последнего существенного изменения.
- [ ] External backup target работает.
- [ ] Monitoring/alerting работает.
- [ ] T-Bank demo payment/webhook E2E пройден.
- [ ] Текущий production backend `komui-production-backend` active.
- [ ] Текущий production runtime отвечает на `127.0.0.1:3001/health/ready`.
- [ ] Текущий production runtime отвечает через Nginx/`komui.ru`.
- [ ] Production DB `komui_production` обновлена свежим snapshot или явно
  принята как есть.
- [ ] Production T-Bank mode/credentials/webhook подтверждены.
- [ ] CDEK quote и production shipment policy подтверждены.
- [ ] Ozon import dry-run/job готов или явно исключён из cutover.
- [ ] Подготовлен rollback window.
- [ ] Подтверждены текущие DNS TTL.
- [ ] Подтверждены production webhook настройки Т-Банка.

Текущий evidence для rollback archive staging rollout:

```text
archive: /var/backups/komui/daily/komui-backup-20260830T180555Z.tar.gz.gpg
checksum/external upload: OK
restore drill: OK, 2026-09-01, staging + production DB dumps
app-role/legacy-runtime smoke: OK in outbound-isolated namespaces
cleanup/live-runtime invariants: OK
log: /var/backups/komui/logs/restore-drill-20260830T180555Z-20260901t082839z.log
```

Этот evidence не отменяет новый backup/restore gate для будущего production
window. Текущий backup format не сохраняет owners/ACL, а runtime-config archive
не покрывает production Nginx/systemd/frontend контур полностью. До заявления
полного production DR исправить оба пробела, создать новый archive и проверить
также offsite download + доступность ключа вне самого сервера.

## Pre-freeze перед migration window

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

## Обязательный gate для payment-consistency migration

Migration `20260830143000_harden_payment_consistency.sql` и backend, который
ставит durable CDEK effects для `PARTIAL_REVERSED`/amount mismatch, должны
вводиться только в одном maintenance window. Проверенный до окна нулевой
агрегат не заменяет повторную проверку после остановки writes: между проверкой
и migration может прийти подписанный webhook.

Generic Telegram/Git deploy не применяет migration и не должен использоваться
для этого cutover. Установленный `komui-deploy-from-git` проверяет
source/schema до build/activation: legacy code блокируется на migrated DB, а
новый code — на legacy DB. Это только аварийный fail-closed gate, а не механизм
миграции. До controlled window можно выполнить non-activation operational
check:

```bash
sudo /usr/local/sbin/komui-deploy-from-git prod main --check-compatibility-only
```

Этот режим не строит release, не переключает symlink и не перезапускает
services, но fetch/reset/clean выполняются в специально disposable
`/opt/komui/deploy-source`. Не хранить в этом checkout ручные изменения.

После merge hardening в `main` эта команда обязана блокироваться до применения
migration. Candidate release готовится отдельно до write gate; активация
выполняется только после backup, migration и разбора provider-effect backfill.

Порядок обязателен:

1. Взять тот же `/run/komui-deploy.lock`, который использует
   `komui-deploy-from-git`, и удерживать его на всём migration/activation
   window. Это исключает параллельный Telegram/Git deploy. Staging rollout
   использовал именно этот lock.
2. Включить maintenance для checkout и отдельно закрыть внешний
   `POST /api/v1/webhooks/tbank` на Nginx. Уже принятые соединения должны быть
   дренированы; нельзя просто скрыть frontend.
3. Проверить `nginx -t`, применить reload и убедиться снаружи, что checkout
   writes/webhook больше не доходят до backend.
4. Остановить **старый** backend и убедиться, что unit не active. Имена ниже
   иллюстративны — использовать фактический production unit:

```bash
sudo nginx -t
sudo systemctl reload nginx
sudo systemctl stop komui-production-backend
sudo systemctl is-active komui-production-backend
```

5. В том же закрытом окне повторить агрегатный preflight в production DB.
   Команда не должна печатать connection string или secret values:

```bash
sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d komui_production <<'SQL'
select count(*) as partial_reversed_attempts
from public.merch_payment_attempts as attempts
where attempts.provider = 'tbank'
  and attempts.provider_status = 'PARTIAL_REVERSED';

select
  count(*) filter (
    where events.provider_status = 'PARTIAL_REVERSED'
  ) as signed_partial_reversed_events,
  count(*) filter (
    where events.provider_status = 'AUTH_FAIL'
  ) as signed_auth_fail_events
from public.merch_payment_events as events
where events.provider = 'tbank'
  and events.signature_valid = true
  and events.provider_status in ('PARTIAL_REVERSED', 'AUTH_FAIL');

select count(*) as signed_amount_mismatch_events_on_fulfillable
from public.merch_payment_events as events
join public.merch_customer_orders as orders
  on orders.id = events.order_id
left join public.merch_payment_attempts as attempts
  on attempts.id = events.payment_attempt_id
where events.provider = 'tbank'
  and events.signature_valid = true
  and (
    events.amount is distinct from orders.total_amount
    or (
      attempts.id is not null
      and attempts.amount is distinct from orders.total_amount
    )
  )
  and orders.status in ('authorized', 'paid', 'partially_refunded', 'payment_review')
  and exists (
    select 1
    from public.merch_cdek_shipments as shipments
    where shipments.order_id = orders.id
      and shipments.status <> 'deleted'
  );

select count(distinct events.order_id) as signed_full_cancel_events_on_fulfillable
from public.merch_payment_events as events
join public.merch_customer_orders as orders
  on orders.id = events.order_id
where events.provider = 'tbank'
  and events.signature_valid = true
  and events.provider_status in ('REVERSED', 'REFUNDED')
  and orders.status in ('authorized', 'paid', 'partially_refunded', 'payment_review')
  and exists (
    select 1
    from public.merch_cdek_shipments as shipments
    where shipments.order_id = orders.id
      and shipments.status <> 'deleted'
  );

select count(distinct events.order_id) as direct_partial_refunds_on_fulfillable
from public.merch_payment_events as events
join public.merch_customer_orders as orders
  on orders.id = events.order_id
where events.provider = 'tbank'
  and events.signature_valid = true
  and events.provider_status = 'PARTIAL_REFUNDED'
  and not exists (
    select 1
    from public.merch_payment_events as confirmed
    where confirmed.provider = 'tbank'
      and confirmed.signature_valid = true
      and confirmed.order_id = events.order_id
      and confirmed.external_payment_id is not distinct from events.external_payment_id
      and confirmed.provider_status = 'CONFIRMED'
      and confirmed.received_at <= events.received_at
  )
  and orders.status in ('authorized', 'paid', 'partially_refunded', 'payment_review')
  and exists (
    select 1
    from public.merch_cdek_shipments as shipments
    where shipments.order_id = orders.id
      and shipments.status <> 'deleted'
  );

select count(*) as auth_fail_attempts_marked_payment_failed
from public.merch_payment_attempts as attempts
join public.merch_customer_orders as orders
  on orders.id = attempts.order_id
where attempts.provider = 'tbank'
  and attempts.provider_status = 'AUTH_FAIL'
  and orders.status = 'payment_failed';
SQL
```

Все семь счётчиков должны быть ровно `0`. Проверка signed events обязательна:
текущий status попытки мог быть перезаписан более поздним webhook и сам по
себе не доказывает отсутствие исторического `AUTH_FAIL`/`PARTIAL_REVERSED`.
Любое ненулевое значение — **NO-GO**:
maintenance остаётся включённым, старый backend не запускается, строки
сверяются с T-Bank вручную; для уже отменённого финансового факта с живой
доставкой отдельно создаётся явный causal `cdek_cancel` до продолжения.
Preflight 30 августа 2026 года был нулевым, но во время deploy он всё равно
повторяется.

6. Снять/проверить backup и до старта нового backend отдельно посчитать:

   - строки, которые migration добавит в `merch_order_effects` как historical
     `cdek_cancel`;
   - уже due/processing CDEK effects;
   - T-Bank Init reconciliation candidates.

   Новый backend запускает оба worker сразу после `listen`; поэтому ненулевой
   результат может вызвать реальный CDEK `DELETE` или T-Bank reconciliation ещё
   до readiness-проверки. Такие строки должны быть поштучно согласованы либо
   переведены в явный operator review до старта. Временный `CDEK_MOCK=true` не
   является безопасным gate: mock-обработка может ошибочно отметить реальную
   доставку удалённой только в локальной БД.

7. Применить migration с `ON_ERROR_STOP=1`, повторить inventory уже по новой
   схеме и поштучно разрешить/quarantine все provider effects. Затем проверить
   **точный заранее подготовленный production release**, атомарно переключить
   `/opt/komui/production-current` и только после этого запускать unit.

   Нельзя ограничиваться `systemctl start komui-production-backend`: пока
   symlink указывает на legacy release, эта команда запустит старый backend на
   migrated DB. Нельзя использовать staging-only `komui-release-activate` — он
   управляет `/opt/komui/current` и `komui-backend`, а не production paths.

```bash
sudo -u postgres psql -X --single-transaction -v ON_ERROR_STOP=1 -d komui_production \
  -f /path/to/20260830143000_harden_payment_consistency.sql

# Эти два значения заранее вписываются как exact immutable release/40-char SHA.
# Placeholder-команда должна завершиться ошибкой, пока значения не заменены.
prod_release='/opt/komui/releases/REPLACE_WITH_EXACT_PROD_RELEASE'
expected_commit='REPLACE_WITH_EXACT_40_CHAR_GIT_COMMIT'

case "$prod_release" in
  /opt/komui/releases/*-prod-*) ;;
  *) echo 'invalid production release path' >&2; exit 1 ;;
esac
[[ "$expected_commit" =~ ^[0-9a-f]{40}$ ]] || {
  echo 'invalid expected commit' >&2
  exit 1
}
test -d "$prod_release/backend"
test -f "$prod_release/RELEASE"
test "$(awk -F= '$1 == "git_commit" {print $2}' "$prod_release/RELEASE")" = "$expected_commit"
test -f "$prod_release/backend/dist/cdekEffects.js"
test -f "$prod_release/backend/dist/tbankReconciliation.js"
test -f "$prod_release/backend/dist/tbankWebhook.js"

sudo ln -sfnT "$prod_release" /opt/komui/production-current
test "$(sudo readlink -f /opt/komui/production-current)" = "$prod_release"
sudo systemctl start komui-production-backend
sudo systemctl is-active komui-production-backend
curl -fsS http://127.0.0.1:3001/health/ready
```

При неуспешном readiness старый backend автоматически не возвращать и ingress
не открывать. Maintenance сохраняется; выполняется forward-fix/reconciliation
либо согласованный restore по rollback rule ниже. До открытия ingress также
проверить, что production frontend release собран из того же exact commit,
атомарно переключить `/var/lib/komui/production-root`, выполнить `nginx -t` и
только затем reload.

8. Проверить worker/effect logs и только после этого открыть webhook ingress и
   checkout, снова выполнив `nginx -t` перед reload.

Rollback rule: после применения migration старый backend нельзя
запускать против БД, снова принимающей payment/webhook writes — он не создаёт
новые causal effects и может потерять fulfillment cancellation. До открытия
ingress rollback из согласованного backup допустим только если новый backend
ещё не запускался и provider effects заведомо не выполнялись. После запуска
workers, любых provider calls или новых writes maintenance сохраняется,
выполняется data reconciliation/forward-fix либо отдельно согласованный restore;
простой restart старого binary запрещён.

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

## Финальные проверки текущего production runtime перед migration

Эти проверки не переключают live `komui.ru`; они проверяют уже работающий
self-hosted production через loopback и публичный endpoint.

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

Текущие настройки production:

```text
TBANK_MODE=production
CDEK_CREATE_SHIPMENTS=true
```

T-Bank работает в production mode, `TBANK_MOCK_PAYMENTS=false`. CDEK
auto-create включён; оплаченные заказы могут создавать реальные CDEK
отправления.

Исторический production snapshot перед DNS cutover:

```text
database: komui_production
source: komui_staging
backup: /var/backups/komui/daily/komui-backup-20260630T164013Z.tar.gz.gpg
external: s3://komui-backups/komui/stage/komui-backup-20260630T164013Z.tar.gz.gpg
restore drill: OK
```

Важно: snapshot содержит staging test orders/payments/CDEK rows. Если нужна
чистая история заказов, выполнить cleanup только по отдельному явному
разрешению.

## DNS cutover

Выполнено 30 июня 2026 года. Следующий блок сохранён как historical record и не
является инструкцией для payment-consistency release.

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

Фактический результат 30 июня 2026:

```text
komui.ru / www.komui.ru -> 89.111.152.112
certificate: /etc/letsencrypt/live/komui.ru/fullchain.pem
traffic switch: state=applied, mode=server, productionVhostEnabled=true
public smoke: root/checkout/payment-result/products/delivery-config/robots/sitemap HTTP 200
```

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

## Исторический DNS rollback

Если проблема до появления production writes:

1. Вернуть DNS на Vercel.
2. Вернуть T-Bank webhook на старый endpoint.
3. Проверить `komui.ru` на Vercel.

Если проблема после появления production writes:

1. Остановить новые checkout на новом сервере или включить maintenance.
2. Экспортировать новые orders/payments из server PostgreSQL.
3. Решить, переносить эти записи в Supabase или обрабатывать вручную.
4. Только после этого возвращать DNS/webhook.

## Исторический traffic fallback

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
