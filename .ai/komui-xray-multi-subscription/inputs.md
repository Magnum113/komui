# Inputs

## Goal

Extend the production Xray updater to support a second, independent
subscription as a failover provider. The secondary subscription is expected
to expose three profiles using VLESS with XHTTP/TCP transports, but its actual
response format must be inspected before implementation.

## Constraints

- Never print or commit either subscription URL, HWID, endpoint credentials,
  or downloaded profiles.
- Keep Xray inbounds loopback-only on ports 10808/10809.
- Keep the currently active configuration unless a replacement passes syntax,
  isolated network, Telegram, and post-activation probes.
- Preserve automatic rollback and bounded profile/resource validation.
- Avoid provider flapping: a healthy active provider remains active until a
  scheduled refresh or a health failure.

## Secure input received

The secondary URL is stored outside the repository in a local secret file with
mode `0600`.

It was copied to `/etc/komui-xray/subscription-secondary.url` as
`0600 root:root`; the value was never printed or committed.
