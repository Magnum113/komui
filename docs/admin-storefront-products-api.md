# API редактирования товаров витрины KOMUI

Документ для внедрения редактора товаров в отдельной админке. Визуал можно делать любым, но данные нужно менять через Komui backend, а не прямой записью из браузера в Supabase/Postgres.

## Общая схема

- В проекте есть два контура данных:
  - server PostgreSQL на отдельном сервере, подключается Komui backend через `DATABASE_URL`;
  - Supabase project `bkxpzfnglihxpbnhtjjq`, исторический/legacy контур и источник Edge Functions.
- Этот API редактирования пишет именно в server PostgreSQL, то есть в базу, которая стоит за Komui backend `/api`.
- Таблица витрины в обоих контурах называется `public.merch_storefront_products`.
- Backend маршруты: `server/src/adminStorefront.ts`, подключены в `server/src/app.ts`.
- Авторизация: тот же `ADMIN_API_TOKEN`, что уже используется для Ozon import.
- Деньги в этом API передаются в рублях числом, не в копейках.
- Изменение строки `merch_storefront_products` обновляет `updated_at = now()`.
- Если в БД активен trigger `storefront_products_redeploy`, изменение товара запустит rebuild статических страниц.
- Новая миграция БД не нужна: API использует существующие колонки `merch_storefront_products` и backend DB user, который уже нужен для Ozon import.
- Supabase этим endpoint сейчас не обновляется. Если текущая production-витрина или checkout всё ещё читают Supabase Edge Functions напрямую, нужно либо сначала перевести их на Komui backend `/api`, либо добавить отдельный server-side dual-write/sync в Supabase через service role. Не пытаться делать это из браузера админки.

## Авторизация

Каждый запрос к `/admin/...` должен передавать один из заголовков:

```http
Authorization: Bearer <ADMIN_API_TOKEN>
```

или:

```http
x-komui-admin-token: <ADMIN_API_TOKEN>
```

Не класть `ADMIN_API_TOKEN` в браузерный клиент. Если админка SPA/Next.js, сделай свой server-side BFF: браузер ходит в backend админки, а backend админки уже ходит в Komui API с токеном из env.

## Endpoints

В примерах ниже `KOMUI_API_BASE_URL` - адрес Komui backend. Если на сервере он проксируется через `/api`, полный путь будет вроде:

```text
https://komui.ru/api/admin/storefront/products
```

### 1. Список товаров

```http
GET /admin/storefront/products?limit=100&offset=0&q=gojo&active=all
```

Query:

| поле | тип | описание |
|---|---|---|
| `limit` | number | 1-200, default `100` |
| `offset` | number | default `0` |
| `q` | string | поиск по названию, slug, design_key, коллекции, тайтлу, персонажу |
| `active` | `all` / `active` / `inactive` / `true` / `false` | фильтр активности |

Ответ:

```json
{
  "products": [
    {
      "id": "7c169f01-b459-4e25-b74f-a4909a1b4149",
      "designKey": "var16|print|tshirt|washed-grey",
      "name": "Футболка-варёнка Сатору Годжо",
      "slug": "var16-print-tshirt-washed-grey",
      "description": "Описание...",
      "shortDescription": "Короткое описание...",
      "category": "Футболки",
      "productType": "Футболка",
      "decorationType": "Принт",
      "colorName": "Вареный серый",
      "collectionName": "Satoru Gojo",
      "sizes": ["S", "M", "L", "XL"],
      "salePrice": 2900,
      "priceMax": 2900,
      "regularPrice": 4500,
      "currency": "RUB",
      "primaryImageUrl": "https://ir.ozone.ru/s3/example.jpg",
      "mainImagePath": "https://ir.ozone.ru/s3/example.jpg",
      "imageUrls": ["https://ir.ozone.ru/s3/example.jpg"],
      "offers": [],
      "isActive": true,
      "sortOrder": 10,
      "badges": ["hit"],
      "updatedAt": "2026-06-30T10:00:00.000Z"
    }
  ],
  "pagination": {
    "limit": 100,
    "offset": 0,
    "total": 31
  }
}
```

### 2. Один товар

```http
GET /admin/storefront/products/:productId
```

`productId` - UUID из поля `id`, не `slug`.

Ответ:

```json
{
  "product": {
    "id": "7c169f01-b459-4e25-b74f-a4909a1b4149",
    "name": "Футболка-варёнка Сатору Годжо",
    "sizes": ["S", "M", "L", "XL"],
    "salePrice": 2900,
    "regularPrice": 4500,
    "imageUrls": ["https://ir.ozone.ru/s3/example.jpg"]
  }
}
```

Фактический объект такой же, как элемент в `products`.

### 3. Обновить товар

```http
PATCH /admin/storefront/products/:productId
Content-Type: application/json
Authorization: Bearer <ADMIN_API_TOKEN>
```

Отправлять можно только изменённые поля. Сервер сам сделает транзакцию, `FOR UPDATE`, нормализацию и вернёт свежий товар.

Payload:

| поле | тип | что меняет |
|---|---|---|
| `name` | string | название товара на сайте |
| `description` | string или `null` | полное описание |
| `shortDescription` | string или `null` | короткое описание для карточек/meta |
| `salePrice` | number | текущая цена покупки; пишет `price_min` и `price_max` |
| `regularPrice` | number или `null` | обычная/старая цена; пишет `compare_at_price`; `null` убирает зачёркнутую цену |
| `sizes` | string[] | полный итоговый список доступных размеров |
| `imageUrls` | string[] | полный итоговый порядок фото; первое фото становится главным |
| `mainImagePath` | string или `null` | thumbnail для каталога/checkout; если не передать вместе с `imageUrls`, станет первым фото |
| `isActive` | boolean | показать/скрыть товар на сайте |
| `sortOrder` | number | порядок сортировки |
| `syncOfferPrices` | boolean | default `true`; при `salePrice` обновляет цены внутри `offers` для JSON-LD |

Пример полного сохранения формы:

```json
{
  "name": "Футболка-варёнка Сатору Годжо",
  "description": "Новое описание товара",
  "shortDescription": "Короткое описание",
  "salePrice": 2900,
  "regularPrice": 4500,
  "sizes": ["S", "M", "L", "XL", "XXL"],
  "imageUrls": [
    "https://ir.ozone.ru/s3/photo-1.jpg",
    "https://ir.ozone.ru/s3/photo-2.jpg",
    "https://ir.ozone.ru/s3/photo-3.jpg"
  ]
}
```

Ответ:

```json
{
  "product": {
    "id": "7c169f01-b459-4e25-b74f-a4909a1b4149",
    "name": "Футболка-варёнка Сатору Годжо",
    "salePrice": 2900,
    "regularPrice": 4500,
    "sizes": ["S", "M", "L", "XL", "XXL"],
    "imageUrls": [
      "https://ir.ozone.ru/s3/photo-1.jpg",
      "https://ir.ozone.ru/s3/photo-2.jpg",
      "https://ir.ozone.ru/s3/photo-3.jpg"
    ],
    "primaryImageUrl": "https://ir.ozone.ru/s3/photo-1.jpg",
    "mainImagePath": "https://ir.ozone.ru/s3/photo-1.jpg"
  },
  "changedFields": [
    "description",
    "salePrice",
    "priceMax",
    "regularPrice",
    "sizes",
    "imageUrls",
    "primaryImageUrl",
    "mainImagePath",
    "offers"
  ]
}
```

## Важные правила для UI

1. Для редактора фото используй `imageUrls` как единственный источник порядка. При drag-and-drop отправляй весь итоговый массив, не только перемещённый элемент.
2. Первое фото в `imageUrls` автоматически становится `primaryImageUrl`.
3. `mainImagePath` влияет на картинку в каталоге и checkout. Если хочешь, чтобы первая фотка после сортировки стала главной везде, не передавай `mainImagePath`. Если хочешь сохранить старый thumbnail, передай старое значение `mainImagePath`.
4. `salePrice` - цена, по которой checkout создаёт заказ. Это не старая цена.
5. `regularPrice` - старая/обычная цена для зачёркивания. Она должна быть больше `salePrice` или `null`.
6. Чтобы убрать акцию, оставь `salePrice` как текущую цену и отправь `regularPrice: null`.
7. `sizes` отправляй как полный итоговый список. Сервер приведёт размеры к uppercase и уберёт дубли.
8. Удалённые из `sizes` размеры перестают проходить checkout. В `offers` такие размеры дополнительно помечаются `visible: false`.
9. После успешного PATCH замени локальное состояние формы объектом `product` из ответа.
10. Не редактируй `offers` напрямую из админки: это техническая связка с Ozon/SKU. Для сайта достаточно `sizes`, `salePrice`, `regularPrice`, `imageUrls`.

## Ошибки

Единый формат:

```json
{
  "error": {
    "code": "invalid_regular_price",
    "message": "regularPrice must be greater than salePrice or null"
  }
}
```

Основные коды:

| HTTP | code | причина |
|---|---|---|
| 401 | `unauthorized` | нет или неверный admin token |
| 503 | `admin_disabled` | на Komui backend не задан `ADMIN_API_TOKEN` |
| 400 | `bad_request` | невалидный JSON/payload |
| 400 | `empty_update` | PATCH без редактируемых полей |
| 400 | `invalid_regular_price` | `regularPrice <= salePrice` |
| 404 | `product_not_found` | товар не найден |
| 500 | `internal_error` | ошибка backend/DB |

## Пример клиента для BFF админки

```ts
const KOMUI_API_BASE_URL = process.env.KOMUI_API_BASE_URL!;
const KOMUI_ADMIN_TOKEN = process.env.KOMUI_ADMIN_TOKEN!;

async function komuiRequest(path: string, init: RequestInit = {}) {
  const res = await fetch(`${KOMUI_API_BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${KOMUI_ADMIN_TOKEN}`,
      ...init.headers,
    },
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.error?.message || `Komui API HTTP ${res.status}`);
  }
  return data;
}

export async function listKomuiProducts(params: {
  q?: string;
  active?: "all" | "active" | "inactive";
  limit?: number;
  offset?: number;
}) {
  const query = new URLSearchParams();
  if (params.q) query.set("q", params.q);
  if (params.active) query.set("active", params.active);
  query.set("limit", String(params.limit ?? 100));
  query.set("offset", String(params.offset ?? 0));
  return komuiRequest(`/admin/storefront/products?${query.toString()}`);
}

export async function updateKomuiProduct(productId: string, patch: {
  name?: string;
  description?: string | null;
  shortDescription?: string | null;
  salePrice?: number;
  regularPrice?: number | null;
  sizes?: string[];
  imageUrls?: string[];
  mainImagePath?: string | null;
}) {
  return komuiRequest(`/admin/storefront/products/${productId}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}
```

## Минимальный сценарий внедрения

1. В админке добавить экран "Товары сайта Komui".
2. На входе загрузить `GET /admin/storefront/products?active=all&limit=100`.
3. В таблице показывать фото `mainImagePath || primaryImageUrl || imageUrls[0]`, `name`, `salePrice`, `regularPrice`, `sizes`, `isActive`.
4. При открытии карточки загрузить `GET /admin/storefront/products/:id`.
5. В форме редактировать название, описание, цену, старую цену, размеры и порядок фото.
6. На save отправить `PATCH` только с изменёнными полями.
7. После save заменить форму ответом `product`, показать `changedFields`.
8. Не писать напрямую в Supabase из браузера и не светить admin token.
