# NALUKESA
### Affiliate Discovery & Intelligence Hub

NALUKESA is the umbrella brand and private operating workspace for discovering, researching, testing, and scaling affiliate opportunities across niches.

**Core idea:** discover evidence → run small tests → measure real outcomes → scale only what earns the right to scale.

NALUKESA is **not a marketplace**. No inventory, cart, checkout, payments, or seller onboarding.

## Status — v0.5.0 (private pilot)
| Item | Status |
|---|---|
| Production URL | https://nalukesa.pages.dev (owner login required) |
| Hosting | Cloudflare Pages project `nalukesa` (owner's own Cloudflare account) |
| Database | Cloudflare D1 `nalukesa-production`, migrations `0001`–`0004` applied. **Contains no data**: no research records exist yet |
| Auth | Owner-only password session. Secrets `OWNER_PASSWORD` and `SESSION_SECRET` are stored as Cloudflare Pages secrets |
| Production URL (custom domain) | https://nalukesa.biz.id |
| MCP server | `POST /mcp`: 5 read-only tools, scoped bearer tokens issued in the UI. See [docs/mcp-architecture.md](docs/mcp-architecture.md) |
| External MCP connector | Generic: register any Streamable-HTTP MCP server (none / bearer / OAuth 2.1 via CIMD, DCR or a pre-registered app), discover tools, approve per tool, invoke. See also [docs/universal-mcp-oauth-gateway.md](docs/universal-mcp-oauth-gateway.md). See [docs/mcp-connector.md](docs/mcp-connector.md). **No real third-party provider has been connected yet.** |
| Integrations | None connected (Shopee/TikTok: manual entry and CSV only; AI: disabled) |
| Checks | `npm run check`: typecheck ✓, lint ✓, 157/157 tests ✓, build ✓ · `smoke.sh` 34/34 · `mcp-smoke.sh` 57/57 · `connector-smoke.sh` 129/129 · `gateway-smoke.sh` 102/102 (local D1 + mock MCP/AS) |

## Features (implemented and verified)
- **Overview:** counts and next actions computed only from stored records. It flags stale offers (>30 days), reviews due, experiments without a decision, and published content without performance data. Outcome totals only include snapshots that actually recorded the metric.
- **Niches:** hypotheses with audience, problem, confidence, status (Hypothesis → Rejected) and next review date.
- **Products:** exact listing URL, platform, seller, checked date, trust notes.
- **Offer snapshots (append-only):** price in integer IDR, *advertised* commission %, basis, terms URL, recheck date. History is never overwritten.
- **Evidence sources:** URL, publisher, accessed date, grade A/B/C/D, caveats. Stale after 90 days.
- **Observations:** the observed fact is kept separate from its interpretation, linked to a source, with confidence.
- **Experiments:** hypothesis, scope, dates, primary metric, time and budget caps, and a decision rule that must be registered before launch.
- **Content studio:** angle, verified proof point, caveats, CTA, disclosure, asset rights. A draft brief is generated only from the stored fields (no AI). A record cannot be marked *Published* until disclosure and rights are resolved.
- **Performance snapshots (append-only):** views, clicks, orders, *approved* commission, cancellations/returns, data source. A blank field means **not recorded**, never zero.
- **Decision log (append-only):** scale candidate / iterate / hold / stop, with rationale, evidence refs, owner and review date. Each record's detail page shows its decision history.
- **CSV:** export every entity. Import works as validate → preview with row-level errors → confirm. The import is atomic: one bad row aborts everything.
- **MCP & integrations:** issue and revoke scoped inbound MCP tokens. Manage external MCP connections: add, test & discover, approve tools, invoke, view the audit trail.
- **Settings:** live health check, enforced guardrails, integration status, audit log.
- **Security:** see `docs/technical-architecture.md`. In short: auth on every private endpoint, input validation, http(s)-only URLs, body limits, login throttling, CSP and security headers, `noindex`.

## Using the workspace
1. Open https://nalukesa.pages.dev and sign in with the owner password.
2. Follow the **Research workflow** on the Overview. It points to the next empty step.
3. Register the three initial lanes (Beauty & personal care, Everyday fashion, Useful home goods) as **Hypothesis**. They are not proven winners.
4. For each claim, add an evidence source first, then observations, products, and dated offer snapshots.
5. Before publishing anything, plan one bounded experiment per lane with a written decision rule.
6. Record real numbers from platform dashboards as performance snapshots, then log a decision.

## Project structure
```
src/shared/      entities.ts (single source of truth), validate.ts, csv.ts
src/worker/      Hono API (index.ts) + owner auth (auth.ts) → dist/_worker.js
web/             React + Vite SPA (index.html, src/, public/_headers)
migrations/      D1 SQL migrations
tests/           Vitest unit tests
scripts/         build-worker.mjs, smoke.sh (API integration checks)
legacy/          original static prototype (not deployed)
docs/            brand, methodology, architecture, backlog, acceptance criteria
```

## Workflow
All changes are committed directly to `main` and deployed to Cloudflare Pages (project `nalukesa`) after `npm run check` and the local smoke suites pass.

## Development
```bash
npm install
cp .env.example .dev.vars            # fill OWNER_PASSWORD and SESSION_SECRET (>=32 chars)
npm run db:migrate:local
npm run build && pm2 start ecosystem.config.cjs   # http://localhost:3000
npm run check                         # typecheck + lint + tests + build
PW=<local password> bash scripts/smoke.sh   # writes test rows: local DB only
```

## Deploy (Cloudflare Pages, own account)
```bash
npm run db:migrate:prod      # only when there are new migrations
npm run deploy               # build + wrangler pages deploy
```
Rotate the password with `npx wrangler pages secret put OWNER_PASSWORD --project-name nalukesa`, then redeploy.
Back up the database with `npx wrangler d1 export nalukesa-production --remote --output backup.sql`.

## Not yet implemented
- Cloudflare Access (Zero Trust) as an extra layer. It is recommended, and is configured in the dashboard.
- Global cross-entity search, duplicate-listing detection, and bulk delete/export-all.
- Rate limiting beyond login. An automated a11y audit with assistive tech. CI pipeline.
- Official platform integrations (M6) and the AI assistant (M7). Both are deliberately out of scope until justified.
- Public discovery pages (M7). There will be no checkout.

## Next recommended milestone
**M5 — Real-world validation:** use the workspace for manual research on the three lanes. Record dated evidence and one bounded experiment per lane, then compare the recorded figures against the source dashboards. Fix any workflow friction found before adding integrations.

## Documentation
[Brand architecture](docs/brand-architecture.md) · [Niche validation](docs/niche-validation.md) · [Product intelligence](docs/product-intelligence.md) · [Content playbook](docs/content-playbook.md) · [Metrics & decisions](docs/metrics-and-decisions.md) · [Technical architecture](docs/technical-architecture.md) · [Full-stack blueprint](docs/full-stack-blueprint.md) · [Roadmap](docs/roadmap.md) · [Implementation backlog](docs/implementation-backlog.md) · [Acceptance criteria](docs/acceptance-criteria.md) · [Compliance & trust](docs/compliance-and-trust.md) · [Genspark master prompt](docs/master-system-prompt-genspark.md)

_Last updated: 2026-10-23 (v0.5.0)_
