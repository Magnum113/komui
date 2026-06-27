# Этап 6 — frontend, SEO и статические ресурсы

Дата: 27 июня 2026 года.

Статус: `GO с ограничениями`.

## Что изменено

- Runtime frontend переведён с `data/supabase-config.js` на
  `data/api-config.js`.
- Удалены browser-зависимости от Supabase:
  - publishable/anon key;
  - `functionsProxyUrl`;
  - прямые `/rest/v1` запросы;
  - прямые `/functions/v1` запросы.
- `index.html` получает каталог через `/api/v1/products?limit=200`.
- `checkout.html` вызывает собственные API:
  - `/api/v1/delivery/points`;
  - `/api/v1/delivery/quote`;
  - `/api/v1/promos/validate`;
  - `/api/v1/payments`.
- `payment-result.html` вызывает `/api/v1/payments/status`.
- `scripts/build-products.js` больше не содержит Supabase URL/key.
- Пересобраны:
  - 31 product page;
  - 5 collection pages;
  - `sitemap.xml`;
  - `robots.txt`.
- Staging frontend развернут как
  `/opt/komui/frontend-releases/20260627114138-stage6-frontend`.
- `/var/lib/komui/staging-root` переключён на release symlink.
- Предыдущий staging root сохранён как
  `/var/lib/komui/staging-root.backup-20260627114140`.
- Nginx staging routing исправлен:
  `try_files $uri $uri.html $uri/ /index.html`.

## Проверки

- `node scripts/build-products.js` — OK.
- `node --check scripts/build-products.js` — OK.
- `npm test` в `server/` — 13/13 tests passed.
- `https://stage.komui.ru/` с Basic Auth — HTTP 200.
- `https://stage.komui.ru/checkout` — HTTP 200, title
  `Оформление заказа — KOMUI`.
- `https://stage.komui.ru/payment-result` — HTTP 200, title
  `Статус оплаты — KOMUI`.
- `https://stage.komui.ru/delivery` — HTTP 200.
- `https://stage.komui.ru/data/api-config.js` — HTTP 200.
- `https://stage.komui.ru/api/v1/products?limit=1` — HTTP 200.
- Staging без Basic Auth — HTTP 401.
- `X-Robots-Tag: noindex, nofollow, noarchive` сохранён.
- В active release `.html/.js` не найдены:
  - `sb_publishable`;
  - `supabase.co`;
  - `functionsProxyUrl`;
  - `window.KOMUI_SUPABASE`;
  - `/rest/v1`;
  - `/functions/v1`.
- `data/supabase-config.js` отсутствует в active release.
- Внешние API smoke без создания платежей/отправлений:
  - `/api/v1/delivery/points` вернул 120 CDEK пунктов для Москвы;
  - `/api/v1/promos/validate` и `/api/v1/payments/status` вернули ожидаемые
    validation errors на некорректные тестовые payload.

## Production impact

Production не изменялся:

- `komui.ru` не переключался;
- Vercel deployment не менялся;
- Supabase project не менялся;
- production webhooks не менялись.

## Ограничения

- Browser smoke через Playwright не выполнен: temporary `playwright` package
  был доступен как CLI, но не был доступен через `require()` для безопасной
  передачи Basic Auth credentials без печати секретов.
- Изображения товаров пока идут с Ozon CDN.
- Google Fonts пока остаются внешними.
- Ozon dual-write admin job заблокирован до передачи настоящего Supabase
  service role/secret key.

## Rollback

Вернуть staging frontend можно переключением symlink:

```bash
sudo ln -sfn /var/lib/komui/staging-root.backup-20260627114140 /var/lib/komui/staging-root
sudo nginx -t
sudo systemctl reload nginx
```

Production rollback не требуется, потому что production не изменялся.

## Решение

Можно переходить к этапу 7: staging verification, backup, reboot/service checks
и ручная тестовая приёмка владельцем.
