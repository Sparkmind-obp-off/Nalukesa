-- NALUKESA MCP dual-stack: inbound MCP access tokens, rate limiting, outbound provider checks.
-- Secrets are NEVER stored here: tokens are stored as SHA-256 hashes only;
-- provider credentials live in Cloudflare secrets.

CREATE TABLE IF NOT EXISTS mcp_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,       -- base64url(SHA-256(token))
  token_prefix TEXT NOT NULL,            -- first chars, for identification only
  scopes TEXT NOT NULL,                  -- space-separated, e.g. "products:read evidence:read"
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  expires_at TEXT,                       -- ISO timestamp; NULL = no expiry (discouraged)
  revoked_at TEXT,
  last_used_at TEXT
);

-- Fixed-window request counter per token (per minute).
CREATE TABLE IF NOT EXISTS mcp_rate (
  token_id INTEGER NOT NULL REFERENCES mcp_tokens(id) ON DELETE CASCADE,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (token_id, window_start)
);

-- Results of explicit, owner-triggered outbound provider checks.
CREATE TABLE IF NOT EXISTS provider_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id TEXT NOT NULL,
  status TEXT NOT NULL,                  -- available | unavailable | rate_limited | auth_failed | invalid_response | blocked
  checked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  latency_ms INTEGER,
  detail TEXT                            -- redacted, short
);
CREATE INDEX IF NOT EXISTS idx_provider_checks ON provider_checks(provider_id, id);
