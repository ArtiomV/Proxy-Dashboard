# DR-RUNBOOK — восстановление дашборда на чистой машине (D6)

Сценарий: прод-хост потерян (диск/образ/дЦ). Есть облачная копия бэкапов
(rclone remote, см. OPERATIONS.md «Бэкапы → облако») и репозиторий кода.

**RPO/RTO:**
- Текущее: бэкап 1×/сут (02:00 UTC) → **RPO 24 ч**, RTO ~1 ч (ручной сценарий ниже).
- Целевое: при настроенной облачной копии частоту DbBackup можно поднять до
  4×/сут → **RPO 6 ч** (зафиксировано как цель; требует отдельного решения —
  DbBackup сейчас привязан к 02:00 UTC в src/boot/startup.js).

## 0. Что понадобится заранее (хранить вне сервера)

- SSH-доступ к новой машине (root или sudo-пользователь).
- `.env` прода: `TOCHKA_CONFIG_KEY`, `TELEGRAM_*` (если переопределялись),
  `RCLONE_REMOTE`, `DB_BACKUP_DIR`, `API_<name>_*` (серверы ProxySmart),
  `ANTHROPIC_API_KEY` (опционально). Без `TOCHKA_CONFIG_KEY` банковский
  конфиг из бэкапа НЕ расшифруется — machine-id фолбэк на новом хосте
  бесполезен (см. OPERATIONS.md «Environment variables»).
- Креды облачного хранилища (Backblaze B2 application key) для rclone.

## 1. Чистая машина → зависимости

```bash
# Node.js LTS + pm2 + rclone + sqlite3
curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
apt-get install -y nodejs sqlite3
npm install -g pm2
# rclone: https://rclone.org/install/
curl https://rclone.org/install.sh | sudo bash
rclone config   # завести remote (S3/B2), имя = будущий $RCLONE_REMOTE
```

## 2. Код

```bash
git clone git@github.com:ArtiomV/Proxy-Dashboard.git /root/Proxy-Dashboard
cd /root/Proxy-Dashboard
npm ci --omit=dev
```

## 3. Env

Восстановить `.env` (минимум):

```
TOCHKA_CONFIG_KEY=<64 hex>      # ОБЯЗАТЕЛЬНО — иначе банковский конфиг не расшифруется
DB_BACKUP_DIR=/var/backups/proxy-dashboard
RCLONE_REMOTE=b2                # имя remote из rclone config
# API_<NAME>_URL/USER/PASS/PUBLIC_IP — серверы ProxySmart
# TELEGRAM_* — если переопределялись на уровне env
```

## 4. Restore БД из облака

```bash
mkdir -p /var/backups/proxy-dashboard
# Список доступных снапшотов:
rclone lsf ${RCLONE_REMOTE}:proxy-dashboard-backups
rclone lsf ${RCLONE_REMOTE}:proxy-dashboard-backups/monthly
# Забрать последний daily (или нужный monthly):
rclone copy ${RCLONE_REMOTE}:proxy-dashboard-backups/dashboard-YYYY-MM-DD.db /var/backups/proxy-dashboard/
cp /var/backups/proxy-dashboard/dashboard-YYYY-MM-DD.db /root/Proxy-Dashboard/dashboard.db
```

## 5. Verify

```bash
sqlite3 /root/Proxy-Dashboard/dashboard.db "SELECT count(*) FROM clients;"
sqlite3 /root/Proxy-Dashboard/dashboard.db "SELECT max(date) FROM billing_ledger;"
sqlite3 /root/Proxy-Dashboard/dashboard.db "SELECT value FROM kv_store WHERE key='tochka_config';"  # должна быть строка (enc1:-поля)
```

## 6. Старт

```bash
cd /root/Proxy-Dashboard
pm2 start ecosystem.config.js   # или: pm2 start server.js --name dashboard
pm2 save && pm2 startup
sleep 5 && curl -sf http://localhost:3000/health
```

Проверить в логах (`pm2 logs dashboard`):
- `[Tochka] API configured` — конфиг расшифровался (иначе см. ошибки
  DECRYPT → неверный/отсутствующий `TOCHKA_CONFIG_KEY`);
- нет `kv_write_refused` / `balance_drift`;
- первый опрос ProxySmart прошёл (модемы появились в UI).

## 7. Что НЕ восстанавливается из БД (пере-создаётся само)

- `server_cache.json`, `ip_tracking/uptime_tracking` — наполнятся первыми опросами.
- `known_modems.json` — если есть копия со старого хоста, положить рядом;
  иначе ростер пересоберётся из live-опроса + modem_meta в БД.
- pm2-logrotate, nginx/SSL — настраиваются отдельно (вне этого runbook).

Ссылки: OPERATIONS.md («Database backup», «Environment variables»),
docs/FUNCTIONAL-SPEC.md §11.
