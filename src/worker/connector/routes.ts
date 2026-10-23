/**
 * Owner-only connector API. Mounted under /api/connector (behind requireOwner).
 * The OAuth callback is mounted separately and authenticates via the owner
 * session cookie + single-use state (it is a top-level browser navigation).
 */
import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import * as svc from './service'
import { startOAuth, finishOAuth } from './oauth'
import { sealJson, openJson } from './crypto'
import { classify } from './client'
import { redact } from '../hub/safety'
import { sha256 } from '../auth'

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
      { id: 'oauth', label: 'OAuth 2.1 (PKCE + dynamic client registration)', supported: true, note: 'Requires the provider to support RFC 9728 discovery and RFC 7591 dynamic registration' },
    ],
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

// ---------- OAuth start (owner session) ----------
connectorRoutes.post('/connections/:id{[0-9]+}/oauth/start', async (c) => {
  const conn = await svc.getConnection(c.env.DB, id(c))
  if (conn.auth_type !== 'oauth') throw new svc.ServiceError(400, 'Connection is not configured for OAuth')
  if (!c.env.CONNECTOR_ENC_KEY) throw new svc.ServiceError(503, 'CONNECTOR_ENC_KEY is not configured')
  const redirectUri = new URL('/api/connector/oauth/callback', c.req.url).toString()
  try {
    const r = await startOAuth(new URL(conn.endpoint_url), redirectUri, svc.policyFor(conn, c.env, deps(c)))
    await c.env.DB.prepare('DELETE FROM mcp_oauth_states WHERE created_at < ?').bind(Math.floor(Date.now() / 1000) - 600).run()
    await c.env.DB.prepare('INSERT INTO mcp_oauth_states (state_hash, connection_id, context_ciphertext, created_at) VALUES (?,?,?,?)')
      .bind(r.stateHash, conn.id, await sealJson(c.env.CONNECTOR_ENC_KEY, `oauth-ctx:${r.stateHash}`, { ...r.context, hosts: r.hosts }), Math.floor(Date.now() / 1000))
      .run()
    return c.json({ authorization_url: r.authorizationUrl, expires_in: 600 })
  } catch (e) {
    const ce = classify(e)
    throw new svc.ServiceError(502, `OAuth discovery/registration failed: ${redact(e instanceof Error && ce.kind === 'unavailable' ? e.message : ce.message)}`)
  }
})

/** GET /api/connector/oauth/callback — must be registered BEFORE the owner gate's CSRF header rule (GET is exempt anyway). */
export async function oauthCallback(c: Context<Env>) {
  const page = (title: string, msg: string, ok: boolean) =>
    c.html(
      `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>${title}</title><body style="font-family:system-ui;background:#10110f;color:#f4f0e7;display:grid;place-items:center;min-height:100vh"><div style="max-width:420px;text-align:center"><h1 style="font-weight:500">${title}</h1><p style="color:#a4a89a">${msg}</p><a style="color:#c9aa78" href="/#/integrations">Back to NALUKESA</a></div>`,
      ok ? 200 : 400,
    )
  const state = c.req.query('state') ?? ''
  const code = c.req.query('code') ?? ''
  const err = c.req.query('error')
  if (err) return page('Authorization cancelled', 'The provider returned an error. No credential was stored.', false)
  if (!state || !code || state.length > 200 || code.length > 2000) return page('Invalid callback', 'Missing or malformed parameters.', false)
  const h = await sha256('oauth-state:' + state)
  // single-use: mark used atomically
  const row = await c.env.DB.prepare('UPDATE mcp_oauth_states SET used = 1 WHERE state_hash = ? AND used = 0 AND created_at >= ? RETURNING connection_id, context_ciphertext')
    .bind(h, Math.floor(Date.now() / 1000) - 600)
    .first<{ connection_id: number; context_ciphertext: string }>()
  if (!row) return page('Invalid or expired state', 'Start the authorization again from NALUKESA.', false)
  try {
    const ctx = await openJson<Record<string, unknown> & { hosts: string[] }>(c.env.CONNECTOR_ENC_KEY, `oauth-ctx:${h}`, row.context_ciphertext)
    const conn = await svc.getConnection(c.env.DB, row.connection_id)
    const policy = { ...svc.policyFor(conn, c.env, { selfHost: new URL(c.req.url).hostname }), allowedHosts: ctx.hosts }
    const cred = await finishOAuth(ctx, code, policy)
    await svc.saveOAuthCredential(c.env, conn.id, cred, ctx.hosts.filter((x) => x !== new URL(conn.endpoint_url).hostname))
    await c.env.DB.prepare('DELETE FROM mcp_oauth_states WHERE state_hash = ?').bind(h).run()
    return page('Authorization complete', 'Credential stored encrypted. Return to NALUKESA and run “Test & discover”.', true)
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', msg: 'oauth_callback_failed', err: redact(String(e)) }))
    return page('Authorization failed', 'Token exchange failed. No credential was stored.', false)
  }
}
