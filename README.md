# KOMUI Storefront

Статическая витрина и self-hosted backend аниме-мерча KOMUI: футболки, худи и
свитшоты с принтами и вышивкой. Production работает на собственном сервере:
nginx отдаёт HTML/static, Fastify backend отдаёт API, PostgreSQL хранит каталог,
заказы, платежи, CDEK и admin/Ozon import данные.

## Что внутри

- Главная промо-секция с анимацией, промокодом и динамическими товарами.
- Каталог с фильтрами по категории, коллекции, типу нанесения, размеру, цвету и цене.
- Поиск и сортировка товаров.
- Карточки товаров с галереей изображений.
- Быстрый просмотр товара.
- Корзина, checkout, T-Bank payment flow и CDEK delivery flow через KOMUI API.
- Подключение к KOMUI API, если конфиг доступен.
- Локальный fallback-каталог, если API недоступен.
- SEO product pages, collection pages, sitemap, robots и LLM-файлы.
- Локальный media-cache для товарных фото вместо hotlink на Ozon CDN.

## Технологии

Frontend написан на чистом стеке:

- HTML5;
- CSS3;
- vanilla JavaScript;
- локальные JSON/JS-файлы с данными;
- WebP-изображения из локального media-cache;
- KOMUI backend API как внешний источник каталога;
- Google Fonts: `Unbounded`, `Inter`, `Noto Sans JP`.

Backend:

- Node.js 22;
- Fastify;
- PostgreSQL;
- TypeScript;
- systemd/nginx deploy на сервере.

Root `package.json` используется для build scripts, включая media sync через
`sharp`. Backend-зависимости лежат отдельно в `server/package.json`.

## Структура проекта

```text
.
├── index.html
├── assets/
│   ├── ozon-main/
│   ├── ozon/
│   └── ozon-candidates/
├── data/
│   ├── storefront-products.js
│   ├── api-config.js
│   ├── storefront-products.json
│   ├── supabase-storefront-products.json
│   ├── supabase-storefront-products.compact.json
│   ├── ozon-products.raw.json
│   ├── ozon-products.enriched.json
│   ├── ozon-products.cards.json
│   └── main-image-selection.json
├── sku-mapping.csv
├── sku-mapping.md
├── sku-template-guide.md
├── scripts/
│   ├── build-products.js
│   └── sync-product-media.js
├── server/
│   ├── src/
│   └── test/
├── ops/server/
└── README.md
```

### `index.html`

Главный файл витрины. В нём находятся:

- HTML-разметка всех секций;
- все стили сайта;
- вся браузерная логика;
- подключение данных из `data/storefront-products.js`;
- подключение API-конфига из `data/api-config.js`.

Ключевые части логики:

- `loadStorefrontProducts()` сначала загружает локальные товары из `window.KOMUI_PRODUCTS`, затем пробует заменить их данными из Supabase.
- `setProducts()` нормализует товары и пересчитывает списки фильтров.
- `renderGrid()` строит карточки каталога.
- `openModal()` открывает быстрый просмотр.
- `addToCart()` и `updateCart()` управляют корзиной.
- `initHeroProducts()` и canvas-логика отвечают за анимации главного экрана.

### `scripts/sync-product-media.js`

Синхронизирует товарные изображения из `https://ir.ozone.ru` в локальный
media-cache:

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

Публичный URL:

```text
/media/products/<hash-prefix>/<hash>/800.webp
```

Локально cache лежит в `.komui/media-cache` и не попадает в git.

Основные команды:

```bash
node scripts/sync-product-media.js --dry-run
node scripts/sync-product-media.js
KOMUI_API_BASE_URL=http://127.0.0.1:3001 node scripts/sync-product-media.js
```

### `scripts/build-products.js`

Генерирует:

- `p/*.html`;
- `collections/*.html`;
- `sitemap.xml`;
- `robots.txt`;
- `llms-full.txt`;
- `data/storefront-products.js`;
- `nginx-product-redirects.conf`.

При наличии media manifest заменяет Ozon image URLs на `/media/products/...`,
добавляет `srcset`, `sizes`, `width`, `height`, `fetchpriority` для hero image и
пишет Product JSON-LD/meta images уже с `https://komui.ru/media/products/...`.

Production build должен запускаться в strict mode:

```bash
KOMUI_MEDIA_MANIFEST_PATH=/var/lib/komui/media-cache/manifest.json \
KOMUI_MEDIA_STRICT=1 \
KOMUI_API_BASE_URL=http://127.0.0.1:3001 \
node scripts/build-products.js
```

### `assets/`

Статические изображения сайта и исторические локальные картинки.

Актуальные товарные фото production не хранятся в git. Они живут на сервере в
`/var/lib/komui/media-cache` и отдаются nginx по `/media/products/...`.

### `data/storefront-products.js`

Локальный fallback для витрины. Файл объявляет:

```js
window.KOMUI_STORE_STATS = { ... };
window.KOMUI_PRODUCTS = [ ... ];
```

Эти данные используются, если KOMUI API недоступен или не настроен. Файл
генерируется `scripts/build-products.js`. После media migration в нём должны
быть только `/media/products/...`, а не `https://ir.ozone.ru/...`.

### `data/api-config.js`

Публичная конфигурация frontend API без секретов:

```js
window.KOMUI_API = {
  baseUrl: "/api",
  productsUrl: "/api/v1/products?limit=200"
};
```

Витрина делает GET-запрос к:

```text
/api/v1/products?limit=200
```

Важно: в этом файле не должно быть Supabase service role, T-Bank, CDEK, Ozon или других секретов.

### Остальные файлы `data/`

- `ozon-products.raw.json` - сырая выгрузка SKU из Ozon.
- `ozon-products.enriched.json` - расширенная подготовленная выгрузка.
- `ozon-products.cards.json` - сгруппированные карточки товаров.
- `storefront-products.json` - подготовленная storefront-структура для локального использования.
- `supabase-storefront-products.json` - данные в формате, близком к Supabase view/table.
- `supabase-storefront-products.compact.json` - компактная версия Supabase-данных.
- `main-image-selection.json` - выбор основных изображений для карточек.

Эти файлы нужны для аудита, ручной проверки и регенерации витрины.

### SKU-документы

- `sku-template-guide.md` - правила составления новых артикулов KOMUI.
- `sku-mapping.csv` - таблица перехода от старых Ozon offer_id к новым артикулам.
- `sku-mapping.md` - человекочитаемая версия таблицы перехода.

Новый шаблон артикулов:

- футболки и свитшоты: `DESIGN-GARMENT-DECOR-COLOR-VERSION-SIZE`;
- худи: `DESIGN-HDY-DECOR-COLOR-FIT-FABRIC-VERSION-SIZE`.

## Как запустить локально

Самый надёжный вариант - поднять простой статический сервер из корня проекта:

```bash
python3 -m http.server 8080
```

После этого открыть:

```text
http://localhost:8080
```

Можно открыть `index.html` напрямую в браузере, но локальный сервер ближе к реальному деплою и лучше подходит для проверки относительных путей, сетевых запросов и браузерных API.

## Как работает загрузка каталога

1. Браузер открывает `index.html`.
2. Загружается `data/storefront-products.js`.
3. Загружается `data/api-config.js`.
4. Скрипт витрины вызывает `loadStorefrontProducts()`.
5. Сначала отображается локальный fallback из `window.KOMUI_PRODUCTS`.
6. Если KOMUI API настроен и отвечает, товары заменяются live-данными из backend.
7. После загрузки данных строятся фильтры, карточки каталога, бегущая строка коллекций, hero-статистика и корзина.

Если API недоступен, сайт остаётся рабочим на локальном fallback-каталоге.

## Как обновлять товары

Есть два источника, которые желательно держать синхронными:

1. KOMUI API / PostgreSQL `merch_storefront_products` - основной live-источник.
2. `data/storefront-products.js` - локальный fallback.

При добавлении товара проверь:

- заполнены `name`, `category`, `decoration_type`, `color_name`, `price_min` или `price_max`;
- есть хотя бы один размер в `sizes`;
- есть `main_image_path` или изображение в `image_urls`;
- путь к локальной картинке реально существует;
- товар корректно попадает в фильтры;
- quick view открывается без ошибок;
- товар добавляется в корзину с нормальным размером.

## Деплой

Production/stage deploy выполняется на сервере скриптом:

```bash
sudo /usr/local/sbin/komui-deploy-from-git stage main
sudo /usr/local/sbin/komui-deploy-from-git prod main
```

Скрипт:

1. подтягивает `origin/main`;
2. ставит root build dependencies;
3. ставит backend dependencies;
4. гоняет backend tests;
5. собирает backend;
6. запускает `scripts/sync-product-media.js`;
7. собирает static frontend в `KOMUI_MEDIA_STRICT=1`;
8. проверяет, что публичные артефакты не содержат `ir.ozone.ru`;
9. создаёт immutable backend/frontend releases;
10. переключает symlink;
11. перезапускает backend/nginx;
12. проверяет public API и отсутствие `ir.ozone.ru` в catalog API.

## Важные нюансы

- Корзина живёт только в памяти страницы. После перезагрузки она очищается.
- Email-форма в футере не отправляет данные на backend.
- Frontend не должен содержать приватные ключи backend-интеграций и базы данных.
- Public HTML, JSON-LD, meta images, `data/storefront-products.js` и
  `/api/v1/products` не должны отдавать `ir.ozone.ru`.
- PostgreSQL может хранить исходные Ozon URLs как source-of-truth. Публичный
  слой мапит их через media manifest.
- Тексты из API вставляются в DOM через HTML-шаблоны. Если источник данных станет пользовательским, нужно добавить escaping/sanitization.
- `.env.local`, `.DS_Store`, `.git/`, `.claude/` и другие локальные файлы не должны попадать в репозиторий.
- Файл `data/api-config.js` допустим только для публичных URL/путей. Секреты туда не добавлять.

## Текущие замечания к данным

На момент подготовки README есть несколько известных несостыковок, которые стоит учитывать при дальнейшей чистке каталога:

- live Supabase отдаёт 29 карточек, локальный fallback `storefront-products.js` содержит 24 карточки;
- в `sku-mapping.csv` 109 строк данных, а в `ozon-products.raw.json` 110 SKU;
- в маппинге отсутствует старый offer_id `var6` для товара "Футболка с принтом гор, Дагестан";
- в live Supabase у карточек `var4|embroidery|tshirt|other` и `var7|print|tshirt|other` нет размеров, из-за чего их нужно дозаполнить перед полноценными продажами.

## Быстрая проверка перед публикацией

```bash
python3 -m http.server 8080
```

Потом в браузере проверить:

- главная страница открывается без ошибок в консоли;
- каталог показывает товары;
- фильтры не ломают сетку;
- поиск работает;
- quick view открывается;
- галерея листается;
- товар добавляется в корзину;
- изображения `/media/products/...` не отдают 404;
- `/api/v1/products?limit=100` не содержит `ir.ozone.ru`;
- `index.html`, `p/`, `collections/`, `data/` не содержат `ir.ozone.ru`;
- KOMUI API либо отвечает 200, либо сайт корректно остаётся на fallback-данных.
