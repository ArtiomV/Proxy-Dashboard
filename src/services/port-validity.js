'use strict';
//
// src/services/port-validity.js — общие операции со сроком жизни и привязкой
// порта ProxySmart (B2C Э2: выделено из src/jobs/debt-block.js, переиспользуется
// debt-block'ом и retail-guard'ом).
//
// Запись идёт тем же путём, что ручной save_port_config / assign_modem:
// читаем форму /conf/edit_port целиком (обход логин-стены S2 через proxyConf),
// меняем нужное поле, POST обратно + apply_port.

function create(deps) {
  const {
    proxyConf, fetchApi, parseHtmlInputFields, findServer, proxySmart,
    ledgerDb, getMoscowNow,
  } = deps;

  function _mskDateStr(d) { return d.toLocaleDateString('en-CA'); }   // YYYY-MM-DD
  function _today() { return _mskDateStr(getMoscowNow()); }

  // Форма целиком → правка полей → POST → apply_port.
  async function _editPort(server, portId, patch) {
    const form = await proxyConf.getConfForm(server, `/conf/edit_port/${portId}`);
    if (!form.ok) throw new Error(`edit_port form: ${form.reason}`);
    const formData = parseHtmlInputFields(form.html);
    // proxy_password в HTML-форме нет — добираем из API портов.
    if (!formData.proxy_password) {
      const portsData = await fetchApi(server, '/apix/list_ports_json');
      for (const plist of Object.values(portsData || {})) {
        for (const port of plist || []) {
          if (port.portID === portId && port.PASSWORD) { formData.proxy_password = port.PASSWORD; break; }
        }
        if (formData.proxy_password) break;
      }
    }
    Object.assign(formData, patch);
    const posted = await proxyConf.postConfForm(server, `/conf/edit_port/${portId}`, formData);
    if (!posted.ok) throw new Error(`edit_port post: ${posted.reason}`);
    await fetchApi(server, `/apix/apply_port?arg=${encodeURIComponent(portId)}`);
    if (proxySmart && typeof proxySmart.invalidateCache === 'function') proxySmart.invalidateCache();
  }

  // «Дата до» (PROXY_VALID_BEFORE): YYYY-MM-DD; сегодня = порт погашен.
  function setPortValidBefore(server, portId, dateStr) {
    return _editPort(server, portId, { PROXY_VALID_BEFORE: dateStr });
  }

  // Привязка/отвязка: пустой portName = порт выключен (B6).
  function setPortName(server, portId, name) {
    return _editPort(server, portId, { portName: name });
  }

  // Среднесуточное списание за 7 дн (charge-строки ledger за [today-7 .. today-1] / 7)
  // — тот же критерий, что в портале (billing_history.summary.avgDailyCharge7d).
  function avgDailyCharge7d(clientId) {
    const today = _today();
    const d7 = getMoscowNow();
    d7.setDate(d7.getDate() - 7);
    const from = _mskDateStr(d7);
    const total = (ledgerDb.listByClient(clientId) || [])
      .filter(e => e.type === 'charge' && e.date && e.date > from && e.date < today)
      .reduce((s, e) => s + (e.cost || 0), 0);
    return Math.round((total / 7) * 100) / 100;
  }

  // Все порты клиента по всем серверам (из уже загруженных server data).
  function clientPorts(client, serverResults) {
    const ports = [];
    for (const data of serverResults || []) {
      for (const list of Object.values(data.ports || {})) {
        for (const p of list || []) {
          if (p && p.portName && p.portName === client.portName) {
            ports.push({
              server: findServer(data.serverName),
              portId: p.portID,
              validBefore: p.PROXY_VALID_BEFORE || ''
            });
          }
        }
      }
    }
    return ports.filter(pt => pt.server && pt.portId);
  }

  return { setPortValidBefore, setPortName, avgDailyCharge7d, clientPorts };
}

module.exports = { create };
