# План переноса админки GetoMerchV3 на сервер KOMUI

Документ для агента/разработчика, который будет переносить админку на сервер и
не знает текущую инфраструктуру KOMUI. Цель — аккуратно добавить
`admin.komui.ru`, не сломать production-магазин `komui.ru`, staging
`stage.komui.ru`, текущий Supabase-учёт админки и существующий deploy-процесс.

## 1. Текущая архитектура

### Репозитории

На локальной машине владельца сейчас два независимых git-проекта:

```text
/Users/kadimagomedov/Documents/KomuiMerch
  git: https://github.com/Magnum113/komui.git
  назначение: публичный магазин, backend, PostgreSQL-схема сайта, checkout,
              Т-Банк, CDEK, Ozon import API, SEO/static generation.

/Users/kadimagomedov/Documents/GetoMerchV3
  git: https://github.com/Magnum113/GetoMerchV3.git
  назначение: внутренняя админка Next.js: Ozon, склад, расходы, производство,
              Komui-разделы товаров/заказов/импорта/runtime.
```

Эти репозитории **не смешивать**. Не копировать один проект внутрь другого. Не
делать общий `.git`. Исторически уже был риск смешивания разных git-папок, это
нужно явно избегать.

### Сервер

Сервер:

```text
IP: 89.111.152.112
OS: Ubuntu 24.04 LTS
CPU/RAM: 2 vCPU / 4 GB RAM
```

На сервере уже живёт магазин KOMUI:

```text
/opt/komui/deploy-source
/opt/komui/releases/
/opt/komui/frontend-releases/
/opt/komui/production-frontend-releases/
/var/lib/komui/production-root
/var/lib/komui/media-cache
/etc/komui/
/var/log/komui/
```

Сервисы:

```text
postgresql
nginx
komui-backend                 # stage backend
komui-production-backend      # prod backend, 127.0.0.1:3001
komui-backup.timer
komui-healthcheck.timer
komui-deploy-bot
```

Домены:

```text
komui.ru        -> production магазин на сервере
stage.komui.ru  -> staging магазин на сервере
```

Желаемый новый домен:

```text
admin.komui.ru  -> админка GetoMerchV3 на этом же сервере
```

## 2. Рекомендуемая целевая схема

Админку развернуть как отдельный Next.js service на том же сервере:

```text
GitHub GetoMerchV3.git
  ↓
/opt/getomerch/deploy-source
  ↓
/opt/getomerch/releases/<timestamp>-admin-<commit>
  ↓
systemd: getomerch-admin.service
  ↓
127.0.0.1:3100
  ↓
nginx: admin.komui.ru
```

Не разворачивать админку внутри `/opt/komui`. Не использовать порты магазина.
Не менять существующие `komui-production-backend`, `komui-backend`,
`/usr/local/sbin/komui-deploy-from-git`, если задача не требует отдельного
явного изменения deploy-инфраструктуры магазина.

## 3. Почему пока оставить Supabase

На первом этапе админка должна продолжить использовать текущий Supabase для
своего merch/Ozon/складского учёта.

Причина:

- это минимальный риск;
- текущие таблицы админки уже работают;
- не нужно сразу мигрировать все `merch_*`, `ozon_*`, расходы, остатки,
  производство;
- можно быстро получить рабочий `admin.komui.ru`;
- перенос БД админки на сервер — отдельный большой этап, который нужно делать
  после стабилизации админки на сервере.

На первом этапе данные делятся так:

```text
Server PostgreSQL KOMUI:
  - товары публичного сайта;
  - offers/SKU витрины;
  - заказы сайта;
  - платежи;
  - CDEK;
  - промокоды;
  - runtime/fallback состояние;
  - Ozon import API для витрины.

Supabase GetoMerchV3:
  - merch_products;
  - merch_inventory;
  - merch_warehouses;
  - merch_designs;
  - Ozon-учёт админки;
  - расходы;
  - производство;
  - прочие текущие таблицы админки.
```

## 4. Как админке обращаться к магазину

Админка не должна напрямую писать SQL в production PostgreSQL магазина. Все
изменения публичного сайта должны идти через Komui backend API:

```text
Админка Next.js UI
  ↓
server-side routes / BFF админки
  ↓
Komui backend API: https://komui.ru/api/admin/...
  ↓
PostgreSQL komui_production
```

Токен `ADMIN_API_TOKEN` нельзя класть в браузерный JS. Он должен храниться
только в server-side env админки.

Уже существующая модель в `GetoMerchV3` правильная:

```env
KOMUI_PROD_API_BASE_URL=https://komui.ru/api
KOMUI_STAGE_API_BASE_URL=https://stage.komui.ru/api
KOMUI_ADMIN_API_TOKEN=...
# или раздельно:
KOMUI_PROD_ADMIN_API_TOKEN=...
KOMUI_STAGE_ADMIN_API_TOKEN=...
KOMUI_STAGE_BASIC_AUTH=...
```

Если admin UI умеет переключать prod/stage через cookie — сохранить это
поведение. По умолчанию для production админки лучше открывать `prod`, но
визуально явно показывать текущий target.

## 5. Чего нельзя делать

Нельзя:

- менять DNS `komui.ru` или `stage.komui.ru`;
- менять production checkout, Т-Банк, CDEK, webhooks;
- менять `/etc/komui/backend-production.env` без отдельной задачи;
- менять production PostgreSQL schema магазина без backup и отдельного плана;
- писать `KOMUI_ADMIN_API_TOKEN` в `NEXT_PUBLIC_*`;
- светить Supabase service role в браузере;
- запускать destructive SQL (`DROP`, `TRUNCATE`, массовые `UPDATE/DELETE`) без
  явного подтверждения;
- объединять два git-репозитория;
- деплоить магазин при изменениях только в админке, кроме случаев, когда это
  явно требуется API-контрактом;
- ломать текущий Telegram deploy bot магазина.

## 6. Верхнеуровневый план переноса

### Этап 1. Подготовка DNS и секретов

1. Создать DNS-запись:

```text
admin.komui.ru A 89.111.152.112
```

2. Подготовить env для админки:

```text
/etc/getomerch/admin-production.env
```

Пример:

```env
NODE_ENV=production
PORT=3100
HOST=127.0.0.1

NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...

KOMUI_PROD_API_BASE_URL=https://komui.ru/api
KOMUI_STAGE_API_BASE_URL=https://stage.komui.ru/api
KOMUI_PROD_ADMIN_API_TOKEN=...
KOMUI_STAGE_ADMIN_API_TOKEN=...
KOMUI_STAGE_BASIC_AUTH=...

ADMIN_AUTH_PASSWORD_HASH=...
ADMIN_AUTH_COOKIE_SECRET=...
ADMIN_AUTH_COOKIE_NAME=getomerch_admin_session
ADMIN_AUTH_SESSION_DAYS=60
```

Файл должен быть:

```bash
sudo chown root:root /etc/getomerch/admin-production.env
sudo chmod 600 /etc/getomerch/admin-production.env
```

### Этап 2. Развернуть отдельный deploy-source

```text
/opt/getomerch/deploy-source
```

Клонировать только `GetoMerchV3.git`. Не использовать `/opt/komui`.

### Этап 3. Сборка Next.js админки

Минимальный production flow:

```bash
pnpm install --frozen-lockfile
pnpm build
```

Если lockfile отсутствует или проект использует npm — выбрать один менеджер и
зафиксировать это в deploy script. Не смешивать npm/pnpm/yarn без причины.

### Этап 4. Systemd service

Создать отдельный сервис:

```text
getomerch-admin.service
```

Рекомендуемый runtime:

```text
WorkingDirectory=/opt/getomerch/current
EnvironmentFile=/etc/getomerch/admin-production.env
ExecStart=/usr/bin/pnpm start -- -H 127.0.0.1 -p 3100
Restart=always
```

Можно заменить на `npm start`, если deploy pipeline выберет npm.

### Этап 5. Nginx vhost `admin.komui.ru`

Схема:

```text
admin.komui.ru
  HTTPS Let’s Encrypt
  security headers
  proxy_pass http://127.0.0.1:3100
```

Обязательно:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

Не менять vhost `komui.ru` и `stage.komui.ru`, кроме добавления отдельного
server block для `admin.komui.ru`.

### Этап 6. Авторизация админки

Для `admin.komui.ru` нужна простая авторизация с долгой сессией.

Рекомендуемый вариант: **password form + HttpOnly Secure cookie**.

Почему не Basic Auth:

- Basic Auth часто просит пароль заново после очистки/смены браузера;
- сложнее сделать нормальный logout/session expiry;
- пароль каждый раз идёт через browser auth mechanism;
- менее удобно на мобильных.

Реализация:

1. В Next.js добавить `/login`.
2. Middleware защищает все страницы, кроме:

```text
/login
/api/auth/login
/api/auth/logout
/_next/static/*
/favicon.ico
```

3. Пароль хранить только как хеш в env:

```env
ADMIN_AUTH_PASSWORD_HASH=$argon2id$...
# или bcrypt hash
```

4. При успешном входе ставить cookie:

```text
HttpOnly
Secure
SameSite=Lax
Path=/
Max-Age=60 дней
```

5. Значение cookie не должно быть просто `true`. Нужен подписанный токен:

```text
payload: { sub: "owner", iat, exp }
signature: HMAC-SHA256(payload, ADMIN_AUTH_COOKIE_SECRET)
```

6. Middleware проверяет подпись и `exp`.

7. Добавить кнопку logout.

8. Rate limit на `/api/auth/login` желательно сделать хотя бы простой:

```text
5 неудачных попыток за 10 минут на IP
```

Если нужен максимально быстрый старт, допустимо временно поставить nginx Basic
Auth, но целевой вариант — форма логина + HttpOnly cookie.

### Этап 7. Deploy registry и Telegram

Не использовать registry магазина напрямую. Создать отдельные пути:

```text
/var/log/getomerch/deploy/
/var/lib/getomerch/deploy-registry.jsonl
```

В будущем можно добавить в текущий Telegram bot новые inline-кнопки:

```text
Deploy admin prod
Status admin prod
Rollback admin prod
```

Но это отдельное улучшение. Для первого запуска достаточно ручного deploy
script:

```text
/usr/local/sbin/getomerch-deploy-from-git prod main
```

### Этап 8. Проверка

Проверить:

- `https://admin.komui.ru` открывается по HTTPS;
- без cookie редиректит на `/login`;
- после ввода пароля сессия сохраняется на 60 дней;
- logout работает;
- Supabase-разделы админки читают текущие данные;
- Komui target switcher показывает prod/stage;
- Komui prod API открывает товары/заказы сайта;
- Komui stage API работает с Basic Auth;
- `ADMIN_API_TOKEN` не виден в browser devtools/network;
- `NEXT_PUBLIC_*` не содержит секретов;
- магазин `https://komui.ru` работает как раньше;
- `https://stage.komui.ru` работает как раньше;
- `sudo /usr/local/sbin/komui-deploy-status` не показывает проблем.

## 7. Backup и восстановление

Текущий backup магазина уже настроен:

```text
script: /usr/local/sbin/komui-backup
systemd: komui-backup.service
timer: komui-backup.timer
local: /var/backups/komui/
external bucket: s3://komui-backups/komui/stage/
endpoint: https://storage.yandexcloud.net
credentials: /etc/komui/yandex-backup.env
encryption key: /etc/komui/backup.key
retention: 7 daily, 4 weekly, 6 monthly
```

Backup содержит:

- PostgreSQL dumps;
- Postgres globals;
- nginx/systemd configs;
- `/etc/komui`;
- Komui releases;
- frontend releases;
- media manifest/checksums.

Для админки нужно добавить отдельный backup scope:

```text
/etc/getomerch/
/opt/getomerch/releases/
/opt/getomerch/current symlink
/var/lib/getomerch/deploy-registry.jsonl
/var/log/getomerch/deploy/ последние логи
```

На первом этапе Supabase-данные админки остаются в Supabase, поэтому серверный
backup не покрывает сами таблицы `merch_*`/`ozon_*`. Это нормально, но нужно
явно понимать: пока БД админки не перенесена на сервер, backup этих данных
зависит от Supabase export/backup.

Перед любыми изменениями production БД магазина:

```bash
sudo /usr/local/sbin/komui-backup
```

После добавления админки желательно расширить `komui-backup` или создать
отдельный `getomerch-backup`, чтобы конфиги админки и deploy registry уходили
во внешний bucket.

## 8. Будущий этап: перенос БД админки с Supabase на сервер

Это не делать в первом переносе. Отдельный будущий план:

1. Инвентаризировать все Supabase-таблицы GetoMerchV3.
2. Разделить их на домены:

```text
merch catalog/SKU
inventory
warehouses
ozon orders/import/finance
expenses
workshop
reference tables
```

3. Создать отдельную БД или schema на сервере.

Рекомендуемо:

```text
DB: getomerch_production
```

Не смешивать автоматически с `komui_production`, пока нет точной схемы
границ. Для интеграций между магазином и админкой использовать API или
explicit sync jobs.

4. Сделать миграции.
5. Сделать read-only rehearsal.
6. Сделать dual-read/compare.
7. Сделать cutover админки.
8. Оставить Supabase read-only fallback на период стабилизации.

## 9. Рекомендуемая последовательность работ

1. Подготовить документированную env-схему админки.
2. Добавить auth middleware/login в `GetoMerchV3`.
3. Локально проверить `pnpm build`.
4. На сервере создать `/opt/getomerch`, `/etc/getomerch`, `/var/log/getomerch`,
   `/var/lib/getomerch`.
5. Настроить `getomerch-admin.service` на `127.0.0.1:3100`.
6. Настроить nginx `admin.komui.ru`.
7. Выпустить Let’s Encrypt certificate.
8. Проверить auth и все основные разделы.
9. Добавить deploy script/registry.
10. Добавить Telegram кнопки для admin deploy/status/rollback.
11. Расширить backup.
12. Только после стабилизации планировать перенос Supabase-таблиц админки на
    сервер.

## 10. Критерии готовности первого этапа

Первый этап считается завершённым, если:

- `admin.komui.ru` работает по HTTPS;
- есть авторизация с HttpOnly cookie;
- сессия живёт долго и не требует ежедневного входа;
- Supabase-разделы админки работают;
- Komui prod/stage API работают;
- секреты не попадают в браузер;
- магазин `komui.ru` не изменён и работает;
- stage `stage.komui.ru` не изменён и работает;
- есть понятный rollback: остановить `getomerch-admin.service` и отключить
  nginx vhost `admin.komui.ru`, не трогая магазин;
- конфиги админки включены в backup-план.
