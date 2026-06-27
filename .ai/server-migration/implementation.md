# Implementation

Выполнен этап 0:

- подтверждён SSH fingerprint;
- проверены доступ и sudo;
- собран read-only аудит сервера;
- зафиксированы существующие сервисы и конфликты;
- выдано решение `GO` с ограничениями.

Сервер не изменялся.

Выполнен этап 1:

- найдены потребители текущего Supabase;
- подтверждены 29 public-таблиц и 6 Edge Functions;
- подтверждена фактическая публичная запись в 18 внутренних таблиц;
- найдены GetoMerchV3/V4 и их Ozon routes;
- сформирована матрица потребителей и реестр секретов;
- подготовлены guarded forward/rollback SQL;
- production не изменялся.

Выполнен этап 2:

- создан swap 2 ГБ;
- установлен PostgreSQL 17.10;
- создана пустая `komui_staging` и роли owner/migrator/app/backup;
- PostgreSQL ограничен localhost;
- включён UFW с 22/80/443;
- усилен SSH без отключения обычного password authentication;
- создан системный пользователь и каталоги KOMUI;
- подготовлен backend systemd unit;
- создан отдельный HTTPS staging hostname с Basic Auth;
- production Nginx vhost остался без изменений.

Выполнен этап 3:

- через авторизованный Supabase SQL Editor получен согласованный read-only
  снимок 29 таблиц и экспортирована история из 31 миграции;
- снимок зашифрован AES-256 и хранится на сервере отдельно от ключа;
- схема и 3500 строк восстановлены в обычный PostgreSQL 17;
- два последовательных restore дали одинаковые schema/data hashes;
- проверены row counts, агрегаты, 39 foreign keys, 99 индексов и 5 sequences;
- удалены Supabase roles/grants/RLS и Vercel trigger/function;
- создана минимальная модель доступа для `komui_app` и `komui_backup`;
- временная проверочная БД удалена, рабочая staging-БД — `komui_staging`;
- production Supabase, Vercel, DNS и webhook не изменялись.

Частично выполнен этап 7:

- установлен `/usr/local/sbin/komui-backup`;
- включён `komui-backup.timer` с ежедневным запуском;
- создан root-only encryption key `/etc/komui/backup.key`;
- создан первый encrypted backup
  `/var/backups/komui/daily/komui-backup-20260627T120725Z.tar.gz.gpg`;
- backup содержит PostgreSQL dump, globals, runtime config, `/etc/komui`,
  Nginx/systemd configs, backend/frontend releases;
- выполнен restore drill в отдельную БД
  `komui_restore_drill_20260627121243`;
- restore drill подтвердил 29 таблиц, 31 storefront product и 31 active product;
- временный backend на восстановленной БД отдал `/health/ready` и
  `/v1/products?limit=1`;
- encrypted backup временно скопирован off-server на локальную машину и checksum
  совпал;
- настроен permanent external backup upload в Yandex Object Storage через
  `s3cmd`;
- Yandex backup env хранится root-only в `/etc/komui/yandex-backup.env`;
- ручной backup после настройки загрузил:
  `s3://komui-backups/komui/stage/komui-backup-20260627T143747Z.tar.gz.gpg`
  и `.sha256`;
- установлен `/usr/local/sbin/komui-healthcheck`;
- включён `komui-healthcheck.timer` каждые 5 минут;
- healthcheck проверяет systemd services, backend ready, stage HTTP, disk,
  memory, backup freshness, failed units и stale pending payments;
- выполнен restart check backend/Nginx;
- выполнен rollback symlink test и возврат на active frontend release;
- выполнен reboot test: PostgreSQL, backend, Nginx и timers поднялись сами;
- выполнен load smoke: 100 static, 50 catalog API, 10 validation requests;
- настроен Telegram alerting через `/usr/local/sbin/komui-alert`;
- Telegram Bot API доступен с сервера через Xray SOCKS proxy
  `socks5h://127.0.0.1:10808`;
- `/etc/komui/telegram-alerts.env` создан root-only;
- тестовый Telegram alert отправлен;
- production Supabase, Vercel, DNS и webhook не изменялись.

Выполнен этап 6:

- frontend runtime-конфиг переведён на `data/api-config.js`;
- удалены прямые frontend обращения к Supabase REST/Edge Functions;
- каталог, checkout, promo, CDEK и payment status переведены на `/api/v1/*`;
- `scripts/build-products.js` больше не содержит Supabase URL/key и использует
  `KOMUI_API_BASE_URL` только опционально;
- пересобраны 31 product page, 5 collection page, `sitemap.xml`, `robots.txt`;
- frontend release развернут на сервере:
  `/opt/komui/frontend-releases/20260627114138-stage6-frontend`;
- `/var/lib/komui/staging-root` переключён на этот release symlink;
- Nginx staging routing обновлён на `try_files $uri $uri.html $uri/ /index.html`;
- production Supabase, Vercel, DNS и webhook не изменялись.

Выполнен этап 4:

- создан `server/` backend на TypeScript/Fastify/pg;
- добавлены health endpoints, catalog API и admin foundation;
- public catalog API отдаёт совместимый массив товаров без внутренних
  `source_payload`, `ozon_attributes`, Ozon IDs, sales/revenue и raw offer
  fields;
- backend развернут на сервере как `/opt/komui/releases/20260626-stage4-backend`;
- `komui-backend.service` enabled/active;
- DB pool max 6, statement timeout 3000 ms;
- Nginx staging отдаёт API через `/api/*`;
- Basic Auth, localhost-only backend bind и закрытые внешние 3000/5432
  подтверждены;
- production smoke checks не изменились.

Частично выполнен этап 5:

- перенесены checkout routes из Supabase Edge Functions в собственный backend;
- добавлены CDEK delivery points/quote handlers;
- добавлены promo validation и promo redemption reserve/redeem/release helpers;
- добавлен T-Bank payment init/status/webhook контур;
- добавлена подпись T-Bank payload и constant-time проверка webhook token;
- добавлена compatibility route `/supabase-function?name=<old-name>` и
  `/api/supabase-function?name=<old-name>`;
- backend развёрнут как `/opt/komui/releases/20260626121442-stage5-checkout`;
- `stage.komui.ru` подключён к Nginx staging vhost;
- выпущен Let’s Encrypt certificate для `stage.komui.ru`;
- backend env переведён на `SITE_URL=https://stage.komui.ru`;
- включены safe staging flags:
  `TBANK_MOCK_PAYMENTS=true`, `CDEK_MOCK=true`,
  `CDEK_CREATE_SHIPMENTS=false`;
- production Supabase, Vercel, DNS и webhook не изменялись.
