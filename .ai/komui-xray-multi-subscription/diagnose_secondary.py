#!/usr/bin/env python3
"""Run secret-safe, per-transport secondary Xray diagnostics on the server."""

from __future__ import annotations

import importlib.machinery
import importlib.util
import os
import socket
import subprocess
import tempfile
import time
from pathlib import Path


UPDATER = Path("/usr/local/sbin/komui-xray-subscription-update")
DIAGNOSTIC_XRAY = Path(os.environ.get("KOMUI_DIAGNOSTIC_XRAY", "/usr/local/bin/xray"))
loader = importlib.machinery.SourceFileLoader("komui_xray_diagnostic", str(UPDATER))
spec = importlib.util.spec_from_loader(loader.name, loader)
assert spec is not None
module = importlib.util.module_from_spec(spec)
loader.exec_module(module)


def probe(port: int, url: str) -> tuple[int, str]:
    try:
        completed = subprocess.run(
            [
                "curl",
                "--http1.1",
                "--proxy",
                f"socks5h://127.0.0.1:{port}",
                "--silent",
                "--show-error",
                "--output",
                "/dev/null",
                "--connect-timeout",
                "8",
                "--max-time",
                "20",
                "--write-out",
                "%{http_code}",
                "--config",
                "-",
            ],
            input=f'url = "{module.curl_config_escape(url)}"\n',
            text=True,
            capture_output=True,
            check=False,
            timeout=25,
        )
    except subprocess.TimeoutExpired:
        return 124, "000"
    return completed.returncode, completed.stdout.strip() or "000"


def classify_log(raw: str) -> str:
    lowered = raw.lower()
    patterns = {
        "auth": ("authentication", "invalid user", "rejected"),
        "connection_refused": ("connection refused",),
        "connection_reset": ("connection reset", "reset by peer"),
        "closed": ("closed pipe", "transport is closing", "use of closed network connection"),
        "dial": ("failed to dial", "connection error"),
        "dns": ("name resolution", "no such host", "dns"),
        "eof": ("eof",),
        "invalid_connection": ("invalid connection", "processed invalid"),
        "file_access": ("permission denied", "failed to read", "failed to load", "no such file"),
        "geodata": ("geoip", "geosite"),
        "initialize": ("failed to initialize", "failed to create"),
        "reality": ("reality",),
        "remote_error": ("remote error", "server preface"),
        "timeout": ("timeout", "deadline exceeded", "i/o timeout"),
        "tls": ("tls", "handshake"),
        "unreachable": ("network is unreachable", "no route to host"),
    }
    categories = [name for name, needles in patterns.items() if any(item in lowered for item in needles)]
    return ",".join(categories) if categories else "unclassified"


def main() -> int:
    nobody_gid = module.grp.getgrnam("nogroup").gr_gid
    url = module.read_secret(module.DEFAULT_SECONDARY_URL_FILE, "secondary subscription URL")
    hwid = module.read_secret(module.DEFAULT_HWID_FILE, "subscription HWID")
    module.validate_subscription_url(url)
    module.validate_hwid(hwid)
    module.DEFAULT_RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    os.chown(module.DEFAULT_RUNTIME_DIR, 0, nobody_gid)
    os.chmod(module.DEFAULT_RUNTIME_DIR, 0o750)
    with tempfile.TemporaryDirectory(prefix="secondary-diagnostic-", dir=module.DEFAULT_RUNTIME_DIR) as raw:
        root = Path(raw)
        os.chown(root, 0, nobody_gid)
        os.chmod(root, 0o750)
        payload, _interval = module.fetch_subscription(url, hwid, root)
        candidates = module.extract_candidates(payload, "subscription-secondary")
        print(f"profiles={len(candidates)}", flush=True)
        for index, outbound in enumerate(candidates, start=1):
            network = str(outbound["streamSettings"]["network"])
            raw_endpoint = outbound["settings"]["vnext"][0]
            resolved = socket.getaddrinfo(
                str(raw_endpoint["address"]), int(raw_endpoint["port"]), type=socket.SOCK_STREAM
            )
            unique_addresses = []
            families = set()
            for item in resolved:
                address = str(item[4][0]).split("%", 1)[0]
                if address not in unique_addresses:
                    unique_addresses.append(address)
                families.add("ipv6" if item[0] == socket.AF_INET6 else "ipv4")
            pinned = module.pin_public_endpoint(outbound)
            if pinned is None:
                print(f"profile={index} transport={network} endpoint_safe=false", flush=True)
                continue
            socks_port = module.find_free_port()
            http_port = module.find_free_port()
            while http_port == socks_port:
                http_port = module.find_free_port()
            config = module.build_config(pinned, socks_port, http_port)
            config["log"]["loglevel"] = "debug"
            config_path = root / f"profile-{index}.json"
            module.write_json(config_path, config, 0o640, 0, nobody_gid)
            syntax_ok = module.syntax_test(DIAGNOSTIC_XRAY, config_path)
            if not syntax_ok:
                try:
                    syntax_detail = subprocess.run(
                        [str(DIAGNOSTIC_XRAY), "run", "-test", "-config", str(config_path)],
                        text=True,
                        capture_output=True,
                        check=False,
                        timeout=15,
                        **module.nobody_process_kwargs(nobody_gid),
                    )
                    syntax_log = syntax_detail.stdout + syntax_detail.stderr
                    syntax_rc = syntax_detail.returncode
                except (OSError, subprocess.TimeoutExpired) as error:
                    syntax_log = type(error).__name__
                    syntax_rc = -1
                print(
                    " ".join(
                        [
                            f"profile={index}",
                            f"transport={network}",
                            "syntax=false",
                            f"syntax_rc={syntax_rc}",
                            f"syntax_error={classify_log(syntax_log)}",
                            f"syntax_log_bytes={len(syntax_log.encode('utf-8', errors='replace'))}",
                        ]
                    ),
                    flush=True,
                )
                continue
            process = subprocess.Popen(
                [str(DIAGNOSTIC_XRAY), "run", "-config", str(config_path)],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                start_new_session=True,
                **module.nobody_process_kwargs(nobody_gid),
            )
            try:
                endpoint = pinned["settings"]["vnext"][0]
                direct_started = time.monotonic()
                try:
                    with socket.create_connection(
                        (str(endpoint["address"]), int(endpoint["port"])), timeout=5
                    ):
                        direct_tcp = "ok"
                except OSError:
                    direct_tcp = "failed"
                direct_ms = int((time.monotonic() - direct_started) * 1000)
                ready = module.wait_for_port(socks_port)
                cloudflare = probe(socks_port, module.CLOUDFLARE_PROBE_URL) if ready else (-1, "000")
                telegram = probe(socks_port, module.TELEGRAM_PROBE_URL) if ready else (-1, "000")
            finally:
                if process.poll() is None:
                    process.terminate()
                try:
                    stdout, stderr = process.communicate(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    stdout, stderr = process.communicate(timeout=5)
            xray_log = stdout + stderr
            print(
                " ".join(
                    [
                        f"profile={index}",
                        f"transport={network}",
                        f"resolved={len(unique_addresses)}",
                        f"families={','.join(sorted(families))}",
                        f"ready={str(ready).lower()}",
                        f"direct_tcp={direct_tcp}",
                        f"direct_ms={direct_ms}",
                        f"cloudflare_rc={cloudflare[0]}",
                        f"cloudflare_http={cloudflare[1]}",
                        f"telegram_rc={telegram[0]}",
                        f"telegram_http={telegram[1]}",
                        f"xray_error={classify_log(xray_log)}",
                        f"xray_log_bytes={len(xray_log.encode('utf-8', errors='replace'))}",
                    ]
                ),
                flush=True,
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
