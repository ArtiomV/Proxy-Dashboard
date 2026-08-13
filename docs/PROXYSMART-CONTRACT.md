# PROXYSMART-CONTRACT — используемые эндпоинты /apix/* и их формы (D7)

Документ фиксирует контракт боксов ProxySmart **по факту того, как код
парсит ответы** (не по документации вендора). Соответствие проверяется
в рантайме валидатором `src/api/proxysmart-contract.js` — вызывается в
цикле опроса (`fetchServerData`, src/api/proxy-smart.js); при несоответствии —
TG-алерт «бокс S<n> отвечает не по контракту» (правило
`proxysmart_contract_mismatch`, cooldown сутки на бокс) + warn в лог.

Аутентификация: HTTP Basic (user/pass сервера) для всех read-эндпоинтов.
Исключение — `/apix/reboot_server`: сидит за session-кукой веб-панели
(`fetchApiPanel`, логин через POST /modem/login, TTL сессии ~10 мин).

Единицы и TZ: полоса пропускания в ответах — **строки вида `"21.1 GB"`**
(парсер `parseBwToBytes`, src/utils/traffic.js; 1 GB = 10⁹ байт).
Дневные/месячные счётчики — по **локальному времени бокса** (боксы — МСК);
агрегаты дашборда (`traffic_hourly.hour_start`) хранятся в UTC.
Даты в строках портов — ISO (`2026-02-10T14:14:26`).

## Чтение (опрос и UI)

### GET /apix/bandwidth_report_all
Ключевой опрос (каждый цикл, src/api/proxy-smart.js fetchServerData).
```
{ "<portId>": {
    "port": "portQcSp2e0Y", "portName": "Brandanalytics",
    "bandwidth_bytes_day_in": "21.1 GB",  "bandwidth_bytes_day_out": "3.4 GB",
    "bandwidth_bytes_yesterday_in": "77.7 GB", "bandwidth_bytes_yesterday_out": "10.4 GB",
    "bandwidth_bytes_month_in": "267.8 GB",   "bandwidth_bytes_month_out": "39.5 GB",
    "bandwidth_bytes_premonth_in": "… GB", "bandwidth_bytes_premonth_out": "… GB"
} }
```
Читается: hourly-дельты (src/traffic/hourly.js), liveMonthGb портала,
дневная сводка. Валидатор: `port` (string), `portName` (string),
`bandwidth_bytes_day_in/out` — string, null или finite number ≥ 0 у каждой записи.

Легальные значения `bandwidth_*` — всё, что `parseBwToBytes` переваривает без
потерь: string "N.N GB", null (бокс так отвечает в момент сброса счётчиков;
в проде `bandwidth_bytes_prevmonth_in: null` — постоянно, а 13.08.2026 S1/S2
транзитно отдали null в day_in/day_out) и числовой 0 (бокс отдаёт number,
пока за день нет трафика — 13.08.2026 S1–S4). Ночной сброс бьёт по всем
портам сразу, поэтому ВСЯ выборка в null/0 — тоже легальная ситуация.
Нарушение — значение другого типа (object/array/bool) или ключ отсутствует,
либо ВСЯ выборка с невалидными типами счётчиков (фид деградировал → трафик
посчитается нулевым, биллинг недоберёт).

### GET /apix/show_status_json
Статус модемов (каждый цикл).
```
[ { "modem_details": { "IMEI": "867…", "NICK": "RO_1", "MODEL": "MF289",
      "MODEL_SHOWN": "MF289", "PHONE_NUMBER": "", "UPTIME": "…",
      "REBOOT_SCORE": 0, "AUTO_IP_ROTATION": "8", "USB_ID": "…" },
    "net_details": { "IS_ONLINE": "yes", "EXT_IP": "…", "ICCID": "…",
      "SimStatus": "OK", "SIGNAL_STRENGTH": "…", "CELLOP": "…",
      "HTTP_REDIRECT_IMPOSED": 0 },
    "IS_ROTATED": "false", "IS_REBOOTING": "false",
    "android": {"battery":"","serial":"","version":""},
    "STATE": "added", "OWNER": "proxy", "N": 1 } ]
```
Читается: fleet/tracking (IS_ONLINE/EXT_IP/ICCID/NICK/IMEI), SIM-сигналы
(SimStatus, HTTP_REDIRECT_IMPOSED, REBOOT_SCORE). Валидатор: массив,
`modem_details.IMEI` (string), `NICK`, `net_details` (object).
NB: запись без IMEI — легальна (модем в процессе добавления,
`MSGS: "dev … is not yet processed"`); парсер её пропускает, валидатор —
тоже, нарушение только если без IMEI вся выборка.

### GET /apix/list_ports_json
Порты по IMEI (каждый цикл + действия с портами).
```
{ "<imei>": [ { "HTTP_PORT": "8031", "LOGIN": "S54KDSog", "PASSWORD": "…",
    "CREATED_AT": "2026-02-10T14:14:26", "IS_EXPIRED": 0, "IS_OVER_QUOTA": 0,
    "PROXY_VALID_BEFORE": "", "QUOTA": "", "OWNER": "proxy",
    "RESET_SECURE_LINK": { "URL": "http://…/apix/reset_ip_secure?hash=aes_ecb:…" } } ] }
```
Валидатор: object, значения — массивы, у записи `HTTP_PORT`, `LOGIN`.

### Прочие read-эндпоинты (по требованию)
- `GET /apix/show_single_status_json?arg=<nick>` — статус одного модема (форма = элемент show_status_json).
- `GET /apix/get_rotation_log?arg=<nick>` — лог ротаций IP (дата/время, старый/новый IP).
- `GET /apix/bandwidth_report_json?arg=<portId>` — детальный отчёт по порту.
- `GET /apix/get_counters_port?PORTID=<id>&START=<ts>&END=<ts>` — счётчики
  порта за диапазон (src/routes/traffic.js). Используется ручной сверкой;
  в каноне биллинга не участвует.
- `GET /apix/unique_ips_json` — `UNIQUE_IPS_PERCENT` за 14 дней (карточки серверов).
- `GET /apix/top_hosts?arg=<portId>` — топ хостов (через шим на боксах), джоба TopHosts.
- `GET /apix/speedtest?arg=<nick>` — спидтест (долгий, таймаут 180 с).
- `GET /apix/get_free_tcp_ports` — свободные TCP-порты бокса.
- `GET /apix/shop_report/<shop>/<period>` — отчёт магазина.

## Действия (write)

- `GET /apix/apply_port?arg=<portId>` — применить конфиг порта (создание/перенос/гашение; debt-block, failover, proxies-ports).
- `GET /apix/reset_modem?arg=<nick>`, `GET /apix/reset_modem_by_imei?IMEI=<imei>`,
  `GET /apix/reboot_modem_by_imei?IMEI=<imei>`, `GET /apix/usb_reset_modem_json?arg=<nick>` — ребуты/ресеты модема.
- `GET /apix/purge_sms_json?arg=<nick>` — очистка SMS.
- `POST /apix/bandwidth_reset_counter?arg=<portId>` — сброс счётчика порта.
- `GET /apix/reboot_server` — ребут бокса; **панельная сессия** (fetchApiPanel), не Basic-auth.

## HTML-формы панели (/conf/*, не JSON)

`/conf/edit/<imei>`, `/conf/edit_port/<portId>`, `/conf/add_port?imei=<imei>`
— читаются `getConfForm` (src/api/proxysmart-conf.js), поля парсятся из HTML
(`parseHtmlInputFields`): `AUTO_IP_ROTATION`, `portName`, `http_port`,
`proxy_password` и др. POST через `postConfForm` с той же панельной сессией.

## Версия прошивки/панели — ТРЕБУЕТСЯ ОТ ProxySmart

В используемых ответах поля версии прошивки/панели **нет** (проверено по
живому server_cache.json 2026-08: есть только per-modem `android.version`,
пустое). Запросить у ProxySmart поле версии (например, в show_status_json
или отдельным эндпоинтом) — после появления показать в карточке сервера
(admin.html, секция серверов) и дополнить этот контракт + валидатор.

## Валидация в рантайме (D7)

`validateFetchResult({bw, status, ports})` гоняется на каждом успешном
опросе сервера. Нарушения (отсутствие полей, смена типов верхнего уровня)
→ logger.warn + `alerts.trigger('proxysmart_contract_mismatch', …)`,
cooldown 86400 с, dedupe `pscontract_<server>`. Пустые коллекции
(0 модемов/портов) нарушением не считаются.
