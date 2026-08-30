# KOMUI server project overview

Основной актуальный документ по серверной реализации находится здесь:

- [docs/server-migration/SERVER_PROJECT_OVERVIEW.md](docs/server-migration/SERVER_PROJECT_OVERVIEW.md)

Этот корневой файл оставлен как стабильная точка входа для разработчиков и
агентов. Все существенные изменения серверной реализации нужно описывать в
основном документе выше.

Последнее крупное обновление: 30 августа 2026 — локально подготовлено усиление
согласованности оплаты и доставки по первым трём пунктам P1-аудита. T-Bank
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
visibility и regression tests. Migration условно поддерживает managed
Supabase roles и self-hosted backend role `komui_app` при включённом RLS. Это
изменение пока не развёрнуто на сервере: migration должна применяться до
запуска новой версии backend. CDEK fulfillment разрешён для актуальных статусов
`paid` и `partially_refunded`; `authorized` и `payment_review` его не запускают.
Выкладка требует maintenance/drain старого backend и payment ingress: после
начала migration старую версию нельзя возвращать к приёму payment writes,
ошибка устраняется forward-fix/data reconciliation либо восстановлением
согласованного backup до открытия ingress. Подробности и порядок выкладки — в
основном документе ниже.

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
