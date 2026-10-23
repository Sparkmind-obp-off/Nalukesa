# NALUKESA MCP — Local Testing

All of these commands use the local Wrangler runtime and the **local** D1 database. None of them contacts production.

```bash
npm install
cp .env.example .dev.vars            # OWNER_PASSWORD, SESSION_SECRET, CONNECTOR_ENC_KEY, CONNECTOR_ALLOW_LOCAL=true, APP_ENV=development
npm run db:migrate:local             # applies 0001 + 0002 locally
npm run build
pm2 start ecosystem.config.cjs       # wrangler pages dev on :3000 + mock MCP provider on 127.0.0.1:8788

npm run check                         # typecheck + lint + unit/hub tests + build
PW=<local pw> bash scripts/smoke.sh       # 34 web-API regression checks
PW=<local pw> bash scripts/mcp-smoke.sh   # 57 MCP end-to-end checks (refuses non-localhost BASE)
PW=<local pw> bash scripts/connector-smoke.sh  # 129 generic-connector checks against scripts/mock-mcp-server.mjs (:8788)
```

What each test layer covers:
- `tests/hub.test.ts`:
  - spins up a **local** HTTP server that hosts a mock REST API and a mock MCP server (built with the official SDK);
  - tests success, timeout, 401, 429, malformed JSON, schema failure, size cap, redirect-to-metadata, non-allowlisted hosts, the tool allowlist, and secret redaction;
  - tests 12 SSRF URL variants.
- `tests/tokens.test.ts`: token format, bearer parsing, scope allowlist, null-preserving totals.
- `scripts/mcp-smoke.sh`:
  - auth: no token, bad token, session cookie, password as token, cross-origin, revoked token;
  - protocol: initialize and version negotiation, tools/list, all 5 tools against D1 fixtures;
  - errors: invalid args, unknown tool, scope enforcement;
  - audit trail and routing regressions (SPA, static, `/api`, `/mcp/other`).

### Connect a client (local)
Create a token in the UI (**MCP & integrations → New token**), then:
```bash
npx @modelcontextprotocol/inspector   # Transport: Streamable HTTP, URL http://localhost:3000/mcp,
                                      # header Authorization: Bearer nkmcp_…
```
Claude Desktop (`claude_desktop_config.json`), via `mcp-remote`:
```json
{ "mcpServers": { "nalukesa": { "command": "npx",
  "args": ["mcp-remote", "https://nalukesa.biz.id/mcp", "--header", "Authorization:${NK_TOKEN}"],
  "env": { "NK_TOKEN": "Bearer nkmcp_..." } } } }
```

### Generic connector test coverage (`scripts/connector-smoke.sh`, `tests/connector-net.test.ts`)
The numbers refer to the requirement list:
1. register;
2. unsafe endpoints (11 variants plus 18 in unit tests);
3. bearer auth;
4. invalid credentials;
5. initialize;
6. dynamic discovery, including catalog add/remove detection;
7. approve/deny, including risk confirmation;
8. non-allowlisted tool rejected;
9. real mock result (structured + text);
10. schema-invalid args, enum, array, size;
11. malformed JSON-RPC;
12. declared and chunked size caps;
13. timeouts on headers, body, and slow tool;
14. redirect to metadata blocked;
15. reflected-credential redaction;
16. unauthenticated and CSRF;
17. inbound MCP plus bridge;
18. edit, disable, endpoint-change reset, revoke, delete;
19. OAuth: discovery, DCR, PKCE S256, forged and replayed state, callback without session, automatic refresh, invoke;
20. full suite regression.

The mock server runs locally only. These tests do **not** prove that any specific real provider works.
