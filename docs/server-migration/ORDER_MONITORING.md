# Мониторинг проблем с заказами KOMUI

Production-заказы проверяет отдельный systemd-таймер
`komui-order-monitor.timer`. Он запускается каждую минуту и читает заказы только
из локальной базы `komui_production`; проверка сбоев email workers охватывает
обе базы — `komui_production` и `komui_staging`.

Текущее состояние на 2 сентября 2026: глобально установлена hardened-версия из
репозитория, совместимая с мигрированной `komui_production`. Production timer
активен, а monitor учитывает payment reconciliation и durable CDEK effects.

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

## Что считает проблемой production monitor

- новая сетевая ошибка при обращении backend к Т-Банку;
- платёж в статусе `payment_review`;
- два заказа одного покупателя, созданные с интервалом не более пяти секунд;
- три и более заказа одного покупателя за десять минут;
- три и более неудачных оплаты одного покупателя за тридцать минут;
- пять и более неудачных оплат минимум двух покупателей за пятнадцать минут;
- заказ без строк в `merch_customer_order_items`;
- отправление CDEK в статусе `failed` или `invalid`;
- заказ в `paid`/`partially_refunded`, для которого через десять минут нет CDEK
  shipment в конечном статусе `created`; промежуточные `creating`/`accepted` и
  ошибочные строки проблему не скрывают;
- первичный неоднозначный T-Bank `Init` (`INIT_UNKNOWN`), пока новый заказ
  безопасно заблокирован и фоновый reconciler уточняет результат;
- durable CDEK-действие `cdek_create`/`cdek_cancel` в статусе `needs_review`;

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
sudo systemctl status xray komui-xray-subscription-update.timer
sudo journalctl -u komui-xray-subscription-update.service -n 100 --no-pager
```

Если monitor не может доставить Telegram-уведомление, нужно проверять всю цепочку
до Xray, а не только состояние timer. Xray updater описан в
[`XRAY_SUBSCRIPTION_UPDATER.md`](XRAY_SUBSCRIPTION_UPDATER.md).

## Установка или восстановление после сбоя сервера

Текущая версия monitor читает `merch_order_effects` и новые поля
reconciliation. На новом или восстановленном сервере сначала должна быть
применена migration `20260830143000_harden_payment_consistency.sql`.

Systemd unit читает `komui_production`; отдельного постоянного staging monitor
нет. В рабочем production migration уже применена, поэтому это ограничение
важно только для восстановления или развёртывания на новой БД.

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
