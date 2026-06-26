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

## До окна

- Объявить maintenance window.
- Проверить demo/test в последний раз.
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
