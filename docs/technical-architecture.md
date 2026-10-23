# Technical Architecture

## Current implementation
- Static single-page prototype in `index.html`.
- Responsive dark editorial interface; overview, niche discovery, product intelligence, experiments, content brief, roadmap.
- No build step or server required.
- Product and experiment records are held in JavaScript memory only for the current page session; refresh clears them.
- CSV export is available for records created in that session.
- No authentication, database, analytics ingestion, affiliate API, or live platform data connection is implemented.
- The prototype intentionally shows zero verified earnings and no fabricated metrics.

## Static deployment
A static host such as Cloudflare Pages can serve the repository root with no build command. Verify the output directory and custom domain in the hosting dashboard before publishing. No secrets are required for the prototype.

## Proposed next architecture (only after manual validation)
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
