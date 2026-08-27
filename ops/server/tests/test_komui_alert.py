from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ALERT_PATH = Path(__file__).resolve().parents[1] / "komui-alert"


class KomuiAlertTest(unittest.TestCase):
    def test_optional_https_action_is_sent_as_inline_button(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            env_file = root / "telegram.env"
            args_file = root / "curl-args.json"
            fake_curl = root / "curl"
            env_file.write_text(
                "TELEGRAM_BOT_TOKEN=test-token\nTELEGRAM_CHAT_ID=123\n",
                encoding="utf-8",
            )
            fake_curl.write_text(
                "#!/usr/bin/env python3\n"
                "import json, os, sys\n"
                "from pathlib import Path\n"
                "Path(os.environ['CURL_ARGS_PATH']).write_text(json.dumps(sys.argv[1:]))\n",
                encoding="utf-8",
            )
            fake_curl.chmod(0o755)
            env = os.environ.copy()
            env.update(
                {
                    "KOMUI_TELEGRAM_ENV_FILE": str(env_file),
                    "CURL_ARGS_PATH": str(args_file),
                    "PATH": f"{root}:{env['PATH']}",
                }
            )

            completed = subprocess.run(
                [
                    "bash",
                    str(ALERT_PATH),
                    "KOMUI: новый заказ",
                    "Заказ KOM-123",
                    "https://admin.komui.ru/komui/orders",
                    "Открыть заказы",
                ],
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            args = json.loads(args_file.read_text(encoding="utf-8"))
            markup_arg = next(value for value in args if value.startswith("reply_markup="))
            markup = json.loads(markup_arg.removeprefix("reply_markup="))
            self.assertEqual(
                markup,
                {
                    "inline_keyboard": [
                        [
                            {
                                "text": "Открыть заказы",
                                "url": "https://admin.komui.ru/komui/orders",
                            }
                        ]
                    ]
                },
            )


if __name__ == "__main__":
    unittest.main()
