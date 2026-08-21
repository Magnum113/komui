# Импорт отзывов Ozon в KOMUI

Документ описывает текущую реализацию хранения отзывов Ozon на собственном
сервере KOMUI, ручную выгрузку без платной подписки Ozon Review API, перенос
фото/видео, сопоставление с карточками и безопасное повторное обновление.

## Текущее состояние

Первичная полная выгрузка выполнена 21 августа 2026 года.

- проверены помесячные отчёты с января 2025 по 21 августа 2026;
- январь–июль 2025 пусты, первый отзыв опубликован в августе 2025;
- в PostgreSQL импортируются только отзывы со статусом получения, отличным от
  `Отменён`/`Отменен`;
- отменённые отзывы не создаются и при повторной выгрузке скрывают ранее
  импортированную запись с тем же source key;
- отзывы сопоставлены с карточками по Ozon SKU и offer ID;
- при старом дубле карточки выбирается единственная активная карточка; если
  активных кандидатов несколько, импорт останавливает публикацию и оставляет
  конфликт для ручной проверки;
- имена покупателей и аватары не импортируются: публичное имя —
  `Покупатель Ozon`;
- сырые номера заказов не записываются в публичные таблицы — хранится только
  SHA-256; исходные CSV лежат в закрытом архиве с правами `0600`.

Актуальные количества нужно проверять SQL-запросами из раздела
«Проверка». Они будут расти после следующих импортов.

## Почему используется CSV + ручной сбор медиа

Текущий тариф Ozon Seller не даёт доступ к Review API. Стандартный отчёт
`Отзывы` содержит рейтинг, текст, точное время, SKU, offer ID, статус получения
и количество фото/видео, но не содержит:

- стабильный review ID;
- имя автора;
- URL и файлы фото/видео.

Поэтому данные собираются в два шага:

1. Помесячный CSV формирует полный перечень отзывов.
2. Только для строк с `Количество фото > 0` или `Количество видео > 0` медиа
   открываются в Ozon Seller и скачиваются отдельно.

При появлении доступа к Review API схема менять не потребуется: в ней заранее
есть `source_review_id`, source keys и поля исходных URL.

## Таблицы

Миграция:

```text
docs/server-migration/sql/ozon-reviews-forward.sql
```

### `public.merch_review_sync_runs`

Журнал каждого запуска импорта: период, checksum CSV, количество обработанных,
добавленных, обновлённых, отменённых и несопоставленных строк, количество медиа,
предупреждения и статус.

### `public.merch_storefront_reviews`

Нормализованные отзывы. Важные поля:

- `storefront_product_id` — связь с карточкой KOMUI;
- `source_review_key` — идемпотентный ключ;
- `source_review_id` — будущий ID из API;
- `source_order_reference_hash` — SHA-256 номера заказа;
- `source_sku`, `source_offer_id` — диагностика сопоставления;
- `rating`, `review_text`, `published_at`;
- `is_verified_purchase`;
- `mapping_status`, `moderation_status`, `is_published`;
- ожидаемые `photos_count` и `videos_count`.

### `public.merch_storefront_review_media`

Фото и видео отзывов:

- связь с отзывом через `review_id`;
- тип `image`/`video`;
- исходный URL только для технической сверки;
- локальный `storage_path` и публичный `public_url`;
- MIME, размер файла, checksum и необязательные размеры/длительность;
- порядок показа;
- статусы обработки и модерации;
- `is_suppressed` для ручного скрытия.

Повторный импорт обновляет запись, но не сбрасывает `is_suppressed`. Поэтому
скрытое вручную медиа не вернётся на сайт после следующей синхронизации.

## Файлы на сервере

```text
/var/lib/komui/review-media-cache/public/reviews/
/var/lib/komui/review-imports/private/
```

Медиа хранится content-addressed по SHA-256:

```text
/var/lib/komui/review-media-cache/public/reviews/<2 символа>/<sha256>/original.<ext>
/var/lib/komui/review-media-cache/public/reviews/<2 символа>/<sha256>/preview.<ext>
```

Публичный URL:

```text
https://komui.ru/media/reviews/<2 символа>/<sha256>/original.<ext>
```

Nginx отдаёт только каталог `public/reviews`. Закрытые CSV и номера заказов
никогда не попадают в web root.

## Публичный API

После backend-релиза отзывы доступны отдельно от каталога:

```http
GET /api/v1/products/:slug/reviews?limit=20&cursor=...
```

Ответ содержит:

- canonical product id/slug;
- общее количество и среднюю оценку;
- распределение оценок 1–5;
- количество отзывов с медиа;
- публичные отзывы и локальные URL фото/видео;
- `nextCursor` для keyset-пагинации.

API не отдаёт номер заказа, его hash, source payload, исходные URL Ozon,
storage paths или внутренние статусы.

## Повторная выгрузка

В Ozon Seller:

1. Открыть `Отзывы` → `Скачать отчёт`.
2. Выбрать `Отзывы`.
3. Формировать отчёты максимум по одному календарному месяцу.
4. Скачать все месяцы после последнего успешного импорта. Безопасно захватить
   предыдущий месяц повторно — импорт идемпотентный.
5. Для строк с медиа открыть отзыв, проверить `Получен` и `Виден всем`, скачать
   фото/видео и подготовить manifest.

Dry-run на сервере:

```bash
export DATABASE_URL="$(sudo sed -n 's/^DATABASE_URL=//p' /etc/komui/backend-production.env | tail -n 1)"
export NODE_PATH=/opt/komui/production-current/backend/node_modules

node /opt/komui/production-current/backend/dist/importOzonReviews.js \
  --csv /secure/path/reviews-2026-08.csv \
  --dry-run
```

Применение без медиа:

```bash
node /opt/komui/production-current/backend/dist/importOzonReviews.js \
  --csv /secure/path/reviews-2026-08.csv
```

Применение с медиа:

```bash
node /opt/komui/production-current/backend/dist/importOzonReviews.js \
  --csv /secure/path/reviews-2026-08.csv \
  --media-manifest /secure/path/media/manifest-2026-08.json
```

Формат manifest:

```json
{
  "version": 1,
  "items": [
    {
      "orderNumber": "из закрытого CSV",
      "sku": "Ozon SKU",
      "publishedAt": "2026-08-15T14:58:24Z",
      "media": [
        {
          "type": "image",
          "file": "2026-08/review-01.webp",
          "sourceUrl": "технический URL",
          "sourceMediaKey": "стабильный ключ",
          "width": 1200,
          "height": 1600
        }
      ]
    }
  ]
}
```

Для видео `file` указывает на локальный MP4/WebM, а `previewFile` — на
скачанную локальную обложку. Можно также указать `durationMs`, `width` и
`height`. Публичный API не использует Ozon URL как video poster.

Manifest и CSV содержат персонально связанную техническую информацию. Их нельзя
коммитить в Git, класть во frontend или пересылать в публичные логи.

## Проверка

```sql
select count(*) as reviews,
       count(*) filter (where is_published) as published,
       count(*) filter (where mapping_status = 'matched') as matched,
       count(*) filter (where source_delivery_status ~* '^отмен') as cancelled
from public.merch_storefront_reviews
where source = 'ozon';

select count(*) as media,
       count(*) filter (where media_type = 'image') as images,
       count(*) filter (where media_type = 'video') as videos,
       sum(file_size_bytes) as bytes
from public.merch_storefront_review_media;

select status, count(*)
from public.merch_review_sync_runs
group by status;
```

Ожидаемые инварианты:

- `published = matched = reviews` для текущей принятой выгрузки;
- `cancelled = 0`;
- нет `unmapped`/`conflict` среди опубликованных;
- сумма ожидаемых фото/видео совпадает с media rows;
- повторный импорт даёт `imported = 0`, увеличивает только `updated`, а
  `mediaImported = 0`;
- каждый `public_url` отвечает `200` и checksum файла совпадает с БД.

## Backup

`ops/server/komui-backup.sh` по умолчанию сохраняет обе базы
`komui_staging` и `komui_production`, а также:

```text
/var/lib/komui/review-media-cache
/var/lib/komui/review-imports
```

Архив шифруется AES-256 и отправляется в Yandex Object Storage. Исходные CSV
оказываются только внутри зашифрованного backup.

## Будущее развитие

1. При подключении Review API записывать `source_review_id` и получать изменения
   по курсору/API timestamp.
2. Сохранять CSV fallback как контроль полноты и способ восстановления.
3. Для новых медиа продолжать content-addressed хранение и проверку magic bytes.
4. Добавить в админку модерацию `is_published`, `moderation_status` и
   `is_suppressed` без физического удаления записей.
5. Отображать на товарной странице summary, отзывы, lightbox фото и нативный
   video player с lazy loading; аватар — локальная нейтральная заглушка.
