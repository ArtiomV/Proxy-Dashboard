'use strict';
//
// src/jobs/client-activity-sync.js — признак «неактивен» (вкладка «Неактивные»
// страницы «Клиенты» = у клиента нет ни одного порта) в виде, доступном
// внешним потребителям. Агент продлений (tg2twenty/renewal) читает dashboard.db
// read-only и сам вычислить «нет модемов» не может — порты живут в ProxySmart.
//
// Результат — kv_store['crm_client_activity']:
//   { updatedAt, clients: { <clientId>: { active, ports, inactiveSince } } }
// inactiveSince — момент, когда джоба впервые увидела клиента без портов
// (переживает рестарт, сбрасывается при возврате портов). Агент по этому ключу
// помечает неактивных в CRM и возвращает пометку, когда порты появились снова.
//
// Защита от ложных «все неактивны»: пустой фид серверов → прогон пропускается,
// прежний снимок остаётся. Недоступные боксы фид берёт из кэша (см.
// proxy-smart.fetchAllServersDataCached), так что короткий сбой порты не «стирает».

const KEY = 'crm_client_activity';

function create(deps) {
  const { clients, fetchAllServersDataCached, kvGet, kvSet, portValidity } = deps;

  function _prev() {
    try {
      const row = kvGet(KEY);
      return row && row.value ? JSON.parse(row.value) : null;
    } catch (_) { return null; }
  }

  async function runOnce() {
    const serverResults = await fetchAllServersDataCached();
    if (!Array.isArray(serverResults) || !serverResults.length) {
      return { status: 'skipped', reason: 'empty_feed' };
    }
    const index = portValidity.clientPortsIndex(serverResults);
    const prev = (_prev() || {}).clients || {};
    const nowIso = new Date().toISOString();
    const out = {};
    let inactive = 0;
    for (const c of clients) {
      if (!c || !c.id) continue;
      const ports = portValidity.clientPortsFromIndex(c, index).length;
      const active = ports > 0;
      if (!active) inactive++;
      const was = prev[c.id];
      out[c.id] = {
        active,
        ports,
        inactiveSince: active ? null : ((was && !was.active && was.inactiveSince) || nowIso),
      };
    }
    kvSet(KEY, JSON.stringify({ updatedAt: nowIso, clients: out }));
    return { status: 'completed', total: Object.keys(out).length, inactive };
  }

  return { runOnce };
}

module.exports = { create, KEY };
