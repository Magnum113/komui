# Komui Alert: order notifications and compact menu

## User request

Improve the Telegram bot `Komui Alert` running on the production server:

- notify the configured Telegram chat about every new storefront order;
- redesign the current oversized Telegram button menu;
- prefer one compact entry button that opens grouped actions with inline buttons;
- inspect the existing project and server before choosing the implementation;
- implement, deploy, and verify the change.

## Constraints

- Production server: `codex-migrate@89.111.152.112:22`.
- SSH identity and pinned `known_hosts` are supplied by the user.
- Preserve unrelated local worktree changes.
- Do not send artificial test alerts to real users/chats during verification.
- Keep existing alert, deployment, backup, and monitoring behavior working.
- Secrets must remain server-side and must not be written to repository artifacts or logs.

## Product assumptions to validate

- A new-order notification should contain enough information to act on the order, but must avoid exposing payment secrets or excessive personal data.
- Repeated monitoring runs must be idempotent, so one order produces no duplicate alerts.
- The compact menu should be navigable inside one Telegram message using inline callbacks, with Back/Home navigation.
