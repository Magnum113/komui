#!/usr/bin/env python3
"""Emit only non-secret invariants for the deployed KOMUI Xray failover."""

from __future__ import annotations

import ipaddress
import json
import os
import stat
import subprocess
from pathlib import Path


SECRET_PATHS = [
    Path("/etc/komui-xray/subscription.url"),
    Path("/etc/komui-xray/subscription-secondary.url"),
    Path("/etc/komui-xray/subscription.hwid"),
]


def mode(path: Path) -> str:
    return f"{stat.S_IMODE(path.stat().st_mode):04o}"


def service_active(name: str) -> bool:
    return subprocess.run(
        ["systemctl", "is-active", "--quiet", name],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    ).returncode == 0


def walk_keys(value: object) -> set[str]:
    if isinstance(value, dict):
        result = set(value)
        for item in value.values():
            result.update(walk_keys(item))
        return result
    if isinstance(value, list):
        result: set[str] = set()
        for item in value:
            result.update(walk_keys(item))
        return result
    return set()


def main() -> int:
    secrets = [path.read_bytes().strip() for path in SECRET_PATHS]
    journal = subprocess.run(
        ["journalctl", "-u", "komui-xray-subscription-update.service", "--no-pager"],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        check=False,
    ).stdout
    process_data = b""
    for path in Path("/proc").glob("[0-9]*/cmdline"):
        try:
            process_data += path.read_bytes()
        except OSError:
            continue
    config = json.loads(Path("/usr/local/etc/xray/config.json").read_text(encoding="utf-8"))
    state = json.loads(
        Path("/var/lib/komui/xray-subscription/state.json").read_text(encoding="utf-8")
    )
    endpoint = config["outbounds"][0]["settings"]["vnext"][0]["address"]
    endpoint_public = ipaddress.ip_address(endpoint).is_global
    forbidden = {
        "allowInsecure",
        "masterKeyLog",
        "proxySettings",
        "sendThrough",
        "sockopt",
    }
    version_output = subprocess.run(
        ["/usr/local/bin/xray", "version"],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        check=False,
    ).stdout.splitlines()
    version = version_output[0].split()[1] if version_output else "unknown"
    print(f"xray_version={version}")
    print(f"xray_active={str(service_active('xray.service')).lower()}")
    print(
        "updater_timer_active="
        + str(service_active("komui-xray-subscription-update.timer")).lower()
    )
    print(f"bot_active={str(service_active('komui-deploy-bot.service')).lower()}")
    print(f"state_version={state.get('version')}")
    print(f"active_provider={state.get('activeProvider')}")
    print(f"active_profile={state.get('selectedProfileIndex')}")
    print(f"provider_count={len(state.get('providers', {}))}")
    print(
        "loopback_only="
        + str(all(item.get("listen") == "127.0.0.1" for item in config["inbounds"])).lower()
    )
    print(f"endpoint_pinned_public={str(endpoint_public).lower()}")
    print(f"forbidden_config_keys={len(walk_keys(config) & forbidden)}")
    print("credential_modes=" + ",".join(mode(path) for path in SECRET_PATHS))
    print(f"pending_marker={str(Path('/var/lib/komui/xray-subscription/pending.json').exists()).lower()}")
    print(f"journal_secret_matches={sum(journal.count(secret) for secret in secrets)}")
    print(f"process_secret_matches={sum(process_data.count(secret) for secret in secrets)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
