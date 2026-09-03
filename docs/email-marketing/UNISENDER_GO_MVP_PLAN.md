# MVP-план интеграции Unisender Go с KOMUI

Дата: 1 сентября 2026 года

Статус: этапы 1–8 реализованы и развёрнуты; production работает, продолжается
наблюдение и расширение набора писем

Полный план: `UNISENDER_GO_INTEGRATION_PLAN.md`

## 1. Цель MVP

Подключить к KOMUI надёжную отправку email через Unisender Go с минимальным
объёмом собственной инфраструктуры.

MVP должен:

- отправлять письмо после успешной оплаты заказа;
- позднее отправлять письмо с трек-номером СДЭК;
- позволять делать рекламную рассылку только покупателям с явным согласием;
- учитывать отписки, hard bounce и жалобы;
- не допускать повторной отправки одного письма;
- не влиять на оплату, создание заказа и СДЭК при сбое Unisender;
- запрещать staging отправлять письма реальным покупателям;
- уведомлять владельца о неисправности через Telegram.

В MVP не создаются собственная CRM, редактор рассылок, конструктор шаблонов и
подробная аналитика открытий. Эти функции остаются в Unisender или переносятся
на следующие этапы.

## 2. Что уже есть

Текущий KOMUI уже:

- собирает и валидирует `customer_email` в checkout;
- сохраняет email в заказе;
- сохраняет отдельный `marketing_consent`;
- не требует рекламного согласия для покупки;
- содержит страницу `/marketing-consent`.

После первоначального MVP форма подписки в подвале подключена к backend. Она
использует Single Opt-In: два отдельных согласия и отправка формы сразу
активируют подписку и сохраняют append-only доказательство.

## 3. Границы MVP

### Входит в MVP

- DNS-аутентификация домена;
- один подтверждённый отправитель;
- API-клиент Unisender Go;
- одна таблица очереди;
- одна таблица блокировок email;
- простой worker;
- webhook для отписки, bounce и жалобы;
- шаблон `order_paid`;
- staging allowlist;
- минимальные Telegram-алерты;
- dry-run существующей аудитории.

### Не входит в MVP

- отдельная таблица CRM-контактов;
- локальная статистика открытий и переходов;
- собственная страница отписки;
- публичная форма подписки (реализована после первоначального MVP как
  Single Opt-In);
- редактор шаблонов;
- кампании и сегменты в GetoMerch;
- собственный CDP-профиль покупателя;
- сложные автоматические цепочки;
- отдельные таблицы всех provider events;
- персонализация на основе суммы и частоты покупок;
- отдельные адреса для каждого типа писем.

## 4. Целевая архитектура

```text
Т-Банк подтверждает оплату
            |
            v
Заказ атомарно становится paid
            |
            v
В email_outbox создаётся одно задание
            |
            v
Отдельный email worker
            |
            v
Unisender Go API
            |
            v
Письмо покупателю
```

Сбой Unisender не откатывает оплату, не меняет статус заказа и не мешает
созданию отправления СДЭК.

## Поэтапный план реализации

Работа разделена на восемь этапов. Новый этап начинается только после проверки
критериев завершения предыдущего. Исключение — подготовка текстов писем, которую
можно вести параллельно без включения отправки.

| Этап | Результат | Связанные разделы | Статус |
| --- | --- | --- | --- |
| 1. Провайдер и безопасная конфигурация | Домен, API и сервер готовы, отправка выключена | 5–6 | завершён; DNS и API проверены |
| 2. База и доказуемое согласие | Миграции outbox, suppression и полей согласия | 7–8 | завершён в production |
| 3. API-клиент и шаблон `order_paid` | Проверенный клиент и обе версии письма | 9, 11 | завершён в production |
| 4. Worker и событие оплаты | Надёжная очередь, повторы и отсутствие дублей | 10–11 | завершён в production |
| 5. Webhook и suppression | Отписки, bounce и жалобы блокируют отправку | 13–14 | завершён в production |
| 6. Наблюдаемость и Admin API | Healthcheck, Telegram и минимальный статус заказа | 16–17 | завершён в production |
| 7. Staging и приёмочные тесты | Безопасная отправка только на allowlist | 18–19 | завершён, включая Gmail и аутентификацию письма |
| 8. Production и расширение | `order_paid`, СДЭК и безопасная подписка | 12, 15, 19 | production включён; `order_paid` и Single Opt-In работают, идёт наблюдение |

### Этап 1. Провайдер и безопасная конфигурация

Задачи:

1. Проверить DNS-аутентификацию `komui.ru` и делегирование `email.komui.ru`.
2. Проверить API-ключ read-only запросом без вывода секрета.
3. Зафиксировать официальный HTTPS API endpoint и способ авторизации.
4. Сохранить production-настройки в root-owned env с
   `EMAIL_ENABLED=false`.
5. Подтвердить один адрес отправителя и рабочий `Reply-To`.
6. Определить staging allowlist и способ аутентификации webhook.

Критерии завершения:

- Unisender показывает ownership `confirmed` и DKIM `active`;
- в публичном DNS видны SPF, DKIM, DMARC и три NS технического домена;
- API-ключ успешно выполняет разрешённый read-only метод;
- env принадлежит `root:root`, имеет режим `0600`, секрет не попал в Git;
- production-отправка остаётся выключенной;
- согласованы `From`, `Reply-To` и staging allowlist.

Ход выполнения на 31 августа 2026 года:

- [x] `UNISENDER_GO_API_KEY` сохранён на production без вывода значения;
- [x] права `/etc/komui/backend-production.env` — `root:root 0600`;
- [x] официальный API endpoint зафиксирован как
  `https://goapi.unisender.ru/ru/transactional/api/v1`;
- [x] ключ проверен методом `domain/list`: HTTP 200;
- [x] Unisender API возвращает ownership `confirmed` и DKIM `active` для
  `komui.ru`;
- [x] production содержит `EMAIL_ENABLED=false`;
- [x] в публичном DNS видны DKIM и DMARC;
- [ ] опубликовать SPF `v=spf1 include:spf.unisender.ru ~all`;
- [ ] опубликовать NS `uns1/uns2/uns3.unisender.com` для `email.komui.ru`;
- [ ] проверить постоянную публикацию ownership TXT в DNS REG.RU;
- [ ] подтвердить, что `hello@komui.ru` разрешён как `From`;
- [x] `EMAIL_FROM` и рабочий `EMAIL_REPLY_TO` настроены на production и
  staging; конкретный адрес `Reply-To` не хранится в Git;
- [x] адрес владельца для staging allowlist настроен на сервере; само значение
  не хранится в Git;
- [x] способ аутентификации webhook зафиксирован по официальному контракту:
  MD5 поля `auth`, рассчитанный по точному строковому body с заменой значения
  `auth` на project API key; API-ключ и полный payload не журналируются.

Для текущего project API key отдельный `UNISENDER_GO_PROJECT_ID` не обязателен:
project key разрешён для обычных API-методов, но закономерно не имеет доступа к
методам управления проектами. Ключ передаётся в заголовке `X-API-KEY`.

### Этап 2. База и доказуемое согласие

Реализовано 31 августа 2026 года:

- [x] добавлены `marketing_consent_at`, `marketing_consent_version` и
  `marketing_consent_source` в серверную модель заказа;
- [x] серверный checkout записывает версию
  `checkout-email-marketing-v1` и источник `checkout` только при явно
  установленном необязательном чекбоксе;
- [x] для отказа от рассылки доказательные поля принудительно остаются `NULL`;
- [x] существующие согласия получают безопасную отметку `legacy_checkout`, не
  выдавая старые записи за новое согласие;
- [x] добавлена идемпотентная очередь `merch_email_outbox`;
- [x] добавлен реестр блокировок `merch_email_suppressions`;
- [x] прямой доступ браузерных ролей к обеим email-таблицам запрещён через
  права и RLS;
- [x] Admin API заказа возвращает доказательные поля без раскрытия новых
  секретов;
- [x] рядом с чекбоксом checkout добавлена ссылка на действующий текст
  согласия `/marketing-consent`, чекбокс остаётся выключенным по умолчанию;
- [x] миграция выполнена на реальной схеме `komui_staging` внутри транзакции и
  успешно отменена через `ROLLBACK`;
- [x] полный backend-набор из 233 тестов и TypeScript-сборка проходят;
- [x] legacy checkout flow не изменялись.

До контролируемого развёртывания этапа 2 остаётся:

1. применить миграцию сначала к `komui_staging` с резервной копией;
2. развернуть server backend на staging и оформить тестовый неоплачиваемый
   checkout с включённым и выключенным согласием;
3. проверить значения в заказах и Admin API;
4. только после этого повторить миграцию и deploy на production.

### Этап 3. API-клиент и шаблон `order_paid`

Реализовано 1 сентября 2026 года:

- [x] добавлена типизированная email-конфигурация без публикации API-ключа в
  `/health/ready`;
- [x] API URL разрешён только по HTTPS, запрос ограничен тайм-аутом;
- [x] API-ключ передаётся только в заголовке `X-API-KEY`;
- [x] клиент использует официальный метод `POST email/send.json`;
- [x] локальный idempotency key хешируется в стабильный provider key короче
  лимита 64 символа;
- [x] ответы `job_id` сохраняемы как provider message ID;
- [x] HTTP 429/5xx, сеть и `temporary_unavailable` классифицируются как
  временные ошибки, ошибки запроса и адреса — как постоянные, повторный
  idempotency key — как отдельное неоднозначное состояние;
- [x] полные email и API-ключ не включаются в диагностические сообщения;
- [x] вне production клиент запрещает отправку без `EMAIL_TEST_MODE=true`;
- [x] test mode разрешает получателей только из
  `EMAIL_ALLOWED_RECIPIENTS`;
- [x] создан HTML-шаблон, `text/plain`, subject и тестовая фикстура
  `order_paid`;
- [x] динамические значения экранируются перед вставкой в HTML;
- [x] письмо содержит только факты заказа и не содержит рекламы, промокодов и
  рекомендаций;
- [x] контракт API, ошибки, allowlist и шаблон покрыты автоматическими тестами;
  полный набор из 249 backend-тестов и TypeScript-сборка проходят;
- [x] legacy checkout flow не изменялся, фактическая отправка не подключена.

Официальная спецификация:

- <https://godocs.unisender.ru/web-api-ref>;
- endpoint:
  `https://goapi.unisender.ru/ru/transactional/api/v1/email/send.json`;
- успешный ответ: `status=success` и `job_id`.

Клиент намеренно не передаёт `skip_unsubscribe=1`, `track_links=0`,
`track_read=0` и bypass-флаги: по документации Unisender часть этих параметров
требует отдельного разрешения поддержки. До production нужно выяснить у
Unisender режим именно для служебных писем по заказу, чтобы рекламная отписка
не блокировала обязательное уведомление покупателя и при этом API не отклонял
payload.

До контролируемого развёртывания этапа 3 остаётся:

1. завершить staging-развёртывание этапа 2;
2. на этапе 7 включить staging только с allowlist владельца;
3. отправить тестовое письмо через реальный API;
4. проверить Gmail, Mail.ru, Яндекс Почту, мобильную вёрстку и заголовки
   SPF/DKIM/DMARC;
5. оставить production с `EMAIL_ENABLED=false` до готовности worker и
   атомарного события оплаты.

### Этап 4. Worker и событие оплаты

Реализовано 1 сентября 2026 года:

- [x] при первом переходе заказа в `paid` создаётся неизменяемый snapshot для
  `order_paid` с товарами, размерами, суммами и доставкой;
- [x] постановка выполняется внутри той же PostgreSQL-транзакции, что и
  подтверждение оплаты, без сетевого вызова Unisender;
- [x] учтены обе серверные ветки оплаты: подписанный webhook Т-Банка и
  reconciliation неопределённого `Init`;
- [x] стабильный ключ `order-paid:<order-id>` и уникальное ограничение outbox
  исключают повторное письмо при replay webhook или reconciliation;
- [x] worker выбирает задания через `FOR UPDATE SKIP LOCKED`, возвращает в
  работу только просроченные lease и не держит транзакцию во время HTTP-запроса;
- [x] завершение `sent`, `retry` и `failed` защищено сравнением `locked_by`,
  поэтому устаревший worker не может перезаписать результат нового;
- [x] временные ошибки повторяются через 5 минут, 30 минут и 4 часа; после
  четвёртой неудачной попытки задание становится `failed`;
- [x] повторный provider idempotency key после неоднозначного сетевого ответа
  завершает локальное задание как доставленное и не создаёт дубль;
- [x] невалидный snapshot и постоянная ошибка провайдера не повторяются;
- [x] `hard_bounce` и `spam_complaint` блокируют даже служебное письмо;
  обычная рекламная отписка не блокирует `order_paid`;
- [x] добавлены отдельные hardened systemd units для staging и production;
- [x] deploy-скрипт перезапускает email worker только если unit уже включён или
  запущен, поэтому текущий production не меняет поведение;
- [x] worker по умолчанию выключен через `EMAIL_WORKER_ENABLED=false`;
- [x] полный набор из 262 backend-тестов и TypeScript-сборка проходят;
- [x] legacy checkout flow не изменялись.

До контролируемого развёртывания этапа 4 остаётся:

1. применить миграцию этапа 2 к серверной staging-БД и развернуть matching
   backend;
2. установить unit `komui-email-worker.service`, но не включать production
   unit;
3. на этапе 7 включить `EMAIL_ENABLED=true` и
   `EMAIL_WORKER_ENABLED=true` только на staging с allowlist владельца;
4. проверить один реальный `order_paid`, повтор webhook и временную ошибку;
5. оставить production с `EMAIL_ENABLED=false` и
   `EMAIL_WORKER_ENABLED=false` до завершения приёмки.

### Этап 5. Webhook и suppression

Реализовано 1 сентября 2026 года:

- [x] добавлены `GET` и `POST /v1/webhooks/unisender-go`; публичный URL при
  текущем nginx-префиксе — `/api/v1/webhooks/unisender-go`;
- [x] `GET` всегда возвращает минимальный `200 OK`, необходимый Unisender для
  проверки callback URL, и не раскрывает конфигурацию;
- [x] `POST` по умолчанию выключен отдельным флагом
  `UNISENDER_GO_WEBHOOK_ENABLED=false`;
- [x] подпись проверяется штатным алгоритмом Unisender: MD5 точного строкового
  JSON после замены значения `auth` на API-ключ; сравнение выполняется с
  постоянным временем;
- [x] строковое тело сохраняется только в памяти на время проверки подписи;
  API-ключ, полный payload и email не попадают в логи;
- [x] размер callback ограничен 1 МиБ, а один вызов — 100 событиями согласно
  максимальному пакетному режиму провайдера;
- [x] обрабатываются только `unsubscribed`, `hard_bounced` и `spam` из
  `transactional_email_status`; открытия, клики, временные bounce и доменные
  spam-block события не копируются в PostgreSQL;
- [x] email нормализуется, а poison event с отсутствующим или невалидным
  адресом изолируется без повторной обработки всего корректно подписанного
  пакета;
- [x] suppression применяются идемпотентным `UPSERT`; приоритет причин:
  `manual` → `spam_complaint` → `hard_bounce` → `unsubscribed`, поэтому позднее
  слабое событие не снимает более строгую блокировку;
- [x] ожидающие marketing-задания адреса атомарно переводятся в `cancelled`;
  служебные задания не отменяются обычной отпиской;
- [x] пакет обрабатывается двумя bulk SQL-операциями в одной транзакции, чтобы
  укладываться в требование ответа `200 OK` не позднее трёх секунд;
- [x] replay callback безопасен: suppression остаётся одной записью, уже
  отменённые задания повторно не меняются;
- [x] неизвестные события отражаются только обезличенными счётчиками в
  backend audit-log; отдельная локальная аналитика provider events не
  создаётся;
- [x] контракт подписи, tamper, disabled mode, replay, приоритеты причин,
  poison events и лимит пакета покрыты тестами; полный набор из 268
  backend-тестов и TypeScript-сборка проходят;
- [x] legacy checkout flow не изменялись; новая
  миграция для этапа 5 не требуется.

Контролируемое развёртывание этапа 5 на staging выполнено в составе этапа 7.
Production callback не регистрировался и production-флаг webhook остался
выключенным.

### Этап 6. Наблюдаемость и Admin API

Реализовано 1 сентября 2026 года:

- [x] существующий healthcheck получил проверки `email_worker_active` и
  `email_failed_or_stale_jobs` для staging и production;
- [x] обе проверки feature-flag-aware: выключенный email worker не считается
  аварией и не меняет поведение текущего production;
- [x] при включённом worker проверяется согласованность конфигурации; staging
  дополнительно обязан иметь `EMAIL_TEST_MODE=true` и непустой allowlist;
- [x] контролируются неактивный systemd unit, окончательные `failed`, готовые
  задания старше 10 минут и зависшие `processing` старше 10 минут;
- [x] Telegram использует существующий `/usr/local/sbin/komui-alert`, поэтому
  отдельный бот и новые Telegram-секреты не создаются;
- [x] существующий `komui-order-monitor` формирует подробное уведомление только
  для новых окончательных email-ошибок: номер заказа, тип события, число
  попыток, безопасный код ошибки и замаскированный адрес;
- [x] HTTP 401/403 от Unisender теперь имеет отдельный код
  `email_provider_auth_rejected`, чтобы в алерте явно предложить проверить
  API-ключ;
- [x] ошибка `email_recipient_not_allowed` отдельно объясняет, что необходимо
  проверить staging allowlist и что реальному адресу письмо не отправлено;
- [x] Admin API списка и карточки заказа возвращает минимальный
  `email.orderPaid`: статус, число попыток, последнюю безопасную ошибку и даты
  отправки/ошибки/обновления;
- [x] Admin API не возвращает recipient email из outbox, payload,
  idempotency key или provider message ID; email покупателя и доказательства
  marketing consent остаются в уже защищённой модели заказа;
- [x] отдельный раздел рассылок и прямой доступ GetoMerch к PostgreSQL не
  добавлялись; UI сможет использовать защищённый Admin API после отдельного
  изменения в репозитории GetoMerch;
- [x] shell-контракт healthcheck, маскирование и Telegram-текст покрыты
  тестами; проходят 270 backend-тестов, 69 ops-тестов, TypeScript-сборка и
  `git diff --check`;
- [x] legacy checkout flow не изменялись.

Контролируемое развёртывание этапа 6 выполнено в составе этапа 7. Production
worker и production email-флаги оставлены выключенными. Проверка отображения
`email.orderPaid` непосредственно в интерфейсе GetoMerch остаётся отдельной
задачей его репозитория; серверный Admin API уже готов.

### Этап 7. Staging и приёмочные тесты

Техническая приёмка выполнена 1 сентября 2026 года:

- [x] перед миграцией создан backup staging-БД
  `/var/backups/komui/migrations/komui_staging-before-email-mvp-20260901T103824Z.dump`
  с SHA-256 файлом;
- [x] backward-compatible миграция применена только к `komui_staging`;
  production-БД и production email-флаги не изменялись;
- [x] код развёрнут в согласованный staging-релиз
  `20260901T103826Z-stage-dce3949325d9`; backend и frontend указывают на один
  коммит;
- [x] staging worker установлен и включён, а production worker не включался;
- [x] staging работает с `EMAIL_TEST_MODE=true` и allowlist ровно из одного
  адреса владельца;
- [x] попытка поставить письмо адресу вне allowlist отклонена до записи в
  очередь; количество заданий не изменилось;
- [x] синтетическое `order_paid` на 10 рублей прошло
  `pending → processing → sent` с первой попытки; заказ, платёж и отправление
  СДЭК не создавались;
- [x] очередь после теста не содержит `pending`, `retry`, `processing` или
  `failed`; проверки `email_worker_active` и
  `email_failed_or_stale_jobs` проходят;
- [x] полный email получателя и API-ключ отсутствуют в worker-логах;
- [x] публичный callback
  `https://stage.komui.ru/api/v1/webhooks/unisender-go` доступен для Unisender
  без staging Basic Auth, при этом POST защищён подписью провайдера;
- [x] webhook зарегистрирован в Unisender Go как `active`, `json_post`,
  `single_event=0`, `delivery_info=0`, `max_parallel=5` и только для статусов
  `unsubscribed`, `hard_bounced`, `spam`;
- [x] на staging проверены корректная подпись, отказ при неверной подписи,
  replay одного события и запись `hard_bounce` в suppression; синтетическая
  suppression после проверки удалена;
- [x] защищённый Admin API возвращает объект `email.orderPaid` и не раскрывает
  служебные секреты;
- [x] автоматическая приёмка включает 273 backend-теста, 69 ops-тестов,
  TypeScript-сборку и `git diff --check`;
- [x] legacy checkout flow не изменялись.
- [x] письмо доставлено в Gmail за одну секунду; в исходных заголовках
  подтверждены `SPF=PASS`, `DKIM=PASS` для `komui.ru` и `DMARC=PASS`;
- [x] обнаруженный в поле получателя буквальный placeholder `${to_name}`
  полностью удалён из API payload: клиент больше не передаёт необязательные
  `substitutions`, а regression-тест запрещает возврат `to_name`;
- [x] исправление развёрнуто на staging в релизе
  `20260901T111238Z-stage-b3fdd98ca31d`, после чего второе тестовое письмо
  `STAGE-EMAIL-7BFF502F` принято провайдером с первой попытки;
- [x] production-сборка дополнительно проверена на отсутствие `${to_name}`,
  `"to_name"` и `recipientName` в скомпилированном email-модуле.

Проверки Яндекс Почты и Mail.ru остаются полезной дополнительной проверкой
доставляемости, но не блокируют MVP после успешной приёмки Gmail и прохождения
SPF, DKIM и DMARC.

### Этап 8. Production и расширение

Production-часть `order_paid` включена 1 сентября 2026 года:

- [x] перед изменением схемы создан проверенный backup
  `/var/backups/komui/migrations/komui_production-before-payment-email-20260901T111608Z.dump`
  и отдельный SHA-256 файл;
- [x] миграции payment consistency и email MVP сначала успешно выполнены в
  транзакции с `ROLLBACK`, затем применены к `komui_production` одной
  транзакцией;
- [x] deploy compatibility-gate подтвердил полные состояния
  `payment-consistency-v1` и `email-mvp-v1`, частичная схема не активировалась;
- [x] GitHub `main` обновлён fast-forward до `b3fdd98ca31d`, production backend
  и frontend развёрнуты как релиз
  `20260901T111912Z-prod-b3fdd98ca31d`;
- [x] первый production deploy выполнен с `EMAIL_ENABLED=false` и
  `EMAIL_WORKER_ENABLED=false`; до smoke-проверки письма не ставились в
  очередь и не отправлялись;
- [x] после ответов 200 от readiness, каталога и checkout включены только
  `EMAIL_ENABLED=true` и `EMAIL_WORKER_ENABLED=true`; production остаётся с
  `EMAIL_TEST_MODE=false`, без allowlist и без маркетинговых заданий;
- [x] `komui-production-email-worker.service` включён и активен; staging и
  production worker используют разные release/env/database;
- [x] production callback
  `https://komui.ru/api/v1/webhooks/unisender-go` включён и зарегистрирован в
  Unisender как активный `json_post` webhook для `unsubscribed`,
  `hard_bounced` и `spam`; staging callback сохранён отдельно;
- [x] после включения обе email-очереди имеют 0 окончательных и просроченных
  ошибок, backend и production worker не содержат ошибок уровня `err`;
- [x] синтетический production-заказ не создавался, старые оплаченные заказы
  намеренно не backfill-ятся: первое письмо уйдёт только при новом первом
  переходе реального заказа в `paid`;
- [x] legacy checkout flow не изменялись.

До полного закрытия наблюдения за этапом 8 остаётся:

1. проверить ровно одно письмо после первой новой реальной подтверждённой
   оплаты: outbox должен перейти `pending -> processing -> sent` с одним
   idempotency key;
2. убедиться, что повтор webhook Т-Банка не создал дубль;
3. после периода стабильной работы отдельно принять решение о включении
   `shipment_created`;
4. маркетинговый dry-run выполнять только отдельной read-only операцией после
   проверки consent и suppression; он не включён текущим rollout.

## 5. Подготовка Unisender и DNS

Перед разработкой необходимо подтвердить в кабинете:

- технический домен ссылок `email.komui.ru`;
- SPF;
- DKIM;
- DMARC;
- адрес отправителя;
- API-доступ;
- webhook и механизм его проверки.

Для MVP достаточно одного адреса:

```text
hello@komui.ru
```

Он используется как `From` и для служебных, и для рекламных писем. `Reply-To`
должен вести в реальный почтовый ящик или на настроенную переадресацию.

Проверка DNS:

```bash
dig TXT komui.ru
dig TXT _dmarc.komui.ru
dig TXT <unisender-selector>._domainkey.komui.ru
dig NS email.komui.ru
```

SPF-запись должна быть одна. При использовании нескольких почтовых сервисов их
значения объединяются внутри одной записи.

## 6. Конфигурация сервера

Секреты хранятся только в root-owned env-файлах сервера.

Production:

```text
EMAIL_PROVIDER=unisender_go
EMAIL_ENABLED=false
EMAIL_WORKER_ENABLED=false
EMAIL_WORKER_INTERVAL_MS=10000
EMAIL_WORKER_BATCH_SIZE=10
EMAIL_WORKER_LEASE_MS=120000
EMAIL_WORKER_MAX_ATTEMPTS=4
EMAIL_FROM=hello@komui.ru
EMAIL_FROM_NAME=KOMUI
EMAIL_REPLY_TO=...
UNISENDER_GO_API_URL=...
UNISENDER_GO_API_KEY=...
UNISENDER_GO_PROJECT_ID=... # только если потребуется для выбранного типа ключа
UNISENDER_GO_WEBHOOK_ENABLED=false
```

До завершения проверки production разворачивается с `EMAIL_ENABLED=false`.

Staging:

```text
EMAIL_PROVIDER=unisender_go
EMAIL_ENABLED=true
EMAIL_WORKER_ENABLED=true
EMAIL_TEST_MODE=true
EMAIL_ALLOWED_RECIPIENTS=<owner-email>
EMAIL_SUBJECT_PREFIX=[STAGE]
```

Staging обязан отклонять любой адрес, отсутствующий в allowlist.

## 7. Минимальные изменения базы

### 7.1. Поля согласия в заказе

К существующим полям заказа добавить:

```text
marketing_consent_at timestamptz null
marketing_consent_version text null
marketing_consent_source text null
```

Значения:

- `marketing_consent_at` — серверное время фиксации выбранного чекбокса при
  создании заказа;
- `marketing_consent_version` — версия текста согласия;
- `marketing_consent_source` — для MVP только `checkout` или
  `legacy_checkout`.

IP и User-Agent в MVP отдельно не сохраняются.

### 7.2. `merch_email_outbox`

Минимальная очередь:

```text
id uuid primary key
order_id uuid null
event_type text not null
message_class text not null
recipient_email text not null
template_key text not null
payload jsonb not null
scheduled_at timestamptz not null
status text not null
attempt_count integer not null default 0
next_attempt_at timestamptz null
provider_message_id text null
last_error text null
idempotency_key text not null unique
created_at timestamptz not null
updated_at timestamptz not null
```

Статусы:

```text
pending
processing
retry
sent
failed
cancelled
```

Пример idempotency key:

```text
order-paid:<order-id>
```

Повторный webhook Т-Банка не сможет создать второе такое задание.

### 7.3. `merch_email_suppressions`

Минимальный запрет маркетинговой отправки:

```text
email_normalized text primary key
reason text not null
source text not null
provider_event_id text null
created_at timestamptz not null
updated_at timestamptz not null
```

Причины:

```text
unsubscribed
hard_bounce
spam_complaint
manual
```

Suppression запрещает рекламные письма. Служебное письмо по новому заказу можно
отправить, если адрес не является технически недоставляемым. Для `hard_bounce`
запрещаются оба типа сообщений до исправления email.

## 8. Доработка checkout

Существующий необязательный чекбокс сохраняется выключенным по умолчанию.

Необходимо:

- добавить в его текст ссылку на `/marketing-consent`;
- при согласии сохранять время, версию текста и источник `checkout`;
- не менять возможность покупки без согласия;
- не считать email для заказа или чека автоматической подпиской.

Рекомендуемая версия текста:

```text
Получать новости и специальные предложения KOMUI. Согласие на рассылку.
```

Последняя часть является ссылкой на `/marketing-consent`.

## 9. API-клиент Unisender Go

Backend-модуль должен:

- обращаться к API только по HTTPS;
- иметь тайм-аут;
- передавать API-ключ только с сервера;
- отправлять HTML и текстовую версию письма;
- возвращать provider message ID;
- различать временные и постоянные ошибки;
- маскировать email и секреты в логах;
- не выполнять бесконечные повторы.

Точные URL, заголовки авторизации и payload берутся из документации аккаунта
Unisender Go и покрываются integration-тестом.

## 10. Email worker

Создать отдельный systemd unit:

```text
komui-email-worker.service
```

Worker:

1. выбирает готовые задания из outbox;
2. блокирует их через `FOR UPDATE SKIP LOCKED`;
3. проверяет suppression для marketing;
4. отправляет письмо;
5. сохраняет provider message ID;
6. планирует повтор или переводит задание в `failed`.

Минимальная политика повторов:

1. первая попытка сразу;
2. повтор через 5 минут;
3. повтор через 30 минут;
4. последняя попытка через несколько часов;
5. затем `failed` и Telegram-алерт.

Постоянные ошибки авторизации, невалидный email и hard bounce не повторяются как
временные сетевые ошибки.

## 11. Первое письмо `order_paid`

Задание создаётся в той же транзакции, в которой заказ впервые получает статус
`paid`.

Письмо содержит:

- номер заказа;
- подтверждение оплаты;
- состав заказа;
- количество и размеры;
- итоговую сумму;
- выбранный пункт или адрес СДЭК;
- пояснение, что трек-номер придёт отдельно;
- контакты магазина.

Письмо не содержит рекламу, промокоды или рекомендации. Оно отправляется
независимо от marketing consent.

Шаблон хранится в Git:

```text
server/src/email/templates/order-paid/
```

В шаблоне должны существовать HTML, `text/plain`, subject и тестовая фикстура.

## 12. Второе письмо `shipment_created`

Добавляется после стабилизации `order_paid`.

Письмо содержит:

- номер заказа;
- трек-номер;
- ссылку на отслеживание;
- пункт назначения;
- ориентировочный срок при наличии достоверных данных.

Не следует включать в MVP письма на каждый внутренний статус СДЭК.

## 13. Webhook Unisender

Минимальный endpoint:

```text
POST /api/webhooks/unisender-go
```

В MVP обрабатываются только:

- unsubscribe;
- hard bounce;
- spam complaint;
- финальная ошибка доставки при необходимости диагностики.

Требования:

- проверка штатного `auth` по project API key и точному строковому body;
- ограничение размера body;
- защита от повторного события;
- создание или обновление suppression;
- отсутствие API-ключей и полного payload в логах;
- быстрый ответ `2xx` после успешной обработки.

Открытия и переходы остаются в статистике Unisender и не копируются в
PostgreSQL.

## 14. Отписка

В MVP используется стандартная ссылка и страница отписки Unisender.

После отписки webhook обязан добавить email в `merch_email_suppressions` с
причиной `unsubscribed`. Все ожидающие marketing-задания для адреса отменяются.

Событие `subscribed` в MVP автоматически не удаляет локальную suppression:
повторное включение адреса требует отдельного контролируемого решения, чтобы
случайно не снять `manual`, `hard_bounce` или `spam_complaint`.

Собственная страница `/email/unsubscribe` переносится в следующий этап.

## 15. Маркетинговая аудитория существующих покупателей

Для первой кампании выбираются только уникальные email, у которых:

- существует оплаченный заказ;
- `marketing_consent=true`;
- email валиден;
- нет suppression;
- нет более поздней отписки.

Процесс:

1. выполнить read-only dry-run;
2. показать количество уникальных адресов;
3. показать исключения по причинам;
4. проверить несколько записей вручную;
5. экспортировать CSV или отправить сегмент через API;
6. не изменять статусы заказов.

Контакты без marketing consent не включаются, даже если email был обязателен
для электронного чека.

## 16. Минимальная интеграция с GetoMerch

Для запуска отдельный раздел рассылок в GetoMerch не нужен.

При необходимости в карточке заказа позднее достаточно показать:

- email;
- marketing consent;
- время согласия;
- статус письма `order_paid`;
- последнюю ошибку отправки.

Кампании, сегменты и шаблоны в MVP управляются вне GetoMerch. Админка остаётся
отдельным Git-репозиторием и не подключается напрямую к production PostgreSQL.

## 17. Минимальный мониторинг

Добавить две проверки:

1. `email_worker_active`;
2. `email_failed_or_stale_jobs`.

Telegram сообщает, если:

- worker неактивен;
- самое старое готовое задание ждёт более 10 минут;
- письмо перешло в `failed`;
- API отклонил ключ;
- staging попытался отправить письмо не из allowlist.

Email в Telegram маскируется.

## 18. Тестирование MVP

Обязательные сценарии:

- первая успешная оплата создаёт одно письмо;
- повторный webhook Т-Банка не создаёт дубль;
- сбой Unisender не влияет на статус оплаты;
- worker корректно повторяет временную ошибку;
- постоянная ошибка переходит в `failed`;
- staging отправляет только владельцу;
- unsubscribe блокирует marketing;
- hard bounce блокирует дальнейшую отправку;
- заказ без рекламного согласия получает только служебное письмо;
- заказ с согласием может попасть в маркетинговый сегмент;
- логи не содержат ключ и полный email.

Ручная проверка доставки:

- Яндекс Почта;
- Mail.ru;
- Gmail;
- мобильное отображение;
- ссылки и изображения;
- SPF, DKIM и DMARC в заголовках полученного письма.

## 19. Deployment и rollback

Порядок безопасного развёртывания:

1. применить backward-compatible миграцию;
2. задеплоить код с `EMAIL_ENABLED=false`;
3. проверить production healthcheck;
4. включить staging с allowlist;
5. отправить тестовые письма;
6. проверить webhook и suppression;
7. включить production;
8. наблюдать первые реальные отправки;
9. добавить `shipment_created` после стабилизации.

Rollback:

- установить `EMAIL_ENABLED=false`;
- остановить worker;
- откатить код обычным release rollback;
- не удалять таблицы и outbox;
- после исправления продолжить необработанные задания без повторов уже
  отправленных писем.

## 20. Рекомендуемый порядок реализации

1. Завершить этап 1: провайдер, DNS и выключенная конфигурация.
2. Завершить этап 2: backward-compatible миграции и согласие checkout.
3. Завершить этап 3: API-клиент и шаблон `order_paid`.
4. Завершить этап 4: worker и атомарное задание при оплате.
5. Завершить этап 5: webhook, отписки и suppression.
6. Завершить этап 6: healthcheck, Telegram и минимальный Admin API.
7. Завершить этап 7: staging allowlist и полный набор тестов.
8. Завершить этап 8: production `order_paid`, наблюдение, затем СДЭК и
   маркетинговый dry-run.

## 21. Что потребуется от владельца

- подтверждённый адрес `hello@komui.ru`;
- рабочий `Reply-To`;
- API URL и API key из Unisender Go; project ID нужен только для сценариев,
  где он явно требуется выбранным типом ключа;
- project API key, которым регистрируется webhook: он же участвует в штатной
  проверке целостности поля `auth`;
- статус DNS и домена `email.komui.ru` в кабинете;
- email-адреса для staging allowlist;
- согласованный текст первого письма.

API-ключ не отправляется в чат и не коммитится. Он вводится непосредственно в
защищённый env-файл сервера.

## 22. Критерии готовности MVP

MVP считается готовым, если:

- `order_paid` уходит ровно один раз;
- Unisender не влияет на оплату и СДЭК;
- SPF, DKIM и DMARC проходят;
- staging ограничен allowlist;
- отписка, hard bounce и complaint создают suppression;
- worker и очередь наблюдаемы;
- Telegram сообщает о неисправности;
- существующая аудитория формируется только из оплаченных заказов с явным
  marketing consent;
- отправку можно полностью отключить одним env-флагом.

## 23. Что переносится после MVP

- форма подписки — реализована после MVP как Single Opt-In;
- собственная страница отписки;
- локальная история открытий и переходов;
- CRM-таблица контактов;
- автоматические review- и reactivation-цепочки;
- кампании и сегменты в GetoMerch;
- редактор шаблонов;
- персонализация по истории покупок;
- расширенная аналитика и A/B-тестирование.
