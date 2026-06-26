# Этап 9. Стабилизация и отключение старой инфраструктуры

## Цель

Подтвердить новый сервер как единственную production-систему и безопасно вывести Supabase/Vercel из эксплуатации.

## Период стабилизации

Минимум 7–14 дней после cutover.

## Действия

### 9.1. Ежедневный контроль

- backup завершён;
- внешний backup доступен;
- нет необработанных webhook;
- нет зависших paid/pending orders;
- CDEK shipments согласованы;
- 5xx и resource alerts;
- диск и PostgreSQL growth;
- сверка платежей с Т-Банком.

### 9.2. Остаточные зависимости

Искать:

- `supabase.co`;
- старые keys;
- Vercel URLs;
- старый webhook;
- обращения админки/Ozon sync к source;
- старые DNS records;
- вызовы Vercel deploy hook.

### 9.3. Упрощение

- Перевести compatibility routes на чистые `/v1/*`.
- Удалить Supabase config из frontend.
- Удалить неиспользуемые Edge Function файлы только после архива.
- Удалить Vercel-specific build/deploy config после подтверждения.

### 9.4. Финальный архив

Сохранить вне сервера:

- финальный Supabase dump;
- source schema;
- grants/policies;
- Edge Functions;
- список секретов без значений;
- migration/cutover отчёты;
- restore procedure.

### 9.5. Decommission

Только после письменного checklist:

- отключить Vercel production deployment;
- отключить/поставить на паузу Supabase;
- удалить старые DNS records;
- ротировать больше не нужные Supabase/Vercel keys;
- удалить временный deploy hook;
- удалить временный SSH-доступ `codex-migrate`;
- удалить `/etc/sudoers.d/codex-migrate`.

## Финальные проверки

- 7–14 дней без source writes.
- Два успешных production backup.
- Хотя бы один успешный restore drill после cutover.
- Нет runtime-запросов к старой инфраструктуре.
- Все известные клиенты работают через новый контур.
- Документация соответствует фактическому серверу.

## Результат

KOMUI работает независимо от Supabase и Vercel, а старые сервисы можно удалить без потери данных и функций.

## NO-GO

- есть хотя бы один неизвестный source request;
- backup не проверен восстановлением;
- админка/Ozon sync ещё используют Supabase;
- не завершена сверка платежей;
- временный доступ нужен для незавершённых работ.

