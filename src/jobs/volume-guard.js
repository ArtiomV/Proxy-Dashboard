'use strict';
// src/jobs/volume-guard.js — A4 (ТЗ мониторинга v2, 23.08): объёмные алерты
// с настраиваемыми пакетами по операторам. Защита пакетов трафика: узнать об
// аномальном потреблении за час, а не постфактум из счёта оператора.
//
// Пакеты — настройка operator_packages (JSON-массив, редактируется в
// Настройки → «Пакеты операторов» без рестарта):
//   [{ operator: 'Orange MD',     type: 'per_sim', volume_gb: 400,
//      hourly_gb: 20,  pace_pct: 10 },
//    { operator: 'Moldtelecom',   type: 'shared',  volume_gb: 30720,
//      hourly_gb: 30,  pace_pct: 5  },
//    { operator: 'Digi',          type: 'unlimited', volume_gb: 0,
//      hourly_gb: 30,  pace_pct: 0  }, ...]
//   per_sim — объём на каждую симку (Orange 400 ГБ);
//   shared  — общий котёл на оператора (Moldtelecom/Moldcell 30 ТБ).
//   unlimited — безлимит: проверяем только аномальный расход за час, без
//               алертов об исчерпании и темпе.
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

// Forecasts are based on current-month average daily usage. This intentionally
// shares the same traffic_hourly source as billing and package alerts.
function buildForecasts(db, pkgs, now = new Date()) {
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) return [];
  const todayUtc = date.toISOString().slice(0, 10);
  const monthUtc = todayUtc.slice(0, 7);
  const elapsedDays = Math.max(1, Number(todayUtc.slice(8, 10)));
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT server_name, nick, operator, SUM(bytes_in + bytes_out) AS b
      FROM traffic_hourly WHERE hour_start >= ?
      GROUP BY server_name, nick, operator
    `).all(monthUtc + '-01 00:00');
  } catch (_) { return []; }

  const out = [];
  for (const pkg of pkgs || []) {
    const type = pkg.type === 'shared' || pkg.type === 'unlimited' ? pkg.type : 'per_sim';
    const matches = rows.filter(r => findPackage([pkg], r.operator));
    if (type === 'unlimited') {
      out.push({ scope: 'package', operator: pkg.operator, type, status: 'unlimited', modems: new Set(matches.map(r => r.server_name + '/' + r.nick)).size });
      continue;
    }
    const limitGb = Number(pkg.volume_gb);
    if (!(limitGb > 0)) {
      out.push({ scope: 'package', operator: pkg.operator, type, status: 'not_configured', modems: matches.length });
      continue;
    }
    const make = (scope, usedGb, extra) => {
      const dailyGb = usedGb / elapsedDays;
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
          server: row.server_name, nick: row.nick, operator_actual: row.operator,
        }));
      }
    } else {
      const usedGb = matches.reduce((sum, row) => sum + (Number(row.b) || 0) / GB, 0);
      out.push(make('package', usedGb, {
        modems: new Set(matches.map(r => r.server_name + '/' + r.nick)).size,
      }));
    }
  }
  return out.sort((a, b) => {
    const ad = a.days_left == null ? Infinity : a.days_left;
    const bd = b.days_left == null ? Infinity : b.days_left;
    return ad - bd;
  });
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
    const monthUtc = todayUtc.slice(0, 7);                           // 'YYYY-MM'
    const dayOfMonth = Number(todayUtc.slice(8, 10));

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

    // shared: среднесуточный расход MTD по оператору против темпа котла.
    for (const pkg of pkgs) {
      if (pkg.type !== 'shared' || !(Number(pkg.volume_gb) > 0) || !(Number(pkg.pace_pct) > 0)) continue;
      const row = db.prepare(`
        SELECT SUM(bytes_in + bytes_out) AS b, COUNT(DISTINCT nick) AS modems
        FROM traffic_hourly
        WHERE hour_start >= ? AND LOWER(operator) LIKE ?
      `).get(monthUtc + '-01 00:00', String(pkg.operator).toLowerCase().trim() + '%');
      const usedGb = ((row && row.b) || 0) / GB;
      const dailyGb = usedGb / Math.max(1, dayOfMonth);
      const limitGb = Number(pkg.volume_gb) * Number(pkg.pace_pct) / 100;
      if (dailyGb <= limitGb) continue;
      const daysLeft = dailyGb > 0 ? Math.max(0, Math.round((Number(pkg.volume_gb) - usedGb) / dailyGb)) : null;
      if (alerts.trigger('volume_package_pace', {
        scope: 'package', operator: pkg.operator,
        gb_day: Math.round(dailyGb * 10) / 10, package_gb: Number(pkg.volume_gb),
        used_gb: Math.round(usedGb), days_left: daysLeft,
        modems: (row && row.modems) || 0, pace_pct: Number(pkg.pace_pct),
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

module.exports = { create, findPackage, buildForecasts };
