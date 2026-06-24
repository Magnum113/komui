# Интернет-эквайринг Т-Банка

В проекте используются Supabase Edge Function:

- `tbank-create-payment` — проверяет заказ, пересчитывает сумму по данным Supabase и вызывает `v2/Init`;
- `tbank-webhook` — проверяет подпись уведомления Т-Банка и обновляет статус оплаты;
- `tbank-payment-status` — возвращает клиенту безопасный статус заказа.
- `cdek-delivery-points` — ищет города и пункты выдачи СДЭК;
- `cdek-delivery-quote` — серверно пересчитывает стоимость доставки СДЭК по выбранному ПВЗ и корзине.

## Обязательные секреты

В локальном `.env.local` и в Supabase Edge Function Secrets должны быть заданы:

```dotenv
TBANK_DEMO_TERMINAL_KEY=...
TBANK_DEMO_PASSWORD=...
CDEK_LOGIN=...
CDEK_PASSWORD=...
```

Секреты нельзя добавлять во frontend-код или коммитить в Git.

Для загрузки секретов через Supabase CLI создайте отдельный временный env-файл только с переменными Т-Банка и выполните:

```sh
supabase secrets set --project-ref bkxpzfnglihxpbnhtjjq --env-file /absolute/path/to/tbank-secrets.env
```

Для СДЭК нужны также операционные параметры отправителя:

```dotenv
CDEK_API_BASE_URL=https://api.cdek.ru
CDEK_DELIVERY_MODES=4
CDEK_SHIPMENT_CITY=Махачкала
CDEK_SHIPMENT_CITY_CODE=
CDEK_SHIPMENT_ADDRESS=ул. Сурикова, 77
CDEK_SHIPMENT_POINT=MKHCH20
CDEK_SENDER_NAME=Komui
CDEK_SENDER_PHONE=+79995330015
CDEK_PACKING_HEIGHT_EXTRA_CM=1
CDEK_TARIFF_CODE=
```

`CDEK_SHIPMENT_CITY_CODE` и `CDEK_TARIFF_CODE` можно оставить пустыми: функция сама отправит город отправления и выберет самый дешёвый тариф из разрешённого режима `4` (ПВЗ → ПВЗ). Если СДЭК вернёт неоднозначный город или другой тариф нужен по договору, задайте эти значения явно.

## СДЭК

Checkout работает по схеме:

1. Storefront открывает собственный выбор ПВЗ на Leaflet/OpenStreetMap.
2. `cdek-delivery-points` получает город и список ПВЗ через CDEK API, не раскрывая `CDEK_LOGIN`/`CDEK_PASSWORD` в браузере.
3. Пользователь выбирает ПВЗ.
4. `cdek-delivery-quote` считает доставку по текущей корзине, статичным профилям упаковки и выбранному ПВЗ.
5. `tbank-create-payment` повторно проверяет ПВЗ и заново считает доставку на сервере перед созданием платежа.
6. После успешного webhook от Т-Банка `tbank-webhook` автоматически создаёт заказ в СДЭК.
7. Статус создания накладной сохраняется в `merch_cdek_shipments`.

Перед деплоем функций примените миграции, включая `20260624205358_add_cdek_shipments.sql`. Без этой таблицы `tbank-payment-status` и автоматическое создание заказа СДЭК будут падать.

После миграций задеплойте функции:

```sh
supabase functions deploy cdek-delivery-points --project-ref bkxpzfnglihxpbnhtjjq
supabase functions deploy cdek-delivery-quote --project-ref bkxpzfnglihxpbnhtjjq
supabase functions deploy tbank-create-payment --project-ref bkxpzfnglihxpbnhtjjq
supabase functions deploy tbank-webhook --project-ref bkxpzfnglihxpbnhtjjq
supabase functions deploy tbank-payment-status --project-ref bkxpzfnglihxpbnhtjjq
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
4. Проверьте таблицы `merch_customer_orders`, `merch_payment_attempts`, `merch_payment_events` и `merch_cdek_shipments`.
