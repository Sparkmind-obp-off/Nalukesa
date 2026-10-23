/**
 * Generic read-only REST adapter with timeout, size cap, safe retry (GET only,
 * only on network error / 5xx / 429 with short backoff), no redirects, and
 * normalized + redacted errors.
 */
import { assertSafeDestination, DestinationBlocked, redact, type DestinationPolicy } from './safety'
import { DEFAULT_LIMITS, type HubLimits, type ProviderResult, type ProviderStatus } from './types'

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

export interface RestCallOptions {
  providerId: string
  url: string
  policy: DestinationPolicy
  secret?: string
  /** header used for credential; defaults to Authorization: Bearer */
  authHeader?: string
  limits?: Partial<HubLimits>
  fetchImpl?: FetchLike
}

async function readCapped(res: Response, max: number): Promise<string> {
  const len = Number(res.headers.get('content-length') ?? '0')
  if (len > max) throw new Error('response_too_large')
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel()
      throw new Error('response_too_large')
    }
    chunks.push(value)
  }
  const all = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    all.set(c, off)
    off += c.byteLength
  }
  return new TextDecoder().decode(all)
}

function statusFor(code: number): ProviderStatus {
  if (code === 401 || code === 403) return 'auth_failed'
  if (code === 429) return 'rate_limited'
  return 'unavailable'
}

export async function restGetJson<T = unknown>(o: RestCallOptions, validate?: (d: unknown) => d is T): Promise<ProviderResult<T>> {
  const limits = { ...DEFAULT_LIMITS, ...o.limits }
  const f = o.fetchImpl ?? fetch
  const started = Date.now()
  const base = { provider_id: o.providerId, observed_at: new Date().toISOString(), source_url: null as string | null }
  let url: URL
  try {
    url = assertSafeDestination(o.url, o.policy)
  } catch (e) {
    return { ...base, ok: false, status: 'blocked', latency_ms: null, error: e instanceof DestinationBlocked ? e.message : 'blocked' }
  }
  base.source_url = url.origin + url.pathname
  const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'NALUKESA-Hub/1' }
  if (o.secret) {
    if (o.authHeader && o.authHeader.toLowerCase() !== 'authorization') headers[o.authHeader] = o.secret
    else headers.Authorization = `Bearer ${o.secret}`
  }

  let attempt = 0
  for (;;) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), limits.timeoutMs)
    try {
      const res = await f(url.toString(), { method: 'GET', headers, redirect: 'manual', signal: ctrl.signal })
      if (res.status >= 300 && res.status < 400) {
        return { ...base, ok: false, status: 'blocked', latency_ms: Date.now() - started, error: 'Redirects are not followed' }
      }
      if (!res.ok) {
        const retryable = res.status >= 500 || res.status === 429
        if (retryable && attempt < limits.maxRetries) {
          attempt++
          await new Promise((r) => setTimeout(r, 200 * attempt))
          continue
        }
        return { ...base, ok: false, status: statusFor(res.status), latency_ms: Date.now() - started, error: `HTTP ${res.status}` }
      }
      const text = await readCapped(res, limits.maxResponseBytes)
      let data: unknown
      try {
        data = JSON.parse(text)
      } catch {
        return { ...base, ok: false, status: 'invalid_response', latency_ms: Date.now() - started, error: 'Malformed JSON' }
      }
      if (validate && !validate(data)) {
        return { ...base, ok: false, status: 'invalid_response', latency_ms: Date.now() - started, error: 'Response failed schema validation' }
      }
      return { ...base, ok: true, status: 'available', latency_ms: Date.now() - started, data: data as T }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg === 'response_too_large') return { ...base, ok: false, status: 'invalid_response', latency_ms: Date.now() - started, error: 'Response too large' }
      const aborted = (e as Error)?.name === 'AbortError'
      if (!aborted && attempt < limits.maxRetries) {
        attempt++
        await new Promise((r) => setTimeout(r, 200 * attempt))
        continue
      }
      return { ...base, ok: false, status: 'unavailable', latency_ms: Date.now() - started, error: aborted ? 'Timeout' : redact(msg, [o.secret]) }
    } finally {
      clearTimeout(timer)
    }
  }
}
