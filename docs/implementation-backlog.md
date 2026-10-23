# Implementation Backlog

> Status updated 2026-10-23 for v0.2.0. Checked items were verified by `npm run check` (typecheck, lint, 19 unit tests, build) and `scripts/smoke.sh` (34/34 API checks against local D1). Not yet done: accessibility audit with assistive tech, duplicate detection, disposable-DB CI integration tests, delete/export-all flow.

Priorities: **P0** blocks foundation, **P1** core workflow, **P2** persistence/security, **P3** later optimization. Status values: Planned / In progress / Done / Blocked. Update status only after verifying the deliverable.

## P0 — Foundation
- [x] Inspect repository and retain existing NALUKESA visual direction.
- [x] Establish application structure and reusable layout/navigation.
- [x] Define TypeScript types and validation schemas.
- [x] Add lint, typecheck, build, and test commands.
- [x] Add `.env.example` with variable names only; no real secrets.
- [x] Document local setup and deployment assumptions.
- [ ] Accessibility and responsive design pass.

## P1 — Core research workflow
- [x] Niche registry: create/edit/status/filter/notes.
- [x] Product registry: listing URL, seller, niche, status, checked date.
- [x] Offer snapshots: price, commission, basis, terms URL, recheck date.
- [x] Evidence/source registry with evidence grade and confidence.
- [x] Observation records separating facts from interpretation.
- [x] Experiment planner with hypothesis and pre-registered decision rules.
- [x] Content brief generator based only on supplied facts.
- [x] Publication/content registry with disclosure and asset-rights fields.
- [x] Performance snapshots: views, clicks, orders, approved commission, cancellations.
- [x] Decision log: scale / iterate / hold / stop with linked evidence.
- [x] CSV export and validated CSV import preview.
- [x] Global search, filters, sorting, pagination where needed. (per-list search; no cross-entity global search yet)
- [x] Useful empty, loading, success, and error states.

## P2 — Persistence and security
- [x] D1 schema and versioned migrations.
- [x] Worker API with schema validation and consistent errors.
- [x] Owner-only authentication selected and verified. (signed-cookie password session; Cloudflare Access recommended as extra layer)
- [x] Authorization checks on every private endpoint.
- [x] Audit events for important changes.
- [x] URL validation, safe rendering, request size limits, rate limits. (rate limit on login only)
- [ ] Backup/export and documented restore procedure.
- [ ] Production environment separation and secret handling.
- [ ] Integration tests against a disposable test database.
- [x] Verify that unauthorized requests receive 401/403 as expected.

## P3 — Reliability and decision quality
- [x] Source freshness indicators and recheck reminders. (stale badges: offers >30d, sources >90d; overview flags)
- [ ] Detect possible duplicate products/listings.
- [x] Keep historical offer snapshots instead of silent overwrite.
- [ ] Metric provenance, date range, attribution notes, nullable values.
- [ ] Portfolio comparison with confidence and caveats.
- [ ] Decision review dates and change history.
- [x] CSV import validation report with row-level errors.
- [ ] Data export and delete flows.

## MCP dual-stack (v0.3.0) — branch `feat/nalukesa-mcp-dual-stack`
- [x] Inbound MCP server `/mcp` (official SDK, stateless Streamable HTTP, JSON responses) with 5 read-only tools.
- [x] Scoped, expiring, revocable bearer tokens (hash-only storage), per-token rate limit, origin check, audit.
- [x] Shared domain services (`src/worker/domain.ts`) used by MCP tools.
- [x] Outbound hub: official SDK MCP client adapter, REST adapter, provider registry, SSRF guard, redaction.
- [x] Mock MCP + REST provider tests (local only); 57 unit tests; 57 MCP e2e checks; 34 API regression checks.
- [x] Owner UI: MCP & integrations page (tokens, tools, provider checks).
- [ ] OAuth 2.1 authorization for clients that require it (not implemented — documented limitation).
- [ ] Real provider integration (needs eligibility, terms, credentials and owner approval).
- [ ] Atomic/global rate limiting (current: best-effort D1 fixed window).

## Universal MCP OAuth gateway (v0.5.0, main)
- [x] RFC 9728 / RFC 8414 / OIDC discovery with issuer/resource/S256 checks and SSRF validation of every URL.
- [x] Registration strategies: CIMD, DCR (cached), pre-registered (none / basic / post) with encrypted secret.
- [x] Session-bound single-use hashed state, `iss` check, refresh rotation, reauth on failure, endpoint-only token injection.
- [x] Staged diagnostics + UI (Recommended / pre-registered, stages, Check OAuth, Re-authorize).
- [x] Unit tests (35) + gateway E2E smoke (102).
- [ ] Real third-party provider verified end-to-end (blocked: needs owner account/credentials).

## Generic external MCP connector (v0.4.0, main)
- [x] Connection registry in D1 (migration 0003), with credentials encrypted using AES-256-GCM (key held in a Cloudflare secret).
- [x] Streamable HTTP client via the official SDK: initialize, paginated tools/list, tools/call, session cleanup.
- [x] Auth: none, bearer, and OAuth 2.1 (discovery + DCR + PKCE + state + refresh).
- [x] Endpoint, DNS, and host-allowlist SSRF guard; no redirects; deadline also covers body reads; streaming byte cap.
- [x] Per-tool approval with risk classification and explicit write/destructive confirmation; approvals revoked on schema change.
- [x] Schema-validated invocation, normalized and redacted results with provenance, invocation log and audit trail.
- [x] Inbound bridge tools (read-only external tools only) and recursion guard.
- [x] Owner UI for connection management.
- [x] OAuth with pre-registered clients (v0.5.0).
- [ ] Custom auth header names.
- [ ] First real third-party provider (needs the owner's account and credentials).

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
