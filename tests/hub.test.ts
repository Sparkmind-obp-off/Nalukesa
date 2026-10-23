/**
 * Outbound MCP Hub tests against deterministic LOCAL mock servers only.
 * No external network is contacted.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'
import { restGetJson } from '../src/worker/hub/rest'
import { mcpListTools, mcpCallTool } from '../src/worker/hub/mcpClient'
import { assertSafeDestination, redact, DestinationBlocked } from '../src/worker/hub/safety'
import { checkProvider, configStatus, PROVIDERS } from '../src/worker/hub/registry'

const SECRET = 'sk_test_super_secret_value_123'
let server: Server
let base = ''
let hostPort = ''
const seenAuth: string[] = []

async function mockMcp(req: Request): Promise<Response> {
  const s = new McpServer({ name: 'mock-provider', version: '1.0.0' })
  s.registerTool('echo', { description: 'Echo', inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } }, async ({ text }) => ({
    content: [{ type: 'text', text: `echo:${text}` }],
  }))
  s.registerTool('delete_everything', { description: 'Dangerous', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'should never run' }] }))
  const t = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  await s.connect(t)
  return t.handleRequest(req)
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    seenAuth.push(String(req.headers.authorization ?? ''))
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const send = (code: number, body: string, headers: Record<string, string> = { 'content-type': 'application/json' }) => {
      res.writeHead(code, headers)
      res.end(body)
    }
    switch (url.pathname) {
      case '/ok':
        return send(200, JSON.stringify({ items: [1, 2, 3] }))
      case '/slow':
        return setTimeout(() => send(200, '{}'), 1500)
      case '/auth':
        return send(401, JSON.stringify({ error: `bad key ${req.headers.authorization}` }))
      case '/rate':
        return send(429, '{}')
      case '/malformed':
        return send(200, '{not json')
      case '/big':
        return send(200, JSON.stringify({ blob: 'x'.repeat(200_000) }))
      case '/redirect':
        return send(302, '', { location: 'http://169.254.169.254/latest/meta-data' })
      case '/mcp-auth':
        return send(401, '{}')
      case '/mcp': {
        const chunks: Buffer[] = []
        for await (const c of req) chunks.push(c as Buffer)
        const headers = new Headers()
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v)
        const r = await mockMcp(new Request(`http://127.0.0.1${url.pathname}`, { method: req.method, headers, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined }))
        res.writeHead(r.status, Object.fromEntries(r.headers.entries()))
        return res.end(Buffer.from(await r.arrayBuffer()))
      }
      default:
        return send(404, '{}')
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as AddressInfo).port
  base = `http://127.0.0.1:${port}`
  hostPort = `127.0.0.1:${port}`
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))

const policy = () => ({ allowedHosts: [hostPort], allowInsecureLocalForTests: true })

describe('destination safety (SSRF)', () => {
  const prod = { allowedHosts: ['api.example.com'] }
  it('allows allowlisted https host', () => {
    expect(assertSafeDestination('https://api.example.com/v1', prod).hostname).toBe('api.example.com')
  })
  it.each([
    ['http://api.example.com/', 'Only https'],
    ['https://evil.com/', 'allowlist'],
    ['https://127.0.0.1/', 'IP literal'],
    ['https://169.254.169.254/latest', 'IP literal'],
    ['https://[::1]/', 'IP literal'],
    ['https://2130706433/', 'IP literal'],
    ['https://localhost/', 'Internal'],
    ['https://db.internal/', 'Internal'],
    ['https://api.example.com:8443/', 'Non-default port'],
    ['https://user:pw@api.example.com/', 'Credentials'],
    ['file:///etc/passwd', 'Only https'],
    ['not a url', 'Invalid'],
  ])('blocks %s', (url, reason) => {
    expect(() => assertSafeDestination(url, prod)).toThrow(DestinationBlocked)
    expect(() => assertSafeDestination(url, prod)).toThrow(new RegExp(reason, 'i'))
  })
  it('local test mode still requires exact host:port on allowlist', () => {
    expect(() => assertSafeDestination('http://127.0.0.1:1/', { allowedHosts: ['127.0.0.1:2'], allowInsecureLocalForTests: true })).toThrow()
  })
  it('redacts secrets and bearer tokens', () => {
    const t = redact(`failed Authorization: Bearer abc.def ${SECRET} token=xyz nkmcp_ABCDEF`, [SECRET])
    expect(t).not.toContain(SECRET)
    expect(t).not.toContain('abc.def')
    expect(t).not.toContain('xyz')
    expect(t).not.toContain('nkmcp_ABCDEF')
  })
})

describe('REST adapter', () => {
  it('returns data with provenance on success and sends credential server-side', async () => {
    const r = await restGetJson({ providerId: 'p', url: `${base}/ok`, policy: policy(), secret: SECRET })
    expect(r.ok).toBe(true)
    expect(r.status).toBe('available')
    expect(r.source_url).toBe(`${base}/ok`)
    expect(r.observed_at).toMatch(/^\d{4}-/)
    expect(seenAuth.at(-1)).toBe(`Bearer ${SECRET}`)
    expect(JSON.stringify(r)).not.toContain(SECRET)
  })
  it('times out', async () => {
    const r = await restGetJson({ providerId: 'p', url: `${base}/slow`, policy: policy(), limits: { timeoutMs: 200, maxRetries: 0 } })
    expect(r.status).toBe('unavailable')
    expect(r.error).toBe('Timeout')
  })
  it('maps 401 to auth_failed without leaking the key', async () => {
    const r = await restGetJson({ providerId: 'p', url: `${base}/auth`, policy: policy(), secret: SECRET })
    expect(r.status).toBe('auth_failed')
    expect(JSON.stringify(r)).not.toContain(SECRET)
  })
  it('maps 429 to rate_limited after bounded retry', async () => {
    const r = await restGetJson({ providerId: 'p', url: `${base}/rate`, policy: policy(), limits: { maxRetries: 1 } })
    expect(r.status).toBe('rate_limited')
  })
  it('rejects malformed JSON', async () => {
    const r = await restGetJson({ providerId: 'p', url: `${base}/malformed`, policy: policy() })
    expect(r.status).toBe('invalid_response')
  })
  it('rejects schema-invalid response', async () => {
    const isStrings = (d: unknown): d is { items: string[] } => !!d && Array.isArray((d as { items: unknown }).items) && (d as { items: unknown[] }).items.every((x) => typeof x === 'string')
    const r = await restGetJson({ providerId: 'p', url: `${base}/ok`, policy: policy() }, isStrings)
    expect(r.status).toBe('invalid_response')
  })
  it('enforces response size cap', async () => {
    const r = await restGetJson({ providerId: 'p', url: `${base}/big`, policy: policy(), limits: { maxResponseBytes: 10_000 } })
    expect(r.status).toBe('invalid_response')
    expect(r.error).toMatch(/too large/)
  })
  it('does not follow redirects (SSRF via redirect)', async () => {
    const r = await restGetJson({ providerId: 'p', url: `${base}/redirect`, policy: policy() })
    expect(r.status).toBe('blocked')
  })
  it('blocks non-allowlisted destination before any request', async () => {
    const before = seenAuth.length
    const r = await restGetJson({ providerId: 'p', url: 'https://evil.example/', policy: { allowedHosts: [] } })
    expect(r.status).toBe('blocked')
    expect(seenAuth.length).toBe(before)
  })
})

describe('MCP client adapter (official SDK) against local mock MCP server', () => {
  it('lists tools', async () => {
    const r = await mcpListTools({ providerId: 'm', url: `${base}/mcp`, policy: policy(), secret: SECRET })
    expect(r.ok).toBe(true)
    const names = (r.data as { name: string }[]).map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(['echo', 'delete_everything']))
    expect(seenAuth.at(-1)).toBe(`Bearer ${SECRET}`)
  })
  it('calls an allowlisted tool', async () => {
    const r = await mcpCallTool({ providerId: 'm', url: `${base}/mcp`, policy: policy(), allowedTools: ['echo'] }, 'echo', { text: 'hi' })
    expect(r.ok).toBe(true)
    expect(JSON.stringify(r.data)).toContain('echo:hi')
  })
  it('refuses a tool not on the allowlist without contacting the server', async () => {
    const before = seenAuth.length
    const r = await mcpCallTool({ providerId: 'm', url: `${base}/mcp`, policy: policy(), allowedTools: ['echo'] }, 'delete_everything', {})
    expect(r.status).toBe('blocked')
    expect(seenAuth.length).toBe(before)
  })
  it('maps upstream 401 to auth_failed and redacts the secret', async () => {
    const r = await mcpListTools({ providerId: 'm', url: `${base}/mcp-auth`, policy: policy(), secret: SECRET })
    expect(r.status).toBe('auth_failed')
    expect(JSON.stringify(r)).not.toContain(SECRET)
  })
  it('blocks a non-allowlisted MCP destination', async () => {
    const r = await mcpListTools({ providerId: 'm', url: 'https://evil.example/mcp', policy: { allowedHosts: [] } })
    expect(r.status).toBe('blocked')
  })
})

describe('provider registry', () => {
  it('built-in providers are not configured by default and are never contacted', async () => {
    for (const p of PROVIDERS) {
      expect(configStatus(p, {}).status).toBe('not_configured')
      const r = await checkProvider(p, {})
      expect(r.status).toBe('not_configured')
      expect(r.latency_ms).toBeNull()
    }
  })
  it('checks a configured MCP provider via mock and reports only tool count', async () => {
    const def = PROVIDERS.find((p) => p.kind === 'mcp')!
    const env = { [def.urlEnv]: `${base}/mcp`, [def.secretEnv!]: SECRET, HUB_ALLOWED_HOSTS: hostPort }
    const r = await checkProvider(def, env, { allowInsecureLocalForTests: true })
    expect(r.status).toBe('available')
    expect('data' in r ? r.data : undefined).toEqual({ tool_count: 2 })
    expect(JSON.stringify(r)).not.toContain(SECRET)
  })
  it('production policy rejects the local mock URL', async () => {
    const def = PROVIDERS.find((p) => p.kind === 'rest')!
    const env = { [def.urlEnv]: `${base}`, [def.secretEnv!]: SECRET, HUB_ALLOWED_HOSTS: hostPort }
    const r = await checkProvider(def, env)
    expect(r.status).toBe('blocked')
  })
})
