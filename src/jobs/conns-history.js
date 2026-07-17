// Кольцевая история живых TCP-коннектов по модемам (для спарклайна в колонке
// «Конн.» на странице Модемы). ProxySmart отдаёт только мгновенный снимок
// (conns_stats на порту), поэтому раз в минуту сэмплируем сумму по модему в
// память. Глубина ~65 минут; при рестарте история начинается заново — это
// осознанно (диагностический график, не биллинг).
//
// Сэмплер ходит через fetchAllServersDataCached() — SWR-кэш сам решает,
// отдать кэш или обновиться, лишней долбёжки ProxySmart нет.

const HIST_MS = 65 * 60 * 1000;   // храним чуть больше часа
const STEP_MS = 60 * 1000;        // шаг сэмпла — минута

function create(deps) {
  const { getFetchAllServersDataCached, logger } = deps;
  const hist = new Map();         // 'S1_86xxx' -> [{t, v}]
  let timer = null;

  async function sample() {
    try {
      const results = await getFetchAllServersDataCached()();
      const now = Date.now();
      for (const data of results || []) {
        if (data._cached) continue;                      // протухший кэш недоступного сервера не пишем
        const prefix = data.serverName + '_';
        for (const [imei, ports] of Object.entries(data.ports || {})) {
          let v = 0;
          for (const p of ports || []) v += (p.conns_stats && Number(p.conns_stats.total)) || 0;
          const key = prefix + imei;
          let arr = hist.get(key);
          if (!arr) { arr = []; hist.set(key, arr); }
          // не дублируем точку, если кэш не обновился с прошлого сэмпла
          if (arr.length && now - arr[arr.length - 1].t < STEP_MS / 2) continue;
          arr.push({ t: now, v });
          while (arr.length && now - arr[0].t > HIST_MS) arr.shift();
        }
      }
      for (const [k, arr] of hist) {                     // модемы, исчезнувшие из выдачи, стареют и удаляются
        if (!arr.length || Date.now() - arr[arr.length - 1].t > HIST_MS) hist.delete(k);
      }
    } catch (e) { logger.warn('[ConnsHist] sample failed: ' + e.message); }
  }

  function start() {
    if (timer) return;
    sample();
    timer = setInterval(sample, STEP_MS);
    if (timer.unref) timer.unref();
  }

  // Компактная форма для payload: key -> [[секундНазад, total], ...] от старых к новым.
  function get() {
    const out = {};
    const now = Date.now();
    for (const [k, arr] of hist) out[k] = arr.map(p => [Math.round((now - p.t) / 1000), p.v]);
    return out;
  }

  return { start, get, sample, _hist: hist };
}

module.exports = { create };
