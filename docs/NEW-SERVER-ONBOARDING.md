# Подключение нового прокси-сервера (ProxySmart) к дашборду

Чек-лист от 2026-08-26, проверен на сервере ro1 (92.180.31.223). Дашборд живёт на VPS 2.29.2.168 (`/root/Proxy-Dashboard`, pm2, node).

## 1. На прокси-сервере

```bash
# пользователь mon (read-only доступ для дашборда)
useradd -m -s /bin/bash mon
passwd -l mon
mkdir -p /home/mon/.ssh
cat > /home/mon/.ssh/authorized_keys << 'EOF'
from="2.29.2.168",no-agent-forwarding,no-X11-forwarding,no-port-forwarding ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIbiTNcnkb6nuONo0Nt5C+9diV/3AGJb+4jwxphAncYc dashboard-mon
EOF
chmod 700 /home/mon/.ssh; chmod 600 /home/mon/.ssh/authorized_keys
chown -R mon:mon /home/mon/.ssh

# sudo только на чтение статусов ProxySmart
cat > /etc/sudoers.d/mon-dashboard << 'EOF'
mon ALL=(root) NOPASSWD: /usr/local/bin/proxysmart.sh show_status, /usr/local/bin/proxysmart.sh show_status_json, /usr/local/bin/proxysmart.sh show_single_status_json *, /usr/local/bin/proxysmart.sh help
EOF
chmod 440 /etc/sudoers.d/mon-dashboard
```

Важно про `from=`:
- Дашборд ходит только с IP **2.29.2.168**. Если роутер перед сервером сохраняет src-адрес (MikroTik dst-nat без masquerade) — оставляем как есть.
- Если роутер маскарадит src (случай md1: на сервер приходит 192.168.1.1) — добавить в `from=` адрес роутера: `from="2.29.2.168,192.168.1.1"`. Диагностика: `grep "2.29.2.168\|mon" /var/log/auth.log` — видно, с какого IP реально приходит попытка.

## 2. На роутере перед сервером

- dst-nat: `<внешний SSH-порт> → <LAN-IP сервера>:22` (без masquerade src!). Пример ro1: `92.180.31.223:6005 → 192.168.88.252:22`.
- dst-nat панели: `<внешний порт> → <LAN-IP>:8080`. Пример ro1: `:7005 → :8080`.
- LAN-IP сервера закрепить статикой на самом сервере (networkd/netplan), чтобы проброс не протух.
- Клиентские прокси-порты: прямой проброс диапазонов 5001-5099 и 8001-8099 **без To Ports** (инцидент 26.08: на MikroTik ro1 стояло To Ports 1194 — диапазоны бы не работали).

## 3. В дашборде (админка → Настройки → серверы)

Добавить сервер с полями (с 26.08 SSH-реквизиты вводятся прямо в форме «Добавить сервер» — отдельная правка после создания не нужна):
- `name` — S5/RO1... (внутренний идентификатор, используется в rotation_cache и т.п.)
- `url` — `http://<внешний IP>:<порт панели>` (напр. `http://92.180.31.223:7005`)
- `user`/`pass` — логин панели ProxySmart (proxy / пароль панели)
- `publicIp` — внешний IP
- `osLogin` (SSH логин) — **обязательно `mon`** (не artiom/root!). Инцидент 26.08: дашборд пытался войти как artiom, ключ dashboard-mon лежит только у mon → «Connection closed by authenticating user artiom».
- `osPassword` (SSH пароль) — оставить пустым (mon ходит по ключу; sshpass-фолбэк не нужен)
- `sshPort` — внешний SSH-порт из п.2 (напр. 6005). Если пусто — дашборд пробует 2222, потом 22.
- `displayName`, `hardware`, `address`, `country`/`countryName`, `tz` — по факту площадки.

Как это устроено: env `API_S<n>_*` в `.env` — только bootstrap-дефолт (url/publicIp env-owned); метаданные, SSH-реквизиты и user/pass — DB-owned (kv_store `api_servers`), править через UI, переживают pm2-рестарт.

## 4. Проверка

- На дашборд-сервере: `ssh -i ~/.ssh/id_ed25519 mon@<внешний IP> -p <sshPort> 'sudo /usr/local/bin/proxysmart.sh show_status'` — должна вернуться таблица модемов.
- На прокси-сервере: `lsusb` — модемы должны быть видны на шине (ZTE = вендор `19d2`). Если хаб виден, а модемов нет — проблема физическая (питание хаба/кабель), дашборд тут ни при чём (инцидент ro1 26.08).
- В админке дашборда: метрики сервера и модемы появляются в течение цикла сбора (server-metrics.js). Первая попытка сбора может отвалиться на HTTP-фолбэк — следующая уже пойдёт по SSH.
- На прокси-сервере: `grep "Accepted publickey for mon" /var/log/auth.log`.
