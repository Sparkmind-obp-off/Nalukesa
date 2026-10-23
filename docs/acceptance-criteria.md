# Acceptance Criteria & QA Checklist

## Product integrity
- [ ] Every metric shown is sourced or clearly labelled as a placeholder/demo.
- [ ] Unknown values render as “Not recorded” or equivalent, never as zero by default.
- [ ] Advertised commission and approved commission are distinct.
- [ ] Each evidence record has a source/locator and date when available.
- [ ] Interpretation is visibly distinct from direct observation.
- [ ] Volatile prices and commission terms display a checked-at date.
- [ ] Every scale decision has a rationale and links to supporting evidence.

## Core workflows
- [ ] Create, edit, view, filter, and export a niche.
- [ ] Create and edit a product with an exact listing URL and checked date.
- [ ] Record multiple offer snapshots without erasing prior values.
- [ ] Add sources and observations to a product/niche.
- [ ] Create an experiment with a hypothesis and decision rule before launch.
- [ ] Create a content brief without inventing product facts.
- [ ] Record publication URL and asset permission/disclosure status.
- [ ] Import a metrics CSV after previewing columns and row errors.
- [ ] Record results and a scale/iterate/hold/stop decision.
- [ ] Export records to a usable CSV and verify round-trip fields.

## Security
- [ ] Private routes and API endpoints reject unauthenticated access.
- [ ] User-entered text cannot execute as HTML or script.
- [ ] External links use safe protocols and safe target behavior.
- [ ] Secrets are absent from source, logs, frontend bundles, and errors.
- [ ] API inputs are validated; oversized requests are rejected.
- [ ] Import files are size-limited and parsed safely.
- [ ] Errors do not disclose credentials, internal tokens, or raw stack traces.
- [ ] Audit events avoid secrets and unnecessary personal data.

## UX and accessibility
- [ ] Works at phone, tablet, laptop, and wide desktop widths.
- [ ] Keyboard navigation and visible focus work throughout.
- [ ] Inputs have labels; status is not communicated by color alone.
- [ ] Tables have headings and usable mobile behavior.
- [ ] Empty/loading/error/success states are understandable.
- [ ] Destructive or externally visible actions require confirmation.
- [ ] Respect reduced-motion preference; animations are nonessential.
- [ ] Color contrast and text sizing are checked.

## Engineering
- [ ] Typecheck, lint, build, unit tests, and integration tests pass as applicable.
- [ ] Database migrations work from a clean database.
- [ ] Migration/rollback and backup notes exist.
- [ ] Health endpoint reveals no sensitive details.
- [ ] Production config is separate from local/test config.
- [ ] Deploy preview and production status are verified separately.

## Honest release notes
Release notes must state what changed, which tests ran and their result, what was deployed (if anything), the exact deployment reference where available, and remaining blockers. Never imply deployment or integration success without evidence.
