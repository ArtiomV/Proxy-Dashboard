#!/usr/bin/env bash
# D2: offsite-выгрузка бэкапов dashboard.db в облако через rclone.
# Вызывается из src/jobs/backup.js после успешного ночного DbBackup.
#
# Настройка (см. OPERATIONS.md «Бэкапы → облако»):
#   1. rclone config — завести remote (S3 / Backblaze B2), креды на стороне сервера.
#   2. RCLONE_REMOTE=<имя remote> в env дашборда (pm2 restart --update-env).
#
# Если rclone не установлен или RCLONE_REMOTE не задан — падаем с понятной
# ошибкой: вызывающая джоба ловит это и пишет warn (НЕ молчит, правило C7).
set -euo pipefail

BACKUP_DIR="${1:-${DB_BACKUP_DIR:-/var/backups/proxy-dashboard}}"
REMOTE="${RCLONE_REMOTE:-}"
DEST_PREFIX="${RCLONE_DEST_PREFIX:-proxy-dashboard-backups}"

if ! command -v rclone >/dev/null 2>&1; then
  echo "backup-offsite: rclone не установлен — облачная выгрузка невозможна (см. OPERATIONS.md)" >&2
  exit 1
fi
if [ -z "$REMOTE" ]; then
  echo "backup-offsite: RCLONE_REMOTE не задан — облачная выгрузка не настроена (см. OPERATIONS.md)" >&2
  exit 1
fi
if [ ! -d "$BACKUP_DIR" ]; then
  echo "backup-offsite: каталог бэкапов $BACKUP_DIR не существует" >&2
  exit 1
fi

# Копируем только снапшоты БД (daily в корне + monthly/), без sidecar-файлов.
# Паттерн без '/' матчит basename на любой глубине — monthly/ попадает сам.
rclone copy "$BACKUP_DIR" "${REMOTE}:${DEST_PREFIX}" \
  --include "dashboard-*.db" \
  --checksum --stats-one-line --stats 30s

echo "offsite OK: $BACKUP_DIR → ${REMOTE}:${DEST_PREFIX}"
