# KOMUI self-hosted server project overview

Дата актуализации: 3 сентября 2026 года.

Этот документ описывает, как устроена текущая серверная реализация KOMUI на
`89.111.152.112`, какие компоненты уже перенесены с Supabase/Vercel, где лежит
код и конфигурация, как работают backend/API, PostgreSQL, staging, backup,
email, alerting, Xray, Ozon import и production traffic fallback.

Документ предназначен для разработчика, который не участвовал в миграции и
должен быстро понять проект.

Секреты, пароли, API keys и token values в документе не указаны. Они лежат
только на сервере в root-owned env-файлах.

## 1. Текущий статус

Production cutover выполнен, а staging сохранён как отдельный тестовый контур:

- `https://komui.ru` и `https://www.komui.ru` обслуживаются self-hosted Nginx;
- traffic switch имеет `state=applied`, `mode=server`,
  `productionVhostEnabled=true`;
- production backend `komui-production-backend` работает на
  `127.0.0.1:3001` с локальной БД `komui_production`;
- production `/api/health/ready` возвращал HTTP `200` при read-only проверке
  2 сентября 2026 года;
- staging доступен на `https://stage.komui.ru`, закрыт Basic Auth/`noindex` и
  использует backend `127.0.0.1:3000` с БД `komui_staging`;
- локальный PostgreSQL не открыт наружу;
- Vercel origin сохранён только как legacy fallback, а старый Supabase proxy —
  для совместимости отдельных legacy путей, не как основной checkout runtime.

Актуальные инварианты, подтверждённые после последних rollout:

- staging и production разворачиваются из `main`; точные active Git revision и
  release paths нужно получать через `/usr/local/sbin/komui-deploy-status`;
- payment/CDEK consistency migration и backend из первых трёх пунктов P1
  работают в обеих KOMUI databases;
- PostgreSQL server/client работает на версии 17.11 внутри прежнего cluster
  `17/main`;
- Single Opt-In в checkout и футере сразу фиксирует доказуемое согласие без
  дополнительного confirmation-письма;
- production order monitor читает hardened payment/CDEK schema и отслеживает
  `INIT_UNKNOWN`, `payment_review` и durable effects в `needs_review`;
- Telegram transport использует loopback Xray 26.3.27. Конфигурацию обновляет
  fail-closed primary/secondary subscription timer;
- backup v2 сохраняет обе KOMUI DB с owners/ACL и staging/production runtime;
  внешний объект принимается только после обратного скачивания и проверки
  checksum.
- hoodie variant contract `hoodie-variants-v1` проверен в staging и production:
  физический
  SKU checkout определяется точной парой product UUID + `offerId`, а не первым
  совпавшим размером; посадка (`CRP`/`REG`) и наличие начёса (`FLC`/`NF`)
  разделены на связанные карточки; неоднозначная legacy позиция требует
  повторного выбора.

Проверенные safe-флаги production (значения секретов не читались):

```text
NODE_ENV=production
RUNTIME_MODE=server
SITE_URL=https://komui.ru
PUBLIC_API_BASE_URL=https://komui.ru/api
TBANK_MODE=production
TBANK_MOCK_PAYMENTS=false
CDEK_MOCK=false
CDEK_CREATE_SHIPMENTS=true
```

Проверенные safe-флаги staging:

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

```

Ozon dual-write в legacy Supabase остаётся выключенным; importer по умолчанию
работает с локальным server PostgreSQL.

### 1.1. Последние существенные обновления

#### 3 сентября 2026 — production rollout checkout-safe вариантов худи

- Введён единый физический variant contract для PostgreSQL, Ozon importer,
  catalog API, generated storefront, корзины и checkout.
- Один активный товар не может содержать два selectable offers одного
  нормализованного размера; активный hoodie обязан иметь группу варианта,
  посадку и признак начёса. Повтор активной физической комбинации запрещён
  уникальным индексом.
- Корзина, delivery quote, promo validation, payment fingerprint и order
  snapshots передают точный `offerId`. Backend принимает legacy-запись без него
  только при единственном совпадении; неоднозначность завершается безопасной
  ошибкой `ambiguous_offer`.
- GTA regular/cropped и Gravity fleece/no-fleece представлены отдельными
  связанными карточками. Выбор размера не предустановлен; посадка и начёс явно
  показаны покупателю.
- Миграция прошла полный forward/rollback rehearsal на одноразовой копии
  production и staging rollout с реальным `komui_app` и браузерным smoke без
  создания платежа. Затем тот же migration-first процесс выполнен в production:
  внешний API/webhook был закрыт, создан и проверен свежий offsite backup,
  migration дала 40/37 total/active rows, а новый backend прошёл read-only
  repository smoke под реальной ролью приложения.
- Canonical static fallback пересобран из migrated production API и активирован
  отдельным descendant revision. Публичный browser smoke подтвердил точный
  вариант в карточке, корзине и checkout без клика по оплате или provider call.

#### 1–2 сентября 2026 — production convergence

- Payment/CDEK consistency migration применена к staging и production; один
  совместимый backend revision развёрнут в обоих контурах.
- Hardened `komui-order-monitor` установлен глобально после production
  migration; state сохранён, timer активен.
- Newsletter signup переведён на Single Opt-In в checkout и футере. Новая
  подписка получает `subscribed` и append-only `granted` event сразу, а pending
  confirmation job не создаётся.
- PostgreSQL обновлён с 17.10 до 17.11 контролируемым minor-version restart без
  изменения cluster identity и данных.
- Backup v2 прошёл exact offsite download и изолированный restore обеих KOMUI
  databases с проверкой owners, ACL, schema, данных и app-role доступа.
- Xray обновлён до 26.3.27; primary/secondary updater, state v2, canary probes,
  atomic activation и rollback работают через 15-минутный systemd timer.

Эта сводка является текущим состоянием. Датированные разделы ниже сохраняют
историю отдельных этапов и не должны интерпретироваться как live-status.

#### 30 августа 2026 — исторический payment/CDEK staging rollout

На этом этапе по первым трём пунктам P1-аудита backend/frontend candidate был
развёрнут только на staging. Позднее тот же контракт был контролируемо перенесён
в production, как указано в актуальной сводке выше.

Основные инварианты новой реализации:

- валидный T-Bank webhook фиксирует inbox event, payment attempt, order status,
  promo transition и CDEK intent в одной PostgreSQL-транзакции;
- повторный `event_hash` идемпотентен, а более ранний provider status не может
  перезаписать более окончательный финансовый факт;
- обязательные подписанные `PaymentId`, `OrderId`, `Status` и `Amount`
  проверяются до привязки payment id и до изменения любой state machine;
- webhook не ждёт сетевой вызов CDEK и возвращает `200 OK` только после commit;
- полный refund/reversal создаёт durable `cdek_cancel`, а `CONFIRMED` —
  `cdek_create`; оба действия имеют dedupe key, lease, retry/backoff и
  `needs_review` после исчерпания попыток или не retryable отказа провайдера;
- автоматическое создание CDEK разрешено только для текущего order status
  `paid` или `partially_refunded`; статус повторно читается непосредственно
  перед provider request. `authorized` и `payment_review` fulfillment не
  запускают;
- после появления любой строки shipment повторный CDEK create `POST` запрещён:
  worker только сверяет точный UUID/merchant order number. Пустой lookup
  повторяется с backoff и в итоге переводит effect в `needs_review`, но не
  рискует создать дубликат;
- первичный CDEK status `accepted` не считается завершением: worker продолжает
  reconciliation до `created` либо `needs_review`; конкурентные create/cancel
  updates защищены compare-and-set и не могут воскресить `deleting`/`deleted`;
- новая фактическая refund/reversal-цепочка заново активирует уже terminal
  `cdek_cancel` с тем же dedupe key и очищенным lease/retry outcome;
- до T-Bank `/Init` сохраняется точная очищенная request boundary. Timeout,
  network error или ошибка сохранения ответа переводят заказ в
  `payment_unknown` и не разрешают создавать новый заказ с тем же
  `clientRequestId`;
- reconciler использует подписанные `CheckOrder` и `GetState`. Поскольку эти
  методы не возвращают opaque `PaymentURL`, найденный orphan в status `NEW`
  сначала идемпотентно отменяется через `Cancel`; только подтверждённый
  terminal failure разрешает пользователю создать новый заказ;
- непосредственно перед HTTP `Cancel` короткая транзакция повторно проверяет
  lease generation, order/amount/terminal boundary и глобального владельца
  PaymentId, затем привязывает PaymentId, очищает `payment_url` и сохраняет
  durable cancel-intent. Потерянный CAS запрещает сетевой вызов; crash после
  intent или отправки `Cancel` не позволяет позднему fulfillable-статусу
  создать доставку — заказ переходит в `payment_review`, а `cdek_cancel`
  сохраняется причинно;
- mismatch `TerminalKey`, `OrderId`, `PaymentId` или amount не принимается как
  локальная истина и переводится в безопасное ожидание/operator review.
- `AUTH_FAIL` не считается terminal failure: по контракту Т-Банка платёжная
  форма допускает следующие попытки до `REJECTED`, поэтому существующий
  PaymentId/URL переиспользуется либо сверяется, а новый платёж не создаётся;
- `PARTIAL_REVERSED`, а также direct `PARTIAL_REFUNDED` без ранее
  подтверждённого локального `paid`, блокируют fulfillment и требуют более
  финального непротиворечивого факта либо ручной проверки; lower-rank
  `CONFIRMED` не выводит такой заказ из review. Обычный переход
  `paid -> partially_refunded` остаётся отдельным бизнес-сценарием и сам по себе
  не означает автоматическую отмену уже созданной доставки.

Новые основные файлы:

```text
server/src/tbankWebhook.ts
server/src/tbankReconciliation.ts
server/src/tbankPaymentIdentity.ts
server/src/cdekEffects.ts
server/src/cdekShipments.ts
server/test/tbankWebhook.test.ts
server/test/tbankReconciliation.test.ts
server/test/cdekEffects.test.ts
supabase/migrations/20260830143000_harden_payment_consistency.sql
```

Migration добавляет:

- order status `payment_unknown`;
- `reconciliation_attempts` и `reconciliation_next_at` для payment attempts;
- CDEK shipment status `deleting`;
- `merch_order_effects` с RLS, уникальным `dedupe_key`, due/order indexes,
  lease/retry полями и безопасным historical cancel backfill.

RLS/grants в migration условны по наличию ролей: в managed Supabase разрешён
`service_role`, а в self-hosted PostgreSQL — backend role `komui_app` с
`SELECT`/`INSERT`/`UPDATE` и доступом к identity sequence. Отсутствующие
`anon`/`authenticated`/`service_role` не делают migration неисполняемой.

Admin order detail на staging показывает безопасную сводку `orderEffects` без
внутреннего payload. Candidate `komui-order-monitor` умеет формировать отдельный
Telegram alert при переходе эффекта в `needs_review`, но глобальный production
timer пока использует legacy binary; новая версия устанавливается только после
production migration.

Новые необязательные env-настройки имеют безопасные defaults:

```text
TBANK_REQUEST_TIMEOUT_MS=15000
TBANK_RECONCILIATION_ENABLED=true
TBANK_RECONCILIATION_INTERVAL_MS=30000
TBANK_RECONCILIATION_BATCH_SIZE=5
TBANK_RECONCILIATION_STALE_MS=30000
TBANK_RECONCILIATION_LEASE_MS=60000
TBANK_RECONCILIATION_MAX_ATTEMPTS=20
```

Проверенный порядок выкладки сначала в staging, затем тем же revision в
production:

1. Подготовить immutable release без активации и проверить его на временной
   полной копии целевой БД.
2. Закрыть payment/webhook ingress, остановить старый backend, повторить семь
   SQL counters и снять согласованный post-drain backup.
3. Применить migration `20260830143000_harden_payment_consistency.sql` к
   целевой БД одной транзакцией.
   Проверить, что у `komui_app` созданы grants и разрешающая RLS policy.
4. До старта workers сверить historical CDEK backfill и T-Bank reconciliation
   candidates; любые реальные provider effects должны быть явно согласованы
   либо помещены в operator review.
5. Развернуть backend без auto-rollback старой версии, затем frontend одного
   revision.
6. Проверить `/health/ready`, backend logs и отсутствие растущих
   `INIT_REVIEW`/`needs_review`.
7. Выполнить demo-платёж, duplicate webhook replay и refund/CDEK cancel smoke.
   Для CDEK отдельно подтвердить, что `accepted` продолжает сверяться, а
   повторная обработка неоднозначного create не отправляет второй `POST`.

Обновлённый `ops/server/komui-order-monitor` нельзя глобально устанавливать на
staging-шаге: systemd unit читает `komui_production`, где migration ещё нет.
Во время staging rollout candidate был однократно запущен из подготовленного
source tree с `--database komui_staging --bootstrap --dry-run` и временными
state/lock paths; постоянного нового staging monitor пока нет.

После начала migration старый backend нельзя возвращать к приёму payment writes:
он не соблюдает новые transaction/outbox-инварианты, даже если schema additions
технически ему не мешают. Выкладка выполняется только в maintenance window с
остановкой старого backend и блокировкой checkout/webhook ingress. При ошибке
maintenance сохраняется; допустимы forward-fix/data reconciliation либо
восстановление согласованного backup до повторного открытия ingress. Точный
порядок и blocking preflight приведены в `CUTOVER_RUNBOOK.md`.

Фактический staging rollout:

```text
branch: codex/payment-consistency-hardening
commit: ac2567bb42aefcc0f75d9bb31fa915fd373954f6
backend/frontend release: 20260830T175312Z-stage-ac2567bb42ae
post-drain backup: komui-backup-20260830T180555Z.tar.gz.gpg
```

Результат:

- server-side tests 228/228 и TypeScript build прошли;
- migration rehearsal на временной полной БД прошёл, временная БД удалена;
- семь counters перед migration: `0|0|0|0|0|0|0`;
- schema, validated constraints, RLS/grants и indexes подтверждены;
- две historical CDEK cancellation строки безопасно переведены в
  `needs_review` до старта worker; provider calls не выполнялись;
- non-terminal effects, T-Bank reconciliation candidates, `INIT_REVIEW` и
  `payment_review`: 0;
- root/checkout/payment-result/products/readiness: HTTP 200, Basic Auth и
  `noindex` сохранены;
- global healthcheck: `SUMMARY OK`, failed units: 0;
- production остаётся на release `20260827T150442Z-prod-5a36b6c11d66` и не
  содержит новую schema.
- exact post-drain archive restore drill обоих DB dumps завершён 1 сентября:
  schema/counts, `komui_app` read path, isolated legacy-backend smokes и cleanup
  подтверждены; active staging/production runtime не изменился.

Полный payment/refund/real-CDEK E2E оставлен отдельным явно разрешаемым шагом,
потому что staging использует `CDEK_MOCK=false`.

После independent review штатный `komui-deploy-from-git` дополнен fail-closed
source/schema compatibility gate до build и activation. Он блокирует
`origin/main` с legacy payment code на migrated staging DB и блокирует новый
payment-consistency code на legacy production DB. Режим
`--check-compatibility-only` проверяет branch/DB без restart или переключения
symlink. Gate не выполняет migration и не заменяет controlled maintenance
rollout.

На сервер установлен guard commit `b2c7337`; exact file hash совпал с Git.
Четыре check-only probe подтвердили обе разрешённые и обе запрещённые
комбинации. Staging/production symlinks, PID, release counts и DB row counters
до/после совпали. Registry содержит successful ops event
`deploy-guard-b2c7337`; notification намеренно отключена из-за предыдущих
transport timeout.

Post-drain backup имеет размер `52 584 372 bytes`; checksum, external upload и
restore drill обоих DB dumps проверены. Evidence log:
`/var/backups/komui/logs/restore-drill-20260830T180555Z-20260901t082839z.log`.
Drill доказал data/schema + legacy-runtime recovery exact rollback snapshot, но
не полный production DR: archive не сохраняет owners/ACL, а runtime-config
staging-centric. Provider E2E и решение по двум quarantined
`cdek_cancel/needs_review` остаются отдельными gates.

#### 7 июля 2026 — product media migration foundation

Начата реализация пункта GEO/SEO roadmap по переносу товарных фото с Ozon CDN
на `komui.ru`.

Целевое состояние:

- PostgreSQL может продолжать хранить исходные `https://ir.ozone.ru/...` как
  source-of-truth;
- публичный HTML, `data/storefront-products.js`, Product JSON-LD, `og:image`,
  `twitter:image` и `/api/v1/products` должны отдавать только
  `https://komui.ru/media/products/...` или относительные
  `/media/products/...`;
- товарные фото физически лежат вне git на сервере:

```text
/var/lib/komui/media-cache/
  manifest.json
  manifest.previous.json
  public/products/<hash-prefix>/<hash>/
    original.jpg
    480.webp
    800.webp
    1200.webp
    thumb.webp
```

Добавлены файлы:

- `package.json` в корне проекта — root build dependencies для scripts;
- `pnpm-lock.yaml`, `pnpm-workspace.yaml`;
- `scripts/sync-product-media.js` — сбор Ozon image URL из каталога, скачивание
  оригиналов, генерация WebP variants, manifest и reports;
- `docs/SEO_MEDIA_MIGRATION_PLAN.md` — детальный план реализации;
- `server/src/mediaManifest.ts` — backend mapping Ozon URL -> public media URL.

Изменён `scripts/build-products.js`:

- читает manifest из `KOMUI_MEDIA_MANIFEST_PATH` или
  `/var/lib/komui/media-cache/manifest.json`;
- в локальной разработке автоматически использует
  `.komui/media-cache/manifest.json`, если он существует;
- поддерживает `KOMUI_MEDIA_STRICT=1`;
- заменяет Ozon URLs на `/media/products/...`;
- генерирует `srcset`, `sizes`, `width`, `height`;
- ставит `fetchpriority="high"` на первую hero image product page;
- использует `thumb.webp` для product gallery thumbnails;
- удаляет `preconnect` к `https://ir.ozone.ru`;
- пишет `og:image`, `twitter:image` и Product JSON-LD image с
  `https://komui.ru/media/products/...`;
- генерирует `data/storefront-products.js` уже с локальными media URLs, чтобы
  главная после загрузки JS не возвращала картинки Ozon CDN.

Изменён backend:

- `sanitizeProduct()` в `server/src/catalog.ts` применяет media manifest mapping
  к `primary_image_url`, `main_image_path`, `image_urls`,
  `offers[].primary_image`, `offers[].images`;
- `/health/ready` отдаёт `media` block со статусом manifest:
  `path`, `loaded`, `sourceImages`, `publicImages`, `strict`;
- если manifest отсутствует и strict mode не включён, API работает как раньше;
- если `KOMUI_MEDIA_STRICT=1` и встречен неизвестный Ozon URL, API/build падает,
  чтобы не публиковать Ozon CDN.

Важно: постоянный backend env не должен включать `KOMUI_MEDIA_STRICT=1` без
отдельного решения. Иначе новый Ozon URL, который ещё не попал в manifest,
может сломать публичный catalog API до media sync. Strict mode используется в
deploy build/sync проверках.

Изменён deploy pipeline `ops/server/komui-deploy-from-git`:

- ставит root build dependencies;
- запускает `scripts/sync-product-media.js --strict` перед static build;
- собирает static frontend с
  `KOMUI_MEDIA_MANIFEST_PATH=/var/lib/komui/media-cache/manifest.json` и
  `KOMUI_MEDIA_STRICT=1`;
- проверяет публичные static artifacts на отсутствие `ir.ozone.ru`;
- после активации backend/frontend проверяет public catalog API на отсутствие
  `ir.ozone.ru`;
- пишет media cache metadata в deployment registry.

Изменён production runtime nginx snippet generator
`ops/server/komui-traffic-switch-apply.sh`:

```nginx
location ^~ /media/products/ {
    alias /var/lib/komui/media-cache/public/products/;
    access_log off;
    expires 30d;
    add_header Cache-Control "public, max-age=2592000, immutable";
    add_header X-Content-Type-Options "nosniff" always;
}
```

Локальная проверка на 7 июля 2026:

```text
products: 34
unique Ozon image URLs: 143
manifest images: 143
media-cache size: 63M
failed downloads: 0
```

Проверено:

- `KOMUI_MEDIA_STRICT=1 node scripts/build-products.js` — OK;
- public static artifacts `index.html`, `p/`, `collections/`, `data/`,
  `sitemap.xml`, `llms-full.txt` не содержат `ir.ozone.ru`;
- backend tests — 48/48 passed;
- backend TypeScript build — OK;
- shell syntax для deploy scripts — OK.

Оставшиеся связанные работы:

- убедиться, что staging nginx тоже отдаёт `/media/products/` через alias на
  `/var/lib/komui/media-cache/public/products/`;
- задеплоить изменения через stage/prod pipeline;
- после deploy проверить:

```bash
curl -fsS https://komui.ru/api/v1/products?limit=100 | grep ir.ozone.ru
curl -I https://komui.ru/media/products/<hash-prefix>/<hash>/800.webp
```

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

Этот раздел фиксирует поведение релиза от 30 июня и не является текущим
контрактом. Начиная с hardening 30 августа `AUTH_FAIL` считается
неокончательным, автоматический fresh payment запрещён, а ambiguous result
обрабатывается через тот же `clientRequestId` и reconciliation.

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

На момент snapshot 30 июня `komui_production` была создана из staging и
содержала тестовые transactional rows. Это историческая характеристика
snapshot, а не описание текущего cutover status; любой cleanup требует
отдельного явного разрешения и свежего backup.

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

На завершении этого датированного этапа ещё требовались подтверждение T-Bank
webhook, тестовый платёж и наблюдение. Это historical note; последующие rollout
и текущий статус описаны в начале документа.

## 2. Высокоуровневая архитектура

```text
Покупатель                         Тестировщик
    |                                  |
    v                                  v
https://komui.ru                 https://stage.komui.ru
    |                                  |
    +------------ Nginx ---------------+
                 |              |
                 v              v
        production static    staging static
        + backend :3001      + backend :3000
                 |              |
                 +------ PostgreSQL 17.11
                        komui_production
                        komui_staging

Дополнительно:

- staging/production email workers -> PostgreSQL outbox -> Unisender Go
- komui-order-monitor.timer -> komui_production -> Telegram alert
- Telegram callers -> komui-alert -> Xray SOCKS 127.0.0.1:10808
- komui-xray-subscription-update.timer -> primary/secondary canary + activation
- komui-backup.timer -> encrypted local backup -> verified Yandex Object Storage
- komui-healthcheck.timer -> local/public checks -> Telegram alert on failure
- komui-traffic-switch.path -> controlled production server/legacy runtime mode
```

## 3. Сервер и системные ресурсы

Сервер:

Исторический ресурсный снимок после rollout 30 августа 2026 года:

```text
IP: 89.111.152.112
Hostname: cv6065797.novalocal
OS: Ubuntu 24.04.4 LTS
Virtualization: KVM / OpenStack Nova
Architecture: x86-64
Disk: 20G, 14G used / 5.6G available (71%)
RAM: 3.8Gi total, около 2.4Gi available
Swap: 2.0Gi total, около 102Mi used
```

Основные сервисы:

```text
postgresql                 active
nginx                      active
komui-backend              active
komui-production-backend   active
komui-email-worker         active
komui-production-email-worker active
komui-backup.timer         active
komui-healthcheck.timer    active
komui-order-monitor.timer  active
komui-deploy-bot           active
komui-traffic-switch.path  active
xray                       active
komui-xray-subscription-update.timer active
```

## 4. Основные серверные пути

### Backend releases

```text
/opt/komui/releases/
/opt/komui/current -> /opt/komui/releases/<active-release>
/opt/komui/current/backend
```

Точные active targets меняются при каждом deploy. Проверять их нужно командой:

```bash
sudo /usr/local/sbin/komui-deploy-status
```

Backend запускается из разных active symlink:

```text
staging:    /opt/komui/current/backend/dist/server.js
production: /opt/komui/production-current/backend/dist/server.js
```

### Frontend releases

```text
/opt/komui/frontend-releases/
/var/lib/komui/staging-root -> /opt/komui/frontend-releases/<active-release>
/opt/komui/production-frontend-releases/
/var/lib/komui/production-root -> /opt/komui/production-frontend-releases/<active-release>
```

`/var/lib/komui/staging-root` — static root для Nginx staging.
`/var/lib/komui/production-root` — static root для production.

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
/etc/komui-xray/subscription.url
/etc/komui-xray/subscription-secondary.url
/etc/komui-xray/subscription.hwid
```

Эти файлы не должны попадать в Git.

Important runtime permissions:

```text
/etc/komui                  root:komui 0710
/etc/komui/backend.env      root:root 0600
/etc/komui/backend-production.env root:root 0600
/etc/komui/ozon-sync.env    root:komui 0640
/etc/komui/traffic-switch.env root:komui 0640
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
/etc/nginx/sites-enabled/komui-production-switch
/etc/nginx/sites-available/komui-production-http-precutover
/etc/nginx/snippets/komui-production-runtime.conf

/etc/nginx/sites-available/api.komui.ru
/etc/nginx/sites-enabled/api.komui.ru
```

Файл `komui-production-http-precutover` сохранён как исторический артефакт и не
включён в `sites-enabled`. Активный `komui-production-switch`
обслуживает HTTP/ACME и HTTPS, сертификат установлен, а live `komui.ru`
работает через этот vhost. Проверенное состояние traffic
switch — `mode=server`, `state=applied`; точные пути и ограничения описаны ниже
в разделе **Active production switch vhost**.

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

### Legacy-compatible `api.komui.ru`

`api.komui.ru` сохранён как legacy proxy к Supabase origin:

```text
https://bkxpzfnglihxpbnhtjjq.supabase.co
```

Этот vhost не является зависимостью текущей self-hosted витрины. Его изменение
не входит в обычный backend deploy; перед ремонтом или удалением нужно отдельно
проверить legacy consumers и фактическую доступность upstream.

### Active production switch vhost

Production HTTPS vhost is enabled:

```text
/etc/nginx/sites-available/komui-production-switch
/etc/nginx/sites-enabled/komui-production-switch
```

It serves:

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

Read-only verification on 30 August 2026:

```text
productionVhostEnabled=true
mode=server
state=applied
```

Therefore switching to `legacy` or changing this vhost affects live
`komui.ru`; use the cutover/rollback runbook and explicit owner approval.

## 7. Backend service

Staging systemd unit:

```text
/etc/systemd/system/komui-backend.service
bind: 127.0.0.1:3000
env: /etc/komui/backend.env
database: komui_staging
```

Production systemd unit:

```text
/etc/systemd/system/komui-production-backend.service
bind: 127.0.0.1:3001
env: /etc/komui/backend-production.env
database: komui_production
```

Оба unit работают как `User=komui`, `Group=komui`, но используют разные paths:

```text
staging:
  WorkingDirectory=/opt/komui/current/backend
  EnvironmentFile=/etc/komui/backend.env
  ExecStart=/usr/bin/node /opt/komui/current/backend/dist/server.js

production:
  WorkingDirectory=/opt/komui/production-current/backend
  EnvironmentFile=/etc/komui/backend-production.env
  ExecStart=/usr/bin/node /opt/komui/production-current/backend/dist/server.js
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
staging: MemoryHigh=900M, MemoryMax=1200M
production: MemoryHigh=700M, MemoryMax=1000M
```

Logs:

```text
/var/log/komui/backend.log
/var/log/komui/backend-error.log
/var/log/komui/backend-production.log
/var/log/komui/backend-production-error.log
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
server/src/checkout.ts       exact product/offer/size resolution and order persistence
server/src/reviews.ts        public product reviews API
server/src/importOzonReviews.ts  idempotent Ozon Seller CSV/media importer
server/src/stage5.ts         CDEK, promo, T-Bank handlers, compatibility route
server/src/cdek.ts           CDEK client and package calculations
server/src/cdekEffects.ts    durable CDEK effect queue/worker/reconciliation
server/src/cdekShipments.ts  CDEK shipment DB workflow and admin retry endpoint
server/src/tbankWebhook.ts   transactional webhook state machine
server/src/tbankReconciliation.ts ambiguous Init reconciliation worker
server/src/tbankPaymentIdentity.ts provider/local payment identity checks
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

Полный server test suite и TypeScript build должны проходить до создания
immutable release. Точный test count не фиксируется здесь, потому что он меняется
вместе с кодом.

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
GET /v1/products/:slug/reviews?limit=20&cursor=...
GET /v1/products/:slug/reviews?limit=20&mediaOnly=1
GET /v1/catalog/stats
```

Uses `public.merch_storefront_products`.

Only public storefront fields are returned. Raw/internal fields such as
`source_payload`, `ozon_attributes`, internal costs and warehouse data are not
returned to the browser.

For hoodie variants the sanitized response includes `storefront_variant` and
`requires_offer_id_sizes`. Raw variant columns and the transitional source
payload remain server-side. A selectable size must resolve to one exact offer;
archived or explicitly hidden offers are excluded.

The reviews route returns only approved, published, matched reviews and locally
served media. Source URLs, raw Ozon order references and internal mapping data
are never exposed. See `docs/server-migration/OZON_REVIEWS_IMPORT.md` for the
import, validation and future refresh workflow.

Catalog product responses include a sanitized `review_summary` object used by
catalog, collection and recommendation cards. Full reviews are loaded only on
the canonical product page; `mediaOnly=1` filters the paginated list without
changing the overall rating summary.

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

- only works for `paid`/`partially_refunded` orders; `authorized` and
  `payment_review` are not fulfillable;
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

Контуры используют разные T-Bank modes:

```text
staging:    TBANK_MODE=demo,       TBANK_MOCK_PAYMENTS=false
production: TBANK_MODE=production, TBANK_MOCK_PAYMENTS=false
```

Meaning:

- staging обращается к реальному demo API;
- production использует production terminal mode;
- provider-mutating smoke в любом контуре запускается только как отдельная
  контролируемая операция.

T-Bank token/signature logic is implemented in `server/src/crypto.ts`.

### Email subscription и Unisender webhook

```text
POST /v1/email/subscribe
POST /v1/email/confirm
GET  /v1/webhooks/unisender-go
POST /v1/webhooks/unisender-go
```

`/v1/email/subscribe` требует отдельные privacy и marketing consents. Single
Opt-In атомарно устанавливает `subscribed` и записывает append-only `granted`
event без confirmation email. `/v1/email/confirm` сохранён только для старых
Double Opt-In links. Unsubscribe, hard bounce и complaint создают suppression и
останавливают ожидающие marketing jobs. Отдельные staging/production workers
обрабатывают PostgreSQL outbox; HTTP/payment flow не ждёт Unisender.

Подробности:
[`../email-marketing/UNISENDER_GO_INTEGRATION_PLAN.md`](../email-marketing/UNISENDER_GO_INTEGRATION_PLAN.md).

### T-Bank Russian Trusted CA

T-Bank can serve payment API endpoints with a Russian Trusted CA certificate
chain. Ubuntu and Node.js do not always trust this chain by default, so the
self-hosted server installs the Gosuslugi Russian Trusted CA certificates into
the OS trust store and exposes the resulting bundle to Node.js.

Installed files:

```text
/usr/local/share/ca-certificates/komui-russian-trusted/
/etc/komui/certs/komui-node-ca-bundle.pem
```

Backend env files contain:

```text
NODE_EXTRA_CA_CERTS=/etc/komui/certs/komui-node-ca-bundle.pem
```

Helper:

```bash
sudo /usr/local/sbin/komui-install-russian-trusted-ca /path/to/unpacked/certs
```

Verification:

```bash
curl -fsSI https://mddc.tbank.ru/
sudo -u komui env NODE_EXTRA_CA_CERTS=/etc/komui/certs/komui-node-ca-bundle.pem \
  node -e "fetch('https://mddc.tbank.ru/').then(r=>console.log(r.status))"
sudo /usr/local/sbin/komui-healthcheck
```

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
productionVhostEnabled=true
mode=server
state=applied
```

The production vhost is live, so switching modes affects `komui.ru` after the
asynchronous apply completes. Treat this endpoint as a production mutation.

### Admin Ozon import

```text
POST /admin/ozon/products/import-preview
POST /admin/ozon/products/import
POST /admin/ozon/products/link-storefront-offers
POST /admin/ozon/products/storefront-products
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
6. `import` applies selected matched updates to local server PostgreSQL.
7. Unmatched Ozon offers can be manually linked to an existing storefront
   product through `link-storefront-offers`.
8. New Ozon designs/products can be reviewed by the admin UI and created as
   storefront cards through `storefront-products`.
9. Job status/result is saved in `public.merch_admin_jobs`.

Safety behavior:

- matched existing storefront products can be updated selectively by
  `itemIds` or `offerIds`;
- prices on the site are not changed unless `updatePrices=true` is explicitly
  sent; Ozon prices are stored separately in technical offer fields;
- new Ozon sizes are added when `syncSizes="add"`, but existing storefront
  sizes are not removed automatically;
- unmatched/new Ozon products are grouped as candidates and are not
  auto-published as storefront cards;
- Supabase writes are skipped while `OZON_IMPORT_WRITE_SUPABASE=false`;
- every import job supports idempotency key.

Integration guide for the separate admin UI:

```text
docs/admin-ozon-import-api.md
```

Current smoke result:

```text
Ozon preview with limit=1: HTTP 200
matchedStorefront=1
actionableServerPostgres=1
actionableSupabase=0
```

## 10. PostgreSQL

PostgreSQL server/client: 17.11, cluster `17/main`. Application databases:

```text
komui_staging
komui_production
```

PostgreSQL is local only. Staging and production applications connect through
separate `DATABASE_URL` values in `/etc/komui/backend.env` and
`/etc/komui/backend-production.env`.

Important tables:

```text
public.merch_storefront_products       public catalog source
public.merch_products                  internal products/SKU source
public.merch_customer_orders           checkout orders
public.merch_customer_order_items      checkout items
public.merch_payment_attempts          payment init/status
public.merch_payment_events            payment webhooks/events
public.merch_order_effects             durable CDEK create/cancel outbox
public.merch_promo_codes               promo config
public.merch_promo_redemptions         promo usage
public.merch_cdek_shipments            CDEK shipment records
public.merch_cdek_events               CDEK events
public.merch_email_contacts            normalized email contacts
public.merch_email_consent_events      append-only consent history
public.merch_email_outbox              transactional email queue
public.merch_email_suppressions        unsubscribe/bounce/complaint blocks
public.merch_admin_import_previews     Ozon import previews
public.merch_admin_jobs                Ozon import jobs
public.merch_review_sync_runs           review import audit runs
public.merch_storefront_reviews         normalized product reviews
public.merch_storefront_review_media    local review images/videos
```

Row counts are operational data and are intentionally not recorded as current
constants. Query the required tables read-only immediately before a migration,
restore comparison or incident decision.

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

Static frontends are deployed to immutable release directories:

```text
/opt/komui/frontend-releases/<stage-release>
/opt/komui/production-frontend-releases/<production-release>
```

and exposed through active symlinks:

```text
/var/lib/komui/staging-root
/var/lib/komui/production-root
```

The current frontend no longer contains runtime Supabase URL/key in deployed
HTML/JS/CSS under either active root.

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

It proxies to Supabase Edge Functions and is part of the old Vercel
compatibility path. It is not part of the self-hosted storefront runtime. Do not
delete or change it until legacy consumers and fallback are explicitly
decommissioned.

## 12. Backup

Backup v2 установлен как:

```text
/usr/local/sbin/komui-backup
/etc/systemd/system/komui-backup.service
/etc/systemd/system/komui-backup.timer
/var/backups/komui
```

Формат v2 включает:

- PostgreSQL custom dumps `--create` для `komui_staging` и
  `komui_production` с native owners, ACL и default ACL;
- recoverable PostgreSQL globals и checksummed per-DB/cluster security
  inventories в явно ограниченном KOMUI scope;
- staging и production Nginx, TLS, systemd, active backend/frontend releases,
  `/var/lib/komui`, PostgreSQL host config и control-plane tools;
- Xray runtime, updater units/state и root-only subscription credential files;
- local review media, private source archives, UID/GID mapping, manifest и
  checksums.

Текущий encryption key `/etc/komui/backup.key` намеренно исключается из каждого
archive. Скрипт требует заранее созданный root-only key и не генерирует его
автоматически.

Публикация fail-closed: encrypted archive загружается в Yandex Object Storage,
затем скачивается обратно и сверяется по exact SHA-256. Локальный final `.gpg`
появляется только после успешной offsite-проверки. Backup lock также очищает
точно определённые stale plaintext/partial artifacts.

External storage:

```text
Yandex Object Storage
bucket: komui-backups
prefix: komui/stage/
endpoint: https://storage.yandexcloud.net
credentials: /etc/komui/yandex-backup.env
```

Принятый backup v2 был скачан из Object Storage и полностью восстановлен в
изолированный PostgreSQL 1 сентября 2026 года:

```text
archive: /var/backups/komui/daily/komui-backup-20260901T122859Z.tar.gz.gpg
exact offsite download/hash/decrypt/internal checksums: PASS
both DB restore + owners/ACL/security/catalog/data/app-role checks: PASS
live runtime and cleanup invariants: PASS
evidence: /var/backups/komui/logs/restore-v2-drill-20260901T122859Z-20260901T123323Z-904805.log
```

Этот drill восстанавливает заявленный KOMUI scope; другие databases общего
PostgreSQL cluster, включая GetoMerch, в контракт не входят. Единственный
существенный внешний DR gap — отдельное от сервера хранение и проверка
доступности `/etc/komui/backup.key`.

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
- staging и production backend active/readiness;
- включённые staging/production email workers и состояние email queues;
- backup и order-monitor timers;
- stage root HTTPS;
- stage catalog API HTTPS;
- production Yandex Direct feed и соответствие количества offers активному
  каталогу production backend;
- disk under threshold;
- memory available;
- backup freshness;
- no relevant failed service units; текущий healthcheck исключает собственный
  oneshot и оставшиеся после диагностики transient `run-u*.service`;
- no stale pending payments в настроенной healthcheck DB (по умолчанию
  `komui_staging`).

Результат последней live-проверки 2 сентября 2026:

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

Telegram transport проверен через Xray вместе с bot API и order-monitor
delivery. Production использует Xray 26.3.27 с loopback-only inbounds.
`komui-xray-subscription-update.timer` каждые 15 минут проверяет активный proxy и
при необходимости выбирает проверенный profile из primary/secondary providers.
Каждая активация требует isolated Cloudflare/Telegram canaries и production
probe; при ошибке восстанавливаются точные прежние config/state.

Подробный runbook:
[`XRAY_SUBSCRIPTION_UPDATER.md`](XRAY_SUBSCRIPTION_UPDATER.md).

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
state=applied
productionVhostEnabled=true
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

Certificate/vhost enable helper used during the completed cutover:

```bash
sudo /usr/local/sbin/komui-production-issue-cert-and-enable
```

The script refuses to issue a certificate if DNS does not resolve both names to
the server IP.

Important limitation:

This is not DNS switching. DNS already points `komui.ru` to this server and the
production vhost is enabled, therefore traffic-switch changes do affect live
requests that reach the server.

If the whole server is unavailable, traffic switch is also unavailable. Then the
rollback mechanism is manual DNS rollback at the DNS provider.

## 15. Admin app integration

The separate admin project should call KOMUI backend server-side only.

Production env for the external admin:

```text
KOMUI_MIGRATION_API_BASE_URL=https://komui.ru/api
KOMUI_ADMIN_API_TOKEN=<from /etc/komui/backend-production.env>
```

Production headers:

```ts
const headers = {
  "X-Komui-Admin-Token": process.env.KOMUI_ADMIN_API_TOKEN!,
  "Content-Type": "application/json",
};
```

Target switching note:

The external admin can switch between production and stage in its UI. The
selected target is stored in the admin browser cookie `komui_api_target`.

- `prod` calls `https://komui.ru/api` and writes to production backend
  `127.0.0.1:3001`.
- `stage` calls `https://stage.komui.ru/api` and writes to staging backend
  `127.0.0.1:3000`.

Do not route `stage.komui.ru/api/admin/*` to production. That old temporary
compatibility route was removed after the admin gained explicit target
switching.

If the admin intentionally targets stage for testing, use a separate admin
deployment/env and keep the stage Basic Auth headers:

```text
KOMUI_MIGRATION_API_BASE_URL=https://stage.komui.ru/api
KOMUI_ADMIN_API_TOKEN=<from /etc/komui/backend.env>
KOMUI_STAGE_BASIC_AUTH=<from /etc/komui/staging-access.env>
```

Stage headers:

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
- storefront product list, detail and update;
- order list, detail, fulfillment update and mark-shipped action;
- manual CDEK shipment creation/retry;
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
- `/etc/komui` allows `komui` directory traversal; `ozon-sync.env` and
  `traffic-switch.env` are intentionally group-readable by `komui`, while the
  active backend env files remain `0600 root:root`;
- systemd hardening is enabled;
- admin routes require server-only token;
- admin audit events are appended to `/var/lib/komui/admin-audit.log`;
- production Supabase writes are disabled unless explicitly enabled for a
  controlled Ozon dual-write job.

Security hygiene follow-up: two historical `backend.env.bak-*` files observed
2 September 2026 still had `root:komui 0640`; verify their recovery value and
remove them or restrict them to `0600 root:root` in a separately controlled
server operation.

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

Every `komui-release-activate` call best-effort records its result in the
registry and, by default, asks the registry to send a Telegram release
notification through `/usr/local/sbin/komui-alert`; `--no-notify` suppresses
only the notification. A registry/notification failure does not undo an
otherwise successful activation. Failed activation attempts use the same
best-effort reporting path; by default the script first tries to restore the
previous symlink.

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

Telegram controls open from one persistent `⚙️ Управление` button. It shows a
compact inline root menu with two sections:

- `🏪 Магазин`: status, stage deploy and confirmed production deploy;
- `🛠 Админка`: status, confirmed production deploy and confirmed rollback.

Back buttons edit the same menu message instead of adding a new message for each
navigation step. Direct Telegram commands and callback handling for old buttons
remain available for backwards compatibility.

`📋 Статус админки` does not forward raw shell output. It returns a Russian
operator summary with one overall verdict and named checks for public/login/auth
availability, GetoMerch web and worker services, PostgreSQL, nginx, the hourly
database-backup timer, failed systemd units, the latest off-site backup, Git and
release state, and root-disk usage. The raw diagnostic output remains available
through `/usr/local/sbin/getomerch-deploy-status` over SSH.

The persistent Telegram reply keyboard contains only the single menu button, so
it does not occupy multiple rows above the text input field.

Telegram commands (`/menu`, `/status`, `/deploy_stage`, `/deploy_prod`,
`/admin_status`, `/admin_deploy`, `/admin_rollback`) are registered through the
Bot API on startup. The Telegram token and proxy URL are passed to curl through
stdin config rather than process arguments, so they are not exposed in `ps`.

The bot reads Telegram token, allowed chat id and proxy from:

```text
/etc/komui/telegram-alerts.env
```

Telegram access from the Russian server goes through the local Xray SOCKS proxy
configured as `TELEGRAM_PROXY_URL=socks5h://127.0.0.1:10808`.

The release flow is intentionally manual:

1. changes are committed and pushed from the Mac to `origin/main`;
2. the owner presses the stage or prod release button in Telegram;
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

It also enforces the payment-consistency source/schema contract before any
build or activation:

- legacy source is accepted only against a fully legacy target schema;
- the payment-consistency source set is accepted only when the target DB has
  the complete table/columns/indexes/constraints/RLS/grants/policy/trigger
  signature;
- partial schema/source and either mismatch direction fail closed;
- `--check-compatibility-only` performs this check without building,
  restarting a service or changing a release symlink.

Обе KOMUI databases уже имеют payment-consistency schema, а совместимый код
находится в `main`. Guard остаётся обязательным: legacy, partial либо
несовместимая source/schema комбинация блокируется до build/activation. Guard
не применяет migrations и не заменяет maintenance/drain procedure из
`CUTOVER_RUNBOOK.md` для будущих schema changes.

`hoodie-variants-v1` adds another fail-closed source/schema signature. Its
production rollout is migration-first: keep `/api` ingress closed, apply and
verify the migration, activate the variant-aware backend once, regenerate the
canonical static fallback from the migrated production API, commit that exact
generated delta, then activate the final descendant revision. Reopen ingress
only after database, backend, static, healthcheck and browser postflights agree.
The generic deploy script does not apply this migration.

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

### Release retention

Old immutable releases are pruned by:

```bash
sudo /usr/local/sbin/komui-prune-releases --keep 5
```

The script preserves:

- currently active stage backend release;
- currently active prod backend release;
- currently active stage frontend release;
- currently active prod frontend release;
- newest 5 releases in every release directory.

Release directories:

```text
/opt/komui/releases/
/opt/komui/frontend-releases/
/opt/komui/production-frontend-releases/
```

Scheduled cleanup:

```bash
systemctl list-timers komui-prune-releases.timer
sudo journalctl -u komui-prune-releases.service
sudo tail -n 100 /var/log/komui/prune-releases.log
```

## 18. Local development and verification

Backend:

```bash
cd /Users/kadimagomedov/Documents/KomuiMerch/server
npm test
npm run build
```

Staging and catalog smoke from server:

```bash
sudo /usr/local/sbin/komui-healthcheck
sudo /usr/local/sbin/komui-deploy-status
```

Both tools load staging credentials without placing their values in process
arguments. Do not pass the combined username/password through curl's command-line
authentication option: another local user can observe command arguments through
`ps`.

Admin runtime smoke should use the protected server-side admin BFF/UI against
the explicitly selected staging target:

```text
GET https://stage.komui.ru/api/admin/runtime
```

The response must identify the staging backend/database and current runtime
state. For an exceptional SSH-only diagnostic, pass Basic Auth and admin
headers through curl stdin config or another protected file descriptor, never
through `-u`/`-H` command-line values.

Ozon preview smoke is also run through the protected admin flow with staging
selected and this bounded request:

```json
{
  "limit": 1,
  "targets": {
    "serverPostgres": true,
    "supabase": false
  }
}
```

This smoke calls Ozon and records a preview row, so it is an explicit bounded
admin operation rather than a read-only public healthcheck.

## 19. Post-cutover operations and release readiness

DNS/TLS cutover уже выполнен. Любое переключение live traffic, cleanup данных
или изменение production credentials по-прежнему требует явного owner
approval.

Payment-consistency migration и production rollout завершены. Для обычного
code/docs release применяется текущая deployment model:

1. Проверить clean source, exact remote revision, tests/build и
   source/schema compatibility gate.
2. Развернуть revision сначала в staging и проверить readiness, public routes,
   queues, logs и generated static artifacts.
3. Убедиться, что свежий encrypted backup опубликован и проверен через exact
   offsite round-trip.
4. Тем же immutable revision выполнить production deploy.
5. После переключения проверить production backend/frontend, email worker,
   payment/CDEK queues, order monitor, Xray/Telegram transport, Nginx и failed
   units.

Новый schema-changing release по-прежнему требует отдельного closed-write
maintenance window. Generic Telegram/Git deploy не применяет migrations.

Cutover runbook:

```text
docs/server-migration/CUTOVER_RUNBOOK.md
```

## 20. Known limitations / open decisions

Current known limitations:

1. Ozon import пишет только в local server PostgreSQL; Supabase dual-write
   выключен.
2. Полностью новый Ozon product без mapping не публикуется автоматически.
3. Production использует T-Bank production mode, staging — demo; реальные
   provider-mutating payment/refund/CDEK smokes требуют отдельного разрешения и
   поштучного контроля side effects.
4. Historical `cdek_cancel` backfill может оставаться в `needs_review`; перед
   любым retry/cleanup нужно сверять live queue и реальный CDEK shipment.
5. Google Fonts ещё не полностью локализованы.
6. `api/supabase-function.js`, Supabase и Vercel сохраняются для legacy
   compatibility/fallback; их decommission не завершён. `api.komui.ru` не
   является зависимостью текущего checkout и требует отдельного решения о
   ремонте либо выводе из эксплуатации.
7. Production traffic fallback меняет live routing и требует runbook/owner
   approval. DNS rollback остаётся запасным вариантом при недоступности сервера.
8. Backup v2 намеренно исключает `/etc/komui/backup.key`; независимое
   off-server escrow и recovery test ключа ещё не подтверждены.
9. KOMUI backup не является backup всего общего PostgreSQL cluster: базы и
   runtime GetoMerch имеют отдельный recovery contract.

## 21. Quick orientation for a new developer

If you need to understand the project quickly:

1. Read this document.
2. Read `SERVER_MIGRATION_PLAN.md`.
3. Read `docs/server-migration/CUTOVER_RUNBOOK.md`.
4. Read `docs/server-migration/XRAY_SUBSCRIPTION_UPDATER.md` for Telegram
   transport operations.
5. Inspect backend routes in `server/src/app.ts`.
6. Inspect env schema in `server/src/config.ts`.
7. Inspect checkout/integration logic in `server/src/stage5.ts`.
8. Inspect Ozon import in `server/src/ozonImport.ts`.
9. Inspect traffic switch in `server/src/runtimeSwitch.ts` and
   `ops/server/komui-traffic-switch-apply.sh`.
10. Run:

```bash
cd server
npm test
npm run build
```

11. On server, run:

```bash
sudo /usr/local/sbin/komui-healthcheck
systemctl is-active postgresql nginx komui-backend komui-production-backend \
  komui-email-worker komui-production-email-worker komui-backup.timer \
  komui-healthcheck.timer komui-order-monitor.timer xray \
  komui-xray-subscription-update.timer
```

Локальные tests и один healthcheck недостаточны для заявления о production
deploy. Дополнительно сверяются exact Git/release state, обе readiness probes,
public endpoints, queues, service logs и отсутствие failed units.
