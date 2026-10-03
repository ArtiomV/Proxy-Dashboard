#!/usr/bin/env bash
# Deploy proxy-dashboard to production.
# Usage:  SERVER=root@2.29.2.168 ./scripts/deploy.sh
# Requires: sshpass + $SSHPASS env (or ssh keys), rsync.
set -euo pipefail

SERVER="${SERVER:-root@2.29.2.168}"
REMOTE_DIR="${REMOTE_DIR:-/root/Proxy-Dashboard}"
HEALTH_URL="${HEALTH_URL:-http://localhost:3000/health}"

# Resolve ssh wrapper — sshpass if SSHPASS is set, plain ssh otherwise.
if [ -n "${SSHPASS:-}" ]; then
  SSH=(sshpass -e ssh -o StrictHostKeyChecking=no)
  SCP=(sshpass -e scp -o StrictHostKeyChecking=no)
  RSYNC_RSH='sshpass -e ssh -o StrictHostKeyChecking=no'
else
  SSH=(ssh -o StrictHostKeyChecking=no)
  SCP=(scp -o StrictHostKeyChecking=no)
  RSYNC_RSH='ssh -o StrictHostKeyChecking=no'
fi

echo "==> Pre-flight checks"
node --check server.js
for f in src/api/proxy-smart.js src/billing/atomic.js src/traffic/hourly.js; do
  node --check "$f"
done

# 03.10: дисциплина changelog — деплой без новой записи за сегодня
# предупреждает (не блокирует: хотфиксам не нужен релиз-нотес).
if [ -f public/changelog.html ]; then
  CL_DAY=$(grep -o 'release-date">[^<]*' public/changelog.html | head -1 | sed -E 's/release-date">([0-9]+).*/\1/')
  CL_MON=$(grep -o 'release-date">[^<]*' public/changelog.html | head -1 | sed -E 's/release-date">[0-9]+ ([^ ]+).*/\1/')
  NOW_DAY=$(date '+%-d'); NOW_MON=$(date '+%m')
  MONTHS_RU="января февраля марта апреля мая июня июля августа сентября октября ноября декабря"
  NOW_MON_RU=$(echo "$MONTHS_RU" | cut -d' ' -f"$NOW_MON")
  if [ "$CL_DAY" != "$NOW_DAY" ] || [ "$CL_MON" != "$NOW_MON_RU" ]; then
    echo "⚠️  changelog: последняя запись «${CL_DAY:-?} ${CL_MON:-?}», сегодня «${NOW_DAY} ${NOW_MON_RU}». Добавь запись, если это фича-деплой (Ctrl+C для отмены, 5 сек)"
    sleep 5
  fi
fi

# D2: pre-deploy снапшот БД на сервере ДО rsync/миграций — точка отката, если
# деплой (или авторан-миграция при старте) сломает БД. Храним последние 2 —
# полная история снапшотов есть в облаке (rclone, backup-offsite.sh).
echo "==> Pre-deploy DB snapshot on $SERVER"
"${SSH[@]}" "$SERVER" "set -e; cd $REMOTE_DIR; \
  BK=\${DB_BACKUP_DIR:-/var/backups/proxy-dashboard}; \
  mkdir -p \"\$BK\"; \
  TS=\$(date -u +%Y%m%d-%H%M%S); \
  D=\"\$BK/pre-deploy-\$TS\"; \
  mkdir -p \"\$D\"; \
  if [ -f dashboard.db ]; then \
    sqlite3 dashboard.db \".backup '\$D/dashboard.db'\" 2>/dev/null || \
    { sqlite3 dashboard.db 'PRAGMA wal_checkpoint(TRUNCATE);' >/dev/null 2>&1 || true; cp dashboard.db \"\$D/dashboard.db\"; }; \
    echo \"snapshot: \$D/dashboard.db\"; \
  else echo 'dashboard.db not found — snapshot skipped'; fi; \
  ls -d \"\$BK\"/pre-deploy-* 2>/dev/null | sort | head -n -2 | xargs -r rm -rf"

echo "==> Syncing files to $SERVER:$REMOTE_DIR"
rsync -av --delete \
  --exclude='node_modules' --exclude='logs' --exclude='*.db' \
  --exclude='.env' --exclude='.env.*' \
  --exclude='*.db-wal' --exclude='*.db-shm' \
  --exclude='tochka_config.json' --exclude='known_modems.json' \
  --exclude='server_cache.json' --exclude='bank_payments.json' \
  --exclude='ip_history.json' --exclude='ip_tracking.json' \
  --exclude='sessions.json' --exclude='speedtest_history.json' \
  --exclude='telegram_*.json' --exclude='uptime_tracking.json' \
  --exclude='.git' --exclude='tests' \
  -e "$RSYNC_RSH" ./ "$SERVER:$REMOTE_DIR/"

echo "==> Installing production dependencies"
"${SSH[@]}" "$SERVER" "cd $REMOTE_DIR && npm ci --omit=dev"

echo "==> Restarting pm2"
"${SSH[@]}" "$SERVER" "pm2 restart dashboard"

echo "==> Smoke test"
sleep 5
if "${SSH[@]}" "$SERVER" "curl -sf $HEALTH_URL >/dev/null"; then
  echo "✅ Deploy OK"
else
  echo "❌ Health check failed — investigating..."
  "${SSH[@]}" "$SERVER" "pm2 logs dashboard --lines 30 --nostream | tail -30"
  exit 1
fi
