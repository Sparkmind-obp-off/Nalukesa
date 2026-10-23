# NALUKESA MCP Dual-Stack — Architecture

Status: implemented on branch `feat/nalukesa-mcp-dual-stack` (v0.3.0). Every capability is read-only.

## Components
```
            External MCP client (Claude Desktop, Cursor, custom SDK client …)
                     │  POST /mcp  (Authorization: Bearer nkmcp_…)
                     ▼
┌───────────────── Cloudflare Pages Worker (dist/_worker.js) ─────────────────┐
│  Hono router                                                                 │
│   ├─ /api/*   owner web API (session cookie)                                 │
│   └─ /mcp     INBOUND MCP SERVER  src/worker/mcp/                            │
│                 tokens.ts  bearer verify, scopes, expiry, revoke, rate limit │
│                 server.ts  McpServer + WebStandardStreamableHTTP (stateless) │
│                     │                                                        │
│                     ▼                                                        │
│           SHARED DOMAIN SERVICES  src/worker/domain.ts                       │
│             searchProducts · getProductEvidence · compareOpportunities       │
│             getAffiliatePerformance · summarizeMetrics · recordAudit         │
│                     │                                                        │
│                     ▼                         OUTBOUND MCP HUB src/worker/hub│
│                Cloudflare D1  ◄── provider_checks ── registry.ts (allowlist) │
│                                                     ├─ mcpClient.ts (SDK)    │
│                                                     ├─ rest.ts (REST)        │
│                                                     └─ safety.ts (SSRF guard)│
└──────────────────────────────────────────────────────────────────────────────┘
                                                              │ https only, allowlisted
                                                              ▼
                                               Approved third-party MCP / REST
                                               (none configured in this change)
```

## Inbound MCP server
- **SDK:** `@modelcontextprotocol/sdk@1.32.1` (official TypeScript SDK), `McpServer` and `WebStandardStreamableHTTPServerTransport`.
- **Transport:** Streamable HTTP in **stateless mode** (`sessionIdGenerator: undefined`, `enableJsonResponse: true`). Each POST builds a fresh server/transport pair and answers with JSON. No Durable Objects and no long-lived connections, which fits the Pages Worker request model.
  - `GET` and `DELETE` on `/mcp` return 405 because the server is stateless and offers no SSE stream or session.
  - The SDK client negotiates the protocol version during `initialize`. Version `2025-06-18` was verified.
- **Capabilities:** `tools` only. No resources, prompts, sampling, or elicitation.
- **JSON-schema validation:** `CfWorkerJsonSchemaValidator`. The SDK's default Ajv validator uses `new Function`, which Workers forbid, so it is stubbed at bundle time. `scripts/build-worker.mjs` fails the build if Ajv leaks into the bundle.
- **Routing:** `dist/_routes.json` includes `["/api/*", "/mcp"]`. Static assets and SPA routes, including `/mcp/other`, are not served by the Worker.

### Tools
| Tool | Scope | Input | Output (structuredContent) |
|---|---|---|---|
| `search_products` | `products:read` | `query?` (1–100 chars), `niche_id?`, `platform?` (enum), `status?` (enum), `limit?` (1–25, default 10) | `total_matching`, `returned`, `products[]` (id, name, platform, listing_url, seller, status, checked_at, niche_id, niche_name, last_offer_checked_at) |
| `get_product_evidence` | `evidence:read` | `product_id` | `product`, `observations[]` (fact, interpretation, source url/title/grade, accessed_at, `source_stale`), `offer_snapshots[]` (`age_days`, `stale`), `niche_level_observations[]`, `notes[]` |
| `compare_opportunities` | `products:read` | `product_ids` (2–10) | `items[]` (latest_offer incl. `advertised_commission_per_sale_idr`, evidence_by_grade, recorded_performance, latest_decision, `missing_fields[]`), `not_found[]`, `method` |
| `get_affiliate_performance` | `performance:read` | `product_id?`, `content_item_id?`, `experiment_id?`, `period_from?`, `period_to?` (YYYY-MM-DD) | `snapshots[]`, `totals` (per metric: `sum` or null, `recorded_in`, `of_snapshots`), `notes[]` |
| `get_provider_status` | `providers:read` | none | `providers[]` (config_status, missing_config names, last_check, verified) |

All tools carry `readOnlyHint: true`, `destructiveHint: false`, and `openWorldHint: false`. Unknown products return `isError: true`. Invalid arguments are rejected by the SDK using the zod schemas.

Data rules:
- `null` always means "not recorded".
- Totals only sum snapshots where the metric was recorded.
- No score or ranking is computed.
- Advertised commission is always labelled as advertised, never as earned.

## Outbound MCP Hub
- `registry.ts` holds an explicit list of `ProviderDefinition`s. Two **templates** exist (`example-mcp`, `example-rest`). Both are `not_configured`, so they are never contacted.
- A provider is contacted only when all of these hold:
  - its URL env var and secret env var are set as Cloudflare secrets;
  - its host appears in `allowedHosts` or `HUB_ALLOWED_HOSTS`;
  - the owner presses **Check** (`POST /api/hub/providers/:id/check`). There is no background polling.
- `mcpClient.ts`: official SDK `Client` plus `StreamableHTTPClientTransport`. It uses a guarded `fetch` that enforces the allowlist, blocks redirects, and applies timeouts and size caps. `mcpCallTool` also requires the tool name to be on a per-provider `allowedTools` list.
- `rest.ts`: read-only GET adapter. It applies a timeout (8 s), a 512 KB response cap, no redirects, one bounded retry on network/5xx/429 errors, and optional schema validation.
- Normalized result: `{ ok, status, provider_id, observed_at, latency_ms, source_url, data?, error? }`.
  - `status` is one of: `not_configured | configured | available | unavailable | rate_limited | auth_failed | invalid_response | blocked`.
- Check results are stored in `provider_checks`, redacted. Secret values are never stored or returned.

### Adding an approved provider (future, requires owner approval)
1. Add a `ProviderDefinition` with an exact `allowedHosts` list and a `secretEnv` name.
2. Set the values:
   - `npx wrangler pages secret put <URL_ENV>` and `<SECRET_ENV>`. These are values, never committed.
   - Optionally set `HUB_ALLOWED_HOSTS`.
3. Redeploy, then press **Check** on the MCP & integrations page and confirm the status is `available`.
4. If the provider will be used beyond health checks, add a domain-level wrapper that maps its response into NALUKESA records with provenance.

## Data model (migration 0002)
- `mcp_tokens`: name, SHA-256 hash, prefix, scopes, expiry, revoked_at, last_used_at. **No plaintext tokens.**
- `mcp_rate`: per-token, per-minute counter.
- `provider_checks`: status history of explicit checks.
