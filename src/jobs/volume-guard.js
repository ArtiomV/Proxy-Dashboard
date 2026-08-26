'use strict';
// src/jobs/volume-guard.js — A4 (ТЗ мониторинга v2, 23.08): объёмные алерты
// с настраиваемыми пакетами по операторам. Защита пакетов трафика: узнать об
// аномальном потреблении за час, а не постфактум из счёта оператора.
//
// Пакеты — настройка operator_packages (JSON-массив, редактируется в
// Настройки → «Пакеты операторов» без рестарта):
//   [{ operator: 'Orange MD',     type: 'per_sim', volume_gb: 400,
//      renewal_day: 15, hourly_gb: 20,  pace_pct: 10 },
//    { operator: 'Moldtelecom',   type: 'shared',  volume_gb: 30720,
//      renewal_day: 1,  hourly_gb: 30,  pace_pct: 5  },
//    { operator: 'Digi',          type: 'unlimited', volume_gb: 0,
//      hourly_gb: 30,  pace_pct: 0  }, ...]
//   per_sim — объём на каждую симку (Orange 400 ГБ);
//   shared  — общий котёл на оператора (Moldtelecom/Moldcell 30 ТБ).
//   unlimited — безлимит: проверяем только аномальный расход за час, без
//               алертов об исчерпании и темпе.
//   renewal_day — день месяца, когда оператор обнуляет пакет (26.08);
//               остаток и темп считаются от последней такой даты, а не от
//               1-го числа. Пусто/1 — календарный месяц.
//   hourly_gb — порог мгновенной аномалии (ГБ/час на модем);
//               пусто у per_sim → 5% пакета; пусто у shared →
//               volume_hourly_default_gb.
//   pace_pct  — порог темпа: % пакета в сутки (per_sim — сутки модема,
//               shared — среднесуточное MTD по оператору).
//
// Прогон — раз в час (startup.js), по traffic_hourly:
//   1) volume_modem_hourly (important): модем за последний полный час
//      скачал больше порога. Текст: оператор, объём, % пакета (per_sim).
//   2) volume_package_pace (important): суточный темп превышает pace_pct%
//      пакета — «такими темпами пакет кончится за N дней».
// Дедуп по модему/оператору, cooldown 6 ч — в правилах alerts.js.
//
// Нестыковка часовых поясов: traffic_hourly.hour_start в UTC («YYYY-MM-DD
// HH:MM»). «Сутки» темпа считаем по UTC — для оценки расхода пакета сдвиг
// на 2–3 часа несущественен.

const GB = 1e9;

function findPackage(pkgs, operator) {
  const op = String(operator || '').toLowerCase().trim();
  if (!op) return null;
  for (const p of pkgs || []) {
    const po = String(p.operator || '').toLowerCase().trim();
    if (po && (op === po || op.startsWith(po) || po.startsWith(op))) return p;
  }
  return null;
}

function _forecastDate(now, daysLeft) {
  if (!Number.isFinite(daysLeft)) return null;
  return new Date(now.getTime() + Math.max(0, daysLeft) * 86400e3).toISOString().slice(0, 10);
}

// 26.08: день обновления тарифа (1–31). У операторов пакет обнуляется не 1-го
// числа, а в свою дату биллинга (Moldtelecom/Moldcell — общий бандл, Orange —
// пакет на SIM). Остаток и темп считаем от последней такой даты, а не от
// начала календарного месяца. По умолчанию 1 — старое поведение.
function renewalDayOf(pkg) {
  const d = Math.floor(Number(pkg && pkg.renewal_day));
  return d >= 1 && d <= 31 ? d : 1;
}

function _daysInMonthUtc(y, m) { return new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); }

// Период пакета: от последнего дня обновления (<= now, UTC) до следующего.
// Если дня нет в месяце (31 в феврале) — берём последний день месяца.
function packagePeriod(pkg, now = new Date()) {
  const day = renewalDayOf(pkg);
  let y = now.getUTCFullYear();
  let m = now.getUTCMonth();
  let start = new Date(Date.UTC(y, m, Math.min(day, _daysInMonthUtc(y, m))));
  if (start.getTime() > now.getTime()) {
    m -= 1; if (m < 0) { m = 11; y -= 1; }
    start = new Date(Date.UTC(y, m, Math.min(day, _daysInMonthUtc(y, m))));
  }
  let ny = y; let nm = m + 1;
  if (nm > 11) { nm = 0; ny += 1; }
  const reset = new Date(Date.UTC(ny, nm, Math.min(day, _daysInMonthUtc(ny, nm))));
  return { start, reset };
}

// Forecasts are based on average daily usage within the current billing
// period (от даты обновления тарифа). This intentionally shares the same
// traffic_hourly source as billing and package alerts.
function buildForecasts(db, pkgs, now = new Date()) {
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) return [];
  const out = [];
  for (const pkg of pkgs || []) {
    const type = pkg.type === 'shared' || pkg.type === 'unlimited' ? pkg.type : 'per_sim';
    const { start, reset } = packagePeriod(pkg, date);
    const periodStart = start.toISOString().slice(0, 10);
    const resetDate = reset.toISOString().slice(0, 10);
    const elapsedDays = Math.max(1, Math.floor((date.getTime() - start.getTime()) / 86400e3) + 1);
    let rows = [];
    try {
      rows = db.prepare(`
        SELECT server_name, nick, operator, SUM(bytes_in + bytes_out) AS b
        FROM traffic_hourly WHERE hour_start >= ?
        GROUP BY server_name, nick, operator
      `).all(periodStart + ' 00:00');
    } catch (_) { continue; }

    const matches = rows.filter(r => findPackage([pkg], r.operator));
    const periodExtra = { period_start: periodStart, reset_date: resetDate };
    if (type === 'unlimited') {
      out.push({ scope: 'package', operator: pkg.operator, type, status: 'unlimited', modems: new Set(matches.map(r => r.server_name + '/' + r.nick)).size, ...periodExtra });
      continue;
    }
    const baseLimitGb = Number(pkg.volume_gb);
    if (!(baseLimitGb > 0)) {
      out.push({ scope: 'package', operator: pkg.operator, type, status: 'not_configured', modems: matches.length, ...periodExtra });
      continue;
    }
    const make = (scope, usedGb, extra, limitGb = baseLimitGb) => {
      const dailyGb = usedGb / elapsedDays;
      // A configured bundle may have no active SIM yet. Its capacity is then
      // correctly zero, but zero usage must not be reported as "exhausted".
      if (!(limitGb > 0)) {
        return {
          scope, operator: pkg.operator, type,
          package_gb: 0,
          used_gb: Math.round(usedGb * 10) / 10,
          remaining_gb: 0,
          gb_day: Math.round(dailyGb * 10) / 10,
          days_left: null,
          full_date: null,
          status: 'no_usage',
          ...extra,
        };
      }
      const remainingGb = Math.max(0, limitGb - usedGb);
      const daysLeft = usedGb >= limitGb ? 0 : (dailyGb > 0 ? remainingGb / dailyGb : null);
      return {
        scope, operator: pkg.operator, type,
        package_gb: limitGb,
        used_gb: Math.round(usedGb * 10) / 10,
        remaining_gb: Math.round(remainingGb * 10) / 10,
        gb_day: Math.round(dailyGb * 10) / 10,
        days_left: daysLeft == null ? null : Math.round(daysLeft * 10) / 10,
        full_date: _forecastDate(date, daysLeft),
        status: usedGb >= limitGb ? 'exhausted' : dailyGb > 0 ? 'forecast' : 'no_usage',
        ...extra,
      };
    };
    if (type === 'per_sim') {
      for (const row of matches) {
        out.push(make('sim', (Number(row.b) || 0) / GB, {
          server: row.server_name, nick: row.nick, operator_actual: row.operator, ...periodExtra,
        }));
      }
    } else {
      const usedGb = matches.reduce((sum, row) => sum + (Number(row.b) || 0) / GB, 0);
      const simCount = new Set(matches.map(r => r.server_name + '/' + r.nick)).size;
      const maxSims = Math.max(0, Math.floor(Number(pkg.max_sims) || 0));
      // Legacy shared rows had no max_sims and represented one common bundle.
      const bundleCount = maxSims > 0 ? (simCount > 0 ? Math.ceil(simCount / maxSims) : 0) : 1;
      const totalLimitGb = baseLimitGb * bundleCount;
      out.push(make('package', usedGb, {
        modems: simCount, max_sims: maxSims, bundle_count: bundleCount,
        volume_gb_per_bundle: baseLimitGb, ...periodExtra,
      }, totalLimitGb));
    }
  }
  return out.sort((a, b) => {
    const ad = a.days_left == null ? Infinity : a.days_left;
    const bd = b.days_left == null ? Infinity : b.days_left;
    return ad - bd;
  });
}

// Итог уже завершившегося расчётного периода. В отличие от прогноза выше,
// здесь показываем не "сколько осталось сейчас", а сколько оплаченного
// трафика фактически сгорело в прошлом периоде и какую долю платежа это
// составляет. Количество SIM всегда читается из живого modem_meta.
function buildPackageEfficiency(db, pkgs, now = new Date()) {
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) return [];
  let roster = [];
  try {
    roster = db.prepare(`
      SELECT server_name, nick, operator,
             CASE
               WHEN TRIM(COALESCE(iccid, '')) <> '' THEN 'iccid:' || TRIM(iccid)
               ELSE 'modem:' || server_name || '|' || COALESCE(NULLIF(TRIM(imei), ''), nick)
             END AS sim_key
      FROM modem_meta
      WHERE TRIM(COALESCE(operator, '')) <> '' AND COALESCE(deleted, 0) = 0
    `).all();
  } catch (_) {
    try {
      roster = db.prepare(`
        SELECT server_name, nick, operator,
               'modem:' || server_name || '|' || COALESCE(NULLIF(TRIM(imei), ''), nick) AS sim_key
        FROM modem_meta WHERE TRIM(COALESCE(operator, '')) <> ''
      `).all();
    } catch (_) { roster = []; }
  }

  const out = [];
  for (const pkg of pkgs || []) {
    const operator = String(pkg.operator || '').trim();
    if (!operator) continue;
    const type = pkg.type === 'shared' || pkg.type === 'unlimited' ? pkg.type : 'per_sim';
    const current = packagePeriod(pkg, date);
    const previous = packagePeriod(pkg, new Date(current.start.getTime() - 1));
    const periodStart = previous.start.toISOString().slice(0, 10);
    const periodEnd = current.start.toISOString().slice(0, 10);
    let trafficRows = [];
    try {
      trafficRows = db.prepare(`
        SELECT server_name, nick, operator, SUM(bytes_in + bytes_out) AS b
        FROM traffic_hourly
        WHERE hour_start >= ? AND hour_start < ?
        GROUP BY server_name, nick, operator
      `).all(periodStart + ' 00:00', periodEnd + ' 00:00');
    } catch (_) { trafficRows = []; }

    const matchingRoster = roster.filter(r => findPackage([pkg], r.operator));
    const simCount = new Set(matchingRoster.map(r => r.sim_key)).size;
    const usedGbRaw = trafficRows
      .filter(r => findPackage([pkg], r.operator))
      .reduce((sum, row) => sum + (Number(row.b) || 0) / GB, 0);
    const usedGb = Math.round(usedGbRaw * 10) / 10;
    const price = Math.max(0, Number(pkg.price) || 0);
    const currency = String(pkg.currency || 'RUB').toUpperCase();

    if (type === 'unlimited') {
      out.push({
        operator, type, period_start: periodStart, period_end: periodEnd,
        sim_count: simCount, bundle_count: simCount > 0 ? 1 : 0,
        purchased_gb: null, used_gb: usedGb, unused_gb: null,
        utilization_pct: null, monthly_cost: simCount > 0 ? price : 0,
        wasted_cost: null, currency, status: 'unlimited',
      });
      continue;
    }

    const volumeGb = Math.max(0, Number(pkg.volume_gb) || 0);
    const maxSims = type === 'per_sim' ? 1 : Math.max(0, Math.floor(Number(pkg.max_sims) || 0));
    const bundleCount = simCount === 0 ? 0 : (maxSims > 0 ? Math.ceil(simCount / maxSims) : null);
    const purchasedGb = bundleCount == null ? null : Math.round(bundleCount * volumeGb * 10) / 10;
    const monthlyCost = bundleCount == null ? null : Math.round(bundleCount * price * 100) / 100;
    const unusedGb = purchasedGb == null ? null : Math.round(Math.max(0, purchasedGb - usedGb) * 10) / 10;
    const utilizationPct = purchasedGb > 0 ? Math.round(Math.min(usedGb / purchasedGb * 100, 9999) * 10) / 10 : null;
    const wastedCost = monthlyCost != null && purchasedGb > 0
      ? Math.round(monthlyCost * Math.max(0, 1 - usedGb / purchasedGb) * 100) / 100
      : null;
    let status = 'ok';
    if (!(volumeGb > 0) || bundleCount == null) status = 'not_configured';
    else if (usedGb > purchasedGb) status = 'overrun';
    else if (utilizationPct != null && utilizationPct < 50) status = 'underused';
    out.push({
      operator, type, period_start: periodStart, period_end: periodEnd,
      sim_count: simCount, max_sims: maxSims, bundle_count: bundleCount,
      purchased_gb: purchasedGb, used_gb: usedGb, unused_gb: unusedGb,
      utilization_pct: utilizationPct, monthly_cost: monthlyCost,
      wasted_cost: wastedCost, currency, status,
    });
  }
  return out.sort((a, b) => Number(b.wasted_cost || 0) - Number(a.wasted_cost || 0));
}

function create(deps) {
  const { db, logger, alerts, getSetting } = deps;

  function _packages() {
    let raw = getSetting('operator_packages', '');
    if (Array.isArray(raw)) return raw;
    try {
      const arr = JSON.parse(String(raw || '[]'));
      return Array.isArray(arr) ? arr : [];
    } catch (_) { return []; }
  }

  function _findPkg(pkgs, operator) {
    return findPackage(pkgs, operator);
  }

  function _hourlyThresholdGb(pkg) {
    const explicit = Number(pkg.hourly_gb);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    if (pkg.type === 'per_sim' && Number(pkg.volume_gb) > 0) return Number(pkg.volume_gb) * 0.05;
    return Number(getSetting('volume_hourly_default_gb', 30)) || 30;
  }

  function runOnce() {
    if (getSetting('volume_enabled', true) === false) return { skipped: 'disabled' };
    const pkgs = _packages();
    if (!pkgs.length) return { skipped: 'no_packages' };

    const maxHour = db.prepare('SELECT MAX(hour_start) AS h FROM traffic_hourly').get();
    if (!maxHour || !maxHour.h) return { skipped: 'no_data' };
    const lastHour = maxHour.h;

    // 1) Почасовая аномалия по модемам за последний полный час.
    const hourRows = db.prepare(`
      SELECT server_name, nick, operator, SUM(bytes_in + bytes_out) AS b
      FROM traffic_hourly
      WHERE hour_start = ?
      GROUP BY server_name, nick
    `).all(lastHour);

    let hourlyAlerts = 0, paceAlerts = 0, forecastAlerts = 0;
    for (const r of hourRows) {
      const pkg = _findPkg(pkgs, r.operator);
      if (!pkg) continue;
      const thrGb = _hourlyThresholdGb(pkg);
      const gb = (r.b || 0) / GB;
      if (gb <= thrGb) continue;
      const pct = (pkg.type === 'per_sim' && Number(pkg.volume_gb) > 0)
        ? Math.round(gb / Number(pkg.volume_gb) * 100) : null;
      if (alerts.trigger('volume_modem_hourly', {
        server: r.server_name, nick: r.nick, operator: r.operator,
        gb: Math.round(gb * 10) / 10, threshold_gb: thrGb,
        pct_of_package: pct, hour: lastHour,
      })) hourlyAlerts++;
    }

    // 2) Темп расхода пакета.
    const todayUtc = new Date().toISOString().slice(0, 10);          // 'YYYY-MM-DD'

    // per_sim: суточное потребление модема против доли его пакета.
    const todayRows = db.prepare(`
      SELECT server_name, nick, operator, SUM(bytes_in + bytes_out) AS b
      FROM traffic_hourly
      WHERE hour_start >= ?
      GROUP BY server_name, nick
    `).all(todayUtc + ' 00:00');
    for (const r of todayRows) {
      const pkg = _findPkg(pkgs, r.operator);
      if (!pkg || pkg.type !== 'per_sim' || !(Number(pkg.volume_gb) > 0) || !(Number(pkg.pace_pct) > 0)) continue;
      const limitGb = Number(pkg.volume_gb) * Number(pkg.pace_pct) / 100;
      const gb = (r.b || 0) / GB;
      if (gb <= limitGb) continue;
      if (alerts.trigger('volume_package_pace', {
        scope: 'sim', server: r.server_name, nick: r.nick, operator: r.operator,
        gb_day: Math.round(gb * 10) / 10, package_gb: Number(pkg.volume_gb),
        pace_pct: Number(pkg.pace_pct),
      })) paceAlerts++;
    }

    // shared: среднесуточный расход за текущий биллинговый период оператора
    // (от дня обновления тарифа, а не от 1-го числа) против темпа котла.
    for (const pkg of pkgs) {
      if (pkg.type !== 'shared' || !(Number(pkg.volume_gb) > 0) || !(Number(pkg.pace_pct) > 0)) continue;
      const { start } = packagePeriod(pkg);
      const periodStart = start.toISOString().slice(0, 10) + ' 00:00';
      const elapsedDays = Math.max(1, Math.floor((Date.now() - start.getTime()) / 86400e3) + 1);
      const row = db.prepare(`
        SELECT SUM(bytes_in + bytes_out) AS b, COUNT(DISTINCT nick) AS modems
        FROM traffic_hourly
        WHERE hour_start >= ? AND LOWER(operator) LIKE ?
      `).get(periodStart, String(pkg.operator).toLowerCase().trim() + '%');
      const usedGb = ((row && row.b) || 0) / GB;
      const dailyGb = usedGb / elapsedDays;
      const simCount = Number((row && row.modems) || 0);
      const maxSims = Math.max(0, Math.floor(Number(pkg.max_sims) || 0));
      const bundleCount = maxSims > 0 ? (simCount > 0 ? Math.ceil(simCount / maxSims) : 0) : 1;
      const totalPackageGb = Number(pkg.volume_gb) * bundleCount;
      const limitGb = totalPackageGb * Number(pkg.pace_pct) / 100;
      if (dailyGb <= limitGb) continue;
      const daysLeft = dailyGb > 0 ? Math.max(0, Math.round((totalPackageGb - usedGb) / dailyGb)) : null;
      if (alerts.trigger('volume_package_pace', {
        scope: 'package', operator: pkg.operator,
        gb_day: Math.round(dailyGb * 10) / 10, package_gb: totalPackageGb,
        volume_gb_per_bundle: Number(pkg.volume_gb), bundle_count: bundleCount, max_sims: maxSims,
        used_gb: Math.round(usedGb), days_left: daysLeft,
        modems: simCount, pace_pct: Number(pkg.pace_pct),
      })) paceAlerts++;
    }

    // 3) Явный прогноз исчерпания — независимо от ручного pace_pct.
    // Пер-SIM пакеты прогнозируются для каждой SIM, shared — одним котлом.
    const forecasts = buildForecasts(db, pkgs, new Date());
    const warnDays = Math.max(1, Number(getSetting('package_forecast_warn_days', 7)) || 7);
    for (const f of forecasts) {
      if (f.days_left == null || f.days_left > warnDays) continue;
      if (alerts.trigger('volume_package_exhaustion', f)) forecastAlerts++;
    }

    if (hourlyAlerts || paceAlerts || forecastAlerts) {
      logger.info(`[VolumeGuard] hour=${lastHour}: ${hourlyAlerts} hourly, ${paceAlerts} pace, ${forecastAlerts} forecast alerts`);
    }
    return { hour: lastHour, hourlyAlerts, paceAlerts, forecastAlerts, forecasts };
  }

  return { runOnce, _packages, _findPkg };
}

module.exports = { create, findPackage, buildForecasts, buildPackageEfficiency, packagePeriod, renewalDayOf };
