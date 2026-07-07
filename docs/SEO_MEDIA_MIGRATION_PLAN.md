# План переноса товарных фото с Ozon CDN на komui.ru

Дата: 2026-07-07  
Источник задачи: пункт 5 дорожной карты из [GEO-AUDIT-REPORT.md](../GEO-AUDIT-REPORT.md)

## 1. Контекст и цель

Сейчас товарные изображения на сайте в основном отдаются напрямую с `https://ir.ozone.ru`. Это используется не только в видимых `<img>`, но и в SEO/GEO-поверхностях:

- `og:image`;
- `twitter:image`;
- Product JSON-LD `image`;
- карточки на главной;
- страницы товаров;
- страницы коллекций;
- рекомендации на товарных страницах;
- prerender-каталог в `index.html`;
- публичный API каталога, который используется клиентским JS после загрузки страницы.

Это создаёт несколько проблем:

- зависимость от внешнего CDN Ozon;
- риск поломки карточек и schema, если Ozon изменит URL или ограничит доступ;
- слабее контроль над индексацией картинок;
- невозможно нормально управлять WebP, `width`, `height`, `srcset`, cache headers и LCP;
- после клиентской гидрации главная может снова получить Ozon-URL из API, даже если статический HTML уже переписан.

Цель реализации:

- все публичные товарные изображения должны открываться с `https://komui.ru`;
- в публичном HTML, API, JSON-LD и meta-тегах не должно оставаться `ir.ozone.ru`;
- изображения должны иметь WebP-варианты, размеры, `srcset`, `sizes`;
- первая hero-картинка товара должна быть оптимизирована под LCP;
- новые изображения из Ozon import не должны возвращать сайт к хотлинкам на `ir.ozone.ru`.

## 2. Текущее состояние

На момент аудита:

- активный каталог prod: 34 товара;
- уникальных Ozon image URL в публичных данных: около 142;
- ссылок на Ozon-картинки с учётом дублей в product/offers/static: более 1000;
- генератор статических страниц: [scripts/build-products.js](../scripts/build-products.js);
- публичный catalog API: [server/src/catalog.ts](../server/src/catalog.ts);
- текущий deploy pipeline: [ops/server/komui-deploy-from-git](../ops/server/komui-deploy-from-git).

Критичный вывод: менять только `build-products.js` недостаточно. Нужно одновременно изменить:

1. генерацию статического HTML;
2. публичный backend API;
3. nginx/static serving;
4. deploy pipeline;
5. процесс будущего Ozon import.

## 3. Целевая архитектура

### 3.1. Где хранить изображения

Не хранить товарные изображения в git. Репозиторий быстро раздуется, а деплои станут тяжелее.

Рекомендуемое расположение на сервере:

```text
/var/lib/komui/media-cache/
  manifest.json
  manifest.previous.json
  public/
    products/
      ab/
        abcdef123456/
          original.jpg
          480.webp
          800.webp
          1200.webp
          thumb.webp
```

Публичный URL:

```text
https://komui.ru/media/products/ab/abcdef123456/800.webp
```

### 3.2. Manifest

`manifest.json` — источник соответствия между исходным Ozon URL и локальными вариантами.

Пример структуры:

```json
{
  "version": 1,
  "updatedAt": "2026-07-07T00:00:00Z",
  "images": {
    "https://ir.ozone.ru/s3/multimedia-1-x/example.jpg": {
      "sourceUrl": "https://ir.ozone.ru/s3/multimedia-1-x/example.jpg",
      "hash": "abcdef123456",
      "width": 1200,
      "height": 1600,
      "mime": "image/jpeg",
      "original": "/media/products/ab/abcdef123456/original.jpg",
      "fallback": "/media/products/ab/abcdef123456/800.webp",
      "variants": [
        {
          "width": 480,
          "height": 640,
          "format": "webp",
          "url": "/media/products/ab/abcdef123456/480.webp"
        },
        {
          "width": 800,
          "height": 1067,
          "format": "webp",
          "url": "/media/products/ab/abcdef123456/800.webp"
        },
        {
          "width": 1200,
          "height": 1600,
          "format": "webp",
          "url": "/media/products/ab/abcdef123456/1200.webp"
        }
      ],
      "thumb": "/media/products/ab/abcdef123456/thumb.webp",
      "lastSyncedAt": "2026-07-07T00:00:00Z"
    }
  }
}
```

Требования:

- ключом является исходный URL;
- локальные URL должны быть относительными (`/media/products/...`), чтобы stage/prod могли использовать один manifest;
- manifest должен быть атомарно перезаписываемым;
- перед перезаписью нужно сохранять `manifest.previous.json`;
- broken/failed images нужно логировать отдельно.

### 3.3. Nginx

Добавить отдачу локального media cache:

```nginx
location /media/products/ {
    alias /var/lib/komui/media-cache/public/products/;
    access_log off;
    expires 30d;
    add_header Cache-Control "public, max-age=2592000, immutable";
    add_header X-Content-Type-Options "nosniff";
}
```

Проверки после настройки:

```bash
curl -I https://komui.ru/media/products/.../800.webp
curl -I https://stage.komui.ru/media/products/.../800.webp
```

Ожидаемо:

```text
HTTP/2 200
content-type: image/webp
cache-control: public, max-age=2592000, immutable
```

## 4. Скрипт синхронизации медиа

Создать:

```text
scripts/sync-product-media.js
```

### 4.1. Входные данные

Скрипт должен уметь работать от двух источников:

1. API:

```bash
KOMUI_API_BASE_URL=http://127.0.0.1:3001 node scripts/sync-product-media.js
```

2. локальный fallback:

```bash
node scripts/sync-product-media.js --source=data/storefront-products.js
```

### 4.2. Какие URL собирать

Из каждого товара:

- `primary_image_url`;
- `main_image_path`;
- `image_urls[]`;
- `offers[].primary_image`;
- `offers[].images[]`.

Собирать только внешние изображения:

```text
https://ir.ozone.ru/...
```

Локальные `/media/products/...` пропускать.

### 4.3. Обработка

Для каждого уникального URL:

1. скачать оригинал;
2. проверить HTTP status;
3. проверить `content-type`;
4. посчитать hash;
5. определить фактические `width`/`height`;
6. сохранить оригинал;
7. сгенерировать WebP-варианты:
   - `480.webp`;
   - `800.webp`;
   - `1200.webp`;
   - `thumb.webp`.

Для конвертации использовать `sharp`.

Параметры WebP:

```js
quality: 82
effort: 4
```

Для `thumb.webp`:

```text
320px по ширине
```

### 4.4. Поведение при ошибках

Ошибки делить на уровни:

- `warning`: не удалось скачать второстепенную картинку;
- `fatal`: не удалось скачать hero-image товара.

Рекомендуемое правило:

- если сломалась не первая картинка — продолжать, но записать в report;
- если сломалась первая картинка активного товара — падать, чтобы не задеплоить товар без hero-image.

Отчёт:

```text
/var/log/komui/media-sync/YYYYMMDDTHHMMSSZ.json
```

Содержимое:

```json
{
  "startedAt": "...",
  "finishedAt": "...",
  "sourceUrls": 142,
  "downloaded": 12,
  "reused": 130,
  "failed": [],
  "fatal": false
}
```

### 4.5. Cleanup

Добавить безопасную очистку:

- не удалять файлы сразу;
- сначала помечать orphan images в отчёте;
- удалять только если URL не встречается в catalog API 2–3 последовательных запуска.

На первом этапе cleanup можно сделать ручным dry-run:

```bash
node scripts/sync-product-media.js --cleanup-dry-run
```

## 5. Интеграция в `build-products.js`

### 5.1. Загрузка manifest

Добавить:

```js
const MEDIA_MANIFEST_PATH =
  process.env.KOMUI_MEDIA_MANIFEST_PATH ||
  '/var/lib/komui/media-cache/manifest.json';
```

Если manifest отсутствует:

- для локальной разработки можно fallback на исходный URL;
- для production deploy лучше падать, если есть `ir.ozone.ru` и нет manifest.

Рекомендуемые env:

```text
KOMUI_MEDIA_STRICT=1
KOMUI_MEDIA_MANIFEST_PATH=/var/lib/komui/media-cache/manifest.json
```

### 5.2. Функции

Добавить helpers:

```js
resolvePublicImage(sourceUrl)
resolvePublicImages(sourceUrls)
renderResponsiveImage(sourceUrl, options)
imageSrcSet(sourceUrl)
imageDimensions(sourceUrl)
```

`resolvePublicImage`:

- если URL уже `/media/products/...` — вернуть как есть;
- если URL есть в manifest — вернуть локальный fallback;
- если URL внешний и strict mode включён — ошибка;
- если URL внешний и strict mode выключен — вернуть исходный URL.

### 5.3. Что заменить

В `build-products.js` заменить все прямые `<img src="${u}">` на `renderResponsiveImage`.

Обязательные места:

- product gallery slides;
- product gallery thumbnails;
- recommendations;
- collection cards;
- catalog prerender;
- `og:image`;
- `twitter:image`;
- JSON-LD `Product.image`;
- возможно `data/storefront-products.js`, если он генерируется этим же скриптом или попадает в клиентский runtime.

### 5.4. LCP и размеры

Для первой картинки товара:

```html
<img
  src="/media/products/.../800.webp"
  srcset="/media/products/.../480.webp 480w, /media/products/.../800.webp 800w, /media/products/.../1200.webp 1200w"
  sizes="(max-width: 768px) 100vw, 680px"
  width="1200"
  height="1600"
  loading="eager"
  fetchpriority="high"
  decoding="async"
>
```

Для остальных:

```html
loading="lazy"
fetchpriority не ставить
```

Для миниатюр:

```html
src="/media/products/.../thumb.webp"
width="320"
height="..."
```

### 5.5. Убрать preconnect к Ozon

После миграции в HTML больше не нужен:

```html
<link rel="preconnect" href="https://ir.ozone.ru">
```

Удалить из product/collection templates.

## 6. Интеграция в backend API

Файл:

```text
server/src/catalog.ts
```

Создать helper, например:

```text
server/src/mediaManifest.ts
```

Он должен:

- лениво читать manifest;
- мапить внешний URL в публичный local URL;
- возвращать dimensions/variants при необходимости;
- не падать весь API, если manifest временно отсутствует, но логировать проблему.

Публичный API должен отдавать уже локальные URL в:

- `primary_image_url`;
- `main_image_path`;
- `image_urls`;
- `offers[].primary_image`;
- `offers[].images`.

Важно: в PostgreSQL можно продолжать хранить исходные Ozon URL. Это нормальный source-of-truth. Публичный слой должен преобразовывать их в `komui.ru` media URLs.

Плюсы такого подхода:

- Ozon import не ломается;
- можно пересобрать manifest при необходимости;
- в БД сохраняется связь с оригинальным источником;
- frontend и API получают одинаковые публичные URL.

## 7. Интеграция в Ozon import

Файлы:

```text
server/src/ozonImport.ts
scripts/sync-product-media.js
```

После импорта новых товаров или обновления медиа:

1. Ozon import сохраняет source URL в PostgreSQL.
2. Запускается media sync.
3. Следующий build/API отдаёт локальные URL.

Минимальный вариант:

- не запускать sync из backend;
- после импорта в админке показывать предупреждение: “Новые медиа требуют media sync/deploy”;
- запускать sync в deploy pipeline.

Лучший вариант:

- добавить endpoint:

```text
POST /admin/media/sync
```

- админка после Ozon import может запустить sync;
- результат виден в UI: downloaded/reused/failed.

Для первого релиза достаточно deploy-pipeline sync. Endpoint можно добавить позже.

## 8. Deploy pipeline

Файл:

```text
ops/server/komui-deploy-from-git
```

Текущий порядок:

```text
git checkout
npm ci
tests
backend build
static build
release
activate
smoke
```

Целевой порядок:

```text
git checkout
npm ci
tests
backend build
media sync
static build with media manifest
release backend
release frontend
activate backend
activate frontend
smoke
registry record
```

Для stage:

```bash
KOMUI_API_BASE_URL=http://127.0.0.1:3000 \
KOMUI_MEDIA_CACHE_DIR=/var/lib/komui/media-cache \
node scripts/sync-product-media.js
```

Для prod:

```bash
KOMUI_API_BASE_URL=http://127.0.0.1:3001 \
KOMUI_MEDIA_CACHE_DIR=/var/lib/komui/media-cache \
node scripts/sync-product-media.js
```

Затем:

```bash
KOMUI_MEDIA_STRICT=1 \
KOMUI_MEDIA_MANIFEST_PATH=/var/lib/komui/media-cache/manifest.json \
KOMUI_API_BASE_URL="$api_base" \
node scripts/build-products.js
```

## 9. NPM/dependency стратегия

Сейчас корневого package.json нет, server package содержит только backend dependencies.

Варианты:

### Вариант A — root package.json

Создать root `package.json`:

```json
{
  "private": true,
  "scripts": {
    "build:products": "node scripts/build-products.js",
    "sync:media": "node scripts/sync-product-media.js"
  },
  "devDependencies": {
    "sharp": "^0.33.0"
  }
}
```

Плюс: `scripts/` имеют свои зависимости в правильном месте.  
Минус: deploy script должен делать `npm ci` в root.

### Вариант B — положить `sharp` в server package

Плюс: меньше изменений в deploy.  
Минус: backend package получает зависимость, которая нужна build scripts, а не серверу.

Рекомендация: вариант A. Это чище архитектурно.

## 10. Проверки

### 10.1. До деплоя

```bash
node scripts/sync-product-media.js --dry-run
npm run sync:media
npm run build:products
rg "ir\\.ozone\\.ru" index.html p collections data sitemap.xml llms-full.txt
```

После build в strict mode `rg` не должен находить `ir.ozone.ru` в публичных артефактах.

Исключения допустимы только в:

- manifest;
- logs;
- internal source data, если она не отдаётся публично.

### 10.2. После stage deploy

```bash
curl -k -u "$STAGING_USER:$STAGING_PASSWORD" https://stage.komui.ru | grep ir.ozone.ru
curl -k -u "$STAGING_USER:$STAGING_PASSWORD" https://stage.komui.ru/api/v1/products?limit=100 | grep ir.ozone.ru
curl -k -I https://stage.komui.ru/media/products/.../800.webp
```

Ожидаемо:

```text
no ir.ozone.ru
HTTP 200 image/webp
```

### 10.3. После prod deploy

```bash
curl -s https://komui.ru | grep -c 'ir.ozone.ru'
curl -s https://komui.ru/api/v1/products?limit=100 | grep -c 'ir.ozone.ru'
curl -s https://komui.ru/p/futbolka-varenka-jujutsu-kaisen-satoru-gojo-print-seraya | grep -c 'ir.ozone.ru'
curl -I https://komui.ru/media/products/.../800.webp
```

Ожидаемо:

```text
0
0
0
HTTP/2 200
content-type: image/webp
```

### 10.4. Schema/meta checks

Проверить:

- `og:image` начинается с `https://komui.ru/media/...`;
- `twitter:image` начинается с `https://komui.ru/media/...`;
- Product JSON-LD `image[]` содержит только `https://komui.ru/media/...`;
- первая hero-картинка имеет `width`, `height`, `fetchpriority="high"`.

## 11. Rollback

Rollback должен быть простым.

### 11.1. Кодовый rollback

Откат на предыдущий release:

```bash
sudo /usr/local/sbin/komui-release-activate backend <previous-release> --event rollback --summary "rollback media migration"
```

Для frontend:

```bash
sudo /usr/local/sbin/komui-release-activate frontend <previous-release> --event rollback --summary "rollback media migration"
```

### 11.2. Media manifest rollback

Перед каждым sync:

```text
manifest.json -> manifest.previous.json
```

Если новый manifest сломан:

```bash
sudo cp /var/lib/komui/media-cache/manifest.previous.json /var/lib/komui/media-cache/manifest.json
sudo /usr/local/sbin/komui-deploy-from-git prod main
```

### 11.3. Не удалять media при rollback

Нельзя удалять `/var/lib/komui/media-cache/public/products` при деплое. Старые frontend-релизы могут ссылаться на старые media paths.

## 12. Риски и ограничения

### 12.1. Диск

Сервер имеет 20 ГБ SSD. На момент последних проверок диск был занят примерно на 75–80%.

Риск: WebP-варианты для всех изображений могут занять заметное место.

Меры:

- ограничить размеры 480/800/1200/thumb;
- не генерировать 1600/2000 без необходимости;
- делать `du -sh /var/lib/komui/media-cache`;
- добавить cleanup после стабильной работы.

### 12.2. Ozon CDN

Ozon может:

- временно отдавать 403/429;
- менять формат;
- отдавать картинки медленно.

Меры:

- user-agent;
- retry 2–3 раза;
- timeout;
- кешировать уже скачанные изображения;
- не перекачивать существующие URL без причины.

### 12.3. Разные контуры stage/prod

Stage и prod используют разные БД и разное количество товаров.

Рекомендуемо:

- media-cache может быть общим, потому что ключ — исходный URL;
- manifest общий;
- sync запускать на stage/prod deploy;
- если stage содержит image, которого нет в prod, это не проблема.

### 12.4. Публичный API

Если забыть API-слой, HTML будет чистый, но клиентский JS может снова подставить `ir.ozone.ru`.

Это главный риск. Поэтому API mapping обязателен.

## 13. Рекомендуемый порядок работ

### Шаг 1. Подготовка foundation

1. Создать root `package.json`.
2. Добавить `sharp`.
3. Создать `scripts/sync-product-media.js`.
4. Реализовать dry-run: сбор URL и отчёт без скачивания.
5. Проверить количество уникальных Ozon URL.

Результат:

```text
sync-product-media dry-run показывает список URL и не меняет файловую систему
```

### Шаг 2. Реальное скачивание и manifest

1. Добавить скачивание оригиналов.
2. Добавить генерацию WebP-вариантов.
3. Добавить `manifest.json`.
4. Добавить report в `/var/log/komui/media-sync`.
5. Прогнать локально на 2–3 URL.
6. Прогнать на сервере stage для всех URL.

Результат:

```text
/var/lib/komui/media-cache/manifest.json содержит все текущие изображения
```

### Шаг 3. Nginx `/media/products/`

1. Добавить alias в nginx config.
2. Проверить отдачу WebP.
3. Проверить cache headers.

Результат:

```text
https://stage.komui.ru/media/products/.../800.webp отдаёт 200 image/webp
```

### Шаг 4. Static build mapping

1. Подключить manifest в `build-products.js`.
2. Переписать генерацию product gallery.
3. Переписать collection cards.
4. Переписать recommendations.
5. Переписать catalog prerender.
6. Переписать `og:image`, `twitter:image`, JSON-LD `image`.
7. Удалить preconnect к `ir.ozone.ru`.
8. Добавить `width`, `height`, `srcset`, `sizes`, `fetchpriority`.

Результат:

```text
static HTML после build не содержит ir.ozone.ru
```

### Шаг 5. Backend API mapping

1. Создать `server/src/mediaManifest.ts`.
2. Подключить mapping в `server/src/catalog.ts`.
3. Покрыть тестом: входной Ozon URL -> публичный `/media/products/...`.
4. Проверить `/api/v1/products`.

Результат:

```text
curl https://stage.komui.ru/api/v1/products?limit=100 | grep ir.ozone.ru
```

ничего не находит.

### Шаг 6. Deploy pipeline

1. Добавить media sync перед static build.
2. Включить strict mode для production build.
3. Добавить smoke-check на отсутствие `ir.ozone.ru`.
4. Добавить проверку `llms`, schema/meta по возможности.

Результат:

```text
deploy падает, если публичные артефакты снова содержат ir.ozone.ru
```

### Шаг 7. Stage verification

Проверить:

- главная;
- товарная страница;
- коллекция;
- API;
- JSON-LD;
- meta images;
- мобильная галерея;
- Lighthouse/LCP.

Результат:

```text
stage чистый, картинки отдаются с stage.komui.ru/media/products
```

### Шаг 8. Prod deploy

1. Сделать prod deploy.
2. Проверить публичные URL.
3. Проверить registry.
4. Проверить disk usage.
5. Проверить Google Rich Results / schema validator вручную.

Результат:

```text
prod не содержит ir.ozone.ru в HTML/API/schema/meta
```

### Шаг 9. Post-release hardening

1. Добавить cleanup dry-run.
2. Добавить media sync timer или admin endpoint.
3. Добавить алерт, если sync failed.
4. Документировать runbook.

## 14. Критерии готовности

Пункт 5 дорожной карты считается закрытым, если:

- `https://komui.ru` не содержит `ir.ozone.ru`;
- `https://komui.ru/api/v1/products?limit=100` не содержит `ir.ozone.ru`;
- все product pages не содержат `ir.ozone.ru`;
- коллекции не содержат `ir.ozone.ru`;
- Product JSON-LD `image` содержит `https://komui.ru/media/products/...`;
- `og:image` и `twitter:image` содержат `https://komui.ru/media/products/...`;
- hero image имеет `width`, `height`, `srcset`, `sizes`, `fetchpriority="high"`;
- lazy images имеют `loading="lazy"`;
- WebP реально отдаётся с `content-type: image/webp`;
- после Ozon import новые картинки попадают в media-cache;
- deploy registry фиксирует релиз;
- rollback возможен без удаления media-cache.

