# Ozon import API для внешней админки

Этот документ описывает работу с Ozon-товарами через отдельный Komui backend и server PostgreSQL. Supabase для этого сценария не нужен.

Base URL в production обычно:

```text
https://komui.ru/api
```

Локально на сервере backend слушает без `/api`:

```text
http://127.0.0.1:3000
```

Все `/admin/...` запросы требуют:

```http
Authorization: Bearer <ADMIN_API_TOKEN>
```

или:

```http
x-komui-admin-token: <ADMIN_API_TOKEN>
```

`ADMIN_API_TOKEN` нельзя класть в браузерный SPA. Внешняя админка должна ходить в Komui API через свой server-side backend/BFF.

## Главный принцип цен

У KOMUI цены на сайте и цены Ozon отличаются. Поэтому безопасный режим по умолчанию:

```json
{
  "updatePrices": false
}
```

В этом режиме API:

- не меняет `price_min` / `price_max` у товаров сайта;
- не меняет `offers.price`;
- сохраняет Ozon-цены в технические поля `offers[].ozon_price`, `offers[].ozon_old_price`, `offers[].ozon_min_price`;
- добавляет новые `offers`, новые `sizes`, SKU, offer_id и фото.
- подтягивает JSON таблицы размеров из Ozon `attribute_id = 13164`
  через `/v4/product/info/attributes` и сохраняет в
  `merch_storefront_products.size_chart_json`.

`updatePrices: true` использовать только если ты сознательно хочешь заменить цены сайта Ozon-ценами.

## Workflow

1. Сделать preview Ozon-синхронизации.
2. Показать в админке:
   - matched товары: обновление offer/SKU/фото/размеров;
   - unmatched offer-ы;
   - `newProductGroups` как кандидаты новых карточек.
3. Для старых товаров:
   - если offer сматчился автоматически, применить import по выбранным `itemIds` или `offerIds`;
   - если offer не сматчился, но это старый товар, привязать его вручную к `productId`.
4. Для новых дизайнов/товаров:
   - взять группу из `newProductGroups`;
   - пользователь заполняет поля карточки и цену сайта;
   - создать новую карточку через API.
5. Повторить preview и убедиться, что остались только ожидаемые skip/noop.

## 1. Preview

```http
POST /admin/ozon/products/import-preview
Content-Type: application/json
Authorization: Bearer <ADMIN_API_TOKEN>
```

Рекомендуемый payload:

```json
{
  "limit": 10000,
  "includeArchived": false,
  "updatePrices": false,
  "syncSizes": "add",
  "targets": {
    "serverPostgres": true,
    "supabase": false
  }
}
```

Ответ содержит:

```json
{
  "previewId": "uuid",
  "mode": {
    "updatePrices": false,
    "syncSizes": "add"
  },
  "summary": {
    "totalOzonItems": 155,
    "matchedStorefront": 128,
    "unmatched": 27,
    "newProductGroups": 4,
    "actionableServerPostgres": 128
  },
  "items": [],
  "newProductGroups": []
}
```

Важные поля `items[]`:

| поле | смысл |
|---|---|
| `itemId` | стабильный ID preview item, использовать для выбранного импорта |
| `offerId` | Ozon offer_id |
| `sku` | Ozon SKU |
| `productId` | Ozon product_id |
| `size` | размер, распарсенный из offer_id/name |
| `price` | Ozon-цена только для админки |
| `targetProduct` | товар сайта, если сматчился |
| `inferredProduct` | предполагаемый новый товар, если не сматчился |
| `plannedActions` | что API может применить |
| `diff.changedFields` | поля, которые изменятся |

Важные поля `newProductGroups[]`:

```json
{
  "designKey": "var21|print|tshirt|washed-grey",
  "slug": "var21-print-tshirt-washed-grey",
  "ozonVariant": "var21",
  "productType": "Футболка",
  "productTypeSlug": "tshirt",
  "category": "Футболки",
  "categorySlug": "tshirts",
  "decorationType": "Принт",
  "decorationSlug": "print",
  "colorName": "Вареный серый",
  "colorSlug": "washed-grey",
  "colorHex": "#9ca3af",
  "itemIds": ["..."],
  "offerIds": ["D21-TSH-PRT-WGRY-S"],
  "sizes": ["S", "M", "L", "XL", "XXL"],
  "suggestedName": "Вареная футболка с принтом Язык Сукуны",
  "primaryImageUrl": "https://ir.ozone.ru/...",
  "imageUrls": ["https://ir.ozone.ru/..."],
  "minOzonPrice": 5896,
  "maxOzonPrice": 6700
}
```

## 2. Применить сматчившиеся изменения

Использовать для offer-ов, у которых есть `targetProduct` и `plannedActions[].action !== "skip"`.

```http
POST /admin/ozon/products/import
Content-Type: application/json
Authorization: Bearer <ADMIN_API_TOKEN>
```

Payload:

```json
{
  "previewId": "uuid-from-preview",
  "confirm": true,
  "targets": {
    "serverPostgres": true,
    "supabase": false
  },
  "itemIds": ["preview-item-id-1", "preview-item-id-2"]
}
```

Можно вместо `itemIds` передать `offerIds`:

```json
{
  "previewId": "uuid-from-preview",
  "confirm": true,
  "targets": {
    "serverPostgres": true,
    "supabase": false
  },
  "offerIds": ["D8-TSH-PRT-WHT-XXL"]
}
```

Если `itemIds` и `offerIds` не переданы, применится весь importable preview. Для админки лучше всегда передавать выбранный список.

Что обновляется у старого товара:

- `ozon_product_ids`
- `ozon_skus`
- `ozon_offer_ids`
- `offers`
- `sizes`, если `syncSizes: "add"` был в preview
- `primary_image_url`
- `main_image_path`, только если раньше не было ручного override
- `image_urls`
- `size_chart_json`, если Ozon вернул таблицу размеров
- `updated_at`

При `updatePrices:false` не меняются:

- `price_min`
- `price_max`
- `offers.price`

## 3. Привязать unmatched offer к существующему товару

Использовать, когда Ozon offer не сматчился автоматически, но в админке пользователь выбрал существующую карточку сайта.

```http
POST /admin/ozon/products/link-storefront-offers
Content-Type: application/json
Authorization: Bearer <ADMIN_API_TOKEN>
```

Payload:

```json
{
  "previewId": "uuid-from-preview",
  "productId": "existing-storefront-product-uuid",
  "offerIds": [
    "D2-TSH-EMB-WHT-L",
    "D2-TSH-EMB-WHT-XL",
    "D2-TSH-EMB-WHT-XXL"
  ],
  "updatePrices": false,
  "syncSizes": "add"
}
```

Ответ:

```json
{
  "productId": "existing-storefront-product-uuid",
  "linkedOzon": {
    "itemIds": ["..."],
    "offerIds": ["D2-TSH-EMB-WHT-L"],
    "skus": ["4920920069"],
    "productIds": ["5313430842"]
  },
  "updatePrices": false,
  "syncSizes": "add",
  "applied": 3,
  "syncedAt": "2026-07-02T..."
}
```

Этот endpoint нужен для исторических несовпадений `design_key`, например когда Ozon `D2-TSH-EMB-WHT-*` должен привязаться к существующему `var13-embroidery-tshirt-white`.

## 4. Создать новый товар из Ozon group

Использовать для новых дизайнов/товаров из `newProductGroups`.

```http
POST /admin/ozon/products/storefront-products
Content-Type: application/json
Authorization: Bearer <ADMIN_API_TOKEN>
```

Минимальный payload:

```json
{
  "previewId": "uuid-from-preview",
  "offerItemIds": ["item-id-s", "item-id-m", "item-id-l"],
  "product": {
    "name": "Футболка-варёнка Язык Сукуны",
    "slug": "var21-print-tshirt-washed-grey",
    "designKey": "var21|print|tshirt|washed-grey",
    "salePrice": 2900,
    "regularPrice": 4500,
    "shortDescription": "Короткое описание для карточки и meta.",
    "description": "Полное описание товара.",
    "titleName": "Jujutsu Kaisen",
    "titleSlug": "jujutsu-kaisen",
    "animeTitle": "Jujutsu Kaisen",
    "animeSlug": "jujutsu-kaisen",
    "characterName": "Ryomen Sukuna",
    "characterSlug": "ryomen-sukuna",
    "collectionName": "Sukuna",
    "collectionSlug": "sukuna",
    "designName": "Sukuna Tongue",
    "designSlug": "sukuna-tongue",
    "tags": ["anime", "jujutsu-kaisen", "sukuna", "print", "tshirt", "washed-grey"],
    "badges": ["new"],
    "isActive": true,
    "sortOrder": 50
  }
}
```

Можно не передавать эти поля, если подходят значения из `newProductGroups`:

- `ozonVariant`
- `category`
- `categorySlug`
- `productType`
- `productTypeSlug`
- `decorationType`
- `decorationSlug`
- `colorName`
- `colorSlug`
- `colorHex`
- `sizes`
- `imageUrls`

Но админке лучше показывать их пользователю перед сохранением.

Что делает endpoint:

- создаёт строку в `public.merch_storefront_products`;
- ставит `price_min = salePrice`, `price_max = salePrice`;
- ставит `compare_at_price = regularPrice`;
- заполняет `sizes`, `image_urls`, `primary_image_url`;
- заполняет `size_chart_json`, если выбранные Ozon offer-ы содержат таблицу размеров;
- связывает выбранные Ozon SKU в `offers`, `ozon_skus`, `ozon_product_ids`, `ozon_offer_ids`;
- записывает `offers[].price = salePrice`;
- Ozon-цены сохраняет отдельно в `offers[].ozon_price`.

Ответ:

```json
{
  "product": {
    "id": "new-product-uuid",
    "designKey": "var21|print|tshirt|washed-grey",
    "slug": "var21-print-tshirt-washed-grey",
    "name": "Футболка-варёнка Язык Сукуны",
    "sizes": ["S", "M", "L"],
    "salePrice": 2900,
    "primaryImageUrl": "https://ir.ozone.ru/...",
    "isActive": true
  },
  "linkedOzon": {
    "itemIds": ["..."],
    "offerIds": ["D21-TSH-PRT-WGRY-S"],
    "skus": ["4895614235"],
    "productIds": ["5284182591"]
  }
}
```

## Ошибки

Формат:

```json
{
  "error": {
    "code": "invalid_regular_price",
    "message": "regularPrice must be greater than salePrice or null"
  }
}
```

Частые коды:

| code | когда |
|---|---|
| `unauthorized` | нет/неверный admin token |
| `ozon_not_configured` | backend не видит Ozon credentials |
| `preview_not_found` | неверный `previewId` |
| `empty_import_selection` | `itemIds`/`offerIds` не нашли items |
| `empty_offer_selection` | нечего привязывать/создавать |
| `mixed_product_selection` | в create product выбраны offer-ы разных дизайнов |
| `missing_product_field` | не хватает обязательного поля, которое нельзя вывести из Ozon |
| `missing_sizes` | у создаваемого товара нет размеров |
| `missing_images` | у создаваемого товара нет фото |
| `invalid_regular_price` | `regularPrice <= salePrice` |

## Рекомендации для UI админки

Показывай preview в трёх секциях:

1. **Автоматически сопоставлено**: `items` с `targetProduct`.
   Дай чекбоксы и кнопку “Применить выбранные”.
2. **Нужно привязать к существующему товару**: `items` без `targetProduct`, но пользователь может выбрать product из `/admin/storefront/products`.
   Кнопка вызывает `/admin/ozon/products/link-storefront-offers`.
3. **Новые товары**: `newProductGroups`.
   Открывай форму создания карточки, предзаполненную group-полями, но требуй человеческое название, цену сайта, описание, коллекцию/персонажа/теги.

Не скрывай `diff.changedFields`: по нему удобно подсветить, что поменяется.

Для всех штатных импортов передавай:

```json
{
  "updatePrices": false,
  "syncSizes": "add"
}
```

`syncSizes: "add"` только добавляет новые размеры. Удаление размеров с сайта должно оставаться отдельным ручным действием редактора товара.
