# Implementation Backlog

Priorities: **P0** blocks foundation, **P1** core workflow, **P2** persistence/security, **P3** later optimization. Status values: Planned / In progress / Done / Blocked. Update status only after verifying the deliverable.

## P0 — Foundation
- [ ] Inspect repository and retain existing NALUKESA visual direction.
- [ ] Establish application structure and reusable layout/navigation.
- [ ] Define TypeScript types and validation schemas.
- [ ] Add lint, typecheck, build, and test commands.
- [ ] Add `.env.example` with variable names only; no real secrets.
- [ ] Document local setup and deployment assumptions.
- [ ] Accessibility and responsive design pass.

## P1 — Core research workflow
- [ ] Niche registry: create/edit/status/filter/notes.
- [ ] Product registry: listing URL, seller, niche, status, checked date.
- [ ] Offer snapshots: price, commission, basis, terms URL, recheck date.
- [ ] Evidence/source registry with evidence grade and confidence.
- [ ] Observation records separating facts from interpretation.
- [ ] Experiment planner with hypothesis and pre-registered decision rules.
- [ ] Content brief generator based only on supplied facts.
- [ ] Publication/content registry with disclosure and asset-rights fields.
- [ ] Performance snapshots: views, clicks, orders, approved commission, cancellations.
- [ ] Decision log: scale / iterate / hold / stop with linked evidence.
- [ ] CSV export and validated CSV import preview.
- [ ] Global search, filters, sorting, pagination where needed.
- [ ] Useful empty, loading, success, and error states.

## P2 — Persistence and security
- [ ] D1 schema and versioned migrations.
- [ ] Worker API with schema validation and consistent errors.
- [ ] Owner-only authentication selected and verified.
- [ ] Authorization checks on every private endpoint.
- [ ] Audit events for important changes.
- [ ] URL validation, safe rendering, request size limits, rate limits.
- [ ] Backup/export and documented restore procedure.
- [ ] Production environment separation and secret handling.
- [ ] Integration tests against a disposable test database.
- [ ] Verify that unauthorized requests receive 401/403 as expected.

## P3 — Reliability and decision quality
- [ ] Source freshness indicators and recheck reminders.
- [ ] Detect possible duplicate products/listings.
- [ ] Keep historical offer snapshots instead of silent overwrite.
- [ ] Metric provenance, date range, attribution notes, nullable values.
- [ ] Portfolio comparison with confidence and caveats.
- [ ] Decision review dates and change history.
- [ ] CSV import validation report with row-level errors.
- [ ] Data export and delete flows.

## P4 — Research integrations (conditional)
- [ ] Inventory eligible official APIs and permitted exports.
- [ ] Record provider terms, required scopes, rate limits, and costs.
- [ ] Start with read-only ingestion.
- [ ] Reconcile imported data against official source.
- [ ] Show sync status, source timestamp, and stale/error states.
- [ ] Provide manual entry/import fallback.
- [ ] No login scraping, credential collection, or access-control bypass.

## P5 — AI assistance (conditional)
- [ ] Provider adapter behind server-side interface.
- [ ] Source-grounded research summaries with citations/URLs.
- [ ] Distinguish extracted facts, interpretations, and unknowns.
- [ ] Prompt/version audit and token/usage budgets.
- [ ] Redact unnecessary personal data before requests.
- [ ] Human review required before publication or decisions.
- [ ] Test hallucination, prompt injection, stale data, and source conflicts.
- [ ] No automatic posting or fabricated analytics.

## P6 — Public curated discovery (optional)
- [ ] Publication review queue.
- [ ] Public/private data boundaries.
- [ ] Clear affiliate disclosure and editorial policy.
- [ ] Outbound link health checks and revalidation of prices.
- [ ] Search/index metadata and accessibility review.
- [ ] Abuse reporting/contact process where appropriate.
- [ ] No marketplace checkout until separately justified and approved.

## Release gate
A backlog item is Done only with an implementation reference, relevant tests or QA evidence, and known limitations. Do not report an item Done because code was merely generated.
