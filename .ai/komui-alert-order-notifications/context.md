# Context

## Existing production design

- `ops/server/komui-deploy-bot` is a long-polling Telegram Bot API process managed by `komui-deploy-bot.service`.
- The bot currently installs a persistent `ReplyKeyboardMarkup` with six large buttons in four rows. Production and admin destructive actions already require inline confirmation.
- `ops/server/komui-order-monitor` is a root-owned Python oneshot run by `komui-order-monitor.timer` every five minutes.
- The monitor reads only the local `komui_production` PostgreSQL database and sends findings through `/usr/local/sbin/komui-alert`.
- Monitor state lives at `/var/lib/komui/order-monitor/state.json` with mode `0600`. Its `lastCheckedAt` cursor advances only after a successful Telegram send, which already provides retry/idempotency behavior.
- The local copies of `komui-deploy-bot`, `komui-order-monitor`, and `komui-alert` matched the installed production copies by SHA-256 before changes.
- On 2026-08-21 the bot service and order-monitor timer were active; the monitor state was current and had no active paid-without-CDEK incident.

## Order data available

`public.merch_customer_orders` stores order number, status, delivery city/PVZ, totals, promo code, timestamps, and customer data. `public.merch_customer_order_items` stores product name, size, quantity, and line totals.

The checkout creates the order and its items transactionally, then initiates payment and normally changes the order to `pending_payment`. A periodic notification therefore needs to show the current payment status instead of claiming that every new order is already paid.

## Privacy and safety

The existing monitoring policy deliberately excludes full names, full phone numbers, and email from Telegram. New-order messages can be operationally useful with order number, amount, item list, delivery city/PVZ, and the last four phone digits, so the same data-minimization policy can be retained.

No payment tokens, access tokens, email, full phone number, full customer name, or Telegram credentials may enter notifications, repository files, or test logs.

## Chosen UI

- Persistent reply keyboard: one button, `⚙️ Управление`.
- Root inline menu: `🏪 Магазин` and `🛠 Админка`.
- Store submenu: status, stage deploy, prod deploy, Back.
- Admin submenu: status, prod deploy, rollback, Back.
- Inline navigation edits one existing message when Telegram permits it, with a send-new-message fallback.
- Direct slash commands remain available for operators and backward compatibility.
- Destructive actions retain explicit confirmation.

## Notification design

- Extend the existing database monitor instead of adding Telegram calls to the checkout request path. This keeps Telegram/network failures outside checkout and reuses locking/state/retry behavior.
- Query orders created in `(lastCheckedAt, checkedAt]`, with item snapshots, as part of the monitor's single PostgreSQL report.
- Send one atomic alert per monitor run containing all newly found orders (and any simultaneous incidents), then advance state. This avoids partial progress and duplicate order messages.
- Include an inline URL button to `https://admin.komui.ru/komui/orders` for alerts that contain new orders.
- Change the timer interval from five minutes to one minute; the query is local and indexed, so this is a small operational load while making alerts useful.

## Tooling limitation

The installed `task-think` references a missing `PROMPTS.md`, and the local `codex` child binary fails with `ENOENT`. Required artifacts and phases are therefore executed directly in the main session.
