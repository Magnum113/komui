# Дополнительные требования владельца — 26 июня 2026

## 1. Staging-домен

Целевой URL тестовой реализации: `stage.komui.ru`.

Текущее состояние DNS: A/CNAME для `stage.komui.ru` не найден.

Нужно вручную добавить у DNS-провайдера:

```text
type: A
name: stage
value: 89.111.152.112
ttl: 300
```

После распространения DNS можно:

- добавить `stage.komui.ru` в Nginx staging server_name;
- выпустить Let's Encrypt certificate;
- оставить Basic Auth/noindex;
- проверить, что `komui.ru` и `www.komui.ru` продолжают работать через текущий
  production-контур.

## 2. Возможность вернуть production на Vercel/Supabase

Требование реализуемо, но только с важным ограничением.

Если после cutover DNS `komui.ru` будет указывать на новый сервер, на сервере
можно сделать admin-controlled traffic fallback:

- режим `server`: трафик обслуживает новая реализация;
- режим `legacy`: Nginx проксирует трафик на текущий Vercel deployment, который
  продолжает работать с Supabase.

Это позволит вернуть сайт на старый контур без смены DNS, пока сервер доступен.

Если сервер полностью недоступен, admin-кнопка не поможет. Тогда нужен ручной
DNS-rollback у DNS-провайдера.

Для data-safe rollback нужно отдельно решить вопрос записей. Если после cutover
новые заказы/платежи пишутся только в server DB, простой traffic fallback на
Vercel/Supabase потеряет эти новые записи для старого контура. Поэтому на период
стабилизации нужны:

- dual-write критичных write-доменов в Supabase; или
- sync-back процедура перед rollback.

## 3. Импорт новых товаров из Ozon одной кнопкой

Требование реализуемо как admin job.

Правильная модель:

1. `Preview` — получить новые товары из Ozon и показать diff без записи.
2. `Import` — запустить server-side job.
3. Job пишет в обе базы: текущий Supabase и новую PostgreSQL.
4. Все шаги идемпотентны, чтобы повторный запуск не создавал дубли.
5. Partial failure виден в админке и лечится retry.
6. Каждая операция пишется в audit log.

Настоящей общей транзакции между Supabase и серверной PostgreSQL не будет.
Нужен saga/outbox-подход: фиксируем шаги, делаем retry, сверяем результат.

Для реализации понадобятся от владельца:

- Ozon Client-Id;
- Ozon API Key;
- Supabase server-side write credential;
- правила публикации товара: сразу active на витрине или сначала draft/review;
- правила маппинга Ozon-полей в `merch_products`,
  `merch_storefront_products`, inventory и images.

По умолчанию staging не должен писать в production Supabase. Real dual-write
включается только отдельной owner-командой.
