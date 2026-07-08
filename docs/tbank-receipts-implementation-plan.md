# План реализации чеков Т-Бизнеса для KOMUI

## Цель

Сделать полный рабочий контур: заказ на сайте → платёж Т-Банк → электронный чек Т-Бизнеса → webhook оплаты → заказ в СДЭК.

Текущий выбранный вариант — использовать подключённую услугу **«Чеки Т-Бизнеса»**, без отдельной облачной кассы.

## Что должен делать сайт

1. Собирать у покупателя данные, нужные для заказа и чека:
   - имя;
   - фамилия;
   - телефон;
   - email для электронного чека;
   - согласие с офертой и обработкой персональных данных.

2. Передавать в backend checkout payload с email.

3. Не доверять цене из браузера: backend пересчитывает товары, доставку, скидку и итоговую сумму по серверной базе.

## Что должен делать backend

1. Валидировать email.

2. Сохранять email в `public.merch_customer_orders.customer_email`.

3. При вызове T-Банк `/v2/Init` передавать:
   - `DATA.Phone`;
   - `DATA.Email`;
   - `Receipt.Phone`;
   - `Receipt.Email`;
   - `Receipt.Taxation`;
   - `Receipt.Items`.

4. Использовать текущие env-параметры:

```env
TBANK_MODE=production
TBANK_MOCK_PAYMENTS=false
TBANK_TAXATION=usn_income
TBANK_TAX=none
```

Если система налогообложения или НДС изменятся, значения `TBANK_TAXATION` и `TBANK_TAX` нужно поменять до приёма реальных платежей.

## Receipt mapping

Товары:

```json
{
  "Name": "Название товара · Размер",
  "Price": 290000,
  "Quantity": 1,
  "Amount": 290000,
  "PaymentMethod": "full_prepayment",
  "PaymentObject": "commodity",
  "Tax": "none"
}
```

Доставка:

```json
{
  "Name": "Доставка СДЭК",
  "Price": 35000,
  "Quantity": 1,
  "Amount": 35000,
  "PaymentMethod": "full_prepayment",
  "PaymentObject": "service",
  "Tax": "none"
}
```

Сумма всех `Receipt.Items.Amount` должна совпадать с `Amount` платежа.

## Изменения БД

Добавляется колонка:

```sql
alter table public.merch_customer_orders
  add column if not exists customer_email text;
```

И индекс для поиска заказов по email:

```sql
create index if not exists merch_customer_orders_email_created_idx
  on public.merch_customer_orders (customer_email, created_at desc)
  where customer_email is not null;
```

## Админка

Backend API заказов должен возвращать:

```json
{
  "customer": {
    "firstName": "...",
    "lastName": "...",
    "phone": "...",
    "email": "..."
  }
}
```

Поиск заказов должен искать и по `customer_email`.

## Тестовый товар

Для безопасной проверки реальной оплаты добавляется тестовый товар:

- название: `Тестовый товар для проверки чека`;
- цена товара: `10 ₽`;
- размер: `ONE SIZE`;
- slug: `/p/testovyi-tovar-dlya-proverki-cheka-10-rub`;
- `design_key`: `test|receipt|tshirt|black`;
- `sort_order`: `999999`, чтобы товар был в конце каталога;
- badge: `TEST`.

Важно: итоговая сумма платежа будет больше 10 ₽, если выбранная доставка СДЭК не бесплатная.

## Тестовый сценарий

1. Открыть товар `/p/testovyi-tovar-dlya-proverki-cheka-10-rub`.
2. Добавить размер `ONE SIZE` в корзину.
3. Оформить заказ.
4. Указать реальные телефон и email.
5. Выбрать пункт СДЭК.
6. Перейти к оплате.
7. Проверить:
   - T-Банк создал платёж;
   - покупатель получил электронный чек;
   - в личном кабинете Т-Бизнеса у платежа есть чек;
   - backend получил webhook;
   - заказ перешёл в `paid`;
   - СДЭК-отправление создалось.

## Риски и проверки

1. Если T-Банк снова вернёт `request.validate.expected.receipt`, значит `Receipt` не дошёл или услуга чеков настроена не полностью.

2. Если вернёт ошибку по `Taxation` или `Tax`, нужно сверить значения с настройками организации в Т-Бизнесе.

3. Если чек не пришёл покупателю, проверить:
   - email в заказе;
   - статус платежа в Т-Бизнесе;
   - раздел чеков в личном кабинете;
   - `request_payload` и `response_payload` в `merch_payment_attempts`.

4. Если товары попадут под обязательную маркировку, текущий простой `Receipt` может быть недостаточен. Нужно отдельно проработать передачу маркировочных кодов.
