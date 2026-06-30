# Komui Merch — интеграция админ-панели

Документ для нейросети/разработчика, который будет делать админку в **отдельном фронтенд-проекте**, но **в том же Supabase-проекте**, что и витрина komui.ru. Здесь — всё, что нужно, чтобы читать заказы, оплаты, отгрузки, склад и финансы магазина.

> **Контекст «один Supabase на двоих»:** витрина и админка ходят в одну и ту же БД `bkxpzfnglihxpbnhtjjq`. Витрина — публичная статика, в неё клиент **не логинится** (`auth.users` пустой). Поэтому Supabase Auth можно спокойно занять под админов: конфликта с клиентскими сессиями не будет.

---

## 1. Стек и архитектура

- **Бэкенд**: Supabase (Postgres + PostgREST + Edge Functions на Deno).
- **Project ref**: `bkxpzfnglihxpbnhtjjq`
- **Project URL**: `https://bkxpzfnglihxpbnhtjjq.supabase.co`
- **REST**: `https://bkxpzfnglihxpbnhtjjq.supabase.co/rest/v1/`
- **Edge Functions**: `https://bkxpzfnglihxpbnhtjjq.supabase.co/functions/v1/<slug>`
- **Frontend проекта**: статичный HTML/JS (без сборки), хостинг — Vercel. Никакой публичной админки нет, её и нужно построить.

Витрина пишет в Supabase через Edge Functions; оплата — Т-Банк интернет-эквайринг; доставка — СДЭК (виджет + API).

---

## 2. Главное про доступ к данным (безопасность)

Все «чувствительные» таблицы (заказы, платежи, ПД клиентов, накладные СДЭК) **закрыты RLS-политикой `using (false)`** для ролей `anon` и `authenticated`. Прямой доступ через PostgREST с `anon`/обычным пользовательским JWT работать **не будет** — он вернёт пустой массив или 401.

Доступ к ним есть **только у `service_role`**:

```
grant select, insert, update, delete on public.merch_customer_orders to service_role;
grant select, insert, update, delete on public.merch_customer_order_items to service_role;
grant select, insert, update, delete on public.merch_payment_attempts to service_role;
grant select, insert, update, delete on public.merch_payment_events to service_role;
grant select, insert, update, delete on public.merch_cdek_shipments to service_role;
grant select, insert, update, delete on public.merch_cdek_events to service_role;
```

### Правила работы с `service_role` ключом

- **Никогда** не клади его в браузер, в `NEXT_PUBLIC_*` переменную, в репозиторий, в локальный JS.
- Храни на сервере (env переменная в Vercel/Render/Fly и т.п.).
- Все запросы из админки → **через свой BFF/Server Actions/Route Handlers**, которые на сервере используют ключ.

### Два варианта архитектуры (выбрать один)

#### Вариант A — Supabase Auth + RLS (рекомендуется)

Раз проекты общие и витрина не использует Supabase Auth, занимаем `auth.users` под админов. Тогда service_role вообще не нужен в админке, всё работает прямо с `anon` ключом + JWT залогиненного админа. RLS-политики пускают только тех, кто есть в новой таблице `merch_admins`.

```
[Admin UI: Next.js / SPA]
        │ supabase.auth.signInWithPassword (email+password)
        │ anon key + JWT админа
        ▼
[Supabase PostgREST]
        │ RLS: разрешено, если auth.uid() ∈ merch_admins
        ▼
[merch_customer_orders, merch_inventory, ...]
```

Минусы: нужно один раз накатить миграцию (см. §3.5) и завести админ-юзера в Dashboard → Authentication → Users.

#### Вариант B — Service Role через BFF

Если по каким-то причинам Supabase Auth не подходит (например, хочется SSO/Clerk), оставляем RLS как есть и ходим в Supabase **только с сервера админки** под `service_role`. Авторизация админа решается на стороне BFF (NextAuth + whitelist email, Clerk и т.п.).

```
[Admin UI]
        │ session cookie
        ▼
[Next.js Server Action / Route Handler]   ◄── проверяет, что юзер — админ
        │ supabase-js (service_role key, ТОЛЬКО на сервере)
        ▼
[Supabase REST / RPC]
```

В этом варианте раздел §3.5 (миграция RLS) **не нужен**.

---

## 3. Подключение supabase-js

### 3.1 Вариант A (Supabase Auth + RLS) — клиентский браузер

```ts
// lib/supabase.ts (admin UI)
import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,       // https://bkxpzfnglihxpbnhtjjq.supabase.co
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,  // anon key — публичный
  { auth: { persistSession: true, autoRefreshToken: true } },
);

// логин
await supabase.auth.signInWithPassword({ email, password });
// после логина RLS пропускает к merch_* (см. §3.5)
const { data } = await supabase
  .from("merch_customer_orders")
  .select("*")
  .order("created_at", { ascending: false })
  .limit(50);
```

Env (можно лежать в `NEXT_PUBLIC_*` — это не секрет):

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://bkxpzfnglihxpbnhtjjq.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key из Dashboard → Project Settings → API>
```

### 3.2 Вариант B (Service Role через BFF) — только на сервере

```ts
// app/server/supabase.ts
import { createClient } from "@supabase/supabase-js";

export const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,                 // https://bkxpzfnglihxpbnhtjjq.supabase.co
  process.env.SUPABASE_SERVICE_ROLE_KEY!,    // НИКОГДА не префиксовать NEXT_PUBLIC_
  {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: "public" },
  },
);
```

Env (только на сервере, не выгружать в браузер):

```dotenv
SUPABASE_URL=https://bkxpzfnglihxpbnhtjjq.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service_role из Dashboard → Project Settings → API>
```

Альтернатива supabase-js — прямой REST:

```
GET https://bkxpzfnglihxpbnhtjjq.supabase.co/rest/v1/merch_customer_orders?select=*&order=created_at.desc&limit=50
apikey: <SERVICE_ROLE_KEY>
Authorization: Bearer <SERVICE_ROLE_KEY>
```

### 3.5 Миграция для Варианта A — таблица админов + RLS

Накатить **один раз** на проект `bkxpzfnglihxpbnhtjjq` (например, файлом `supabase/migrations/<ts>_add_admin_access.sql` либо через Dashboard → SQL Editor).

```sql
-- 1. Таблица админов: 1:1 с auth.users
create table if not exists public.merch_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  created_at timestamptz not null default now()
);

alter table public.merch_admins enable row level security;

-- Только сами админы видят свою же запись (для UI «кто я»)
create policy "Admins see admin list"
  on public.merch_admins
  for select
  to authenticated
  using (exists (select 1 from public.merch_admins a where a.user_id = auth.uid()));

-- 2. Хелпер
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.merch_admins where user_id = auth.uid()
  );
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- 3. Открываем чувствительные таблицы админам.
--    Существующие политики "No direct storefront access ..." оставляем (они для anon),
--    добавляем рядом новые — для authenticated-админов.

-- merch_customer_orders
grant select, insert, update, delete on public.merch_customer_orders to authenticated;
create policy "Admins read customer orders"
  on public.merch_customer_orders for select to authenticated
  using (public.is_admin());
create policy "Admins write customer orders"
  on public.merch_customer_orders for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- merch_customer_order_items
grant select on public.merch_customer_order_items to authenticated;
create policy "Admins read customer order items"
  on public.merch_customer_order_items for select to authenticated
  using (public.is_admin());

-- merch_payment_attempts / merch_payment_events — read-only из админки
grant select on public.merch_payment_attempts to authenticated;
create policy "Admins read payment attempts"
  on public.merch_payment_attempts for select to authenticated
  using (public.is_admin());
grant select on public.merch_payment_events to authenticated;
create policy "Admins read payment events"
  on public.merch_payment_events for select to authenticated
  using (public.is_admin());

-- merch_cdek_shipments / merch_cdek_events
grant select on public.merch_cdek_shipments to authenticated;
create policy "Admins read cdek shipments"
  on public.merch_cdek_shipments for select to authenticated
  using (public.is_admin());
grant select on public.merch_cdek_events to authenticated;
create policy "Admins read cdek events"
  on public.merch_cdek_events for select to authenticated
  using (public.is_admin());

-- 4. Каталог / склад / финансы — на чтение и запись админам
-- (тут можно не разделять read/write, если все админы равноправны)
do $$
declare t text;
begin
  foreach t in array array[
    'merch_warehouses','merch_product_categories','merch_fabric_types','merch_colors',
    'merch_sizes','merch_designs','merch_decoration_types','merch_products',
    'merch_inventory','merch_print_inventory','merch_transactions',
    'merch_workshop_orders','merch_workshop_order_items',
    'merch_ozon_orders','merch_ozon_order_items','merch_ozon_finance_operations',
    'merch_expense_categories','merch_expenses','merch_storefront_products'
  ] loop
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format($q$
      create policy "Admins manage %1$s"
        on public.%1$I for all to authenticated
        using (public.is_admin()) with check (public.is_admin());
    $q$, t);
  end loop;
end $$;
```

Завести первого админа:

1. Dashboard → Authentication → Users → **Add user** (email + пароль или magic link).
2. SQL Editor:
   ```sql
   insert into public.merch_admins (user_id, email, display_name)
   select id, email, 'Owner' from auth.users where email = 'твой@email';
   ```

После этого админка логинится через `supabase.auth.signInWithPassword` и видит всё. Никто другой (даже залогиненный, но не из `merch_admins`) — не видит ничего.

---

## 4. Схема данных (то, что нужно админке)

Все таблицы — в схеме `public`, префикс `merch_`.

### 4.1 Заказы с витрины komui.ru (онлайн-магазин)

#### `merch_customer_orders` — заказ покупателя

| колонка | тип | описание |
|---|---|---|
| `id` | uuid PK | внутренний |
| `order_number` | text UNIQUE | человекочитаемый номер (показывать клиенту/в админке) |
| `client_request_id` | uuid UNIQUE | идемпотентность создания |
| `access_token_hash` | text | sha256 от токена, по нему клиент смотрит `payment-result` |
| `status` | text | `created` / `pending_payment` / `authorized` / `paid` / `payment_failed` / `payment_review` / `canceled` / `partially_refunded` / `refunded` |
| `customer_first_name`, `customer_last_name`, `customer_phone` | text | ПД — НЕ светить в интерфейсах без авторизации |
| `marketing_consent` | bool | согласие на маркетинг |
| `legal_accepted_at` | timestamptz | момент акцепта оферты |
| `delivery_provider` | text | сейчас всегда `cdek` |
| `delivery_point_code`, `delivery_city`, `delivery_address`, `delivery_hours`, `delivery_eta` | text | выбранный ПВЗ |
| `delivery_amount` | int (копейки) | стоимость доставки |
| `subtotal_amount`, `discount_amount`, `total_amount` | int (копейки) | суммы. Инвариант: `total = subtotal − discount + delivery` |
| `currency` | text | всегда `RUB` |
| `promo_code` | text nullable | применённый промокод, если есть |
| `source` | text | по умолчанию `storefront` |
| `metadata` | jsonb | произвольные данные |
| `paid_at` | timestamptz nullable | момент подтверждения оплаты |
| `fulfillment_status` | text | ручной статус обработки в админке: `new` / `processing` / `shipped` / `delivered` / `canceled` / `returned` |
| `fulfillment_note` | text nullable | внутренняя заметка админа |
| `shipped_at`, `delivered_at` | timestamptz nullable | когда админ отметил отправку/доставку |
| `created_at`, `updated_at` | timestamptz | |

> Все денежные поля **в копейках** (`integer`). Для UI делить на 100.
> `status` — это статус оплаты/денег. Для кнопки «отправил» использовать `fulfillment_status`, не менять `status`.

#### `merch_customer_order_items` — позиции заказа

`order_id` → `merch_customer_orders.id` (ON DELETE CASCADE).
`product_id` → `merch_storefront_products.id` (товар витрины, может быть `null` если удалён).
Хранит `product_name`, `size`, `quantity`, `unit_price_amount`, `line_total_amount`, `image_url`, `product_snapshot` (jsonb-снимок карточки на момент покупки — устойчиво к будущим правкам товара).

#### `merch_payment_attempts` — попытки инициации платежа в Т-Банке

`order_id` → orders. `provider='tbank'`, `terminal_key`, `external_payment_id` (id платежа в Т-Банке), `provider_status` (`INITIATING` / `NEW` / `FORM_SHOWED` / `AUTHORIZED` / `CONFIRMED` / `REJECTED` / `REFUNDED` …), `amount`, `payment_url`, `error_code`, `error_message`, `request_payload`/`response_payload` (jsonb для отладки), `confirmed_at`.

#### `merch_payment_events` — верифицированные webhook-уведомления Т-Банка

`event_hash` уникальный — защита от дублей. `signature_valid` — true только если подпись прошла. `payload` jsonb — сырое тело уведомления. Это **источник правды** по статусу оплаты.

#### `merch_cdek_shipments` — накладные СДЭК

Один к одному с заказом (`order_id` UNIQUE). `status`: `pending` / `creating` / `accepted` / `created` / `invalid` / `failed` / `deleted` / `unknown`. `cdek_uuid`, `cdek_number` — идентификаторы СДЭК. `tariff_code`, `tariff_name`, `shipment_point` (откуда), `delivery_point` (куда — ПВЗ), `package_snapshot` (jsonb массив мест), `error_code`/`error_message`.

#### `merch_cdek_events` — события СДЭК (webhook/синхронизация)

Аналогично payment_events — `event_hash` UNIQUE, `payload` jsonb, `event_type`, `status_code`, `status_name`.

### 4.2 Каталог и склад (внутренний учёт)

- **`merch_products`** (151 строка) — внутренние SKU. Связи: `category_id → merch_product_categories`, `fabric_id → merch_fabric_types`, `color_id → merch_colors`, `size_id → merch_sizes`, `design_id → merch_designs`, `decoration_type_id → merch_decoration_types`. Поля: `sku`, `is_blank` (заготовка vs готовый товар), `cost_price`, `sale_price`, `legacy_skus[]`, `ozon_sku`, `design_version`, `hoodie_fit` (`REG`/`CRP`), `hoodie_fabric` (`FLC`/`NF`).
- **`merch_storefront_products`** (31 строка) — карточки для витрины komui.ru. Один storefront-товар = один дизайн × вариант. Содержит `offers` jsonb (варианты по размерам со ссылкой на `merch_products`), цены `price_min`/`price_max`/`compare_at_price`, продажи `sales_6m_units/revenue/rank`, медиа.
- **`merch_warehouses`** — склады. `type`: `own` (свой) или `workshop` (мастерская/подрядчик).
- **`merch_inventory`** — остатки готовых товаров по складам. `(product_id, warehouse_id, quantity)`.
- **`merch_print_inventory`** — остатки **напечатанных листов/принтов** по складам (для производства). `(design_id, warehouse_id, quantity)`.
- **`merch_designs`** — дизайны (принты/вышивки). `type`: `print` / `embroidery`. `code` = D### из шаблона артикула.
- **`merch_product_categories`**, **`merch_fabric_types`**, **`merch_colors`**, **`merch_sizes`**, **`merch_decoration_types`** — справочники.
- **`merch_transactions`** (329 строк) — движение склада. `type`: `receive` / `transfer` / `sale` / `production` / `adjustment` / `writeoff`. Это аналог журнала проводок. `product_id`, `from_warehouse_id`, `to_warehouse_id`, `quantity`, `source_product_id` (для production — заготовка), `design_id`/`source_design_id`, `workshop_order_id`, `occurred_at`.
- **`merch_workshop_orders`** + **`merch_workshop_order_items`** — заказы в мастерскую (отправка заготовок на печать/вышивку). Статусы: `sent` / `ready` / `received` / `cancelled`.

### 4.3 Маркетплейс Ozon (импорт продаж и финансов)

- **`merch_ozon_orders`** (495) — заказы (postings) Ozon. `posting_number`, `status`, `substatus`, `total_price`, `raw` jsonb, `shipped_at`, `shipped_from_warehouse_id`, `workshop_order_id`.
- **`merch_ozon_order_items`** (499) — позиции. `offer_id`, `ozon_sku`, `name`, `quantity`, `price`, `product_id` (мэппинг на внутренний `merch_products.id`).
- **`merch_ozon_finance_operations`** (1427) — операции из Ozon финансового отчёта. `operation_type`, `operation_date`, `amount`, `accruals_for_sale`, `sale_commission`, `services` jsonb, `items` jsonb, `raw` jsonb.

### 4.4 Расходы

- **`merch_expense_categories`** — категории расходов (цвет, порядок, `archived`).
- **`merch_expenses`** — расходы: `amount`, `occurred_at` (date), `description`, `category_id`.

### 4.5 Бэкап-таблицы (игнорировать в админке)

`merch_products_backup_20260622`, `merch_products_backup_v2` — снимки до миграций. **Не показывать, не редактировать.**

---

## 5. Edge Functions (как работает витрина)

Все функции в `supabase/functions/`, развёрнуты в Supabase. Для админки они **не нужны напрямую** — это пайплайн самой витрины. Но контекст важен.

| slug | назначение | вызывает |
|---|---|---|
| `tbank-create-payment` | создаёт заказ + вызывает `v2/Init` Т-Банка | витрина (POST /checkout) |
| `tbank-webhook` | проверяет подпись уведомления Т-Банка, обновляет статусы, создаёт отгрузку в СДЭК | Т-Банк |
| `tbank-payment-status` | возвращает клиенту статус по `orderNumber` + `accessToken` | страница `/payment-result` |
| `cdek-delivery-points` | прокси к СДЭК API (поиск города и ПВЗ) | checkout витрины |
| `cdek-delivery-quote` | расчёт тарифа СДЭК по ПВЗ и корзине | checkout витрины |

Жизненный цикл заказа на витрине:

1. Клиент → `tbank-create-payment` → запись в `merch_customer_orders` (status=`created`), `merch_customer_order_items`, попытка в `merch_payment_attempts`, ответ с `payment_url` Т-Банка.
2. Клиент платит на форме Т-Банка.
3. Т-Банк → `tbank-webhook`: запись в `merch_payment_events`, обновление `merch_payment_attempts.provider_status`, обновление `merch_customer_orders.status` + `paid_at` при `CONFIRMED`. Параллельно создаётся `merch_cdek_shipments` (status=`creating` → `created`).
4. Клиент видит результат на `/payment-result` (читает `tbank-payment-status`).

---

## 6. Что строить в админке

Минимально полезный набор экранов (по приоритету):

### 6.1 Дашборд (главная)
- Заказы за сегодня/неделю/месяц: count + суммы (`merch_customer_orders` where `paid_at` in range).
- Конверсия `created` → `paid` (отношение по `status`).
- Ozon продажи за период (`merch_ozon_orders` + `merch_ozon_finance_operations`).
- Остатки с алертом: `merch_inventory` where `quantity <= threshold`.

### 6.2 Заказы (komui.ru)
- Список `merch_customer_orders` с фильтрами по `status`, дате, поиску по `order_number` / `customer_phone`.
- Карточка заказа: позиции (`merch_customer_order_items`), история платежей (`merch_payment_attempts` + `merch_payment_events`), статус СДЭК (`merch_cdek_shipments`, последние `merch_cdek_events`).
- Действия: пометить `canceled`, инициировать возврат (отдельная Edge Function — не реализована, нужно делать), скачать ярлык СДЭК (по `cdek_uuid` через CDEK API).
- Для отдельной админки использовать защищённый Komui backend API заказов: см. `docs/admin-storefront-orders-api.md`. Кнопка «отправил» вызывает `POST /admin/storefront/orders/:orderId/mark-shipped` и меняет `fulfillment_status`, а не payment `status`.

### 6.3 Ozon заказы
- Список `merch_ozon_orders` с фильтрами. Привязка к складу отгрузки и workshop-заказу.

### 6.4 Склад
- Остатки: join `merch_inventory` + `merch_products` + справочники.
- Журнал движений: `merch_transactions` с фильтром по типу/складу/товару.
- Мастерская: `merch_workshop_orders` (создание новой партии заготовок → дизайн → готовый товар).

### 6.5 Финансы
- Расходы: CRUD `merch_expenses` + `merch_expense_categories`.
- Доходы: агрегаты по `merch_customer_orders.paid_at` + `merch_ozon_finance_operations`.
- P&L по периодам.

### 6.6 Каталог
- `merch_products` (внутренние SKU): редактирование `cost_price`, `sale_price`, `legacy_skus`, привязка `ozon_sku`.
- `merch_storefront_products` (витрина): цены, `is_active`, `sort_order`, `badges`, `compare_at_price`, медиа.
- Для редактирования товаров витрины из отдельной админки использовать защищённый Komui backend API, а не прямую запись из браузера: см. `docs/admin-storefront-products-api.md`.

---

## 7. Готовые SQL-сниппеты (для admin BFF)

Все запросы — от `service_role`.

### Свежие заказы (последние 50)

```ts
const { data, error } = await supabaseAdmin
  .from("merch_customer_orders")
  .select(`
    id, order_number, status, total_amount, currency,
    customer_first_name, customer_last_name, customer_phone,
    delivery_city, delivery_address, paid_at, created_at,
    items:merch_customer_order_items (
      id, product_name, size, quantity, unit_price_amount, line_total_amount, image_url
    ),
    payment:merch_payment_attempts (
      provider_status, error_code, error_message, payment_url, updated_at
    ),
    shipment:merch_cdek_shipments (
      status, cdek_uuid, cdek_number, error_message
    )
  `)
  .order("created_at", { ascending: false })
  .limit(50);
```

### Метрики выручки за период

```sql
select
  date_trunc('day', paid_at) as day,
  count(*) as orders_count,
  sum(total_amount) / 100.0 as revenue_rub,
  sum(delivery_amount) / 100.0 as delivery_rub
from public.merch_customer_orders
where status = 'paid' and paid_at >= now() - interval '30 days'
group by 1
order by 1;
```

### Топ товаров по выручке (витрина)

```sql
select
  i.product_name,
  i.sku,
  sum(i.quantity) as units,
  sum(i.line_total_amount) / 100.0 as revenue_rub
from public.merch_customer_order_items i
join public.merch_customer_orders o on o.id = i.order_id
where o.status = 'paid' and o.paid_at >= now() - interval '90 days'
group by 1, 2
order by revenue_rub desc
limit 20;
```

### Остатки готовых товаров по складам

```sql
select
  w.name as warehouse,
  p.sku,
  c.name as category,
  col.name as color,
  s.name as size,
  inv.quantity
from public.merch_inventory inv
join public.merch_warehouses w on w.id = inv.warehouse_id
join public.merch_products p on p.id = inv.product_id
left join public.merch_product_categories c on c.id = p.category_id
left join public.merch_colors col on col.id = p.color_id
left join public.merch_sizes s on s.id = p.size_id
where inv.quantity > 0
order by w.name, p.sku;
```

### P&L грубо за месяц

```sql
with rev as (
  select sum(total_amount) / 100.0 as v
  from public.merch_customer_orders
  where status = 'paid' and paid_at >= date_trunc('month', now())
),
ozon_rev as (
  select sum(amount) as v
  from public.merch_ozon_finance_operations
  where operation_date >= date_trunc('month', now())
),
exp as (
  select sum(amount) as v
  from public.merch_expenses
  where occurred_at >= date_trunc('month', now())
)
select rev.v as storefront_revenue,
       ozon_rev.v as ozon_net,
       exp.v as expenses,
       coalesce(rev.v,0) + coalesce(ozon_rev.v,0) - coalesce(exp.v,0) as net
from rev, ozon_rev, exp;
```

---

## 8. Чего НЕ делать

- ❌ Не использовать `anon` ключ из браузера без миграции §3.5 — текущий RLS вернёт пустоту даже залогиненному пользователю.
- ❌ Не выкатывать миграцию §3.5, не заведя сначала первого админа в `auth.users` — иначе сам себе закроешь доступ.
- ❌ Не давать `authenticated` доступ к таблицам **без** проверки `public.is_admin()` — иначе любой человек, который зарегается в Supabase Auth, увидит заказы.
- ❌ Не править `merch_customer_orders.status` напрямую, если есть оплата — статус оплаты должен идти из webhook. Для отмены лучше отдельная Edge Function, которая ещё и в Т-Банке cancel вызовет.
- ❌ Не светить `customer_phone`, `customer_first/last_name` в публичных URL/логах.
- ❌ Не трогать `merch_products_backup_*` — это бэкапы.
- ❌ Не коммитить `SUPABASE_SERVICE_ROLE_KEY`, `TBANK_*`, `CDEK_*` в репозиторий админки.

---

## 9. Realtime

- **Вариант A:** после миграции §3.5 Realtime работает прямо из браузера админки на `anon` ключе под JWT админа. Включить таблицы в Dashboard → Database → Replication (`merch_customer_orders`, `merch_payment_attempts`, `merch_cdek_shipments`).
  ```ts
  supabase.channel("new-orders")
    .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "merch_customer_orders" },
        (payload) => showToast(payload.new))
    .subscribe();
  ```
- **Вариант B:** Realtime поверх RLS не пустит `authenticated` без политики, поэтому в BFF либо подписываемся через service_role на сервере и стримим клиенту по SSE, либо поллим раз в 10–30 секунд `where created_at > last_seen`.

---

## 10. Резюме для другой нейросети

> Тебе нужно построить админку для интернет-магазина мерча Komui. Бэкенд — **тот же** Supabase, что у витрины: `https://bkxpzfnglihxpbnhtjjq.supabase.co`, схема `public`, префикс таблиц `merch_*`. Витрина в Supabase Auth не логинит клиентов (`auth.users` пуст), поэтому Auth свободен под админов.
>
> **Рекомендуемый путь (Вариант A):** накатить миграцию из §3.5 (таблица `public.merch_admins` + хелпер `public.is_admin()` + RLS-политики «для authenticated, если is_admin»), завести первого админа через Dashboard, сделать SPA/Next.js, который логинит через `supabase.auth.signInWithPassword` и ходит в БД прямо `anon` ключом — RLS отдаст всё нужное.
>
> **Если нельзя занимать Auth (Вариант B):** оставить RLS как есть и сделать BFF (Next.js Server Actions), который с сервера ходит в Supabase под `SUPABASE_SERVICE_ROLE_KEY` (этот ключ никогда не должен попасть в браузер).
>
> Главные таблицы: `merch_customer_orders` + `merch_customer_order_items` (заказы витрины, **деньги в копейках**), `merch_payment_attempts` + `merch_payment_events` (оплата Т-Банк, payment_events — источник правды), `merch_cdek_shipments` + `merch_cdek_events` (доставка СДЭК), `merch_ozon_orders`/`merch_ozon_order_items`/`merch_ozon_finance_operations` (маркетплейс), `merch_inventory` + `merch_print_inventory` + `merch_products` + `merch_warehouses` + `merch_transactions` (склад и движения), `merch_storefront_products` (карточки витрины), `merch_expenses` + `merch_expense_categories` (расходы). Подробности схемы и готовые SQL — выше в этом документе.
