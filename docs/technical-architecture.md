# Technical Architecture

## Current implementation (v0.2.0, M1–M4 foundation)
- **Frontend:** React 19 + TypeScript + Vite SPA in `web/`. Hash routing (`#/niches/3`). CSS design tokens in `web/src/styles.css` preserve the approved prototype palette.
- **API:** Hono on Cloudflare Pages Functions (advanced mode). `src/worker/index.ts` is bundled by esbuild into `dist/_worker.js`; `dist/_routes.json` routes only `/api/*` to the Worker, everything else is static.
- **Shared domain:** `src/shared/entities.ts` defines every entity/field once. It drives server validation, SQL column whitelists, CSV columns, forms and tables.
- **Database:** Cloudflare D1 (`nalukesa-production`), versioned migrations in `migrations/`. Foreign keys, indexes, nullable metrics, integer IDR.
- **Append-only history:** `offer_snapshots`, `performance_snapshots`, `decisions` reject PATCH/DELETE (HTTP 409).
- **Auth (owner-only pilot):** password in Cloudflare secret `OWNER_PASSWORD`; HMAC-signed session (`SESSION_SECRET`) in an HttpOnly + Secure + SameSite=Strict cookie, 12h TTL. Login throttled (5 attempts / 15 min per hashed IP, stored in D1). Writes also require an `x-nk-client: web` header (CSRF defence in depth). Every `/api/*` route except `health`, `auth/me`, `auth/login`, `auth/logout` requires a session.
- **Hardening:** unknown fields rejected (no mass assignment), only http(s) URLs accepted, body limits (4 KB login, 64 KB writes, 1 MB CSV), React escaping (no `dangerouslySetInnerHTML`), external links `noopener noreferrer`, CSV formula-injection guard on export, secure headers, `Cache-Control: no-store` on API, safe error messages (no stack traces).
- **CSV:** validate → preview row-level errors → explicit commit. Commit is atomic (D1 batch); any invalid row aborts the whole import. Max 500 rows.
- **Audit:** create/update/delete/import/export/login events in `audit_events` (no secrets, field names only for updates).
- **Legacy:** the original static prototype is preserved at `legacy/prototype.html` (not deployed).

### Endpoints
| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | public; status, db, auth configured — no secrets |
| GET | `/api/auth/me` | public; session status |
| POST | `/api/auth/login` / `/api/auth/logout` | |
| GET | `/api/overview` | counts, stale offers (>30d), due reviews, experiments without decision, published content without performance, recorded-only totals |
| GET | `/api/:entity?q=&page=&limit=&sort=&dir=&<filter>=` | paginated list, search, filters |
| GET/PATCH/DELETE | `/api/:entity/:id` | PATCH/DELETE blocked for append-only entities; DELETE blocked (409) if dependents exist |
| POST | `/api/:entity` | create, validated + FK existence check |
| GET | `/api/lookup/:entity` | id → title for selects |
| GET | `/api/export/:entity.csv` | full export incl. ids/timestamps |
| POST | `/api/import/:entity/validate` · `/commit` | CSV body (`text/csv`) |
| GET | `/api/audit` | latest 100 events |

Entities: `niches, products, offer_snapshots, evidence_sources, observations, experiments, content_items, performance_snapshots, decisions`.

### Local development
```bash
npm install
cp .env.example .dev.vars        # set OWNER_PASSWORD and SESSION_SECRET (>=32 chars)
npm run db:migrate:local
npm run build
pm2 start ecosystem.config.cjs   # wrangler pages dev on :3000
PW=<your local password> bash scripts/smoke.sh   # 34 API integration checks (writes test rows!)
```
Quality gate: `npm run check` (typecheck + lint + unit tests + build).

### Deployment (Cloudflare Pages, own account)
```bash
npx wrangler d1 create nalukesa-production        # once; put id in wrangler.jsonc
npm run db:migrate:prod
npx wrangler pages project create nalukesa --production-branch main
npx wrangler pages secret put OWNER_PASSWORD --project-name nalukesa
npx wrangler pages secret put SESSION_SECRET --project-name nalukesa
npm run deploy
```
Backup: `npx wrangler d1 export nalukesa-production --remote --output backup.sql`. Restore into a fresh DB with `wrangler d1 execute <db> --remote --file backup.sql`. Schema changes must add a new numbered migration; never edit an applied one.

Recommended hardening: put **Cloudflare Access** (Zero Trust, owner email only) in front of the Pages domain as an additional layer.

## Further architecture (only after manual validation)
1. **Presentation:** responsive workspace and optional public discovery pages.
2. **Application API:** authenticated endpoints for products, sources, experiments, content, and outcomes.
3. **Database:** relational tables for niches, products, source observations, offers, experiments, posts, metrics snapshots, and decisions.
4. **Source registry:** source URL, source type, observed date, evidence grade, terms/permissions, and expiration/recheck policy.
5. **Ingestion:** manual CSV import first; official APIs or permitted exports only after reviewing provider terms and access.
6. **Auditability:** track when data was collected, changed, or reviewed; keep observed values distinct from computed values.
7. **Access:** private research by default; public publication requires a deliberate review/publish step.

## Possible data entities
- `niches`
- `products`
- `offers`
- `evidence_sources`
- `product_observations`
- `experiments`
- `content_assets`
- `content_publications`
- `performance_snapshots`
- `decisions`
- `users_and_roles` (only when multi-user access is needed)

## Security and privacy
- Never commit access tokens, passwords, cookies, OTPs, or platform credentials.
- Keep account analytics private.
- Minimize collection of personal data; do not harvest private communities or sensitive personal information.
- Respect robots/access controls, API terms, platform policies, and intellectual property.
- Validate external URLs and escape user-entered content before rendering.
- Use least-privilege credentials and documented retention when a backend is introduced.

## Integration policy
No scraping or API integration should be implemented until the exact source, permitted access method, rate limits, licensing, and intended data use are reviewed. Do not bypass platform access controls. A manually verified workflow is the preferred MVP.
