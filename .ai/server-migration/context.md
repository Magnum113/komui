# Context

- Витрина статическая, без frontend framework.
- Есть 2 Vercel Functions и 6 Supabase Edge Functions.
- Supabase содержит PostgreSQL 17.6, 29 public-таблиц и около 20 МБ данных.
- Auth, Storage и Realtime не используются.
- В репозитории сохранены только 5 из 31 миграции.
- База обслуживает каталог, склад, производство, Ozon, финансы и checkout.
- Обнаружены опасные публичные права записи в 18 внутренних таблиц.
- Целевая архитектура: Nginx + Node.js/TypeScript/Fastify + PostgreSQL 17 + systemd.
- Этапы подготовки выполняются параллельно production.
- Staging использует отдельную БД и demo/test integrations.
- До ручной приёмки не меняются production DNS, Vercel, Supabase и webhook.
- GetoMerchV3 и GetoMerchV4 используют тот же Supabase и прямой `anon` CRUD.
- V3 является вероятным основным вариантом, но deployment ещё не подтверждён.
- Сервер не содержит активных cron/jobs, пишущих в текущий Supabase.
- DB-trigger вызывает Vercel deploy hook при изменении storefront products.
- Сервер имеет 2 ГБ swap и около 7,3 ГБ свободного SSD.
- PostgreSQL 17.10 слушает только localhost; staging DB — `komui_staging`.
- Подготовлен основной HTTPS staging hostname `stage.komui.ru`.
- Технический hostname `staging-89-111-152-112.sslip.io` сохранён как
  вспомогательный.
- Staging credentials хранятся только в root-only файле на сервере.
- UFW разрешает только 22/80/443; внешние 3000/5432 закрыты.
- Этап 3 завершён: в `komui_staging` восстановлены 29 таблиц и 3500 строк.
- Снимок source зашифрован; открытая копия и source DB credential отсутствуют.
- Схема и данные подтверждены двумя последовательными restore.
- Supabase roles/grants/RLS и Vercel redeploy trigger в target удалены.
- Production Supabase, Vercel, DNS и webhook остаются неизменными.
- Этап 4 завершён: backend `komui-backend` работает на сервере из release
  `/opt/komui/releases/20260626-stage4-backend`.
- Backend слушает только `127.0.0.1:3000`; Nginx staging проксирует `/api/*`.
- Catalog API отдаёт 31 активный storefront product из `komui_staging`.
- Admin foundation включён через server-only bearer token и audit log.
- Этап 5 частично завершён: checkout API, CDEK mock, promo, T-Bank mock,
  webhook handler и compatibility route развернуты из release
  `/opt/komui/releases/20260626121442-stage5-checkout`.
- `stage.komui.ru` резолвится на `89.111.152.112`, имеет Let’s Encrypt TLS,
  Basic Auth и noindex.
- T-Bank/CDEK credentials переданы владельцем и распознаны backend; создание
  отправлений СДЭК остаётся выключенным через `CDEK_CREATE_SHIPMENTS=false`.
- Ozon credentials переданы, `/etc/komui/ozon-sync.env` создан, но dual-write в
  Supabase заблокирован: вместо service role/secret key был передан публичный
  publishable/anon key.
- Этап 6 завершён: frontend staging раздаётся из release
  `/opt/komui/frontend-releases/20260627114138-stage6-frontend` через
  `stage.komui.ru`.
- Frontend runtime больше не содержит Supabase key/URL и обращается к
  собственному `/api/v1/*`.
- Этап 7 частично выполнен: настроены encrypted local backup, backup timer,
  local healthcheck timer, restore drill, reboot test, rollback symlink test и
  load smoke.
- Первый encrypted backup:
  `/var/backups/komui/daily/komui-backup-20260627T120725Z.tar.gz.gpg`.
- Временная off-server копия backup скачана локально в ignored runtime path:
  `.ai/server-migration/runtime/backups/`.
- Постоянная внешняя backup-автоматизация настроена в Yandex Object Storage:
  bucket `komui-backups`, prefix `komui/stage/`; credentials root-only в
  `/etc/komui/yandex-backup.env`.
- Проверенный uploaded object:
  `s3://komui-backups/komui/stage/komui-backup-20260627T143747Z.tar.gz.gpg`.
- Telegram alerting настроен через Xray SOCKS proxy
  `socks5h://127.0.0.1:10808`; root-only env:
  `/etc/komui/telegram-alerts.env`; chat id `741679125`.
