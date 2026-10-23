import { describe, it, expect } from 'vitest'
import { bearer, generateToken, parseScopes, TOKEN_PREFIX } from '../src/worker/mcp/tokens'
import { summarizeMetrics, daysSince } from '../src/worker/domain'

describe('mcp tokens', () => {
  it('generates prefixed high-entropy tokens', () => {
    const a = generateToken()
    const b = generateToken()
    expect(a.startsWith(TOKEN_PREFIX)).toBe(true)
    expect(a.length).toBeGreaterThan(40)
    expect(a).not.toBe(b)
  })
  it('parses bearer header strictly', () => {
    expect(bearer('Bearer nkmcp_abcdefghijkl')).toBe('nkmcp_abcdefghijkl')
    expect(bearer('bearer nkmcp_abcdefghijkl')).toBeNull()
    expect(bearer('Basic abc')).toBeNull()
    expect(bearer(undefined)).toBeNull()
    expect(bearer('Bearer short')).toBeNull()
  })
  it('validates scopes against allowlist', () => {
    expect(parseScopes(['products:read', 'products:read'])).toEqual(['products:read'])
    expect(parseScopes(['admin'])).toBeNull()
    expect(parseScopes([])).toBeNull()
    expect(parseScopes('products:read')).toBeNull()
  })
})

describe('domain helpers', () => {
  it('summarizeMetrics keeps unknown as null, not zero', () => {
    const t = summarizeMetrics([
      { views: 100, clicks: null, orders: null, approved_commission_idr: null, cancellations_returns: null },
      { views: null, clicks: 5, orders: null, approved_commission_idr: null, cancellations_returns: null },
    ])
    expect(t.views).toEqual({ sum: 100, recorded_in: 1, of_snapshots: 2 })
    expect(t.clicks).toEqual({ sum: 5, recorded_in: 1, of_snapshots: 2 })
    expect(t.orders.sum).toBeNull()
    expect(t.approved_commission_idr.sum).toBeNull()
  })
  it('summarizeMetrics on empty is all null', () => {
    expect(summarizeMetrics([]).views).toEqual({ sum: null, recorded_in: 0, of_snapshots: 0 })
  })
  it('daysSince', () => {
    expect(daysSince('2026-10-01', Date.parse('2026-10-11T00:00:00Z'))).toBe(10)
    expect(daysSince(null)).toBeNull()
  })
})
