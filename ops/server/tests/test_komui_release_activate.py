from __future__ import annotations

import subprocess
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "komui-release-activate"


class KomuiReleaseActivateContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.script = SCRIPT_PATH.read_text(encoding="utf-8")

    def test_shell_syntax_is_valid(self) -> None:
        completed = subprocess.run(
            ["bash", "-n", str(SCRIPT_PATH)],
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)

    def test_staging_credentials_are_passed_on_stdin_not_in_curl_argv(self) -> None:
        self.assertNotRegex(self.script, r"curl[^\n]*(?:^|\s)(?:-u|--user)(?:\s|=)")
        self.assertIn('curl -q --config - "$@" "$url"', self.script)
        self.assertIn("staging_curl https://stage.komui.ru/", self.script)


if __name__ == "__main__":
    unittest.main()
