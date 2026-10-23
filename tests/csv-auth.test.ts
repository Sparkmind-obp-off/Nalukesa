import { describe, it, expect } from 'vitest'
import { parseCsv, toCsv } from '../src/shared/csv'
import { createSession, verifySession, passwordMatches, SESSION_TTL_S } from '../src/worker/auth'

describe('csv', () => {
  it('round-trips quotes, commas, newlines and nulls', () => {
    const rows = [{ a: 'x, "y"', b: 'line1\nline2', c: null }]
    const text = toCsv(['a', 'b', 'c'], rows)
    const parsed = parseCsv(text)
    expect(parsed[0]).toEqual(['a', 'b', 'c'])
    expect(parsed[1]).toEqual(['x, "y"', 'line1\nline2', ''])
  })
  it('neutralizes formula injection on export', () => {
    expect(toCsv(['a'], [{ a: '=HYPERLINK("x")' }])).toContain("'=HYPERLINK")
  })
  it('strips BOM and handles CRLF', () => {
    expect(parseCsv('\ufeffname,status\r\nBeauty,Hypothesis\r\n')).toEqual([['name', 'status'], ['Beauty', 'Hypothesis']])
  })
})

describe('auth', () => {
  const secret = 'x'.repeat(40)
  it('verifies a fresh session and rejects tampering', async () => {
    const t = await createSession(secret)
    expect(await verifySession(secret, t)).toBe(true)
    expect(await verifySession('y'.repeat(40), t)).toBe(false)
    expect(await verifySession(secret, t.slice(0, -2) + 'aa')).toBe(false)
    expect(await verifySession(secret, undefined)).toBe(false)
    expect(await verifySession(secret, 'garbage')).toBe(false)
  })
  it('rejects expired sessions', async () => {
    const now = 1_000_000
    const t = await createSession(secret, now)
    expect(await verifySession(secret, t, now + SESSION_TTL_S + 1)).toBe(false)
  })
  it('compares passwords', async () => {
    expect(await passwordMatches('abc', 'abc')).toBe(true)
    expect(await passwordMatches('abd', 'abc')).toBe(false)
    expect(await passwordMatches('', 'abc')).toBe(false)
  })
})
