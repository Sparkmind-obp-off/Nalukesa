# NALUKESA — Full-Stack Blueprint

## Product definition
NALUKESA is an affiliate discovery and intelligence workspace under one umbrella brand. It helps its operator research niches, collect dated evidence, evaluate products and offers, plan bounded content experiments, record actual outcomes, and make traceable scale/iterate/hold/stop decisions.

It is **not a marketplace at launch**. It does not own inventory, process checkout, handle payments, or promise sales. A public curated-discovery layer is optional and conditional on evidence.

## Architecture principles
- Zero-cost or free-tier-first until product validation supports spend.
- Ship a secure, useful MVP before adding integrations.
- Store evidence provenance with every material claim.
- Unknown data remains unknown; never fabricate demand, prices, commission, orders, or earnings.
- Manual entry and CSV import first; official APIs only after terms and access are verified.
- Separate the public brand layer from private operational data.
- Every consequential decision should be explainable from its underlying observations.

## Recommended MVP stack
| Layer | Recommendation | Why |
|---|---|---|
| Frontend | React + TypeScript + Vite | Fast, maintainable workspace UI; good fit for a Genspark-generated codebase |
| Styling | CSS design tokens + accessible component patterns | Preserve premium visual consistency without adding a large dependency stack |
| Hosting | Cloudflare Pages | Static delivery and simple deployment |
| API | Cloudflare Workers + Hono (or minimal native Worker routes) | Small server-side API; avoids a permanently running server |
| Database | Cloudflare D1 (SQLite) | Relational records for products, sources, experiments, content, and decisions |
| File/object storage | Cloudflare R2, optional | Evidence exports and approved assets only when needed |
| Authentication | Cloudflare Access for owner-only pilot | Avoid building custom authentication prematurely; verify plan/limits before relying on it |
| Validation | TypeScript, ESLint, unit tests, API contract tests | Catch regressions without paid services |
| Observability | Structured logs and a simple health endpoint first | Avoid unnecessary paid monitoring until usage justifies it |
| AI | Provider adapter interface, disabled by default | Keep vendor choice, privacy, and costs controlled; no keys in client code |
| Source integrations | Manual URLs/CSV first; approved official APIs later | No brittle scraping or policy bypass |

This is a recommended architecture, not a claim that integrations, hosting, credentials, or deployments are already configured. Confirm current provider limits and costs before production use.

## Logical architecture
```text
Owner / Researcher
       |
       v
Responsive Web App (React + TypeScript)
       |
       v
Authenticated API (Cloudflare Worker)
       |--------------------|
       v                    v
Cloudflare D1           R2 (optional)
structured records      permitted files/exports
       |
       v
Evidence + decisions + audit history

Optional, later:
Official platform APIs / CSV imports -> validated ingestion -> D1
AI provider adapter -> server-side secret -> redacted prompts -> human-reviewed output
Public curated pages -> approved/published records only
```

## Data model (minimum viable)
- `niches`: id, name, description, hypothesis, status, created_at, updated_at
- `products`: id, niche_id, name, platform, listing_url, seller, status, created_at
- `offers`: id, product_id, checked_at, price_idr, commission_rate, commission_basis, terms_url, expiry/recheck date
- `evidence_sources`: id, source_type, url, title, publisher, published_at, accessed_at, evidence_grade, notes
- `observations`: id, entity_type, entity_id, source_id, observed_value_json, interpretation, confidence, observed_at
- `experiments`: id, niche_id, name, hypothesis, start_date, review_date, scope, primary_metric, decision_rule, status
- `content_items`: id, experiment_id, product_id, angle, proof_point, asset_rights, disclosure, publication_url, published_at
- `performance_snapshots`: id, content_item_id, period_start, period_end, views, clicks, orders, approved_commission_idr, cancellations, source, imported_at
- `decisions`: id, entity_type, entity_id, decision, rationale, evidence_ids, decided_at, next_review_at
- `audit_events`: id, actor, action, entity_type, entity_id, timestamp, metadata_redacted

Use foreign keys, appropriate indexes, timestamps, migrations, and server-side validation. Store money in integer IDR where applicable. Do not turn missing metrics into zero.

## Minimum API surface
- `GET /api/health` — readiness without revealing secrets
- `GET/POST /api/niches`
- `GET/POST /api/products`
- `GET/POST /api/products/:id/observations`
- `GET/POST /api/experiments`
- `GET/POST /api/content-items`
- `GET/POST /api/performance-snapshots`
- `GET/POST /api/decisions`
- `POST /api/imports/csv/validate` and a separately confirmed import action
- `GET /api/exports/:entity.csv`

All write endpoints require authentication, schema validation, bounded request sizes, safe error responses, and audit events. Pagination and filters are required for list endpoints. Do not implement an endpoint merely because it is listed; deliver in phases.

## Security and trust requirements
- Never commit credentials, tokens, cookies, OTPs, private keys, or real customer data.
- Secrets belong in Cloudflare environment secrets, never client-side variables.
- Owner-only private workspace by default. Public access is an explicit product decision.
- Validate URLs, reject unsafe schemes, escape user-provided text, and prevent XSS.
- Use least-privilege access, CSRF protections where relevant, and secure session patterns from the chosen auth provider.
- Do not store credentials for TikTok, Shopee, Instagram, or affiliate portals.
- Keep research public and authorized; never bypass access controls, anti-bot protections, or platform terms.
- Minimize personal data and define deletion/export behavior.
- Audit changes to product terms, evidence, experiment outcomes, and decisions.
- AI-generated content must be labelled as draft and reviewed by a human; do not permit auto-publishing in the MVP.

## Data integrity requirements
- Every source observation has a URL or source identifier and accessed timestamp where possible.
- Separate raw observation from interpretation.
- Evidence grades: A primary verified; B direct public observation; C secondary report; D anecdotal/unclear.
- Track price and commission snapshots; never overwrite history silently.
- Advertised commission and approved earnings are separate fields.
- Views, clicks, orders, and approved commission are separate metrics.
- Data that is absent remains null/unknown.
- All imported metrics include a source and period.

## UI/UX direction
Premium editorial, restrained, deliberate:
- Charcoal / warm near-black base, warm ivory typography, muted champagne accent, restrained sage for verified positive states.
- Spacious layout, strong type hierarchy, high-quality tables, calm status indicators, minimal animation.
- Mobile-responsive navigation and forms; desktop optimized for research tables.
- Keyboard accessible controls, visible focus, proper labels, meaningful empty/loading/error states.
- Clear status labels: Hypothesis, Researching, Ready to test, Testing, Scale candidate, Hold, Rejected.
- Never display decorative fake analytics as if they were live data.
- Include source freshness and confidence when displaying a research claim.
- Include last-updated timestamps for volatile offer details.

## Delivery phases
### P0 — Repo and design foundation
Review existing repository, preserve approved design language, establish app structure, lint/typecheck/build/test commands, environment examples, and contributor notes.

### P1 — Functional local MVP
Replace the static-only session state with typed domain models and a clean UI architecture. Build overview, niche registry, product registry, evidence/source records, experiments, content briefs, metrics snapshots, decisions, CSV import/export. Until backend is connected, state clearly that storage is local/demo-only.

### P2 — Persistence and owner authentication
Create D1 migrations, Worker API, input validation, pagination, audit events, error handling, and owner-only access. Confirm deployment environment and auth method before applying production changes.

### P3 — Data quality
Implement source freshness, evidence grades, history snapshots, nullable metrics, duplicate detection, CSV schema preview, row-level validation, and export verification.

### P4 — Operational validation
Use the workspace for actual niche research and a bounded content test. Compare imported figures to source dashboards. Document workflow friction and measured value before adding integrations.

### P5 — Authorized integrations
Evaluate official platform APIs, permitted exports, and provider terms. Build one integration at a time, with a manual fallback and explicit sync timestamps. Stop if eligibility, permission, or cost is not acceptable.

### P6 — Optional AI research assistance
Add provider-agnostic server adapter, source-grounded summaries, prompt/version logging, privacy filtering, usage caps, and human review. AI cannot invent evidence or auto-approve scale decisions.

### P7 — Optional public discovery pages
Publish only reviewed, current, curated product guides. Add affiliate disclosures, outbound link monitoring, and clear editorial criteria. No cart or checkout unless a separate validated business case is approved.

## Definition of done for every phase
- Requirements and acceptance criteria documented.
- Tests/build/lint/typecheck pass where applicable.
- No secrets in repository.
- Manual QA includes desktop and mobile, empty/loading/error states, keyboard navigation, and data validation.
- Actual status reported honestly; unconfigured integrations are labelled blocked/not connected.
- Any schema change includes a migration and backup/rollback notes.
- No production data migration, public publishing, account changes, or spending without explicit authorization.
