# Review

- План разделён на 10 контрольных этапов.
- Production cutover отделён от staging и от decommission.
- Rollback после появления новых заказов описан отдельно.
- Инвентаризация всех внешних потребителей является обязательным gate.
- В этапах отсутствуют значения секретов.
- Следующий безопасный шаг: read-only аудит сервера.
- Добавлена жёсткая изоляция staging от production.
- Staging по умолчанию не пишет в Supabase и не создаёт реальные
  платежи/отправления; единственное согласованное будущее исключение —
  отдельный owner-confirmed Ozon dual-write admin job.
- После тестовой приёмки предусмотрена обязательная остановка.
- Этап 0 завершён в read-only режиме.
- Обнаружены существующие Nginx/OpenClaw/Kaiten/Xray-сервисы.
- `api.komui.ru` нельзя использовать как staging без изменения production.
- Следующий этап не должен применять hardening автоматически.
- Этап 1 завершён в read-only режиме.
- Публичная запись в 18 таблиц подтверждена статистикой реальных запросов.
- GetoMerchV3/V4 зависят от `anon` CRUD и не используют Supabase Auth.
- Необходимо подтвердить активный deployment V3/V4 до переноса админки.
- Подготовлены, но не применены forward и rollback SQL.
- Переход к серверной подготовке разрешён; production hardening запрещён.
- Этап 2 завершён со статусом GO с ограничениями.
- PostgreSQL и backend ports недоступны извне.
- Staging защищён TLS и Basic Auth, индексация запрещена.
- Production vhost `api.komui.ru` совпадает с исходным backup.
- Reboot и 163 обычных package updates отложены до maintenance window.
- Password authentication остаётся до проверки личного ключа владельца.
- Этап 3 завершён со статусом GO.
- Credential gate пройден без сброса production DB password и без создания
  временной LOGIN-роли.
- Авторизованный Dashboard использован только для read-only SQL export.
- Два restore воспроизвели одинаковую схему и одинаковые нормализованные данные.
- `komui_staging` не содержит Supabase/Vercel runtime-зависимостей.
- Этап 4 завершён со статусом GO.
- Backend/API каталога работают в staging через `/api/v1/products`.
- Admin runtime endpoint закрыт bearer token и пишет audit log.
- Public API не отдаёт raw/internal поля.
- `stage.komui.ru` резолвится на `89.111.152.112`; TLS выпущен до
  2026-09-24.
- Этап 5 частично завершён со статусом GO только для перехода к frontend
  staging wiring.
- Checkout API работает через собственный backend и compatibility route.
- Staging checkout использует mock T-Bank/CDEK; реальные payment/shipment
  side effects отключены.
- Full Stage 5 и production cutover заблокированы до T-Bank/CDEK/Ozon
  credentials, Ozon dual-write admin job и реальных интеграционных тестов.
- После передачи T-Bank/CDEK credentials staging распознаёт реальные интеграции;
  CDEK shipment creation остаётся выключенным.
- Ozon dual-write admin job заблокирован до передачи настоящего Supabase
  service role/secret key; public anon/publishable key для этого не подходит.
- Этап 6 завершён со статусом GO с ограничениями.
- Frontend staging больше не содержит runtime Supabase key/URL и не использует
  Vercel/Supabase Functions proxy.
- Проверены HTTPS routes `/`, `/checkout`, `/payment-result`, `/delivery`,
  `/data/api-config.js`, `/api/v1/products?limit=1`; Basic Auth и noindex
  сохранены.
- Ограничения этапа 6: browser smoke через Playwright пропущен из-за локальной
  зависимости; Ozon CDN images и Google Fonts пока внешние.
- Следующий безопасный шаг: этап 7, staging/backup/operational verification и
  ручная тестовая приёмка без изменения production.
- Этап 7 частично выполнен со статусом infra GO.
- Backup/restore/reboot/rollback/load smoke прошли.
- Полный Stage 7 GO заблокирован до:
  - ручной приёмки владельцем;
  - Ozon admin import dry-run/job;
  - осознанного теста T-Bank demo payment/webhook, если владелец хочет
    проверять платёжный сценарий.
- External backup target закрыт: Yandex Object Storage upload проверен.
- Alerting target закрыт: Telegram bot через Xray proxy проверен.
- Этап 8 по-прежнему запрещён без отдельного явного разрешения production
  cutover.
