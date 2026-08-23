'use strict';
//
// src/sla.js — C1 (ТЗ мониторинга v2, этап 4, 23.08): SLA/uptime-отчёт
// за месяц. Чистые функции поверх db (better-sqlite3) — покрыты тестами.
//
//   Серверы: server_downtime (эпизоды, пересекающие месяц, клиппятся на его
//     границы; maintenance=1 исключаются из простоя — B3).
//   Модемы: доля online/total в минутных uptime_daily за месяц.
//   Операторы: средний uptime модемов оператора (оператор — из modem_meta).
//
// Клиенты: те же минутные счётчики, сегментированные по владельцу модема.

const uptimePeriod = require('./uptime-period');

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

// Модемы: доля online среди всех периодических проверок за месяц.
function modemUptime(db, month) {
  const b = monthBounds(month);
  return uptimePeriod.modemRows(db, b.fromIso.slice(0, 10), b.toIso.slice(0, 10))
    .map(uptimePeriod.mapRow);
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

// Client-scoped SLA. New checks are attributed at collection time through
// client_uptime_daily. Historical days are attributed by traffic_hourly, while
// their online/total counters still come from the canonical uptime_daily.
function _clientUptimeRange(db, fromIso, toIso, clientName, groupByDay) {
  return uptimePeriod.clientRows(
    db,
    String(fromIso).slice(0, 10),
    String(toIso).slice(0, 10),
    clientName,
    groupByDay
  );
}

function _mapClientRow(r) {
  return uptimePeriod.mapRow(r);
}

function clientUptime(db, month, clientName) {
  const b = monthBounds(month);
  return _clientUptimeRange(db, b.fromIso, b.toIso, clientName, false).map(_mapClientRow);
}

// Валидация day ('YYYY-MM-DD' внутри month). Возвращает null либо границы дня.
function _dayBounds(month, day) {
  if (day == null || day === '') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day));
  if (!m || String(day).slice(0, 7) !== month) {
    throw new Error('day: ожидается YYYY-MM-DD внутри выбранного месяца');
  }
  const fromMs = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const d = new Date(fromMs);
  if (d.toISOString().slice(0, 10) !== day) throw new Error('day: некорректная дата');
  return { fromIso: d.toISOString(), toIso: new Date(fromMs + 86400000).toISOString() };
}

function buildClientReport(db, month, clientName, day) {
  const b = monthBounds(month); // validate even when the client has no assignments
  const dayB = _dayBounds(month, day);
  const period = dayB || b;
  const modems = _clientUptimeRange(db, period.fromIso, period.toIso, clientName, false).map(_mapClientRow);
  const checks = modems.reduce((sum, m) => sum + m.checks, 0);
  const onlineChecks = modems.reduce((sum, m) => sum + m.online_checks, 0);

  // Per-day breakdown за весь месяц (та же методология) — питает выбор дня в UI.
  // Сворачиваем помодемные дневные строки в один ряд на день.
  const byDay = {};
  for (const r of _clientUptimeRange(db, b.fromIso, b.toIso, clientName, true)) {
    const d = byDay[r.day] || (byDay[r.day] = { day: r.day, checks: 0, online_checks: 0 });
    d.checks += Number(r.checks) || 0;
    d.online_checks += Number(r.online_checks) || 0;
  }
  const days = Object.values(byDay)
    .sort((a, c) => a.day.localeCompare(c.day))
    .map(d => ({
      day: d.day,
      checks: d.checks,
      online_checks: d.online_checks,
      failed_checks: Math.max(0, d.checks - d.online_checks),
      uptime_pct: d.checks ? _pct(d.online_checks / d.checks) : null,
    }));

  return {
    month,
    period: { month, day: dayB ? String(day) : null },
    generated_at: new Date().toISOString(),
    methodology: 'periodic_modem_availability_during_client_assignment',
    summary: {
      uptime_pct: checks ? _pct(onlineChecks / checks) : null,
      modems: modems.length,
      checks,
      online_checks: onlineChecks,
      failed_checks: Math.max(0, checks - onlineChecks),
    },
    days,
    modems,
  };
}

// CSV с BOM (Excel RU открывает UTF-8 корректно) и разделителем ';'.
function toCsv(report) {
  const cell = v => String(v == null ? '' : v).replace(/;/g, ',');
  const lines = ['type;target;operator;uptime_pct;episodes;downtime_min;checks'];
  for (const s of report.servers) {
    lines.push(['server', s.server, '', s.uptime_pct, s.episodes, s.downtime_min, ''].map(cell).join(';'));
  }
  for (const m of report.modems) {
    lines.push(['modem', m.server + '/' + m.nick, m.operator, m.uptime_pct, '', '', m.checks].map(cell).join(';'));
  }
  for (const o of report.operators) {
    lines.push(['operator', o.operator, '', o.uptime_pct, '', '', o.modems].map(cell).join(';'));
  }
  // BOM — чтобы Excel открывал UTF-8 корректно.
  return '﻿' + lines.join('\n') + '\n';
}

module.exports = { monthBounds, serverUptime, modemUptime, operatorUptime, buildReport, clientUptime, buildClientReport, toCsv };
