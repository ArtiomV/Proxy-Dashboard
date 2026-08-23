'use strict';
//
// src/sla.js — C1 (ТЗ мониторинга v2, этап 4, 23.08): SLA/uptime-отчёт
// за месяц. Чистые функции поверх db (better-sqlite3) — покрыты тестами.
//
//   Серверы: server_downtime (эпизоды, пересекающие месяц, клиппятся на его
//     границы; maintenance=1 исключаются из простоя — B3).
//   Модемы: доля ok=1 в modem_ping за месяц (ping-based «up», A1).
//   Операторы: средний uptime модемов оператора (оператор — из modem_meta).
//
// Все метки времени в источниках — ISO UTC, сравнение лексикографическое.

function monthBounds(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
  if (!m) throw new Error('month: ожидается YYYY-MM');
  const y = +m[1], mo = +m[2];
  if (mo < 1 || mo > 12) throw new Error('month: ожидается YYYY-MM');
  const fromMs = Date.UTC(y, mo - 1, 1);
  const toMs = mo === 12 ? Date.UTC(y + 1, 0, 1) : Date.UTC(y, mo, 1);
  return {
    fromMs, toMs,
    fromIso: new Date(fromMs).toISOString(),
    toIso: new Date(toMs).toISOString(),
    minutes: Math.round((toMs - fromMs) / 60000),
  };
}

function _pct(x) { return Math.round(x * 10000) / 100; }

// Серверы: uptime % = (минуты месяца − минуты простоя) / минуты месяца.
// Эпизод считается, если пересекает месяц; вклад клиппится на границы.
// maintenance=1 (B3) исключён из простоя и из числа эпизодов, но виден
// отдельными колонками (maintenance_episodes / maintenance_min).
function serverUptime(db, month) {
  const b = monthBounds(month);
  let rows;
  try {
    rows = db.prepare(`
      SELECT server_name, down_from, down_to, maintenance
        FROM server_downtime
       WHERE down_from < ? AND down_to > ?
    `).all(b.toIso, b.fromIso);
  } catch (_) { rows = []; }   // таблицы нет (старая БД) → простоев не было
  const byServer = {};
  for (const r of rows) {
    const s = byServer[r.server_name] || (byServer[r.server_name] = {
      server: r.server_name, episodes: 0, downtime_sec: 0,
      maintenance_episodes: 0, maintenance_sec: 0,
    });
    const from = Math.max(Date.parse(r.down_from) || 0, b.fromMs);
    const to = Math.min(Date.parse(r.down_to) || 0, b.toMs);
    const sec = Math.max(0, Math.round((to - from) / 1000));
    if (r.maintenance) {
      s.maintenance_episodes++;
      s.maintenance_sec += sec;
      continue;
    }
    s.episodes++;
    s.downtime_sec += sec;
  }
  return Object.values(byServer).map(s => ({
    server: s.server,
    episodes: s.episodes,
    downtime_min: Math.round(s.downtime_sec / 60 * 10) / 10,
    maintenance_episodes: s.maintenance_episodes,
    maintenance_min: Math.round(s.maintenance_sec / 60 * 10) / 10,
    uptime_pct: _pct(1 - s.downtime_sec / (b.minutes * 60)),
  })).sort((a, c) => a.server.localeCompare(c.server));
}

// Модемы: доля ok=1 среди пингов за месяц по (server, nick).
function modemUptime(db, month) {
  const b = monthBounds(month);
  let rows;
  try {
    rows = db.prepare(`
      SELECT mp.server, mp.nick,
             COUNT(*) AS pings,
             SUM(mp.ok) AS ok_pings,
             mm.operator AS operator
        FROM modem_ping mp
        LEFT JOIN (
          SELECT server_name, nick, MAX(NULLIF(TRIM(operator), '')) AS operator
            FROM modem_meta
           GROUP BY server_name, nick
        ) mm ON mm.server_name = mp.server AND mm.nick = mp.nick
       WHERE mp.ts >= ? AND mp.ts < ?
       GROUP BY mp.server, mp.nick
       ORDER BY mp.server, mp.nick
    `).all(b.fromIso, b.toIso);
  } catch (_) { rows = []; }
  return rows.map(r => ({
    server: r.server,
    nick: r.nick,
    operator: r.operator || '',
    pings: r.pings,
    ok_pings: r.ok_pings || 0,
    uptime_pct: r.pings ? _pct((r.ok_pings || 0) / r.pings) : null,
  }));
}

// Операторы: средний uptime их модемов (модемы без оператора не участвуют).
function operatorUptime(modems) {
  const byOp = {};
  for (const m of modems) {
    if (!m.operator || m.uptime_pct == null) continue;
    const o = byOp[m.operator] || (byOp[m.operator] = { operator: m.operator, modems: 0, _sum: 0 });
    o.modems++;
    o._sum += m.uptime_pct;
  }
  return Object.values(byOp)
    // _sum уже в процентах (uptime_pct модемов) — усредняем без _pct (она ждёт долю 0..1)
    .map(o => ({ operator: o.operator, modems: o.modems, uptime_pct: Math.round(o._sum / o.modems * 100) / 100 }))
    .sort((a, b) => a.operator.localeCompare(b.operator));
}

function buildReport(db, month) {
  const b = monthBounds(month);
  const servers = serverUptime(db, month);
  const modems = modemUptime(db, month);
  const operators = operatorUptime(modems);
  return {
    month,
    minutes_in_month: b.minutes,
    generated_at: new Date().toISOString(),
    servers, modems, operators,
  };
}

// CSV с BOM (Excel RU открывает UTF-8 корректно) и разделителем ';'.
function toCsv(report) {
  const cell = v => String(v == null ? '' : v).replace(/;/g, ',');
  const lines = ['type;target;operator;uptime_pct;episodes;downtime_min;pings'];
  for (const s of report.servers) {
    lines.push(['server', s.server, '', s.uptime_pct, s.episodes, s.downtime_min, ''].map(cell).join(';'));
  }
  for (const m of report.modems) {
    lines.push(['modem', m.server + '/' + m.nick, m.operator, m.uptime_pct, '', '', m.pings].map(cell).join(';'));
  }
  for (const o of report.operators) {
    lines.push(['operator', o.operator, '', o.uptime_pct, '', '', o.modems].map(cell).join(';'));
  }
  // BOM — чтобы Excel открывал UTF-8 корректно.
  return '﻿' + lines.join('\n') + '\n';
}

module.exports = { monthBounds, serverUptime, modemUptime, operatorUptime, buildReport, toCsv };
