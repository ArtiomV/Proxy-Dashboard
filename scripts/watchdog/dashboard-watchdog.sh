#!/bin/bash
# dashboard-watchdog.sh — внешний сторож дашборда (D1, ТЗ мониторинга v2).
# Живёт на боксе S3 (mon@37.233.27.147:2223), запускается cron'ом каждые 5 мин.
# Дёргает https://app.arendaproxy.ru/healthz:
#   - 200  → всё ок; если раньше были фейлы и слали алерт — шлём recovery;
#   - !=200/таймаут 2 раза подряд → алерт в TG напрямую через Bot API
#     (дашборд лежит, его собственные алерты мертвы — поэтому сторож внешний).
# Состояние (счётчик фейлов + флаг «алерт отправлен») — в state-файле рядом.

URL="https://app.arendaproxy.ru/healthz"
STATE_DIR="$(dirname "$0")"
STATE_FILE="$STATE_DIR/.watchdog_state"
ENV_FILE="$STATE_DIR/.watchdog_env"   # BOT_TOKEN=... CHAT_ID=... (chmod 600)

[ -f "$ENV_FILE" ] || { echo "no $ENV_FILE"; exit 1; }
. "$ENV_FILE"

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$URL" 2>/dev/null || echo "000")

fails=0; alerted=0
[ -f "$STATE_FILE" ] && . "$STATE_FILE"

save_state() { printf 'fails=%s\nalerted=%s\n' "$fails" "$alerted" > "$STATE_FILE"; }

send_tg() {
  curl -s --max-time 20 -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${CHAT_ID}" \
    --data-urlencode "text=$1" \
    --data-urlencode "parse_mode=HTML" >/dev/null 2>&1
}

if [ "$code" = "200" ]; then
  if [ "$alerted" = "1" ]; then
    send_tg "✅ <b>Дашборд поднялся</b>%0Aapp.arendaproxy.ru снова отвечает (healthz 200). Простой был ~$((fails * 5)) мин."
  fi
  fails=0; alerted=0; save_state
  exit 0
fi

fails=$((fails + 1))
if [ "$fails" -ge 2 ] && [ "$alerted" = "0" ]; then
  alerted=1
  send_tg "🔴 <b>Дашборд недоступен</b>%0Aapp.arendaproxy.ru/healthz не отвечает (HTTP $code), 2 проверки подряд (~10 мин).%0AСмотри сервер: ssh root@2.29.2.168 → pm2 logs dashboard"
fi
save_state
