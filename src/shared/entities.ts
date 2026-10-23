/**
 * NALUKESA shared domain definitions.
 * Single source of truth for entity fields, used by the Worker API (validation,
 * SQL column whitelist, CSV) and by the web app (forms, tables).
 *
 * Rule: unknown data stays NULL. Empty inputs become null, never zero.
 */

export type FieldType =
  | 'text'
  | 'textarea'
  | 'url'
  | 'select'
  | 'int'
  | 'money'
  | 'percent'
  | 'date'
  | 'ref'

export type EntityKey =
  | 'niches'
  | 'products'
  | 'offer_snapshots'
  | 'evidence_sources'
  | 'observations'
  | 'experiments'
  | 'content_items'
  | 'performance_snapshots'
  | 'decisions'

export interface FieldDef {
  key: string
  label: string
  type: FieldType
  required?: boolean
  options?: readonly string[]
  ref?: EntityKey
  max?: number
  help?: string
  /** show as a column in list tables */
  list?: boolean
}

export interface EntityDef {
  key: EntityKey
  label: string
  singular: string
  /** column used as human-readable title */
  titleField: string
  fields: FieldDef[]
  /** append-only history: no update, no delete */
  appendOnly?: boolean
  searchable: string[]
  filterable: string[]
  csvImport: boolean
  description: string
}

export const LANE_STATUS = [
  'Hypothesis',
  'Researching',
  'Ready to test',
  'Testing',
  'Scale candidate',
  'Hold',
  'Rejected',
] as const

export const CONFIDENCE = ['Unrated', 'Low', 'Medium', 'High'] as const
export const EVIDENCE_GRADE = ['A', 'B', 'C', 'D'] as const
export const EVIDENCE_GRADE_HELP: Record<string, string> = {
  A: 'A — primary, verified (official terms, own dashboard)',
  B: 'B — direct public observation (listing seen first-hand)',
  C: 'C — secondary report',
  D: 'D — anecdotal / unclear',
}
export const PLATFORMS = ['Shopee', 'TikTok Shop', 'Tokopedia', 'Lazada', 'Other'] as const
export const CHANNELS = ['TikTok', 'Instagram', 'YouTube', 'Shopee Video', 'Blog', 'Other'] as const
export const DECISIONS = ['Scale candidate', 'Iterate', 'Hold', 'Stop'] as const
export const DECISION_TARGETS = ['niches', 'products', 'experiments', 'content_items'] as const

export const ENTITIES: Record<EntityKey, EntityDef> = {
  niches: {
    key: 'niches',
    label: 'Niches',
    singular: 'Niche',
    titleField: 'name',
    description: 'Hypotheses about audiences and problems. Unproven until evidence says otherwise.',
    searchable: ['name', 'audience', 'problem', 'hypothesis', 'notes'],
    filterable: ['status', 'confidence'],
    csvImport: true,
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true, max: 120, list: true },
      { key: 'status', label: 'Status', type: 'select', options: LANE_STATUS, required: true, list: true },
      { key: 'audience', label: 'Audience', type: 'text', max: 300, list: true },
      { key: 'problem', label: 'Audience problem', type: 'textarea', max: 2000 },
      { key: 'hypothesis', label: 'Hypothesis', type: 'textarea', max: 2000 },
      { key: 'confidence', label: 'Confidence', type: 'select', options: CONFIDENCE, required: true, list: true },
      { key: 'next_review_date', label: 'Next review', type: 'date', list: true },
      { key: 'notes', label: 'Notes', type: 'textarea', max: 4000 },
    ],
  },
  products: {
    key: 'products',
    label: 'Products',
    singular: 'Product',
    titleField: 'name',
    description: 'Exact listings under research. Prices and commission live in dated offer snapshots.',
    searchable: ['name', 'seller', 'listing_url', 'trust_notes'],
    filterable: ['niche_id', 'platform', 'status'],
    csvImport: true,
    fields: [
      { key: 'name', label: 'Product / listing name', type: 'text', required: true, max: 200, list: true },
      { key: 'niche_id', label: 'Niche', type: 'ref', ref: 'niches', required: true, list: true },
      { key: 'platform', label: 'Platform', type: 'select', options: PLATFORMS, required: true, list: true },
      { key: 'listing_url', label: 'Exact listing URL', type: 'url', required: true, max: 2000 },
      { key: 'seller', label: 'Seller', type: 'text', max: 200, list: true },
      { key: 'status', label: 'Status', type: 'select', options: LANE_STATUS, required: true, list: true },
      { key: 'checked_at', label: 'Date checked', type: 'date', list: true },
      { key: 'trust_notes', label: 'Trust / compliance notes', type: 'textarea', max: 4000 },
    ],
  },
  offer_snapshots: {
    key: 'offer_snapshots',
    label: 'Offer snapshots',
    singular: 'Offer snapshot',
    titleField: 'checked_at',
    appendOnly: true,
    description: 'Append-only history of price and advertised commission. Never overwritten.',
    searchable: ['commission_basis', 'source_note'],
    filterable: ['product_id'],
    csvImport: true,
    fields: [
      { key: 'product_id', label: 'Product', type: 'ref', ref: 'products', required: true, list: true },
      { key: 'checked_at', label: 'Checked on', type: 'date', required: true, list: true },
      { key: 'price_idr', label: 'Price (IDR)', type: 'money', list: true },
      { key: 'advertised_commission_pct', label: 'Advertised commission %', type: 'percent', list: true,
        help: 'Advertised rate only. Approved/earned commission is recorded in performance snapshots.' },
      { key: 'commission_basis', label: 'Commission basis', type: 'text', max: 300 },
      { key: 'terms_url', label: 'Terms URL', type: 'url', max: 2000 },
      { key: 'recheck_by', label: 'Recheck by', type: 'date', list: true },
      { key: 'source_note', label: 'Source note', type: 'textarea', max: 2000 },
    ],
  },
  evidence_sources: {
    key: 'evidence_sources',
    label: 'Evidence sources',
    singular: 'Evidence source',
    titleField: 'title',
    description: 'Where a claim comes from, when it was accessed, and how strong it is.',
    searchable: ['title', 'publisher', 'url', 'notes'],
    filterable: ['evidence_grade', 'source_type'],
    csvImport: true,
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true, max: 300, list: true },
      { key: 'source_type', label: 'Source type', type: 'select', required: true, list: true,
        options: ['Platform listing', 'Official terms', 'Own dashboard', 'Public report', 'Social post', 'Other'] },
      { key: 'url', label: 'URL', type: 'url', max: 2000 },
      { key: 'publisher', label: 'Publisher', type: 'text', max: 200, list: true },
      { key: 'published_at', label: 'Published on', type: 'date' },
      { key: 'accessed_at', label: 'Accessed on', type: 'date', required: true, list: true },
      { key: 'evidence_grade', label: 'Evidence grade', type: 'select', options: EVIDENCE_GRADE, required: true, list: true,
        help: 'A primary verified · B direct public observation · C secondary · D anecdotal' },
      { key: 'notes', label: 'Caveats / notes', type: 'textarea', max: 4000 },
    ],
  },
  observations: {
    key: 'observations',
    label: 'Observations',
    singular: 'Observation',
    titleField: 'observed_fact',
    description: 'Directly observed facts kept separate from interpretation.',
    searchable: ['observed_fact', 'interpretation', 'caveats'],
    filterable: ['source_id', 'niche_id', 'product_id', 'confidence'],
    csvImport: true,
    fields: [
      { key: 'observed_fact', label: 'Observed fact', type: 'textarea', required: true, max: 2000, list: true },
      { key: 'source_id', label: 'Source', type: 'ref', ref: 'evidence_sources', required: true, list: true },
      { key: 'niche_id', label: 'Niche', type: 'ref', ref: 'niches', list: true },
      { key: 'product_id', label: 'Product', type: 'ref', ref: 'products', list: true },
      { key: 'observed_at', label: 'Observed on', type: 'date', required: true, list: true },
      { key: 'interpretation', label: 'Interpretation (not fact)', type: 'textarea', max: 2000 },
      { key: 'confidence', label: 'Confidence', type: 'select', options: CONFIDENCE, required: true, list: true },
      { key: 'caveats', label: 'Caveats', type: 'textarea', max: 2000 },
    ],
  },
  experiments: {
    key: 'experiments',
    label: 'Experiments',
    singular: 'Experiment',
    titleField: 'name',
    description: 'Bounded tests with decision rules registered before launch.',
    searchable: ['name', 'hypothesis', 'decision_rule', 'scope'],
    filterable: ['niche_id', 'status'],
    csvImport: true,
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true, max: 200, list: true },
      { key: 'niche_id', label: 'Niche', type: 'ref', ref: 'niches', required: true, list: true },
      { key: 'status', label: 'Status', type: 'select', options: ['Planned', 'Running', 'Completed', 'Cancelled'], required: true, list: true },
      { key: 'hypothesis', label: 'Hypothesis', type: 'textarea', required: true, max: 2000 },
      { key: 'scope', label: 'Scope', type: 'textarea', max: 2000 },
      { key: 'start_date', label: 'Start', type: 'date', list: true },
      { key: 'review_date', label: 'Review', type: 'date', list: true },
      { key: 'duration_days', label: 'Duration (days)', type: 'int' },
      { key: 'content_target', label: 'Content pieces target', type: 'int' },
      { key: 'primary_metric', label: 'Primary metric', type: 'text', required: true, max: 200, list: true },
      { key: 'time_cap_hours', label: 'Time cap (hours)', type: 'int' },
      { key: 'budget_cap_idr', label: 'Budget cap (IDR)', type: 'money' },
      { key: 'decision_rule', label: 'Pre-registered decision rule', type: 'textarea', required: true, max: 3000 },
    ],
  },
  content_items: {
    key: 'content_items',
    label: 'Content',
    singular: 'Content item',
    titleField: 'title',
    description: 'Briefs and published pieces with disclosure and asset-rights status.',
    searchable: ['title', 'creative_angle', 'proof_point', 'published_url'],
    filterable: ['experiment_id', 'product_id', 'channel', 'status'],
    csvImport: true,
    fields: [
      { key: 'title', label: 'Working title', type: 'text', required: true, max: 200, list: true },
      { key: 'experiment_id', label: 'Experiment', type: 'ref', ref: 'experiments', list: true },
      { key: 'product_id', label: 'Product', type: 'ref', ref: 'products', list: true },
      { key: 'channel', label: 'Channel', type: 'select', options: CHANNELS, required: true, list: true },
      { key: 'status', label: 'Status', type: 'select', options: ['Draft', 'Approved', 'Published', 'Archived'], required: true, list: true },
      { key: 'creative_angle', label: 'Creative angle', type: 'text', max: 300 },
      { key: 'proof_point', label: 'Verified proof point', type: 'textarea', max: 2000,
        help: 'Only facts you have verified. Never invent personal product experience.' },
      { key: 'caveats', label: 'Caveats / limitations', type: 'textarea', max: 2000 },
      { key: 'cta', label: 'Call to action', type: 'text', max: 300 },
      { key: 'disclosure_status', label: 'Affiliate disclosure', type: 'select', required: true, list: true,
        options: ['Not yet', 'Disclosed in content', 'Not applicable'] },
      { key: 'asset_rights', label: 'Asset rights', type: 'select', required: true, list: true,
        options: ['Own original', 'Licensed', 'Permission granted', 'Unclear — do not publish'] },
      { key: 'published_url', label: 'Published URL', type: 'url', max: 2000 },
      { key: 'published_at', label: 'Published on', type: 'date', list: true },
    ],
  },
  performance_snapshots: {
    key: 'performance_snapshots',
    label: 'Performance',
    singular: 'Performance snapshot',
    titleField: 'period_end',
    appendOnly: true,
    description: 'Real figures for a period. Blank means not recorded — never zero.',
    searchable: ['data_source', 'attribution_notes'],
    filterable: ['content_item_id'],
    csvImport: true,
    fields: [
      { key: 'content_item_id', label: 'Content item', type: 'ref', ref: 'content_items', required: true, list: true },
      { key: 'period_start', label: 'Period start', type: 'date', required: true, list: true },
      { key: 'period_end', label: 'Period end', type: 'date', required: true, list: true },
      { key: 'views', label: 'Views', type: 'int', list: true },
      { key: 'clicks', label: 'Clicks', type: 'int', list: true },
      { key: 'orders', label: 'Orders', type: 'int', list: true },
      { key: 'approved_commission_idr', label: 'Approved commission (IDR)', type: 'money', list: true },
      { key: 'cancellations_returns', label: 'Cancellations / returns', type: 'int', list: true },
      { key: 'data_source', label: 'Data source', type: 'text', required: true, max: 300,
        help: 'e.g. "Shopee Affiliate dashboard export, 2026-10-20"' },
      { key: 'attribution_notes', label: 'Attribution notes', type: 'textarea', max: 2000 },
    ],
  },
  decisions: {
    key: 'decisions',
    label: 'Decisions',
    singular: 'Decision',
    titleField: 'decision',
    appendOnly: true,
    description: 'Append-only log. A newer decision supersedes an older one; history is kept.',
    searchable: ['rationale', 'evidence_refs', 'owner'],
    filterable: ['entity_type', 'decision'],
    csvImport: false,
    fields: [
      { key: 'entity_type', label: 'Applies to', type: 'select', options: DECISION_TARGETS, required: true, list: true },
      { key: 'entity_id', label: 'Record ID', type: 'int', required: true, list: true },
      { key: 'decision', label: 'Decision', type: 'select', options: DECISIONS, required: true, list: true },
      { key: 'rationale', label: 'Rationale', type: 'textarea', required: true, max: 4000 },
      { key: 'evidence_refs', label: 'Evidence references', type: 'text', max: 500,
        help: 'Observation / source / snapshot IDs, e.g. "obs:3, src:5, perf:2"' },
      { key: 'owner', label: 'Owner', type: 'text', max: 120, list: true },
      { key: 'decided_at', label: 'Decided on', type: 'date', required: true, list: true },
      { key: 'next_review_at', label: 'Next review', type: 'date', list: true },
    ],
  },
}

export const ENTITY_KEYS = Object.keys(ENTITIES) as EntityKey[]

export function isEntityKey(v: string): v is EntityKey {
  return (ENTITY_KEYS as string[]).includes(v)
}

export function fieldKeys(e: EntityKey): string[] {
  return ENTITIES[e].fields.map((f) => f.key)
}
