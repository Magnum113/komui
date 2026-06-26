#!/usr/bin/env bash
set -Eeuo pipefail

STAGED_DIR=${1:-/tmp/komui-stage2}

install -m 644 "$STAGED_DIR/00-komui-hardening.conf" \
  /etc/ssh/sshd_config.d/00-komui-hardening.conf

sshd -t
systemctl reload ssh

ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'SSH'
ufw allow 80/tcp comment 'HTTP'
ufw allow 443/tcp comment 'HTTPS'
ufw logging low
ufw --force enable

sshd -t
ufw status verbose
printf 'SECURITY_BASELINE_OK\n'
