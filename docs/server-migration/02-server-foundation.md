# Этап 2. Подготовка серверной платформы

## Цель

Подготовить защищённую и воспроизводимую платформу для Nginx, Node.js backend и PostgreSQL 17.

На этом этапе сервер является только staging. Действующий домен и Vercel не переключаются.

## Зависимости

- Этапы 0 и 1 завершены.
- Известно, какие существующие сервисы нельзя затрагивать.
- Есть backup текущей конфигурации сервера.

## Архитектурное решение

Для 2 vCPU, 4 ГБ RAM и 20 ГБ SSD использовать нативные systemd services без полного Docker-стека.

## Действия

### 2.1. ОС и доступ

- Установить security updates.
- Проверить время и NTP.
- Создать отдельного системного пользователя `komui`.
- Подготовить `/opt/komui`, `/etc/komui`, `/var/lib/komui`.
- Настроить release directories и symlink `current`.
- Не отключать текущий административный SSH-доступ до проверки нового.

### 2.2. Ресурсы

- Создать 2 ГБ swap.
- Ограничить journald.
- Настроить logrotate.
- Зафиксировать минимальный резерв диска 3–4 ГБ.
- Настроить хранение не более трёх releases.

### 2.3. Firewall и SSH

- Открыть наружу только 22, 80, 443.
- Не открывать 3000 и 5432.
- Проверить вход по ключам.
- Включить fail2ban или эквивалент.
- Отключать password/root login только после отдельной проверки доступа.

### 2.4. Runtime

- Установить Nginx.
- Установить PostgreSQL 17 из официального PGDG-репозитория.
- Установить активную Node.js LTS.
- Подготовить systemd unit backend.
- Подготовить защищённый `/etc/komui/backend.env`.

### 2.5. PostgreSQL baseline

- Слушать только localhost/Unix socket.
- Создать пустую БД `komui`.
- Создать роли owner/migrator/app/backup.
- Не выдавать приложению superuser.
- Ограничить connections с учётом 4 ГБ RAM.

### 2.6. Nginx baseline

- Создать временный staging vhost.
- Защитить staging Basic Auth и/или allowlist по IP.
- Добавить `X-Robots-Tag: noindex, nofollow, noarchive`.
- Настроить static root.
- Настроить proxy только на `127.0.0.1:3000`.
- Добавить request size limits и базовые security headers.
- TLS подключать после готовности DNS/staging hostname.
- Не изменять DNS-записи `komui.ru` и `www.komui.ru`.

## Проверки

- После reboot Nginx и PostgreSQL запускаются.
- PostgreSQL недоступен с внешнего IP.
- Порт 3000 недоступен извне.
- Swap существует, но не используется постоянно.
- Диск имеет достаточный резерв.
- `nginx -t` проходит.
- Логи ограничены.
- Пользователь `komui` не имеет лишнего sudo.

## Результат

Готовая серверная платформа без размещения production-данных.

Фактический результат от 25 июня 2026 года:

- PostgreSQL 17.10 и пустая `komui_staging`;
- Node.js 22.22.0 LTS;
- UFW и SSH hardening;
- 2 ГБ swap;
- отдельный system user и systemd unit;
- защищённый HTTPS staging hostname;
- production Nginx vhost не изменён.

Подробности: `.ai/server-migration/phase-02-report.md`.

Статус: `GO` к этапу 3 с ограничениями по reboot, password authentication,
offsite backup и обычным package updates.

## GO

Все проверки проходят, существующие сервисы не нарушены, есть минимум 3–4 ГБ свободного диска после установки.

## NO-GO

- после установки остаётся слишком мало диска;
- PostgreSQL или backend доступны извне;
- reboot ломает существующие сервисы;
- RAM постоянно уходит в swap;
- нет способа безопасно хранить внешний backup.

## Rollback

Остановить новые units, удалить только созданные vhost/директории и вернуть сохранённые конфигурации. Не удалять системные пакеты до выяснения зависимостей.
