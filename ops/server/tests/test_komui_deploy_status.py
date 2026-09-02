from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path


STATUS_PATH = Path(__file__).resolve().parents[1] / "komui-deploy-status"


class KomuiDeployStatusContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.script = STATUS_PATH.read_text(encoding="utf-8")

    def test_shell_syntax_is_valid(self) -> None:
        completed = subprocess.run(
            ["bash", "-n", str(STATUS_PATH)],
            text=True,
            capture_output=True,
            check=False,
        )

        self.assertEqual(completed.returncode, 0, completed.stderr)

    def test_remote_lookup_is_noninteractive_and_nonfatal(self) -> None:
        self.assertIn('deploy_home="${KOMUI_DEPLOY_HOME:-/var/lib/komui/deploy-home}"', self.script)
        self.assertIn('HOME="$deploy_home" GIT_TERMINAL_PROMPT=0', self.script)
        self.assertIn(
            'timeout --signal=TERM --kill-after=2s "${remote_timeout_seconds}s"',
            self.script,
        )
        self.assertIn(
            "git -c protocol.version=1 ls-remote origin refs/heads/main",
            self.script,
        )
        self.assertIn("refs/remotes/origin/main", self.script)
        self.assertIn('remote_source=" (cached)"', self.script)
        self.assertIn("      || true\n  )", self.script)

    def test_status_covers_current_application_and_transport_units(self) -> None:
        for unit in (
            "komui-backend",
            "komui-production-backend",
            "komui-email-worker",
            "komui-production-email-worker",
            "komui-order-monitor.timer",
            "xray",
            "komui-xray-subscription-update.timer",
        ):
            with self.subTest(unit=unit):
                self.assertIn(unit, self.script)

    def test_all_external_status_checks_have_wall_clock_bounds(self) -> None:
        self.assertEqual(self.script.count("--connect-timeout 5 --max-time 10"), 2)

    def test_staging_credentials_are_passed_on_stdin_not_in_curl_argv(self) -> None:
        self.assertNotRegex(self.script, r"curl[^\n]*(?:^|\s)(?:-u|--user)(?:\s|=)")
        self.assertIn('curl -q --config - "$@" "$url"', self.script)
        self.assertIn("printf 'user = \"'", self.script)
        self.assertIn("unset STAGING_USER STAGING_PASSWORD", self.script)

    def test_staging_secret_reaches_fake_curl_only_through_stdin(self) -> None:
        helper_start = self.script.index("curl_config_escape()")
        helper_end = self.script.index('\necho "KOMUI deploy status"')
        helpers = self.script[helper_start:helper_end]
        harness = (
            helpers
            + "\nIFS= read -r STAGING_USER\n"
            + "IFS= read -r STAGING_PASSWORD\n"
            + "staging_curl https://stage.invalid/test -fsS -o /dev/null\n"
        )
        password = 's3cr"et\\value'

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fake_curl = root / "curl"
            args_file = root / "args"
            stdin_file = root / "stdin"
            env_file = root / "env"
            fake_curl.write_text(
                "#!/usr/bin/env bash\n"
                "printf '%s\\n' \"$@\" >\"$ARGS_FILE\"\n"
                "env >\"$ENV_FILE\"\n"
                "cat >\"$STDIN_FILE\"\n",
                encoding="utf-8",
            )
            fake_curl.chmod(0o755)
            environment = os.environ.copy()
            environment.update(
                {
                    "ARGS_FILE": str(args_file),
                    "STDIN_FILE": str(stdin_file),
                    "ENV_FILE": str(env_file),
                    "PATH": f"{root}:{environment['PATH']}",
                    "STAGING_USER": "exported-dummy-user",
                    "STAGING_PASSWORD": "exported-dummy-password",
                    "staging_user": "exported-lowercase-user",
                    "staging_password": "exported-lowercase-password",
                }
            )
            completed = subprocess.run(
                ["bash", "-c", harness],
                input=f"audit-user\n{password}\n",
                text=True,
                capture_output=True,
                check=False,
                env=environment,
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertNotIn(password, args_file.read_text(encoding="utf-8"))
            curl_environment = env_file.read_text(encoding="utf-8")
            self.assertNotIn(password, curl_environment)
            self.assertNotIn("STAGING_USER=", curl_environment)
            self.assertNotIn("STAGING_PASSWORD=", curl_environment)
            self.assertNotIn("staging_user=", curl_environment)
            self.assertNotIn("staging_password=", curl_environment)
            curl_stdin = stdin_file.read_text(encoding="utf-8")
            self.assertIn("audit-user", curl_stdin)
            self.assertIn('s3cr\\"et\\\\value', curl_stdin)


if __name__ == "__main__":
    unittest.main()
