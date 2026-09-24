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

  // 2026-09-18 · DEEP-09 (§15.1): изменения одного порта сериализуются
  // внутри процесса — цепочка read-form → POST → apply → verify не должна
  // пересекаться с другим писателем того же server+portID (включая UI).
  // Межпроцессной гонки это не закрывает: server-side CAS у ProxySmart нет,
  // остаточная внешняя гонка документирована в §15.1; владельца и срок
  // перечитываем свежим чтением (см. ниже).
  const _portLocks = new Map();   // `${serverName}:${portId}` → Promise

  // Свежая запись порта из list_ports_json (обход кэша — читаем напрямую).
  async function _readPort(server, portId) {
    const data = await fetchApi(server, '/apix/list_ports_json');
    for (const list of Object.values(data || {})) {
      const found = Array.isArray(list) && list.find(p => p && p.portID === portId);
      if (found) return found;
    }
    return null;
  }

  // Форма целиком → правка полей → POST → apply_port.
  // opts.expectedPortName — ожидаемый владелец (client.portName): перед POST
  // и после apply владелец перечитывается; смена владельца = конфликт,
  // полную форму конкурента НЕ затираем (DEEP-09).
  async function _editPortUnlocked(server, portId, patch, opts = {}) {
    const expectedOwner = opts.expectedPortName != null ? String(opts.expectedPortName) : null;
    const form = await proxyConf.getConfForm(server, `/conf/edit_port/${portId}`);
    if (!form.ok) throw new Error(`edit_port form: ${form.reason}`);
    const formData = parseHtmlInputFields(form.html);
    // proxy_password в HTML-форме нет — добираем из API портов. Заодно это же
    // чтение — повторная проверка владельца ПЕРЕД мутацией: форму могли
    // пересохранить (переаренда порта) между нашим чтением и POST.
    let livePort = null;
    if (!formData.proxy_password || expectedOwner !== null) {
      livePort = await _readPort(server, portId);
      if (livePort && !formData.proxy_password && livePort.PASSWORD) {
        formData.proxy_password = livePort.PASSWORD;
      }
    }
    if (expectedOwner !== null) {
      if (!livePort) throw new Error('conflict: port missing from list_ports_json before mutation');
      if (String(livePort.portName || '') !== expectedOwner) {
        throw new Error(`conflict: port owner is ${livePort.portName || 'empty'}, expected ${expectedOwner}`);
      }
    }
    Object.assign(formData, patch);
    const posted = await proxyConf.postConfForm(server, `/conf/edit_port/${portId}`, formData);
    if (!posted.ok) throw new Error(`edit_port post: ${posted.reason}`);
    const applied = await fetchApi(server, `/apix/apply_port?arg=${encodeURIComponent(portId)}`);
    if (applied && (applied.error || applied.ok === false)) {
      throw new Error(`apply_port: ${applied.error || applied.reason || 'rejected'}`);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'PROXY_VALID_BEFORE') || expectedOwner !== null
        || Object.prototype.hasOwnProperty.call(patch, 'portName')) {
      const confirmed = await _readPort(server, portId);
      if (!confirmed) throw new Error('verification: port missing from list_ports_json');
      if (expectedOwner !== null && String(confirmed.portName || '') !== expectedOwner) {
        throw new Error(`verification: port owner is ${confirmed.portName || 'empty'}, expected ${expectedOwner}`);
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'PROXY_VALID_BEFORE')) {
        // API отдаёт дату со временем («YYYY-MM-DD HH:MM:SS»), постим только дату —
        // сравниваем по первым 10 символам, как делают UI и billing-ext.
        const wantVb = String(patch.PROXY_VALID_BEFORE).slice(0, 10);
        const gotVb = String(confirmed.PROXY_VALID_BEFORE || '').slice(0, 10);
        if (gotVb !== wantVb) {
          throw new Error(`verification: valid-before is ${gotVb || 'empty'}, expected ${wantVb}`);
        }
      }
      // 2026-09-18 · DEEP-15 (§15.2): назначение/отвязка portName подтверждается
      // свежим чтением, как setPortValidBefore подтверждает срок — один
      // HTTP 200/apply не доказывает отключение прежнего клиента.
      if (Object.prototype.hasOwnProperty.call(patch, 'portName')) {
        const wantName = String(patch.portName || '');
        const gotName = String(confirmed.portName || '');
        if (gotName !== wantName) {
          throw new Error(`verification: portName is ${gotName || 'empty'}, expected ${wantName || 'empty'}`);
        }
      }
    }
    if (proxySmart && typeof proxySmart.invalidateCache === 'function') proxySmart.invalidateCache();
  }

  function _editPort(server, portId, patch, opts) {
    const key = `${server && server.name}:${portId}`;
    const prev = _portLocks.get(key) || Promise.resolve();
    const next = prev.catch(() => {}).then(() => _editPortUnlocked(server, portId, patch, opts));
    _portLocks.set(key, next);
    next.catch(() => {}).then(() => { if (_portLocks.get(key) === next) _portLocks.delete(key); });
    return next;
  }

  // «Дата до» (PROXY_VALID_BEFORE): YYYY-MM-DD; сегодня = порт погашен.
  function setPortValidBefore(server, portId, dateStr, opts) {
    return _editPort(server, portId, { PROXY_VALID_BEFORE: dateStr }, opts);
  }

  // Привязка/отвязка: пустой portName = порт выключен (B6). Сохранённое
  // назначение подтверждается свежим чтением после apply (DEEP-15, §15.2).
  function setPortName(server, portId, name, opts) {
    return _editPort(server, portId, { portName: name }, opts);
  }

  // Среднесуточное списание за 7 дн (charge-строки ledger за полуинтервал
  // [сегодня−7; сегодня) московских дат: нижняя граница включена, текущий день
  // исключён; деление всегда на 7, округление до копейки после деления) —
  // FIX-07 (2026-09-18); тот же критерий, что в портале
  // (billing_history.summary.avgDailyCharge7d). Политика типов (только
  // charge; corrections/manual_charge) в этой задаче не меняется.
  function avgDailyCharge7d(clientId) {
    const today = _today();
    const d7 = getMoscowNow();
    d7.setDate(d7.getDate() - 7);
    const from = _mskDateStr(d7);
    // 2026-09-24 · §17.3.2: один SUM по индексу вместо чтения всей истории.
    // Тот же критерий и границы (charge, [from; today), ÷7, round2).
    if (ledgerDb && typeof ledgerDb.chargeSumForDates === 'function') {
      return Math.round((ledgerDb.chargeSumForDates(clientId, from, today) / 7) * 100) / 100;
    }
    const total = (ledgerDb.listByClient(clientId) || [])
      .filter(e => e.type === 'charge' && e.date && e.date >= from && e.date < today)
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

  // 2026-09-24 · §17.3.4: индекс portName → порты ОДИН раз на проход guard —
  // clientPorts сканировал весь фид на каждого клиента и каждый вызов
  // (O(клиенты × порты) на проход). Индекс строится за один проход фида,
  // форма элементов совпадает с clientPorts.
  function clientPortsIndex(serverResults) {
    const index = new Map();   // portName → [{server, portId, validBefore}]
    for (const data of serverResults || []) {
      const server = findServer(data.serverName);
      if (!server) continue;
      for (const list of Object.values(data.ports || {})) {
        for (const p of list || []) {
          if (!p || !p.portName || !p.portID) continue;
          if (!index.has(p.portName)) index.set(p.portName, []);
          index.get(p.portName).push({ server, portId: p.portID, validBefore: p.PROXY_VALID_BEFORE || '' });
        }
      }
    }
    return index;
  }
  function clientPortsFromIndex(client, index) {
    return (index && index.get(client && client.portName)) || [];
  }

  return { setPortValidBefore, setPortName, avgDailyCharge7d, clientPorts, clientPortsIndex, clientPortsFromIndex };
}

module.exports = { create };
