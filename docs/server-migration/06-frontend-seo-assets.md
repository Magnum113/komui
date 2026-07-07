# Этап 6. Frontend, SEO и статические ресурсы

## Цель

Убрать runtime-зависимость frontend от Supabase/Vercel и подготовить автономную раздачу сайта.

Изменения проверяются в отдельной staging-копии frontend. Файлы действующего
Vercel deployment и production-конфигурация не переключаются.

## Зависимости

- API каталога и checkout готовы на staging.

## Действия

### 6.1. Frontend config

Изменить:

- `data/api-config.js`;
- каталог в `index.html`;
- checkout;
- payment result;
- `scripts/build-products.js`;
- Vercel proxy functions;
- env examples и документацию.

Целевое состояние:

- нет publishable/anon key;
- нет `functionsProxyUrl`;
- нет runtime URL `*.supabase.co`;
- frontend знает только собственный API.

### 6.2. Каталог и fallback

- Получать каталог через `/v1/products`.
- Сохранить локальный fallback.
- Настроить его регулярную синхронизацию.
- Проверять совпадение активных товаров и цен.

### 6.3. SEO generation

- Перевести build script на новый API.
- Генерировать во временную директорию.
- Проверять результат.
- Атомарно переключать готовый набор файлов.
- Заменить Vercel deploy hook на durable rebuild job.
- Не запускать shell напрямую из SQL trigger.

### 6.4. Изображения

- Собрать не менее 132 внешних Ozon image URLs.
- Скачать с контролем status/MIME/размера.
- Проверить декодирование.
- Создать стабильный mapping.
- Обновить generated pages и public API mapping.
- Включить immutable caching в Nginx.

Стратегия реализации: БД может хранить исходные Ozon URLs как source-of-truth,
а публичный слой (`build-products.js` и backend `/v1/products`) мапит их через
`/var/lib/komui/media-cache/manifest.json` в `/media/products/...`.

### 6.5. Шрифты

- Скачать используемые Google Fonts.
- Обновить CSS на локальные файлы.
- Проверить лицензии и наборы начертаний.

### 6.6. Vercel removal

- Убедиться, что `/api/supabase-function` обслуживается новым backend.
- Убедиться, что delivery config выдаётся новым сервером.
- Не удалять Vercel deployment до production cutover.
- Не менять production environment variables Vercel до production cutover.
- Не инициировать production redeploy из staging-БД.

## Проверки

- `rg` не находит runtime `supabase.co` вне архивной документации.
- Frontend не содержит Supabase key.
- Все 31 product pages и 5 collection pages генерируются.
- Sitemap и canonical корректны.
- Нет 404 на локальных assets.
- Checkout работает с новым API.
- Сайт остаётся работоспособным при недоступном API каталога через fallback.

## Результат

Готовая автономная release-сборка сайта.

## GO

Staging frontend не обращается к Supabase/Vercel и проходит browser/E2E проверки.

## NO-GO

- остались runtime URL Supabase;
- каталог/цены расходятся;
- SEO build неатомарен;
- broken images или sitemap;
- checkout зависит от Vercel route.

## Rollback

Вернуть предыдущий frontend release/symlink. Старый Vercel deployment остаётся доступным.

## Фактический результат этапа 6

Статус: `GO с ограничениями`.

Дата выполнения: 27 июня 2026 года.

Production не изменялся: `komui.ru`, текущий Vercel deployment, текущий
Supabase project и production webhooks не переключались.

Выполнено:

- runtime-конфиг frontend переименован с `data/supabase-config.js` в
  `data/api-config.js`;
- из frontend runtime удалены Supabase publishable/anon key, `functionsProxyUrl`,
  прямые REST-запросы `/rest/v1` и прямые Edge Functions `/functions/v1`;
- каталог на главной теперь запрашивает `/api/v1/products?limit=200`;
- checkout вызывает собственные endpoints:
  - `/api/v1/delivery/points`;
  - `/api/v1/delivery/quote`;
  - `/api/v1/promos/validate`;
  - `/api/v1/payments`;
- payment result вызывает `/api/v1/payments/status`;
- SEO generator `scripts/build-products.js` переведён на опциональный
  `KOMUI_API_BASE_URL`; без него безопасно использует локальный fallback;
- пересобраны 31 product page, 5 collection page, `sitemap.xml` и `robots.txt`;
- frontend staging задеплоен как release
  `/opt/komui/frontend-releases/20260627114138-stage6-frontend`;
- `/var/lib/komui/staging-root` переключён на symlink этого release;
- предыдущий root сохранён как
  `/var/lib/komui/staging-root.backup-20260627114140`;
- Nginx staging routing исправлен на `try_files $uri $uri.html $uri/ /index.html`,
  чтобы `/checkout`, `/payment-result`, `/delivery` и другие extensionless URL
  отдавали правильные HTML-файлы.

Проверки:

- `node scripts/build-products.js`:
  - 31 product page;
  - 5 collection pages;
  - sitemap и robots пересобраны;
- `node --check scripts/build-products.js` — OK;
- `npm test` в `server/` — 13/13 tests passed;
- `https://stage.komui.ru/` с Basic Auth — HTTP 200;
- `https://stage.komui.ru/checkout` — HTTP 200, title
  `Оформление заказа — KOMUI`;
- `https://stage.komui.ru/payment-result` — HTTP 200, title
  `Статус оплаты — KOMUI`;
- `https://stage.komui.ru/data/api-config.js` — HTTP 200;
- `https://stage.komui.ru/api/v1/products?limit=1` — HTTP 200;
- без Basic Auth staging возвращает HTTP 401;
- `X-Robots-Tag: noindex, nofollow, noarchive` сохранён;
- в deployed runtime `.html/.js` файлах не найдены:
  - `sb_publishable`;
  - `supabase.co`;
  - `functionsProxyUrl`;
  - `window.KOMUI_SUPABASE`;
  - `/rest/v1`;
  - `/functions/v1`;
- `data/supabase-config.js` отсутствует в активном frontend release.

Ограничения на момент 27 июня 2026:

- browser smoke через Playwright не выполнен: локальный temporary package
  `playwright` не был доступен через `require()` в текущем окружении. Вместо
  этого выполнены внешние HTTPS/curl проверки routing и API;
- изображения товаров пока остаются внешними Ozon CDN URL;
- Google Fonts пока не локализованы;
- Ozon dual-write admin job не считается готовым, пока не будет передан
  настоящий Supabase `service_role` / `sb_secret_...` key вместо public
  publishable/anon key.

Решение:

- можно переходить к этапу 7 — изолированная staging-приёмка, backup и
  operational verification;
- production cutover по-прежнему заблокирован до отдельного явного разрешения.

## Дополнение 7 июля 2026 — перенос товарных фото с Ozon CDN

Статус: `реализовано в коде, ожидает stage/prod deploy`.

Выполнено:

- создан детальный план: `docs/SEO_MEDIA_MIGRATION_PLAN.md`;
- добавлен root `package.json` для build scripts;
- добавлен `scripts/sync-product-media.js`;
- локально собраны 143 уникальных Ozon image URLs из 34 товаров;
- скачаны оригиналы;
- сгенерированы WebP variants `480.webp`, `800.webp`, `1200.webp`,
  `thumb.webp`;
- создан локальный manifest `.komui/media-cache/manifest.json`;
- локальный media-cache после sync занимает около `63M`;
- `scripts/build-products.js` теперь читает manifest и генерирует HTML/data с
  `/media/products/...`;
- Product JSON-LD, `og:image`, `twitter:image`, product gallery,
  recommendations, collection cards и prerender catalog используют local media;
- для hero images добавлены `srcset`, `sizes`, `width`, `height`,
  `fetchpriority="high"`;
- thumbnails используют `thumb.webp`;
- `data/storefront-products.js` генерируется с local media URLs;
- добавлен backend mapping через `server/src/mediaManifest.ts`;
- `/health/ready` показывает статус media manifest;
- deploy script запускает media sync, strict frontend build и проверки на
  отсутствие `ir.ozone.ru`;
- production nginx runtime snippet получил `/media/products/` alias.

Локальные проверки:

```bash
KOMUI_MEDIA_STRICT=1 node scripts/build-products.js
rg "ir\\.ozone\\.ru" index.html p collections data sitemap.xml llms-full.txt llms.txt nginx-product-redirects.conf
```

Результат:

```text
build OK
ir.ozone.ru не найден в публичных static artifacts
```

Backend:

```text
server TypeScript build: OK
server tests: 48/48 passed
```

Оставшиеся server-side действия:

- применить изменения на сервере через deploy;
- убедиться, что stage nginx, как и production snippet, отдаёт
  `/media/products/` из `/var/lib/komui/media-cache/public/products/`;
- после deploy проверить `https://stage.komui.ru/api/v1/products?limit=100` и
  `https://komui.ru/api/v1/products?limit=100` на отсутствие `ir.ozone.ru`;
- проверить несколько `/media/products/.../800.webp` через `curl -I`.
