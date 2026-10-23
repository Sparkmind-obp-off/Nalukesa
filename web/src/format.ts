import type { FieldDef } from '../../src/shared/entities'
import { isSafeUrl } from '../../src/shared/validate'

const idr = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 })
const num = new Intl.NumberFormat('id-ID')

export function fmtIdr(v: unknown): string {
  return v === null || v === undefined || v === '' ? '' : idr.format(Number(v))
}
export function fmtNum(v: unknown): string {
  return v === null || v === undefined || v === '' ? '' : num.format(Number(v))
}

export function daysSince(date: string | null | undefined): number | null {
  if (!date) return null
  const d = new Date(date.slice(0, 10) + 'T00:00:00Z').getTime()
  if (Number.isNaN(d)) return null
  return Math.floor((Date.now() - d) / 86400000)
}

export type Tone = 'good' | 'warn' | 'bad' | 'neutral'
export function statusTone(s: string): Tone {
  if (['ok', 'configured', 'Active', 'Enabled', 'Verified', 'Scale candidate', 'Completed', 'Published', 'Disclosed in content', 'Own original', 'Licensed', 'Permission granted', 'A', 'High'].includes(s)) return 'good'
  if (['degraded', 'unavailable', 'not_configured', 'Revoked', 'Expired', 'Rejected', 'Stop', 'Cancelled', 'Unclear — do not publish', 'Not yet', 'D'].includes(s)) return 'bad'
  if (['Unverified', 'Testing', 'Running', 'Ready to test', 'Iterate', 'Approved', 'B', 'Medium'].includes(s)) return 'warn'
  return 'neutral'
}

export { isSafeUrl }
export type { FieldDef }
