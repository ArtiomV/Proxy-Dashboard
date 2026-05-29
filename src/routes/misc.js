'use strict';
//
// src/routes/misc.js — small, mostly-standalone endpoints (Stage 3).
//
// Routes that don't fit into a domain router:
//   GET  /admin                            — serves admin.html
//   GET  /api/docs                         — self-describing JSON API doc
//   POST /api/admin/cache/invalidate       — drop ProxySmart cache
//   GET  /api/admin/vpn_profile            — .ovpn file passthrough
//   GET  /api/admin/shop_report            — opaque ProxySmart shop report

const express = require('express');
const path = require('path');

module.exports = function createMiscRouter(deps) {
  const {
    logger, authMiddleware, adminMiddleware,
    proxySmart, findServer, fetchApi, fetchApiRaw,
  } = deps;
  const r = express.Router();

  r.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, '..', '..', 'public', 'admin.html'));
  });

  r.get('/api/docs', (req, res) => {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.json({
      title: 'Proxies.Rent API Documentation',
      version: '1.0',
      baseUrl,
      authentication: {
        description: 'Используйте API ключ из вашего личного кабинета',
        methods: [
          { name: 'Query parameter', example: `${baseUrl}/api/v1/proxies?apiKey=YOUR_API_KEY` },
          { name: 'Session token', header: 'X-Auth-Token', description: 'Получается через /api/login' }
        ]
      },
      endpoints: {
        public: [
          {
            method: 'GET',
            path: '/api/v1/proxies',
            description: 'Получить список всех ваших прокси',
            params: {
              apiKey: { required: true, description: 'Ваш API ключ (найдите в личном кабинете)' },
              format: { required: false, default: 'json', options: ['json', 'txt', 'csv'], description: 'Формат ответа' }
            },
            examples: {
              json: `curl "${baseUrl}/api/v1/proxies?apiKey=YOUR_KEY&format=json"`,
              txt: `curl "${baseUrl}/api/v1/proxies?apiKey=YOUR_KEY&format=txt"`,
              csv: `curl "${baseUrl}/api/v1/proxies?apiKey=YOUR_KEY&format=csv"`
            },
            response_json: {
              proxies: [{ modem: 'MD2_64', ip: '89.149.100.92', httpPort: 8040, socksPort: 9040, login: 'user', password: 'pass', resetUrl: 'http://...' }],
              count: 1,
              client: 'ClientName'
            },
            response_txt: 'ip:port:login:password|reset_url (по одному на строку)'
          },
          {
            method: 'GET',
            path: '/api/client/reset_ip_by_token',
            description: 'Сброс IP модема по токену (не требует авторизации)',
            params: {
              nick: { required: true, description: 'Ник модема (например MD2_64)' },
              token: { required: true, description: 'Токен сброса из вашего аккаунта' }
            },
            example: `curl "${baseUrl}/api/client/reset_ip_by_token?nick=MD2_64&token=YOUR_TOKEN"`
          }
        ],
        authenticated: [
          {
            method: 'POST',
            path: '/api/login',
            description: 'Авторизация — получение токена сессии',
            body: { login: 'string', password: 'string' },
            response: { token: 'string', login: 'string', isAdmin: 'boolean' }
          },
          {
            method: 'GET',
            path: '/api/client/data',
            description: 'Получить все данные клиента (модемы, трафик, порты)',
            headers: { 'X-Auth-Token': 'YOUR_TOKEN' }
          },
          {
            method: 'GET',
            path: '/api/client/credentials_export',
            description: 'Экспорт доступов прокси с прямыми ссылками на смену IP',
            headers: { 'X-Auth-Token': 'YOUR_TOKEN' }
          },
          {
            method: 'POST',
            path: '/api/client/reset_ip',
            description: 'Сброс IP модема',
            headers: { 'X-Auth-Token': 'YOUR_TOKEN', 'Content-Type': 'application/json' },
            body: { imei: 'IMEI модема', serverName: 'S1 или S2' }
          },
          {
            method: 'GET',
            path: '/api/client/rotation_log',
            description: 'Лог ротации IP модема',
            params: { nick: 'Ник модема', serverName: 'S1 или S2' }
          },
          {
            method: 'GET',
            path: '/api/client/ip_history',
            description: 'История смены IP с точными временными метками',
            params: { key: 'IMEI ключ (формат: S1_IMEI или S2_IMEI)' }
          },
          {
            method: 'GET',
            path: '/api/client/referral',
            description: 'Информация о партнёрской программе'
          },
          {
            method: 'GET',
            path: '/api/client/documents',
            description: 'Список закрывающих документов'
          },
          {
            method: 'POST',
            path: '/api/tools/check_proxy',
            description: 'Проверка работоспособности прокси (макс. 50 штук)',
            body: { proxies: [{ ip: 'string', port: 'number', login: 'string (опц.)', password: 'string (опц.)' }] }
          }
        ]
      },
      formats: {
        txt: 'ip:port:login:password|direct_reset_url',
        csv: 'ip,http_port,socks_port,login,password,reset_url',
        json: 'Полный JSON объект со всеми данными'
      },
      notes: [
        'Ссылка для смены IP работает напрямую с сервером — не требует работы нашего сервера',
        'API ключ можно найти в личном кабинете',
        'Спидтесты выполняются автоматически в 02:00 и 14:00 UTC',
        'IP история обновляется каждые 10 минут'
      ]
    });
  });

  r.post('/api/admin/cache/invalidate', authMiddleware, adminMiddleware, (req, res) => {
    proxySmart.invalidateCache();
    logger.info('[Cache] API server cache invalidated by admin');
    res.json({ ok: true, message: 'Cache invalidated' });
  });

  r.get('/api/admin/vpn_profile', authMiddleware, adminMiddleware, async (req, res) => {
    try {
      const { portId, serverName } = req.query;
      if (!portId || !serverName) return res.status(400).json({ error: 'portId and serverName required' });
      const server = findServer(serverName);
      if (!server) return res.status(400).json({ error: 'Server not found' });
      const { buffer, contentType } = await fetchApiRaw(server, `/get_vpn_profile/${encodeURIComponent(portId)}.ovpn`);
      res.set('Content-Type', contentType || 'application/x-openvpn-profile');
      res.set('Content-Disposition', `attachment; filename="${portId}.ovpn"`);
      res.send(buffer);
    } catch (err) { res.status(502).json({ error: 'VPN profile failed', details: err.message }); }
  });

  r.get('/api/admin/shop_report', authMiddleware, adminMiddleware, async (req, res) => {
    try {
      const { shop, period, serverName } = req.query;
      if (!shop || !period || !serverName) return res.status(400).json({ error: 'shop, period, serverName required' });
      const server = findServer(serverName);
      if (!server) return res.status(400).json({ error: 'Server not found' });
      const result = await fetchApi(server, `/apix/shop_report/${encodeURIComponent(shop)}/${encodeURIComponent(period)}`);
      res.json(result);
    } catch (err) { res.status(502).json({ error: 'Failed', details: err.message }); }
  });

  return r;
};
