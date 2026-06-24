# Проксирование Supabase через свой сервер — инструкция

Документ для нейросети/админа на сервере. Цель — сделать так, чтобы браузер пользователя из РФ ходил в Supabase **не напрямую** (AWS-эндпоинт `*.supabase.co` режется/тормозит из РФ), а через российский сервер, на котором ты работаешь. Сам Supabase остаётся, ничего там не меняем.

## 0. Контекст

- **Магазин**: `https://komui.ru` (статика — HTML/JS, хостится на Vercel).
- **Backend**: Supabase, project ref `bkxpzfnglihxpbnhtjjq`, URL `https://bkxpzfnglihxpbnhtjjq.supabase.co`.
- **Проблема**: из российских IP браузер не дотягивается до `bkxpzfnglihxpbnhtjjq.supabase.co`, поэтому:
  - не подгружается каталог товаров (`/rest/v1/merch_storefront_products`);
  - падают Edge Functions для чек-аута (`/functions/v1/tbank-*`, `/functions/v1/cdek-*`).
- **Решение**: поднять на этом сервере nginx-прокси под доменом `api.komui.ru`, который пересылает оба пути в Supabase. Браузер видит только российский домен.

## 1. Что должно быть на сервере

- Ubuntu 24.04 (есть), доступ root/sudo.
- Открытые порты 80, 443 наружу.
- Установлены: `nginx`, `certbot` с плагином nginx, `ufw` (рекомендуется), `curl`.
- Сервер должен иметь исходящий доступ в `https://bkxpzfnglihxpbnhtjjq.supabase.co` (это AWS, серверной связности с РФ обычно хватает; если нет — нужно поднимать через WireGuard к VPS вне РФ, но это редкий кейс).

Установка, если ещё не стоит:

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx ufw curl
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw --force enable
```

## 2. DNS

В панели DNS-провайдера домена `komui.ru` добавить A-запись:

```
api.komui.ru   A   <публичный IPv4 этого сервера>
TTL: 300
```

Проверить, что разрешается:

```bash
dig +short api.komui.ru
# должен вернуть IP сервера
```

Дальше шаги делать **только после** того, как DNS прорезолвится (обычно 5–30 минут).

## 3. Получить SSL-сертификат

```bash
sudo certbot --nginx -d api.komui.ru --non-interactive --agree-tos -m kadimagomedov0598@gmail.com --redirect
```

Certbot:
- получит Let's Encrypt сертификат для `api.komui.ru`;
- добавит редирект 80 → 443 в nginx;
- настроит автообновление через systemd-таймер `certbot.timer`.

Проверить, что таймер активен:

```bash
systemctl status certbot.timer
```

## 4. Конфиг nginx — прокси на Supabase

Создать `/etc/nginx/sites-available/api.komui.ru`. Если certbot уже создал базовый конфиг при `--nginx`, **заменить его содержимое полностью** на следующее (пути к сертификатам certbot сохранит):

```nginx
# Зона лимитов: 10 запросов в секунду с одного IP, burst 20
limit_req_zone $binary_remote_addr zone=api_komui:10m rate=10r/s;

# Кеш для GET-каталога: 50 MB на диске
proxy_cache_path /var/cache/nginx/komui levels=1:2 keys_zone=komui_cache:10m max_size=50m inactive=60s use_temp_path=off;

# Шлюз: только HTTPS
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name api.komui.ru;

    # Сертификаты certbot впишет автоматически:
    # ssl_certificate /etc/letsencrypt/live/api.komui.ru/fullchain.pem;
    # ssl_certificate_key /etc/letsencrypt/live/api.komui.ru/privkey.pem;
    # include /etc/letsencrypt/options-ssl-nginx.conf;
    # ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    # Цель проксирования
    set $upstream "https://bkxpzfnglihxpbnhtjjq.supabase.co";
    resolver 8.8.8.8 1.1.1.1 valid=300s;
    resolver_timeout 5s;

    # Логи (полезны для отладки в первые дни)
    access_log /var/log/nginx/api.komui.access.log;
    error_log  /var/log/nginx/api.komui.error.log warn;

    # Глобальные таймауты — Edge Functions могут идти до 25 секунд
    proxy_connect_timeout 10s;
    proxy_send_timeout    30s;
    proxy_read_timeout    30s;

    # Размер тела запроса (чек-аут шлёт небольшие JSON-ы, 1MB с запасом)
    client_max_body_size 1m;

    # CORS — разрешаем только официальный фронт и локальную разработку
    set $cors_origin "";
    if ($http_origin ~* ^https://(www\.)?komui\.ru$)       { set $cors_origin $http_origin; }
    if ($http_origin ~* ^http://localhost(:[0-9]+)?$)      { set $cors_origin $http_origin; }
    if ($http_origin ~* ^http://127\.0\.0\.1(:[0-9]+)?$)   { set $cors_origin $http_origin; }

    # Универсальный health-check
    location = /healthz {
        access_log off;
        return 200 "ok\n";
        add_header Content-Type text/plain;
    }

    # --- PostgREST: каталог товаров и любые публичные REST-запросы ---
    location /rest/ {
        limit_req zone=api_komui burst=20 nodelay;

        # CORS preflight
        if ($request_method = OPTIONS) {
            add_header Access-Control-Allow-Origin  $cors_origin always;
            add_header Access-Control-Allow-Methods "GET, POST, PATCH, DELETE, OPTIONS" always;
            add_header Access-Control-Allow-Headers "authorization, apikey, content-type, prefer, range, accept, accept-profile, content-profile, x-client-info" always;
            add_header Access-Control-Max-Age 86400 always;
            add_header Content-Length 0;
            add_header Content-Type text/plain;
            return 204;
        }

        # Кеш только для GET (каталог почти не меняется)
        proxy_cache komui_cache;
        proxy_cache_methods GET;
        proxy_cache_valid 200 60s;
        proxy_cache_key "$request_method$uri$is_args$args$http_authorization";
        proxy_cache_use_stale error timeout updating http_500 http_502 http_503 http_504;
        proxy_cache_lock on;
        add_header X-Cache-Status $upstream_cache_status always;

        # Передача в Supabase
        proxy_pass $upstream;
        proxy_http_version 1.1;
        proxy_set_header Host bkxpzfnglihxpbnhtjjq.supabase.co;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_ssl_server_name on;
        proxy_ssl_name bkxpzfnglihxpbnhtjjq.supabase.co;

        # CORS-заголовки для реальных ответов
        add_header Access-Control-Allow-Origin $cors_origin always;
        add_header Vary "Origin" always;
    }

    # --- Edge Functions: T-Bank и СДЭК ---
    # /functions/v1/tbank-create-payment, tbank-payment-status,
    # cdek-delivery-points, cdek-delivery-quote.
    # ВНИМАНИЕ: tbank-webhook сюда ходит сам Т-Банк (сервер-сервер). Проксировать его
    # тоже можно, но webhook URL у Т-Банка можно оставить прежним (прямо на supabase.co).
    location /functions/ {
        limit_req zone=api_komui burst=30 nodelay;

        # CORS preflight
        if ($request_method = OPTIONS) {
            add_header Access-Control-Allow-Origin  $cors_origin always;
            add_header Access-Control-Allow-Methods "GET, POST, OPTIONS" always;
            add_header Access-Control-Allow-Headers "authorization, apikey, content-type, x-client-info" always;
            add_header Access-Control-Max-Age 86400 always;
            add_header Content-Length 0;
            add_header Content-Type text/plain;
            return 204;
        }

        # Кеширование Edge Functions ОТКЛЮЧЕНО — они меняют состояние БД
        proxy_cache off;
        proxy_buffering off;

        proxy_pass $upstream;
        proxy_http_version 1.1;
        proxy_set_header Host bkxpzfnglihxpbnhtjjq.supabase.co;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_ssl_server_name on;
        proxy_ssl_name bkxpzfnglihxpbnhtjjq.supabase.co;

        add_header Access-Control-Allow-Origin $cors_origin always;
        add_header Vary "Origin" always;
    }

    # Всё остальное — 404, не светим неожиданные пути в Supabase
    location / {
        return 404;
    }
}
```

Активировать:

```bash
sudo ln -sf /etc/nginx/sites-available/api.komui.ru /etc/nginx/sites-enabled/api.komui.ru
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

Если `nginx -t` падает с ошибкой, что нет `ssl_certificate` — значит certbot ещё не вписал свои строки в конфиг. В этом случае добавить вручную после `server_name api.komui.ru;`:

```nginx
    ssl_certificate /etc/letsencrypt/live/api.komui.ru/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.komui.ru/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
```

И снова `nginx -t && systemctl reload nginx`.

## 5. Проверки

### 5.1 Health-check

```bash
curl -sS https://api.komui.ru/healthz
# ожидание: ok
```

### 5.2 Каталог через прокси

Взять anon-ключ Supabase из `.env.local` (`NEXT_PUBLIC_SUPABASE_ANON_KEY`) или из репозитория `data/supabase-config.js`. Затем:

```bash
ANON="<сюда anon key>"
curl -sS "https://api.komui.ru/rest/v1/merch_storefront_products?select=id,name,sort_order&limit=3&order=sort_order.asc" \
  -H "apikey: $ANON" \
  -H "Authorization: Bearer $ANON" \
  -H "Origin: https://komui.ru" \
  -i
```

Ожидание: HTTP 200, JSON со списком товаров, заголовок `Access-Control-Allow-Origin: https://komui.ru`. На втором вызове — `X-Cache-Status: HIT`.

### 5.3 Edge Function через прокси (без реальной оплаты)

```bash
curl -sS -X POST "https://api.komui.ru/functions/v1/tbank-payment-status" \
  -H "Origin: https://komui.ru" \
  -H "Content-Type: application/json" \
  -d '{"orderNumber":"NOT_EXISTING","accessToken":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}' \
  -i
```

Ожидание: HTTP 404 `Order not found` (это значит, функция отработала, просто заказа нет — то, что нужно).

### 5.4 OPTIONS-preflight

```bash
curl -sS -X OPTIONS "https://api.komui.ru/rest/v1/merch_storefront_products" \
  -H "Origin: https://komui.ru" \
  -H "Access-Control-Request-Method: GET" \
  -i
```

Ожидание: HTTP 204, заголовки `Access-Control-Allow-Origin`, `Allow-Methods`, `Allow-Headers`.

Если что-то из 5.1–5.4 падает — смотреть `/var/log/nginx/api.komui.error.log`.

## 6. Что поменять во фронте магазина

Этот шаг делает **владелец репозитория** (другой агент / Vercel-деплой), но проксирующему серверу важно знать, на какие именно URL должен переключиться фронт. Пере́числение для согласованности:

| Файл | Было | Стало |
|---|---|---|
| [data/supabase-config.js](data/supabase-config.js) | `url: "https://bkxpzfnglihxpbnhtjjq.supabase.co"` | `url: "https://api.komui.ru"` |
| [index.html:1190–1200](index.html:1190) — fetch каталога | `cfg.url + "/rest/v1/merch_storefront_products..."` | то же, но `cfg.url` уже указывает на api.komui.ru |
| [checkout.html](checkout.html) — вызов tbank-create-payment, cdek-* | `*.supabase.co/functions/v1/...` | `https://api.komui.ru/functions/v1/...` |
| [payment-result.html](payment-result.html) — вызов tbank-payment-status | `*.supabase.co/functions/v1/...` | `https://api.komui.ru/functions/v1/...` |

**Не трогать:**
- T-Bank webhook URL — он передаётся из Edge Function `tbank-create-payment` в Т-Банк (`https://bkxpzfnglihxpbnhtjjq.supabase.co/functions/v1/tbank-webhook`). Т-Банк ходит сервер-сервер, у него с AWS проблем нет. Оставить как есть.
- Anon-ключ остаётся публичным (это его дизайн), браузер по-прежнему отправляет его в заголовках `apikey` и `Authorization`. Прокси просто пересылает.

## 7. Безопасность

- В nginx-конфиге CORS разрешён **только** для `https://komui.ru`, `https://www.komui.ru` и `localhost/127.0.0.1` (dev). Любые другие Origin получат CORS-блок.
- `limit_req` ограничивает каждый IP 10 req/sec с burst 20–30. Защищает прокси и Supabase от спама.
- Сертификат Let's Encrypt автообновляется (certbot.timer).
- Endpoint `/` возвращает 404, чтобы не было прохода куда-либо ещё, кроме `/rest/` и `/functions/`.
- Никакие секреты Supabase на сервере **не хранятся**: anon-ключ публичный, service_role-ключ **не используется** и не должен сюда попадать.

## 8. Мониторинг и сопровождение

### 8.1 Лог-ротация

В Ubuntu logrotate для nginx уже стоит из коробки (`/etc/logrotate.d/nginx`). Проверить:

```bash
cat /etc/logrotate.d/nginx
sudo logrotate -d /etc/logrotate.d/nginx
```

### 8.2 Метрики «работает / не работает»

Подключить бесплатный UptimeRobot или Healthchecks.io: ping каждые 5 минут на `https://api.komui.ru/healthz`. Если приходит ≠ 200 — алерт владельцу.

### 8.3 Что смотреть при сбоях

```bash
# последние ошибки прокси
sudo tail -n 100 /var/log/nginx/api.komui.error.log

# запросы и статусы
sudo tail -n 100 /var/log/nginx/api.komui.access.log

# идёт ли вообще трафик
sudo ss -tn state established '( dport = :443 or sport = :443 )' | head

# жив ли сам Supabase из этого сервера
curl -sI https://bkxpzfnglihxpbnhtjjq.supabase.co/rest/v1/ | head
```

Если из самого сервера до Supabase нет связности (`curl` висит / Connection timed out) — значит проблема в исходящем маршруте РФ→AWS на стороне провайдера сервера. Тогда нужен трансфер через WireGuard на VPS вне РФ; описать это владельцу — без этого прокси сам станет жертвой блокировок.

### 8.4 Когда менять конфиг

- Появилась новая Edge Function в Supabase — ничего менять не нужно, она автоматически проксируется через `/functions/`.
- Сменился project ref Supabase (миграция/новый проект) — поменять значение `$upstream` и `proxy_set_header Host ...` в обоих `location`.
- Добавили новый домен фронта (например, `staging.komui.ru`) — добавить в блок CORS:
  ```nginx
  if ($http_origin ~* ^https://staging\.komui\.ru$) { set $cors_origin $http_origin; }
  ```

## 9. Чеклист для агента-исполнителя

- [ ] Установлены `nginx`, `certbot`, `ufw`.
- [ ] Открыты 80 и 443, SSH защищён.
- [ ] DNS-запись `api.komui.ru → IP сервера` создана и резолвится.
- [ ] Получен SSL сертификат через certbot.
- [ ] Конфиг `/etc/nginx/sites-available/api.komui.ru` создан, симлинк в `sites-enabled`, дефолтный сайт удалён.
- [ ] `nginx -t` проходит, `systemctl reload nginx` отработал.
- [ ] `curl https://api.komui.ru/healthz` → `ok`.
- [ ] `curl /rest/v1/merch_storefront_products` через прокси возвращает 200 и JSON.
- [ ] `curl /functions/v1/tbank-payment-status` через прокси возвращает осмысленный ответ (404 для несуществующего заказа — это норма).
- [ ] `OPTIONS`-preflight возвращает 204 с CORS-заголовками для Origin `https://komui.ru`.
- [ ] Logrotate включён, certbot.timer активен.
- [ ] Сообщить владельцу: фронт можно переключать на `https://api.komui.ru` в местах из §6.

## 10. Что НЕ делать

- ❌ Не проксировать `/auth/` пути Supabase — клиентский логин не используется на витрине, лишние пути = лишняя поверхность атаки.
- ❌ Не отключать CORS-фильтр (`Access-Control-Allow-Origin: *`) — anon-ключ вместе с открытым CORS позволит любому сайту читать публичные данные через твой прокси и нагружать его.
- ❌ Не класть на сервер `SUPABASE_SERVICE_ROLE_KEY`. Здесь он не нужен. Если попадёт — это компрометация всей БД.
- ❌ Не настраивать кеш на `/functions/` — там операции, меняющие состояние; кеш сломает оплату.
- ❌ Не игнорировать `proxy_ssl_server_name on` — без него TLS-рукопожатие с Supabase упадёт (SNI обязателен для shared TLS termination AWS).

## 11. Итог

После выполнения этой инструкции:

- `https://api.komui.ru/rest/...` и `https://api.komui.ru/functions/...` стабильно работают из РФ.
- Фронт магазина переключают на этот домен и каталог + чек-аут перестают ломаться у российских пользователей.
- Supabase как был, так и остаётся источником правды; ничего там не меняется.
