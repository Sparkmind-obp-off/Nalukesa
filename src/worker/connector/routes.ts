/**
 * Owner-only connector API. Mounted under /api/connector (behind requireOwner).
 * The OAuth callback is mounted separately and authenticates via the owner
 * session cookie + single-use state (it is a top-level browser navigation).
 */
import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import * as svc from './service'
import { startOAuth, finishOAuth, discover, OAuthStageError, clientMetadataDocument } from './oauth'
import { sealJson, openJson } from './crypto'
import { classify } from './client'
import { redact } from '../hub/safety'
import { sha256 } from '../auth'
import { getCookie } from 'hono/cookie'
import { SESSION_COOKIE } from '../auth'

type Env = { Bindings: svc.ConnectorEnv }

const fail = (c: Context, status: number, error: string, details?: unknown) => c.json({ error, ...(details ? { details } : {}) }, status as 400)
const id = (c: Context) => {
  const n = Number(c.req.param('id'))
  if (!Number.isSafeInteger(n) || n < 1) throw new svc.ServiceError(404, 'Connection not found')
  return n
}
const deps = (c: Context): svc.ConnectorDeps => ({ selfHost: new URL(c.req.url).hostname })
const small = bodyLimit({ maxSize: 16 * 1024, onError: (c) => fail(c, 413, 'Payload too large') })
const invokeLimit = bodyLimit({ maxSize: 40 * 1024, onError: (c) => fail(c, 413, 'Payload too large') })

async function json<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T
  } catch {
    throw new svc.ServiceError(400, 'Invalid JSON')
  }
}

export const connectorRoutes = new Hono<Env>()

connectorRoutes.onError((err, c) => {
  if (err instanceof svc.ServiceError) return fail(c, err.status, err.message, err.details)
  console.error(JSON.stringify({ level: 'error', msg: 'connector_error', err: redact(String(err)) }))
  return fail(c, 500, 'Internal error')
})

connectorRoutes.get('/meta', (c) =>
  c.json({
    transports: [{ id: 'streamable_http', label: 'Streamable HTTP', supported: true }, { id: 'sse', label: 'HTTP+SSE (legacy)', supported: false, reason: 'Deprecated transport; not implemented' }, { id: 'stdio', label: 'stdio', supported: false, reason: 'Not possible from a Cloudflare Worker' }],
    auth_types: [
      { id: 'none', label: 'None', supported: true },
      { id: 'bearer', label: 'Bearer token / API key', supported: true },
      { id: 'oauth', label: 'OAuth 2.1 (authorization code + PKCE S256)', supported: true, note: 'Registration: Client ID Metadata Document, Dynamic Client Registration (RFC 7591), or a pre-registered OAuth app' },
    ],
    oauth: {
      registration_strategies: [
        { id: 'cimd', label: 'Client ID Metadata Document', supported: true, requires: 'Provider advertises client_id_metadata_document_supported' },
        { id: 'dcr', label: 'Dynamic Client Registration (RFC 7591)', supported: true, requires: 'Provider advertises registration_endpoint' },
        { id: 'preregistered', label: 'Pre-registered OAuth app', supported: true, requires: 'Owner registers NALUKESA with the provider and enters the client ID (and secret if confidential)' },
      ],
      token_endpoint_auth_methods: ['none', 'client_secret_basic', 'client_secret_post'],
      discovery: ['RFC 9728 protected resource metadata', 'RFC 8414 authorization server metadata', 'OpenID Connect Discovery 1.0'],
      pkce: 'S256 (mandatory)',
      redirect_uri: redirectUriFor(c.req.url),
      client_id_metadata_document: cimdUrlFor(c.req.url, c.env),
    },
    encryption_configured: !!c.env.CONNECTOR_ENC_KEY,
    local_mock_allowed: svc.allowLocal(c.env),
    limits: { timeout_ms: [1000, 30000], max_response_bytes: [1024, 4194304], calls_per_minute: [1, 120], max_argument_bytes: 32768 },
  }),
)
connectorRoutes.get('/connections', async (c) => c.json({ connections: await svc.listConnections(c.env.DB) }))
connectorRoutes.post('/connections', small, async (c) => c.json(await svc.createConnection(c.env, await json(c), deps(c)), 201))
connectorRoutes.get('/connections/:id{[0-9]+}', async (c) => {
  const conn = await svc.getConnection(c.env.DB, id(c))
  const tools = await svc.listTools(c.env.DB, conn.id)
  return c.json({ ...svc.publicConnection(conn), readiness: svc.readiness(conn, tools.filter((t) => t.permission === 'allowed' && t.present).length), tools })
})
connectorRoutes.patch('/connections/:id{[0-9]+}', small, async (c) => c.json(await svc.updateConnection(c.env, id(c), await json(c), deps(c))))
connectorRoutes.delete('/connections/:id{[0-9]+}', async (c) => {
  await svc.deleteConnection(c.env, id(c))
  return c.json({ ok: true })
})
connectorRoutes.post('/connections/:id{[0-9]+}/revoke-credential', async (c) => c.json(await svc.revokeCredential(c.env, id(c))))
connectorRoutes.post('/connections/:id{[0-9]+}/test', async (c) => c.json(await svc.testConnection(c.env, id(c), deps(c))))
connectorRoutes.get('/connections/:id{[0-9]+}/tools', async (c) => c.json({ tools: await svc.listTools(c.env.DB, id(c), c.req.query('allowed') === '1') }))
connectorRoutes.put('/connections/:id{[0-9]+}/tools/:tool/permission', small, async (c) => {
  const b = await json<{ permission?: unknown; confirm_risk?: unknown }>(c)
  return c.json(await svc.setToolPermission(c.env, id(c), decodeURIComponent(c.req.param('tool')), b.permission, b.confirm_risk))
})
connectorRoutes.post('/connections/:id{[0-9]+}/tools/:tool/invoke', invokeLimit, async (c) => {
  const b = await json<{ arguments?: unknown }>(c)
  const r = await svc.invokeTool(c.env, id(c), decodeURIComponent(c.req.param('tool')), b.arguments ?? {}, 'owner:web', deps(c))
  return c.json(r, r.ok || r.status === 'tool_error' ? 200 : r.status === 'invalid_arguments' ? 400 : r.status === 'blocked' ? 403 : r.status === 'rate_limited' ? 429 : 502)
})
connectorRoutes.get('/connections/:id{[0-9]+}/invocations', async (c) => c.json({ invocations: await svc.listInvocations(c.env.DB, id(c)) }))
connectorRoutes.get('/connections/:id{[0-9]+}/audit', async (c) => c.json({ audit: await svc.connectionAudit(c.env.DB, id(c)) }))
connectorRoutes.get('/invocations', async (c) => c.json({ invocations: await svc.listInvocations(c.env.DB, null) }))

// ---------- OAuth (owner session) ----------
const OAUTH_STATE_TTL = 600

/** NALUKESA's CIMD URL — HTTPS origin only; plain http allowed solely for local development tests. */
export function cimdUrlFor(reqUrl: string, env?: svc.ConnectorEnv): string | null {
  const u = new URL(reqUrl)
  if (u.protocol === 'https:' || (env && svc.allowLocal(env) && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'))) return `${u.origin}/oauth/client-metadata.json`
  return null
}
function redirectUriFor(reqUrl: string) {
  return new URL('/api/connector/oauth/callback', reqUrl).toString()
}
async function oauthInputs(c: Context<Env>, conn: svc.ConnectionRow) {
  return {
    endpoint: new URL(conn.endpoint_url),
    policy: svc.policyFor(conn, c.env, deps(c)),
    mode: conn.oauth_mode,
    preregistered: await svc.preregisteredClient(c.env, conn),
    cimdUrl: cimdUrlFor(c.req.url, c.env),
  }
}
function stageFailure(e: unknown) {
  if (e instanceof OAuthStageError) return { stage: e.stage, message: redact(e.message), next_action: e.nextAction ?? null, diagnostics: (e as { diagnostics?: unknown }).diagnostics ?? null }
  const ce = classify(e)
  return { stage: 'network', message: redact(ce.message), next_action: null, diagnostics: null }
}

connectorRoutes.get('/oauth/client-info', (c) =>
  c.json({ redirect_uri: redirectUriFor(c.req.url), client_id_metadata_document: cimdUrlFor(c.req.url, c.env), cimd_available: !!cimdUrlFor(c.req.url, c.env) }),
)

/** Discovery only (no registration, no redirect). Persists non-secret diagnostics. */
connectorRoutes.post('/connections/:id{[0-9]+}/oauth/diagnose', async (c) => {
  const conn = await svc.getConnection(c.env.DB, id(c))
  if (conn.auth_type !== 'oauth') throw new svc.ServiceError(400, 'Connection is not configured for OAuth')
  try {
    const r = await discover(await oauthInputs(c, conn))
    await svc.saveDiagnostics(c.env, conn.id, r.diagnostics)
    return c.json({ ok: true, diagnostics: r.diagnostics })
  } catch (e) {
    const f = stageFailure(e)
    await svc.saveDiagnostics(c.env, conn.id, f.diagnostics ?? { stage_reached: f.stage, message: f.message, next_action: f.next_action })
    return c.json({ ok: false, ...f })
  }
})

connectorRoutes.post('/connections/:id{[0-9]+}/oauth/start', async (c) => {
  const conn = await svc.getConnection(c.env.DB, id(c))
  if (conn.auth_type !== 'oauth') throw new svc.ServiceError(400, 'Connection is not configured for OAuth')
  if (!conn.enabled) throw new svc.ServiceError(409, 'Connection is disabled')
  if (!c.env.CONNECTOR_ENC_KEY) throw new svc.ServiceError(503, 'CONNECTOR_ENC_KEY is not configured')
  const blob = await svc.readClientBlob(c.env, conn)
  try {
    const r = await startOAuth({ ...(await oauthInputs(c, conn)), redirectUri: redirectUriFor(c.req.url), scopeOverride: conn.oauth_scopes, dcrCache: blob.dcr ?? null })
    if (r.newDcrRegistration) await svc.writeClientBlob(c.env, conn.id, { ...blob, dcr: r.newDcrRegistration })
    await svc.saveDiagnostics(c.env, conn.id, r.diagnostics)
    const session = getCookie(c, SESSION_COOKIE) ?? ''
    const now = Math.floor(Date.now() / 1000)
    await c.env.DB.prepare('DELETE FROM mcp_oauth_states WHERE created_at < ? OR connection_id = ?').bind(now - OAUTH_STATE_TTL, conn.id).run()
    await c.env.DB.prepare('INSERT INTO mcp_oauth_states (state_hash, connection_id, context_ciphertext, created_at, session_hash) VALUES (?,?,?,?,?)')
      .bind(r.stateHash, conn.id, await sealJson(c.env.CONNECTOR_ENC_KEY, `oauth-ctx:${r.stateHash}`, r.context), now, await sha256('oauth-session:' + session))
      .run()
    await c.env.DB.prepare('INSERT INTO audit_events (actor, action, entity_type, entity_id, metadata) VALUES (?,?,?,?,?)')
      .bind('owner', 'connector_oauth_start', 'mcp_connections', conn.id, JSON.stringify({ strategy: r.diagnostics.selected, issuer_host: r.diagnostics.authorization_server.issuer ? new URL(r.diagnostics.authorization_server.issuer).host : null }))
      .run()
    return c.json({ ok: true, authorization_url: r.authorizationUrl, strategy: r.diagnostics.selected, expires_in: OAUTH_STATE_TTL, diagnostics: r.diagnostics })
  } catch (e) {
    const f = stageFailure(e)
    if (f.diagnostics) await svc.saveDiagnostics(c.env, conn.id, f.diagnostics)
    await c.env.DB.prepare('INSERT INTO audit_events (actor, action, entity_type, entity_id, metadata) VALUES (?,?,?,?,?)')
      .bind('owner', 'connector_oauth_start_failed', 'mcp_connections', conn.id, JSON.stringify({ stage: f.stage }))
      .run()
    return c.json({ ok: false, ...f }, 422)
  }
})

/** GET /api/connector/oauth/callback — requires owner session (checked by caller) + single-use state bound to that session. */
export async function oauthCallback(c: Context<Env>) {
  const esc = (x: string) => x.replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]!)
  const page = (title: string, msg: string, ok: boolean) => {
    c.header('Referrer-Policy', 'no-referrer')
    c.header('Cache-Control', 'no-store')
    return c.html(
      `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>${esc(title)}</title><body style="font-family:system-ui;background:#10110f;color:#f4f0e7;display:grid;place-items:center;min-height:100vh"><div style="max-width:440px;text-align:center"><h1 style="font-weight:500">${esc(title)}</h1><p style="color:#a4a89a">${esc(msg)}</p><a style="color:#c9aa78" href="/#/integrations">Back to NALUKESA</a></div>`,
      ok ? 200 : 400,
    )
  }
  const audit = (connId: number | null, action: string, meta: Record<string, unknown>) =>
    c.env.DB.prepare('INSERT INTO audit_events (actor, action, entity_type, entity_id, metadata) VALUES (?,?,?,?,?)').bind('owner', action, 'mcp_connections', connId, JSON.stringify(meta)).run().catch(() => {})
  const state = c.req.query('state') ?? ''
  const code = c.req.query('code') ?? ''
  const err = c.req.query('error')
  if (!state || state.length > 200) return page('Invalid callback', 'Missing or malformed state.', false)
  const h = await sha256('oauth-state:' + state)
  const session = getCookie(c, SESSION_COOKIE) ?? ''
  // single-use + TTL + session binding, enforced atomically
  const row = await c.env.DB.prepare('UPDATE mcp_oauth_states SET used = 1 WHERE state_hash = ? AND used = 0 AND created_at >= ? AND session_hash = ? RETURNING connection_id, context_ciphertext')
    .bind(h, Math.floor(Date.now() / 1000) - OAUTH_STATE_TTL, await sha256('oauth-session:' + session))
    .first<{ connection_id: number; context_ciphertext: string }>()
  if (!row) {
    await audit(null, 'connector_oauth_callback_rejected', { reason: 'state_invalid_expired_replayed_or_other_session' })
    return page('Invalid or expired state', 'This authorization link is invalid, expired, already used, or was started in another session. Start again from NALUKESA.', false)
  }
  await c.env.DB.prepare('DELETE FROM mcp_oauth_states WHERE state_hash = ?').bind(h).run()
  if (err) {
    const safe = /^[a-z_]{1,40}$/.test(err) ? err : 'error'
    await audit(row.connection_id, 'connector_oauth_callback_error', { error: safe })
    await c.env.DB.prepare('UPDATE mcp_connections SET status = ?, last_error = ? WHERE id = ?').bind('auth_required', `callback: provider returned ${safe}`, row.connection_id).run()
    return page('Authorization not completed', `The provider returned "${safe}". No credential was stored.`, false)
  }
  if (!code || code.length > 4096) return page('Invalid callback', 'Missing authorization code.', false)
  try {
    const ctx = await openJson<Record<string, unknown> & { hosts: string[] }>(c.env.CONNECTOR_ENC_KEY, `oauth-ctx:${h}`, row.context_ciphertext)
    const conn = await svc.getConnection(c.env.DB, row.connection_id)
    const policy = { ...svc.policyFor(conn, c.env, { selfHost: new URL(c.req.url).hostname }), allowedHosts: ctx.hosts }
    const cred = await finishOAuth(ctx, code, policy, c.req.query('iss'))
    const endpointHost = svc.policyFor(conn, c.env, {}).allowedHosts[0]
    await svc.saveOAuthCredential(c.env, conn.id, cred, ctx.hosts.filter((x) => x !== endpointHost))
    return page('Authorization complete', 'Credential stored encrypted. Authorization alone does not prove data access. Return to NALUKESA and run “Test & discover”.', true)
  } catch (e) {
    const stage = e instanceof OAuthStageError ? e.stage : 'token_exchange'
    const msg = redact(e instanceof Error ? e.message : String(e), [code])
    console.error(JSON.stringify({ level: 'error', msg: 'oauth_callback_failed', stage, err: msg }))
    await audit(row.connection_id, 'connector_oauth_callback_failed', { stage })
    await c.env.DB.prepare('UPDATE mcp_connections SET status = ?, last_error = ? WHERE id = ?').bind('auth_required', `${stage}: ${msg}`.slice(0, 300), row.connection_id).run()
    return page('Authorization failed', `Stage: ${stage}. No credential was stored.`, false)
  }
}

/** Public, non-secret OAuth Client ID Metadata Document. */
export function clientMetadataRoute(c: Context<Env>) {
  const u = new URL(c.req.url)
  if (!cimdUrlFor(c.req.url, c.env)) return c.json({ error: 'Client ID Metadata Document is only served over HTTPS' }, 404)
  c.header('Cache-Control', 'public, max-age=300')
  return c.json(clientMetadataDocument(u.origin))
}
