/**
 * Outbound MCP client adapter (official SDK, Streamable HTTP transport).
 * Every network request made by the SDK passes through a guarded fetch that
 * enforces the destination allowlist, blocks redirects, applies a timeout and
 * caps response size. Credentials are injected server-side only.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker'
import { assertSafeDestination, DestinationBlocked, redact, type DestinationPolicy } from './safety'
import { DEFAULT_LIMITS, type HubLimits, type ProviderResult, type ProviderStatus } from './types'
import type { FetchLike } from './rest'

export interface McpCallOptions {
  providerId: string
  url: string
  policy: DestinationPolicy
  secret?: string
  limits?: Partial<HubLimits>
  fetchImpl?: FetchLike
  /** read-only tool names permitted for this provider (explicit allowlist) */
  allowedTools?: string[]
}

class HttpStatusError extends Error {
  constructor(public code: number) {
    super(`HTTP ${code}`)
  }
}

function guardedFetch(o: McpCallOptions, limits: HubLimits): FetchLike {
  const f = o.fetchImpl ?? fetch
  return async (input, init) => {
    const u = assertSafeDestination(String(input instanceof URL ? input.href : input), o.policy)
    const headers = new Headers(init?.headers)
    if (o.secret) headers.set('Authorization', `Bearer ${o.secret}`)
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), limits.timeoutMs)
    try {
      const res = await f(u.toString(), { ...init, headers, redirect: 'manual', signal: ctrl.signal })
      if (res.status >= 300 && res.status < 400) throw new DestinationBlocked('Redirects are not followed')
      if (res.status === 401 || res.status === 403 || res.status === 429) throw new HttpStatusError(res.status)
      const len = Number(res.headers.get('content-length') ?? '0')
      if (len > limits.maxResponseBytes) throw new Error('response_too_large')
      return res
    } finally {
      clearTimeout(timer)
    }
  }
}

function classify(e: unknown): { status: ProviderStatus; error: string } {
  if (e instanceof DestinationBlocked) return { status: 'blocked', error: e.message }
  if (e instanceof HttpStatusError) return { status: e.code === 429 ? 'rate_limited' : 'auth_failed', error: e.message }
  const err = e as Error
  if (err?.name === 'AbortError') return { status: 'unavailable', error: 'Timeout' }
  if (err?.message === 'response_too_large') return { status: 'invalid_response', error: 'Response too large' }
  // walk cause chain for our typed errors (SDK may wrap)
  let c: unknown = (err as { cause?: unknown })?.cause
  while (c) {
    if (c instanceof DestinationBlocked || c instanceof HttpStatusError) return classify(c)
    c = (c as { cause?: unknown }).cause
  }
  return { status: 'unavailable', error: err?.message ?? 'MCP error' }
}

async function withClient<T>(o: McpCallOptions, fn: (c: Client) => Promise<T>): Promise<ProviderResult<T>> {
  const limits = { ...DEFAULT_LIMITS, ...o.limits }
  const started = Date.now()
  const base = { provider_id: o.providerId, observed_at: new Date().toISOString() }
  let url: URL
  try {
    url = assertSafeDestination(o.url, o.policy)
  } catch (e) {
    return { ...base, ok: false, status: 'blocked', latency_ms: null, source_url: null, error: (e as Error).message }
  }
  const client = new Client({ name: 'nalukesa-hub', version: '0.3.0' }, { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() })
  const transport = new StreamableHTTPClientTransport(url, { fetch: guardedFetch(o, limits) })
  const overall = new Promise<never>((_, rej) => setTimeout(() => rej(Object.assign(new Error('Timeout'), { name: 'AbortError' })), limits.timeoutMs * 2))
  try {
    await Promise.race([client.connect(transport), overall])
    const data = await Promise.race([fn(client), overall])
    return { ...base, ok: true, status: 'available', latency_ms: Date.now() - started, source_url: url.origin + url.pathname, data }
  } catch (e) {
    const { status, error } = classify(e)
    return { ...base, ok: false, status, latency_ms: Date.now() - started, source_url: url.origin + url.pathname, error: redact(error, [o.secret]) }
  } finally {
    await client.close().catch(() => {})
  }
}

export function mcpListTools(o: McpCallOptions) {
  return withClient(o, async (c) => {
    const r = await c.listTools()
    return r.tools.map((t) => ({ name: t.name, description: t.description ?? null, read_only_hint: t.annotations?.readOnlyHint ?? null }))
  })
}

export function mcpCallTool(o: McpCallOptions, name: string, args: Record<string, unknown>) {
  if (!o.allowedTools?.includes(name)) {
    return Promise.resolve<ProviderResult>({
      ok: false,
      status: 'blocked',
      provider_id: o.providerId,
      observed_at: new Date().toISOString(),
      latency_ms: null,
      source_url: null,
      error: `Tool "${name}" is not on this provider's allowlist`,
    })
  }
  return withClient(o, async (c) => {
    const r = await c.callTool({ name, arguments: args })
    if (r.isError) throw new Error('Remote tool returned an error')
    return { content: r.content, structuredContent: r.structuredContent ?? null }
  })
}
