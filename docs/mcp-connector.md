# NALUKESA — Generic External MCP Connector (outbound)

Status: implemented in v0.4.0 on `main`; universal OAuth gateway added in v0.5.0 (see [universal-mcp-oauth-gateway.md](universal-mcp-oauth-gateway.md)). With this connector NALUKESA can connect to any **standard MCP server over Streamable HTTP**. No provider-specific code is needed.

## Lifecycle
1. **Register** (owner UI → MCP & integrations → *Add connection*):
   - fields: name, endpoint URL, auth type (`none` | `bearer` | `oauth`), timeout, response cap, calls per minute;
   - the endpoint is validated: public `https` on port 443, no IP literals, no internal names, never NALUKESA's own hosts.
2. **Authenticate:**
   - `bearer`: the token is stored AES-256-GCM-encrypted with key `CONNECTOR_ENC_KEY` (a Cloudflare secret).
   - `oauth`: press *Authorize*. NALUKESA then runs:
     1. RFC 9728 protected-resource discovery and RFC 8414 authorization-server metadata;
     2. RFC 7591 dynamic client registration;
     3. PKCE S256 plus a single-use `state` (hashed in the DB, 10-minute TTL, valid only with an owner session);
     4. code exchange, after which tokens are stored encrypted;
     5. automatic refresh 60 s before expiry.
3. **Test & discover:** MCP `initialize` (the SDK negotiates the protocol version), then `tools/list` (paginated, max 200 tools). Server name, version, and protocol are recorded. A successful test only marks the connection `connected`; it does **not** mean invocation works.
4. **Review tools:** each tool shows its name, description, JSON input schema, annotations, and a risk class:
   - `read`: `readOnlyHint: true`.
   - `destructive`: `destructiveHint: true`.
   - `write`: everything else. Per the MCP spec, absent hints are treated as unsafe.
5. **Approve:** every tool starts as **denied**.
   - Approving a `write`/`destructive` tool requires an explicit `confirm_risk` (a confirmation dialog in the UI).
   - A refresh that detects a schema, annotation, or description change **revokes** that tool's approval.
   - New tools are never approved or run automatically.
6. **Invoke** an approved tool:
   - arguments are validated against the discovered input schema (`@cfworker/json-schema`, draft 2020-12, ≤ 32 KB);
   - per-connection rate limit, then `tools/call`;
   - the result is normalized: text and resource text are kept, binary content is omitted with only its size reported;
   - any copy of the connection's own credential in the result is redacted.
   - The result is returned with provenance `{source:'external_mcp', server_name, endpoint_host, observed_at, untrusted:true}`.
   - The first successful call marks the connection `verified`, and readiness becomes `ready`.
7. **Operate:** edit, disable/enable, rotate or revoke the credential, re-authorize, refresh tools, delete.
   - Changing the endpoint or auth type drops the old credential and resets all approvals.
   - Invocation history and audit history are viewable per connection. Invocation history survives deletion.

## Readiness states (UI)
`not_configured`, `auth_required`, `untested`, `connection_failed`, `auth_failed`, `connected_unverified`, `tools_discovered` (none approved), `tools_discovered_unverified`, `verified_no_tools_allowed`, `ready`, `disabled`.

## API (owner session + `x-nk-client: web` on writes)
| Method | Path |
|---|---|
| GET | `/api/connector/meta` (supported transports and auth, limits, encryption configured?) |
| GET/POST | `/api/connector/connections` |
| GET/PATCH/DELETE | `/api/connector/connections/:id` |
| POST | `/api/connector/connections/:id/test` (initialize + discover) |
| POST | `/api/connector/connections/:id/revoke-credential` |
| POST | `/api/connector/connections/:id/oauth/start` → `{authorization_url}` |
| GET | `/api/connector/oauth/callback` (owner session + single-use state) |
| GET | `/api/connector/connections/:id/tools[?allowed=1]` |
| PUT | `/api/connector/connections/:id/tools/:tool/permission` `{permission, confirm_risk?}` |
| POST | `/api/connector/connections/:id/tools/:tool/invoke` `{arguments}` |
| GET | `/api/connector/connections/:id/invocations` · `/audit` · `/api/connector/invocations` |

Internal callers use the same service functions (`src/worker/connector/service.ts`: `invokeTool`, `listTools`, `listConnections`).

## Inbound bridge (NALUKESA MCP server)
New inbound tools and scopes:
- `list_external_connections` and `list_external_tools`: scope `connectors:read`.
- `call_external_tool`: scope `connectors:invoke`.

Constraints on `call_external_tool`:
- it can only call tools that are **approved** and classified **read**; write and destructive tools stay owner-UI only;
- outputs are labelled as untrusted third-party data;
- inbound tokens and outbound credentials are completely separate.

Recursion guard:
- outbound requests carry `X-NK-Hop: 1`, and `/mcp` refuses any request that has it;
- NALUKESA's own hosts cannot be registered as endpoints.

## Supported / not supported
| | Status |
|---|---|
| Streamable HTTP (JSON and SSE responses, session id handled by the SDK) | ✅ |
| Auth: none, bearer/API key in `Authorization` | ✅ |
| OAuth discovery: RFC 9728 protected-resource metadata (WWW-Authenticate hint or well-known), RFC 8414 and OIDC (path-insertion + path-append), issuer + resource binding checks, PKCE S256 mandatory | ✅ |
| OAuth registration: **Client ID Metadata Document** (CIMD, `/oauth/client-metadata.json`) | ✅ tested against local mock AS + temporary production mock |
| OAuth registration: **Dynamic Client Registration** (RFC 7591, cached per redirect/issuer) | ✅ tested against local mock AS + temporary production mock |
| OAuth registration: **pre-registered** client (public `none`, `client_secret_basic`, `client_secret_post`; secret encrypted) | ✅ tested against local mock AS + temporary production mock |
| Session-bound, single-use, 10-minute, hashed `state`; RFC 9207 `iss` check; refresh with rotation; reauth on refresh failure | ✅ |
| Real third-party OAuth provider verified end-to-end | ❌ not yet (no owner credentials for a real provider) |
| Custom header names (e.g. `X-API-Key`) | ❌ not yet |
| Legacy HTTP+SSE transport | ❌ (deprecated) |
| stdio transport | ❌ (impossible from a Worker) |
| Resources / prompts / sampling from remote servers | ❌ tools only |

## OAuth gateway (v0.5.0)
Per connection, `auth_type: "oauth"` offers two modes:
- **Recommended: Sign in with OAuth** (`oauth_mode: "auto"`): NALUKESA discovers the provider metadata and picks CIMD if the AS advertises `client_id_metadata_document_supported`, otherwise DCR. If neither is available it stops with an actionable error (`Provider requires a pre-registered client …`), never downgrading security.
- **Use a pre-registered OAuth app** (`oauth_mode: "preregistered"`): `oauth_client_id`, `oauth_token_auth_method` (`none` | `client_secret_basic` | `client_secret_post`), optional `oauth_client_secret` (write-only, AES-GCM encrypted, never returned), optional `oauth_scopes`.

Endpoints (owner session):
- `GET /api/connector/oauth/client-info`: redirect URI + CIMD URL to paste into a provider console.
- `POST /api/connector/connections/:id/oauth/diagnose`: staged discovery report without starting a flow.
- `POST /api/connector/connections/:id/oauth/start`: returns `authorization_url`; on failure 422 `{stage, message, next_action}`.
- `GET /api/connector/oauth/callback`: state checked (hash, session, TTL, single use), `iss` verified, code exchanged; page states that authorization alone does not prove data access.
- `GET /oauth/client-metadata.json`: public CIMD document (HTTPS origins only).

Stages shown in the UI and API (`stages` on each connection): endpoint reachable → OAuth configured → account authorized → MCP initialized → tools discovered → tool invocation verified. **Ready** only after the last one passes.

## Security
See [mcp-security.md](mcp-security.md#generic-external-connector).
