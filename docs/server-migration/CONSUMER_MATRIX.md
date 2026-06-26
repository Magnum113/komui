# Матрица потребителей Supabase

Дата снимка: 25 июня 2026 года.

Проект Supabase: `bkxpzfnglihxpbnhtjjq`.

Значения ключей и токенов в документ не включены.

## Активный контур

| Потребитель | Расположение | Доступ | Что использует | Частота | Целевой интерфейс | Статус |
|---|---|---|---|---|---|---|
| Витрина KOMUI | `KomuiMerch`, production на Vercel | Публичное чтение; запись только через Edge Functions | `merch_storefront_products`, checkout, payment status, promo, CDEK | По запросам покупателей и при build | Собственный public API на сервере | Подтверждён |
| Supabase Edge Functions | Managed Supabase | `service_role` | Заказы покупателей, платежи, промокоды, CDEK | По запросам витрины и webhook | Backend-сервис на сервере | Подтверждён |
| Nginx `api.komui.ru` | Сервер `89.111.152.112` | Проксирует REST и Functions | Supabase REST/Functions текущего проекта | По запросам витрины | В будущем — собственный API; до cutover не менять | Подтверждён |
| GetoMerchV3 | `/Users/kadimagomedov/Documents/GetoMerchV3` | Прямой `anon` CRUD | 18 внутренних таблиц склада, производства, Ozon и финансов | Ручная работа администратора | Защищённый admin API/BFF | Подтверждён, вероятный основной вариант |
| Ozon API routes V3 | `GetoMerchV3/src/app/api/ozon` | Ozon credentials + прямой `anon` CRUD | Ozon orders, items, finance, products, inventory, transactions | Ручной запуск из админки | Защищённые backend jobs | Подтверждён |
| SKU-скрипты V3 | `GetoMerchV3/sku_mapping` | Прямой `anon` CRUD | `merch_products` и связанные SKU/Ozon-поля | Ручной запуск | Одноразовые управляемые migration jobs | Подтверждён |
| GetoMerchV4 | `/Users/kadimagomedov/Documents/GetoMerchV4` | Прямой `anon` CRUD | Те же 18 внутренних таблиц | Не установлено | Либо архивировать, либо перевести на тот же admin API | Подтверждён как код; deployment не установлен |
| Ozon API routes V4 | `GetoMerchV4/src/app/api/ozon` | Ozon credentials + прямой `anon` CRUD | Те же Ozon/складские таблицы | Не установлено | Защищённые backend jobs | Подтверждён как код |
| DB-trigger Vercel redeploy | `notify_vercel_storefront_changed()` | `SECURITY DEFINER`, внешний HTTP | Deploy hook при изменении `merch_storefront_products` | После INSERT/UPDATE/DELETE | Явный rebuild/deploy job без секрета в функции БД | Подтверждён |

## Неактивные или исключённые системы

| Система | Причина исключения |
|---|---|
| GetoMerchV2 | Использует другой Supabase project ref и другую схему данных |
| AnalyticsHub | Использует другой Supabase project ref |
| OpenClaw Supabase MCP на сервере | Конфигурация содержит Supabase URL, но не содержит ref текущего проекта |
| Серверные analytics-скрипты | Активных обращений к текущему Supabase в рабочих скриптах не найдено |
| Cron пользователя `admin` | Активных Supabase/Ozon jobs не найдено; analytics cron закомментирован |
| Supabase Auth | В `auth.users` — 0 пользователей |
| Supabase Storage и Realtime | Runtime-зависимости проекта не обнаружены |

## Таблицы

### Внутренние таблицы с фактическим публичным CRUD

Эти 18 таблиц сейчас используются GetoMerchV3/V4 через роль `anon`:

1. `merch_warehouses`
2. `merch_product_categories`
3. `merch_fabric_types`
4. `merch_colors`
5. `merch_sizes`
6. `merch_decoration_types`
7. `merch_designs`
8. `merch_products`
9. `merch_inventory`
10. `merch_transactions`
11. `merch_print_inventory`
12. `merch_workshop_orders`
13. `merch_workshop_order_items`
14. `merch_ozon_orders`
15. `merch_ozon_order_items`
16. `merch_ozon_finance_operations`
17. `merch_expense_categories`
18. `merch_expenses`

Для них одновременно существуют:

- широкие grants для `anon` и `authenticated`;
- RLS policies `USING (true) WITH CHECK (true)`;
- фактические операции записи под ролью `anon`.

Это не теоретический риск. В `pg_stat_statements` зафиксированы, среди прочего:

- 442 INSERT в `merch_ozon_order_items`;
- 351 DELETE из `merch_ozon_order_items`;
- 315 UPDATE `merch_inventory`;
- 269 UPDATE `merch_ozon_orders`;
- 145 INSERT в `merch_transactions`.

### Публичная витрина

`merch_storefront_products` имеет корректную публичную SELECT policy только для
активных товаров. Однако grants для `anon` и `authenticated` шире необходимого:
RLS сейчас блокирует запись, но grants следует сузить до `SELECT`.

### Закрытый checkout-контур

Прямой доступ `anon`/`authenticated` запрещён RLS для:

- `merch_customer_orders`;
- `merch_customer_order_items`;
- `merch_payment_attempts`;
- `merch_payment_events`;
- `merch_cdek_shipments`;
- `merch_cdek_events`;
- `merch_promo_codes`;
- `merch_promo_redemptions`.

Запись выполняется Edge Functions через `service_role`.

### Backup-таблицы

- `merch_products_backup_20260622`;
- `merch_products_backup_v2`.

У них включён RLS без policies, поэтому фактического `anon`-доступа сейчас нет.
При этом grants выданы слишком широко и должны быть отозваны при отдельном
production hardening.

## Edge Functions

Все 6 функций активны и опубликованы с `verify_jwt=false`:

1. `tbank-create-payment`
2. `tbank-webhook`
3. `tbank-payment-status`
4. `cdek-delivery-points`
5. `cdek-delivery-quote`
6. `promo-validate`

`verify_jwt=false` сам по себе не означает ошибку: checkout endpoints публичны,
а webhook должен приниматься от банка. Компенсирующие проверки присутствуют:

- allowlist origin для браузерных запросов;
- access token заказа для payment status;
- криптографическая проверка T-Банк webhook;
- серверное использование `service_role`.

При переносе эти проверки должны быть воспроизведены и покрыты тестами.

## Функции и триггеры БД

| Функция | Назначение | Риск/решение |
|---|---|---|
| `merch_create_checkout_order(jsonb, jsonb)` | Атомарное создание заказа | Доступ только `service_role`; перенести в транзакцию backend |
| `notify_vercel_storefront_changed()` | Вызов Vercel deploy hook | `SECURITY DEFINER` и доступна `anon`; отозвать EXECUTE после подготовки замены |
| `update_inventory_timestamp()` | Timestamp trigger | Убрать публичный EXECUTE, сам trigger сохранить |
| `private.merch_set_updated_at()` | Timestamp trigger checkout-таблиц | Убрать default PUBLIC EXECUTE |

## Реестр секретов без значений

| Имя/группа | Текущее использование | Целевое хранение | Ротация |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Витрина и админки | Удалить после миграции runtime | Не требуется после удаления |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_ANON_KEY` | Прямой REST из браузера/build | Удалить после миграции | Ротировать только после production cutover |
| `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_SECRET_KEYS` | Edge Functions | Не переносить как рабочий секрет; заменить DB credentials | После окончательного отключения Supabase |
| `OZON_CLIEN_ID`, `OZON_API_KEY` | GetoMerch V3/V4 API routes | Root-owned EnvironmentFile backend | Ротировать после переноса |
| `TBANK_DEMO_TERMINAL_KEY`, `TBANK_DEMO_PASSWORD` | Edge Functions | Staging EnvironmentFile; только demo | По правилам банка |
| Production T-Банк credentials | Пока не используются в staging | Отдельный production EnvironmentFile | Перед cutover либо по политике банка |
| `CDEK_LOGIN`/`CDEK_CLIENT_ID`, `CDEK_PASSWORD`/`CDEK_CLIENT_SECRET` | Edge Functions | Root-owned EnvironmentFile backend | После переноса |
| `YANDEX_MAPS_API_KEY` | Vercel Functions/frontend config | Ограниченный по домену ключ | При смене домена/компрометации |
| Vercel deploy hook | DB trigger | Удалить из БД; заменить локальным rebuild job | Ротировать после отключения trigger |
| SSH migration key | Временный доступ Codex | Удалить после завершения работ | Обязательное удаление |

## Нерешённые вопросы

1. Подтвердить, какой deployment является рабочей админкой: V3, V4 или оба.
2. Зафиксировать URL рабочей админки и владельца deployment.
3. Решить, архивируется ли V4 или переносится как отдельная ветка.
4. Уточнить, какие SKU-скрипты ещё будут запускаться до cutover.

Эти вопросы не блокируют этапы 2–3 и изолированный staging. Они блокируют
production hardening и production cutover.
