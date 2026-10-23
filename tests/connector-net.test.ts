import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { validateEndpoint, isPublicIPv4, isPublicIPv6, assertPublicHost, guardedFetch, NetBlocked, NetTimeout, NetTooLarge, NetHttpStatus } from '../src/worker/connector/net'
import { sealJson, openJson, CryptoUnavailable } from '../src/worker/connector/crypto'
import { riskOf, readiness, validateConnectionInput, publicConnection, type ConnectionRow } from '../src/worker/connector/service'

let server: Server
let port = 0
beforeAll(async () => {
  server = createServer((req, res) => {
    const p = req.url ?? '/'
    if (p === '/chunked-big') {
      res.writeHead(200, { 'content-type': 'application/json' }) // no content-length → chunked
      let n = 0
      const iv = setInterval(() => {
        res.write('x'.repeat(4096))
        if (++n > 100) {
          clearInterval(iv)
          res.end()
        }
      }, 1)
      req.on('close', () => clearInterval(iv))
      return
    }
    if (p === '/declared-big') {
      res.writeHead(200, { 'content-length': String(10_000_000), 'content-type': 'text/plain' })
      return res.end('x')
    }
    if (p === '/slow-body') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.write('start')
      const t = setTimeout(() => res.end('end'), 3000)
      req.on('close', () => clearTimeout(t))
      return
    }
    if (p === '/slow-headers') {
      const t = setTimeout(() => res.end('{}'), 3000)
      req.on('close', () => clearTimeout(t))
      return
    }
    if (p === '/redirect') {
      res.writeHead(307, { location: 'http://169.254.169.254/' })
      return res.end()
    }
    if (p === '/401') {
      res.writeHead(401, { 'www-authenticate': 'Bearer resource_metadata="x"' })
      return res.end()
    }
    if (p === '/echo-headers') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify(req.headers))
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  port = (server.address() as AddressInfo).port
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))

const local = () => ({ policy: { allowedHosts: [`127.0.0.1:${port}`], allowLocalHttp: true }, deadlineMs: 1000, maxBytes: 64 * 1024 })
const url = (p: string) => `http://127.0.0.1:${port}${p}`

describe('endpoint validation', () => {
  it('accepts a public https hostname', () => expect(validateEndpoint('https://mcp.example.com/mcp').hostname).toBe('mcp.example.com'))
  it.each([
    'http://mcp.example.com/mcp',
    'https://127.0.0.1/mcp',
    'https://[::1]/mcp',
    'https://10.0.0.5/',
    'https://169.254.169.254/latest',
    'https://2130706433/',
    'https://0x7f000001/',
    'https://localhost/mcp',
    'https://printer.local/',
    'https://svc.internal/',
    'https://metadata.google.internal/',
    'https://intranet/',
    'https://mcp.example.com:8443/',
    'https://u:p@mcp.example.com/',
    'https://nalukesa.biz.id/mcp',
    'https://abc.nalukesa.pages.dev/mcp',
    'ftp://mcp.example.com/',
    'javascript:alert(1)',
  ])('rejects %s', (u) => expect(() => validateEndpoint(u)).toThrow(NetBlocked))
  it('http://127.0.0.1 only allowed when local dev flag is set', () => {
    expect(() => validateEndpoint('http://127.0.0.1:9999/mcp')).toThrow()
    expect(validateEndpoint('http://127.0.0.1:9999/mcp', { allowLocalHttp: true }).port).toBe('9999')
  })
})

describe('IP classification (DNS validation)', () => {
  it.each(['8.8.8.8', '1.1.1.1', '104.16.0.1'])('public v4 %s', (ip) => expect(isPublicIPv4(ip)).toBe(true))
  it.each(['10.1.2.3', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '198.18.0.1', '255.255.255.255'])('private/reserved v4 %s', (ip) => expect(isPublicIPv4(ip)).toBe(false))
  it.each(['2606:4700::1111', '2001:4860:4860::8888'])('public v6 %s', (ip) => expect(isPublicIPv6(ip)).toBe(true))
  it.each(['::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', 'ff02::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1', '2001:db8::1', '64:ff9b::a00:1', '2002:a00:1::'])('private/reserved v6 %s', (ip) => expect(isPublicIPv6(ip)).toBe(false))
  it('rejects a hostname resolving to any private address (rebinding-style mixed answer)', async () => {
    await expect(assertPublicHost('evil.example', async () => ['93.184.216.34', '10.0.0.1'])).rejects.toThrow(/private/)
    await expect(assertPublicHost('none.example', async () => [])).rejects.toThrow(/resolve/)
    await expect(assertPublicHost('ok.example', async () => ['93.184.216.34'])).resolves.toBeUndefined()
  })
  it('guardedFetch performs DNS check before contacting a public host', async () => {
    let contacted = false
    const f = guardedFetch({ policy: { allowedHosts: ['rebind.example'], resolver: async () => ['127.0.0.1'] }, deadlineMs: 1000, maxBytes: 1000, fetchImpl: async () => ((contacted = true), new Response('{}')) })
    await expect(f('https://rebind.example/mcp')).rejects.toThrow(/private/)
    expect(contacted).toBe(false)
  })
})

describe('guarded fetch limits', () => {
  it('passes a normal response and injects credentials server-side', async () => {
    const f = guardedFetch({ ...local(), inject: async () => ({ Authorization: 'Bearer s3cret-token' }) })
    const r = await f(url('/echo-headers'))
    const h = (await r.json()) as Record<string, string>
    expect(h.authorization).toBe('Bearer s3cret-token')
    expect(h['x-nk-hop']).toBe('1')
  })
  it('enforces size cap on chunked body without content-length', async () => {
    const r = await guardedFetch(local())(url('/chunked-big'))
    await expect(r.text()).rejects.toBeInstanceOf(NetTooLarge)
  })
  it('enforces size cap on declared content-length', async () => {
    await expect(guardedFetch(local())(url('/declared-big'))).rejects.toBeInstanceOf(NetTooLarge)
  })
  it('timeout covers slow headers', async () => {
    await expect(guardedFetch(local())(url('/slow-headers'))).rejects.toBeInstanceOf(NetTimeout)
  })
  it('timeout covers slow body consumption', async () => {
    const r = await guardedFetch(local())(url('/slow-body'))
    await expect(r.text()).rejects.toBeInstanceOf(NetTimeout)
  })
  it('rejects redirects', async () => {
    await expect(guardedFetch(local())(url('/redirect'))).rejects.toThrow(/Redirects/)
  })
  it('surfaces 401 with WWW-Authenticate', async () => {
    const e = await guardedFetch(local())(url('/401')).catch((x) => x)
    expect(e).toBeInstanceOf(NetHttpStatus)
    expect(e.wwwAuthenticate).toContain('resource_metadata')
  })
  it('rejects hosts not on the connection allowlist', async () => {
    await expect(guardedFetch({ ...local(), policy: { allowedHosts: ['127.0.0.1:1'], allowLocalHttp: true } })(url('/'))).rejects.toThrow(/allowlist/)
  })
})

describe('credential encryption', () => {
  const key = Buffer.alloc(32, 7).toString('base64')
  it('round-trips and binds purpose', async () => {
    const ct = await sealJson(key, 'p1', { token: 'abc' })
    expect(ct).not.toContain('abc')
    expect(await openJson(key, 'p1', ct)).toEqual({ token: 'abc' })
    await expect(openJson(key, 'p2', ct)).rejects.toBeTruthy()
    await expect(openJson(Buffer.alloc(32, 8).toString('base64'), 'p1', ct)).rejects.toBeTruthy()
  })
  it('fails closed without a valid key', async () => {
    await expect(sealJson(undefined, 'p', {})).rejects.toBeInstanceOf(CryptoUnavailable)
    await expect(sealJson('c2hvcnQ=', 'p', {})).rejects.toBeInstanceOf(CryptoUnavailable)
  })
})

describe('connector service rules', () => {
  it('risk classification follows MCP hints (absent hints = write)', () => {
    expect(riskOf({ annotations: { readOnlyHint: true } })).toBe('read')
    expect(riskOf({ annotations: { destructiveHint: true, readOnlyHint: true } })).toBe('destructive')
    expect(riskOf({ annotations: null })).toBe('write')
    expect(riskOf({ annotations: { readOnlyHint: false } })).toBe('write')
  })
  it('readiness states are distinct', () => {
    const base = { enabled: 1, status: 'verified' as const, auth_type: 'bearer' as const, auth_ciphertext: 'x', tools_refreshed_at: 't' }
    expect(readiness({ ...base, enabled: 0 }, 1)).toBe('disabled')
    expect(readiness({ ...base, auth_ciphertext: null }, 1)).toBe('not_configured')
    expect(readiness({ ...base, auth_type: 'oauth', auth_ciphertext: null }, 1)).toBe('auth_required')
    expect(readiness({ ...base, status: 'untested' }, 1)).toBe('untested')
    expect(readiness({ ...base, status: 'failed' }, 1)).toBe('connection_failed')
    expect(readiness({ ...base, status: 'auth_failed' }, 1)).toBe('auth_failed')
    expect(readiness({ ...base, status: 'connected', tools_refreshed_at: null }, 0)).toBe('connected_unverified')
    expect(readiness({ ...base, status: 'connected' }, 0)).toBe('tools_discovered')
    expect(readiness({ ...base, status: 'connected' }, 2)).toBe('tools_discovered_unverified')
    expect(readiness(base, 0)).toBe('verified_no_tools_allowed')
    expect(readiness(base, 2)).toBe('ready')
  })
  it('validates connection input strictly', () => {
    const env = { DB: {} as D1Database }
    expect(() => validateConnectionInput({ name: 'x', endpoint_url: 'http://evil.com', auth_type: 'none' }, 'create', env)).toThrow()
    expect(() => validateConnectionInput({ name: 'x', endpoint_url: 'https://mcp.example.com/mcp', auth_type: 'bearer' }, 'create', env)).toThrow()
    expect(() => validateConnectionInput({ name: 'x', endpoint_url: 'https://mcp.example.com/mcp', auth_type: 'none', owner: 'evil' } as never, 'create', env)).toThrow()
    expect(validateConnectionInput({ name: 'x', endpoint_url: 'https://mcp.example.com/mcp', auth_type: 'bearer', bearer_token: 'abcdefgh123' }, 'create', env).auth_type).toBe('bearer')
  })
  it('public projection never includes ciphertext', () => {
    const p = publicConnection({ id: 1, auth_ciphertext: 'v1.secret', extra_allowed_hosts: null, enabled: 1 } as ConnectionRow)
    expect(JSON.stringify(p)).not.toContain('v1.secret')
    expect(p.has_credential).toBe(true)
  })
})
