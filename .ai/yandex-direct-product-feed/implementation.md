# Реализация этапов 1–2

Дата: 2026-08-20.

## Выполнено

- Зафиксировано правило: каждый товар, отображаемый на сайте (`is_active = true`), получает `available="true"` независимо от `archived`/`visible` SKU.
- Добавлен отдельный запрос всех активных товаров без лимита public API в `server/src/catalog.ts`.
- Добавлено чтение width/height/format/file size из media manifest в `server/src/mediaManifest.ts`.
- Добавлен pure YML generator `server/src/yandexDirectFeed.ts`.
- Добавлен внутренний endpoint `GET /v1/feeds/yandex-direct.yml` в `server/src/app.ts`.
- Endpoint отдаёт XML UTF-8, inline filename и `Cache-Control: no-cache`.
- При ошибках обязательных данных генератор не публикует частичный feed; endpoint возвращает HTTP 503 с перечнем проблем.

## Содержимое feed

- один offer на один active product;
- UUID product как offer ID;
- `available="true"` для каждого offer;
- актуальная и старая цены;
- RUB;
- фиксированные категории одежды;
- до пяти изображений от 450 px по каждой стороне и до 10 MB;
- фактологическое описание;
- цвет, международные размеры и тип нанесения;
- четыре существующие collection landing pages.

## Проверка

- `npm --prefix server run build` — успешно.
- `npm --prefix server test` — 49/49 тестов успешно.
- Генерация на фактических 33 production products — успешно.
- 33 offer, у всех `available="true"` и UUID ID.
- 3–5 изображений на offer.
- Невалидное изображение 750x437 исключено.
- Внешних `ir.ozone.ru` URL нет.
- `xmllint --noout` — успешно.
- Внутренний Fastify endpoint через inject — HTTP 200, `application/xml; charset=utf-8`.

## Не выполнено в рамках этапов 1–2

- отдельный автоматический test suite для feed;
- production deployment;
- healthcheck и загрузка в Яндекс Директ.

## Реализация этапа 3

- В `ops/server/komui-traffic-switch-apply.sh` добавлен exact nginx route `/feeds/yandex-direct.yml`.
- Route проксирует на локальный backend `127.0.0.1:3001/v1/feeds/yandex-direct.yml` с теми же proxy headers и timeout, что production API.
- В `robots.txt` добавлен `Allow: /feeds/yandex-direct.yml`.
- То же правило добавлено в `renderRobots()` файла `scripts/build-products.js`, чтобы оно сохранялось после каждого static build.
- Feed не размещается внутри immutable frontend release отдельным статическим файлом.

Проверка этапа 3:

- `bash -n ops/server/komui-traffic-switch-apply.sh` — успешно.
- `node --check scripts/build-products.js` — успешно.
- `git diff --check` — успешно.

Active production nginx snippet не изменялся: backend с новым route ещё не задеплоен. Установка обновлённого ops script, генерация snippet, `nginx -t` и reload должны выполняться атомарно на этапе 5.

## Реализация этапа 4

- Добавлен `server/test/yandexDirectFeed.test.ts` с тестами детерминированного YML, escaping/control chars, порядка секций, цен, категорий, URL, изображений, размеров и collections.
- Зафиксировано тестом, что каждый active product получает `available="true"` независимо от legacy-флагов SKU, а inactive product исключается.
- Проверены обязательные ошибки: duplicate ID, неположительная цена, неизвестная категория и отсутствие подходящего изображения.
- Проверены фильтры изображений: минимум 450×450, максимум 10 MB, допустимый формат, отсутствие Ozon URL и лимит пяти pictures.
- Проверено отсутствие SQL `LIMIT` в feed query и генерация 205 уникальных offer без truncation.
- Endpoint проверен через Fastify inject: успешный XML-ответ с нужными headers и HTTP 503 при невалидных исходных данных.
- Добавлен повторяемый аудит `npm run audit:yandex-feed`, работающий с текущим публичным production-каталогом.

### Результаты проверок 2026-08-20

- `npm --prefix server test` — 54/54 успешно.
- `npm --prefix server run build` — успешно.
- `git diff --check` — успешно.
- live audit — 33 products, 33 offers, у всех `available="true"`.
- 33/33 product pages отвечают и содержат соответствующий UUID и e-commerce payload.
- Проверено 161 уникальное исходное изображение; в feed выбрано 138 уникальных изображений (163 в offer с повторами между товарами).
- Единственное изображение, не прошедшее техническую политику, имеет размер 750×437 и корректно исключено.
- 33 oldprice, 150 size params, 4 collections, 0 Ozon URLs.
- `xmllint` — успешно; итоговый XML на текущих данных 58 607 bytes.
