# Контекст: товарный фид KOMUI для Яндекс Директа

Дата исследования: 2026-08-20.

## 1. Архитектура проекта

- Frontend статический: HTML/CSS/vanilla JS, product pages в `p/*.html`.
- Backend: Node.js 22, Fastify, TypeScript.
- Основной каталог: PostgreSQL, таблица `public.merch_storefront_products`.
- Публичный каталог: `GET /api/v1/products?limit=200`.
- Frontend сначала использует статический fallback `data/storefront-products.js`, затем заменяет его live-данными API.
- Товарные страницы, страницы коллекций, sitemap, robots и fallback-каталог генерируются `scripts/build-products.js`.
- Товарные изображения хранятся на сервере в `/var/lib/komui/media-cache` и публикуются как `/media/products/...`.
- Production-деплой создаёт immutable backend/frontend releases, переключает symlink и проверяет API/media.

Основные файлы:

- `server/src/catalog.ts` — публичная модель и запросы каталога;
- `server/src/app.ts` — публичные Fastify routes;
- `scripts/build-products.js` — генерация SEO/static артефактов;
- `ops/server/komui-traffic-switch-apply.sh` — источник runtime nginx snippet;
- `ops/server/komui-healthcheck.sh` — периодический мониторинг;
- `assets/metrika.js`, `index.html`, `checkout.html` — e-commerce Метрика.

## 2. Production

- Сервер: `89.111.152.112`, SSH-пользователь `codex-migrate`.
- Hostname: `cv6065797.novalocal`.
- Production backend `komui-production-backend` активен на `127.0.0.1:3001`.
- Текущий production release: `20260820T113807Z-prod-3e1a95f159c5`.
- Frontend root: `/var/lib/komui/production-root` -> immutable release.
- nginx публикует `/api/` через backend и `/media/products/` через media-cache.
- Публичного XML/YML/feed-файла сейчас нет.
- `robots.txt` содержит `Disallow: /api/`, поэтому ссылка на рекламный feed под `/api/` нежелательна.

## 3. Аудит каталога

- 35 строк в таблице: 33 active, 2 inactive.
- Публичный API: 33 активных товара.
- Категории: 27 футболок, 5 худи, 1 свитшот.
- Цена: 2 900–3 900 RUB; у всех карточек одна цена, не диапазон.
- У всех 33 есть slug, name, description, category, цена, изображения и размеры.
- У всех 33 задан `compare_at_price`, и он выше текущей цены.
- 154 активных SKU/offer; нет archived/hidden SKU среди активных товаров.
- Все 33 страницы `https://komui.ru/p/<slug>` отвечают HTTP 200.
- API отдаёт 204 относительные media URL; внешних Ozon URL в public API нет.
- Основные `/800.webp` обычно имеют 800x1066/1067 и проходят требования Директа.
- Одно дополнительное изображение имеет 750x437 и не проходит минимум 450 px по каждой стороне:
  `/media/products/35/3562a4cfe824cdba/1200.webp`.

## 4. Доступность и остатки

Отдельной модели складского остатка нет. В публичном каталоге есть:

- product `is_active`;
- product `sizes`;
- offer `archived` и `visible`;
- но нет `stock_quantity`/`in_stock`.

Checkout считает товар доступным, если product активен и выбранный размер присутствует в `sizes`; он не проверяет числовой остаток. Для первой версии зафиксировано простое правило наличия:

- если товар отображается в публичном каталоге сайта (`is_active = true`), передавать `<offer available="true">`;
- не вычислять наличие по `archived`, `visible` или отсутствующему числовому остатку;
- неактивные товары, которые не отображаются на сайте, в feed не включать;
- товар без положительной цены, валидной страницы или подходящего изображения считать ошибкой данных и не публиковать до исправления.

Настоящее управление `available` по складу потребует отдельной inventory-модели и синхронизации сайта, checkout и feed.

## 5. Идентификаторы Метрики

E-commerce события Метрики передают в `product.id` UUID строки `merch_storefront_products`, а размер передают как `variant`. Яндекс требует совпадения e-commerce product ID и YML `offer id` для офферного ретаргетинга.

Следствие: создавать один YML offer на одну товарную страницу и использовать UUID product как `offer id`. Размеры передавать повторяющимися `<param name="Размер" unit="INT">...</param>`. Не создавать 154 отдельных рекламных offer с SKU в качестве ID: это разойдётся с текущей аналитикой Метрики.

## 6. Актуальные требования Яндекс Директа

Рекомендуемый формат для одежды — YML (Yandex Market Language), UTF-8.

Ключевые требования:

- один корневой `<yml_catalog date="YYYY-MM-DD hh:mm">`;
- `<currencies>` и `<categories>` располагаются перед `<offers>`;
- уникальный `offer id`, до 100 символов;
- для упрощённого offer обязателен `<name>`;
- обязательны `<categoryId>` и абсолютный `<url>`;
- `price` должен быть положительным и совпадать с сайтом;
- при `price` обязателен `currencyId`;
- `oldprice` должен быть выше `price`, обе цены должны быть видны на сайте;
- изображения: абсолютный HTTP/HTTPS URL, минимум 450 px по каждой стороне, JPG/PNG/WebP/GIF, максимум 10 MB; рекомендуется до пяти изображений;
- сведения о `available` должны совпадать со страницей товара и checkout;
- размеры одежды передаются как `param` с единицей размерной сетки (`INT`, `RU`, `EU`, `US`);
- XML-символы нужно экранировать, непечатаемые управляющие символы исключать;
- feed по URL может быть до 512 MB, должен быть доступен по HTTP/HTTPS;
- Директ скачивает URL-feed один раз в сутки и автоматически импортирует обновления;
- при расхождении цены/наличия с сайтом offers или весь feed могут быть заблокированы.

Официальные источники:

- https://yandex.ru/support/direct/ru/feeds/types
- https://yandex.ru/support/direct/ru/feeds/requirements-yml
- https://yandex.ru/support/direct/ru/feeds/add
- https://yandex.ru/support/direct/ru/product-campaign/create

## 7. Рекомендуемая схема

Публичный URL:

`https://komui.ru/feeds/yandex-direct.yml`

Схема запроса:

1. Яндекс делает GET на публичный URL.
2. Exact nginx location проксирует запрос на `127.0.0.1:3001/v1/feeds/yandex-direct.yml`.
3. Backend читает актуальные active products напрямую из production PostgreSQL.
4. Pure generator формирует валидный UTF-8 YML и отдаёт `application/xml; charset=utf-8`.

Это лучше недельного cron в данном проекте: данные формируются при каждом скачивании, а сам Яндекс забирает URL раз в сутки. Нет второго файла, который может отстать от БД, и не нарушается immutable frontend release.

## 8. Предлагаемое соответствие полей

| YML | Источник KOMUI / правило |
|---|---|
| `offer@id` | UUID `product.id`; стабилен и совпадает с Метрикой |
| `offer@available` | всегда `true` для товара, отображаемого в публичном каталоге сайта |
| `name` | `product.name`, совпадает с H1 страницы |
| `url` | `https://komui.ru/p/${slug}` |
| `price` | `price_min`, только положительное значение |
| `oldprice` | `compare_at_price`, только если выше price и показан на странице |
| `currencyId` | `RUB` |
| `categoryId` | стабильная числовая карта категорий |
| `picture` | до пяти абсолютных `https://komui.ru/media/...`, прошедших size/type/HTTP checks |
| `description` | фактологический шаблон из product type, color, decoration, title и sizes; не брать рекламный short copy без очистки |
| `vendor` | `KOMUI` |
| `typePrefix` | `product_type` |
| `param Цвет` | `color_name` |
| `param Размер` | каждый доступный размер, `unit="INT"` |
| `param Тип нанесения` | `decoration_type` |
| `collectionId` | стабильный id title collection, если существует landing page |
| `store` | `false` |
| `pickup` | `true` для действующего CDEК ПВЗ checkout |
| `delivery` | не заявлять courier delivery до подтверждения в checkout |

Категории следует закрепить константами, например `1 = Одежда`, `101 = Футболки`, `102 = Худи`, `103 = Свитшоты`. Collections — четыре существующие страницы: Naruto, Jujutsu Kaisen, Gravity, Grand Theft Auto.

## 9. Риски

1. Нет складских остатков: по принятому правилу любой товар на сайте рекламируется как имеющийся в наличии; feed не сможет выключить только закончившийся размер без внедрения inventory.
2. Один gallery image ниже 450 px: его нужно пропускать автоматически.
3. API limit 200 нельзя использовать как скрытый предел feed: нужен отдельный запрос без молчаливого обрезания.
4. `short_description` местами содержит рекламные формулировки; безопаснее генерировать нейтральное фактическое описание.
5. `/api/` закрыт в robots, поэтому public feed нужен вне этого префикса.
6. Названия франшиз/персонажей могут отдельно попасть на рекламную модерацию; технически валидный feed не гарантирует одобрение всех креативов.
