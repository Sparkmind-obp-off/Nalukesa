import { describe, it, expect } from 'vitest'
import { validateEntity, isSafeUrl, isValidDate } from '../src/shared/validate'

describe('isSafeUrl', () => {
  it('accepts http(s)', () => {
    expect(isSafeUrl('https://shopee.co.id/product/1')).toBe(true)
    expect(isSafeUrl('http://example.com')).toBe(true)
  })
  it('rejects dangerous schemes', () => {
    expect(isSafeUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeUrl('data:text/html,<script>')).toBe(false)
    expect(isSafeUrl('ftp://x.com')).toBe(false)
    expect(isSafeUrl('not a url')).toBe(false)
  })
})

describe('isValidDate', () => {
  it('validates real calendar dates', () => {
    expect(isValidDate('2026-10-23')).toBe(true)
    expect(isValidDate('2026-02-30')).toBe(false)
    expect(isValidDate('23/10/2026')).toBe(false)
  })
})

describe('validateEntity — unknown stays unknown', () => {
  it('blank metrics become null, not zero', () => {
    const r = validateEntity('performance_snapshots', {
      content_item_id: '1', period_start: '2026-10-01', period_end: '2026-10-07',
      views: '', clicks: '12', orders: '', approved_commission_idr: '', cancellations_returns: '',
      data_source: 'Shopee dashboard export',
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.views).toBeNull()
      expect(r.value.orders).toBeNull()
      expect(r.value.approved_commission_idr).toBeNull()
      expect(r.value.clicks).toBe(12)
    }
  })
  it('requires required fields', () => {
    const r = validateEntity('niches', { name: '' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.map((e) => e.field)).toContain('name')
  })
  it('rejects unknown fields (mass assignment)', () => {
    const r = validateEntity('niches', { name: 'Beauty', status: 'Hypothesis', confidence: 'Low', id: 5 })
    expect(r.ok).toBe(false)
  })
  it('rejects unsafe listing URL', () => {
    const r = validateEntity('products', { name: 'X', niche_id: '1', platform: 'Shopee', listing_url: 'javascript:alert(1)', status: 'Researching' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0].field).toBe('listing_url')
  })
  it('parses IDR money formats to integers', () => {
    const r = validateEntity('offer_snapshots', { product_id: '1', checked_at: '2026-10-20', price_idr: 'Rp 149.000', advertised_commission_pct: '7,5' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.price_idr).toBe(149000)
      expect(r.value.advertised_commission_pct).toBe(7.5)
    }
  })
  it('rejects negative numbers and percent > 100', () => {
    expect(validateEntity('offer_snapshots', { product_id: '1', checked_at: '2026-10-20', price_idr: '-5' }).ok).toBe(false)
    expect(validateEntity('offer_snapshots', { product_id: '1', checked_at: '2026-10-20', advertised_commission_pct: '120' }).ok).toBe(false)
  })
  it('enforces select options', () => {
    expect(validateEntity('decisions', { entity_type: 'niches', entity_id: '1', decision: 'Yolo', rationale: 'x', decided_at: '2026-10-23' }).ok).toBe(false)
  })
  it('blocks Published content without disclosure or with unclear rights', () => {
    const base = { title: 'T', channel: 'TikTok', status: 'Published', disclosure_status: 'Not yet', asset_rights: 'Own original' }
    const r = validateEntity('content_items', base)
    expect(r.ok).toBe(false)
    const r2 = validateEntity('content_items', { ...base, disclosure_status: 'Disclosed in content', asset_rights: 'Unclear — do not publish' })
    expect(r2.ok).toBe(false)
    const r3 = validateEntity('content_items', { ...base, disclosure_status: 'Disclosed in content' })
    expect(r3.ok).toBe(true)
  })
  it('period end must be after start', () => {
    const r = validateEntity('performance_snapshots', { content_item_id: '1', period_start: '2026-10-07', period_end: '2026-10-01', data_source: 'x' })
    expect(r.ok).toBe(false)
  })
  it('update mode only validates supplied fields', () => {
    const r = validateEntity('niches', { notes: 'hello' }, 'update')
    expect(r.ok).toBe(true)
    const r2 = validateEntity('niches', { name: '' }, 'update')
    expect(r2.ok).toBe(false)
  })
})
