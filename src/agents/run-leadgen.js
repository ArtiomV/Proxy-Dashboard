'use strict';

/**
 * CLI оркестратор self-expanding lead-engine.
 *
 *   node src/agents/run-leadgen.js seed "Prisync" 6      # профиль seed → ниша → компании → контакты
 *   node src/agents/run-leadgen.js refresh               # добрать новые компании по всем активным нишам
 *   node src/agents/run-leadgen.js refresh "мониторинг цен" 6
 *   node src/agents/run-leadgen.js list                  # показать стейджинг
 *
 * Ступень 1 (researcher): seed → ниша → look-alike компании.
 * Ступень 2 (bizdev): по каждой найденной компании → контакты ЛПР.
 * Всё пишется в стейджинг SQLite (sales_niches/companies/contacts, status=draft).
 * Ничего не отправляется; пуш в Twenty CRM — следующий шаг.
 *
 * Ключи: ANTHROPIC_API_KEY (.env или kv_store app_settings) + TAVILY_API_KEY (.env).
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { profileSeed, refreshNiche } = require('./researcher');
const { findContacts } = require('./bizdev');

const ROOT = path.join(__dirname, '..', '..');

function resolveKey(db) {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    const row = db.prepare(`SELECT value FROM kv_store WHERE key='app_settings'`).get();
    const s = row ? JSON.parse(row.value) : {};
    return s.anthropic_api_key || '';
  } catch { return ''; }
}

function openDb() {
  const p = process.env.DASHBOARD_DB_PATH || path.join(ROOT, 'dashboard.db');
  const db = new Database(p);
  db.pragma('journal_mode = WAL');
  db.exec(fs.readFileSync(path.join(ROOT, 'migrations', '037_sales_leads.sql'), 'utf8'));
  return db;
}

// Ступень 2: по всем не-seed компаниям прогона найти контакты ЛПР.
async function enrichContacts(db, runId) {
  const companies = db.prepare(
    `SELECT id, company, website FROM sales_companies WHERE run_id = ? AND is_seed = 0 ORDER BY id`
  ).all(runId);
  let total = 0;
  for (const c of companies) {
    console.log(`   → контакты: ${c.company}`);
    const r = await findContacts({ db, company: c.company, website: c.website, runId: `ct-${runId}-${c.id}` });
    total += r.found;
  }
  return total;
}

function printCompaniesOfRun(db, runId) {
  const comps = db.prepare(
    `SELECT * FROM sales_companies WHERE run_id = ? ORDER BY is_seed DESC, fit_score DESC`
  ).all(runId);
  console.log('\n🏢 Компании (стейджинг, status=draft):');
  for (const c of comps) {
    console.log(`  [#${c.id}] (${c.fit_score}) ${c.company}${c.website ? ' · ' + c.website : ''}${c.is_seed ? ' · SEED' : ''}`);
    if (c.why_fit) console.log(`        почему: ${c.why_fit}`);
    const ks = db.prepare(`SELECT * FROM sales_contacts WHERE company_id = ? ORDER BY id`).all(c.id);
    for (const k of ks) {
      console.log(`        👤 ${k.name} — ${k.role}${k.linkedin ? ' · ' + k.linkedin : ''}${k.contact ? ' · ' + k.contact : ''}`);
    }
  }
}

async function main() {
  const mode = process.argv[2];
  const db = openDb();

  if (mode === 'list') {
    const niches = db.prepare(
      `SELECT n.*, (SELECT COUNT(*) FROM sales_companies c WHERE c.niche_id = n.id) AS comps FROM sales_niches n ORDER BY n.id`
    ).all();
    console.log('\n📚 Ниши:');
    niches.forEach(n => console.log(`  [${n.id}] ${n.name} · компаний: ${n.comps} · seed: ${n.seed_company}${n.last_scanned_at ? ' · скан: ' + n.last_scanned_at : ''}`));
    const comps = db.prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM sales_contacts k WHERE k.company_id = c.id) AS cnt FROM sales_companies c ORDER BY c.id`
    ).all();
    console.log('\n🏢 Компании:');
    comps.forEach(c => console.log(`  [${c.id}] (${c.fit_score}) ${c.company}${c.website ? ' · ' + c.website : ''} · контактов: ${c.cnt}${c.is_seed ? ' · SEED' : ''}`));
    const contacts = db.prepare(`SELECT * FROM sales_contacts ORDER BY company_id, id`).all();
    console.log('\n👤 Контакты:');
    contacts.forEach(k => console.log(`  ${k.company} — ${k.name} (${k.role})${k.linkedin ? ' · ' + k.linkedin : ''}${k.contact ? ' · ' + k.contact : ''}`));
    db.close();
    return;
  }

  // Modes that need the LLM: seed / refresh.
  const key = resolveKey(db);
  if (!key) {
    console.error('❌ ANTHROPIC_API_KEY не найден (.env или kv_store app_settings).');
    console.error('   Добавь в project/.env:  ANTHROPIC_API_KEY=sk-ant-...');
    process.exit(1);
  }
  process.env.ANTHROPIC_API_KEY = key;
  if (!process.env.TAVILY_API_KEY) {
    console.error('❌ TAVILY_API_KEY не найден в .env.');
    process.exit(1);
  }

  if (mode === 'seed') {
    const seed = process.argv[3];
    const count = Math.max(1, Math.min(15, parseInt(process.argv[4], 10) || 6));
    if (!seed) { console.error('Использование: run-leadgen.js seed "<компания>" [кол-во]'); process.exit(1); }
    console.log(`\n🌱 SEED: «${seed}» · искать ${count} похожих компаний + контакты\n`);
    const t0 = Date.now();
    const r = await profileSeed({ db, seed, count, logger: console });
    console.log(`\n🔎 Ниша: ${r.niche || '(не определена)'} · компаний найдено: ${r.companies}`);
    console.log('   Ищу контакты ЛПР по найденным компаниям...');
    const contacts = await enrichContacts(db, r.runId);
    console.log(`\n✅ Готово за ${((Date.now() - t0) / 1000).toFixed(0)}s · компаний: ${r.companies} · контактов: ${contacts}`);
    printCompaniesOfRun(db, r.runId);
    console.log('\nДальше: вычитать стейджинг → пуш в Twenty CRM (следующий шаг). Продавец (ты) пишет по контактам вручную.');
  } else if (mode === 'refresh') {
    const nicheArg = process.argv[3];
    const count = Math.max(1, Math.min(15, parseInt(process.argv[4], 10) || 6));
    const niches = nicheArg
      ? db.prepare(`SELECT * FROM sales_niches WHERE lower(name) = lower(?) AND status = 'active'`).all(nicheArg)
      : db.prepare(`SELECT * FROM sales_niches WHERE status = 'active'`).all();
    if (!niches.length) { console.error('Нет активных ниш. Сначала запусти seed.'); process.exit(1); }
    for (const n of niches) {
      console.log(`\n🔁 Обновляю нишу: «${n.name}»`);
      const r = await refreshNiche({ db, niche: n, count, logger: console });
      const contacts = await enrichContacts(db, r.runId);
      console.log(`   +${r.companies} компаний, +${contacts} контактов`);
      printCompaniesOfRun(db, r.runId);
      db.prepare(`UPDATE sales_niches SET last_scanned_at = strftime('%Y-%m-%d %H:%M:%S','now') WHERE id = ?`).run(n.id);
    }
  } else {
    console.log('Режимы:');
    console.log('  seed "<компания>" [кол-во]    — профиль seed → ниша → компании → контакты');
    console.log('  refresh ["<ниша>"] [кол-во]   — добрать новые компании по известным нишам');
    console.log('  list                           — показать стейджинг');
  }
  db.close();
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
