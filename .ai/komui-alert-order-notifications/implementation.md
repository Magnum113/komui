# Implementation

## Changed behavior

### New-order notifications

- `komui-order-monitor` now queries orders and item snapshots created after the durable cursor.
- The query uses a two-minute overlap window after state v2 migration. `notifiedOrderIds` suppress repeated messages, closing the concurrent-transaction boundary race without coupling Telegram to checkout.
- One alert per monitor run contains up to eight detailed order blocks and reports the complete order count.
- Each block contains order number, Moscow timestamp, current payment status, total, city/PVZ, masked phone tail, optional promo code, and item name/size/quantity.
- Full customer name, full phone, email, payment data, and checkout tokens are excluded.
- Alerts with new orders carry an `Открыть заказы` inline URL button to `https://admin.komui.ru/komui/orders`.
- The common `komui-alert` script remains compatible with its existing two-argument callers; action URL and label are optional third/fourth arguments and only HTTPS actions are accepted.
- The systemd timer now runs every minute with up to ten seconds of jitter.

### Compact bot menu

- The persistent reply keyboard now has one button: `⚙️ Управление`.
- The root inline menu groups actions into `🏪 Магазин` and `🛠 Админка`.
- Store submenu: status, stage deploy, confirmed prod deploy, Back.
- Admin submenu: status, confirmed prod deploy, confirmed rollback, Back.
- Menu navigation edits the current message through `editMessageText`; failures fall back to a new menu message.
- Existing slash commands and old reply-button text remain supported.

## Local verification

- `python3 -m py_compile ops/server/komui-order-monitor ops/server/komui-deploy-bot`: passed.
- `bash -n ops/server/komui-alert`: passed.
- `python3 -m unittest discover -s ops/server/tests -p 'test_*.py' -v`: 13 tests passed.
- Tests cover order rendering/privacy, money and Moscow time, bounded/overlapping cursor behavior, notified UUID deduplication, paid-without-CDEK deduplication, compact keyboard shape, inline navigation, admin status, and optional alert URL markup.
- `shellcheck` and local `systemd-analyze` were unavailable; Bash syntax was checked locally and systemd units were loaded by production systemd successfully.

## Production deployment

Installed on `89.111.152.112`:

- `/usr/local/sbin/komui-order-monitor`
- `/usr/local/sbin/komui-alert`
- `/usr/local/sbin/komui-deploy-bot`
- `/etc/systemd/system/komui-order-monitor.timer`
- `/etc/systemd/system/komui-order-monitor.service`

Production verification:

- candidate monitor `--dry-run` successfully queried the real `komui_production` schema without alerting or saving state;
- installed SHA-256 values matched local source files;
- `komui-order-monitor.timer` is enabled, active, and triggering roughly once per minute;
- repeated oneshot executions exit `0/SUCCESS`;
- state migrated from version 1 to version 2 with `notifiedOrderIds` and remains mode `0600`;
- `komui-deploy-bot.service` is enabled and running.

## Telegram transport state

The pre-existing Xray configuration initially could not reach Telegram. On
2026-08-23 the user supplied a newer configuration whose `nlch` VLESS/REALITY
outbound passed an isolated Telegram `getMe` probe. The complete configuration
also selected that working route successfully.

The previous production config was saved as
`/usr/local/etc/xray/config.json.pre-komui-20260823T202639`. The new config was
installed as `root:nogroup 0640`, validated, and activated by restarting only
`xray.service`.

Post-deployment verification:

- production proxy `socks5h://127.0.0.1:10808` passed 10 of 10 `getMe` calls;
- Komui Alert registered all eight commands, including the compact `/start` description;
- the bot entered its normal `getUpdates` long-poll loop;
- Xray, Komui Alert, and the one-minute order monitor are active;
- no artificial order or manual test alert was sent.
