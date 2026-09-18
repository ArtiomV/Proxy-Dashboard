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

# DEEP-16 (18.09.2026): выгружаем только ТОЧНЫЕ имена опубликованных архивов
# через manifest (--files-from). Wildcard dashboard-*.db* недопустим: он
# захватывает sidecar-файлы .db-wal/.db-shm и недописанные .db.gz.*.partial.
# Опубликованный архив — dashboard-YYYY-MM-DD.db.gz в корне (daily) и в
# monthly/; шаблон с '?' фиксирует длину даты, .gz на конце исключает
# .partial/.tmp. Остатки .partial после crash в облако не попадают и не
# удаляются отсюда — это не файлы этой операции (FIX-08 п.6).
MANIFEST="$(mktemp "${TMPDIR:-/tmp}/backup-offsite-manifest.XXXXXX")"
trap 'rm -f "$MANIFEST"' EXIT

find "$BACKUP_DIR" -maxdepth 2 -type f -name 'dashboard-????-??-??.db.gz' -print \
  | sed "s|^$BACKUP_DIR/||" > "$MANIFEST"

# Legacy несжатые .db: отдельное подтверждение готовности. Файл считаем
# готовым только если нет sidecar -wal/-shm (неоткрытая живая БД) и он не
# изменялся последний час (не идёт запись снимка прямо сейчас).
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'dashboard-????-??-??.db' -mmin +60 -print \
  | while IFS= read -r f; do
      [ ! -e "${f}-wal" ] && [ ! -e "${f}-shm" ] && echo "${f#$BACKUP_DIR/}"
    done >> "$MANIFEST" || true

if [ ! -s "$MANIFEST" ]; then
  echo "backup-offsite: опубликованных архивов в $BACKUP_DIR не найдено — выгружать нечего" >&2
  exit 1
fi

# Beget S3 режет всплески запросов (429 TooManyRequests на UploadPart при
# multi-thread copy ~700 MB файла): глушим параллелизм и делаем до 3 попыток
# с паузой — иначе ночная выгрузка молча не доезжает (13.08.2026).
attempt=1
max_attempts=3
while true; do
  if rclone copy "$BACKUP_DIR" "${REMOTE}:${DEST_PREFIX}" \
    --files-from "$MANIFEST" \
    --checksum --stats-one-line --stats 30s \
    --transfers 2 --s3-upload-concurrency 1 --multi-thread-streams 1 \
    --retries 5 --retries-sleep 30s --low-level-retries 10; then
    break
  fi
  if [ "$attempt" -ge "$max_attempts" ]; then
    echo "backup-offsite: rclone не смог выгрузить за $max_attempts попыток" >&2
    exit 1
  fi
  echo "backup-offsite: попытка $attempt не удалась, повтор через 60s..." >&2
  attempt=$((attempt + 1))
  sleep 60
done

echo "offsite OK: $(wc -l < "$MANIFEST" | tr -d ' ') файлов $BACKUP_DIR → ${REMOTE}:${DEST_PREFIX}"
