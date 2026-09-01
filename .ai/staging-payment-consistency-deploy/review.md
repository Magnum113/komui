# Review

Статус: staging GO для release/deployment и non-provider-mutating smoke.

- Migration предварительно исполнена на временной полной копии и затем успешно
  применена к `komui_staging` в closed-write window.
- Новый backend/frontend release активен и прошёл health/API/static/monitoring
  проверки.
- Реальные provider mutations не выполнялись. Две старые CDEK-отмены сохранены
  как `needs_review` для отдельного бизнес-решения.
- Полный demo payment → refund → real CDEK cancel E2E намеренно не запускался:
  staging использует реальный CDEK. Он требует отдельного явного разрешения.
- Production не переведена на revision `ac2567b` и не мигрирована; активный
  production release и старый production-compatible global order monitor
  оставлены без изменений.
- Git/Telegram deploy flow защищён fail-closed source/schema gate: старый
  `main` блокируется на migrated staging, а новый revision блокируется на
  legacy production до controlled migration rollout. Installed hash совпал с
  commit `b2c7337`; четыре live check-only комбинации дали ожидаемые exit codes
  без изменения runtime/DB.

Остаточные действия:

- Telegram release notification вызвал два сетевых timeout, хотя deployment
  registry надёжно записал оба successful события; transport нужно проверить
  отдельно;
- две historical CDEK cancellation строки остаются в `needs_review` до
  отдельного operator/business решения;
- exact post-drain backup прошёл restore drill обоих DB dumps, `komui_app`
  read-check, isolated legacy-backend smokes и полную cleanup-проверку;
- backup design всё ещё не доказывает полный production DR: owners/ACL не
  сохранены, а runtime-config staging-centric;
- полный demo payment/refund/real-CDEK E2E требует отдельного явного разрешения.
