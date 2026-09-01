import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "komui-backup.sh"


class KomuiBackupContractTest(unittest.TestCase):
    def run_without_side_effects(self, *arguments: str) -> tuple[subprocess.CompletedProcess[str], Path]:
        temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(temporary_directory.cleanup)
        root = Path(temporary_directory.name) / "backup-root"
        environment = os.environ.copy()
        environment.update(
            {
                "KOMUI_BACKUP_ROOT": str(root),
                "KOMUI_BACKUP_KEY_FILE": str(root / "missing.key"),
                "KOMUI_BACKUP_EXTERNAL_ENV_FILE": str(root / "missing.env"),
            }
        )
        completed = subprocess.run(
            ["bash", str(SCRIPT), *arguments],
            check=False,
            capture_output=True,
            text=True,
            env=environment,
        )
        return completed, root

    def test_help_is_read_only(self) -> None:
        completed, root = self.run_without_side_effects("--help")

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn("format-v2", completed.stdout)
        self.assertFalse(root.exists())

    def test_short_help_is_read_only(self) -> None:
        completed, root = self.run_without_side_effects("-h")

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertFalse(root.exists())

    def test_unknown_argument_fails_before_creating_files(self) -> None:
        completed, root = self.run_without_side_effects("--definitely-not-valid")

        self.assertEqual(completed.returncode, 64)
        self.assertIn("does not accept arguments", completed.stderr)
        self.assertFalse(root.exists())

    def test_multiple_arguments_fail_before_creating_files(self) -> None:
        completed, root = self.run_without_side_effects("--help", "unexpected")

        self.assertEqual(completed.returncode, 64)
        self.assertFalse(root.exists())

    def test_shell_syntax_is_valid(self) -> None:
        completed = subprocess.run(
            ["bash", "-n", str(SCRIPT)],
            check=False,
            capture_output=True,
            text=True,
        )

        self.assertEqual(completed.returncode, 0, completed.stderr)

    def test_database_dump_preserves_owner_and_acl_metadata(self) -> None:
        source = SCRIPT.read_text(encoding="utf-8")

        self.assertIn('pg_dump -Fc --create "$db_name"', source)
        self.assertNotIn("--no-acl", source)
        self.assertNotIn("--no-owner", source)
        self.assertIn("DEFAULT ACL", source)
        self.assertIn("grant_revoke_commands", source)
        self.assertIn("security-inventory.sql", source)
        self.assertIn("cluster-security-inventory.sql", source)
        self.assertNotIn('-f "$TMP_DIR/security-inventory.sql"', source)
        self.assertNotIn('-f "$TMP_DIR/cluster-security-inventory.sql"', source)

    def test_cluster_security_inventory_has_explicit_recoverable_scope(self) -> None:
        source = SCRIPT.read_text(encoding="utf-8")

        self.assertIn('d.datname IN (${cluster_database_scope})', source)
        self.assertIn('"fullClusterRecovery": False', source)
        self.assertIn('"globalRolesAndMemberships": True', source)
        self.assertIn('"settings": "global-and-scoped-databases"', source)
        self.assertIn('"fullPostgresCluster": False', source)
        self.assertIn("pg_get_userbyid(s.setrole) NULLS FIRST", source)
        self.assertIn("unsupported ALTER ROLE ALL setting exists", source)
        self.assertIn("unsupported predefined-role setting exists", source)
        self.assertIn("WHERE NOT (", source)
        self.assertIn("pg_get_userbyid(m.roleid) ~ '^pg_'", source)
        self.assertIn("pg_get_userbyid(m.member) ~ '^pg_'", source)
        self.assertNotIn(
            ") ORDER BY s.setdatabase, s.setrole, s.setconfig::text)", source
        )

    def test_backup_key_is_fail_closed_and_not_self_archived(self) -> None:
        source = SCRIPT.read_text(encoding="utf-8")

        self.assertNotIn("openssl rand", source)
        self.assertIn('validate_secret_file "Backup encryption key"', source)
        self.assertIn('--exclude="${KEY_FILE#/}"', source)
        self.assertIn('key_member = sys.argv[1:]', source)
        self.assertIn('for forbidden in {key_member,', source)
        self.assertIn("--exclude='etc/komui/backup.key'", source)
        self.assertIn("encryption key leaked into runtime archive", source)
        self.assertIn('"encryptionKeyIncluded": False', source)

    def test_runtime_capture_contains_production_control_plane(self) -> None:
        source = SCRIPT.read_text(encoding="utf-8")
        required_fragments = (
            "/etc/nginx",
            "/etc/letsencrypt",
            "/etc/postgresql",
            "/opt/komui/production-frontend-releases",
            "/opt/komui/production-current",
            "/var/lib/komui",
            "/usr/local/sbin",
            "komui-production-backend.service",
            "runtime-inventory.json",
            "runtime-identities.json",
        )

        for fragment in required_fragments:
            with self.subTest(fragment=fragment):
                self.assertIn(fragment, source)
        self.assertNotIn("--ignore-failed-read", source)
        self.assertNotIn("done < <(", source)
        self.assertIn('DYNAMIC_SBIN_PATHS="$TMP_DIR/runtime-sbin-paths.nul"', source)
        self.assertIn('DYNAMIC_SYSTEMD_PATHS="$TMP_DIR/runtime-systemd-paths.nul"', source)
        self.assertIn('link_member["linkTarget"] != raw_target', source)

    def test_backup_does_not_reenter_deploy_or_prune_locks(self) -> None:
        source = SCRIPT.read_text(encoding="utf-8")

        self.assertNotIn("/run/komui-deploy.lock", source)
        self.assertNotIn("/run/komui-prune-releases.lock", source)
        self.assertIn("resolved_target", source)
        self.assertIn('capture_activation_links "$ACTIVATION_LINKS_AFTER"', source)

    def test_archive_publish_and_external_upload_are_fail_closed(self) -> None:
        source = SCRIPT.read_text(encoding="utf-8")

        self.assertIn("FINAL_ARCHIVE_PARTIAL", source)
        self.assertIn('mv -- "$FINAL_ARCHIVE_PARTIAL" "$FINAL_ARCHIVE"', source)
        self.assertIn("external upload is mandatory", source)
        self.assertIn("Uploaded archive size mismatch", source)
        self.assertIn("Downloaded archive checksum mismatch", source)
        self.assertIn("Downloaded checksum object differs", source)
        self.assertIn("Retention runs only", source)
        self.assertLess(
            source.index('remote_archive_size="$(remote_size'),
            source.index('mv -- "$FINAL_ARCHIVE_PARTIAL" "$FINAL_ARCHIVE"'),
        )
        self.assertLess(
            source.index('download_remote "$destination_archive"'),
            source.index("# The checksum object is the remote commit marker"),
        )
        self.assertLess(
            source.index('mv -- "$FINAL_CHECKSUM_PARTIAL" "$FINAL_CHECKSUM"'),
            source.index('mv -- "$FINAL_ARCHIVE_PARTIAL" "$FINAL_ARCHIVE"'),
        )

    def test_secrets_are_not_exported_to_database_tools(self) -> None:
        source = SCRIPT.read_text(encoding="utf-8")

        self.assertIn("export -n AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY", source)
        self.assertIn("run_aws() (", source)
        self.assertNotIn("env AWS_ACCESS_KEY_ID", source)

    def test_stale_plaintext_is_cleaned_before_free_space_gate(self) -> None:
        source = SCRIPT.read_text(encoding="utf-8")

        self.assertIn("stale_workdir_removed", source)
        self.assertIn("stale_partial_removed", source)
        self.assertIn("orphan_checksum_removed", source)
        self.assertLess(source.index("stale_workdir_removed"), source.index('available_kb="$(df'))

    def test_checksum_sidecar_contains_only_the_archive_basename(self) -> None:
        source = SCRIPT.read_text(encoding="utf-8")

        self.assertIn("printf '%s  %s\\n' \"$archive_sha\" \"$ARCHIVE_BASENAME\"", source)
        self.assertNotIn('sha256sum "$FINAL_ARCHIVE" > "$FINAL_ARCHIVE.sha256"', source)

    def test_manifest_is_versioned_and_explicit_about_limits(self) -> None:
        source = SCRIPT.read_text(encoding="utf-8")

        self.assertIn('"formatVersion": 2', source)
        self.assertIn('"ownerMetadata": True', source)
        self.assertIn('"objectPrivileges": True', source)
        self.assertIn('"productionRuntime": True', source)
        self.assertIn('"independentKeyEscrowVerified": False', source)


if __name__ == "__main__":
    unittest.main()
