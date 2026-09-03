from __future__ import annotations

import subprocess
import unittest
from pathlib import Path


DEPLOY_PATH = Path(__file__).resolve().parents[1] / "komui-deploy-from-git"


class KomuiDeployFromGitCompatibilityTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.script = DEPLOY_PATH.read_text(encoding="utf-8")

    def test_shell_syntax_is_valid(self) -> None:
        completed = subprocess.run(
            ["bash", "-n", str(DEPLOY_PATH)],
            text=True,
            capture_output=True,
            check=False,
        )

        self.assertEqual(completed.returncode, 0, completed.stderr)

    def test_help_documents_non_activation_compatibility_check(self) -> None:
        completed = subprocess.run(
            ["bash", str(DEPLOY_PATH), "--help"],
            text=True,
            capture_output=True,
            check=False,
        )

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn("--check-compatibility-only", completed.stdout)
        self.assertIn("without\n      building or activating", completed.stdout)

    def test_github_network_operations_use_compatible_protocol(self) -> None:
        self.assertIn(
            'git -c protocol.version=1 -c http.version=HTTP/1.1 clone --branch "$branch"',
            self.script,
        )
        self.assertIn(
            'git -c protocol.version=1 -c http.version=HTTP/1.1 fetch --prune origin "$branch"',
            self.script,
        )

    def test_guard_covers_source_and_database_mismatch_in_both_directions(self) -> None:
        self.assertIn('database_name="komui_staging"', self.script)
        self.assertIn('database_name="komui_production"', self.script)
        self.assertIn("20260830143000_harden_payment_consistency.sql", self.script)
        self.assertIn('"server/src/cdekEffects.ts"', self.script)
        self.assertIn('"server/src/tbankReconciliation.ts"', self.script)
        self.assertIn("to_regclass('public.merch_order_effects')", self.script)
        self.assertIn("reconciliation_attempts", self.script)
        self.assertIn("partial or invalid payment-consistency schema", self.script)
        self.assertIn("payment-consistency source/schema mismatch", self.script)

        guard_offset = self.script.index("enforce_payment_consistency_compatibility\n")
        final_guard_offset = self.script.rindex("enforce_payment_consistency_compatibility\n")
        build_offset = self.script.index('log "removing stale backend dependency/build artifacts"')
        activation_offset = self.script.index('log "activating backend"')
        self.assertEqual(
            self.script.count("  enforce_payment_consistency_compatibility\n"),
            2,
        )
        self.assertLess(guard_offset, build_offset)
        self.assertLess(build_offset, final_guard_offset)
        self.assertLess(final_guard_offset, activation_offset)

    def test_email_contacts_guard_requires_schema_before_new_source(self) -> None:
        self.assertIn("20260901170000_add_email_contacts_and_subscriptions.sql", self.script)
        self.assertIn('"server/src/email/contacts.ts"', self.script)
        self.assertIn('"server/src/email/subscriptions.ts"', self.script)
        self.assertIn("to_regclass('public.merch_email_contacts')", self.script)
        self.assertIn("to_regclass('public.merch_email_consent_events')", self.script)
        self.assertIn("partial or invalid email-contacts schema", self.script)
        self.assertIn("email-contacts source requires the migrated schema", self.script)
        self.assertIn(
            '"$source_state" == "email-contacts-v1" && "$database_state" != "email-contacts-v1"',
            self.script,
        )

        guard_offset = self.script.index("enforce_email_contacts_compatibility\n")
        final_guard_offset = self.script.rindex("enforce_email_contacts_compatibility\n")
        build_offset = self.script.index('log "removing stale backend dependency/build artifacts"')
        activation_offset = self.script.index('log "activating backend"')
        self.assertEqual(
            self.script.count("  enforce_email_contacts_compatibility\n"),
            2,
        )
        self.assertLess(guard_offset, build_offset)
        self.assertLess(build_offset, final_guard_offset)
        self.assertLess(final_guard_offset, activation_offset)

    def test_hoodie_variant_guard_requires_exact_schema_and_partition(self) -> None:
        self.assertIn(
            "20260903125110_split_hoodie_storefront_variants.sql",
            self.script,
        )
        self.assertIn('"assets/product-offers.js"', self.script)
        self.assertIn("indisunique", self.script)
        self.assertIn("indisvalid", self.script)
        self.assertIn("indisready", self.script)
        self.assertIn("to_jsonb(product) ->> 'variant_group_key'", self.script)
        self.assertIn("D18-HDY-EMB-BLK-CRP-NF-S", self.script)
        self.assertIn("D18-HDY-EMB-BLK-REG-NF-2XL", self.script)
        self.assertIn("D8-HDY-EMB-WHT-REG-FLC-S", self.script)
        self.assertIn("D8-HDY-EMB-WHT-REG-NF-2XL", self.script)
        self.assertIn("partial or invalid hoodie-variants state", self.script)
        self.assertIn("hoodie-variants source/schema mismatch", self.script)

        guard_offset = self.script.index("enforce_hoodie_variants_compatibility\n")
        final_guard_offset = self.script.rindex("enforce_hoodie_variants_compatibility\n")
        build_offset = self.script.index('log "removing stale backend dependency/build artifacts"')
        activation_offset = self.script.index('log "activating backend"')
        self.assertEqual(
            self.script.count("  enforce_hoodie_variants_compatibility\n"),
            2,
        )
        self.assertLess(guard_offset, build_offset)
        self.assertLess(build_offset, final_guard_offset)
        self.assertLess(final_guard_offset, activation_offset)

    def test_staging_credentials_are_passed_on_stdin_not_in_curl_argv(self) -> None:
        self.assertNotRegex(self.script, r"curl[^\n]*(?:^|\s)(?:-u|--user)(?:\s|=)")
        self.assertIn('curl -q --config - "$@" "$url"', self.script)
        self.assertEqual(self.script.count("staging_curl \"$public_smoke_url\""), 2)

    def test_dependency_install_does_not_block_deploy_on_remote_audit(self) -> None:
        self.assertIn(
            "npm --prefix server ci --no-audit --no-fund",
            self.script,
        )
        self.assertIn(
            'npm --prefix "$backend_release_dir/backend" ci --omit=dev --no-audit --no-fund',
            self.script,
        )

    def test_production_decommissions_hosted_runtime_after_backend_smoke(self) -> None:
        decommission = "komui-decommission-hosted-platforms"
        backend_offset = self.script.index('log "activating backend"')
        decommission_offset = self.script.index(
            'log "decommissioning retired hosted-platform runtime"'
        )
        frontend_offset = self.script.index('log "activating frontend"')

        self.assertIn('[[ "$target" == "prod"', self.script)
        self.assertIn(decommission, self.script)
        self.assertIn("KOMUI_DEPLOY_LOCK_HELD=1", self.script)
        self.assertIn(
            "does not contain the executable hosted-platform decommission gate",
            self.script,
        )
        self.assertLess(backend_offset, decommission_offset)
        self.assertLess(decommission_offset, frontend_offset)


if __name__ == "__main__":
    unittest.main()
