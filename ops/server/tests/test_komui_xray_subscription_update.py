from __future__ import annotations

import base64
import importlib.machinery
import importlib.util
import json
import os
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest import mock
from urllib.parse import urlencode


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "komui-xray-subscription-update"
loader = importlib.machinery.SourceFileLoader("komui_xray_subscription_update_test", str(SCRIPT_PATH))
spec = importlib.util.spec_from_loader(loader.name, loader)
assert spec is not None
module = importlib.util.module_from_spec(spec)
loader.exec_module(module)


TEST_UUID = "5c9b7ac4-2f2b-4f59-a821-c83c893ed43e"
TEST_PUBLIC_KEY = "A" * 43


def vless_uri(network="tcp", **overrides):
    query = {
        "encryption": "none",
        "fp": "chrome",
        "pbk": TEST_PUBLIC_KEY,
        "security": "reality",
        "sid": "a1b2",
        "sni": "front.example.net",
        "spx": "/",
        "type": network,
    }
    if network == "grpc":
        query.update({"authority": "", "serviceName": "komui-grpc"})
    elif network == "xhttp":
        query.update(
            {
                "extra": json.dumps(
                    {"mode": "auto", "xPaddingBytes": "100-1000"},
                    separators=(",", ":"),
                ),
                "host": "",
                "mode": "auto",
                "path": "/komui-xhttp",
                "x_padding_bytes": "100-1000",
            }
        )
    query.update(overrides.pop("query", {}))
    user_id = overrides.pop("user_id", TEST_UUID)
    host = overrides.pop("host", "vpn.example.net")
    port = overrides.pop("port", 443)
    assert not overrides
    return f"vless://{user_id}@{host}:{port}?{urlencode(query)}#test-profile"


def vless_outbound(**overrides):
    value = {
        "tag": "provider-tag",
        "protocol": "vless",
        "settings": {
            "vnext": [
                {
                    "address": "vpn.example.net",
                    "port": 443,
                    "users": [
                        {
                            "id": "5c9b7ac4-2f2b-4f59-a821-c83c893ed43e",
                            "encryption": "none",
                            "flow": "xtls-rprx-vision",
                        }
                    ],
                }
            ]
        },
        "streamSettings": {
            "network": "xhttp",
            "security": "reality",
            "realitySettings": {
                "fingerprint": "chrome",
                "password": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                "serverName": "vpn.example.net",
                "shortId": "",
                "show": False,
                "spiderX": "/",
            },
            "xhttpSettings": {
                "mode": "auto",
                "path": "/transport",
                "extra": {
                    "xPaddingBytes": "100-1000",
                    "xmux": {"maxConcurrency": "1-2", "hKeepAlivePeriod": 0},
                },
            },
        },
    }
    value.update(overrides)
    return value


class SubscriptionUpdaterTests(unittest.TestCase):
    def test_default_credentials_do_not_share_backend_config_directory(self):
        self.assertEqual(
            module.DEFAULT_URL_FILE,
            Path("/etc/komui-xray/subscription.url"),
        )
        self.assertEqual(
            module.DEFAULT_HWID_FILE,
            Path("/etc/komui-xray/subscription.hwid"),
        )
        self.assertEqual(
            module.DEFAULT_SECONDARY_URL_FILE,
            Path("/etc/komui-xray/subscription-secondary.url"),
        )

    def test_parses_vless_tcp_uri_into_regular_outbound(self):
        result = module.parse_vless_uri(vless_uri("tcp"))
        self.assertEqual(result["protocol"], "vless")
        self.assertEqual(result["settings"]["vnext"][0]["users"][0]["id"], TEST_UUID)
        stream = result["streamSettings"]
        self.assertEqual(stream["network"], "tcp")
        self.assertNotIn("tcpSettings", stream)
        self.assertEqual(stream["realitySettings"]["password"], TEST_PUBLIC_KEY)

    def test_parses_vless_grpc_uri_and_preserves_empty_authority_until_pinning(self):
        result = module.parse_vless_uri(vless_uri("grpc"))
        grpc = result["streamSettings"]["grpcSettings"]
        self.assertEqual(grpc["serviceName"], "komui-grpc")
        self.assertEqual(grpc["authority"], "")
        self.assertFalse(grpc["multiMode"])
        sanitized = module.sanitize_outbound(result, "subscription-secondary-001")
        public_result = [(None, None, None, None, ("1.1.1.1", 443))]
        with mock.patch.object(module.socket, "getaddrinfo", return_value=public_result):
            pinned = module.pin_public_endpoint(sanitized)
        self.assertEqual(
            pinned["streamSettings"]["grpcSettings"]["authority"],
            "vpn.example.net:443",
        )
        self.assertEqual(
            pinned["streamSettings"]["realitySettings"]["serverName"],
            "front.example.net",
        )

    def test_parses_vless_xhttp_uri_and_removes_redundant_nested_mode(self):
        result = module.parse_vless_uri(vless_uri("xhttp"))
        xhttp = result["streamSettings"]["xhttpSettings"]
        self.assertEqual(xhttp["host"], "front.example.net")
        self.assertEqual(xhttp["mode"], "auto")
        self.assertEqual(xhttp["extra"], {"xPaddingBytes": "100-1000"})
        sanitized = module.sanitize_outbound(result, "subscription-secondary-001")
        self.assertEqual(sanitized["streamSettings"]["network"], "xhttp")

    def test_rejects_duplicate_and_unknown_vless_query_fields(self):
        duplicate = vless_uri("tcp").replace("#test-profile", "&fp=firefox#test-profile")
        with self.assertRaises(module.UpdateError):
            module.parse_vless_uri(duplicate)
        with self.assertRaises(module.UpdateError):
            module.parse_vless_uri(vless_uri("tcp", query={"unsafe": "value"}))

    def test_rejects_malformed_percent_and_noncanonical_uuid(self):
        malformed = vless_uri("tcp").replace("spx=%2F", "spx=%ZZ")
        with self.assertRaises(module.UpdateError):
            module.parse_vless_uri(malformed)
        with self.assertRaises(module.UpdateError):
            module.parse_vless_uri(vless_uri("tcp", user_id=TEST_UUID.upper()))

    def test_rejects_disagreeing_xhttp_duplicate_settings(self):
        conflicting = json.dumps(
            {"mode": "stream-up", "xPaddingBytes": "100-1000"}, separators=(",", ":")
        )
        with self.assertRaises(module.UpdateError):
            module.parse_vless_uri(vless_uri("xhttp", query={"extra": conflicting}))

    def test_rejects_duplicate_or_unknown_xhttp_extra_fields(self):
        duplicate = '{"mode":"auto","mode":"auto","xPaddingBytes":"100-1000"}'
        with self.assertRaises(module.UpdateError):
            module.parse_vless_uri(vless_uri("xhttp", query={"extra": duplicate}))
        unknown = '{"mode":"auto","xPaddingBytes":"100-1000","downloadSettings":{}}'
        with self.assertRaises(module.UpdateError):
            module.parse_vless_uri(vless_uri("xhttp", query={"extra": unknown}))

    def test_decodes_padded_and_unpadded_base64_vless_lists(self):
        decoded = "\n".join([vless_uri("grpc"), vless_uri("xhttp"), vless_uri("tcp")])
        encoded = base64.b64encode(decoded.encode("utf-8"))
        for body in (encoded, encoded.rstrip(b"=")):
            result = module.parse_base64_vless_subscription(body)
            self.assertEqual([item["streamSettings"]["network"] for item in result], ["grpc", "xhttp", "tcp"])

    def test_rejects_invalid_base64_utf8_and_too_many_profiles(self):
        with self.assertRaises(module.UpdateError):
            module.parse_base64_vless_subscription(b"!!!!")
        with self.assertRaises(module.UpdateError):
            module.parse_base64_vless_subscription(base64.b64encode(b"\xff"))
        too_many = "\n".join(vless_uri("tcp") for _ in range(module.MAX_PROFILES + 1))
        with self.assertRaises(module.UpdateError):
            module.parse_base64_vless_subscription(base64.b64encode(too_many.encode("utf-8")))

    def test_extracts_only_proxy_outbound(self):
        payload = [
            {
                "inbounds": [{"listen": "0.0.0.0", "port": 1}],
                "routing": {"rules": [{"outboundTag": "provider"}]},
                "dns": {"servers": ["example"]},
                "outbounds": [
                    vless_outbound(),
                    {"tag": "direct", "protocol": "freedom"},
                    {"tag": "block", "protocol": "blackhole"},
                ],
            }
        ]
        result = module.extract_candidates(payload)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["tag"], "subscription-proxy-001")
        self.assertNotIn("inbounds", result[0])
        self.assertNotIn("routing", result[0])
        self.assertNotIn("dns", result[0])

    def test_generated_inbounds_are_loopback_only(self):
        outbound = module.sanitize_outbound(vless_outbound(), "subscription-proxy-001")
        config = module.build_config(outbound, 10808, 10809)
        self.assertEqual(
            [(item["listen"], item["port"]) for item in config["inbounds"]],
            [("127.0.0.1", 10808), ("127.0.0.1", 10809)],
        )
        self.assertEqual(config["routing"]["rules"][-1]["outboundTag"], "subscription-proxy-001")

    def test_rejects_private_proxy_endpoint(self):
        outbound = vless_outbound()
        outbound["settings"]["vnext"][0]["address"] = "127.0.0.1"
        with self.assertRaises(module.UpdateError):
            module.sanitize_outbound(outbound, "subscription-proxy-001")

    def test_rejects_localhost_proxy_endpoint(self):
        outbound = vless_outbound()
        outbound["settings"]["vnext"][0]["address"] = "metadata.google.internal"
        with self.assertRaises(module.UpdateError):
            module.sanitize_outbound(outbound, "subscription-proxy-001")

    def test_rejects_non_integer_proxy_port(self):
        outbound = vless_outbound()
        outbound["settings"]["vnext"][0]["port"] = float("inf")
        with self.assertRaises(module.UpdateError):
            module.sanitize_outbound(outbound, "subscription-proxy-001")

    def test_rejects_sockopt(self):
        outbound = vless_outbound()
        outbound["streamSettings"]["sockopt"] = {"interface": "eth0"}
        with self.assertRaises(module.UpdateError):
            module.sanitize_outbound(outbound, "subscription-proxy-001")

    def test_rejects_invalid_user_id(self):
        outbound = vless_outbound()
        outbound["settings"]["vnext"][0]["users"][0]["id"] = "not-a-uuid"
        with self.assertRaises(module.UpdateError):
            module.sanitize_outbound(outbound, "subscription-proxy-001")

    def test_rejects_non_object_tls_settings(self):
        outbound = vless_outbound()
        outbound["streamSettings"] = {
            "network": "tcp",
            "security": "tls",
            "tlsSettings": "unsafe",
        }
        with self.assertRaises(module.UpdateError):
            module.sanitize_outbound(outbound, "subscription-proxy-001")

    def test_rejects_nested_xhttp_download_settings(self):
        outbound = vless_outbound()
        outbound["streamSettings"]["xhttpSettings"]["extra"]["downloadSettings"] = {
            "network": "xhttp",
            "security": "tls",
            "tlsSettings": {"masterKeyLog": "/tmp/provider-controlled.log"},
        }
        with self.assertRaises(module.UpdateError):
            module.sanitize_outbound(outbound, "subscription-proxy-001")

    def test_rejects_excessive_xhttp_padding(self):
        outbound = vless_outbound()
        outbound["streamSettings"]["xhttpSettings"]["extra"]["xPaddingBytes"] = "1-999999999"
        with self.assertRaises(module.UpdateError):
            module.sanitize_outbound(outbound, "subscription-proxy-001")

    def test_rejects_pathological_numeric_range_without_crashing_scan(self):
        outbound = vless_outbound()
        outbound["streamSettings"]["xhttpSettings"]["extra"]["xPaddingBytes"] = "9" * 5000
        payload = [{"outbounds": [outbound, vless_outbound()]}]
        result = module.extract_candidates(payload)
        self.assertEqual(len(result), 1)

    def test_rejects_excessive_xmux_connections(self):
        outbound = vless_outbound()
        outbound["streamSettings"]["xhttpSettings"]["extra"]["xmux"]["maxConnections"] = 1000000
        with self.assertRaises(module.UpdateError):
            module.sanitize_outbound(outbound, "subscription-proxy-001")

    def test_rejects_nested_tls_socket_options(self):
        outbound = vless_outbound()
        outbound["streamSettings"] = {
            "network": "xhttp",
            "security": "tls",
            "tlsSettings": {"echSockopt": {"interface": "lo"}},
            "xhttpSettings": {"mode": "auto", "path": "/transport"},
        }
        with self.assertRaises(module.UpdateError):
            module.sanitize_outbound(outbound, "subscription-proxy-001")

    def test_rejects_plaintext_vless(self):
        outbound = vless_outbound()
        outbound["streamSettings"] = {"network": "tcp", "security": "none"}
        with self.assertRaises(module.UpdateError):
            module.sanitize_outbound(outbound, "subscription-proxy-001")

    def test_invalid_candidate_does_not_block_valid_candidate(self):
        invalid_before = vless_outbound()
        invalid_before["streamSettings"]["network"] = "kcp"
        invalid_after = vless_outbound()
        invalid_after["streamSettings"]["sockopt"] = {"interface": "lo"}
        payload = [{"outbounds": [invalid_before, vless_outbound(), invalid_after]}]
        result = module.extract_candidates(payload)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["tag"], "subscription-proxy-001")

    def test_xhttp_allowlist_preserves_required_safe_fields(self):
        result = module.sanitize_outbound(vless_outbound(), "subscription-proxy-001")
        stream = result["streamSettings"]
        self.assertEqual(stream["network"], "xhttp")
        self.assertEqual(stream["xhttpSettings"]["extra"]["xPaddingBytes"], "100-1000")
        self.assertEqual(
            stream["xhttpSettings"]["extra"]["xmux"]["hKeepAlivePeriod"],
            0,
        )
        self.assertNotIn("show", stream["realitySettings"])

    def test_drops_provider_fields_from_proxy_settings(self):
        outbound = vless_outbound()
        user = outbound["settings"]["vnext"][0]["users"][0]
        user["level"] = 99
        outbound["settings"]["vnext"][0]["unexpected"] = "ignored"
        result = module.sanitize_outbound(outbound, "subscription-proxy-001")
        endpoint = result["settings"]["vnext"][0]
        self.assertNotIn("unexpected", endpoint)
        self.assertNotIn("level", endpoint["users"][0])

    def test_rejects_allow_insecure(self):
        outbound = vless_outbound()
        outbound["streamSettings"] = {
            "network": "tcp",
            "security": "tls",
            "tlsSettings": {"allowInsecure": True},
        }
        with self.assertRaises(module.UpdateError):
            module.sanitize_outbound(outbound, "subscription-proxy-001")

    def test_parses_last_response_headers(self):
        raw = (
            "HTTP/1.1 302 Found\r\nLocation: https://example.test/sub\r\n\r\n"
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
            "Profile-Update-Interval: 2\r\n\r\n"
        )
        result = module.parse_last_header_block(raw)
        self.assertEqual(result["content-type"], "application/json")
        self.assertEqual(result["profile-update-interval"], "2")

    def test_fetch_limits_download_size_before_reading_body(self):
        observed_command = []

        def fake_run(command, **_kwargs):
            observed_command.extend(command)
            header_path = Path(command[command.index("--dump-header") + 1])
            body_path = Path(command[command.index("--output") + 1])
            header_path.write_text(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n",
                encoding="utf-8",
            )
            body_path.write_text("[{}]", encoding="utf-8")
            return SimpleNamespace(returncode=0)

        with tempfile.TemporaryDirectory() as directory, mock.patch.object(
            module.subprocess, "run", side_effect=fake_run
        ):
            module.fetch_subscription(
                "https://subscription.example/profile",
                "5c9b7ac4-2f2b-4f59-a821-c83c893ed43e",
                Path(directory),
            )
        size_index = observed_command.index("--max-filesize")
        self.assertEqual(observed_command[size_index + 1], str(module.MAX_RESPONSE_BYTES))

    def test_fetch_accepts_plain_text_base64_vless_subscription(self):
        encoded = base64.b64encode(vless_uri("tcp").encode("utf-8"))
        observed_input = ""

        def fake_run(command, **kwargs):
            nonlocal observed_input
            observed_input = kwargs["input"]
            header_path = Path(command[command.index("--dump-header") + 1])
            body_path = Path(command[command.index("--output") + 1])
            header_path.write_text(
                "HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\n"
                "Profile-Update-Interval: 12\r\n\r\n",
                encoding="utf-8",
            )
            body_path.write_bytes(encoded)
            return SimpleNamespace(returncode=0)

        with tempfile.TemporaryDirectory() as directory, mock.patch.object(
            module.subprocess, "run", side_effect=fake_run
        ):
            payload, interval = module.fetch_subscription(
                "https://subscription.example/profile",
                TEST_UUID,
                Path(directory),
            )
        self.assertEqual(interval, 12)
        self.assertEqual(payload[0]["streamSettings"]["network"], "tcp")
        self.assertIn("application/json, text/plain;q=0.9", observed_input)

    def test_nobody_process_has_no_supplementary_groups(self):
        with mock.patch.object(module.pwd, "getpwnam", return_value=SimpleNamespace(pw_uid=65534)):
            kwargs = module.nobody_process_kwargs(65534)
        self.assertEqual(kwargs, {"user": 65534, "group": 65534, "extra_groups": []})

    def test_update_due_logic(self):
        self.assertTrue(module.update_is_due({}, False))
        self.assertTrue(module.update_is_due({"nextDueAt": "invalid"}, False))
        self.assertFalse(module.update_is_due({"nextDueAt": "2999-01-01T00:00:00Z"}, False))
        self.assertTrue(module.update_is_due({"nextDueAt": "2999-01-01T00:00:00Z"}, True))

    def test_migrates_v1_state_to_primary_provider_without_writing(self):
        state = module.normalize_state(
            {
                "version": 1,
                "selectedProfileIndex": 24,
                "profileUpdateIntervalHours": 2,
                "lastSuccessfulAt": "2026-09-01T07:46:07Z",
                "nextDueAt": "2026-09-01T09:46:07Z",
                "activeConfigSha256": "a" * 64,
            }
        )
        self.assertEqual(state["version"], 2)
        self.assertEqual(state["activeProvider"], "primary")
        self.assertEqual(state["providers"]["primary"]["preferredProfileIndex"], 24)
        self.assertEqual(state["selectedProfileIndex"], 24)
        self.assertEqual(state["providers"]["secondary"], {})

    def test_rejects_unknown_future_state_version(self):
        with self.assertRaises(module.UpdateError):
            module.normalize_state({"version": 3})

    def test_load_state_treats_only_missing_file_as_fresh_state(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            self.assertEqual(module.load_state(path), {})
            path.write_text("not-json", encoding="utf-8")
            with self.assertRaises(module.UpdateError):
                module.load_state(path)

    def test_sticky_provider_order_and_outage_failover_order(self):
        available = {"primary", "secondary"}
        self.assertEqual(
            module.provider_scan_order("secondary", True, available),
            ["secondary"],
        )
        self.assertEqual(
            module.provider_scan_order("secondary", False, available),
            ["primary", "secondary"],
        )
        self.assertEqual(
            module.provider_scan_order("primary", False, {"primary"}),
            ["primary"],
        )

    def test_success_state_switches_provider_and_preserves_other_preference(self):
        previous = module.normalize_state(
            {
                "version": 1,
                "selectedProfileIndex": 24,
                "profileUpdateIntervalHours": 2,
                "nextDueAt": "2026-09-01T09:46:07Z",
            }
        )
        now = datetime(2026, 9, 1, 12, 0, tzinfo=timezone.utc)
        state = module.build_success_state(
            previous,
            "secondary",
            2,
            "b" * 64,
            12,
            b"candidate-config",
            now,
        )
        self.assertEqual(state["activeProvider"], "secondary")
        self.assertEqual(state["selectedProfileIndex"], 2)
        self.assertEqual(state["profileUpdateIntervalHours"], 12)
        self.assertEqual(state["providers"]["primary"]["preferredProfileIndex"], 24)
        self.assertEqual(state["providers"]["secondary"]["preferredProfileSha256"], "b" * 64)

    def test_candidate_fingerprint_beats_stale_profile_index(self):
        first = module.sanitize_outbound(vless_outbound(), "subscription-primary-001")
        second_raw = vless_outbound()
        second_raw["settings"]["vnext"][0]["port"] = 8443
        second = module.sanitize_outbound(second_raw, "subscription-primary-002")
        fingerprint = module.outbound_fingerprint(second)
        ordered = module.order_candidates([second, first], 2, fingerprint)
        self.assertEqual(ordered[0][0], 1)

    def test_candidate_production_failure_rolls_back_and_is_retryable(self):
        def direct_write(path, data, _mode, _uid, _gid):
            Path(path).parent.mkdir(parents=True, exist_ok=True)
            Path(path).write_bytes(data)

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            active = root / "config.json"
            state_dir = root / "state"
            state_dir.mkdir()
            active.write_bytes(b"old-config")
            old_state = {
                "version": 1,
                "selectedProfileIndex": 24,
                "profileUpdateIntervalHours": 2,
            }
            (state_dir / "state.json").write_text(json.dumps(old_state), encoding="utf-8")
            with (
                mock.patch.object(module, "atomic_write", side_effect=direct_write),
                mock.patch.object(module, "restart_xray", side_effect=[True, True]),
                mock.patch.object(module, "proxy_is_healthy", return_value=False),
            ):
                with self.assertRaises(module.CandidateRejected):
                    module.activate_candidate(
                        b"new-config",
                        active,
                        state_dir,
                        os.getgid(),
                        12,
                        2,
                        "b" * 64,
                        "secondary",
                        module.normalize_state(old_state),
                    )
            self.assertEqual(active.read_bytes(), b"old-config")
            self.assertEqual(json.loads((state_dir / "state.json").read_text()), old_state)
            self.assertFalse((state_dir / "pending.json").exists())

    def test_pending_recovery_restores_config_and_state_together(self):
        def direct_write(path, data, _mode, _uid, _gid):
            Path(path).parent.mkdir(parents=True, exist_ok=True)
            Path(path).write_bytes(data)

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            active = root / "config.json"
            state_dir = root / "state"
            backup_dir = state_dir / "backups"
            backup_dir.mkdir(parents=True)
            marker_path = state_dir / "pending.json"
            state_path = state_dir / "state.json"
            backup_path = backup_dir / "config-old.json"
            old_state_data = b'{"version":1,"selectedProfileIndex":24}\n'
            active.write_bytes(b"new-config")
            state_path.write_bytes(b'{"version":2,"activeProvider":"secondary"}\n')
            backup_path.write_bytes(b"old-config")
            marker_path.write_text(
                json.dumps(
                    {
                        "backupPath": str(backup_path),
                        "stateExisted": True,
                        "previousStateBase64": base64.b64encode(old_state_data).decode("ascii"),
                    }
                ),
                encoding="utf-8",
            )
            with (
                mock.patch.object(module, "atomic_write", side_effect=direct_write),
                mock.patch.object(module, "restart_xray", return_value=True),
                mock.patch.object(module, "log"),
            ):
                module.recover_pending(marker_path, active, os.getgid())
            self.assertEqual(active.read_bytes(), b"old-config")
            self.assertEqual(state_path.read_bytes(), old_state_data)
            self.assertFalse(marker_path.exists())

    def test_main_continues_to_secondary_after_safe_production_rollback(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            primary_url = root / "primary.url"
            secondary_url = root / "secondary.url"
            primary_url.touch()
            secondary_url.touch()
            args = SimpleNamespace(
                force=True,
                url_file=primary_url,
                secondary_url_file=secondary_url,
                hwid_file=root / "hwid",
                xray=root / "xray",
                active_config=root / "config.json",
                state_dir=root / "state",
                runtime_dir=root / "runtime",
                lock_file=root / "runtime" / "lock",
            )
            candidates = [
                [{"tag": "subscription-primary-001", "protocol": "vless"}],
                [{"tag": "subscription-secondary-001", "protocol": "vless"}],
            ]
            provider_modes = []

            def record_canary_mode(_xray, _config, runtime_dir, _nobody_gid):
                provider_modes.append(runtime_dir.stat().st_mode & 0o777)
                return True

            with (
                mock.patch.object(module, "parse_args", return_value=args),
                mock.patch.object(module.os, "geteuid", return_value=0),
                mock.patch.object(module.os, "chown"),
                mock.patch.object(
                    module.grp, "getgrnam", return_value=SimpleNamespace(gr_gid=os.getgid())
                ),
                mock.patch.object(module, "recover_pending"),
                mock.patch.object(module, "load_state", return_value={}),
                mock.patch.object(module, "proxy_is_healthy", return_value=False),
                mock.patch.object(module, "read_secret", return_value=TEST_UUID),
                mock.patch.object(module, "validate_subscription_url"),
                mock.patch.object(module, "validate_hwid"),
                mock.patch.object(
                    module,
                    "fetch_subscription",
                    side_effect=[([{"provider": "primary"}], 2), ([{"provider": "secondary"}], 12)],
                ),
                mock.patch.object(module, "extract_candidates", side_effect=candidates),
                mock.patch.object(module, "pin_public_endpoint", side_effect=lambda item: item),
                mock.patch.object(module, "build_config", return_value={"config": True}),
                mock.patch.object(module, "write_json", return_value=b"candidate"),
                mock.patch.object(module, "syntax_test", return_value=True),
                mock.patch.object(module, "canary_test", side_effect=record_canary_mode),
                mock.patch.object(
                    module,
                    "activate_candidate",
                    side_effect=[module.CandidateRejected("rolled back"), None],
                ) as activate,
                mock.patch.object(module, "log"),
            ):
                self.assertEqual(module.main(), 0)
            self.assertEqual(activate.call_count, 2)
            self.assertEqual(activate.call_args_list[0].args[7], "primary")
            self.assertEqual(activate.call_args_list[1].args[7], "secondary")
            self.assertEqual(provider_modes, [0o750, 0o750])

    def test_main_starts_failover_if_proxy_dies_during_sticky_refresh(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            primary_url = root / "primary.url"
            secondary_url = root / "secondary.url"
            primary_url.touch()
            secondary_url.touch()
            args = SimpleNamespace(
                force=True,
                url_file=primary_url,
                secondary_url_file=secondary_url,
                hwid_file=root / "hwid",
                xray=root / "xray",
                active_config=root / "config.json",
                state_dir=root / "state",
                runtime_dir=root / "runtime",
                lock_file=root / "runtime" / "lock",
            )
            candidates = [
                [
                    {
                        "tag": f"subscription-primary-{index:03d}",
                        "protocol": "vless",
                    }
                    for index in range(1, module.MAX_PROFILES + 1)
                ],
                [{"tag": "subscription-secondary-001", "protocol": "vless"}],
            ]
            with (
                mock.patch.object(module, "parse_args", return_value=args),
                mock.patch.object(module.os, "geteuid", return_value=0),
                mock.patch.object(module.os, "chown"),
                mock.patch.object(
                    module.grp, "getgrnam", return_value=SimpleNamespace(gr_gid=os.getgid())
                ),
                mock.patch.object(module, "recover_pending"),
                mock.patch.object(module, "load_state", return_value={}),
                mock.patch.object(module, "proxy_is_healthy", side_effect=[True, False]),
                mock.patch.object(module, "read_secret", return_value=TEST_UUID),
                mock.patch.object(module, "validate_subscription_url"),
                mock.patch.object(module, "validate_hwid"),
                mock.patch.object(
                    module,
                    "fetch_subscription",
                    side_effect=[([{"provider": "primary"}], 2), ([{"provider": "secondary"}], 12)],
                ) as fetch,
                mock.patch.object(module, "extract_candidates", side_effect=candidates),
                mock.patch.object(module, "pin_public_endpoint", side_effect=lambda item: item),
                mock.patch.object(module, "build_config", return_value={"config": True}),
                mock.patch.object(module, "write_json", return_value=b"candidate"),
                mock.patch.object(module, "syntax_test", return_value=True),
                mock.patch.object(
                    module,
                    "canary_test",
                    side_effect=([False] * (module.MAX_PROFILES - module.FAILOVER_PROFILE_RESERVE))
                    + [True],
                ) as canary,
                mock.patch.object(module, "activate_candidate") as activate,
                mock.patch.object(module, "log"),
            ):
                self.assertEqual(module.main(), 0)
            self.assertEqual(fetch.call_count, 2)
            self.assertLessEqual(canary.call_count, module.MAX_TOTAL_PROFILES)
            self.assertEqual(activate.call_args.args[7], "secondary")

    def test_main_keeps_restored_healthy_proxy_after_refresh_rejection(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            primary_url = root / "primary.url"
            secondary_url = root / "secondary.url"
            primary_url.touch()
            secondary_url.touch()
            args = SimpleNamespace(
                force=True,
                url_file=primary_url,
                secondary_url_file=secondary_url,
                hwid_file=root / "hwid",
                xray=root / "xray",
                active_config=root / "config.json",
                state_dir=root / "state",
                runtime_dir=root / "runtime",
                lock_file=root / "runtime" / "lock",
            )
            with (
                mock.patch.object(module, "parse_args", return_value=args),
                mock.patch.object(module.os, "geteuid", return_value=0),
                mock.patch.object(module.os, "chown"),
                mock.patch.object(
                    module.grp, "getgrnam", return_value=SimpleNamespace(gr_gid=os.getgid())
                ),
                mock.patch.object(module, "recover_pending"),
                mock.patch.object(module, "load_state", return_value={}),
                mock.patch.object(module, "proxy_is_healthy", side_effect=[True, True]),
                mock.patch.object(module, "read_secret", return_value=TEST_UUID),
                mock.patch.object(module, "validate_subscription_url"),
                mock.patch.object(module, "validate_hwid"),
                mock.patch.object(
                    module, "fetch_subscription", return_value=([{"provider": "primary"}], 2)
                ) as fetch,
                mock.patch.object(
                    module,
                    "extract_candidates",
                    return_value=[{"tag": "subscription-primary-001", "protocol": "vless"}],
                ),
                mock.patch.object(module, "pin_public_endpoint", side_effect=lambda item: item),
                mock.patch.object(module, "build_config", return_value={"config": True}),
                mock.patch.object(module, "write_json", return_value=b"candidate"),
                mock.patch.object(module, "canary_test", return_value=True),
                mock.patch.object(
                    module,
                    "activate_candidate",
                    side_effect=module.CandidateRejected("rolled back"),
                ) as activate,
                mock.patch.object(module, "log"),
            ):
                self.assertEqual(module.main(), 0)
            self.assertEqual(fetch.call_count, 1)
            self.assertEqual(activate.call_count, 1)

    def test_combined_profile_cap_fits_current_two_provider_inventory(self):
        self.assertEqual(module.MAX_TOTAL_PROFILES, 32)
        self.assertEqual(module.MAX_SCAN_SECONDS, 30 * 60)
        self.assertEqual(
            module.provider_candidate_limit(32, "primary", {"secondary"}),
            29,
        )
        self.assertEqual(
            module.provider_candidate_limit(32, "secondary", {"primary"}),
            29,
        )
        self.assertEqual(module.provider_candidate_limit(3, "secondary", set()), 3)

    def test_secondary_refresh_reserves_primary_failover_capacity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            primary_url = root / "primary.url"
            secondary_url = root / "secondary.url"
            primary_url.touch()
            secondary_url.touch()
            args = SimpleNamespace(
                force=True,
                url_file=primary_url,
                secondary_url_file=secondary_url,
                hwid_file=root / "hwid",
                xray=root / "xray",
                active_config=root / "config.json",
                state_dir=root / "state",
                runtime_dir=root / "runtime",
                lock_file=root / "runtime" / "lock",
            )
            candidates = {
                "secondary": [
                    {
                        "tag": f"subscription-secondary-{index:03d}",
                        "protocol": "vless",
                    }
                    for index in range(1, module.MAX_PROFILES + 1)
                ],
                "primary": [
                    {"tag": "subscription-primary-001", "protocol": "vless"}
                ],
            }

            def fetch(_url, _hwid, runtime_dir):
                return ([{"provider": runtime_dir.name}], 2)

            def extract(_payload, tag_prefix):
                return candidates[tag_prefix.rsplit("-", 1)[-1]]

            with (
                mock.patch.object(module, "parse_args", return_value=args),
                mock.patch.object(module.os, "geteuid", return_value=0),
                mock.patch.object(module.os, "chown"),
                mock.patch.object(
                    module.grp, "getgrnam", return_value=SimpleNamespace(gr_gid=os.getgid())
                ),
                mock.patch.object(module, "recover_pending"),
                mock.patch.object(
                    module,
                    "load_state",
                    return_value={"version": 2, "activeProvider": "secondary"},
                ),
                mock.patch.object(module, "proxy_is_healthy", side_effect=[True, False]),
                mock.patch.object(module, "read_secret", return_value=TEST_UUID),
                mock.patch.object(module, "validate_subscription_url"),
                mock.patch.object(module, "validate_hwid"),
                mock.patch.object(module, "fetch_subscription", side_effect=fetch) as fetch_mock,
                mock.patch.object(module, "extract_candidates", side_effect=extract),
                mock.patch.object(module, "pin_public_endpoint", side_effect=lambda item: item),
                mock.patch.object(
                    module,
                    "build_config",
                    side_effect=lambda outbound, _socks, _http: {"tag": outbound["tag"]},
                ),
                mock.patch.object(
                    module,
                    "write_json",
                    side_effect=lambda _path, value, _mode, _uid, _gid: value["tag"].encode(),
                ),
                mock.patch.object(
                    module,
                    "canary_test",
                    side_effect=([False] * (module.MAX_PROFILES - module.FAILOVER_PROFILE_RESERVE))
                    + [True],
                ) as canary,
                mock.patch.object(module, "activate_candidate") as activate,
                mock.patch.object(module, "log"),
            ):
                self.assertEqual(module.main(), 0)

            self.assertEqual(fetch_mock.call_count, 2)
            self.assertEqual(canary.call_count, 30)
            self.assertEqual(activate.call_args.args[7], "primary")

    def test_secondary_reclaims_reserved_slots_when_primary_fetch_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            primary_url = root / "primary.url"
            secondary_url = root / "secondary.url"
            primary_url.touch()
            secondary_url.touch()
            args = SimpleNamespace(
                force=True,
                url_file=primary_url,
                secondary_url_file=secondary_url,
                hwid_file=root / "hwid",
                xray=root / "xray",
                active_config=root / "config.json",
                state_dir=root / "state",
                runtime_dir=root / "runtime",
                lock_file=root / "runtime" / "lock",
            )
            secondary_candidates = [
                {
                    "tag": f"subscription-secondary-{index:03d}",
                    "protocol": "vless",
                }
                for index in range(1, module.MAX_PROFILES + 1)
            ]
            attempted_tags = []

            def fetch(_url, _hwid, runtime_dir):
                if runtime_dir.name == "primary":
                    raise module.UpdateError("primary unavailable")
                return ([{"provider": "secondary"}], 2)

            def canary(_xray, config, _runtime_dir, _nobody_gid):
                attempted_tags.append(config["tag"])
                return config["tag"] == "subscription-secondary-032"

            with (
                mock.patch.object(module, "parse_args", return_value=args),
                mock.patch.object(module.os, "geteuid", return_value=0),
                mock.patch.object(module.os, "chown"),
                mock.patch.object(
                    module.grp, "getgrnam", return_value=SimpleNamespace(gr_gid=os.getgid())
                ),
                mock.patch.object(module, "recover_pending"),
                mock.patch.object(
                    module,
                    "load_state",
                    return_value={"version": 2, "activeProvider": "secondary"},
                ),
                mock.patch.object(module, "proxy_is_healthy", side_effect=[True, False]),
                mock.patch.object(module, "read_secret", return_value=TEST_UUID),
                mock.patch.object(module, "validate_subscription_url"),
                mock.patch.object(module, "validate_hwid"),
                mock.patch.object(module, "fetch_subscription", side_effect=fetch),
                mock.patch.object(
                    module, "extract_candidates", return_value=secondary_candidates
                ),
                mock.patch.object(module, "pin_public_endpoint", side_effect=lambda item: item),
                mock.patch.object(
                    module,
                    "build_config",
                    side_effect=lambda outbound, _socks, _http: {"tag": outbound["tag"]},
                ),
                mock.patch.object(
                    module,
                    "write_json",
                    side_effect=lambda _path, value, _mode, _uid, _gid: value["tag"].encode(),
                ),
                mock.patch.object(module, "canary_test", side_effect=canary),
                mock.patch.object(module, "activate_candidate") as activate,
                mock.patch.object(module, "log"),
            ):
                self.assertEqual(module.main(), 0)

            self.assertEqual(len(attempted_tags), module.MAX_TOTAL_PROFILES)
            self.assertEqual(
                attempted_tags[-3:],
                [
                    "subscription-secondary-030",
                    "subscription-secondary-031",
                    "subscription-secondary-032",
                ],
            )
            self.assertEqual(activate.call_args.args[7], "secondary")

    def _run_failover_capacity_reclaim(self, secondary_payload, passing_primary_index):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            primary_url = root / "primary.url"
            secondary_url = root / "secondary.url"
            primary_url.touch()
            secondary_url.touch()
            args = SimpleNamespace(
                force=True,
                url_file=primary_url,
                secondary_url_file=secondary_url,
                hwid_file=root / "hwid",
                xray=root / "xray",
                active_config=root / "config.json",
                state_dir=root / "state",
                runtime_dir=root / "runtime",
                lock_file=root / "runtime" / "lock",
            )
            primary_candidates = [
                {
                    "tag": f"subscription-primary-{index:03d}",
                    "protocol": "vless",
                }
                for index in range(1, module.MAX_PROFILES + 1)
            ]
            secondary_candidates = [
                {"tag": "subscription-secondary-001", "protocol": "vless"}
            ]
            attempted_tags = []

            def fetch(_url, _hwid, runtime_dir):
                if runtime_dir.name == "primary":
                    return ([{"provider": "primary"}], 2)
                if isinstance(secondary_payload, Exception):
                    raise secondary_payload
                return (secondary_payload, 12)

            def extract(_payload, tag_prefix):
                return (
                    primary_candidates
                    if tag_prefix.endswith("primary")
                    else secondary_candidates
                )

            def canary(_xray, config, _runtime_dir, _nobody_gid):
                tag = config["tag"]
                attempted_tags.append(tag)
                return tag == f"subscription-primary-{passing_primary_index:03d}"

            with (
                mock.patch.object(module, "parse_args", return_value=args),
                mock.patch.object(module.os, "geteuid", return_value=0),
                mock.patch.object(module.os, "chown"),
                mock.patch.object(
                    module.grp, "getgrnam", return_value=SimpleNamespace(gr_gid=os.getgid())
                ),
                mock.patch.object(module, "recover_pending"),
                mock.patch.object(module, "load_state", return_value={}),
                mock.patch.object(module, "proxy_is_healthy", return_value=False),
                mock.patch.object(module, "read_secret", return_value=TEST_UUID),
                mock.patch.object(module, "validate_subscription_url"),
                mock.patch.object(module, "validate_hwid"),
                mock.patch.object(module, "fetch_subscription", side_effect=fetch) as fetch_mock,
                mock.patch.object(module, "extract_candidates", side_effect=extract),
                mock.patch.object(module, "pin_public_endpoint", side_effect=lambda item: item),
                mock.patch.object(
                    module,
                    "build_config",
                    side_effect=lambda outbound, _socks, _http: {"tag": outbound["tag"]},
                ),
                mock.patch.object(
                    module,
                    "write_json",
                    side_effect=lambda _path, value, _mode, _uid, _gid: value["tag"].encode(),
                ),
                mock.patch.object(module, "canary_test", side_effect=canary),
                mock.patch.object(module, "activate_candidate") as activate,
                mock.patch.object(module, "log"),
            ):
                self.assertEqual(module.main(), 0)

            self.assertEqual(fetch_mock.call_count, 2)
            self.assertEqual(activate.call_count, 1)
            self.assertEqual(activate.call_args.args[5], passing_primary_index)
            self.assertEqual(activate.call_args.args[7], "primary")
            self.assertLessEqual(len(attempted_tags), module.MAX_TOTAL_PROFILES)
            return attempted_tags

    def test_reclaims_all_primary_slots_when_secondary_fetch_fails(self):
        attempted = self._run_failover_capacity_reclaim(
            module.UpdateError("secondary unavailable"),
            32,
        )
        self.assertEqual(len(attempted), module.MAX_TOTAL_PROFILES)
        self.assertEqual(
            attempted[-3:],
            [
                "subscription-primary-030",
                "subscription-primary-031",
                "subscription-primary-032",
            ],
        )

    def test_reclaims_two_primary_slots_after_one_secondary_candidate_fails(self):
        attempted = self._run_failover_capacity_reclaim(
            [{"provider": "secondary"}],
            31,
        )
        self.assertEqual(len(attempted), module.MAX_TOTAL_PROFILES)
        self.assertEqual(
            attempted[-3:],
            [
                "subscription-secondary-001",
                "subscription-primary-030",
                "subscription-primary-031",
            ],
        )
        self.assertNotIn("subscription-primary-032", attempted)

    def test_preferred_primary_profile_is_kept_before_failover_reservation(self):
        candidates = [{"position": index} for index in range(1, 33)]
        ordered = module.order_candidates(candidates, 32)
        limited = ordered[: module.provider_candidate_limit(32, "primary", {"secondary"})]
        self.assertEqual(limited[0][0], 32)
        self.assertEqual(len(limited), 29)

    def test_service_loads_secondary_url_as_a_systemd_credential(self):
        service_path = SCRIPT_PATH.with_name("komui-xray-subscription-update.service")
        service = service_path.read_text(encoding="utf-8")
        self.assertIn(
            "LoadCredential=subscription-secondary.url:/etc/komui-xray/subscription-secondary.url",
            service,
        )

    def test_selected_profile_index_remains_one_based(self):
        candidates = [{"name": "first"}, {"name": "second"}, {"name": "third"}]
        self.assertEqual(
            module.order_candidates(candidates, 2),
            [(2, {"name": "second"}), (1, {"name": "first"}), (3, {"name": "third"})],
        )

    def test_endpoint_dns_must_resolve_only_to_public_ips(self):
        outbound = module.sanitize_outbound(vless_outbound(), "subscription-proxy-001")
        private_result = [(None, None, None, None, ("127.0.0.1", 443))]
        with mock.patch.object(module.socket, "getaddrinfo", return_value=private_result):
            self.assertIsNone(module.pin_public_endpoint(outbound))

    def test_endpoint_dns_is_pinned_to_checked_public_ip(self):
        outbound = module.sanitize_outbound(vless_outbound(), "subscription-proxy-001")
        public_result = [(None, None, None, None, ("1.1.1.1", 443))]
        with mock.patch.object(module.socket, "getaddrinfo", return_value=public_result):
            pinned = module.pin_public_endpoint(outbound)
        self.assertIsNotNone(pinned)
        self.assertEqual(pinned["settings"]["vnext"][0]["address"], "1.1.1.1")
        self.assertEqual(pinned["streamSettings"]["xhttpSettings"]["host"], "vpn.example.net")
        self.assertEqual(pinned["streamSettings"]["realitySettings"]["serverName"], "vpn.example.net")

    def test_endpoint_pinning_replaces_empty_reality_and_transport_hosts(self):
        raw = vless_outbound()
        raw["streamSettings"]["realitySettings"]["serverName"] = ""
        raw["streamSettings"]["xhttpSettings"]["host"] = ""
        outbound = module.sanitize_outbound(raw, "subscription-proxy-001")
        public_result = [(None, None, None, None, ("1.1.1.1", 443))]
        with mock.patch.object(module.socket, "getaddrinfo", return_value=public_result):
            pinned = module.pin_public_endpoint(outbound)
        self.assertEqual(pinned["streamSettings"]["realitySettings"]["serverName"], "vpn.example.net")
        self.assertEqual(pinned["streamSettings"]["xhttpSettings"]["host"], "vpn.example.net")

    def test_written_config_is_valid_json(self):
        outbound = module.sanitize_outbound(vless_outbound(), "subscription-proxy-001")
        config = module.build_config(outbound, 10808, 10809)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.json"
            data = module.write_json(path, config, 0o600, os.getuid(), os.getgid())
            self.assertEqual(json.loads(data), config)


if __name__ == "__main__":
    unittest.main()
