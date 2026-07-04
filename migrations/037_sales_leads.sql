-- 037_sales_leads.sql
-- Self-expanding lead-gen engine (staging). A human adds a SEED company (e.g.
-- one that approached us / an existing customer); the researcher agent
-- profiles it, infers its NICHE (a segment of look-alike proxy buyers), and
-- finds more COMPANIES in that niche; the bizdev agent finds decision-maker
-- CONTACTS (name / role / LinkedIn). Everything is staged here for human
-- review, then pushed to Twenty CRM. Known niches are re-scanned periodically.
-- Nothing is sent anywhere — the salesperson (a human) reaches out manually.

CREATE TABLE IF NOT EXISTS sales_niches (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now')),
  name            TEXT NOT NULL DEFAULT '',      -- inferred segment, e.g. "e-comm price monitoring"
  description     TEXT NOT NULL DEFAULT '',      -- what such companies do
  why_proxies     TEXT NOT NULL DEFAULT '',      -- why this niche needs proxies
  seed_company    TEXT NOT NULL DEFAULT '',      -- the company that revealed this niche
  last_scanned_at TEXT,                          -- last look-alike scan
  status          TEXT NOT NULL DEFAULT 'active' -- active|paused
);
CREATE INDEX IF NOT EXISTS idx_sales_niches_name ON sales_niches(name);

CREATE TABLE IF NOT EXISTS sales_companies (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now')),
  niche_id        INTEGER,                        -- FK sales_niches.id
  niche_name      TEXT NOT NULL DEFAULT '',       -- denormalized for convenience
  company         TEXT NOT NULL DEFAULT '',
  website         TEXT NOT NULL DEFAULT '',
  domain          TEXT NOT NULL DEFAULT '',       -- normalized host, for dedup
  country         TEXT NOT NULL DEFAULT '',
  why_fit         TEXT NOT NULL DEFAULT '',       -- why they likely need proxies
  fit_score       INTEGER NOT NULL DEFAULT 0,     -- 0..100
  source_url      TEXT NOT NULL DEFAULT '',
  is_seed         INTEGER NOT NULL DEFAULT 0,     -- 1 = manually added seed
  status          TEXT NOT NULL DEFAULT 'draft',  -- draft|approved|rejected|pushed
  crm_company_id  TEXT NOT NULL DEFAULT '',       -- Twenty company id after push
  run_id          TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sales_companies_niche  ON sales_companies(niche_id);
CREATE INDEX IF NOT EXISTS idx_sales_companies_domain ON sales_companies(domain);
CREATE INDEX IF NOT EXISTS idx_sales_companies_status ON sales_companies(status);

CREATE TABLE IF NOT EXISTS sales_contacts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now')),
  company_id      INTEGER,                        -- FK sales_companies.id
  company         TEXT NOT NULL DEFAULT '',       -- denormalized
  name            TEXT NOT NULL DEFAULT '',
  role            TEXT NOT NULL DEFAULT '',       -- CEO / Founder / CMO / Head of Growth ...
  linkedin        TEXT NOT NULL DEFAULT '',
  contact         TEXT NOT NULL DEFAULT '',       -- general email / form / tg if found
  source_url      TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'draft',  -- draft|approved|rejected|pushed
  crm_person_id   TEXT NOT NULL DEFAULT '',       -- Twenty person id after push
  run_id          TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sales_contacts_company ON sales_contacts(company_id);
CREATE INDEX IF NOT EXISTS idx_sales_contacts_status  ON sales_contacts(status);
