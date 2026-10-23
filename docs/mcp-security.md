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
- **Inbound OAuth 2.1 (NALUKESA as an authorization server) is not implemented.** Static bearer tokens work with clients that accept a custom `Authorization` header (SDK clients, Cursor, `mcp-remote`, Claude Desktop via `mcp-remote`). Clients that *require* the OAuth flow (for example claude.ai remote connectors) cannot connect yet. We do not claim OAuth support.
- The rate limit is best-effort (see above).
- Single-owner workspace. There is no tenant isolation because there is only one tenant.
- The DNS-rebinding check relies on the `Origin` header. Non-browser clients are authenticated by token only.

## Generic external connector
- **Endpoint validation at registration and on every request:**
  - `https:` only, port 443, no userinfo;
  - no IP literals (v4, v6, decimal, hex);
  - no `localhost` / `.local` / `.internal` / `.lan` / `metadata*` / single-label hosts;
  - never NALUKESA's own hosts (`nalukesa.biz.id`, `*.nalukesa.pages.dev`, or the current request host).
- **DNS validation:**
  - before the first request to each host, every A and AAAA record (resolved via DNS-over-HTTPS) must be a public unicast address;
  - private, loopback, link-local, CGNAT, multicast, documentation, NAT64, 6to4 and IPv4-mapped private addresses are blocked;
  - a mixed answer (one public record, one private) is rejected.
  - **Limitation:** Workers cannot pin the TCP connection to the validated IP. Cloudflare's egress does not route to RFC 1918 space anyway. The DNS check narrows the rebinding window but does not close it entirely.
- **Per-connection host allowlist:** the endpoint host plus OAuth hosts discovered and validated during authorization.
- **Redirects:** never followed (`redirect: 'manual'`). Any 3xx is treated as `blocked`.
- **Limits:**
  - the deadline covers both headers and the **whole body read**, so a slow body triggers the timeout;
  - the byte cap is enforced while streaming, so chunked bodies without `Content-Length` are bounded as well as declared ones;
  - an overall ceiling of 3× the timeout applies per operation;
  - arguments ≤ 32 KB; at most 200 tools per catalog.
- **Credentials:**
  - AES-256-GCM, with AAD binding each ciphertext to its connection id;
  - key in the Cloudflare secret `CONNECTOR_ENC_KEY`;
  - never returned to the browser (`has_credential` / `auth_hint` only), never logged, and redacted from errors and from tool results that reflect them.
- **Authorization:**
  - owner session on all management and invoke routes;
  - unknown fields rejected;
  - per-tool permission checked at call time;
  - write/destructive tools need explicit `confirm_risk`;
  - approvals revoked automatically on catalog change or endpoint change.
- **Untrusted output:** tool results are data. They are never executed, never used to call other tools automatically, and never used to change NALUKESA records. UI and bridge responses carry an explicit untrusted label.
- **Throttling:** per-connection calls/minute (D1 fixed window, best-effort) plus the remote server's own 429 responses, which are surfaced as `rate_limited`.
- **Audit:**
  - `mcp_invocations` records status, latency, argument *keys* (not values), sizes, a truncated redacted result preview, and a redacted error;
  - `audit_events` records create, update, test, permission, OAuth and delete events.
- **Local testing only:** `CONNECTOR_ALLOW_LOCAL=true` is honoured only together with `APP_ENV=development`. It is never set in production.

## Outbound OAuth gateway (v0.5.0)
- **Discovery hardening:** protected-resource metadata `resource` must match the endpoint; AS metadata `issuer` must match; `S256` must be supported; authorize/token/registration/revocation URLs and the AS URL are each validated by the SSRF guard (https:443, public DNS, not NALUKESA hosts).
- **State:** 32 random bytes; only its SHA-256 is stored, bound to the connection and to a hash of the owner session cookie, expires after 10 minutes, consumed atomically (`UPDATE … RETURNING`). Replays, other sessions and expired states are rejected.
- **Callback:** RFC 9207 `iss` must match when present; provider errors are shown without echoing codes; `code=` values are redacted from logs and audit; response sent with `Referrer-Policy: no-referrer` and `Cache-Control: no-store`.
- **Secrets at rest:** access/refresh tokens, pre-registered client secret and DCR client information are AES-256-GCM sealed with purpose-bound AAD. The API exposes only `has_credential` / `has_client_secret`.
- **Refresh:** rotated refresh tokens replace the old ones; failure sets the connection to *auth required* and writes an audit event; no token values are logged.
- **Token confinement:** the `Authorization` header is injected only to the connection's endpoint host and stripped for any other host (including AS endpoints during MCP traffic).
- **Changing the endpoint, auth type or OAuth client** erases stored tokens.
