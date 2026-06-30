# KOMUI server project overview

Основной актуальный документ по серверной реализации находится здесь:

- [docs/server-migration/SERVER_PROJECT_OVERVIEW.md](docs/server-migration/SERVER_PROJECT_OVERVIEW.md)

Этот корневой файл оставлен как стабильная точка входа для разработчиков и
агентов. Все существенные изменения серверной реализации нужно описывать в
основном документе выше.

Последнее крупное обновление: 30 июня 2026 — server-side создание CDEK
shipment, admin retry endpoint, ожидание трек-номера и кнопка отслеживания СДЭК
на странице результата оплаты. Также исправлен повтор оплаты после failed
payment: stale payment draft очищается, а checkout создаёт новый платёж вместо
переиспользования старой отклонённой ссылки Т-Банка. Для диагностики добавлены
structured logs всего CDEK shipment flow. На staging включено
`CDEK_CREATE_SHIPMENTS=true`; заказ `KOM-879480584` создан в CDEK с номером
`10288069122`. Backend также подтягивает `cdek_number` follow-up запросом, если
первичный ответ CDEK пришёл как `ACCEPTED` без номера.
