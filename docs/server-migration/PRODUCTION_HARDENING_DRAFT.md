# Production hardening Supabase — проект операции

Дата: 25 июня 2026 года.

Статус: **подготовлено, не применять**.

Этот документ относится только к временному снижению риска в действующем
Supabase. Для целевой self-hosted архитектуры браузер вообще не получает доступ
к PostgreSQL.

## Почему нельзя применить сейчас

GetoMerchV3/V4 и Ozon sync выполняют реальную запись в 18 внутренних таблиц
через публичную роль `anon`. Немедленный отзыв прав остановит:

- учёт склада и транзакций;
- операции с товарами и справочниками;
- производственные заказы;
- синхронизацию Ozon orders/items/finance/prices;
- часть ручных SKU-операций.

## Обязательные условия применения

1. Установлен фактически используемый deployment админки.
2. Весь CRUD админки переведён на аутентифицированный BFF/admin API.
3. Ozon sync выполняется только backend-процессом.
4. В браузерном bundle отсутствуют DB credentials и прямые `.from(...)`.
5. Все SKU-скрипты либо завершены, либо переведены на управляемый backend job.
6. Выполнен полный backup БД и проверено восстановление в отдельную PostgreSQL.
7. Forward и rollback проверены на staging-копии.
8. Проведён полный тест админки, Ozon sync, витрины и checkout.
9. За период наблюдения, включающий хотя бы один полный рабочий цикл, не
   зафиксированы необходимые `anon`-записи во внутренние таблицы.
10. Получено отдельное явное разрешение владельца на изменение production.

## Порядок операции

1. Остановить только административные операции записи и Ozon sync.
2. Создать контрольный backup и записать row counts критичных таблиц.
3. Открыть короткое окно hardening.
4. Применить `production-hardening-forward.sql` одной транзакцией.
5. Проверить:
   - публичное чтение витрины;
   - checkout;
   - payment status;
   - T-Банк webhook test;
   - promo;
   - CDEK quote/points;
   - admin CRUD через новый API;
   - Ozon sync через backend.
6. При критической несовместимости применить rollback.
7. После успеха ротировать anon key только если он больше нигде не нужен.

## Что изменяет forward SQL

- отзывает права `anon`/`authenticated` на 18 внутренних таблиц;
- удаляет permissive RLS policies;
- добавляет deny-by-default policies для прямых клиентов;
- оставляет витрине только `SELECT` на активные storefront products;
- отзывает grants с backup-таблиц;
- отзывает лишний sequence `USAGE`;
- закрывает прямой RPC-вызов trigger-функций;
- не меняет `service_role`;
- не удаляет таблицы, данные, triggers или Edge Functions.

## Rollback

Rollback возвращает grants и policies к снимку от 25 июня 2026 года. Его можно
использовать только при подтверждённой поломке сразу после hardening.

Rollback не решает расхождение данных, если параллельно появились новые записи.
На время операции должен быть один контролируемый источник записи.

## Проверка после операции

Проверки безопасности:

- `anon` не может читать или менять склад, финансы, Ozon и производство;
- `anon` может читать только активные `merch_storefront_products`;
- `anon` не может выполнить `notify_vercel_storefront_changed`;
- backup-таблицы недоступны через PostgREST;
- checkout-таблицы остаются закрытыми.

Проверки совместимости:

- storefront build и runtime не получают 401/403 на каталоге;
- заказ создаётся один раз и идемпотентно;
- webhook не принимается без корректной подписи;
- admin CRUD работает только после аутентификации;
- Ozon sync не использует `anon`.

## Связанные файлы

- [Матрица потребителей](CONSUMER_MATRIX.md)
- [Forward SQL](sql/production-hardening-forward.sql)
- [Rollback SQL](sql/production-hardening-rollback.sql)

Официальные рекомендации Supabase:

- [Permissive RLS policies](https://supabase.com/docs/guides/database/database-linter?lint=0024_permissive_rls_policy)
- [Public SECURITY DEFINER function](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable)
