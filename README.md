# KOMUI Storefront

Статическая витрина аниме-мерча KOMUI: футболки, худи и свитшоты с принтами и вышивкой. Проект собран как один самодостаточный HTML-файл с локальными данными и изображениями. Сборка, Node.js и backend для запуска витрины не требуются.

## Что внутри

- Главная промо-секция с анимацией, промокодом и динамическими товарами.
- Каталог с фильтрами по категории, коллекции, типу нанесения, размеру, цвету и цене.
- Поиск и сортировка товаров.
- Карточки товаров с галереей изображений.
- Быстрый просмотр товара.
- Демо-корзина без реальной оплаты.
- Подключение к Supabase Storefront API, если конфиг доступен.
- Локальный fallback-каталог, если Supabase недоступен.

## Технологии

Проект написан на чистом frontend-стеке:

- HTML5;
- CSS3 внутри `index.html`;
- vanilla JavaScript внутри `index.html`;
- локальные JSON/JS-файлы с данными;
- локальные JPG-изображения;
- Supabase REST API как внешний источник каталога;
- Google Fonts: `Unbounded`, `Inter`, `Noto Sans JP`.

В проекте нет React, Next.js, npm-скриптов, сборщика и серверной части.

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
│   ├── supabase-config.js
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
└── README.md
```

### `index.html`

Главный файл витрины. В нём находятся:

- HTML-разметка всех секций;
- все стили сайта;
- вся браузерная логика;
- подключение данных из `data/storefront-products.js`;
- подключение Supabase-конфига из `data/supabase-config.js`.

Ключевые части логики:

- `loadStorefrontProducts()` сначала загружает локальные товары из `window.KOMUI_PRODUCTS`, затем пробует заменить их данными из Supabase.
- `setProducts()` нормализует товары и пересчитывает списки фильтров.
- `renderGrid()` строит карточки каталога.
- `openModal()` открывает быстрый просмотр.
- `addToCart()` и `updateCart()` управляют корзиной.
- `initHeroProducts()` и canvas-логика отвечают за анимации главного экрана.

### `assets/`

Изображения товаров.

- `assets/ozon-main/` - 24 основные картинки, которые использует локальный fallback-каталог.

Пути к изображениям в данных должны быть относительными от корня проекта, например:

```text
./assets/ozon-main/01-футболка-с-принтом-сатору-годжо.jpg
```

### `data/storefront-products.js`

Локальный fallback для витрины. Файл объявляет:

```js
window.KOMUI_STORE_STATS = { ... };
window.KOMUI_PRODUCTS = [ ... ];
```

Эти данные используются, если Supabase недоступен или не настроен. Сейчас fallback содержит меньше карточек, чем live-выгрузка Supabase, поэтому при обновлении каталога важно синхронизировать оба источника.

### `data/supabase-config.js`

Публичная конфигурация Supabase:

```js
window.KOMUI_SUPABASE = {
  url: "...",
  anonKey: "..."
};
```

Витрина делает GET-запрос к:

```text
/rest/v1/merch_storefront_products?select=*&order=sort_order.asc
```

Важно: в этом файле должен быть только публичный publishable/anon key. Секретные service role ключи сюда добавлять нельзя.

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
3. Загружается `data/supabase-config.js`.
4. Скрипт витрины вызывает `loadStorefrontProducts()`.
5. Сначала отображается локальный fallback из `window.KOMUI_PRODUCTS`.
6. Если Supabase настроен и отвечает, товары заменяются live-данными из `merch_storefront_products`.
7. После загрузки данных строятся фильтры, карточки каталога, бегущая строка коллекций, hero-статистика и корзина.

Если Supabase недоступен, сайт остаётся рабочим на локальном fallback-каталоге.

## Как обновлять товары

Есть два источника, которые желательно держать синхронными:

1. Supabase `merch_storefront_products` - основной live-источник.
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

Проект можно деплоить как обычную статическую папку.

Подходящие варианты:

- GitHub Pages;
- Netlify;
- Vercel static project;
- любой nginx/apache/static hosting.

Для GitHub Pages обычно достаточно выбрать ветку `main` и корень репозитория как source.

## Важные нюансы

- Корзина живёт только в памяти страницы. После перезагрузки она очищается.
- Email-форма в футере не отправляет данные на backend.
- Supabase anon key публичен, поэтому доступная таблица/view должна быть read-only и не должна отдавать приватные поля.
- Тексты из Supabase вставляются в DOM через HTML-шаблоны. Если источник данных станет пользовательским, нужно добавить escaping/sanitization.
- `.env.local`, `.DS_Store`, `.git/`, `.claude/` и другие локальные файлы не должны попадать в репозиторий.
- Файл `data/supabase-config.js` допустим только для публичных ключей. Секреты туда не добавлять.

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
- изображения не отдают 404;
- Supabase-запрос либо отвечает 200, либо сайт корректно остаётся на fallback-данных.
