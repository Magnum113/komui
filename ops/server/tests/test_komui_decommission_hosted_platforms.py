from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path


SCRIPT_PATH = (
    Path(__file__).resolve().parents[1] / "komui-decommission-hosted-platforms"
)
API_VHOST_PATH = Path(__file__).resolve().parents[1] / "komui-api-retired.nginx"
PRODUCTION_VHOST_PATH = Path(__file__).resolve().parents[1] / "komui-production.nginx"


class KomuiHostedPlatformDecommissionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.script = SCRIPT_PATH.read_text(encoding="utf-8")
        cls.api_vhost = API_VHOST_PATH.read_text(encoding="utf-8")
        cls.production_vhost = PRODUCTION_VHOST_PATH.read_text(encoding="utf-8")

    def restore_function(self) -> str:
        start = self.script.index("restore_path() {")
        end = self.script.index("\n}\n\nrollback()", start) + len("\n}")
        return self.script[start:end]

    def test_script_is_executable_and_shell_syntax_is_valid(self) -> None:
        self.assertTrue(os.access(SCRIPT_PATH, os.X_OK))
        completed = subprocess.run(
            ["bash", "-n", str(SCRIPT_PATH)],
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)

    def test_help_is_safe_without_root(self) -> None:
        completed = subprocess.run(
            ["bash", str(SCRIPT_PATH), "--help"],
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn("root-only rollback snapshot", completed.stdout)

    def test_switch_is_stopped_before_mutable_runtime_is_removed(self) -> None:
        stop_offset = self.script.index(
            "systemctl disable --now komui-traffic-switch.path"
        )
        install_offset = self.script.index(
            'install -D -m 0644 "$runtime_source" "$runtime_path"'
        )
        remove_offset = self.script.index('  "$path_unit" \\')
        self.assertLess(stop_offset, install_offset)
        self.assertLess(stop_offset, remove_offset)
        self.assertIn("systemctl daemon-reload", self.script)
        self.assertIn(
            "systemctl is-active --quiet komui-traffic-switch.service",
            self.script,
        )
        self.assertIn(
            'cutover_tls_helper="/usr/local/sbin/komui-production-issue-cert-and-enable"',
            self.script,
        )
        self.assertIn('"$cutover_tls_helper"', self.script)

    def test_direct_run_and_deploy_share_the_same_lock(self) -> None:
        self.assertIn(
            'deploy_lock_path="${KOMUI_DEPLOY_LOCK_PATH:-/run/komui-deploy.lock}"',
            self.script,
        )
        self.assertIn('exec 8>"$deploy_lock_path"', self.script)
        self.assertIn("flock -n 8", self.script)
        self.assertIn("/proc/$$/fd/9", self.script)
        self.assertIn("flock -n 9", self.script)

    def test_active_vhost_uses_an_immutable_server_only_snippet(self) -> None:
        self.assertIn("komui-production-server.conf", self.production_vhost)
        self.assertNotIn("komui-production-runtime.conf", self.production_vhost)
        self.assertIn(
            'old_runtime_path="/etc/nginx/snippets/komui-production-runtime.conf"',
            self.script,
        )
        self.assertIn('rm -f -- "$old_runtime_path"', self.script)
        self.assertIn("Runtime snippet contains an external proxy target", self.script)

    def test_legacy_api_is_a_tombstone_without_an_upstream(self) -> None:
        self.assertIn("server_name api.komui.ru", self.api_vhost)
        self.assertIn("return 410", self.api_vhost)
        self.assertNotIn("proxy_pass", self.api_vhost)
        self.assertNotIn("supabase.co", self.api_vhost)
        self.assertNotIn("vercel.app", self.api_vhost)
        self.assertIn("https://api.komui.ru/rest/v1/", self.script)
        self.assertIn("https://api.komui.ru/functions/v1/promo-validate", self.script)
        self.assertIn("https://api.komui.ru/healthz", self.script)

    def test_finalized_legacy_api_does_not_require_tls_tombstone(self) -> None:
        self.assertIn(
            'api_retirement_marker="/etc/komui/api.komui.ru-finalized"',
            self.script,
        )
        self.assertIn('if [[ "$api_tombstone_enabled" -eq 1 ]]', self.script)
        self.assertIn(
            'rm -f -- "$api_site_enabled" "$api_site_available"',
            self.script,
        )
        self.assertIn(
            "api.komui.ru TLS certificate is absent without the finalization marker",
            self.script,
        )

    def test_only_retired_environment_keys_are_filtered(self) -> None:
        for key in (
            "ENABLE_TRAFFIC_SWITCH",
            "TRAFFIC_SWITCH_STATE_DIR",
            "TRAFFIC_SWITCH_REQUEST_TIMEOUT_MS",
            "LEGACY_ORIGIN",
            "LEGACY_FUNCTION_API_KEY_PREFIX",
            "SUPABASE_URL",
            "SUPABASE_SERVICE_KEY",
            "OZON_IMPORT_WRITE_SUPABASE",
        ):
            self.assertIn(key, self.script)
        self.assertIn('chown --reference="$path" "$temporary"', self.script)
        self.assertIn('chmod --reference="$path" "$temporary"', self.script)
        self.assertIn("assert_env_keys_absent", self.script)
        self.assertIn('/proc/$main_pid/environ', self.script)

    def test_active_backend_and_email_services_are_restarted_and_checked(self) -> None:
        for unit in (
            "komui-backend.service",
            "komui-production-backend.service",
            "komui-email-worker.service",
            "komui-production-email-worker.service",
        ):
            self.assertIn(unit, self.script)
        self.assertIn("wait_for_backend", self.script)
        self.assertIn("http://127.0.0.1:3000/health/ready", self.script)
        self.assertIn("http://127.0.0.1:3001/health/ready", self.script)

    def test_failure_restores_snapshot_and_nginx(self) -> None:
        self.assertIn("trap on_exit EXIT", self.script)
        self.assertIn("rollback()", self.script)
        self.assertIn("restore_path", self.script)
        self.assertIn("nginx -t && systemctl reload nginx", self.script)
        self.assertIn('if [[ "$services_restarted" -eq 1 ]]', self.script)

    def test_unknown_snapshot_state_never_removes_existing_path(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            backup_dir = root / "backup"
            manifest = backup_dir / "manifest.tsv"
            target = root / "etc" / "komui" / "backend.env"
            backup_dir.mkdir()
            manifest.touch()
            target.parent.mkdir(parents=True)
            target.write_text("KEEP=1\n", encoding="utf-8")
            completed = subprocess.run(
                ["bash", "-c", f"{self.restore_function()}\nrestore_path \"$3\"", "_", str(backup_dir), str(manifest), str(target)],
                text=True,
                capture_output=True,
                check=False,
                env={
                    **os.environ,
                    "backup_dir": str(backup_dir),
                    "manifest": str(manifest),
                },
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(target.read_text(encoding="utf-8"), "KEEP=1\n")

    def test_restore_preserves_existing_parent_directory_mode(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            backup_dir = root / "backup"
            manifest = backup_dir / "manifest.tsv"
            target = root / "etc" / "komui" / "backend.env"
            relative = Path(str(target).lstrip("/"))
            archived = backup_dir / relative
            archived.parent.mkdir(parents=True)
            archived.write_text("OLD=1\n", encoding="utf-8")
            target.parent.mkdir(parents=True)
            target.parent.chmod(0o710)
            target.write_text("NEW=1\n", encoding="utf-8")
            manifest.write_text(f"present\t{target}\n", encoding="utf-8")
            completed = subprocess.run(
                ["bash", "-c", f"{self.restore_function()}\nrestore_path \"$3\"", "_", str(backup_dir), str(manifest), str(target)],
                text=True,
                capture_output=True,
                check=False,
                env={
                    **os.environ,
                    "backup_dir": str(backup_dir),
                    "manifest": str(manifest),
                },
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(target.read_text(encoding="utf-8"), "OLD=1\n")
            self.assertEqual(target.parent.stat().st_mode & 0o777, 0o710)


if __name__ == "__main__":
    unittest.main()
