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

### 9.6. Фактический server-side decommission после cutover

Удаления файлов из Git недостаточно: установленные systemd units, Nginx vhost
и секреты в `/etc/komui` продолжают существовать до отдельной серверной
операции. Для этого в репозитории есть идемпотентный gate:

```text
ops/server/komui-decommission-hosted-platforms
```

Production deploy обязан выполнить его после запуска нового backend и до
активации frontend. Прямой запуск и production deploy используют один
`/run/komui-deploy.lock`, поэтому две операции не могут менять Nginx и env
параллельно. Gate делает root-only snapshot для rollback и затем:

- останавливает и удаляет `komui-traffic-switch.path/.service` и оба CLI;
- удаляет завершённый одноразовый TLS cutover helper, чтобы его старая
  установленная копия не могла повторно включить legacy vhost;
- заменяет изменяемый runtime snippet отдельным server-only snippet;
- исключает одновременное включение старого и нового production vhost;
- заменяет публичный `api.komui.ru` proxy на явный TLS tombstone HTTP 410 без
  upstream, чтобы DNS не отправлял неизвестный Host в другой vhost;
- удаляет только перечисленные legacy/Supabase keys из server env-файлов,
  сохраняя owner и mode остальных настроек;
- проверяет `nginx -T`, локальный origin `komui.ru`, 404 удалённого
  compatibility endpoint и 410 для `/rest`, `/functions` и `/healthz` на
  `api.komui.ru`.

DNS и TLS certificate `api.komui.ru` удаляются отдельно после периода
наблюдения. До этого tombstone должен оставаться включённым. Финальное удаление
делается в таком порядке: удалить DNS record, дождаться истечения TTL и
подтвердить отсутствие обращений; создать обычный root-owned файл-маркер
`/etc/komui/api.komui.ru-finalized`; отключить vhost; проверить и перезагрузить
Nginx; только после этого удалить certificate. При наличии маркера последующие
production deploy не восстанавливают tombstone и не требуют удалённый
certificate. Без маркера отсутствие полной TLS-пары считается ошибкой, чтобы
случайная потеря certificate не отправила старый hostname в default vhost.

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
