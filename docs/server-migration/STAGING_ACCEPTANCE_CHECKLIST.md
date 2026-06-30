# KOMUI staging acceptance checklist

Дата актуализации: 30 июня 2026 года.

URL:

```text
https://stage.komui.ru
```

Логин/пароль staging хранятся на сервере в root-only файле и не записываются в
Git. Если нужно показать их владельцу, передать отдельно безопасным каналом.

## Важно

- Production `komui.ru` не переключён.
- Staging закрыт Basic Auth и `noindex`.
- Не запускать production cutover из результатов этой проверки.
- Финальная оплата на staging использует T-Bank demo terminal, но создаёт
  настоящий demo payment в кабинете Т-Банка.
- Реальные CDEK shipments на staging включены по явному разрешению владельца:
  `CDEK_CREATE_SHIPMENTS=true`. Любой оплаченный staging-заказ может создать
  реальное отправление CDEK.
- Ozon dual-write в Supabase выключен: `OZON_IMPORT_WRITE_SUPABASE=false`.

## Подтверждено 30 июня 2026 года

- [x] T-Bank demo payment/webhook E2E прошёл на staging.
- [x] Повтор оплаты после failed payment не переиспользует старую failed-ссылку.
- [x] CDEK shipment создаётся после paid webhook.
- [x] Для заказа `KOM-879480584` создан CDEK заказ `10288069122`.
- [x] Backend подтягивает `cdek_number` follow-up запросом, если первичный ответ
  CDEK приходит как `ACCEPTED` без номера.
- [x] Свежий encrypted backup создан и загружен в Yandex Object Storage.
- [x] Restore drill из свежего backup прошёл успешно.

## Проверка витрины

- [x] Открывается `https://stage.komui.ru`.
- [x] Без логина/пароля страница не открывается.
- [x] Каталог API загружается через `stage.komui.ru/api/v1/products`.
- [x] Видны товары и цены.
- [ ] Работают фильтры по категории.
- [ ] Работают фильтры по коллекции.
- [ ] Работает поиск.
- [ ] Открывается карточка/quick view товара.
- [ ] Галерея товара переключается.
- [x] Товар добавляется в корзину.
- [x] Корзина показывает правильный товар, размер, количество и сумму.
- [x] Кнопка оформления ведёт на `/checkout`.

## Checkout без оплаты

- [x] `/checkout` открывается.
- [x] Данные корзины перенеслись на checkout.
- [x] Ввод имени/фамилии/телефона работает.
- [x] Поиск города работает.
- [x] Пункты СДЭК загружаются.
- [x] Можно выбрать ПВЗ.
- [x] Расчёт доставки отображается.
- [ ] Невалидный промокод показывает корректную ошибку.
- [ ] Чекбоксы согласий работают.

## Payment status

- [x] `/payment-result` открывается.
- [x] Без session storage показывает безопасный статус проверки/обращения в
  поддержку, а не ошибку JS.
- [x] Успешная оплата показывает paid status.
- [x] Failed payment очищает stale payment draft и позволяет повторить оплату.
- [x] Для paid-заказа отображается статус создания CDEK shipment / трек-номер.

## SEO/static

- [ ] Открывается хотя бы одна product page `/p/...`.
- [ ] Открывается хотя бы одна collection page `/collections/...`.
- [ ] `https://stage.komui.ru/sitemap.xml` открывается.
- [ ] `https://stage.komui.ru/robots.txt` открывается.
- [ ] Визуально нет критичных broken images.

## Что пока не проверяется как готовое

- [ ] Ozon import preview/import — backend реализован, но нужна отдельная
  финальная приёмка маппинга и сценариев записи.
- [ ] Dual-write Ozon в Supabase — выключен флагом
  `OZON_IMPORT_WRITE_SUPABASE=false`; включать только отдельным решением
  владельца.
- [ ] Production cutover — запрещён без отдельного явного разрешения.

## Решение после проверки

Выбрать одно:

1. Доработать staging.
2. Оставить staging работающим без переноса production.
3. Отдельно разрешить подготовку production cutover этапа 8.

Успешная staging-проверка сама по себе не является разрешением на этап 8.
