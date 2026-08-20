# План реализации YML-фида для Яндекс Директа

## Статус

- Этап 1 — реализован: правила публикации зафиксированы в документации и коде.
- Этап 2 — реализован локально: добавлены feed query, YML-генератор и внутренний backend endpoint.
- Этап 3 — реализован в source-controlled конфигурации: добавлены внешний nginx route и robots allow. Применение active production snippet отложено до этапа 5, чтобы не публиковать 404 до деплоя backend.
- Этап 4 — реализован: добавлены автоматические тесты и повторяемый live-аудит production-каталога.
- Этапы 5–7 — не выполнялись.

## Целевой результат

- Публичная ссылка: `https://komui.ru/feeds/yandex-direct.yml`.
- Формат: YML/XML, UTF-8.
- Источник истины: production PostgreSQL `merch_storefront_products`.
- Обновление: live при запросе; Яндекс повторно скачивает feed раз в сутки.
- На текущих данных: 33 offer — по одному на каждую активную товарную страницу.
- Идентификаторы offer совпадают с product ID в e-commerce Метрики.

## Этап 1. Зафиксировать правила публикации

1. Один YML offer = одна product page = один UUID `merch_storefront_products.id`.
2. Варианты размеров не превращать в отдельные рекламные offer; передавать их как `param` с `unit="INT"`.
3. Для каждого товара, отображаемого в публичном каталоге сайта (`is_active = true`), всегда формировать `<offer ... available="true">`.
4. Не использовать `archived`, `visible` или отсутствующий числовой остаток для вычисления `available` в первой версии.
5. Публиковать active product только при выполнении технических условий:
   - положительная цена;
   - непустые name и slug;
   - product page существует;
   - есть хотя бы одно подходящее изображение.
6. `oldprice` публиковать только если `compare_at_price > price` и старая цена отображается на странице.
7. Зафиксировать числовые category IDs и не менять их после запуска.

## Этап 2. Реализовать генератор

Предлагаемые изменения:

- `server/src/yandexDirectFeed.ts`
  - типы feed product/category/collection;
  - безопасное XML escaping;
  - удаление запрещённых управляющих символов;
  - формат цены и даты;
  - преобразование relative media URL в absolute HTTPS;
  - фильтр изображений;
  - нейтральное фактологическое описание;
  - рендер `currencies`, `categories`, `offers`, `collections`.
- `server/src/catalog.ts`
  - отдельный feed query без public API limit=200;
  - выбрать только нужные поля;
  - не допускать молчаливого truncation;
  - при необходимости вернуть media metadata из manifest для проверки размеров.
- `server/src/app.ts`
  - `GET /v1/feeds/yandex-direct.yml`;
  - `Content-Type: application/xml; charset=utf-8`;
  - `Content-Disposition: inline; filename="yandex-direct.yml"`;
  - `Cache-Control: no-cache` или короткий cache;
  - при нарушении инвариантов отдавать 503, а не частичный/сломанный XML.

Feed должен включать:

1. `yml_catalog date` — фактическое время генерации.
2. `shop`:
   - name: `KOMUI`;
   - company: `ИП Кадимагомедов Магомедсайгид Алиевич`;
   - url: `https://komui.ru`.
3. currency `RUB`, rate `1`.
4. категории `Одежда -> Футболки/Худи/Свитшоты`.
5. offers с name, URL, price, optional oldprice, currency, category, up to five pictures, description, vendor/type, color/sizes/decoration и collectionId.
6. collections для четырёх существующих landing pages.

## Этап 3. Публичный URL вне `/api/`

1. В `ops/server/komui-traffic-switch-apply.sh` добавить exact location:

   `location = /feeds/yandex-direct.yml`

   с proxy на `http://127.0.0.1:3001/v1/feeds/yandex-direct.yml`.
2. Те же proxy headers/timeouts, что у `/api/`.
3. В `scripts/build-products.js` и `robots.txt` добавить явный `Allow: /feeds/yandex-direct.yml` перед `Disallow: /api/`.
4. Применить runtime snippet штатной server-ops процедурой, выполнить `nginx -t`, затем reload.
5. Не класть feed в immutable frontend release и не писать его cron-ом внутрь symlink-каталога.

## Этап 4. Тесты

Статус: выполнено 2026-08-20.

Добавить `server/test/yandexDirectFeed.test.ts` и покрыть:

- XML declaration стоит с первого символа;
- ровно один root `yml_catalog`;
- фиксированная дата в тесте рендерится правильно;
- обязательный порядок currencies/categories/offers;
- экранирование `& < > " '` и удаление control chars;
- UUID offer IDs уникальны;
- offer ID совпадает с product UUID;
- categoryId числовой и известный;
- URL абсолютные HTTPS и без пробелов;
- price > 0, oldprice > price;
- currencyId присутствует при price;
- от одного до пяти изображений на offer;
- изображение 750x437 исключается;
- каждый размер имеет `unit="INT"`;
- каждый active product получает `available="true"` независимо от `archived`/`visible` его SKU;
- inactive product не рекламируется;
- нет `ir.ozone.ru`;
- количество сгенерированных offer совпадает с ожидаемым количеством, нет лимита 200.

Интеграционная проверка:

1. `npm --prefix server test`.
2. `npm --prefix server run build`.
3. `xmllint --noout` для ответа endpoint.
4. Собственный feed audit: обязательные поля, дубликаты, цены, абсолютные URLs.
5. HTTP-проверка всех product URLs и всех переданных pictures.
6. Проверка dimensions/type/size pictures.
7. Сравнение offer IDs с e-commerce payload Метрики.

## Этап 5. Staging и production

1. Деплой на staging существующим `komui-deploy-from-git stage`.
2. Проверить endpoint напрямую на backend и через staging nginx.
3. Снять пример YML, проверить вручную несколько товаров разных категорий.
4. Деплой production существующим immutable deploy flow.
5. Применить source-controlled nginx runtime update.
6. Проверить публичный URL:
   - HTTP 200;
   - XML content type;
   - UTF-8;
   - offer count 33 на текущем каталоге;
   - цена/oldprice/размеры совпадают с product page;
   - feed не закрыт robots и не требует авторизацию.
7. Добавить проверку feed в `ops/server/komui-healthcheck.sh`:
   - URL отвечает 200;
   - XML парсится;
   - есть хотя бы один offer;
   - count не расходится с feed-eligible products;
   - нет внешних Ozon URLs.

## Этап 6. Подключение в Яндекс Директе

1. Директ -> Библиотека -> Фиды -> Добавить фид.
2. Выбрать «Ссылка на файл».
3. Указать `https://komui.ru/feeds/yandex-direct.yml` без логина/пароля.
4. Выбрать YML / продажа товаров.
5. Дождаться статуса валидации и скачать отчёт об ошибках/предупреждениях.
6. Исправить blocker-ошибки до привязки к кампании.
7. В тестовой товарной кампании проверить:
   - распознанные товары и категории;
   - карточки изображений;
   - текущие и старые цены;
   - фильтры по category/title/decoration;
   - ссылки и UTM-параметры;
   - работу offer retargeting по UUID.
8. После 1–2 автоматических обновлений сравнить время загрузки feed в Директе с `updated_at` каталога.

## Этап 7. Эксплуатация

- Недельный timer не нужен: endpoint всегда строится из live DB, Директ забирает его ежедневно.
- Пока товар отображается на сайте, feed всегда передаёт для него `available="true"`.
- При изменении товара следить, чтобы одновременно обновлялись страница, checkout и feed.
- При внедрении реальных остатков добавить `stock_quantity`/`in_stock` на уровне SKU и использовать один общий availability helper во frontend, checkout, JSON-LD и YML.
- При изменении изображения URL должен меняться; content-hash media-cache уже обеспечивает это.
- Не менять offer UUID для существующего товара: Яндекс связывает историю с feed ID + offer ID.

## Критерии готовности

- Публичный URL стабильно отвечает 200 без авторизации.
- YML проходит XML и Яндекс-валидацию без blocker-ошибок.
- Все опубликованные товары имеют рабочую страницу и минимум одно валидное изображение.
- Цены и oldprice совпадают с сайтом; каждый отображаемый на сайте товар имеет `available="true"`.
- Offer IDs совпадают с e-commerce ID Метрики.
- Автообновление подтверждено повторным скачиванием Яндексом.
- Healthcheck обнаруживает пустой, битый или недоступный feed.
