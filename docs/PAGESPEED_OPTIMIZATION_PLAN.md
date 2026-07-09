# PageSpeed optimization plan

Дата анализа: 2026-07-09  
Целевая страница: `https://komui.ru/`  
Источник анализа: сохранённый отчёт PageSpeed Insights `PageSpeed Insights.html`, mobile profile.

## 1. Текущее состояние

PageSpeed mobile показывает:

| Категория | Оценка |
|---|---:|
| Performance | 51 |
| Accessibility | 67 |
| Best Practices | 100 |
| SEO | 100 |

Core/lab metrics:

| Метрика | Значение | Комментарий |
|---|---:|---|
| First Contentful Paint | 6.2 s | медленно |
| Largest Contentful Paint | 8.9 s | медленно |
| Total Blocking Time | 0 ms | хорошо |
| Cumulative Layout Shift | 0.185 | нужно улучшать |
| Speed Index | 6.2 s | медленно |
| TTFB | 50 ms | хорошо, backend не является главной проблемой |

В Chrome UX Report недостаточно данных о реальной скорости загрузки страницы. Значит отчёт сейчас нужно трактовать как lab-диагностику Lighthouse, а не как статистику реальных пользователей.

Основной вывод: сервер отвечает быстро, просадка идёт от фронта — тяжёлые изображения, блокирующий товарный JS, Google Fonts и layout shift в hero-блоке.

## 2. Главные проблемы из отчёта

### 2.1. Render-blocking requests

PageSpeed оценивает потенциальную экономию примерно в `5 300 ms`.

Блокирующие ресурсы:

```text
/data/storefront-products.js — 355.7 KiB, ~5 400 ms
/data/api-config.js — 0.7 KiB, ~450 ms
Google Fonts CSS — 60.9 KiB, ~1 370 ms
```

Ключевая проблема — `/data/storefront-products.js`. На главной уже есть prerender первых карточек каталога, поэтому полный товарный JS не должен блокировать первый экран.

### 2.2. Cache lifetime

PageSpeed оценивает потенциальную экономию примерно в `4 071 KiB`.

У части ресурсов нет эффективного кэширования:

```text
/assets/ozon-main/*.jpg
/data/storefront-products.js
/data/api-config.js
/assets/collection-logos/*
/favicon.svg
```

При этом `/media/products/.../*.webp` уже имеет нормальные cache headers. Значит проблема не во всём сервере, а в отдельных location/типах статики.

### 2.3. Image delivery

PageSpeed оценивает потенциальную экономию примерно в `7 172 KiB`.

На главной используются старые тяжёлые изображения:

```text
/assets/ozon-main/*.jpg
```

Примеры:

```text
22-футболка-варенка-с-принтом-gravity-серая.jpg — ~508 KiB
05-футболка-наруто-с-вышивкой-itachi.jpg — ~255 KiB
07-футболка-с-принтом-сатору-годжо.jpg — ~226 KiB
20-футболка-наруто-с-вышивкой-akatsuki.jpg — ~222 KiB
```

Эти изображения имеют физический размер около `2048x2730`, `2639x3518`, `2700x3600`, но отображаются в контейнере примерно `320x427`. Нужно отдавать изображения, близкие к реальному размеру отображения.

### 2.4. LCP image

LCP-элемент:

```html
<img class="is-active" alt="" draggable="false" src="./assets/ozon-main/07-футболка-с-принтом-сатору-годжо.jpg">
```

Проблемы:

- используется старый JPG;
- нет `fetchpriority="high"`;
- нет явного preload;
- ресурс не оптимизирован под фактический размер контейнера;
- hero-картинка участвует в layout shift.

### 2.5. CLS

CLS: `0.185`.

Основной виновник:

```text
body > section#home > div.hero-product-stage > div.hero-orbit
```

Причина: hero-блок/орбита меняют геометрию во время загрузки или после инициализации. Нужно стабилизировать размеры и использовать только transform/opacity-анимации.

### 2.6. Общий payload

Общий размер загрузки: примерно `9 604 KiB`.

Самые тяжёлые группы:

- изображения;
- `/data/storefront-products.js`;
- `/api/v1/products?limit=200`;
- Google Fonts.

На странице одновременно присутствуют:

```text
/data/storefront-products.js
/api/v1/products?limit=200
```

Это похоже на дублирование источников данных. Нужно определить основной источник для первого рендера и fallback.

### 2.7. DOM size

DOM содержит примерно `2 171` элемента.

Это не главный bottleneck, но после оптимизации изображений/JS стоит уменьшить начальный DOM:

- не вставлять все изображения галерей сразу;
- не отрисовывать весь каталог до первого interaction/load;
- оставлять в HTML только критичный prerender.

### 2.8. Google Fonts

Google Fonts даёт около `446 KiB` стороннего трафика, а CSS Google Fonts в отчёте помечен как блокирующий и почти полностью неиспользуемый на первом экране.

Сейчас подключается много начертаний:

```text
Unbounded 400/600/800/900
Inter 400/500/600/700/800
Noto Sans JP 400/700
```

Нужно сократить набор весов и желательно перейти на self-hosted fonts.

## 3. Цели оптимизации

Не теряем:

- текущую визуальную стилистику;
- hero-композицию;
- карточки товаров;
- качество товарных изображений;
- SEO-разметку и prerender.

Улучшаем:

- LCP;
- FCP;
- CLS;
- размер первичной загрузки;
- cache lifetime;
- повторные заходы;
- мобильный PageSpeed.

Ориентиры после первого этапа:

| Метрика | Сейчас | Цель после базовой оптимизации |
|---|---:|---:|
| Performance | 51 | 70+ |
| FCP | 6.2 s | 2.5–4.0 s |
| LCP | 8.9 s | 3.0–5.0 s |
| CLS | 0.185 | < 0.1 |
| Total payload | ~9.6 MB | 2–4 MB |

Финальная цель после полной оптимизации: Performance `80+`, если дизайн и объём контента сохраняются.

## 4. План работ

## Этап 1. Перевести главную с `/assets/ozon-main/*.jpg` на optimized media

### Проблема

Старые JPG слишком большие для фактического размера отображения и не имеют нормального cache lifetime.

### Что сделать

1. В генераторе главной и каталога использовать изображения из media cache:

```text
/media/products/<hash>/480.webp
/media/products/<hash>/800.webp
/media/products/<hash>/1200.webp
```

2. Для карточек товаров использовать responsive image:

```html
<img
  src="/media/products/.../480.webp"
  srcset="/media/products/.../480.webp 480w, /media/products/.../800.webp 800w"
  sizes="(max-width: 768px) 50vw, 320px"
  width="800"
  height="1067"
  loading="lazy"
  decoding="async"
>
```

3. Для первых видимых карточек оставить `loading="eager"`, но ограничить количество.

Рекомендация:

- mobile: первые 2–4 изображения;
- desktop: первые 4–6 изображений;
- остальные — lazy.

4. Убрать `/assets/ozon-main/*.jpg` из главной страницы, hero и карточек.

### На что обратить внимание

- Визуальное качество должно проверяться на retina/mobile.
- Для больших product cards на desktop можно отдавать `800.webp`; для mobile достаточно `480.webp`.
- Не удалять сами файлы `/assets/ozon-main` до полной проверки, потому что они могут использоваться где-то ещё.

### Проверка

```bash
rg "assets/ozon-main" index.html
```

Ожидаемо: на главной не должно быть ссылок на старые JPG.

Также проверить:

```bash
curl -sSI https://komui.ru/media/products/.../480.webp
curl -sSI https://komui.ru/media/products/.../800.webp
```

Должен быть `Cache-Control`.

## Этап 2. Оптимизировать LCP hero image

### Проблема

LCP сейчас — старый JPG в hero:

```text
/assets/ozon-main/07-футболка-с-принтом-сатору-годжо.jpg
```

### Что сделать

1. Подобрать актуальную media-cache версию этой картинки.

2. Заменить hero image на WebP:

```html
<img
  class="is-active"
  src="/media/products/.../800.webp"
  srcset="/media/products/.../480.webp 480w, /media/products/.../800.webp 800w"
  sizes="(max-width: 768px) 50vw, 360px"
  width="800"
  height="1067"
  fetchpriority="high"
  loading="eager"
  decoding="async"
  alt=""
  draggable="false"
>
```

3. Добавить preload в `<head>` только для главной LCP-картинки:

```html
<link
  rel="preload"
  as="image"
  href="/media/products/.../800.webp"
  imagesrcset="/media/products/.../480.webp 480w, /media/products/.../800.webp 800w"
  imagesizes="(max-width: 768px) 50vw, 360px"
  fetchpriority="high"
>
```

4. Остальные hero-картинки не preload-ить и не делать high priority.

### На что обратить внимание

- Не нужно preload-ить все hero-картинки: это ухудшит результат.
- Нужно preload-ить только ту, которая реально является LCP на mobile.

### Проверка

В PageSpeed блок LCP request discovery должен перестать ругаться на:

- отсутствующий `fetchpriority=high`;
- старый тяжёлый JPG;
- неоптимальный discovery.

## Этап 3. Убрать render-blocking у `storefront-products.js`

Статус: реализовано.

Выбранная модель для текущего проекта: **API-first + prerender fallback**.

Причина выбора:

- первые карточки каталога уже есть в HTML и доступны поисковикам/пользователю до JS;
- актуальные товары на проде должны приходить из `/api/v1/products?limit=200`;
- тяжёлый `/data/storefront-products.js` больше не должен попадать в критический путь главной;
- статический файл остаётся fallback на случай недоступности API, поэтому сайт не ломается при временной проблеме backend/API;
- на товарных и коллекционных страницах файл товаров оставлен, но подключается через `defer`, чтобы не блокировать первый рендер и сохранить поиск в шапке.

### Проблема

`/data/storefront-products.js` весит около `355.7 KiB` и блокирует первый рендер.

### Что сделать

Быстрый безопасный вариант:

```html
<script src="/data/storefront-products.js" defer></script>
```

Более правильный вариант:

```js
window.addEventListener('load', () => {
  const script = document.createElement('script');
  script.src = '/data/storefront-products.js';
  script.defer = true;
  document.body.appendChild(script);
});
```

Или грузить после первого idle:

```js
const loadProductsScript = () => {
  const script = document.createElement('script');
  script.src = '/data/storefront-products.js';
  document.body.appendChild(script);
};

if ('requestIdleCallback' in window) {
  requestIdleCallback(loadProductsScript, { timeout: 2500 });
} else {
  setTimeout(loadProductsScript, 1500);
}
```

### Важный архитектурный вопрос

На странице сейчас есть два источника:

```text
/data/storefront-products.js
/api/v1/products?limit=200
```

Нужно выбрать модель:

1. **Static-first:** первый рендер и каталог берутся из `storefront-products.js`, API используется только для обновления/актуализации позже.
2. **API-first:** prerender остаётся в HTML, API догружает актуальные данные, `storefront-products.js` становится fallback или убирается.

Рекомендуемый вариант: `API-first + prerender fallback`.

То есть:

- первые карточки уже есть в HTML;
- API загружается после первого рендера;
- `storefront-products.js` не блокирует страницу и используется только если API недоступен.

### Проверка

PageSpeed render-blocking section не должен показывать `/data/storefront-products.js`.

## Этап 4. Оптимизировать загрузку галерей карточек

Статус: реализовано.

Выбранная модель: **lazy gallery slides для карточек + eager gallery для модалки**.

Причина выбора:

- на карточках каталога сразу нужен только первый слайд — остальные фото не должны раздувать DOM и сетевые запросы до взаимодействия;
- при попадании карточки рядом с viewport дополнительные слайды создаются заранее, чтобы свайп/стрелки не ощущались пустыми;
- при клике/свайпе дополнительные изображения создаются немедленно с `loading="eager"`;
- в quick view/modal пользователь уже явно открыл товар, поэтому все фото можно загрузить сразу для нормальной галереи.

### Проблема

Карточки и галереи создают много `img` в DOM. Даже если часть lazy, браузер всё равно обрабатывает DOM, layout и сеть.

### Что сделать

1. В карточке товара на главной сразу рендерить только первый слайд.

2. Остальные слайды хранить как данные:

```html
<div class="gallery" data-images='["/media/.../480.webp", "/media/.../480.webp"]'>
```

3. При свайпе/клике подставлять следующий `img`.

4. Для quick view/modal можно догружать все изображения только при открытии модалки.

5. Для карточек ниже первого экрана использовать `loading="lazy"` и не создавать внутренние gallery img до попадания карточки в viewport.

### Проверка

В Lighthouse должно снизиться:

- total network payload;
- image request count;
- DOM size;
- main-thread work.

## Этап 5. Настроить cache headers

Статус: реализовано на production nginx.

Фактическая модель:

- `/media/products/*` — `Cache-Control: public, max-age=2592000, immutable`;
- `/assets/*` и статические `css/js/svg/webp/avif/jpg/png/gif/woff2` — `Cache-Control: public, max-age=2592000, immutable`;
- `/data/storefront-products.js` — короткий кэш `Cache-Control: public, max-age=600, stale-while-revalidate=86400`, потому что файл не хэширован и может обновляться при деплое;
- HTML-страницы не получили долгий кэш, чтобы релизы сайта применялись сразу.

### Проблема

Для части статики нет cache-control.

### Что сделать

Для immutable-ассетов:

```nginx
location ~* \.(?:jpg|jpeg|png|gif|svg|webp|avif|woff2?)$ {
    expires 30d;
    add_header Cache-Control "public, max-age=2592000, immutable";
}
```

Для `/assets/*`:

```nginx
location ^~ /assets/ {
    expires 30d;
    add_header Cache-Control "public, max-age=2592000, immutable";
}
```

Для `/media/*` уже есть кэш, но нужно убедиться, что нет дублирующихся конфликтующих headers.

Для `/data/storefront-products.js` нельзя бездумно ставить immutable, пока имя файла не хэшированное.

Безопасный вариант:

```nginx
location = /data/storefront-products.js {
    expires 10m;
    add_header Cache-Control "public, max-age=600, stale-while-revalidate=86400";
}
```

Лучший вариант:

- генерировать `/data/storefront-products.<hash>.js`;
- обновлять ссылку в HTML;
- для hash-файла ставить immutable.

### Проверка

```bash
curl -sSI https://komui.ru/assets/collection-logos/gravity-defied.png
curl -sSI https://komui.ru/data/storefront-products.js
curl -sSI https://komui.ru/favicon.svg
```

Ожидаемо: есть осмысленный `Cache-Control`.

## Этап 6. Уменьшить влияние Google Fonts

Статус: реализовано.

Выбранная модель: **self-hosted variable fonts + удаление Noto Sans JP**.

Что сделано:

- `Inter` и `Unbounded` скачаны локально в `/assets/fonts/`;
- подключение идёт через `/assets/fonts/komui-fonts.css`;
- внешние `fonts.googleapis.com` и `fonts.gstatic.com` удалены из HTML и генератора страниц;
- `Noto Sans JP` полностью удалён: логотип использует `Unbounded`, а японские декоративные элементы теперь наследуют основной шрифт/системный fallback;
- оставлен `font-display: swap`;
- используются variable `.woff2` диапазоны `400 900`, чтобы не хранить отдельный файл на каждый вес.

### Проблема

Google Fonts:

- блокирует рендер;
- добавляет сторонние запросы;
- грузит много начертаний;
- даёт около `446 KiB` стороннего трафика.

### Что сделать

Минимальный вариант:

1. Сократить веса:

```text
Unbounded: 700, 900
Inter: 400, 600, 700
```

2. Убрать `Noto Sans JP` с главной, если японские символы не критичны для первого экрана.

3. Оставить `display=swap`.

Лучший вариант:

1. Скачать используемые `.woff2`.
2. Положить в:

```text
/assets/fonts/
```

3. Подключить через `@font-face`:

```css
@font-face {
  font-family: 'Inter';
  src: url('/assets/fonts/inter-400.woff2') format('woff2');
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}
```

4. Проставить cache headers для `/assets/fonts/*`.

### На что обратить внимание

- Полный отказ от Google Fonts может слегка изменить rendering/kerning, поэтому нужен визуальный smoke-test.
- Self-hosted fonts предпочтительнее для скорости и независимости от Google.

## Этап 7. Стабилизировать hero и убрать CLS

### Проблема

CLS даёт:

```text
hero-product-stage > hero-orbit
```

### Что сделать

1. Зафиксировать размеры `.hero-product-stage` на всех breakpoints.

2. Проверить mobile CSS:

```css
.hero-product-stage {
  min-height: ...;
  height: ...;
}
```

3. Все декоративные элементы hero должны быть `position:absolute` внутри фиксированного контейнера.

4. Анимации должны использовать только:

```css
transform
opacity
```

Не использовать для анимаций:

```css
top
left
right
bottom
width
height
background-position
```

5. Для hero images задать `width`, `height`, `aspect-ratio`.

6. Проверить, что JS не добавляет элементы в hero так, что меняет высоту секции после first paint.

### Проверка

В Lighthouse:

- CLS должен стать `< 0.1`;
- желательно `< 0.05`.

## Этап 8. Минификация JS/CSS

### Проблема

PageSpeed показывает:

```text
JS saving ~98 KiB
CSS saving ~7 KiB
```

Основной кандидат: `/data/storefront-products.js`.

### Что сделать

1. Минифицировать генерируемый `storefront-products.js`.

2. Минифицировать inline CSS в `index.html` только после того, как станет понятно, что это не мешает поддержке.

3. Рассмотреть split:

- critical CSS inline;
- остальной CSS отдельным deferred файлом.

### Приоритет

Это не первый этап. Сначала изображения, LCP и render-blocking JS.

## Этап 9. Разделить critical и non-critical код

### Проблема

Главная содержит стили и JS для:

- hero;
- каталога;
- фильтров;
- quick view;
- cart;
- checkout preview;
- lightbox;
- footer;
- поиска.

Для первого экрана всё это сразу не нужно.

### Что сделать

1. Critical CSS оставить inline:

- header;
- hero;
- первые карточки;
- базовая сетка.

2. Non-critical CSS вынести:

- modal;
- lightbox;
- cart;
- footer;
- filters;
- animations ниже первого экрана.

3. JS модалок и корзины инициализировать лениво:

- при клике;
- при первом hover/touch;
- после `load`.

### Проверка

Улучшение должно быть видно в:

- FCP;
- Speed Index;
- main-thread work;
- total byte weight.

## Этап 10. Accessibility

Performance отдельно, но текущая accessibility score — `67`. Это стоит закрыть отдельным проходом.

Проверить:

- контраст текста;
- `aria-label` у icon buttons;
- alt у декоративных изображений;
- focus-visible стили;
- labels у форм;
- размеры tap targets;
- порядок tab navigation;
- aria-hidden у декоративных hero elements.

Цель: поднять Accessibility хотя бы до `90+`.

## 5. Рекомендуемый порядок реализации

### Phase A. Быстрый performance gain

1. Убрать `/assets/ozon-main/*.jpg` с главной.
2. Перевести hero/catalog images на `/media/products/*.webp`.
3. Добавить responsive `srcset/sizes`.
4. Оптимизировать LCP image: preload + `fetchpriority="high"`.
5. Сделать `/data/storefront-products.js` неблокирующим.

Ожидаемый результат:

- payload заметно ниже;
- LCP/FCP лучше;
- PageSpeed может подняться в район `65–75`.

### Phase B. Server/static tuning

1. Настроить cache headers для `/assets`, `/data`, SVG, fonts.
2. Проверить gzip/brotli для JS/CSS/HTML.
3. Проверить отсутствие конфликтующих `Cache-Control`.
4. Добавить smoke-проверку cache headers в deploy checklist.

Ожидаемый результат:

- меньше повторная загрузка;
- меньше PageSpeed warnings;
- стабильнее повторные визиты.

### Phase C. CLS and interaction

1. Зафиксировать hero layout.
2. Убрать layout-changing animations.
3. Перевести галереи карточек на lazy slide loading.
4. Уменьшить начальный DOM.

Ожидаемый результат:

- CLS `< 0.1`;
- меньше DOM и image requests.

### Phase D. Fonts and polish

1. Сократить Google Fonts weights.
2. Перейти на self-hosted fonts.
3. Минифицировать generated JS.
4. Разделить critical/non-critical CSS.
5. Пройти accessibility.

Ожидаемый результат:

- Performance ближе к `80+`;
- Accessibility `90+`.

## 6. Критерии готовности

Перед деплоем:

```bash
node scripts/build-products.js
rg "assets/ozon-main" index.html
```

После деплоя:

```bash
curl -sSI https://komui.ru/
curl -sSI https://komui.ru/data/storefront-products.js
curl -sSI https://komui.ru/assets/collection-logos/gravity-defied.png
curl -sSI https://komui.ru/media/products/<hash>/480.webp
```

PageSpeed/Lighthouse acceptance:

| Проверка | Цель |
|---|---:|
| Performance | 70+ после Phase A, 80+ после Phase D |
| LCP | < 5s после Phase A |
| FCP | < 4s после Phase A |
| CLS | < 0.1 после Phase C |
| Total payload | < 4 MB после Phase A |
| Old `/assets/ozon-main` on home | 0 references |
| Render-blocking `storefront-products.js` | отсутствует |

## 7. Риски

### Риск 1. Потеря качества изображений

Митигировать:

- использовать `800.webp` для desktop;
- `480.webp` для mobile;
- сравнить визуально первые 10 карточек и hero.

### Риск 2. Устаревание `storefront-products.js` при кэше

Митигировать:

- либо короткий cache lifetime;
- либо hash filename;
- либо API-first модель.

### Риск 3. Визуальный сдвиг от self-hosted fonts

Митигировать:

- сначала сократить Google Fonts;
- затем отдельным коммитом перейти на self-host;
- сделать визуальный smoke-test.

### Риск 4. Сломать интерактив каталога

Митигировать:

- сохранить prerender;
- lazy-load JS после первого рендера;
- проверить фильтры, quick view, корзину, переход в товар.

## 8. Практический первый коммит

Первый безопасный коммит должен включать только:

1. hero image на WebP;
2. `preload` + `fetchpriority=high` для LCP;
3. catalog/card images на `/media/products`;
4. уменьшение `eager` images;
5. `defer` или lazy-load для `storefront-products.js`.

Не смешивать с:

- fonts self-host;
- nginx cache;
- large JS refactor;
- accessibility.

Так проще проверить влияние и быстро откатить при проблеме.
