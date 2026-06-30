# KOMUI self-hosted server project overview

Дата актуализации: 30 июня 2026 года.

Этот документ описывает, как устроена текущая серверная реализация KOMUI на
`89.111.152.112`, какие компоненты уже перенесены с Supabase/Vercel, где лежит
код и конфигурация, как работают backend/API, PostgreSQL, staging, backup,
alerting, Ozon import и production traffic fallback.

Документ предназначен для разработчика, который не участвовал в миграции и
должен быстро понять проект.

Секреты, пароли, API keys и token values в документе не указаны. Они лежат
только на сервере в root-owned env-файлах.

## 1. Текущий статус

Сейчас проект работает в изолированном staging-контуре:

- production `https://komui.ru` остаётся на Vercel;
- production Supabase остаётся текущей рабочей базой;
- staging доступен на `https://stage.komui.ru`;
- staging закрыт Basic Auth и `noindex`;
- staging frontend ходит в собственный backend на сервере через `/api`;
- backend работает на `127.0.0.1:3000`;
- PostgreSQL работает локально на сервере и не открыт наружу;
- Supabase/Vercel production не переключались;
- production cutover не начат.

Ключевые safe-флаги на сервере:

```text
NODE_ENV=staging
RUNTIME_MODE=staging
SITE_URL=https://stage.komui.ru
PUBLIC_API_BASE_URL=https://stage.komui.ru/api
YANDEX_MAPS_API_KEY=SET

TBANK_MODE=demo
TBANK_MOCK_PAYMENTS=false

CDEK_API_BASE_URL=https://api.cdek.ru
CDEK_MOCK=false
CDEK_CREATE_SHIPMENTS=true

OZON_IMPORT_MODE=dry_run
OZON_IMPORT_WRITE_SUPABASE=false

ENABLE_TRAFFIC_SWITCH=true
LEGACY_ORIGIN=https://komui.vercel.app
```

Важно: `OZON_IMPORT_WRITE_SUPABASE=false` означает, что Ozon import сейчас не
пишет в текущую production Supabase-базу. Это сделано намеренно.

### 1.1. Последние существенные обновления

#### 30 июня 2026 — server-side CDEK shipment creation

Backend release `20260630-cdek-shipments-server` добавил создание отправлений
СДЭК на сервере без участия Supabase Edge Functions:

- `server/src/cdek.ts` теперь умеет собирать payload `/v2/orders`, создавать
  CDEK order и нормализовать ответ CDEK в статусы `accepted`, `created`,
  `invalid`, `unknown`;
- `server/src/cdekShipments.ts` отвечает за idempotent-запись в
  `public.merch_cdek_shipments`, повтор failed/invalid shipment, сохранение
  request/response/error payload и ручной admin endpoint;
- T-Bank webhook в `server/src/stage5.ts` после перехода заказа в `paid`
  вызывает CDEK shipment creation только если `CDEK_CREATE_SHIPMENTS=true`;
- на staging флаг `CDEK_CREATE_SHIPMENTS=true`, поэтому paid-заказы теперь
  создают реальные CDEK shipment;
- ручной endpoint доступен как
  `POST https://stage.komui.ru/api/admin/cdek/shipments/create` и требует
  admin token плюс явное тело `{"orderNumber":"KOM-...","confirm":true}`;
- `payment-result.html` обновлён: после paid-статуса страница показывает
  человекочитаемый статус трек-номера СДЭК, продолжает короткий polling, если
  номер ещё не появился, и показывает кнопку отслеживания на сайте СДЭК, когда
  номер уже доступен.

#### 30 июня 2026 — повтор оплаты после failed payment

Исправлен сценарий, когда после отклонённого Т-Банком платежа повторная попытка
оформления сразу возвращала пользователя на старый failed-result:

- backend больше не возвращает старый `payment_url` для order со статусом
  `payment_failed`, `canceled`, `refunded` или последней попыткой оплаты в
  терминальном failed-статусе (`REJECTED`, `CANCELED`, `DEADLINE_EXPIRED`,
  `AUTH_FAIL`);
- вместо этого `/v1/payments` возвращает `payment_retry_required` с
  `retryAllowed=true`;
- `checkout.html` очищает stale `komui-payment-draft-v1`, создаёт новый
  `clientRequestId` и один раз автоматически повторяет создание платежа;
- `payment-result.html` при failed-экране очищает только payment draft/session,
  сохраняя корзину и введённые данные.

#### 30 июня 2026 — structured logs для CDEK shipment flow

Добавлены подробные structured logs в T-Bank webhook и CDEK shipment service:

- webhook пишет `orderNumber`, `paymentId`, `providerStatus`, рассчитанный
  `nextStatus`, текущий статус заказа и `CDEK_CREATE_SHIPMENTS`;
- если создание CDEK shipment пропущено, лог содержит явный reason
  `cdek_create_shipments_disabled`;
- CDEK service пишет этапы `loaded order`, `package snapshot built`,
  `request prepared`, `DB row inserted/reset`, `CDEK order API request started`
  и `finished/failed`;
- в логах намеренно нет ФИО, телефона, полного CDEK payload или секретов.

Текущий важный факт по staging: `CDEK_CREATE_SHIPMENTS=true`, поэтому paid
orders создают реальные заказы в CDEK автоматически.

#### 30 июня 2026 — CDEK async number sync

Для заказа `KOM-879480584` CDEK вернул первичный ответ `/v2/orders` как
`ACCEPTED` без `cdek_number`, но по follow-up запросу `/v2/orders/{uuid}` уже
отдал номер `10288069122` и state `SUCCESSFUL`.

Backend обновлён:

- `server/src/cdek.ts` получил `getCdekOrder(config, uuid)`;
- `cdekNumberFromResponse` теперь берёт номер как из `related_entities`, так и
  из `entity.cdek_number`;
- `createCdekShipmentForOrder` после `ACCEPTED` без номера делает короткий
  follow-up sync по CDEK UUID и сохраняет номер, если CDEK уже его выдал;
- DB для `KOM-879480584` обновлена: `status=created`,
  `cdek_number=10288069122`.

#### 30 июня 2026 — fresh backup and restore drill

После последних backend/CDEK изменений выполнена свежая проверка backup/restore:

- создан encrypted backup
  `/var/backups/komui/daily/komui-backup-20260630T145422Z.tar.gz.gpg`;
- размер архива: `40 267 466 bytes`;
- локальный `.sha256` проверен;
- archive и `.sha256` загружены в Yandex Object Storage:
  `s3://komui-backups/komui/stage/`;
- restore drill выполнен во временную БД
  `komui_restore_drill_20260630145919`;
- восстановлено `31` public tables;
- контрольные row counts: `merch_storefront_products=31`,
  `merch_customer_orders=13`, `merch_payment_attempts=13`,
  `merch_cdek_shipments=3`;
- временный backend на restored DB вернул `/health/ready` HTTP `200` и
  `/v1/products?limit=1` HTTP `200`;
- временная БД удалена; активных `komui_restore_drill_*` БД не осталось.

#### 30 июня 2026 — production candidate prepared without cutover

Подготовлен отдельный production candidate-контур на том же сервере, не
затрагивающий `stage.komui.ru` и текущий live `komui.ru` на Vercel:

- создана отдельная БД `komui_production` из текущего `komui_staging`;
- production backend env: `/etc/komui/backend-production.env`;
- production backend service: `komui-production-backend`;
- production backend bind: `127.0.0.1:3001`;
- production backend release symlink:
  `/opt/komui/production-current -> /opt/komui/releases/20260630185629-admin-storefront-orders-fix`;
- production static root:
  `/var/lib/komui/production-root -> /opt/komui/production-frontend-releases/20260630T160446Z-production-candidate`;
- Nginx pre-cutover HTTP vhost enabled for Host `komui.ru` / `www.komui.ru`;
- Nginx production runtime snippet points to
  `/var/lib/komui/production-root` and backend `127.0.0.1:3001`;
- TLS vhost `/etc/nginx/sites-available/komui-production-switch` is prepared
  but not enabled, because the real `komui.ru` certificate cannot be issued
  until DNS points to this server or DNS-01 TXT validation is performed.

Verified locally on the server through loopback Host header:

```text
Host komui.ru http://127.0.0.1/                         HTTP 200
Host komui.ru http://127.0.0.1/checkout                 HTTP 200
Host komui.ru http://127.0.0.1/api/v1/products?limit=1  HTTP 200
http://127.0.0.1:3001/health/ready                      HTTP 200
```

Current production candidate settings:

```text
NODE_ENV=production
RUNTIME_MODE=server
SITE_URL=https://komui.ru
PUBLIC_API_BASE_URL=https://komui.ru/api
TBANK_MODE=demo
TBANK_MOCK_PAYMENTS=false
CDEK_MOCK=false
CDEK_CREATE_SHIPMENTS=true
```

Before real cutover, production DNS/TLS and T-Bank webhook still must be
completed separately.

#### 30 июня 2026 — final production snapshot candidate

По решению владельца перед cutover:

- T-Bank в production candidate оставлен на demo/test ключах;
- CDEK в production candidate должен создавать реальные отправления;
- `CDEK_CREATE_SHIPMENTS=true` включён в
  `/etc/komui/backend-production.env`.

Выполнен свежий snapshot:

- сначала создан encrypted backup текущего staging/config:
  `/var/backups/komui/daily/komui-backup-20260630T163903Z.tar.gz.gpg`;
- `komui_production` обновлена из текущей `komui_staging`;
- предыдущая production candidate DB сохранена как
  `komui_production_prev_20260630163957`;
- после snapshot создан encrypted backup именно production DB:
  `/var/backups/komui/daily/komui-backup-20260630T164013Z.tar.gz.gpg`;
- backup загружен в Yandex Object Storage:
  `s3://komui-backups/komui/stage/komui-backup-20260630T164013Z.tar.gz.gpg`;
- restore drill production snapshot прошёл успешно:
  `komui_production_snapshot_drill_20260630164055`;
- временная drill DB удалена.

Production snapshot row counts:

```text
public tables: 31
merch_storefront_products: 31
merch_customer_orders: 13
merch_payment_attempts: 13
merch_cdek_shipments: 3
```

Important: `komui_production` сейчас создана из staging и содержит staging
тестовые transactional rows. Если перед настоящим DNS cutover нужна чистая
история заказов, эти строки нужно удалить отдельным явно разрешённым cleanup.

#### 30 июня 2026 — DNS and TLS production cutover started

Владелец переключил DNS:

```text
komui.ru      A 89.111.152.112
www.komui.ru  A 89.111.152.112
```

После propagation выполнено:

- выпущен Let's Encrypt certificate для `komui.ru` и `www.komui.ru`;
- certificate path: `/etc/letsencrypt/live/komui.ru/fullchain.pem`;
- expiry: 2026-09-28;
- HTTPS production vhost `/etc/nginx/sites-enabled/komui-production-switch`
  включён;
- traffic switch переведён в applied server mode:
  `state=applied`, `mode=server`, `productionVhostEnabled=true`;
- `https://komui.ru`, `https://www.komui.ru`,
  `https://komui.ru/checkout`, `https://komui.ru/payment-result`,
  `https://komui.ru/api/v1/products?limit=1`,
  `https://komui.ru/api/delivery-config`, `robots.txt` и `sitemap.xml`
  вернули HTTP `200`.

Production теперь обслуживается self-hosted сервером. `stage.komui.ru`
продолжает работать отдельным Basic Auth/noindex контуром.

Оставшиеся обязательные cutover-действия: переключить/подтвердить T-Bank
webhook на `https://komui.ru/api/v1/webhooks/tbank`, выполнить тестовый платёж
в demo mode и наблюдать логи/алерты.

## 2. Высокоуровневая архитектура

```text
Пользователь / тестировщик
        |
        v
https://stage.komui.ru
        |
        v
Nginx staging vhost
  - TLS Let's Encrypt
  - Basic Auth
  - X-Robots-Tag noindex
  - /api/* -> backend 127.0.0.1:3000
  - остальные пути -> static frontend
        |
        +--------------------------+
        |                          |
        v                          v
Static frontend              Fastify backend
/var/lib/komui/staging-root  /opt/komui/current/backend
                                  |
                                  v
                           PostgreSQL local
                           database: komui_staging

Дополнительно:

- komui-backup.timer -> encrypted local backup -> Yandex Object Storage
- komui-healthcheck.timer -> local checks -> Telegram alert on failure
- komui-traffic-switch.path -> prepares production server/legacy runtime mode
```

## 3. Сервер и системные ресурсы

Сервер:

```text
IP: 89.111.152.112
Hostname: cv6065797.novalocal
OS: Ubuntu 24.04.4 LTS
Virtualization: KVM / OpenStack Nova
Architecture: x86-64
Disk: 20G, сейчас около 12G used / 7.1G available
RAM: около 3.8Gi total, около 3.0Gi available
Swap: 2.0Gi, сейчас 0B used
```

Основные сервисы:

```text
postgresql                 active
nginx                      active
komui-backend              active
komui-backup.timer         active
komui-healthcheck.timer    active
komui-traffic-switch.path  active
```

## 4. Основные серверные пути

### Backend releases

```text
/opt/komui/releases/
/opt/komui/current -> /opt/komui/releases/<active-release>
/opt/komui/current/backend
```

Активный backend release на момент проверки:

```text
/opt/komui/releases/20260628-yandex-maps-config
```

Backend запускается из:

```text
/opt/komui/current/backend/dist/server.js
```

### Frontend releases

```text
/opt/komui/frontend-releases/
/var/lib/komui/staging-root -> /opt/komui/frontend-releases/20260627114138-stage6-frontend
/opt/komui/production-frontend-releases/
/var/lib/komui/production-root -> /opt/komui/production-frontend-releases/20260630T160446Z-production-candidate
```

`/var/lib/komui/staging-root` — static root для Nginx staging.
`/var/lib/komui/production-root` — static root для production candidate.

### Runtime state

```text
/var/lib/komui/traffic-switch/
/var/lib/komui/admin-audit.log
/var/log/komui/
```

### Конфигурация и секреты

```text
/etc/komui/backend.env
/etc/komui/backend-production.env
/etc/komui/ozon-sync.env
/etc/komui/staging-access.env
/etc/komui/yandex-backup.env
/etc/komui/telegram-alerts.env
/etc/komui/traffic-switch.env
/etc/komui/backup.key
```

Эти файлы не должны попадать в Git.

Important runtime permissions:

```text
/etc/komui                  root:komui 0710
/etc/komui/backend.env      root:komui 0640
/etc/komui/backend-production.env root:komui 0640
/etc/komui/ozon-sync.env    root:komui 0640
```

`backend.env` is loaded by systemd before the process starts, so the `komui`
runtime user does not need to read it directly. `ozon-sync.env` is read by the
backend process at request time, so user `komui` needs execute permission on
`/etc/komui` and read permission on `ozon-sync.env`.

### Nginx

```text
/etc/nginx/sites-available/komui-staging
/etc/nginx/sites-enabled/komui-staging

/etc/nginx/sites-available/komui-production-switch
/etc/nginx/sites-available/komui-production-http-precutover
/etc/nginx/sites-enabled/komui-production-http-precutover
/etc/nginx/snippets/komui-production-runtime.conf

/etc/nginx/sites-available/api.komui.ru
/etc/nginx/sites-enabled/api.komui.ru
```

`komui-production-http-precutover` включён только для HTTP loopback/pre-cutover
проверок и ACME webroot. Live `komui.ru` всё ещё не обслуживается этим сервером,
пока DNS указывает на Vercel.

`komui-production-switch` — будущий HTTPS vhost. Он сейчас не включён в
`sites-enabled`, потому что на сервере ещё нет certificate для `komui.ru`.

## 5. Git repository layout

Основной workspace:

```text
/Users/kadimagomedov/Documents/KomuiMerch
```

Новые/важные директории после миграции:

```text
server/                    Node.js/Fastify backend
ops/server/                systemd/Nginx/backup/healthcheck scripts
docs/server-migration/     migration docs, runbooks, SQL
.ai/server-migration/      working reports/context for migration
```

Backend package:

```text
server/package.json
server/src/*.ts
server/test/*.test.ts
```

NPM scripts:

```bash
cd server
npm test
npm run build
npm start
```

Backend dependencies:

- Fastify;
- `pg`;
- Zod;
- TypeScript;
- Node.js >= 22.

## 6. Nginx routing

### Staging

`stage.komui.ru`:

- HTTP 80 redirects to HTTPS;
- HTTPS uses Let's Encrypt cert;
- Basic Auth enabled;
- `X-Robots-Tag: noindex, nofollow, noarchive`;
- `/api/` proxies to `http://127.0.0.1:3000/`;
- all non-API paths serve static frontend from `/var/lib/komui/staging-root`.

Key routing:

```nginx
location /api/ {
    proxy_pass http://127.0.0.1:3000/;
}

location / {
    try_files $uri $uri.html $uri/ /index.html;
}
```

Because `proxy_pass` ends with `/`, Nginx strips `/api/` before sending the
request to Fastify.

Example:

```text
https://stage.komui.ru/api/v1/products
        -> backend receives /v1/products
```

### Existing `api.komui.ru`

`api.komui.ru` is still an existing production proxy to current Supabase:

```text
https://bkxpzfnglihxpbnhtjjq.supabase.co
```

This vhost is intentionally preserved for current production compatibility.
Do not repoint or remove it before production cutover.

### Prepared production switch vhost

Prepared but not enabled:

```text
/etc/nginx/sites-available/komui-production-switch
```

Enabled pre-cutover HTTP candidate:

```text
/etc/nginx/sites-available/komui-production-http-precutover
/etc/nginx/sites-enabled/komui-production-http-precutover
```

It is designed for the future stage 8 production cutover. It serves:

```text
komui.ru
www.komui.ru
```

and includes:

```text
/etc/nginx/snippets/komui-production-runtime.conf
```

The runtime snippet can be changed by `komui-traffic-switch` to either:

- serve the self-hosted static frontend + backend API;
- proxy all traffic to legacy Vercel origin.

Currently:

```text
productionHttpPrecutoverEnabled=true
productionTlsVhostEnabled=false
mode=server
state=prepared
```

So live `komui.ru` is unaffected.

## 7. Backend service

Staging systemd unit:

```text
/etc/systemd/system/komui-backend.service
bind: 127.0.0.1:3000
env: /etc/komui/backend.env
database: komui_staging
```

Production candidate systemd unit:

```text
/etc/systemd/system/komui-production-backend.service
bind: 127.0.0.1:3001
env: /etc/komui/backend-production.env
database: komui_production
```

Runs as:

```text
User=komui
Group=komui
WorkingDirectory=/opt/komui/current/backend
EnvironmentFile=/etc/komui/backend.env
ExecStart=/usr/bin/node /opt/komui/current/backend/dist/server.js
```

Important hardening:

```text
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
ReadWritePaths=/var/lib/komui /var/log/komui
MemoryHigh=900M
MemoryMax=1200M
```

Logs:

```text
/var/log/komui/backend.log
/var/log/komui/backend-error.log
```

Common commands:

```bash
sudo systemctl status komui-backend --no-pager -l
sudo journalctl -u komui-backend -n 100 --no-pager
sudo tail -n 100 /var/log/komui/backend.log
sudo tail -n 100 /var/log/komui/backend-error.log
sudo systemctl restart komui-backend
```

## 8. Backend code structure

Main files:

```text
server/src/server.ts         process entrypoint
server/src/app.ts            Fastify app, routes, admin auth, error handler
server/src/config.ts         env schema and public config
server/src/db.ts             pg Pool and transaction helper
server/src/catalog.ts        storefront product read API
server/src/checkout.ts       order/cart validation and repository
server/src/stage5.ts         CDEK, promo, T-Bank handlers, compatibility route
server/src/cdek.ts           CDEK client and package calculations
server/src/cdekShipments.ts  CDEK shipment DB workflow and admin retry endpoint
server/src/promo.ts          promo code logic
server/src/crypto.ts         T-Bank token/signature helpers
server/src/ozonImport.ts     Ozon preview/import/job status
server/src/runtimeSwitch.ts  admin-controlled production runtime switch API
server/src/audit.ts          admin audit append log
server/src/errors.ts         HttpError and helpers
```

Tests:

```text
server/test/*.test.ts
```

Current test count:

```text
28 tests passing
```

## 9. Backend API routes

Through Nginx, public staging URL prefix is:

```text
https://stage.komui.ru/api
```

Fastify itself listens without `/api` prefix on `127.0.0.1:3000`.

### Health

```text
GET /health/live
GET /healthz
GET /health/ready
GET /readyz
```

`/health/ready` checks PostgreSQL and returns non-secret public config.

### Catalog

```text
GET /v1/products?limit=200
GET /v1/products/:slug
GET /v1/catalog/stats
```

Uses `public.merch_storefront_products`.

Only public storefront fields are returned. Raw/internal fields such as
`source_payload`, `ozon_attributes`, internal costs and warehouse data are not
returned to the browser.

### Delivery / CDEK

```text
GET  /delivery-config
POST /v1/delivery/points
POST /v1/delivery/quote
POST /admin/cdek/shipments/create
```

`/delivery-config` returns the browser JavaScript config used by checkout:

```js
window.KOMUI_DELIVERY = Object.assign({}, window.KOMUI_DELIVERY, {
  yandexMapsApiKey: "<public browser key>"
});
```

Through staging Nginx this endpoint is available as:

```text
https://stage.komui.ru/api/delivery-config
```

The value comes from `/etc/komui/backend.env` as `YANDEX_MAPS_API_KEY`.
The static fallback file `data/delivery-config.js` intentionally contains an
empty key and must not be used as the primary server runtime config.

Current flags:

```text
CDEK_MOCK=false
CDEK_CREATE_SHIPMENTS=true
```

Meaning:

- delivery points/quote use real CDEK API credentials;
- real shipment creation code is deployed;
- automatic real shipment creation is enabled by
  `CDEK_CREATE_SHIPMENTS=true`;
- manual admin creation requires `confirm: true`.

Manual shipment creation/retry:

```http
POST /admin/cdek/shipments/create
Authorization: Bearer <ADMIN_API_TOKEN>
Content-Type: application/json

{
  "orderNumber": "KOM-123456789",
  "confirm": true
}
```

The endpoint:

- only works for paid/authorized orders;
- returns an existing non-failed shipment instead of creating duplicates;
- retries only `failed`/`invalid` shipments;
- stores CDEK request/response/error payload in `public.merch_cdek_shipments`.

### Promo

```text
POST /v1/promos/validate
```

Uses:

```text
public.merch_promo_codes
public.merch_promo_redemptions
```

Phone values are normalized and hashed for promo usage accounting.

### T-Bank payment

```text
POST /v1/payments
POST /v1/payments/status
POST /v1/webhooks/tbank
```

Current flags:

```text
TBANK_MODE=demo
TBANK_MOCK_PAYMENTS=false
```

Meaning:

- real T-Bank demo API is used;
- this is not production terminal mode;
- full demo payment/webhook E2E is still a manual acceptance step.

T-Bank token/signature logic is implemented in `server/src/crypto.ts`.

### Compatibility route for old frontend/function shape

```text
POST /supabase-function?name=<old-function-name>
POST /api/supabase-function?name=<old-function-name>
```

Supported compatibility names map to the new backend handlers:

```text
cdek-delivery-points
cdek-delivery-quote
promo-validate
tbank-create-payment
tbank-payment-status
```

This allows older frontend call sites that used Supabase Edge Function names to
work against the new backend.

### Admin runtime / traffic switch

```text
GET  /admin/runtime
POST /admin/runtime/fallback
```

Admin auth:

- either `Authorization: Bearer <ADMIN_API_TOKEN>`;
- or `X-Komui-Admin-Token: <ADMIN_API_TOKEN>`.

For staging behind Basic Auth, use Basic Auth in `Authorization` and admin token
in `X-Komui-Admin-Token`.

`GET /admin/runtime` returns current runtime switch status.

`POST /admin/runtime/fallback` accepts:

```json
{
  "mode": "server",
  "confirm": true,
  "reason": "manual owner action"
}
```

Modes:

```text
server  -> self-hosted frontend/backend
legacy  -> proxy to LEGACY_ORIGIN=https://komui.vercel.app
```

The POST is asynchronous:

- backend writes `/var/lib/komui/traffic-switch/request.json`;
- systemd path unit runs `/usr/local/sbin/komui-traffic-switch-apply`;
- status is written to `/var/lib/komui/traffic-switch/status.json`;
- admin UI should poll `GET /admin/runtime`.

Current production impact:

```text
productionVhostEnabled=false
```

So switching modes does not affect live `komui.ru` until production vhost is
enabled and DNS points to this server.

### Admin Ozon import

```text
POST /admin/ozon/products/import-preview
POST /admin/ozon/products/import
GET  /admin/ozon/jobs/:jobId
```

Credentials/config:

```text
/etc/komui/ozon-sync.env
```

Current mode:

```text
OZON_IMPORT_MODE=dry_run
OZON_IMPORT_WRITE_SUPABASE=false
```

Flow:

1. `import-preview` calls Ozon Seller API `/v5/product/info/prices`.
2. Backend loads existing products from local PostgreSQL.
3. It matches Ozon items by:
   - `ozon_offer_ids`;
   - `ozon_skus`;
   - `ozon_product_ids`;
   - normalized design key derived from offer id, where possible.
4. Preview is saved in `public.merch_admin_import_previews`.
5. Admin UI shows summary/diff.
6. `import` applies matched updates to local server PostgreSQL.
7. Job status/result is saved in `public.merch_admin_jobs`.

Safety behavior:

- matched existing storefront products can be updated;
- unmatched/new Ozon products are not auto-published as active storefront
  cards;
- Supabase writes are skipped while `OZON_IMPORT_WRITE_SUPABASE=false`;
- every import job supports idempotency key.

Current smoke result:

```text
Ozon preview with limit=1: HTTP 200
matchedStorefront=1
actionableServerPostgres=1
actionableSupabase=0
```

## 10. PostgreSQL

Database:

```text
komui_staging
```

PostgreSQL is local only; application connects through `DATABASE_URL` in
`/etc/komui/backend.env`.

Current table count in `public`:

```text
31 tables
```

Important tables:

```text
public.merch_storefront_products       public catalog source
public.merch_products                  internal products/SKU source
public.merch_customer_orders           checkout orders
public.merch_customer_order_items      checkout items
public.merch_payment_attempts          payment init/status
public.merch_payment_events            payment webhooks/events
public.merch_promo_codes               promo config
public.merch_promo_redemptions         promo usage
public.merch_cdek_shipments            CDEK shipment records
public.merch_cdek_events               CDEK events
public.merch_admin_import_previews     Ozon import previews
public.merch_admin_jobs                Ozon import jobs
```

Current key counts:

```text
merch_storefront_products=31
merch_products=151
admin_previews=7
admin_jobs=1
```

Admin import tables were added by:

```text
docs/server-migration/sql/ozon-admin-import-forward.sql
```

`public.merch_admin_import_previews`:

```text
id uuid primary key
import_type text
request_payload jsonb
summary jsonb
items jsonb
can_import boolean
warnings jsonb
created_at timestamptz
```

`public.merch_admin_jobs`:

```text
id uuid primary key
job_type text
status text
idempotency_key text
preview_id uuid
request_payload jsonb
result_payload jsonb
errors jsonb
progress_current integer
progress_total integer
created_at timestamptz
started_at timestamptz
finished_at timestamptz
updated_at timestamptz
```

Unique index:

```text
merch_admin_jobs_idempotency_key_idx
  on (job_type, idempotency_key)
  where idempotency_key is not null
```

## 11. Frontend/static site

Static frontend is deployed to:

```text
/opt/komui/frontend-releases/20260627114138-stage6-frontend
```

and exposed through:

```text
/var/lib/komui/staging-root
```

The current frontend no longer contains runtime Supabase URL/key in deployed
HTML/JS/CSS under `/var/lib/komui/staging-root`.

Runtime API config file:

```text
data/api-config.js
```

It defines:

```js
window.KOMUI_API = {
  baseUrl: "/api"
}
```

Delivery/map runtime config is loaded by checkout from:

```text
/api/delivery-config
```

and falls back to:

```text
data/delivery-config.js
```

On the server the primary source is the backend endpoint, not the static
fallback file.

The older `data/supabase-config.js` was removed from the new frontend runtime.

There is still a legacy file in the Git repo:

```text
api/supabase-function.js
```

It proxies to Supabase Edge Functions and is part of the old Vercel production
compatibility path. It is not deployed into the current staging static root.
Do not delete or change it without checking current Vercel production behavior.

## 12. Backup

Installed script:

```text
/usr/local/sbin/komui-backup
```

Systemd:

```text
/etc/systemd/system/komui-backup.service
/etc/systemd/system/komui-backup.timer
```

Timer:

```text
komui-backup.timer active
```

Backup root:

```text
/var/backups/komui
```

Daily examples:

```text
/var/backups/komui/daily/komui-backup-20260627T120725Z.tar.gz.gpg
/var/backups/komui/daily/komui-backup-20260627T143747Z.tar.gz.gpg
/var/backups/komui/daily/komui-backup-20260630T145422Z.tar.gz.gpg
```

Backup includes:

- PostgreSQL custom dump;
- PostgreSQL globals;
- runtime config archive;
- Nginx/systemd relevant configs;
- manifest;
- checksums.

Encryption:

```text
/etc/komui/backup.key
```

External upload:

```text
Yandex Object Storage
bucket: komui-backups
prefix: komui/stage/
endpoint: https://storage.yandexcloud.net
```

Credentials:

```text
/etc/komui/yandex-backup.env
```

Latest verified backup/restore:

```text
archive: /var/backups/komui/daily/komui-backup-20260630T145422Z.tar.gz.gpg
external: s3://komui-backups/komui/stage/komui-backup-20260630T145422Z.tar.gz.gpg
restore drill: OK, 2026-06-30, 31 public tables, temp backend HTTP 200
production snapshot archive: /var/backups/komui/daily/komui-backup-20260630T164013Z.tar.gz.gpg
production snapshot restore drill: OK, 2026-06-30, 31 public tables
```

Useful commands:

```bash
sudo systemctl start komui-backup.service
sudo systemctl status komui-backup.service --no-pager -l
sudo journalctl -u komui-backup.service -n 100 --no-pager
sudo find /var/backups/komui/daily -type f -name 'komui-backup-*.tar.gz.gpg' | sort | tail -5
```

## 13. Healthcheck and alerting

Installed script:

```text
/usr/local/sbin/komui-healthcheck
```

Systemd:

```text
/etc/systemd/system/komui-healthcheck.service
/etc/systemd/system/komui-healthcheck.timer
```

Timer:

```text
every 5 minutes
```

Healthcheck verifies:

- PostgreSQL active;
- Nginx active;
- backend active;
- backup timer active;
- backend `/health/ready`;
- stage root HTTPS;
- stage catalog API HTTPS;
- disk under threshold;
- memory available;
- backup freshness;
- no failed systemd units;
- no stale pending payments.

Current result:

```text
SUMMARY OK
```

Alert script:

```text
/usr/local/sbin/komui-alert
```

Telegram messages are sent with HTML formatting. The common alert template
contains:

- clear bold title;
- server hostname;
- UTC timestamp;
- escaped details block.

Telegram config:

```text
/etc/komui/telegram-alerts.env
```

Telegram access from the server uses Xray proxy:

```text
socks5h://127.0.0.1:10808
```

Telegram alerting was tested successfully.

## 14. Traffic switch / rollback foundation

Purpose: after stage 8 cutover, when DNS `komui.ru` points to this server, admin
can switch production runtime between:

- `server` — self-hosted frontend/backend;
- `legacy` — proxy to Vercel/Supabase legacy origin.

Files:

```text
/usr/local/sbin/komui-traffic-switch
/usr/local/sbin/komui-traffic-switch-apply
/usr/local/sbin/komui-production-issue-cert-and-enable
/etc/systemd/system/komui-traffic-switch.service
/etc/systemd/system/komui-traffic-switch.path
/var/lib/komui/traffic-switch/request.json
/var/lib/komui/traffic-switch/status.json
/etc/komui/traffic-switch.env
/etc/nginx/snippets/komui-production-runtime.conf
```

Current state:

```text
mode=server
state=prepared
productionHttpPrecutoverEnabled=true
productionTlsVhostEnabled=false
legacyOriginConfigured=true
nginxTest=passed
LEGACY_ORIGIN=https://komui.vercel.app
```

Manual commands:

```bash
sudo /usr/local/sbin/komui-traffic-switch server "reason"
sudo /usr/local/sbin/komui-traffic-switch legacy "reason"
sudo python3 -m json.tool /var/lib/komui/traffic-switch/status.json
```

TLS enable command after DNS points `komui.ru` and `www.komui.ru` to
`89.111.152.112`:

```bash
sudo /usr/local/sbin/komui-production-issue-cert-and-enable
```

The script refuses to issue a certificate if DNS does not resolve both names to
the server IP.

Important limitation:

This is not DNS switching. It only affects requests that already reach this
server. Until DNS `komui.ru` points to `89.111.152.112` and production vhost is
enabled, this does not affect live production.

If the whole server is unavailable, traffic switch is also unavailable. Then the
rollback mechanism is manual DNS rollback at the DNS provider.

## 15. Admin app integration

The separate admin project should call KOMUI backend server-side only.

Staging env:

```text
KOMUI_MIGRATION_API_BASE_URL=https://stage.komui.ru/api
KOMUI_ADMIN_API_TOKEN=<from /etc/komui/backend.env>
KOMUI_STAGE_BASIC_AUTH=<from /etc/komui/staging-access.env>
```

Staging headers:

```ts
const basic = Buffer.from(process.env.KOMUI_STAGE_BASIC_AUTH!).toString("base64");

const headers = {
  Authorization: `Basic ${basic}`,
  "X-Komui-Admin-Token": process.env.KOMUI_ADMIN_API_TOKEN!,
  "Content-Type": "application/json",
};
```

Why `X-Komui-Admin-Token` exists:

- Basic Auth also uses the `Authorization` header;
- Bearer admin token cannot share the same header with Basic Auth;
- the backend therefore accepts `X-Komui-Admin-Token` for admin routes.

Admin features already supported by backend:

- runtime status / traffic switch;
- Ozon import preview;
- Ozon import job;
- Ozon job status.

## 16. Security model

Current safety properties:

- backend listens on `127.0.0.1`, not public interface;
- PostgreSQL is local only;
- staging is behind Basic Auth;
- staging sets `noindex`;
- root-owned env files hold secrets;
- backend runs as `komui` user;
- `/etc/komui` allows `komui` directory traversal only, and only
  `ozon-sync.env` is group-readable because Ozon import loads it at runtime;
- systemd hardening is enabled;
- admin routes require server-only token;
- admin audit events are appended to `/var/lib/komui/admin-audit.log`;
- production Supabase writes are disabled unless explicitly enabled for a
  controlled Ozon dual-write job.

Do not commit:

- `/etc/komui/*.env`;
- backup keys;
- Telegram/Yandex/Ozon/T-Bank/CDEK secrets;
- PostgreSQL dump files;
- local `.ai/server-migration/runtime/`.

## 17. Deployment model

### Deployment registry

Deployments and rollbacks are tracked in an append-only JSONL registry:

```text
/var/lib/komui/deployments.jsonl
/var/lib/komui/deployment-current.json
```

Management scripts:

```text
/usr/local/sbin/komui-deployment-registry
/usr/local/sbin/komui-release-activate
```

`komui-deployment-registry` records:

- UTC timestamp;
- host;
- actor;
- component: `backend`, `frontend`, `ops`, `database`, `config`, `other`;
- event: `deploy`, `rollback`, `config`, `bootstrap`, `failure`, `note`;
- status;
- release name and path;
- previous release;
- git commit, when known;
- checks;
- active backend/frontend symlink snapshot;
- service states.

Every successful `komui-release-activate` call writes to the registry and sends
a Telegram release notification via the existing `/usr/local/sbin/komui-alert`.
Failed activation attempts are also recorded and notified; by default the script
tries to restore the previous symlink.

Release Telegram notifications are formatted in Russian and include:

- component;
- event type;
- status;
- release and previous release;
- git commit, when known;
- summary;
- checks;
- active backend/frontend releases;
- `komui-backend`, `nginx` and `postgresql` service states.

Common commands:

```bash
sudo /usr/local/sbin/komui-deployment-registry history --limit 20
sudo /usr/local/sbin/komui-deployment-registry current
sudo /usr/local/sbin/komui-deployment-registry list-releases
```

The registry is included in encrypted backups.

### Telegram deploy bot

Manual releases from GitHub are available through the same Telegram bot that is
used for alerts.

Server-side files:

```text
/usr/local/sbin/komui-deploy-bot
/usr/local/sbin/komui-deploy-from-git
/usr/local/sbin/komui-deploy-status
/etc/systemd/system/komui-deploy-bot.service
/opt/komui/deploy-source
/var/log/komui/deploy/
```

Service:

```bash
sudo systemctl status komui-deploy-bot
sudo journalctl -u komui-deploy-bot -n 100 --no-pager
```

Telegram controls:

- `Deploy stage` pulls `origin/main`, builds the project and switches staging
  backend/frontend releases;
- `Deploy prod` pulls `origin/main`, builds the project and switches production
  backend/frontend releases;
- `Status` shows current Git revision, active releases, core services and
  public smoke checks.

The bot uses a persistent Telegram reply keyboard, so the deploy controls are
shown above the text input field. Callback handling for old inline-keyboard
messages is kept for backwards compatibility.

The bot reads Telegram token, allowed chat id and proxy from:

```text
/etc/komui/telegram-alerts.env
```

Telegram access from the Russian server goes through the local Xray SOCKS proxy
configured as `TELEGRAM_PROXY_URL=socks5h://127.0.0.1:10808`.

The release flow is intentionally manual:

1. changes are committed and pushed from the Mac to `origin/main`;
2. the owner presses `Deploy stage` or `Deploy prod` in Telegram;
3. the server fetches `origin/main`, runs tests/build, creates immutable
   backend and frontend releases, switches symlinks, restarts the service and
   runs smoke checks;
4. the bot sends the final deploy result and the tail of the deploy log back to
   Telegram.

`komui-deploy-from-git` has a safety guard for the admin API migration: if the
currently active server release contains the admin storefront/order backend and
`origin/main` does not contain the corresponding source files, deploy is
blocked. This prevents an accidental release from deleting the admin backend
routes that are already active on the server.

### Backend release pattern

Backend is deployed as immutable release:

```text
/opt/komui/releases/<timestamp>-<name>/backend
```

The active release is selected by:

```text
/opt/komui/current -> /opt/komui/releases/<release>
```

After symlink switch:

```bash
sudo /usr/local/sbin/komui-release-activate backend <release> \
  --git-commit <sha> \
  --summary "Backend release summary"
```

Rollback:

```bash
sudo /usr/local/sbin/komui-release-activate backend <previous-release> \
  --event rollback \
  --summary "Rollback backend"
```

### Frontend release pattern

Frontend is deployed to:

```text
/opt/komui/frontend-releases/<timestamp>-<name>
```

The active static root is:

```text
/var/lib/komui/staging-root -> /opt/komui/frontend-releases/<release>
```

Rollback:

```bash
sudo /usr/local/sbin/komui-release-activate frontend <previous-release> \
  --event rollback \
  --summary "Rollback frontend"
```

## 18. Local development and verification

Backend:

```bash
cd /Users/kadimagomedov/Documents/KomuiMerch/server
npm test
npm run build
```

Staging smoke from server:

```bash
sudo /usr/local/sbin/komui-healthcheck
```

Catalog smoke:

```bash
sudo bash -c '. /etc/komui/staging-access.env; curl -fsS -u "$STAGING_USER:$STAGING_PASSWORD" https://stage.komui.ru/api/v1/products?limit=1'
```

Admin runtime smoke:

```bash
sudo bash -c '
  set -a
  . /etc/komui/backend.env
  . /etc/komui/staging-access.env
  set +a
  curl -fsS \
    -u "$STAGING_USER:$STAGING_PASSWORD" \
    -H "X-Komui-Admin-Token: $ADMIN_API_TOKEN" \
    https://stage.komui.ru/api/admin/runtime
'
```

Ozon preview smoke:

```bash
sudo bash -c '
  set -a
  . /etc/komui/backend.env
  . /etc/komui/staging-access.env
  set +a
  curl -fsS \
    -u "$STAGING_USER:$STAGING_PASSWORD" \
    -H "X-Komui-Admin-Token: $ADMIN_API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"limit\":1,\"targets\":{\"serverPostgres\":true,\"supabase\":false}}" \
    https://stage.komui.ru/api/admin/ozon/products/import-preview
'
```

## 19. Production cutover readiness

Production cutover is stage 8 and must not be started without explicit owner
approval.

Before/after cutover:

1. Complete remaining Ozon import/dual-write acceptance.
2. Accept current `komui_production` snapshot or explicitly clean staging test
   transactional rows before DNS cutover.
3. Run one more fresh encrypted backup immediately before cutover if cleanup or
   any data change is made; latest production snapshot backup is
   `komui-backup-20260630T164013Z.tar.gz.gpg`.
4. Run or reference the latest restore drill; last successful drill:
   2026-06-30 from `komui-backup-20260630T145422Z.tar.gz.gpg`.
5. Decide final Ozon dual-write policy.
6. Confirm production T-Bank credentials/webhook settings.
7. Production CDEK auto-create is currently enabled in candidate:
   `CDEK_CREATE_SHIPMENTS=true`.
8. DNS now points to the server and TLS vhost is enabled.
9. Switch/confirm T-Bank webhook:
   `https://komui.ru/api/v1/webhooks/tbank`.
10. Run one demo payment on `https://komui.ru` and confirm order/payment/CDEK
    behavior.

Cutover runbook:

```text
docs/server-migration/CUTOVER_RUNBOOK.md
```

## 20. Known limitations / open decisions

Current known limitations:

1. Checkout/payment/CDEK staging acceptance is completed; Ozon import/dual-write
   final acceptance is still open.
2. Ozon import writes only local server PostgreSQL by default; Supabase dual-write
   is disabled.
3. Fully new Ozon products without mapping are not auto-published.
4. T-Bank production mode/webhook is not switched; staging uses demo mode.
5. Production candidate uses T-Bank demo mode until real production credentials
   are provided/confirmed.
6. CDEK real shipment creation is enabled on staging and production candidate:
   `CDEK_CREATE_SHIPMENTS=true`.
7. External product images still use Ozon CDN.
8. Google Fonts are not fully localized.
9. `api/supabase-function.js` remains for legacy Vercel production compatibility.
10. Production HTTPS vhost for `komui.ru` is prepared but not enabled until DNS
    and certificate issuance.
11. If the self-hosted server is down after cutover, rollback requires DNS
    change at the DNS provider.

## 21. Quick orientation for a new developer

If you need to understand the project quickly:

1. Read this document.
2. Read `SERVER_MIGRATION_PLAN.md`.
3. Read `docs/server-migration/CUTOVER_RUNBOOK.md`.
4. Inspect backend routes in `server/src/app.ts`.
5. Inspect env schema in `server/src/config.ts`.
6. Inspect checkout/integration logic in `server/src/stage5.ts`.
7. Inspect Ozon import in `server/src/ozonImport.ts`.
8. Inspect traffic switch in `server/src/runtimeSwitch.ts` and
   `ops/server/komui-traffic-switch-apply.sh`.
9. Run:

```bash
cd server
npm test
npm run build
```

10. On server, run:

```bash
sudo /usr/local/sbin/komui-healthcheck
systemctl is-active postgresql nginx komui-backend komui-backup.timer komui-healthcheck.timer
```

If both local tests and server healthcheck pass, the staging system is in a
known good technical state.
