from __future__ import annotations

import subprocess
import unittest
from pathlib import Path


HEALTHCHECK_PATH = Path(__file__).resolve().parents[1] / "komui-healthcheck.sh"


class KomuiHealthcheckContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.script = HEALTHCHECK_PATH.read_text(encoding="utf-8")

    def test_shell_syntax_is_valid(self) -> None:
        completed = subprocess.run(
            ["bash", "-n", str(HEALTHCHECK_PATH)],
            text=True,
            capture_output=True,
            check=False,
        )

        self.assertEqual(completed.returncode, 0, completed.stderr)

    def test_email_checks_are_feature_flag_aware(self) -> None:
        self.assertIn("emailWorkerEnabled", self.script)
        self.assertIn("emailEnabled", self.script)
        self.assertIn("emailConfigured", self.script)
        self.assertIn("emailTestMode", self.script)
        self.assertIn("emailAllowlistConfigured", self.script)
        self.assertIn("komui-email-worker", self.script)
        self.assertIn("komui-production-email-worker", self.script)

    def test_email_queue_check_covers_terminal_and_stale_jobs(self) -> None:
        self.assertIn("check email_worker_active", self.script)
        self.assertIn("check email_failed_or_stale_jobs", self.script)
        self.assertIn("status = 'failed'", self.script)
        self.assertIn("status in ('pending', 'retry')", self.script)
        self.assertIn("status = 'processing'", self.script)
        self.assertIn("KOMUI_HEALTHCHECK_EMAIL_STALE_MINUTES:-10", self.script)

    def test_healthcheck_does_not_read_or_print_email_secrets(self) -> None:
        self.assertNotIn("UNISENDER_GO_API_KEY", self.script)
        self.assertNotIn("recipient_email", self.script)
        self.assertNotIn("customer_email", self.script)

    def test_storefront_offer_check_covers_size_and_global_offer_identity(self) -> None:
        self.assertIn("check storefront_offers_unambiguous", self.script)
        self.assertIn("invalid_sizes", self.script)
        self.assertIn("invalid_offer_ids", self.script)
        self.assertIn("upper(btrim(item.offer ->> 'size'))", self.script)
        self.assertIn("btrim(item.offer ->> 'offer_id')", self.script)
        self.assertIn("item.offer -> 'archived' is distinct from 'true'::jsonb", self.script)
        self.assertIn("item.offer -> 'visible' is distinct from 'false'::jsonb", self.script)

    def test_staging_credentials_are_passed_on_stdin_not_in_curl_argv(self) -> None:
        self.assertNotRegex(self.script, r"curl[^\n]*(?:^|\s)(?:-u|--user)(?:\s|=)")
        self.assertIn('curl -q --config - "$@" "$url"', self.script)
        self.assertIn("check stage_root_https stage_root_https", self.script)
        self.assertIn("check stage_products_https stage_products_https", self.script)


if __name__ == "__main__":
    unittest.main()
