-- Generic external MCP connector (outbound). Additive only.
-- Credentials are stored ONLY as AES-256-GCM ciphertext; the key lives in the
-- Cloudflare secret CONNECTOR_ENC_KEY, never in D1 or the repository.

CREATE TABLE IF NOT EXISTS mcp_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  endpoint_url TEXT NOT NULL,
  transport TEXT NOT NULL DEFAULT 'streamable_http' CHECK (transport IN ('streamable_http')),
  auth_type TEXT NOT NULL CHECK (auth_type IN ('none', 'bearer', 'oauth')),
  auth_ciphertext TEXT,                 -- encrypted JSON credential blob
  auth_hint TEXT,                       -- non-secret hint, e.g. "…a1b2"
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  owner TEXT NOT NULL DEFAULT 'owner',
  timeout_ms INTEGER NOT NULL DEFAULT 15000 CHECK (timeout_ms BETWEEN 1000 AND 30000),
  max_response_bytes INTEGER NOT NULL DEFAULT 1048576 CHECK (max_response_bytes BETWEEN 1024 AND 4194304),
  calls_per_minute INTEGER NOT NULL DEFAULT 30 CHECK (calls_per_minute BETWEEN 1 AND 120),
  extra_allowed_hosts TEXT,             -- OAuth hosts discovered for this connection (space separated)
  status TEXT NOT NULL DEFAULT 'untested'
    CHECK (status IN ('untested', 'failed', 'auth_failed', 'auth_required', 'connected', 'verified')),
  server_name TEXT,
  server_version TEXT,
  protocol_version TEXT,
  last_check_at TEXT,
  last_verified_at TEXT,
  tools_refreshed_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_mcp_connections_owner ON mcp_connections(owner);

CREATE TABLE IF NOT EXISTS mcp_connection_tools (
  connection_id INTEGER NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  title TEXT,
  description TEXT,
  input_schema TEXT NOT NULL,
  annotations TEXT,
  schema_hash TEXT NOT NULL,
  risk TEXT NOT NULL CHECK (risk IN ('read', 'write', 'destructive')),
  permission TEXT NOT NULL DEFAULT 'denied' CHECK (permission IN ('allowed', 'denied')),
  present INTEGER NOT NULL DEFAULT 1,
  changed_at TEXT,
  discovered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  last_success_at TEXT,
  last_error_at TEXT,
  PRIMARY KEY (connection_id, name)
);

-- Invocation history is kept even if a connection is removed (no FK on purpose).
CREATE TABLE IF NOT EXISTS mcp_invocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id INTEGER NOT NULL,
  connection_name TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  caller TEXT NOT NULL,
  status TEXT NOT NULL,                 -- success | tool_error | failed | auth_failed | blocked | rate_limited | invalid_arguments | timeout | invalid_response
  latency_ms INTEGER,
  arg_keys TEXT,
  arg_bytes INTEGER,
  result_bytes INTEGER,
  result_preview TEXT,                  -- truncated normalized result (untrusted content)
  error TEXT,                           -- redacted
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_mcp_invocations_conn ON mcp_invocations(connection_id, id);

CREATE TABLE IF NOT EXISTS mcp_oauth_states (
  state_hash TEXT PRIMARY KEY,
  connection_id INTEGER NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,
  context_ciphertext TEXT NOT NULL,     -- encrypted {codeVerifier, redirectUri, asUrl, metadata, clientInformation, resource}
  created_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS connector_rate (
  connection_id INTEGER NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (connection_id, window_start)
);
