#!/bin/sh
# Один бекап: pg_dump → R2 → перевірка, що файл у R2 читається.
# Запуск вручну: docker exec <контейнер dump> backup-now
#
# Бекап, який ніколи не відновлювали, не існує: після завантаження файл
# читається НАЗАД із R2 і перевіряється pg_restore --list.
set -eu

: "${PGHOST:?}" "${PGUSER:?}" "${PGPASSWORD:?}" "${PGDATABASE:?}"
: "${BACKUP_PREFIX:?BACKUP_PREFIX — напр. staging або production}"
: "${R2_BUCKET_BACKUPS:?}"

# rclone без конфіг-файла: віддалений сховок `r2` повністю зі змінних.
export RCLONE_CONFIG_R2_TYPE=s3
export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
export RCLONE_CONFIG_R2_ENDPOINT="${R2_S3_ENDPOINT:?}"
export RCLONE_CONFIG_R2_ACCESS_KEY_ID="${R2_BACKUP_ACCESS_KEY_ID:?}"
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="${R2_BACKUP_SECRET_ACCESS_KEY:?}"
# Ключ має доступ лише до одного bucket'а — без прав на створення бакетів.
export RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true

name="${BACKUP_PREFIX}/${PGDATABASE}-$(date -u +%Y%m%dT%H%M%SZ).dump"
target="r2:${R2_BUCKET_BACKUPS}/${name}"
started=$(date +%s)

# -Fc: стиснений custom-формат, відновлюється вибірково через pg_restore.
pg_dump --format=custom --compress=6 --no-owner | rclone rcat --s3-chunk-size 16M "$target"

size=$(rclone size --json "$target" | sed -n 's/.*"bytes":\([0-9]*\).*/\1/p')
tables=$(rclone cat "$target" | pg_restore --list | grep -c ' TABLE DATA ' || true)
if [ "${size:-0}" -le 0 ] || [ "$tables" -le 0 ]; then
  echo "BACKUP FAILED: ${name} — розмір ${size:-0} Б, таблиць з даними ${tables}" >&2
  exit 1
fi
echo "backup ok: ${name} — ${size} Б, таблиць з даними ${tables}, $(($(date +%s) - started)) с"
