#!/usr/bin/env bash
set -Eeuo pipefail

export DEBIAN_FRONTEND=noninteractive

STAGED_DIR=${1:-/tmp/komui-stage2}
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_ROOT=/var/backups/komui
BACKUP_DIR="$BACKUP_ROOT/server-foundation-$STAMP"

install -d -m 700 "$BACKUP_ROOT" "$BACKUP_DIR"
tar -C / -czf "$BACKUP_DIR/etc-configs.tar.gz" \
  etc/ssh etc/nginx etc/fail2ban etc/ufw etc/fstab \
  etc/systemd/journald.conf etc/logrotate.d 2>/dev/null || true
dpkg-query -W > "$BACKUP_DIR/packages.txt"
systemctl list-unit-files --no-pager > "$BACKUP_DIR/systemd-units.txt"
nft list ruleset > "$BACKUP_DIR/nft-ruleset.txt" 2>/dev/null || true
chmod 600 "$BACKUP_DIR"/*

if ! swapon --noheadings --show=NAME | grep -qx /swapfile; then
  if [[ ! -f /swapfile ]]; then
    fallocate -l 2G /swapfile
  fi
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
fi
if ! grep -Eq '^[[:space:]]*/swapfile[[:space:]]' /etc/fstab; then
  printf '%s\n' '/swapfile none swap sw 0 0' >> /etc/fstab
fi

install -m 644 "$STAGED_DIR/60-komui-sysctl.conf" \
  /etc/sysctl.d/60-komui.conf
sysctl --system >/dev/null

if ! getent group komui >/dev/null; then
  groupadd --system komui
fi
if ! id komui >/dev/null 2>&1; then
  useradd --system --gid komui --home-dir /var/lib/komui \
    --shell /usr/sbin/nologin komui
fi

install -d -m 755 -o root -g root /opt/komui /opt/komui/releases
install -d -m 750 -o komui -g komui \
  /opt/komui/shared /var/lib/komui /var/log/komui
# Nginx needs traverse-only access to reach the separately protected static root.
chmod 751 /var/lib/komui
install -d -m 750 -o root -g www-data /var/lib/komui/staging-root
install -d -m 755 -o root -g www-data /var/lib/komui/acme
install -d -m 750 -o root -g komui /etc/komui
install -d -m 700 -o root -g root /var/backups/komui/database

install -d -m 755 -o root -g root /opt/komui/releases/bootstrap
ln -sfn /opt/komui/releases/bootstrap /opt/komui/current

install -m 640 -o root -g www-data "$STAGED_DIR/index.html" \
  /var/lib/komui/staging-root/index.html
install -m 644 "$STAGED_DIR/platform-health.txt" \
  /var/lib/komui/staging-root/platform-health
chown root:www-data /var/lib/komui/staging-root/platform-health
chmod 640 /var/lib/komui/staging-root/platform-health

install -d -m 755 /etc/systemd/journald.conf.d
install -m 644 "$STAGED_DIR/60-komui-journald.conf" \
  /etc/systemd/journald.conf.d/60-komui-limits.conf
install -m 644 "$STAGED_DIR/komui.logrotate" /etc/logrotate.d/komui

install -m 644 "$STAGED_DIR/komui-backend.service" \
  /etc/systemd/system/komui-backend.service
install -m 750 -o root -g komui "$STAGED_DIR/komui-prune-releases" \
  /usr/local/sbin/komui-prune-releases
systemctl daemon-reload

if [[ ! -f /etc/komui/backend.env ]]; then
  install -m 640 -o root -g komui /dev/null /etc/komui/backend.env
fi

apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg openssl apache2-utils postgresql-common

install -d -m 755 /usr/share/postgresql-common/pgdg
curl -fsSL \
  https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  -o /tmp/apt.postgresql.org.asc
install -m 644 /tmp/apt.postgresql.org.asc \
  /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
install -m 644 "$STAGED_DIR/pgdg.sources" \
  /etc/apt/sources.list.d/pgdg.sources

apt-get update
apt-get install -y --no-install-recommends \
  postgresql-17 postgresql-client-17

install -d -m 755 /etc/postgresql/17/main/conf.d
install -m 644 "$STAGED_DIR/60-komui-postgresql.conf" \
  /etc/postgresql/17/main/conf.d/60-komui.conf

if ! grep -Eq "^[[:space:]]*include_dir[[:space:]]*=[[:space:]]*'conf.d'" \
  /etc/postgresql/17/main/postgresql.conf; then
  printf "\ninclude_dir = 'conf.d'\n" \
    >> /etc/postgresql/17/main/postgresql.conf
fi

install -m 644 "$STAGED_DIR/60-komui-fail2ban.local" \
  /etc/fail2ban/jail.d/60-komui.local
systemctl restart fail2ban

install -m 644 "$STAGED_DIR/staging-nginx-bootstrap.conf" \
  /etc/nginx/sites-available/komui-staging

if [[ ! -f /etc/komui/staging-access.env ]]; then
  STAGING_PASSWORD=$(openssl rand -hex 18)
  install -m 600 -o root -g root /dev/null /etc/komui/staging-access.env
  printf 'STAGING_USER=%s\nSTAGING_PASSWORD=%s\n' \
    'komui-staging' "$STAGING_PASSWORD" \
    > /etc/komui/staging-access.env
fi
if [[ ! -f /etc/nginx/komui-staging.htpasswd ]]; then
  set -a
  # shellcheck disable=SC1091
  source /etc/komui/staging-access.env
  set +a
  htpasswd -bcB /etc/nginx/komui-staging.htpasswd \
    "$STAGING_USER" "$STAGING_PASSWORD" >/dev/null
  chown root:www-data /etc/nginx/komui-staging.htpasswd
  chmod 640 /etc/nginx/komui-staging.htpasswd
fi

ln -sfn /etc/nginx/sites-available/komui-staging \
  /etc/nginx/sites-enabled/komui-staging
nginx -t
systemctl reload nginx

systemctl restart systemd-journald
systemctl restart postgresql

printf 'BACKUP_DIR=%s\n' "$BACKUP_DIR"
printf 'BOOTSTRAP_OK\n'
