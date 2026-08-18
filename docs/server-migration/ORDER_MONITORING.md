# Мониторинг проблем с заказами KOMUI

Production-заказы проверяет отдельный systemd-таймер
`komui-order-monitor.timer`. Он запускается каждые пять минут и читает только
локальную базу `komui_production`.

## Что считается проблемой

- новая сетевая ошибка при обращении backend к Т-Банку;
- платёж в статусе `payment_review`;
- два заказа одного покупателя, созданные с интервалом не более пяти секунд;
- три и более заказа одного покупателя за десять минут;
- три и более неудачных оплаты одного покупателя за тридцать минут;
- пять и более неудачных оплат минимум двух покупателей за пятнадцать минут;
- заказ без строк в `merch_customer_order_items`;
- отправление CDEK в статусе `failed` или `invalid`;
- оплаченный заказ, для которого через десять минут нет записи отправления CDEK.

Уведомления отправляются через `/usr/local/sbin/komui-alert`, поэтому монитор
использует тот же Telegram-бот, chat ID и Xray-прокси, что и остальные алерты.
Телефон покупателя передаётся только в виде последних четырёх цифр. Имя, полный
телефон и email в Telegram не отправляются.

## Защита от повторных уведомлений

Состояние хранится в `/var/lib/komui/order-monitor/state.json` с правами `0600`.
В нём находятся время последней успешной проверки, последний ID попытки оплаты
и список уже замеченных оплаченных заказов без CDEK. Состояние обновляется только
после успешной отправки уведомления. При первой установке выполняется bootstrap:
старые заказы фиксируются как исходное состояние и не создают ложную тревогу.

## Управление и диагностика

```bash
sudo systemctl status komui-order-monitor.timer
sudo systemctl status komui-order-monitor.service
sudo journalctl -u komui-order-monitor.service -n 100 --no-pager
sudo /usr/local/sbin/komui-order-monitor --dry-run
sudo /usr/local/sbin/komui-order-monitor --test-alert
```

## Установка после восстановления сервера

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
