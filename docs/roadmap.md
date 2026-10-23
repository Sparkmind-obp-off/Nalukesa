# Roadmap

## Phase 1 — Foundation (current)
**Deliverable:** brand and operating model, static workspace, research and decision documentation.
- Establish umbrella vs niche-channel roles.
- Define evidence grades and record templates.
- Build initial niche and product experiment flow.
- Keep the site static and zero-cost.

**Exit condition:** workflow can be used consistently for real research and results can be exported without invented data.

## Phase 2 — Manual validation
- Research the three initial lanes.
- Confirm affiliate eligibility and exact platform terms.
- Capture dated, source-linked product records.
- Run bounded creative experiments within available time.
- Review real platform analytics and approved commission.

**Exit condition:** at least one repeatable learning loop has been completed; not necessarily a winning niche.

## Phase 3 — Workflow refinement
- Identify repeated manual bottlenecks.
- Add persistent storage only if data loss becomes a real problem.
- Add CSV import/export with validation.
- Add source freshness indicators and decision history.

**Exit condition:** the new capability saves measurable effort or improves data quality.

## Phase 4 — Official integrations (conditional)
- Investigate official affiliate, marketplace, or analytics interfaces.
- Confirm scopes, eligibility, terms, security, and cost.
- Build a single integration at a time and compare imported values to the source.
- Add monitoring for failures and stale data.

**Exit condition:** reliable, authorized data with clear provenance.

## Phase 5 — Public discovery layer (optional)
- Publish selected niche guides and product lists.
- Add transparent affiliate disclosures and clear link destinations.
- Review all claims and product availability.
- Monitor broken links and update timestamps.

This is a curated discovery layer, not a checkout marketplace. A marketplace is not justified until demand, operational need, legal requirements, and economics support it.

## Explicit non-goals for now
- Inventory management
- Checkout and payment processing
- Seller onboarding marketplace
- Paid ads before validation
- Mass account creation
- Automated posting without review
- AI-generated performance claims


## Engineering delivery plan

The detailed technical proposal is in [Full-stack blueprint](full-stack-blueprint.md), with tasks in [Implementation backlog](implementation-backlog.md) and release gates in [Acceptance criteria](acceptance-criteria.md).

Recommended default stack: React + TypeScript + Vite, Cloudflare Pages, Cloudflare Workers API, D1, and optional R2. Authentication should be owner-only for the pilot and chosen only after current access/plan limitations are verified. Manual research and CSV should precede platform integrations.

### Milestone gates
- **M0 — Audit:** verify repository state, scripts, current UI, and deployment assumptions.
- **M1 — Foundation:** establish maintainable frontend structure, typed models, validation, and checks.
- **M2 — End-to-end research workflow:** niches → products → evidence → experiments → content → metrics → decisions.
- **M3 — Persistence and access:** D1 migrations, API, owner-only authentication, audit events.
- **M4 — Data integrity:** evidence provenance, offer history, nullable metrics, CSV validation.
- **M5 — Real-world validation:** run bounded tests with real data and record outcomes.
- **M6 — Official integrations:** one at a time, only when eligibility, access, and terms are verified.
- **M7 — Optional AI/public discovery:** human review, source-grounded summaries, disclosure, no checkout marketplace.

Each milestone requires evidence of completion, test results, known limitations, and an explicit status. No deployment, public publishing, paid spend, or account changes without approval.
