# NALUKESA MCP — Local Testing

All of these commands use the local Wrangler runtime and the **local** D1 database. None of them contacts production.

```bash
npm install
cp .env.example .dev.vars            # OWNER_PASSWORD, SESSION_SECRET (>=32 chars)
npm run db:migrate:local             # applies 0001 + 0002 locally
npm run build
pm2 start ecosystem.config.cjs       # wrangler pages dev on :3000

npm run check                         # typecheck + lint + unit/hub tests + build
PW=<local pw> bash scripts/smoke.sh       # 34 web-API regression checks
PW=<local pw> bash scripts/mcp-smoke.sh   # 57 MCP end-to-end checks (refuses non-localhost BASE)
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
