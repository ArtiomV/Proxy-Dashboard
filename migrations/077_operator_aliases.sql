-- Canonical operator names: several raw ProxySmart carrier labels can belong
-- to one real operator. Aliases are managed from Settings → Operators.
CREATE TABLE IF NOT EXISTS operator_alias_map (
  alias TEXT PRIMARY KEY COLLATE NOCASE,
  canonical TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (length(trim(alias)) BETWEEN 1 AND 60),
  CHECK (length(trim(canonical)) BETWEEN 1 AND 60)
);

CREATE INDEX IF NOT EXISTS idx_operator_alias_canonical
  ON operator_alias_map(canonical COLLATE NOCASE);
