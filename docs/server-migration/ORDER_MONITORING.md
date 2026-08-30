# Мониторинг проблем с заказами KOMUI

Production-заказы проверяет отдельный systemd-таймер
`komui-order-monitor.timer`. Он запускается каждую минуту и читает только
локальную базу `komui_production`.

Текущее состояние на 30 августа 2026: глобально установлен legacy binary из
`origin/main`, совместимый с ещё не мигрированной production DB. Candidate из
payment-consistency revision проверен однократно на staging, но не установлен в
production timer. Поэтому ниже возможности current и candidate разделены.

## Уведомление о новом заказе

Для каждого заказа, созданного после последней успешной проверки, Telegram
показывает:

- номер и время заказа по Москве;
- текущий платёжный статус;
- итоговую сумму;
- город и код ПВЗ CDEK;
- названия товаров, размеры и количество;
- промокод, если он применён;
- только последние четыре цифры телефона.

К уведомлению добавляется кнопка `Открыть заказы`, ведущая в раздел заказов
админки. Если за одну минуту создано несколько заказов, они отправляются одним
сообщением. Курсор мониторинга обновляется только после успешной отправки, поэтому
сбой Telegram не приводит к потере уведомления.

## Что сейчас считает проблемой production monitor

- новая сетевая ошибка при обращении backend к Т-Банку;
- платёж в статусе `payment_review`;
- два заказа одного покупателя, созданные с интервалом не более пяти секунд;
- три и более заказа одного покупателя за десять минут;
- три и более неудачных оплаты одного покупателя за тридцать минут;
- пять и более неудачных оплат минимум двух покупателей за пятнадцать минут;
- заказ без строк в `merch_customer_order_items`;
- отправление CDEK в статусе `failed` или `invalid`;
- оплаченный/авторизованный заказ, для которого через десять минут вообще нет
  строки CDEK shipment. Legacy monitor не отличает terminal `created` от
  промежуточного `creating`/`accepted`.

## Что добавляет candidate после production migration

- первичный неоднозначный T-Bank `Init` (`INIT_UNKNOWN`), пока новый заказ
  безопасно заблокирован и фоновый reconciler уточняет результат;
- durable CDEK-действие `cdek_create`/`cdek_cancel` в статусе `needs_review`;
- более строгий delivery gap: для `paid`/`partially_refunded` требуется именно
  shipment status `created`; `creating`/`accepted` и ошибочные строки проблему
  не скрывают.

Уведомления отправляются через `/usr/local/sbin/komui-alert`, поэтому монитор
использует тот же Telegram-бот, chat ID и Xray-прокси, что и остальные алерты.
Телефон покупателя передаётся только в виде последних четырёх цифр. Имя, полный
телефон и email в Telegram не отправляются. Также не отправляются платёжные и
checkout-токены.

## Защита от повторных уведомлений

Состояние хранится в `/var/lib/komui/order-monitor/state.json` с правами `0600`.
В нём находятся время последней успешной проверки, последний ID попытки оплаты,
список уже замеченных оплаченных заказов без CDEK и последние UUID заказов, о
которых уже сообщалось. Выборки новых заказов перекрываются на две минуты, а UUID
защищают от повторных сообщений; это не даёт потерять заказ, созданный одновременно
с проверкой. Состояние обновляется только после успешной отправки уведомления. При
первой установке выполняется bootstrap: старые заказы фиксируются как исходное
состояние и не создают ложную тревогу.

## Управление и диагностика

```bash
sudo systemctl status komui-order-monitor.timer
sudo systemctl status komui-order-monitor.service
sudo journalctl -u komui-order-monitor.service -n 100 --no-pager
sudo /usr/local/sbin/komui-order-monitor --dry-run
sudo /usr/local/sbin/komui-order-monitor --test-alert
```

## Установка после восстановления сервера

Candidate-версия monitor из этого revision читает `merch_order_effects` и новые поля
reconciliation. Сначала должна быть применена migration
`20260830143000_harden_payment_consistency.sql`.

Важно: текущий systemd unit читает `komui_production`. Поэтому staging deploy
не устанавливает эту версию глобально, пока production migration не применена.
Во время rollout новая candidate-версия была запущена однократно из
подготовленного source tree с `--database komui_staging --bootstrap --dry-run`,
отдельными временными state/lock paths и без изменения production timer. Это
не постоянный staging monitor.

```bash
sudo install -d -m 0700 -o root -g root /var/lib/komui/order-monitor
sudo install -m 0755 ops/server/komui-order-monitor /usr/local/sbin/komui-order-monitor
sudo install -m 0644 ops/server/komui-order-monitor.service /etc/systemd/system/komui-order-monitor.service
sudo install -m 0644 ops/server/komui-order-monitor.timer /etc/systemd/system/komui-order-monitor.timer
sudo install -m 0755 ops/server/komui-healthcheck.sh /usr/local/sbin/komui-healthcheck
sudo systemctl daemon-reload
sudo /usr/local/sbin/komui-order-monitor --dry-run
sudo systemctl enable --now komui-order-monitor.timer
```

Для обычного upgrade существующий state-файл сохраняется; первый запуск —
`--dry-run`. `--bootstrap` используется только при первичной установке или
после отдельно подтверждённого сброса state, иначе текущие incidents могут быть
приняты за уже известные.

Принудительный повторный bootstrap нужен только после осознанного сброса
мониторинга:

```bash
sudo /usr/local/sbin/komui-order-monitor --bootstrap
```

Не удаляйте state-файл при обычном обновлении: иначе текущие нерешённые проблемы
будут приняты за уже известные без отправки уведомления.
