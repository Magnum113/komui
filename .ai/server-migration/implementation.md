# Implementation

Выполнен этап 0:

- подтверждён SSH fingerprint;
- проверены доступ и sudo;
- собран read-only аудит сервера;
- зафиксированы существующие сервисы и конфликты;
- выдано решение `GO` с ограничениями.

Сервер не изменялся.

Выполнен этап 1:

- найдены потребители текущего Supabase;
- подтверждены 29 public-таблиц и 6 Edge Functions;
- подтверждена фактическая публичная запись в 18 внутренних таблиц;
- найдены GetoMerchV3/V4 и их Ozon routes;
- сформирована матрица потребителей и реестр секретов;
- подготовлены guarded forward/rollback SQL;
- production не изменялся.

Выполнен этап 2:

- создан swap 2 ГБ;
- установлен PostgreSQL 17.10;
- создана пустая `komui_staging` и роли owner/migrator/app/backup;
- PostgreSQL ограничен localhost;
- включён UFW с 22/80/443;
- усилен SSH без отключения обычного password authentication;
- создан системный пользователь и каталоги KOMUI;
- подготовлен backend systemd unit;
- создан отдельный HTTPS staging hostname с Basic Auth;
- production Nginx vhost остался без изменений.

Выполнен этап 3:

- через авторизованный Supabase SQL Editor получен согласованный read-only
  снимок 29 таблиц и экспортирована история из 31 миграции;
- снимок зашифрован AES-256 и хранится на сервере отдельно от ключа;
- схема и 3500 строк восстановлены в обычный PostgreSQL 17;
- два последовательных restore дали одинаковые schema/data hashes;
- проверены row counts, агрегаты, 39 foreign keys, 99 индексов и 5 sequences;
- удалены Supabase roles/grants/RLS и Vercel trigger/function;
- создана минимальная модель доступа для `komui_app` и `komui_backup`;
- временная проверочная БД удалена, рабочая staging-БД — `komui_staging`;
- production Supabase, Vercel, DNS и webhook не изменялись.
