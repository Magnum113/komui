# Context

## Initial production runtime before implementation

- Host: `89.111.152.112`
- Xray Core: `26.2.6`
- Service: `xray.service`
- Active config: `/usr/local/etc/xray/config.json`
- Telegram proxy: `socks5h://127.0.0.1:10808`
- Xray runs as `nobody:nogroup`.
- No existing subscription updater or related systemd timer is installed.

## Subscription discovery

- The subscription URL uses HTTPS and is kept outside the repository.
- HTTP/1.1 is required for reliable retrieval from the current Mac/network.
- Response is an Xray JSON array containing a full client configuration with
  multiple proxy outbounds.
- Response header `profile-update-interval` is `2` hours.
- Response announces HWID enforcement. A request without `X-HWID` returns
  `X-Hwid-Not-Supported: true`.
- The non-HWID configuration passes `xray run -test` but fails all canary
  egress probes, including Cloudflare, example.com, and Telegram.
- Production was not switched; the temporary canary was stopped and removed.

## Deployment outcome

- Xray was updated to 26.3.27 before the final updater acceptance.
- The provider accepted a stable server-specific HWID.
- Candidate profile 28 initially restored connectivity. After adding strict
  nested XHTTP/REALITY allowlists, the final safe candidate is profile 24; it
  passed syntax, isolated Cloudflare/Telegram probes, and the post-activation
  production probe.
- Xray is healthy on loopback ports 10808/10809.
- The updater timer checks every 15 minutes and downloads a refreshed profile
  when the provider's two-hour interval is due, or sooner when the current
  proxy health check fails.
- The missed order alert was accepted by Telegram at 20:47:32 MSK and its
  internal order ID is present in `notifiedOrderIds`.

## Required compatibility

- Preserve only loopback inbounds on ports 10808/10809.
- Support bounded multi-profile responses and inspect at most 32 candidates;
  reject malformed, empty, or unsupported content.
- Do not treat `xray run -test` as a network test; a separate temporary Xray
  and SOCKS probe are mandatory.
