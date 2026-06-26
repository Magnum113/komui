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

- `data/supabase-config.js`;
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
- Обновить БД и generated pages.
- Включить immutable caching в Nginx.

Этот пункт можно выполнить после запуска, но тогда проект временно останется зависим от Ozon CDN.

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
