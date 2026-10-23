/**
 * Unit tests for the universal OAuth gateway logic, with an in-process fake network.
 * No real network: every fetch goes to the `net` map below; DNS is a stub resolver.
 */
import { describe, it, expect } from 'vitest'
import { discover, startOAuth, finishOAuth, refreshOAuth, OAuthStageError, clientMetadataDocument, type OAuthCredential } from '../src/worker/connector/oauth'
import { guardedFetch, NetBlocked } from '../src/worker/connector/net'
import { stages, publicConnection, type ConnectionRow } from '../src/worker/connector/service'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyReq = any
type Handler = (req: AnyReq) => Response | Promise<Response>
const PUBLIC_IP = async () => ['93.184.216.34']

function fakeNet(routes: Record<string, Handler>, log: AnyReq[] = []) {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const req: AnyReq = new Request(typeof input === 'string' || input instanceof URL ? String(input) : input.url, init)
    log.push(req.clone())
    const u = new URL(req.url)
    const h = routes[`${req.method} ${u.origin}${u.pathname}`] ?? routes[`${u.origin}${u.pathname}`]
    return h ? h(req) : new Response('not found', { status: 404 })
  }
}
const json = (o: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...headers } })

const MCP = 'https://mcp.provider.example/mcp'
const AS = 'https://auth.provider.example'
const asMeta = (extra: Record<string, unknown> = {}) => ({
  issuer: AS,
  authorization_endpoint: `${AS}/authorize`,
  token_endpoint: `${AS}/token`,
  response_types_supported: ['code'],
  code_challenge_methods_supported: ['S256'],
  ...extra,
})
const baseRoutes = (meta: Record<string, unknown>, opts: { prmVia?: 'header' | 'wellknown'; oidc?: boolean } = {}): Record<string, Handler> => ({
  [`POST ${MCP}`]: () =>
    json({ error: 'unauthorized' }, 401, opts.prmVia === 'wellknown' ? {} : { 'www-authenticate': `Bearer resource_metadata="https://mcp.provider.example/.well-known/oauth-protected-resource/mcp"` }),
  'https://mcp.provider.example/.well-known/oauth-protected-resource/mcp': () => json({ resource: MCP, authorization_servers: [AS], scopes_supported: ['mcp:read'] }),
  [opts.oidc ? `${AS}/.well-known/openid-configuration` : `${AS}/.well-known/oauth-authorization-server`]: () => json(meta),
})
const policy = { allowedHosts: ['mcp.provider.example'], resolver: PUBLIC_IP }

describe('discovery', () => {
  it('finds PRM via WWW-Authenticate and AS via RFC 8414; selects DCR', async () => {
    const r = await discover({ endpoint: new URL(MCP), policy, mode: 'auto', cimdUrl: null, fetchImpl: fakeNet(baseRoutes(asMeta({ registration_endpoint: `${AS}/register` }))) })
    expect(r.diagnostics.resource_metadata.source).toBe('www-authenticate')
    expect(r.diagnostics.authorization_server.discovery).toBe('oauth')
    expect(r.diagnostics.selected).toBe('dcr')
    expect(r.resource).toBe(MCP)
    expect(r.scope).toBe('mcp:read')
    expect(r.hosts).toEqual(expect.arrayContaining(['mcp.provider.example', 'auth.provider.example']))
  })
  it('finds PRM at the well-known location without a header hint', async () => {
    const r = await discover({ endpoint: new URL(MCP), policy, mode: 'auto', cimdUrl: null, fetchImpl: fakeNet(baseRoutes(asMeta({ registration_endpoint: `${AS}/register` }), { prmVia: 'wellknown' })) })
    expect(r.diagnostics.resource_metadata.source).toBe('well-known')
  })
  it('supports OpenID Connect discovery', async () => {
    const r = await discover({ endpoint: new URL(MCP), policy, mode: 'auto', cimdUrl: null, fetchImpl: fakeNet(baseRoutes(asMeta({ registration_endpoint: `${AS}/register`, jwks_uri: `${AS}/jwks`, subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'] }), { oidc: true })) })
    expect(r.diagnostics.authorization_server.found).toBe(true)
    expect(r.diagnostics.authorization_server.discovery).toBe('oidc')
  })
  it('prefers CIMD when supported and NALUKESA can publish a document', async () => {
    const r = await discover({ endpoint: new URL(MCP), policy, mode: 'auto', cimdUrl: 'https://nalukesa.biz.id/oauth/client-metadata.json', fetchImpl: fakeNet(baseRoutes(asMeta({ client_id_metadata_document_supported: true, registration_endpoint: `${AS}/register` }))) })
    expect(r.diagnostics.selected).toBe('cimd')
  })
  it('falls back to DCR when CIMD is advertised but no HTTPS document is available', async () => {
    const r = await discover({ endpoint: new URL(MCP), policy, mode: 'auto', cimdUrl: null, fetchImpl: fakeNet(baseRoutes(asMeta({ client_id_metadata_document_supported: true, registration_endpoint: `${AS}/register` }))) })
    expect(r.diagnostics.selected).toBe('dcr')
  })
  it('OAuth server without DCR or CIMD → actionable pre-registered-client error (no downgrade)', async () => {
    const e = await discover({ endpoint: new URL(MCP), policy, mode: 'auto', cimdUrl: null, fetchImpl: fakeNet(baseRoutes(asMeta())) }).catch((x) => x)
    expect(e).toBeInstanceOf(OAuthStageError)
    expect(e.stage).toBe('strategy')
    expect(e.message).toMatch(/pre-registered client/)
    expect(e.nextAction).toMatch(/pre-registered OAuth app/)
  })
  it('pre-registered mode works on a server without DCR', async () => {
    const r = await discover({ endpoint: new URL(MCP), policy, mode: 'preregistered', preregistered: { client_id: 'abc' }, cimdUrl: null, fetchImpl: fakeNet(baseRoutes(asMeta())) })
    expect(r.diagnostics.selected).toBe('preregistered')
  })
  it('pre-registered mode without client id fails clearly', async () => {
    const e = await discover({ endpoint: new URL(MCP), policy, mode: 'preregistered', preregistered: null, cimdUrl: null, fetchImpl: fakeNet(baseRoutes(asMeta())) }).catch((x) => x)
    expect(e.stage).toBe('strategy')
    expect(e.message).toMatch(/no client ID/)
  })
  it('PRM found but AS metadata missing → stage-specific error', async () => {
    const routes = baseRoutes(asMeta())
    delete routes[`${AS}/.well-known/oauth-authorization-server`]
    const e = await discover({ endpoint: new URL(MCP), policy, mode: 'auto', cimdUrl: null, fetchImpl: fakeNet(routes) }).catch((x) => x)
    expect(e.message).toBe('Protected resource found; OAuth authorization-server metadata missing.')
  })
  it('malformed OIDC metadata is reported as invalid (not missing), naming the bad fields', async () => {
    // OIDC discovery document without jwks_uri / subject_types_supported / id_token_signing_alg_values_supported
    const e = await discover({ endpoint: new URL(MCP), policy, mode: 'auto', cimdUrl: null, fetchImpl: fakeNet(baseRoutes(asMeta({ client_id_metadata_document_supported: true }), { oidc: true })) }).catch((x) => x)
    expect(e).toBeInstanceOf(OAuthStageError)
    expect(e.stage).toBe('authorization_server')
    expect(e.message).toMatch(/metadata is invalid/)
    expect(e.message).toMatch(/jwks_uri/)
  })
  it('rejects AS without PKCE S256', async () => {
    const e = await discover({ endpoint: new URL(MCP), policy, mode: 'auto', cimdUrl: null, fetchImpl: fakeNet(baseRoutes(asMeta({ code_challenge_methods_supported: ['plain'], registration_endpoint: `${AS}/register` }))) }).catch((x) => x)
    expect(e.message).toMatch(/PKCE S256/)
  })
  it('rejects issuer mismatch (mix-up defence)', async () => {
    const e = await discover({ endpoint: new URL(MCP), policy, mode: 'auto', cimdUrl: null, fetchImpl: fakeNet(baseRoutes(asMeta({ issuer: 'https://evil.example', registration_endpoint: `${AS}/register` }))) }).catch((x) => x)
    expect(e.message).toMatch(/issuer/)
  })
  it('rejects PRM that names a different resource', async () => {
    const routes = baseRoutes(asMeta({ registration_endpoint: `${AS}/register` }))
    routes['https://mcp.provider.example/.well-known/oauth-protected-resource/mcp'] = () => json({ resource: 'https://other.example/mcp', authorization_servers: [AS] })
    const e = await discover({ endpoint: new URL(MCP), policy, mode: 'auto', cimdUrl: null, fetchImpl: fakeNet(routes) }).catch((x) => x)
    expect(e.message).toMatch(/different resource/)
  })
})

describe('SSRF on discovered metadata', () => {
  it.each([
    ['token_endpoint', 'http://169.254.169.254/token'],
    ['authorization_endpoint', 'https://127.0.0.1/authorize'],
    ['registration_endpoint', 'https://internal.corp/register'],
    ['token_endpoint', 'https://nalukesa.biz.id/token'],
  ])('rejects %s = %s', async (k, v) => {
    const e = await discover({ endpoint: new URL(MCP), policy, mode: 'auto', cimdUrl: null, fetchImpl: fakeNet(baseRoutes(asMeta({ registration_endpoint: `${AS}/register`, [k]: v }))) }).catch((x) => x)
    expect(e).toBeInstanceOf(OAuthStageError)
    expect(e.message).toMatch(/rejected/)
  })
  it('rejects a private-IP authorization server in PRM', async () => {
    const routes = baseRoutes(asMeta())
    routes['https://mcp.provider.example/.well-known/oauth-protected-resource/mcp'] = () => json({ resource: MCP, authorization_servers: ['https://10.1.2.3/'] })
    const e = await discover({ endpoint: new URL(MCP), policy, mode: 'auto', cimdUrl: null, fetchImpl: fakeNet(routes) }).catch((x) => x)
    expect(e.message).toMatch(/Authorization server URL rejected/)
  })
  it('rejects a resource_metadata hint pointing at a metadata IP', async () => {
    const routes = baseRoutes(asMeta())
    routes[`POST ${MCP}`] = () => json({}, 401, { 'www-authenticate': 'Bearer resource_metadata="http://169.254.169.254/latest"' })
    const e = await discover({ endpoint: new URL(MCP), policy, mode: 'auto', cimdUrl: null, fetchImpl: fakeNet(routes) }).catch((x) => x)
    expect(e).toBeInstanceOf(OAuthStageError)
  })
  it('DNS rebinding: AS hostname resolving to a private IP is blocked before any request', async () => {
    const log: Request[] = []
    const resolver = async (h: string) => (h === 'auth.provider.example' ? ['10.0.0.7'] : ['93.184.216.34'])
    const e = await discover({ endpoint: new URL(MCP), policy: { ...policy, resolver }, mode: 'auto', cimdUrl: null, fetchImpl: fakeNet(baseRoutes(asMeta({ registration_endpoint: `${AS}/register` })), log) }).catch((x) => x)
    expect(e).toBeTruthy()
    expect(log.some((r) => new URL(r.url).hostname === 'auth.provider.example')).toBe(false)
  })
  it('discovery requests never carry an Authorization header', async () => {
    const log: Request[] = []
    await discover({ endpoint: new URL(MCP), policy, mode: 'auto', cimdUrl: null, fetchImpl: fakeNet(baseRoutes(asMeta({ registration_endpoint: `${AS}/register` })), log) })
    expect(log.every((r) => !r.headers.get('authorization'))).toBe(true)
  })
})

describe('cross-host credential leakage', () => {
  it('credentials are injected only for the designated host', async () => {
    const log: Request[] = []
    const f = guardedFetch({ policy: { allowedHosts: ['mcp.provider.example', 'auth.provider.example'], resolver: PUBLIC_IP }, deadlineMs: 2000, maxBytes: 10000, inject: async () => ({ Authorization: 'Bearer SECRET' }), injectHost: 'mcp.provider.example', fetchImpl: fakeNet({}, log) })
    await f('https://mcp.provider.example/mcp')
    await f('https://auth.provider.example/anything', { headers: { authorization: 'Bearer SHOULD-BE-STRIPPED' } })
    expect(log[0].headers.get('authorization')).toBe('Bearer SECRET')
    expect(log[1].headers.get('authorization')).toBeNull()
  })
  it('credential injection without an explicit target host is refused', async () => {
    const f = guardedFetch({ policy: { allowedHosts: ['mcp.provider.example'], resolver: PUBLIC_IP }, deadlineMs: 2000, maxBytes: 10000, inject: async () => ({ Authorization: 'Bearer X' }), fetchImpl: fakeNet({}) })
    await expect(f('https://mcp.provider.example/mcp')).rejects.toBeInstanceOf(NetBlocked)
  })
})

describe('authorization request, exchange, refresh', () => {
  const routes = (extra: Record<string, Handler> = {}) => ({ ...baseRoutes(asMeta({ registration_endpoint: `${AS}/register`, token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'] })), ...extra })
  it('DCR start: registers, PKCE S256, high-entropy state, resource bound, exact redirect', async () => {
    let registered: Record<string, unknown> | null = null
    const r = await startOAuth({
      endpoint: new URL(MCP), policy, mode: 'auto', cimdUrl: null, redirectUri: 'https://nalukesa.biz.id/api/connector/oauth/callback',
      fetchImpl: fakeNet(routes({ [`POST ${AS}/register`]: async (req) => ((registered = await req.json()), json({ ...registered, client_id: 'dcr-123' }, 201)) })),
    })
    const au = new URL(r.authorizationUrl)
    expect(registered!.redirect_uris).toEqual(['https://nalukesa.biz.id/api/connector/oauth/callback'])
    expect(au.origin + au.pathname).toBe(`${AS}/authorize`)
    expect(au.searchParams.get('code_challenge_method')).toBe('S256')
    expect(au.searchParams.get('code_challenge')!.length).toBeGreaterThan(40)
    expect(au.searchParams.get('client_id')).toBe('dcr-123')
    expect(au.searchParams.get('resource')).toBe(MCP)
    expect(au.searchParams.get('redirect_uri')).toBe('https://nalukesa.biz.id/api/connector/oauth/callback')
    expect(r.state.length).toBeGreaterThanOrEqual(43)
    expect(r.stateHash).not.toContain(r.state)
    expect(r.newDcrRegistration?.client_information.client_id).toBe('dcr-123')
  })
  it('reuses a cached DCR registration for the same redirect + issuer', async () => {
    let calls = 0
    const r = await startOAuth({
      endpoint: new URL(MCP), policy, mode: 'auto', cimdUrl: null, redirectUri: 'https://n.example/cb',
      dcrCache: { client_information: { client_id: 'cached-1' }, redirect_uri: 'https://n.example/cb', issuer: AS },
      fetchImpl: fakeNet(routes({ [`POST ${AS}/register`]: () => (calls++, json({ client_id: 'new' }, 201)) })),
    })
    expect(calls).toBe(0)
    expect(new URL(r.authorizationUrl).searchParams.get('client_id')).toBe('cached-1')
  })
  it('CIMD start uses the metadata document URL as client_id and does not call registration', async () => {
    let calls = 0
    const r = await startOAuth({
      endpoint: new URL(MCP), policy, mode: 'auto', cimdUrl: 'https://nalukesa.biz.id/oauth/client-metadata.json', redirectUri: 'https://nalukesa.biz.id/api/connector/oauth/callback',
      fetchImpl: fakeNet({ ...routes({ [`POST ${AS}/register`]: () => (calls++, json({}, 201)) }), [`${AS}/.well-known/oauth-authorization-server`]: () => json(asMeta({ client_id_metadata_document_supported: true, registration_endpoint: `${AS}/register` })) }),
    })
    expect(calls).toBe(0)
    expect(new URL(r.authorizationUrl).searchParams.get('client_id')).toBe('https://nalukesa.biz.id/oauth/client-metadata.json')
  })
  it('pre-registered confidential client: secret never in the authorization URL; client_secret_basic at token endpoint', async () => {
    let tokenReq: Request | null = null
    const fetchImpl = fakeNet(routes({ [`POST ${AS}/token`]: (req) => ((tokenReq = req), json({ access_token: 'AT1', token_type: 'Bearer', expires_in: 60, refresh_token: 'RT1' })) }))
    const r = await startOAuth({ endpoint: new URL(MCP), policy, mode: 'preregistered', preregistered: { client_id: 'pre-1', client_secret: 'SUPERSECRET', token_endpoint_auth_method: 'client_secret_basic' }, cimdUrl: null, redirectUri: 'https://n.example/cb', fetchImpl })
    expect(r.authorizationUrl).not.toContain('SUPERSECRET')
    const cred = await finishOAuth(r.context, 'CODE', { ...policy, allowedHosts: r.hosts }, AS, fetchImpl)
    expect(tokenReq!.headers.get('authorization')).toBe('Basic ' + btoa('pre-1:SUPERSECRET'))
    const body = new URLSearchParams(await tokenReq!.text())
    expect(body.get('code_verifier')!.length).toBeGreaterThan(40)
    expect(body.get('resource')).toBe(MCP)
    expect(body.get('client_secret')).toBeNull()
    expect(cred.access_token).toBe('AT1')
    expect(cred.strategy).toBe('preregistered')
  })
  it('client_secret_post sends the secret in the body, not a header', async () => {
    let tokenReq: Request | null = null
    const fetchImpl = fakeNet(routes({ [`POST ${AS}/token`]: (req) => ((tokenReq = req), json({ access_token: 'AT', token_type: 'Bearer' })) }))
    const r = await startOAuth({ endpoint: new URL(MCP), policy, mode: 'preregistered', preregistered: { client_id: 'pre-2', client_secret: 'S2', token_endpoint_auth_method: 'client_secret_post' }, cimdUrl: null, redirectUri: 'https://n.example/cb', fetchImpl })
    await finishOAuth(r.context, 'C', { ...policy, allowedHosts: r.hosts }, null, fetchImpl)
    expect(tokenReq!.headers.get('authorization')).toBeNull()
    expect(new URLSearchParams(await tokenReq!.text()).get('client_secret')).toBe('S2')
  })
  it('callback iss mismatch (RFC 9207) is rejected before any token request', async () => {
    let called = false
    const fetchImpl = fakeNet(routes({ [`POST ${AS}/token`]: () => ((called = true), json({ access_token: 'x', token_type: 'Bearer' })) }))
    const r = await startOAuth({ endpoint: new URL(MCP), policy, mode: 'preregistered', preregistered: { client_id: 'p' }, cimdUrl: null, redirectUri: 'https://n.example/cb', fetchImpl })
    await expect(finishOAuth(r.context, 'C', { ...policy, allowedHosts: r.hosts }, 'https://evil.example', fetchImpl)).rejects.toThrow(/Issuer/)
    expect(called).toBe(false)
  })
  it('token exchange error is reported as stage token_exchange without leaking the code', async () => {
    const fetchImpl = fakeNet(routes({ [`POST ${AS}/token`]: () => json({ error: 'invalid_grant', error_description: 'bad code=SECRETCODE' }, 400) }))
    const r = await startOAuth({ endpoint: new URL(MCP), policy, mode: 'preregistered', preregistered: { client_id: 'p' }, cimdUrl: null, redirectUri: 'https://n.example/cb', fetchImpl })
    const e = await finishOAuth(r.context, 'SECRETCODE', { ...policy, allowedHosts: r.hosts }, null, fetchImpl).catch((x) => x)
    expect(e.stage).toBe('token_exchange')
    expect(e.message).not.toContain('SECRETCODE')
  })
  it('rejects non-bearer token types', async () => {
    const fetchImpl = fakeNet(routes({ [`POST ${AS}/token`]: () => json({ access_token: 'x', token_type: 'mac' }) }))
    const r = await startOAuth({ endpoint: new URL(MCP), policy, mode: 'preregistered', preregistered: { client_id: 'p' }, cimdUrl: null, redirectUri: 'https://n.example/cb', fetchImpl })
    await expect(finishOAuth(r.context, 'C', { ...policy, allowedHosts: r.hosts }, null, fetchImpl)).rejects.toThrow(/token type/)
  })
  it('refresh rotates the refresh token, and keeps the old one when none is returned', async () => {
    const base: OAuthCredential = { access_token: 'old', refresh_token: 'RT-OLD', expires_at: 1, client_information: { client_id: 'c' }, authorization_server: AS, metadata: asMeta(), resource: MCP, strategy: 'dcr' }
    const p2 = { allowedHosts: ['auth.provider.example'], resolver: PUBLIC_IP }
    let body: URLSearchParams | null = null
    const rotated = await refreshOAuth(base, p2, fakeNet({ [`POST ${AS}/token`]: async (req) => ((body = new URLSearchParams(await req.text())), json({ access_token: 'new', token_type: 'Bearer', expires_in: 3600, refresh_token: 'RT-NEW' })) }))
    expect(body!.get('grant_type')).toBe('refresh_token')
    expect(body!.get('refresh_token')).toBe('RT-OLD')
    expect(body!.get('resource')).toBe(MCP)
    expect(rotated.refresh_token).toBe('RT-NEW')
    expect(rotated.access_token).toBe('new')
    const kept = await refreshOAuth(base, p2, fakeNet({ [`POST ${AS}/token`]: () => json({ access_token: 'new2', token_type: 'Bearer' }) }))
    expect(kept.refresh_token).toBe('RT-OLD')
  })
  it('refresh without refresh token requires re-authorization', async () => {
    await expect(refreshOAuth({ access_token: 'a', client_information: {}, authorization_server: AS }, policy)).rejects.toThrow(/Re-authorize|refresh token/)
  })
})

describe('CIMD document and public projection', () => {
  it('client metadata document is public, consistent, and secret-free', () => {
    const d = clientMetadataDocument('https://nalukesa.biz.id')
    expect(d.client_id).toBe('https://nalukesa.biz.id/oauth/client-metadata.json')
    expect(d.redirect_uris).toEqual(['https://nalukesa.biz.id/api/connector/oauth/callback'])
    expect(d.token_endpoint_auth_method).toBe('none')
    expect(JSON.stringify(d)).not.toMatch(/secret/i)
  })
  it('public projection hides ciphertexts and exposes stage statuses', () => {
    const row = { id: 1, auth_type: 'oauth', auth_ciphertext: 'v1.tok', oauth_client_ciphertext: 'v1.sec', oauth_mode: 'preregistered', oauth_client_id: 'c', oauth_diagnostics: '{"stage_reached":"ready"}', status: 'connected', last_check_at: 't', tools_refreshed_at: 't', last_verified_at: null, extra_allowed_hosts: null, enabled: 1, oauth_authorized_at: 't' } as unknown as ConnectionRow
    const p = publicConnection(row)
    const s = JSON.stringify(p)
    expect(s).not.toContain('v1.tok')
    expect(s).not.toContain('v1.sec')
    expect(p.has_client_secret).toBe(true)
    expect(p.stages).toEqual({ endpoint_reachable: 'ok', oauth_configured: 'ok', account_authorized: 'ok', mcp_initialized: 'ok', tools_discovered: 'ok', invocation_verified: 'unknown' })
  })
  it('OAuth callback alone does not mark invocation verified', () => {
    const s = stages({ auth_type: 'oauth', auth_ciphertext: 'x', status: 'untested', last_check_at: null, tools_refreshed_at: null, last_verified_at: null, oauth_authorized_at: 'now', oauth_diagnostics: null, oauth_mode: 'auto', oauth_client_id: null })
    expect(s.account_authorized).toBe('ok')
    expect(s.mcp_initialized).toBe('unknown')
    expect(s.invocation_verified).toBe('unknown')
  })
})
