# Мониторинг проблем с заказами KOMUI

Production-заказы проверяет отдельный systemd-таймер
`komui-order-monitor.timer`. Он запускается каждую минуту и читает только
локальную базу `komui_production`.

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

## Что считается проблемой

- новая сетевая ошибка при обращении backend к Т-Банку;
- первичный неоднозначный T-Bank `Init` (`INIT_UNKNOWN`), пока новый заказ
  безопасно заблокирован и фоновый reconciler уточняет результат;
- платёж в статусе `payment_review`;
- durable CDEK-действие `cdek_create`/`cdek_cancel` в статусе `needs_review`;
- два заказа одного покупателя, созданные с интервалом не более пяти секунд;
- три и более заказа одного покупателя за десять минут;
- три и более неудачных оплаты одного покупателя за тридцать минут;
- пять и более неудачных оплат минимум двух покупателей за пятнадцать минут;
- заказ без строк в `merch_customer_order_items`;
- отправление CDEK в статусе `failed` или `invalid`;
- оплаченный заказ, для которого через десять минут нет отправления CDEK в
  конечном статусе `created`; промежуточные `creating`/`accepted` и ошибочные
  строки не скрывают проблему.

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

Версия monitor из этого revision читает `merch_order_effects` и новые поля
reconciliation. Сначала должна быть применена migration
`20260830143000_harden_payment_consistency.sql`.

```bash
sudo install -d -m 0700 -o root -g root /var/lib/komui/order-monitor
sudo install -m 0755 ops/server/komui-order-monitor /usr/local/sbin/komui-order-monitor
sudo install -m 0644 ops/server/komui-order-monitor.service /etc/systemd/system/komui-order-monitor.service
sudo install -m 0644 ops/server/komui-order-monitor.timer /etc/systemd/system/komui-order-monitor.timer
sudo install -m 0755 ops/server/komui-healthcheck.sh /usr/local/sbin/komui-healthcheck
sudo systemctl daemon-reload
sudo /usr/local/sbin/komui-order-monitor --bootstrap
sudo systemctl enable --now komui-order-monitor.timer
```

Принудительный повторный bootstrap нужен только после осознанного сброса
мониторинга:

```bash
sudo /usr/local/sbin/komui-order-monitor --bootstrap
```

Не удаляйте state-файл при обычном обновлении: иначе текущие нерешённые проблемы
будут приняты за уже известные без отправки уведомления.
