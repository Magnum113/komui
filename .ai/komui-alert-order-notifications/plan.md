# Plan

1. Extend `komui-order-monitor` SQL with a bounded `newOrders` report containing order metadata and order items for records created after the persisted cursor.
2. Add safe Russian formatting for order status, Moscow time, ruble amounts, product lines, delivery city/PVZ, promo code, and masked phone tail.
3. Select the Telegram subject based on whether the run contains one order, multiple orders, or incidents only; attach the admin orders URL for new-order alerts.
4. Extend `komui-alert` with optional URL-button arguments while keeping all existing two-argument callers compatible.
5. Reduce the monitor timer interval to one minute.
6. Replace the large persistent reply keyboard with a single `⚙️ Управление` button and grouped inline submenus that edit one Telegram message.
7. Preserve direct commands, old button text handling, allowed-chat checks, and confirmations for production deploy/admin deploy/admin rollback.
8. Expand Python unit tests for notification rendering, cursor boundaries, privacy, compact keyboard layout, inline navigation, and confirmation behavior.
9. Run Python syntax/unit tests and shell checks locally.
10. Install only the changed operational scripts/unit, daemon-reload, restart the bot, restart the timer, and verify hashes, service state, logs, and a monitor dry-run without sending a test alert.
11. Record implementation and independent review findings; fix any material issue before completion.
