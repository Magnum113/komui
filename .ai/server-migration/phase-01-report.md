# Этап 1 — отчёт

Дата: 25 июня 2026 года.

Статус: **GO для этапов подготовки staging; production hardening не разрешён**.

## Выполнено

- проверены локальные репозитории и конфигурации;
- проверен сервер на активных потребителей текущего Supabase;
- получен live-снимок 29 public-таблиц;
- проверены grants, RLS policies, routines, triggers и sequences;
- проверены 6 активных Edge Functions;
- проверена статистика фактических запросов к БД;
- сформирована матрица потребителей;
- сформирован реестр секретов без значений;
- подготовлены guarded forward и rollback SQL;
- production Supabase, Vercel, DNS и webhook не изменялись.

## Карта данных

В public schema находится 29 таблиц:

- 18 внутренних таблиц админки, склада, производства, Ozon и финансов;
- 1 публичная таблица витрины;
- 8 закрытых таблиц checkout/payment/CDEK/promo;
- 2 backup-таблицы.

Текущие объёмы небольшие: крупнейшая таблица
`merch_ozon_finance_operations` содержит около 1450 строк.

## Критический риск

На 18 внутренних таблицах `anon` и `authenticated` имеют широкие grants, а
RLS policies разрешают `USING (true) WITH CHECK (true)`.

Статистика подтверждает реальную запись под `anon`, включая:

- 442 INSERT `merch_ozon_order_items`;
- 351 DELETE `merch_ozon_order_items`;
- 315 UPDATE `merch_inventory`;
- 269 UPDATE `merch_ozon_orders`;
- 145 INSERT `merch_transactions`.

GetoMerchV3/V4 не используют Supabase Auth. В live Supabase Auth зарегистрировано
0 пользователей. Поэтому publishable/anon key фактически является единственным
условием доступа к административным данным.

## Потребители

Подтверждены:

- storefront `KomuiMerch`;
- 6 Supabase Edge Functions;
- Nginx proxy `api.komui.ru`;
- GetoMerchV3;
- GetoMerchV4;
- Ozon sync routes в V3/V4;
- ручные SKU-скрипты V3;
- DB-trigger Vercel redeploy.

Не найдено активных Supabase/Ozon cron jobs на сервере.

OpenClaw MCP использует другой Supabase URL: ref текущего проекта в его
конфигурации отсутствует.

## Неопределённость

Не установлено, какой внешний deployment админки является рабочим:

- V3 выглядит основным: последний commit 22 июня 2026 года, 20 миграций;
- V4 выглядит более старой экспериментальной веткой: последний commit
  29 мая 2026 года, локальные незакоммиченные analytics-варианты.

Это не мешает этапам 2–3 и изолированному staging. До переноса admin API и
production hardening владелец должен подтвердить рабочий deployment.

## Дополнительные риски

- `notify_vercel_storefront_changed()` — `SECURITY DEFINER`, доступна через RPC
  роли `anon` и содержит внешний Vercel hook;
- `update_inventory_timestamp()` и `private.merch_set_updated_at()` имеют лишний
  публичный EXECUTE;
- checkout/CDEK/payment sequences имеют лишний `USAGE` для прямых клиентов;
- backup-таблицы имеют широкие grants, хотя RLS без policies сейчас блокирует
  фактический доступ;
- 18 foreign keys не имеют покрывающих индексов;
- Edge Functions опубликованы с `verify_jwt=false`, но для публичных checkout и
  webhook endpoints в коде присутствуют компенсирующие проверки.

## Подготовленные артефакты

- `docs/server-migration/CONSUMER_MATRIX.md`;
- `docs/server-migration/PRODUCTION_HARDENING_DRAFT.md`;
- `docs/server-migration/sql/production-hardening-forward.sql`;
- `docs/server-migration/sql/production-hardening-rollback.sql`.

SQL содержит обязательный session gate и не применялся.

## Решение

### GO

Можно переходить к этапу 2:

- подготовить swap, firewall, SSH hardening, PostgreSQL, Node.js и systemd;
- использовать только отдельный staging-контур;
- не менять `api.komui.ru`, DNS, Supabase, Vercel и production webhook;
- не переносить реальные production credentials в staging.

### NO-GO

Пока запрещено:

- отзывать production grants/policies;
- ротировать anon key;
- отключать DB-trigger Vercel;
- переключать админку;
- выполнять production cutover.

Эти действия разрешаются только после переноса GetoMerch/Ozon на защищённый
backend, подтверждения активного deployment, backup и отдельного согласия.

## Изменения внешних систем

Нет. Сервер и production-сервисы на этом этапе не изменялись.
