-- Universal MCP gateway: OAuth registration strategies (CIMD / DCR / pre-registered),
-- non-secret diagnostics, and owner-session binding of OAuth state. Additive only.

ALTER TABLE mcp_connections ADD COLUMN oauth_mode TEXT NOT NULL DEFAULT 'auto' CHECK (oauth_mode IN ('auto', 'preregistered'));
ALTER TABLE mcp_connections ADD COLUMN oauth_client_id TEXT;            -- public identifier (pre-registered only)
ALTER TABLE mcp_connections ADD COLUMN oauth_token_auth_method TEXT;    -- none | client_secret_basic | client_secret_post
ALTER TABLE mcp_connections ADD COLUMN oauth_scopes TEXT;               -- optional owner override
-- Encrypted JSON: { client_secret?, dcr?: { client_information, redirect_uri, issuer } }
ALTER TABLE mcp_connections ADD COLUMN oauth_client_ciphertext TEXT;
ALTER TABLE mcp_connections ADD COLUMN oauth_strategy TEXT;             -- strategy used for the current credential
ALTER TABLE mcp_connections ADD COLUMN oauth_diagnostics TEXT;          -- last discovery result (non-secret JSON)
ALTER TABLE mcp_connections ADD COLUMN oauth_authorized_at TEXT;
ALTER TABLE mcp_connections ADD COLUMN oauth_token_expires_at TEXT;
ALTER TABLE mcp_connections ADD COLUMN oauth_last_refresh_at TEXT;

ALTER TABLE mcp_oauth_states ADD COLUMN session_hash TEXT;              -- binds state to the owner session that started it
