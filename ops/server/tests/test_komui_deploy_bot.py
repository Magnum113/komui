from __future__ import annotations

import importlib.machinery
import importlib.util
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch


BOT_PATH = Path(__file__).resolve().parents[1] / "komui-deploy-bot"


def load_bot_module():
    original_read_text = Path.read_text

    def read_text(path: Path, *args, **kwargs):
        if str(path) == "/etc/komui/telegram-alerts.env":
            return "TELEGRAM_BOT_TOKEN=test\nTELEGRAM_CHAT_ID=1\n"
        return original_read_text(path, *args, **kwargs)

    loader = importlib.machinery.SourceFileLoader("komui_deploy_bot_test", str(BOT_PATH))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    with patch.object(Path, "read_text", read_text):
        loader.exec_module(module)
    return module


class AdminStatusMessageTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.bot = load_bot_module()

    def status_output(self, *, worker_status: str = "active") -> str:
        now = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
        return f"""GetoMerch admin deploy status

deploy-source: /opt/getomerch/deploy-source
branch: main
local: 141298fa6647
origin/main: 141298fa6647
active release: /opt/getomerch/releases/20260717T132235Z-admin-141298fa6647

disk:
root: /dev/sda1 20G 15G 4.4G 77% /

services:
getomerch-admin.service: active
getomerch-worker.service: {worker_status}
getomerch-database-backup.timer: active
postgresql: active
nginx: active

health:
failed units: 0

smoke:
admin /: 307 -> https://admin.komui.ru/login?next=%2F
admin /login: 200
admin protected API without cookie: 401

database backup:
status: success
updatedAt: {now}
external status: ok
backup id: 20260717T143943Z

registry:
updatedAt: 2026-07-17T13:23:56Z
last status: success
"""

    def test_formats_healthy_status_for_operator(self) -> None:
        message = self.bot.format_admin_status_message(self.status_output(), 0)

        self.assertIn("✅ Админка работает штатно.", message)
        self.assertIn("✅ Фоновые задачи и синхронизации", message)
        self.assertIn("загружена в облако", message)
        self.assertIn("Действий не требуется.", message)
        self.assertNotIn("deploy-source:", message)
        self.assertNotIn("protected API without cookie", message)

    def test_surfaces_failed_worker_as_problem(self) -> None:
        message = self.bot.format_admin_status_message(self.status_output(worker_status="failed"), 0)

        self.assertIn("❌ В работе админки или серверных сервисов есть проблема.", message)
        self.assertIn("❌ Фоновые задачи и синхронизации: ошибка", message)


class CompactMenuTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.bot = load_bot_module()

    def test_persistent_keyboard_contains_only_one_menu_button(self) -> None:
        keyboard = self.bot.keyboard()

        self.assertEqual(keyboard["keyboard"], [[{"text": "⚙️ Управление"}]])
        self.assertTrue(keyboard["is_persistent"])

    def test_inline_menu_groups_store_and_admin_actions(self) -> None:
        root = self.bot.main_menu_keyboard()["inline_keyboard"]
        store = self.bot.store_menu_keyboard()["inline_keyboard"]
        admin = self.bot.admin_menu_keyboard()["inline_keyboard"]

        self.assertEqual([button["callback_data"] for button in root[0]], ["menu:store", "menu:admin"])
        self.assertEqual(store[-1][0]["callback_data"], "menu:root")
        self.assertEqual(admin[-1][0]["callback_data"], "menu:root")
        self.assertIn("deploy:prod", {button["callback_data"] for row in store for button in row})
        self.assertIn(
            "admin:rollback:prod",
            {button["callback_data"] for row in admin for button in row},
        )

    def test_menu_callback_edits_existing_message(self) -> None:
        update = {
            "callback_query": {
                "id": "callback-1",
                "data": "menu:store",
                "message": {"message_id": 44, "chat": {"id": 1}},
            }
        }

        with patch.object(self.bot, "answer_callback") as answer, patch.object(
            self.bot, "edit_menu"
        ) as edit:
            self.bot.handle_update(update)

        answer.assert_called_once_with("callback-1", "Магазин")
        edit.assert_called_once()
        self.assertEqual(edit.call_args.args[0], update["callback_query"])
        self.assertIn("Магазин KOMUI", edit.call_args.args[1])


if __name__ == "__main__":
    unittest.main()
