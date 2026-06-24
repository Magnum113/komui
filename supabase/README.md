# Интернет-эквайринг Т-Банка

В проекте используются три Supabase Edge Function:

- `tbank-create-payment` — проверяет заказ, пересчитывает сумму по данным Supabase и вызывает `v2/Init`;
- `tbank-webhook` — проверяет подпись уведомления Т-Банка и обновляет статус оплаты;
- `tbank-payment-status` — возвращает клиенту безопасный статус заказа.

## Обязательные секреты

В локальном `.env.local` и в Supabase Edge Function Secrets должны быть заданы:

```dotenv
TBANK_DEMO_TERMINAL_KEY=...
TBANK_DEMO_PASSWORD=...
```

Секреты нельзя добавлять во frontend-код или коммитить в Git.

Для загрузки секретов через Supabase CLI создайте отдельный временный env-файл только с переменными Т-Банка и выполните:

```sh
supabase secrets set --project-ref bkxpzfnglihxpbnhtjjq --env-file /absolute/path/to/tbank-secrets.env
```

## Онлайн-касса

Если терминал работает с онлайн-кассой, дополнительно задайте:

```dotenv
TBANK_TAXATION=...
TBANK_TAX=...
```

`TBANK_TAXATION` — система налогообложения магазина, `TBANK_TAX` — ставка НДС товарных позиций. Пока эти параметры не заданы, `Receipt` в запрос `Init` не отправляется.

## Callback URL

Функция `tbank-create-payment` передает в Т-Банк адрес webhook автоматически:

```text
https://bkxpzfnglihxpbnhtjjq.supabase.co/functions/v1/tbank-webhook
```

Webhook не доверяет URL успешной оплаты: заказ становится оплаченным только после корректно подписанного уведомления со статусом `CONFIRMED`.

## Проверка

После настройки секретов:

1. Откройте `/checkout` с `https://komui.ru` или локального сервера.
2. Заполните контактные данные, выберите пункт выдачи и подтвердите заказ.
3. Завершите тестовую оплату на платежной форме Т-Банка.
4. Проверьте таблицы `merch_customer_orders`, `merch_payment_attempts` и `merch_payment_events`.
