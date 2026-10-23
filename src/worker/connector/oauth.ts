/**
 * Universal OAuth 2.1 client for outbound MCP connections (provider-agnostic).
 *
 * Discovery (every URL passes the connector SSRF policy before it is fetched):
 *   1. Protected Resource Metadata (RFC 9728): WWW-Authenticate `resource_metadata`
 *      from an unauthenticated probe, else the well-known locations.
 *   2. Authorization Server Metadata: RFC 8414 and OpenID Connect Discovery
 *      (path-insertion and path-append variants) via the official SDK.
 *   3. Issuer, authorization/token/registration/revocation endpoints validated.
 *
 * Client registration strategy (first applicable wins; never downgrades to no-auth):
 *   - preregistered : owner supplied client_id (+ optional secret)        [oauth_mode = preregistered]
 *   - cimd          : AS advertises client_id_metadata_document_supported [auto]
 *   - dcr           : AS advertises registration_endpoint (RFC 7591)      [auto]
 *   - none          : fail with actionable error                           [auto]
 *
 * Flow: authorization code + PKCE S256 (mandatory), single-use hashed state bound to
 * connection + owner session, exact redirect URI, RFC 8707 `resource` binding,
 * server-side code exchange, encrypted token storage, refresh with rotation.
 */
import {
  discoverOAuthProtectedResourceMetadata,
  discoverAuthorizationServerMetadata,
  registerClient,
  startAuthorization,
  exchangeAuthorization,
  refreshAuthorization,
  extractWWWAuthenticateParams,
} from '@modelcontextprotocol/sdk/client/auth.js'
import { guardedFetch, validateEndpoint, hostKeyOf, NetBlocked, type NetPolicy, type FetchLike } from './net'
import { sha256 } from '../auth'

export type RegistrationStrategy = 'preregistered' | 'cimd' | 'dcr'
export type TokenAuthMethod = 'none' | 'client_secret_basic' | 'client_secret_post'

export class OAuthStageError extends Error {
  constructor(public stage: string, message: string, public nextAction?: string) {
    super(message)
    this.name = 'OAuthStageError'
  }
}

export interface OAuthCredential {
  access_token: string
  refresh_token?: string
  expires_at?: number // epoch seconds
  token_type?: string
  scope?: string
  client_information: Record<string, unknown>
  authorization_server: string
  metadata?: Record<string, unknown>
  resource?: string
  strategy?: RegistrationStrategy
}

export interface Diagnostics {
  checked_at: string
  stage_reached: 'probe' | 'resource_metadata' | 'authorization_server' | 'strategy' | 'ready'
  resource_metadata: { found: boolean; source: 'www-authenticate' | 'well-known' | null; resource: string | null; authorization_servers: string[]; scopes_supported: string[] }
  authorization_server: { found: boolean; issuer: string | null; discovery: 'oauth' | 'oidc' | 'legacy-base-url' | null; pkce_s256: boolean | null; dcr: boolean; cimd: boolean; token_endpoint_auth_methods: string[] }
  strategies: { preregistered: boolean; cimd: boolean; dcr: boolean }
  selected: RegistrationStrategy | null
  message: string
  next_action: string | null
}

export interface PreregisteredClient {
  client_id: string
  client_secret?: string
  token_endpoint_auth_method?: TokenAuthMethod
}

export interface DiscoveryInput {
  endpoint: URL
  policy: NetPolicy
  mode: 'auto' | 'preregistered'
  preregistered?: PreregisteredClient | null
  /** HTTPS URL of NALUKESA's Client ID Metadata Document, or null if not available on this host */
  cimdUrl: string | null
  fetchImpl?: FetchLike
}

export interface DiscoveryResult {
  diagnostics: Diagnostics
  asUrl: string
  metadata: Record<string, unknown>
  resource: string
  scope?: string
  hosts: string[]
}

const META_LIMIT = 256 * 1024

/** Fetch for discovery: grows the allowlist only with SSRF-validated hosts, never sends credentials. */
function discoveryFetch(policy: NetPolicy, hosts: Set<string>, fetchImpl?: FetchLike): FetchLike {
  return async (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    const u = validateEndpoint(raw, policy)
    hosts.add(hostKeyOf(u, policy.allowLocalHttp))
    const p: NetPolicy = { ...policy, allowedHosts: [...hosts] }
    const h = new Headers(init?.headers)
    h.delete('authorization')
    return guardedFetch({ policy: p, deadlineMs: 10000, maxBytes: META_LIMIT, fetchImpl })(input, { ...init, headers: h })
  }
}

/** Fetch for token / registration endpoints: only the validated AS hosts. */
export function oauthFetch(policy: NetPolicy, fetchImpl?: FetchLike): FetchLike {
  return guardedFetch({ policy, deadlineMs: 10000, maxBytes: META_LIMIT, fetchImpl })
}

function normIssuer(s: string) {
  return s.replace(/\/+$/, '')
}

export async function discover(input: DiscoveryInput): Promise<DiscoveryResult> {
  const { endpoint, policy } = input
  const hosts = new Set<string>(policy.allowedHosts)
  const f = discoveryFetch(policy, hosts, input.fetchImpl)
  const d: Diagnostics = {
    checked_at: new Date().toISOString(),
    stage_reached: 'probe',
    resource_metadata: { found: false, source: null, resource: null, authorization_servers: [], scopes_supported: [] },
    authorization_server: { found: false, issuer: null, discovery: null, pkce_s256: null, dcr: false, cimd: false, token_endpoint_auth_methods: [] },
    strategies: { preregistered: input.mode === 'preregistered' && !!input.preregistered?.client_id, cimd: false, dcr: false },
    selected: null,
    message: '',
    next_action: null,
  }
  const fail = (stage: string, message: string, next: string): never => {
    d.message = message
    d.next_action = next
    throw Object.assign(new OAuthStageError(stage, message, next), { diagnostics: d })
  }

  // 1. Unauthenticated probe → WWW-Authenticate resource_metadata hint
  let resourceMetadataUrl: URL | undefined
  try {
    const probe = await guardedFetch({ policy: { ...policy, allowedHosts: [...hosts] }, deadlineMs: 10000, maxBytes: 64 * 1024, fetchImpl: input.fetchImpl })(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'nalukesa-probe', version: '1' } } }),
    })
    await probe.body?.cancel().catch(() => {})
  } catch (e) {
    const www = (e as { wwwAuthenticate?: string | null }).wwwAuthenticate
    if (www) {
      const params = extractWWWAuthenticateParams(new Response(null, { headers: { 'www-authenticate': www } }))
      if (params.resourceMetadataUrl) resourceMetadataUrl = params.resourceMetadataUrl
    } else if (e instanceof NetBlocked) {
      fail('probe', `Endpoint rejected by network policy: ${e.message}`, 'Use a public HTTPS MCP endpoint.')
    }
  }

  // 2. Protected resource metadata (RFC 9728)
  let prm: Record<string, unknown> | undefined
  try {
    if (resourceMetadataUrl) validateEndpoint(resourceMetadataUrl.toString(), policy)
    prm = (await discoverOAuthProtectedResourceMetadata(endpoint, { resourceMetadataUrl }, f)) as unknown as Record<string, unknown>
    d.resource_metadata = {
      found: true,
      source: resourceMetadataUrl ? 'www-authenticate' : 'well-known',
      resource: typeof prm.resource === 'string' ? prm.resource : null,
      authorization_servers: Array.isArray(prm.authorization_servers) ? (prm.authorization_servers as string[]).slice(0, 5) : [],
      scopes_supported: Array.isArray(prm.scopes_supported) ? (prm.scopes_supported as string[]).slice(0, 30) : [],
    }
    d.stage_reached = 'resource_metadata'
  } catch (e) {
    if (e instanceof NetBlocked) fail('resource_metadata', `Protected-resource metadata URL rejected: ${e.message}`, 'The provider advertises metadata on a non-public or disallowed host.')
  }

  // Resource binding: PRM resource must match the endpoint origin/path (RFC 9728 §3.3)
  let resource = endpoint.toString()
  if (d.resource_metadata.resource) {
    const r = new URL(d.resource_metadata.resource)
    if (r.origin !== endpoint.origin || !endpoint.pathname.startsWith(r.pathname.replace(/\/$/, '') || '/')) {
      fail('resource_metadata', 'Protected-resource metadata names a different resource than this endpoint', 'The provider metadata is inconsistent; contact the provider.')
    }
    resource = d.resource_metadata.resource
  }

  // 3. Authorization server metadata (RFC 8414 / OIDC)
  const asUrl = d.resource_metadata.authorization_servers[0] ?? new URL('/', endpoint).toString()
  try {
    validateEndpoint(asUrl, policy)
  } catch (e) {
    fail('authorization_server', `Authorization server URL rejected: ${(e as Error).message}`, 'The advertised authorization server is not a public HTTPS host.')
  }
  let asMeta: Record<string, unknown> | undefined
  try {
    asMeta = (await discoverAuthorizationServerMetadata(asUrl, { fetchFn: f })) as unknown as Record<string, unknown> | undefined
  } catch (e) {
    if (e instanceof NetBlocked) fail('authorization_server', `Authorization server metadata rejected: ${e.message}`, 'Metadata is served from a disallowed host.')
  }
  if (!asMeta) {
    fail(
      'authorization_server',
      d.resource_metadata.found ? 'Protected resource found; OAuth authorization-server metadata missing.' : 'No OAuth metadata found (neither protected-resource nor authorization-server metadata).',
      d.resource_metadata.found ? 'The provider must publish RFC 8414 or OpenID Connect discovery metadata.' : 'This server may not use OAuth. Try “Bearer token” or “None”.',
    )
  }
  const meta = asMeta!
  d.authorization_server = {
    found: true,
    issuer: typeof meta.issuer === 'string' ? meta.issuer : null,
    discovery: d.resource_metadata.authorization_servers.length ? ('jwks_uri' in meta || 'userinfo_endpoint' in meta ? 'oidc' : 'oauth') : 'legacy-base-url',
    pkce_s256: Array.isArray(meta.code_challenge_methods_supported) ? (meta.code_challenge_methods_supported as string[]).includes('S256') : null,
    dcr: typeof meta.registration_endpoint === 'string',
    cimd: meta.client_id_metadata_document_supported === true,
    token_endpoint_auth_methods: Array.isArray(meta.token_endpoint_auth_methods_supported) ? (meta.token_endpoint_auth_methods_supported as string[]) : [],
  }
  d.stage_reached = 'authorization_server'
  // Issuer must match the AS identifier (RFC 8414 §3.3)
  if (d.authorization_server.issuer && d.resource_metadata.authorization_servers.length && normIssuer(d.authorization_server.issuer) !== normIssuer(asUrl)) {
    fail('authorization_server', 'Authorization server issuer does not match the advertised authorization server', 'Provider metadata is inconsistent (issuer mismatch); refusing to continue.')
  }
  // PKCE S256 is mandatory. If metadata omits the field we still send S256 (SDK default) — the server must accept it.
  if (d.authorization_server.pkce_s256 === false) fail('authorization_server', 'Authorization server does not support PKCE S256', 'NALUKESA requires PKCE S256; this provider cannot be used.')
  for (const k of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint', 'revocation_endpoint'] as const) {
    const v = meta[k]
    if (typeof v === 'string') {
      try {
        hosts.add(hostKeyOf(validateEndpoint(v, policy), policy.allowLocalHttp))
      } catch (e) {
        fail('authorization_server', `${k} rejected: ${(e as Error).message}`, 'Provider OAuth endpoints must be public HTTPS hosts.')
      }
    } else if (k === 'authorization_endpoint' || k === 'token_endpoint') {
      fail('authorization_server', `Authorization server metadata has no ${k}`, 'Provider metadata is incomplete.')
    }
  }

  // 4. Strategy
  d.strategies.cimd = d.authorization_server.cimd && !!input.cimdUrl
  d.strategies.dcr = d.authorization_server.dcr
  if (input.mode === 'preregistered') {
    if (!input.preregistered?.client_id) fail('strategy', 'Pre-registered OAuth app selected but no client ID is configured', 'Enter the client ID (and secret if the provider requires one) in the connection settings.')
    d.selected = 'preregistered'
  } else if (d.strategies.cimd) d.selected = 'cimd'
  else if (d.strategies.dcr) d.selected = 'dcr'
  else {
    fail(
      'strategy',
      d.authorization_server.cimd && !input.cimdUrl
        ? 'Provider supports Client ID Metadata Documents, but NALUKESA cannot publish one from this host (HTTPS required).'
        : 'Provider requires a pre-registered client (no dynamic registration and no client ID metadata document support).',
      'Register an OAuth app with the provider using the callback URL shown, then choose “Use a pre-registered OAuth app” and enter its client ID.',
    )
  }
  d.stage_reached = 'strategy'
  const scopes = d.resource_metadata.scopes_supported.length ? d.resource_metadata.scopes_supported : Array.isArray(meta.scopes_supported) ? (meta.scopes_supported as string[]).filter((s) => !['openid', 'profile', 'email', 'offline_access'].includes(s)) : []
  d.message = `Ready to authorize using ${d.selected}.`
  d.stage_reached = 'ready'
  return { diagnostics: d, asUrl, metadata: meta, resource, scope: scopes.length ? scopes.join(' ') : undefined, hosts: [...hosts] }
}

export interface StartInput extends DiscoveryInput {
  redirectUri: string
  scopeOverride?: string | null
  /** cached DCR registration (re-used if redirect URI + issuer unchanged) */
  dcrCache?: { client_information: Record<string, unknown>; redirect_uri: string; issuer: string } | null
}

export interface StartResult {
  authorizationUrl: string
  state: string
  stateHash: string
  context: Record<string, unknown>
  hosts: string[]
  diagnostics: Diagnostics
  newDcrRegistration?: { client_information: Record<string, unknown>; redirect_uri: string; issuer: string }
}

export async function startOAuth(input: StartInput): Promise<StartResult> {
  const disc = await discover(input)
  const policy: NetPolicy = { ...input.policy, allowedHosts: disc.hosts }
  const strategy = disc.diagnostics.selected!
  let clientInformation: Record<string, unknown>
  let newDcr: StartResult['newDcrRegistration']
  const issuer = disc.diagnostics.authorization_server.issuer ?? disc.asUrl

  if (strategy === 'preregistered') {
    const p = input.preregistered!
    clientInformation = { client_id: p.client_id, ...(p.client_secret ? { client_secret: p.client_secret } : {}), token_endpoint_auth_method: p.token_endpoint_auth_method ?? (p.client_secret ? 'client_secret_basic' : 'none') }
  } else if (strategy === 'cimd') {
    clientInformation = { client_id: input.cimdUrl!, token_endpoint_auth_method: 'none' }
  } else {
    if (input.dcrCache && input.dcrCache.redirect_uri === input.redirectUri && normIssuer(input.dcrCache.issuer) === normIssuer(issuer)) {
      clientInformation = input.dcrCache.client_information
    } else {
      try {
        clientInformation = (await registerClient(disc.asUrl, {
          metadata: disc.metadata as never,
          clientMetadata: {
            client_name: 'NALUKESA MCP Gateway',
            redirect_uris: [input.redirectUri],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
          },
          fetchFn: oauthFetch(policy, input.fetchImpl),
        })) as unknown as Record<string, unknown>
      } catch (e) {
        throw Object.assign(new OAuthStageError('registration', `Dynamic client registration failed: ${String((e as Error).message).slice(0, 160)}`, 'Use a pre-registered OAuth app instead.'), { diagnostics: disc.diagnostics })
      }
      newDcr = { client_information: clientInformation, redirect_uri: input.redirectUri, issuer }
    }
  }

  const state = b64url(crypto.getRandomValues(new Uint8Array(32)))
  const scope = input.scopeOverride?.trim() || disc.scope
  let started: { authorizationUrl: URL; codeVerifier: string }
  try {
    started = await startAuthorization(disc.asUrl, {
      metadata: disc.metadata as never,
      clientInformation: clientInformation as never,
      redirectUrl: input.redirectUri,
      state,
      resource: new URL(disc.resource),
      scope,
    })
  } catch (e) {
    throw Object.assign(new OAuthStageError('authorization_request', String((e as Error).message).slice(0, 200), 'The provider metadata is incompatible with OAuth 2.1 authorization code + PKCE.'), { diagnostics: disc.diagnostics })
  }
  const au = started.authorizationUrl
  validateEndpoint(au.toString(), policy)
  if (au.searchParams.get('code_challenge_method') !== 'S256' || !au.searchParams.get('code_challenge')) throw new OAuthStageError('authorization_request', 'PKCE S256 missing from authorization request')
  return {
    authorizationUrl: au.toString(),
    state,
    stateHash: await sha256('oauth-state:' + state),
    context: { codeVerifier: started.codeVerifier, redirectUri: input.redirectUri, asUrl: disc.asUrl, issuer, metadata: disc.metadata, clientInformation, resource: disc.resource, strategy, hosts: disc.hosts },
    hosts: disc.hosts,
    diagnostics: disc.diagnostics,
    newDcrRegistration: newDcr,
  }
}

export async function finishOAuth(ctx: Record<string, unknown>, code: string, policy: NetPolicy, issuerParam?: string | null, fetchImpl?: FetchLike): Promise<OAuthCredential> {
  // RFC 9207: if the AS returns `iss`, it must match the expected issuer (mix-up defence)
  if (issuerParam && ctx.issuer && normIssuer(issuerParam) !== normIssuer(String(ctx.issuer))) throw new OAuthStageError('callback', 'Issuer in callback does not match the authorization server')
  let tokens: Record<string, unknown>
  try {
    tokens = (await exchangeAuthorization(String(ctx.asUrl), {
      metadata: (ctx.metadata ?? undefined) as never,
      clientInformation: ctx.clientInformation as never,
      authorizationCode: code,
      codeVerifier: String(ctx.codeVerifier),
      redirectUri: String(ctx.redirectUri),
      resource: ctx.resource ? new URL(String(ctx.resource)) : undefined,
      fetchFn: oauthFetch(policy, fetchImpl),
    })) as unknown as Record<string, unknown>
  } catch (e) {
    throw new OAuthStageError('token_exchange', `Token exchange failed: ${String((e as Error).message).replace(/code=[^&\s]+/g, 'code=[REDACTED]').slice(0, 160)}`)
  }
  return toCredential(tokens, ctx)
}

export async function refreshOAuth(cred: OAuthCredential, policy: NetPolicy, fetchImpl?: FetchLike): Promise<OAuthCredential> {
  if (!cred.refresh_token) throw new OAuthStageError('refresh', 'Access token expired and no refresh token is available', 'Re-authorize the connection.')
  const tokens = (await refreshAuthorization(cred.authorization_server, {
    metadata: (cred.metadata ?? undefined) as never,
    clientInformation: cred.client_information as never,
    refreshToken: cred.refresh_token,
    resource: cred.resource ? new URL(cred.resource) : undefined,
    fetchFn: oauthFetch(policy, fetchImpl),
  })) as unknown as Record<string, unknown>
  const next = toCredential(tokens, { asUrl: cred.authorization_server, metadata: cred.metadata, clientInformation: cred.client_information, resource: cred.resource, strategy: cred.strategy })
  // Rotation: use the new refresh token if issued, otherwise keep the previous one
  if (!next.refresh_token) next.refresh_token = cred.refresh_token
  return next
}

function toCredential(t: Record<string, unknown>, ctx: Record<string, unknown>): OAuthCredential {
  if (typeof t.access_token !== 'string' || !t.access_token) throw new OAuthStageError('token_exchange', 'Token response has no access_token')
  if (t.token_type && String(t.token_type).toLowerCase() !== 'bearer') throw new OAuthStageError('token_exchange', `Unsupported token type ${String(t.token_type).slice(0, 20)}`)
  return {
    access_token: t.access_token,
    refresh_token: typeof t.refresh_token === 'string' ? t.refresh_token : undefined,
    expires_at: typeof t.expires_in === 'number' ? Math.floor(Date.now() / 1000) + t.expires_in : undefined,
    token_type: 'Bearer',
    scope: typeof t.scope === 'string' ? t.scope : undefined,
    client_information: ctx.clientInformation as Record<string, unknown>,
    authorization_server: String(ctx.asUrl),
    metadata: (ctx.metadata ?? undefined) as Record<string, unknown> | undefined,
    resource: ctx.resource ? String(ctx.resource) : undefined,
    strategy: ctx.strategy as RegistrationStrategy | undefined,
  }
}

function b64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Client ID Metadata Document served by NALUKESA (public, non-secret). */
export function clientMetadataDocument(origin: string) {
  return {
    client_id: `${origin}/oauth/client-metadata.json`,
    client_name: 'NALUKESA MCP Gateway',
    client_uri: origin,
    redirect_uris: [`${origin}/api/connector/oauth/callback`],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  }
}
