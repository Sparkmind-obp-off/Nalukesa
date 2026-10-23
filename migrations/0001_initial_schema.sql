-- NALUKESA initial schema
-- Rule: unknown metrics are NULL, never defaulted to 0.
-- Money stored as INTEGER IDR. Percent stored as REAL (0-100).
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS niches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Hypothesis',
  audience TEXT,
  problem TEXT,
  hypothesis TEXT,
  confidence TEXT NOT NULL DEFAULT 'Unrated',
  next_review_date TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_niches_status ON niches(status);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  niche_id INTEGER NOT NULL REFERENCES niches(id) ON DELETE RESTRICT,
  platform TEXT NOT NULL,
  listing_url TEXT NOT NULL,
  seller TEXT,
  status TEXT NOT NULL DEFAULT 'Researching',
  checked_at TEXT,
  trust_notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_products_niche ON products(niche_id);
CREATE INDEX IF NOT EXISTS idx_products_url ON products(listing_url);

-- Append-only: price/commission history is never overwritten.
CREATE TABLE IF NOT EXISTS offer_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  checked_at TEXT NOT NULL,
  price_idr INTEGER,
  advertised_commission_pct REAL,
  commission_basis TEXT,
  terms_url TEXT,
  recheck_by TEXT,
  source_note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_offers_product ON offer_snapshots(product_id, checked_at);

CREATE TABLE IF NOT EXISTS evidence_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  source_type TEXT NOT NULL,
  url TEXT,
  publisher TEXT,
  published_at TEXT,
  accessed_at TEXT NOT NULL,
  evidence_grade TEXT NOT NULL CHECK (evidence_grade IN ('A','B','C','D')),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_sources_grade ON evidence_sources(evidence_grade);

CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  observed_fact TEXT NOT NULL,
  source_id INTEGER NOT NULL REFERENCES evidence_sources(id) ON DELETE RESTRICT,
  niche_id INTEGER REFERENCES niches(id) ON DELETE RESTRICT,
  product_id INTEGER REFERENCES products(id) ON DELETE RESTRICT,
  observed_at TEXT NOT NULL,
  interpretation TEXT,
  confidence TEXT NOT NULL DEFAULT 'Unrated',
  caveats TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_obs_source ON observations(source_id);
CREATE INDEX IF NOT EXISTS idx_obs_niche ON observations(niche_id);
CREATE INDEX IF NOT EXISTS idx_obs_product ON observations(product_id);

CREATE TABLE IF NOT EXISTS experiments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  niche_id INTEGER NOT NULL REFERENCES niches(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'Planned',
  hypothesis TEXT NOT NULL,
  scope TEXT,
  start_date TEXT,
  review_date TEXT,
  duration_days INTEGER,
  content_target INTEGER,
  primary_metric TEXT NOT NULL,
  time_cap_hours INTEGER,
  budget_cap_idr INTEGER,
  decision_rule TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_exp_niche ON experiments(niche_id);

CREATE TABLE IF NOT EXISTS content_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  experiment_id INTEGER REFERENCES experiments(id) ON DELETE RESTRICT,
  product_id INTEGER REFERENCES products(id) ON DELETE RESTRICT,
  channel TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Draft',
  creative_angle TEXT,
  proof_point TEXT,
  caveats TEXT,
  cta TEXT,
  disclosure_status TEXT NOT NULL DEFAULT 'Not yet',
  asset_rights TEXT NOT NULL,
  published_url TEXT,
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_content_exp ON content_items(experiment_id);
CREATE INDEX IF NOT EXISTS idx_content_product ON content_items(product_id);

-- Append-only. NULL = not recorded.
CREATE TABLE IF NOT EXISTS performance_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_item_id INTEGER NOT NULL REFERENCES content_items(id) ON DELETE RESTRICT,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  views INTEGER,
  clicks INTEGER,
  orders INTEGER,
  approved_commission_idr INTEGER,
  cancellations_returns INTEGER,
  data_source TEXT NOT NULL,
  attribution_notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_perf_content ON performance_snapshots(content_item_id, period_end);

-- Append-only decision log.
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('Scale candidate','Iterate','Hold','Stop')),
  rationale TEXT NOT NULL,
  evidence_refs TEXT,
  owner TEXT,
  decided_at TEXT NOT NULL,
  next_review_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_decisions_entity ON decisions(entity_type, entity_id);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id INTEGER,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_events(created_at);

-- Login throttling (hashed client key, no raw IP stored).
CREATE TABLE IF NOT EXISTS login_attempts (
  client_key TEXT NOT NULL,
  attempted_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_attempts ON login_attempts(client_key, attempted_at);
