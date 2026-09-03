# KOMUI server project overview

Это основной актуальный документ по серверной реализации. Подробный дневник
переезда сохранён отдельно как исторический материал:
[docs/server-migration/SERVER_PROJECT_OVERVIEW.md](docs/server-migration/SERVER_PROJECT_OVERVIEW.md).

Последняя проверка актуального состояния: 4 сентября 2026 года.

- `komui.ru` и `stage.komui.ru` обслуживаются self-hosted
  Nginx/Fastify/PostgreSQL;
- код runtime, storefront build и Ozon import в этом репозитории не имеет
  зависимости от Supabase или Vercel; аварийный proxy/fallback на старый
  hosting удалён из исходников и rollout-конфигурации;
- production deploy содержит обязательный fail-closed decommission gate: он
  отключает legacy systemd watcher, устанавливает отдельный server-only Nginx
  snippet, очищает точные устаревшие env-ключи и переводит `api.komui.ru` в
  HTTP 410 tombstone без upstream;
- SQL схемы хранятся в `db/migrations` и применяются к PostgreSQL через
  контролируемый server rollout;
- payment/CDEK consistency hardening из первых трёх пунктов P1 и совместимая
  схема работают в staging и production;
- PostgreSQL обновлён внутри ветки 17.x до версии 17.11;
- Single Opt-In работает в checkout и футере без confirmation-письма;
- production order monitor использует hardened payment/CDEK schema;
- Telegram transport работает через loopback Xray 26.3.27, конфигурацию которого
  обновляет fail-closed primary/secondary systemd timer;
- backup v2 сохраняет обе KOMUI DB с owners/ACL и staging/production runtime,
  а публикация во внешнее хранилище завершается только после обратного
  скачивания и проверки checksum.
- hoodie variant contract `hoodie-variants-v1` работает в staging и production:
  checkout использует точный `offerId`, разная посадка/начёс представлены
  связанными карточками, неоднозначный legacy выбор требует повторного выбора,
  а deploy fail-closed проверяет совместимость source/schema.

Точные активные release paths и Git revision не фиксируются здесь как
долгоживущая константа: их нужно получать через
`/usr/local/sbin/komui-deploy-status`.

Историческое recovery evidence от 1 сентября 2026: exact post-drain archive
`komui-backup-20260830T180555Z.tar.gz.gpg` успешно восстановлен по обоим DB
dumps в уникальные временные базы. Подтверждены legacy schema и aggregate
counts, catalog read как `komui_app`, `/health/ready` и
`/v1/products?limit=1` на соответствующих immutable legacy backends внутри
network namespaces без outbound. Temporary DB/session/process/workdir удалены;
staging/production PID, symlinks и active DB identity не изменились. Evidence:
`/var/backups/komui/logs/restore-drill-20260830T180555Z-20260901t082839z.log`.
Это scoped data/schema + legacy-runtime recovery test, а не полный production
DR: backup не сохраняет owners/ACL, runtime-config staging-centric, offsite
download/key escrow и более свежий scheduled archive отдельно не
восстанавливались. Подробности — в основном документе ниже.
Эти ограничения относятся именно к старому archive: backup v2 позднее закрыл
owners/ACL, production runtime и offsite-download проверки. Отдельное хранение
encryption key вне сервера всё ещё требует решения владельца.

Исторический staging rollout от 30 августа 2026: усиление согласованности оплаты
и доставки по первым трём пунктам P1-аудита первоначально развёрнуто на staging. T-Bank
webhook теперь обрабатывается одной транзакцией с монотонной state machine и
durable CDEK outbox; неоднозначный `/Init` блокирует повторный заказ до
`CheckOrder`/`GetState` reconciliation. Перед provider `Cancel` backend
транзакционно фиксирует durable intent, очищает `payment_url` и повторно
проверяет lease/OrderId/amount/terminal/PaymentId; без этого CAS сетевой
`Cancel` не отправляется. Поэтому crash или поздний `CONFIRMED` после начала
отмены переводит заказ в review и не запускает fulfillment. Полный
refund/reversal ставит идемпотентную отмену CDEK в очередь. После появления shipment row повторный
CDEK create `POST` запрещён, `accepted` сверяется до конечного результата, а
конкурентные create/cancel updates защищены compare-and-set. Добавлена
forward-only migration
`20260830143000_harden_payment_consistency.sql`, фоновые workers, operator
visibility и regression tests. Исторический SQL сохраняет условную
совместимость со старыми managed-ролями, а self-hosted PostgreSQL использует
backend role `komui_app` при включённом RLS.
Staging backend/frontend работает из release
`20260830T175312Z-stage-ac2567bb42ae` (commit `ac2567b`), а migration применена
только к `komui_staging`. Перед migration закрывались POST/webhook ingress и
старый backend; post-drain encrypted backup
`komui-backup-20260830T180555Z.tar.gz.gpg` проверен локально и загружен во
внешнее хранилище. Две исторические отмены реальных CDEK-отправлений оставлены
в `needs_review`, поэтому provider calls при rollout не выполнялись. CDEK
fulfillment разрешён для актуальных статусов
`paid` и `partially_refunded`; `authorized` и `payment_review` его не запускают.
Выкладка требует maintenance/drain старого backend и payment ingress: после
начала migration старую версию нельзя возвращать к приёму payment writes,
ошибка устраняется forward-fix/data reconciliation либо восстановлением
согласованного backup до старта workers. Штатный Git/Telegram deploy защищён
fail-closed source/schema gate: legacy code не запускается на migrated staging,
а новый payment-consistency code не запускается на legacy production schema.
Guard commit `b2c7337` установлен и проверен четырьмя server-side
non-activation probes; staging/production runtime при проверке не изменились.
На этом конкретном staging-этапе production не изменялся. Позднее migration и
тот же набор payment/CDEK-инвариантов были контролируемо развёрнуты в
production; актуальное состояние описано выше и в основном документе.

Предыдущее крупное обновление: 21 августа 2026 — добавлена self-hosted система
отзывов Ozon: нормализованные таблицы PostgreSQL, идемпотентный CSV/media
importer, локальное хранение фото и видео, фильтрация отменённых отзывов,
безопасный публичный API и включение review-данных в зашифрованные резервные
копии. Runbook: `docs/server-migration/OZON_REVIEWS_IMPORT.md`.

Предыдущее крупное обновление: 7 июля 2026 — начата реализация пункта
GEO/SEO roadmap по переносу товарных фото с Ozon CDN на `komui.ru`.
Добавлены root build dependencies, `scripts/sync-product-media.js`,
локальный/server media-cache, manifest mapping, WebP variants, `srcset`,
`width/height`, `fetchpriority`, nginx `/media/products/`, backend API mapping
через `server/src/mediaManifest.ts` и deploy checks, которые запрещают
`ir.ozone.ru` в публичных static/API артефактах. Подробный план:
`docs/SEO_MEDIA_MIGRATION_PLAN.md`.

Предыдущее крупное обновление: 30 июня 2026 — server-side создание CDEK
shipment, admin retry endpoint, ожидание трек-номера и кнопка отслеживания СДЭК
на странице результата оплаты. Также исправлен повтор оплаты после failed
payment: stale payment draft очищается, а checkout создаёт новый платёж вместо
переиспользования старой отклонённой ссылки Т-Банка. Для диагностики добавлены
structured logs всего CDEK shipment flow. На staging включено
`CDEK_CREATE_SHIPMENTS=true`; заказ `KOM-879480584` создан в CDEK с номером
`10288069122`. Backend также подтягивает `cdek_number` follow-up запросом, если
первичный ответ CDEK пришёл как `ACCEPTED` без номера. После этих изменений
создан свежий encrypted backup
`/var/backups/komui/daily/komui-backup-20260630T145422Z.tar.gz.gpg`,
загружен в Yandex Object Storage и успешно восстановлен в restore drill.
Также на первом шаге был подготовлен отдельный production candidate без cutover: БД
`komui_production`, service `komui-production-backend` на `127.0.0.1:3001`,
static root `/var/lib/komui/production-root` и HTTP pre-cutover vhost для
`komui.ru/www.komui.ru`. На этом историческом этапе TLS vhost был подготовлен,
но ещё не включён до DNS/cert.
Финальный production snapshot candidate создан из `komui_staging` в
`komui_production`; production backup
`/var/backups/komui/daily/komui-backup-20260630T164013Z.tar.gz.gpg` загружен во
внешнее хранилище и проверен restore drill. T-Bank оставлен в demo mode,
`CDEK_CREATE_SHIPMENTS=true` включён для production candidate. После ручного
DNS switch владельцем выпущен TLS certificate для `komui.ru/www.komui.ru`,
включён production HTTPS vhost и `https://komui.ru` обслуживается self-hosted
сервером.
