# Инвентаризация прямых async HTTP handlers

Статический AST-разбор server.js и src/routes/*.js. Код приложения не исполняется.

Прямых async callback: 103; с await вне лексического try/catch: 14.

Это список для проверки DEEP-60, а не число новых багов. Promise.catch у самого await может обрабатывать ошибку; напротив, синхронный throw внутри async тоже создаёт rejection. Callback по имени, обёртки и динамические пути не разрешаются. Catch/finally сами могут бросить ошибку. Отсутствие строки в первой группе не доказывает безопасность.

## Приоритет проверки: await вне try/catch

| Файл:строка | Метод | Путь | Строки await |
|---|---|---|---|
| src/routes/auth.js:28 | POST | /api/login | 57 |
| src/routes/clients.js:75 | POST | /api/admin/clients | 84 |
| src/routes/clients.js:165 | PUT | /api/admin/clients/:id | 182 |
| src/routes/payments.js:214 | POST | /api/payments/webhook/tochka | 228 |
| src/routes/proxy-checks.js:33 | POST | /api/tools/check_proxy | 102 |
| src/routes/registration.js:273 | POST | /api/register | 280, 299 |
| src/routes/registration.js:518 | POST | /api/forgot_password | 521 |
| src/routes/registration.js:546 | POST | /api/reset_password | 552 |
| src/routes/registration.js:564 | POST | /api/client/change_password | 571, 573 |
| src/routes/servers.js:37 | GET | /api/admin/server_stats | 39 |
| src/routes/servers.js:417 | PUT | /api/admin/settings | 772 |
| src/routes/tochka.js:322 | POST | /api/admin/tochka/config | 342 |
| src/routes/tochka.js:429 | POST | /api/admin/tochka/sync | 430 |
| src/routes/traffic.js:144 | GET | /api/admin/daily_traffic | 146 |

## Остальные прямые async callbacks — требуют проверки остальных исключений

- src/routes/admin-meta.js:50 — DELETE /api/admin/modems/:server_name/:port_id
- src/routes/alerts.js:42 — POST /api/admin/alerts/:id/test
- src/routes/analytics.js:101 — GET /api/analytics/heatmap
- src/routes/analytics.js:183 — GET /api/client/hourly_traffic
- src/routes/analytics.js:237 — GET /api/analytics/modem_heatmap
- src/routes/billing-ext.js:93 — GET /api/admin/monthly_costs
- src/routes/billing-ext.js:187 — GET /api/admin/finance_dashboard
- src/routes/billing-ext.js:686 — GET /api/admin/billing/reconciliation
- src/routes/billing.js:25 — POST /api/admin/run_billing
- src/routes/billing.js:47 — POST /api/admin/billing_rerun
- src/routes/client-portal.js:103 — GET /api/dashboard_data
- src/routes/client-portal.js:320 — POST /api/client/api_key/regenerate
- src/routes/client-portal.js:352 — GET /api/billing_history
- src/routes/client-portal.js:414 — POST /api/client/reset_ip
- src/routes/client-portal.js:468 — POST /api/client/set_rotation
- src/routes/client-portal.js:527 — GET /api/client/credentials_export
- src/routes/client-portal.js:688 — GET /api/client/closing_documents/:docId/pdf
- src/routes/client-portal.js:726 — GET /api/client/bills/:billId/pdf
- src/routes/clients.js:252 — DELETE /api/admin/clients/:id
- src/routes/clients.js:601 — POST /api/admin/clients/:id/document
- src/routes/clients.js:684 — POST /api/admin/clients/:id/block
- src/routes/failover.js:28 — GET /api/admin/failover/spares
- src/routes/failover.js:41 — GET /api/admin/failover/candidates
- src/routes/failover.js:50 — POST /api/admin/failover/execute
- src/routes/misc.js:160 — GET /api/admin/vpn_profile
- src/routes/misc.js:173 — GET /api/admin/shop_report
- src/routes/ops-ext.js:532 — GET /api/admin/data
- src/routes/ops-ext.js:827 — GET /api/admin/backup
- src/routes/payments.js:143 — POST /api/client/topup
- src/routes/payments.js:342 — POST /api/admin/card_payments/:orderId/refund
- src/routes/proxies-actions.js:56 — POST /api/admin/readd_modem
- src/routes/proxies-actions.js:78 — POST /api/admin/reboot_server
- src/routes/proxies-actions.js:100 — POST /api/admin/reset_complete
- src/routes/proxies-actions.js:132 — POST /api/admin/reconnect_all
- src/routes/proxies-ports.js:36 — POST /api/admin/store_port
- src/routes/proxies-ports.js:144 — POST /api/admin/move_port
- src/routes/proxies-ports.js:179 — POST /api/admin/update_port_creds
- src/routes/proxies-ports.js:197 — GET /api/admin/get_port_config
- src/routes/proxies-ports.js:247 — POST /api/admin/save_port_config
- src/routes/proxies-ports.js:304 — POST /api/admin/bulk_os_spoof
- src/routes/proxies-ports.js:348 — POST /api/admin/bulk_rotation
- src/routes/proxies-ports.js:395 — POST /api/admin/apply_port
- src/routes/proxies-ports.js:406 — POST /api/admin/purge_port
- src/routes/proxies-ports.js:427 — GET /api/admin/free_ports
- src/routes/proxies-sms.js:13 — GET /api/admin/sms
- src/routes/proxies-sms.js:24 — POST /api/admin/send_sms
- src/routes/proxies-sms.js:35 — POST /api/admin/send_ussd
- src/routes/proxies-sms.js:46 — POST /api/admin/purge_sms
- src/routes/proxies-speedtest.js:86 — GET /api/admin/speedtest
- src/routes/proxies.js:30 — POST /api/admin/store_modem
- src/routes/proxies.js:81 — POST /api/admin/apply_modem
- src/routes/proxies.js:94 — POST /api/admin/assign_modem
- src/routes/proxies.js:140 — GET /api/admin/available_modems
- src/routes/proxies.js:174 — GET /api/admin/modem_status
- src/routes/proxies.js:185 — GET /api/admin/rotation_log
- src/routes/proxy-checks.js:22 — GET /api/admin/top_hosts
- src/routes/public-api.js:26 — GET /api/v1/proxy
- src/routes/public-api.js:104 — GET /api/v1/proxies
- src/routes/public-lead.js:47 — POST /api/public/lead
- src/routes/registration.js:367 — POST /api/auth/telegram
- src/routes/registration.js:421 — GET /api/auth/telegram_oidc
- src/routes/registration.js:588 — POST /api/client/tg_link_code
- src/routes/retail.js:75 — POST /api/client/buy_proxy
- src/routes/retail.js:293 — POST /api/admin/retail/pool/add
- src/routes/retail.js:368 — POST /api/admin/retail/client/rehabilitate
- src/routes/retail.js:421 — GET /api/admin/retail/pool/legacy_preview
- src/routes/servers.js:280 — PATCH /api/admin/servers/:name
- src/routes/servers.js:348 — POST /api/admin/servers
- src/routes/simulator.js:93 — GET /api/admin/simulator/all-modems
- src/routes/simulator.js:146 — GET /api/admin/simulator/test-pool
- src/routes/simulator.js:237 — POST /api/admin/simulator/run
- src/routes/telegram-crm.js:22 — POST /api/admin/telegram/send_test
- src/routes/telegram-crm.js:43 — GET /api/admin/ai_insights/preview
- src/routes/telegram-crm.js:59 — GET /api/admin/telegram/preview
- src/routes/tochka.js:364 — POST /api/admin/tochka/autodetect
- src/routes/tochka.js:410 — POST /api/admin/tochka/register_webhook
- src/routes/tochka.js:501 — POST /api/admin/tochka/create_act
- src/routes/tochka.js:591 — GET /api/admin/clients/:id/closing_documents/:docId/pdf
- src/routes/tochka.js:651 — DELETE /api/admin/clients/:id/closing_document/:docId
- src/routes/tochka.js:748 — POST /api/admin/tochka/generate_acts
- src/routes/tochka.js:814 — POST /api/admin/tochka/create_bill
- src/routes/tochka.js:879 — POST /api/admin/tochka/generate_bills
- src/routes/tochka.js:956 — GET /api/admin/clients/:id/bills/:billId/pdf
- src/routes/tochka.js:1001 — DELETE /api/admin/clients/:id/bill/:billId
- src/routes/traffic.js:34 — GET /api/client/daily_traffic
- src/routes/traffic.js:421 — GET /api/admin/bandwidth_single
- src/routes/traffic.js:432 — GET /api/admin/bandwidth_period
- src/routes/traffic.js:443 — POST /api/admin/reset_bandwidth
- src/routes/traffic.js:454 — GET /api/admin/unique_ips
