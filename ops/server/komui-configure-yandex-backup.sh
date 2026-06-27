#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo: sudo /usr/local/sbin/komui-configure-yandex-backup" >&2
  exit 1
fi

read -r -p "Yandex Object Storage Access Key ID: " access_key_id
read -r -s -p "Yandex Object Storage Secret Access Key: " secret_access_key
echo

bucket="${YANDEX_S3_BUCKET:-komui-backups}"
endpoint="${YANDEX_S3_ENDPOINT:-https://storage.yandexcloud.net}"
prefix="${YANDEX_S3_PREFIX:-komui/stage/}"
region="${AWS_DEFAULT_REGION:-ru-central1}"

if [[ -z "$access_key_id" || -z "$secret_access_key" ]]; then
  echo "Access key ID and secret key are required." >&2
  exit 1
fi

install -d -m 0700 /etc/komui
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

{
  printf 'AWS_ACCESS_KEY_ID=%q\n' "$access_key_id"
  printf 'AWS_SECRET_ACCESS_KEY=%q\n' "$secret_access_key"
  printf 'AWS_DEFAULT_REGION=%q\n' "$region"
  printf 'YANDEX_S3_ENDPOINT=%q\n' "$endpoint"
  printf 'YANDEX_S3_BUCKET=%q\n' "$bucket"
  printf 'YANDEX_S3_PREFIX=%q\n' "$prefix"
} > "$tmp"

install -o root -g root -m 0600 "$tmp" /etc/komui/yandex-backup.env
echo "Saved /etc/komui/yandex-backup.env with root-only permissions."
echo "Bucket: $bucket"
echo "Endpoint: $endpoint"
echo "Prefix: $prefix"
