# Этап 2 — отчёт

Дата: 25 июня 2026 года.

Статус: **GO к тестовому переносу БД с ограничениями**.

Production Supabase, Vercel, DNS `komui.ru` и production webhook не изменялись.

## Созданный baseline

### Ресурсы

- Создан и добавлен в `/etc/fstab` swap-файл 2 ГБ.
- `vm.swappiness=10`.
- После установки свободно около 7,3 ГБ SSD.
- Доступно около 2,7 ГБ RAM.
- Swap после проверок не используется.
- journald ограничен 150 МБ и retention 14 дней.
- Добавлен logrotate для `/var/log/komui/*.log`.
- Добавлен безопасный pruning releases до трёх каталогов.

### Пользователь и каталоги

- Создан системный пользователь `komui` без shell и без sudo.
- Созданы:
  - `/opt/komui/releases`;
  - `/opt/komui/shared`;
  - `/opt/komui/current`;
  - `/etc/komui`;
  - `/var/lib/komui`;
  - `/var/log/komui`;
  - `/var/backups/komui/database`.
- Подготовлен, но не включён `komui-backend.service`.
- Backend ещё не запущен, внешний и локальный порт 3000 не занят.

### Runtime

- Существующий Node.js `22.22.0` сохранён: это поддерживаемая LTS-ветка.
- Существующий Nginx сохранён.
- Установлен PostgreSQL `17.10` из официального PGDG-репозитория.

### PostgreSQL

- Создана пустая БД `komui_staging`.
- Созданы роли:
  - `komui_owner` — NOLOGIN;
  - `komui_migrator` — LOGIN, член owner;
  - `komui_app` — LOGIN, лимит 15 соединений;
  - `komui_backup` — LOGIN, лимит 2 соединения.
- Ни одна роль KOMUI не является superuser и не может создавать роли/БД.
- `komui_app` и `komui_backup` не имеют CREATE на schema `public`.
- PostgreSQL слушает только:
  - `127.0.0.1:5432`;
  - `[::1]:5432`.
- Внешний порт 5432 недоступен.
- `max_connections=40`, `shared_buffers=256MB`.
- Credentials созданы на сервере и не выводились:
  - `/etc/komui/backend.env`, `0640 root:komui`;
  - `/etc/komui/database-admin.env`, `0600 root:root`.

### SSH и firewall

- UFW включён и запускается при старте.
- Разрешены только 22/tcp, 80/tcp и 443/tcp.
- Внешние 3000/tcp и 5432/tcp закрыты.
- Root password login отключён; root key login пока разрешён.
- `MaxAuthTries=4`.
- X11 forwarding отключён.
- Fail2ban включён с incremental ban.
- После изменений проверен новый независимый SSH-сеанс.

`PasswordAuthentication` для обычных пользователей временно оставлен включённым:
отдельный личный ключ владельца ещё не проверен в рамках этого этапа.

### Staging Nginx

Создан отдельный hostname:

`https://staging-89-111-152-112.sslip.io`

- DNS KOMUI не изменялся.
- HTTP перенаправляет на HTTPS.
- Без Basic Auth возвращается `401`.
- С корректной авторизацией возвращается `200`.
- Credentials хранятся только на сервере:
  `/etc/komui/staging-access.env`, режим `0600`.
- Добавлен `X-Robots-Tag: noindex, nofollow, noarchive`.
- Сертификат Let's Encrypt действует до 23 сентября 2026 года.
- `certbot.timer` включён и активен.
- `/api/` подготовлен для proxy на `127.0.0.1:3000`.

Сейчас staging показывает только технический placeholder. Приложение и
production-данные на сервер ещё не переносились.

## Обновления ОС

- Обновлены пакеты, необходимые для TLS/PGDG/PostgreSQL.
- Проверка `unattended-upgrade` показывает 0 доступных security updates.
- Остаётся 163 обычных package updates.

Обычные обновления отложены до отдельного maintenance window, потому что
массовое обновление может перезапустить Nginx, SSH, OpenClaw, Xray и другие
действующие сервисы.

`/var/run/reboot-required` отсутствует.

## Проверки

- Новый SSH-сеанс после UFW и hardening: успешно.
- `nginx -t`: успешно.
- PostgreSQL `pg_isready`: успешно.
- Вход ролями app/migrator/backup: успешно.
- `komui_app` superuser: false.
- `komui_app` CREATE schema: false.
- `komui_migrator` член `komui_owner`: true.
- `komui_backup` CREATE schema: false.
- 22/80/443 снаружи: доступны.
- 3000/5432 снаружи: закрыты.
- Staging HTTPS без auth: `401`.
- Staging HTTPS с auth: `200`.
- Failed systemd units: 0.
- Nginx, SSH, PostgreSQL, Fail2ban, Xray и Docker: active.
- Swap usage: 0.

## Проверка неизменности production

- SHA-256 текущего `/etc/nginx/sites-available/api.komui.ru` совпадает с
  резервной копией до изменений:
  `fbe9f8cba358be684ace51e034e9e784caaf6238922d89a3c5719f36d369b124`.
- `https://api.komui.ru/` возвращает прежний `404`.
- `https://komui.ru/` и `https://www.komui.ru/` возвращают `200` с Vercel.

## Backup

Основной снимок до изменений:

`/var/backups/komui/server-foundation-20260625-233155`

Содержит архив исходных конфигураций, список пакетов, systemd units и firewall.
Каталог и файлы доступны только root.

## Ограничения

1. Контролируемый reboot не выполнялся, поскольку он не требуется обновлениями и
   вызвал бы краткий простой действующего `api.komui.ru`.
2. Cold-start всех сервисов нужно проверить в согласованное maintenance window
   или перед этапом 7.
3. Password authentication нельзя отключать до проверки личного ключа владельца.
4. Автоматический offsite backup будет настроен после появления staging-данных.
5. 163 обычных обновления требуют отдельного maintenance window.

## Решение

### GO

Можно переходить к этапу 3 — read-only dump Supabase и restore в
`komui_staging`.

Условия:

- staging не пишет в Supabase;
- production Supabase/Vercel/DNS остаются без изменений;
- реальные payment/shipment credentials не используются;
- после restore свободный диск должен оставаться не менее 4 ГБ.

### Пока запрещено

- запускать backend с production credentials;
- направлять `komui.ru` на сервер;
- изменять production webhook;
- отключать Supabase/Vercel;
- применять production hardening;
- выполнять reboot без согласованного окна.

## Rollback

При необходимости:

1. отключить symlink `/etc/nginx/sites-enabled/komui-staging`;
2. выполнить `nginx -t` и reload;
3. остановить `postgresql@17-main`;
4. отключить новый backend unit, если он будет включён позднее;
5. восстановить конфигурации из server-foundation backup;
6. не удалять пакеты до анализа зависимостей;
7. swap можно отключить только после подтверждения достаточного объёма RAM.

## Использованные официальные источники

- [Node.js release status](https://nodejs.org/en/about/previous-releases)
- [PostgreSQL PGDG для Ubuntu](https://www.postgresql.org/download/linux/ubuntu/)
