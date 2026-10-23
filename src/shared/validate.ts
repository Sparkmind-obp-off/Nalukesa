import { ENTITIES, type EntityKey, type FieldDef } from './entities'

export type Row = Record<string, string | number | null>
export interface FieldError {
  field: string
  message: string
}
export type ValidationResult =
  | { ok: true; value: Row }
  | { ok: false; errors: FieldError[] }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function isValidDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false
  const d = new Date(s + 'T00:00:00Z')
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

/** Only http(s) URLs are accepted; blocks javascript:, data:, etc. */
export function isSafeUrl(s: string): boolean {
  try {
    const u = new URL(s)
    return (u.protocol === 'https:' || u.protocol === 'http:') && !!u.hostname
  } catch {
    return false
  }
}

function coerce(f: FieldDef, raw: unknown): { value: string | number | null } | { error: string } {
  if (raw === undefined || raw === null) return { value: null }
  if (typeof raw !== 'string' && typeof raw !== 'number') return { error: 'Invalid value type' }
  const s = String(raw).trim()
  // Unknown stays unknown: blank input is NULL, never zero.
  if (s === '') return { value: null }

  switch (f.type) {
    case 'text':
    case 'textarea': {
      const max = f.max ?? 2000
      if (s.length > max) return { error: `Max ${max} characters` }
      return { value: s }
    }
    case 'url': {
      if (s.length > (f.max ?? 2000)) return { error: 'URL too long' }
      if (!isSafeUrl(s)) return { error: 'Must be a valid http(s) URL' }
      return { value: s }
    }
    case 'select': {
      if (!f.options?.includes(s)) return { error: `Must be one of: ${f.options?.join(', ')}` }
      return { value: s }
    }
    case 'date': {
      if (!isValidDate(s)) return { error: 'Use date format YYYY-MM-DD' }
      return { value: s }
    }
    case 'int':
    case 'money':
    case 'ref': {
      const cleaned = f.type === 'money' ? s.replace(/[.,\s]/g, '').replace(/^rp/i, '') : s
      if (!/^\d+$/.test(cleaned)) return { error: 'Must be a whole number ≥ 0' }
      const n = Number(cleaned)
      if (!Number.isSafeInteger(n)) return { error: 'Number too large' }
      if (f.type === 'ref' && n < 1) return { error: 'Invalid reference' }
      return { value: n }
    }
    case 'percent': {
      const cleaned = s.replace('%', '').replace(',', '.')
      if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return { error: 'Percent like 7.5 (max 2 decimals)' }
      const n = Number(cleaned)
      if (n < 0 || n > 100) return { error: 'Must be between 0 and 100' }
      return { value: n }
    }
  }
}

/**
 * Validate and normalize an input object for an entity.
 * mode 'create': all required fields must be present.
 * mode 'update': only supplied fields are validated; required fields cannot be cleared.
 */
export function validateEntity(
  entity: EntityKey,
  input: unknown,
  mode: 'create' | 'update' = 'create',
): ValidationResult {
  const def = ENTITIES[entity]
  const errors: FieldError[] = []
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: [{ field: '_', message: 'Body must be a JSON object' }] }
  }
  const obj = input as Record<string, unknown>
  const known = new Set(def.fields.map((f) => f.key))
  for (const k of Object.keys(obj)) {
    if (!known.has(k)) errors.push({ field: k, message: 'Unknown field' })
  }
  const value: Row = {}
  for (const f of def.fields) {
    const present = Object.prototype.hasOwnProperty.call(obj, f.key)
    if (mode === 'update' && !present) continue
    const r = coerce(f, obj[f.key])
    if ('error' in r) {
      errors.push({ field: f.key, message: r.error })
      continue
    }
    if (f.required && r.value === null) {
      errors.push({ field: f.key, message: 'Required' })
      continue
    }
    value[f.key] = r.value
  }
  // Cross-field rules
  if (entity === 'performance_snapshots' && typeof value.period_start === 'string' && typeof value.period_end === 'string') {
    if (value.period_end < value.period_start) errors.push({ field: 'period_end', message: 'Must be on or after period start' })
  }
  if (entity === 'experiments' && typeof value.start_date === 'string' && typeof value.review_date === 'string') {
    if (value.review_date < value.start_date) errors.push({ field: 'review_date', message: 'Must be on or after start date' })
  }
  if (entity === 'content_items' && value.status === 'Published') {
    if (value.asset_rights === 'Unclear — do not publish') errors.push({ field: 'asset_rights', message: 'Resolve asset rights before marking as Published' })
    if (value.disclosure_status === 'Not yet') errors.push({ field: 'disclosure_status', message: 'Affiliate disclosure required before Published' })
  }
  if (mode === 'update' && Object.keys(value).length === 0 && errors.length === 0) {
    errors.push({ field: '_', message: 'No fields to update' })
  }
  return errors.length ? { ok: false, errors } : { ok: true, value }
}
