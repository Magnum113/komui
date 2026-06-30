# Этап 8. Production cutover — только по отдельному разрешению

## Цель

Переключить production на новый сервер с коротким контролируемым downtime и без split-brain.

## Зависимости

- Этап 7 имеет формальный `GO`.
- Владелец проверил staging самостоятельно.
- Владелец отдельным явным сообщением разрешил production cutover.
- DNS TTL снижен до 300 секунд за 3–7 дней.
- Схема заморожена.
- Есть свежий внешний backup.
- Есть доступ к DNS, Т-Банку, Supabase и серверу.
- Vercel deployment и Supabase project остаются активными минимум на период
  стабилизации.
- Подготовлен traffic fallback: новый сервер умеет временно проксировать
  production обратно на текущий Vercel/Supabase-контур.
- Определено, какие writes во время стабилизации dual-write'ятся обратно в
  Supabase, чтобы rollback после новых записей был безопасным.

Успешное завершение этапа 7, наличие рабочего staging или отсутствие замечаний
не дают автоматического разрешения на этот этап.

## Подготовка, выполненная до cutover

30 июня 2026 года выполнена безопасная подготовка production candidate без
переключения live `komui.ru`:

- `stage.komui.ru` оставлен отдельным тестовым контуром;
- создана отдельная БД `komui_production`;
- создан env `/etc/komui/backend-production.env`;
- поднят systemd service `komui-production-backend` на `127.0.0.1:3001`;
- создан separate static root `/var/lib/komui/production-root`;
- Nginx runtime snippet для production указывает на production root/backend;
- включён HTTP-only pre-cutover vhost для Host `komui.ru` / `www.komui.ru`;
- HTTPS vhost подготовлен, но не включён, потому что cert для `komui.ru` можно
  выпустить только после DNS switch или DNS-01 validation;
- helper для TLS/cert включения:
  `/usr/local/sbin/komui-production-issue-cert-and-enable`.

Проверено на loopback:

```text
http://127.0.0.1:3001/health/ready                      HTTP 200
Host komui.ru http://127.0.0.1/                         HTTP 200
Host komui.ru http://127.0.0.1/checkout                 HTTP 200
Host komui.ru http://127.0.0.1/api/v1/products?limit=1  HTTP 200
```

Это не является production cutover. DNS, production webhook Т-Банка и Vercel /
Supabase live-контур не изменялись.

30 июня 2026 года выполнен final production snapshot candidate:

- `komui_production` обновлена из `komui_staging`;
- предыдущая candidate DB сохранена как
  `komui_production_prev_20260630163957`;
- encrypted backup production DB:
  `/var/backups/komui/daily/komui-backup-20260630T164013Z.tar.gz.gpg`;
- external object:
  `s3://komui-backups/komui/stage/komui-backup-20260630T164013Z.tar.gz.gpg`;
- restore drill production snapshot: OK;
- T-Bank в candidate оставлен в demo/test mode;
- CDEK auto-create включён: `CDEK_CREATE_SHIPMENTS=true`.

Ограничение: `komui_production` создана из staging и содержит staging
test orders/payments/CDEK rows. Cleanup этих строк перед DNS cutover выполнять
только по отдельному явному разрешению.

30 июня 2026 года после ручного DNS switch владельцем:

- `komui.ru` и `www.komui.ru` резолвятся в `89.111.152.112`;
- Let's Encrypt certificate для `komui.ru` / `www.komui.ru` выпущен;
- HTTPS vhost `komui-production-switch` включён;
- traffic switch status: `state=applied`, `mode=server`,
  `productionVhostEnabled=true`;
- публичные smoke checks `https://komui.ru`, `/checkout`, `/payment-result`,
  `/api/v1/products?limit=1`, `/api/delivery-config`, `robots.txt`,
  `sitemap.xml` вернули HTTP `200`.

Production DNS/TLS часть cutover выполнена. Остаётся T-Bank webhook/test
payment и наблюдение.

## До окна

- Объявить maintenance window.
- Проверить demo/test в последний раз.
- Обновить или явно принять `komui_production`; текущая БД является clone
  текущего staging и содержит staging transactional rows.
- Зафиксировать source row counts.
- Проверить свободный диск и backup destination.
- Подготовить maintenance page.
- Открыть monitoring dashboards/logs.

## Порядок переключения

1. Включить maintenance для checkout.
2. Остановить все известные записи в source.
3. Зафиксировать время cutover.
4. Выполнить финальный consistent dump.
5. Восстановить production target.
6. Применить post-restore cleanup/grants.
7. Сравнить row counts и контрольные суммы.
8. Запустить backend.
9. Запустить frontend release.
10. Проверить localhost smoke tests.
11. Проверить внешний HTTPS.
12. Обновить webhook Т-Банка.
13. Переключить DNS.
14. Проверить новый endpoint с разных резолверов.
15. Выполнить demo или разрешённый минимальный production test.
16. Включить checkout.
17. Наблюдать первый реальный заказ.

## Admin fallback mode

Требование владельца: в админке должна быть возможность вернуть production на
текущий Vercel/Supabase-контур.

Реализация допускается только как контролируемый traffic fallback:

- production DNS после cutover указывает на новый сервер;
- Nginx на сервере имеет два upstream: `server` и `legacy`;
- `legacy` проксирует на текущий Vercel deployment, который продолжает работать
  с Supabase;
- admin action меняет только заранее подготовленный runtime mode;
- перед reload выполняется `nginx -t`;
- действие записывается в audit log;
- есть команда мгновенного возврата `legacy -> server`.

Ограничения:

- если сам сервер недоступен, admin fallback недоступен — нужен ручной
  DNS-rollback у DNS-провайдера;
- traffic fallback не решает проблему данных, если после cutover появились
  новые заказы/платежи только в server DB;
- для data-safe rollback во время стабилизации нужны либо dual-write критичных
  write-доменов в Supabase, либо отдельная sync-back процедура.

## Контроль после включения

Первые 2 часа:

- все 5xx;
- CPU/RAM/disk;
- DB connections;
- payment attempts;
- webhook;
- CDEK;
- promo reservations;
- DNS traffic;
- старые Supabase invocations.

Первые 24 часа:

- сверка заказов с Т-Банком;
- backup;
- pending/failed orders;
- frontend errors;
- SEO/static availability.

## Критерии успеха

- Новый заказ полностью проходит.
- Валидный webhook получен.
- Заказ становится paid.
- Shipment создаётся однократно.
- Payment status доступен клиенту.
- Source больше не получает writes.

## Rollback до новых записей

- Оставить checkout выключенным.
- Вернуть DNS.
- Вернуть старый webhook.
- Включить старую инфраструктуру.

## Rollback после новых записей

Нельзя просто вернуть DNS.

1. Отключить checkout.
2. Экспортировать новые orders/items/attempts/events/promos/shipments.
3. Сверить с Т-Банком.
4. Согласовать перенос новых записей в source.
5. Проверить sequence/unique conflicts.
6. Только затем возвращать DNS/webhook.

## NO-GO во время окна

- row counts расходятся;
- target не проходит smoke tests;
- webhook нельзя переключить;
- DNS недоступен;
- backup не завершён;
- неизвестный клиент продолжает писать в source.
