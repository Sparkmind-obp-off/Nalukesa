/**
 * OAuth 2.1 (authorization code + PKCE) for outbound MCP connections, using the
 * official SDK's discovery / DCR / exchange / refresh helpers with a guarded fetch.
 *
 * Flow:
 *  1. owner clicks "Authorize" -> start(): discover protected-resource metadata
 *     and authorization-server metadata, dynamically register a client (RFC 7591)
 *     if supported, create PKCE + state, persist encrypted context, return URL.
 *  2. provider redirects to /api/connector/oauth/callback?code&state
 *  3. callback(): validate state (hashed, single-use, 10 min TTL), exchange code,
 *     store tokens encrypted; refresh() renews before expiry.
 */
import {
  discoverOAuthServerInfo,
  registerClient,
  startAuthorization,
  exchangeAuthorization,
  refreshAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js'
import { guardedFetch, validateEndpoint, type NetPolicy } from './net'
import { sha256 } from '../auth'

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
}

export interface OAuthStartResult {
  authorizationUrl: string
  stateHash: string
  context: Record<string, unknown>
  hosts: string[]
}

function oauthFetch(policy: NetPolicy) {
  return guardedFetch({ policy, deadlineMs: 10000, maxBytes: 256 * 1024 })
}

/** Discover + register + build the authorization URL. `policy.allowedHosts` grows as hosts are discovered. */
export async function startOAuth(endpoint: URL, redirectUri: string, basePolicy: NetPolicy, existingClient?: Record<string, unknown>): Promise<OAuthStartResult> {
  const hosts = new Set(basePolicy.allowedHosts)
  const policy: NetPolicy = { ...basePolicy, allowedHosts: [...hosts] }
  // Discovery may point at a separate authorization server; validate it before allowing it.
  const info = await discoverOAuthServerInfo(endpoint, {
    fetchFn: async (input, init) => {
      const u = validateEndpoint(typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url, policy)
      if (!policy.allowedHosts.includes(u.hostname)) {
        hosts.add(u.hostname)
        policy.allowedHosts = [...hosts]
      }
      return oauthFetch(policy)(input, init)
    },
  })
  const asUrl = new URL(info.authorizationServerUrl)
  validateEndpoint(asUrl.toString(), policy)
  hosts.add(asUrl.hostname)
  const meta = info.authorizationServerMetadata
  for (const k of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint'] as const) {
    const v = meta?.[k]
    if (typeof v === 'string') {
      const u = validateEndpoint(v, policy)
      hosts.add(u.hostname)
    }
  }
  policy.allowedHosts = [...hosts]
  const f = oauthFetch(policy)
  let clientInformation = existingClient
  if (!clientInformation) {
    if (!meta?.registration_endpoint) throw new Error('Authorization server does not support dynamic client registration; pre-registered clients are not supported yet')
    clientInformation = (await registerClient(asUrl, {
      metadata: meta,
      clientMetadata: {
        client_name: 'NALUKESA Connector',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
      fetchFn: f,
    })) as unknown as Record<string, unknown>
  }
  const state = crypto.randomUUID() + crypto.randomUUID()
  const resource = info.resourceMetadata?.resource ? String(info.resourceMetadata.resource) : endpoint.toString()
  const scope = Array.isArray(info.resourceMetadata?.scopes_supported) ? (info.resourceMetadata!.scopes_supported as string[]).join(' ') : undefined
  const { authorizationUrl, codeVerifier } = await startAuthorization(asUrl, {
    metadata: meta,
    clientInformation: clientInformation as never,
    redirectUrl: redirectUri,
    state,
    resource: new URL(resource),
    scope,
  })
  validateEndpoint(authorizationUrl.toString(), policy)
  return {
    authorizationUrl: authorizationUrl.toString(),
    stateHash: await sha256('oauth-state:' + state),
    context: { codeVerifier, redirectUri, asUrl: asUrl.toString(), metadata: meta ?? null, clientInformation, resource },
    hosts: [...hosts],
  }
}

export async function finishOAuth(ctx: Record<string, unknown>, code: string, policy: NetPolicy): Promise<OAuthCredential> {
  const tokens = await exchangeAuthorization(String(ctx.asUrl), {
    metadata: (ctx.metadata ?? undefined) as never,
    clientInformation: ctx.clientInformation as never,
    authorizationCode: code,
    codeVerifier: String(ctx.codeVerifier),
    redirectUri: String(ctx.redirectUri),
    resource: ctx.resource ? new URL(String(ctx.resource)) : undefined,
    fetchFn: oauthFetch(policy),
  })
  return toCredential(tokens as unknown as Record<string, unknown>, ctx)
}

export async function refreshOAuth(cred: OAuthCredential, policy: NetPolicy): Promise<OAuthCredential> {
  if (!cred.refresh_token) throw new Error('Access token expired and no refresh token is available; re-authorize')
  const tokens = await refreshAuthorization(cred.authorization_server, {
    metadata: (cred.metadata ?? undefined) as never,
    clientInformation: cred.client_information as never,
    refreshToken: cred.refresh_token,
    resource: cred.resource ? new URL(cred.resource) : undefined,
    fetchFn: oauthFetch(policy),
  })
  const next = toCredential(tokens as unknown as Record<string, unknown>, {
    asUrl: cred.authorization_server,
    metadata: cred.metadata,
    clientInformation: cred.client_information,
    resource: cred.resource,
  })
  if (!next.refresh_token) next.refresh_token = cred.refresh_token
  return next
}

function toCredential(t: Record<string, unknown>, ctx: Record<string, unknown>): OAuthCredential {
  if (typeof t.access_token !== 'string' || !t.access_token) throw new Error('Token response has no access_token')
  return {
    access_token: t.access_token,
    refresh_token: typeof t.refresh_token === 'string' ? t.refresh_token : undefined,
    expires_at: typeof t.expires_in === 'number' ? Math.floor(Date.now() / 1000) + t.expires_in : undefined,
    token_type: typeof t.token_type === 'string' ? t.token_type : 'Bearer',
    scope: typeof t.scope === 'string' ? t.scope : undefined,
    client_information: ctx.clientInformation as Record<string, unknown>,
    authorization_server: String(ctx.asUrl),
    metadata: (ctx.metadata ?? undefined) as Record<string, unknown> | undefined,
    resource: ctx.resource ? String(ctx.resource) : undefined,
  }
}
