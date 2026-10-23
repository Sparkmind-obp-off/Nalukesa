# NALUKESA MCP — Security Model

## Trust boundaries
| Boundary | Credential | Where it lives |
|---|---|---|
| Owner → web app | password → HMAC session cookie | `OWNER_PASSWORD`, `SESSION_SECRET` (Cloudflare secrets) |
| MCP client → `/mcp` | `nkmcp_…` bearer token | client config; server stores a SHA-256 hash only |
| NALUKESA → provider | provider API key/token | Cloudflare secret named in the provider definition |

These credentials are independent of each other:
- The session cookie is **not** accepted on `/mcp`.
- The owner password is **not** accepted as a bearer token. Both cases are tested.

## Inbound controls
- **Authentication on every request.** Tokens are verified against a hash and must not be revoked or expired. The server fails closed: with no token, or no tokens in the database, every request gets 401 plus `WWW-Authenticate: Bearer`.
- **Scopes:** `products:read`, `evidence:read`, `performance:read`, `providers:read`. Each tool checks its scope at call time.
- **Expiry:** 1–365 days, default 90 via the API and 30 via the UI. Tokens can be revoked instantly.
- **Rate limiting:** 60 requests/min per token, fixed window in D1; the limit returns 429 with `Retry-After`. The window counter is not atomic across edge locations, so this is a best-effort limit.
- **Origin check:** a browser `Origin` header that differs from the site origin gets 403 (DNS-rebinding/CSRF defence).
- **Limits:** request body ≤ 64 KB. JSON parse errors get a JSON-RPC `-32700` response.
- **Validation:** strict zod schemas per tool, including enums, integer bounds, date format, and array sizes.
- **No dangerous tools:** no SQL, filesystem, shell, URL fetch, proxy, or write tools. Domain services use parameterized SQL only.
- **Audit:** every tool call writes `audit_events` with actor `mcp:<token_id>` and the tool name, never token values.
- **Token issuance:** owner session only. The token is shown once and is not recoverable.
- **Kill switch:** setting `MCP_ENABLED=false` makes the endpoint return 503.

## Outbound controls (SSRF and secrets)
- `https` only, default port only, exact-host allowlist.
- The following are rejected:
  - IP literals (v4, v6, decimal, hex);
  - `localhost`, `.local`, `.internal`, and similar internal names;
  - credentials embedded in the URL.
- Redirects are never followed (`redirect: 'manual'`, and a 3xx response is treated as `blocked`).
- Timeout, response-size cap, at most one retry.
- Tool calls require a per-provider tool allowlist.
- Credentials are injected server-side only. Errors pass through `redact()`, which removes known secret values, `Bearer …`, `nkmcp_…`, and `token=/key=/password=` patterns.
- The hub is read-only by design: there is no publish, post, purchase, or message capability.

## Known limitations
- **OAuth 2.1 is not implemented.** Static bearer tokens work with clients that accept a custom `Authorization` header (SDK clients, Cursor, `mcp-remote`, Claude Desktop via `mcp-remote`). Clients that *require* the OAuth flow (for example claude.ai remote connectors) cannot connect yet. We do not claim OAuth support.
- The rate limit is best-effort (see above).
- Single-owner workspace. There is no tenant isolation because there is only one tenant.
- The DNS-rebinding check relies on the `Origin` header. Non-browser clients are authenticated by token only.
