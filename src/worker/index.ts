import { Hono, type Context, type Next } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { bodyLimit } from 'hono/body-limit'
import { secureHeaders } from 'hono/secure-headers'
import { ENTITIES, isEntityKey, fieldKeys, type EntityKey } from '../shared/entities'
import { validateEntity, type Row } from '../shared/validate'
import { parseCsv, toCsv } from '../shared/csv'
import { SESSION_COOKIE, SESSION_TTL_S, createSession, verifySession, passwordMatches, sha256 } from './auth'
import { handleMcp, TOOL_DEFS, SERVER_INFO } from './mcp/server'
import { bearer, verifyToken, consumeRate, touchToken, createToken, parseScopes, MCP_SCOPES, RATE_LIMIT_PER_MIN } from './mcp/tokens'
import { PROVIDERS, checkProvider, providerStatusReport } from './hub/registry'
import { redact } from './hub/safety'
import { connectorRoutes, oauthCallback } from './connector/routes'

export type Bindings = {
  DB: D1Database
  ASSETS?: Fetcher
  OWNER_PASSWORD?: string
  SESSION_SECRET?: string
  APP_ENV?: string
  /** Set to "false" to disable the inbound MCP endpoint entirely */
  MCP_ENABLED?: string
  HUB_ALLOWED_HOSTS?: string
  CONNECTOR_ENC_KEY?: string
  CONNECTOR_ALLOW_LOCAL?: string
  [key: string]: unknown
}
type Env = { Bindings: Bindings }

const app = new Hono<Env>()
const STALE_DAYS = 30
const MAX_LIMIT = 100
const MAX_IMPORT_ROWS = 500

// ---------- helpers ----------
const fail = (c: Context, status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 503, error: string, details?: unknown) =>
  c.json({ error, ...(details ? { details } : {}) }, status)

const today = () => new Date().toISOString().slice(0, 10)
const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10)

function configured(env: Bindings): boolean {
  return !!env.OWNER_PASSWORD && !!env.SESSION_SECRET && env.SESSION_SECRET.length >= 32
}

async function audit(env: Bindings, action: string, entity?: string, id?: number | null, meta?: Record<string, unknown>) {
  try {
    await env.DB.prepare('INSERT INTO audit_events (actor, action, entity_type, entity_id, metadata) VALUES (?,?,?,?,?)')
      .bind('owner', action, entity ?? null, id ?? null, meta ? JSON.stringify(meta).slice(0, 2000) : null)
      .run()
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', msg: 'audit_failed', action, err: String(e) }))
  }
}

/** Verify referenced rows exist so the user gets a clear message instead of a FK error. */
async function checkRefs(env: Bindings, entity: EntityKey, row: Row): Promise<{ field: string; message: string }[]> {
  const errs: { field: string; message: string }[] = []
  for (const f of ENTITIES[entity].fields) {
    if (f.type !== 'ref' || row[f.key] == null) continue
    const hit = await env.DB.prepare(`SELECT id FROM ${f.ref} WHERE id = ?`).bind(row[f.key]).first()
    if (!hit) errs.push({ field: f.key, message: `${ENTITIES[f.ref!].singular} #${row[f.key]} not found` })
  }
  if (entity === 'decisions' && row.entity_type && row.entity_id != null) {
    const t = String(row.entity_type)
    if (isEntityKey(t)) {
      const hit = await env.DB.prepare(`SELECT id FROM ${t} WHERE id = ?`).bind(row.entity_id).first()
      if (!hit) errs.push({ field: 'entity_id', message: `${ENTITIES[t].singular} #${row.entity_id} not found` })
    }
  }
  return errs
}

// ---------- global middleware ----------
app.use('*', secureHeaders())
app.use('/api/*', async (c, next) => {
  c.header('Cache-Control', 'no-store')
  await next()
})
app.onError((err, c) => {
  console.error(JSON.stringify({ level: 'error', path: c.req.path, err: String(err) }))
  return fail(c, 500, 'Internal error')
})

// ---------- public endpoints ----------
app.get('/api/health', async (c) => {
  let db = 'unavailable'
  try {
    await c.env.DB.prepare('SELECT 1').first()
    db = 'ok'
  } catch {
    db = 'unavailable'
  }
  return c.json({ status: db === 'ok' ? 'ok' : 'degraded', db, auth: configured(c.env) ? 'configured' : 'not_configured', time: new Date().toISOString() })
})

app.get('/api/auth/me', async (c) => {
  if (!configured(c.env)) return c.json({ authenticated: false, configured: false })
  const ok = await verifySession(c.env.SESSION_SECRET!, getCookie(c, SESSION_COOKIE))
  return c.json({ authenticated: ok, configured: true })
})

app.post('/api/auth/login', bodyLimit({ maxSize: 4 * 1024, onError: (c) => fail(c, 413, 'Payload too large') }), async (c) => {
  if (!configured(c.env)) return fail(c, 503, 'Owner access is not configured on the server')
  const ip = c.req.header('cf-connecting-ip') ?? 'local'
  const key = await sha256('login:' + ip)
  const windowStart = Math.floor(Date.now() / 1000) - 15 * 60
  await c.env.DB.prepare('DELETE FROM login_attempts WHERE attempted_at < ?').bind(windowStart).run()
  const cnt = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE client_key = ? AND attempted_at >= ?')
    .bind(key, windowStart).first<{ n: number }>()
  if ((cnt?.n ?? 0) >= 5) return fail(c, 429, 'Too many attempts. Try again in 15 minutes.')

  let password = ''
  try {
    const body = await c.req.json<{ password?: unknown }>()
    password = typeof body.password === 'string' ? body.password : ''
  } catch {
    return fail(c, 400, 'Invalid JSON')
  }
  if (!password || !(await passwordMatches(password, c.env.OWNER_PASSWORD!))) {
    await c.env.DB.prepare('INSERT INTO login_attempts (client_key, attempted_at) VALUES (?, ?)').bind(key, Math.floor(Date.now() / 1000)).run()
    await audit(c.env, 'login_failed')
    return fail(c, 401, 'Incorrect password')
  }
  await c.env.DB.prepare('DELETE FROM login_attempts WHERE client_key = ?').bind(key).run()
  const isLocal = c.env.APP_ENV === 'development'
  setCookie(c, SESSION_COOKIE, await createSession(c.env.SESSION_SECRET!), {
    httpOnly: true,
    secure: !isLocal,
    sameSite: 'Strict',
    path: '/',
    maxAge: SESSION_TTL_S,
  })
  await audit(c.env, 'login')
  return c.json({ ok: true })
})

app.post('/api/auth/logout', (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
  return c.json({ ok: true })
})

// ---------- inbound MCP endpoint (bearer token, separate from owner session) ----------
const MCP_MAX_BODY = 64 * 1024
function mcpError(status: 400 | 401 | 403 | 404 | 405 | 413 | 429 | 503, message: string, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra },
  })
}
app.all('/mcp', async (c) => {
  if (c.env.MCP_ENABLED === 'false') return mcpError(503, 'MCP endpoint disabled')
  // Recursion guard: requests originating from NALUKESA's own outbound connector are refused
  if (c.req.header('x-nk-hop')) return mcpError(403, 'Recursive connector call refused')
  // Browsers must not drive this endpoint cross-origin (DNS-rebinding / CSRF defence)
  const origin = c.req.header('origin')
  if (origin && origin !== new URL(c.req.url).origin) return mcpError(403, 'Origin not allowed')
  const tok = bearer(c.req.header('authorization'))
  const wwwAuth = { 'WWW-Authenticate': 'Bearer realm="nalukesa-mcp"' }
  if (!tok) return mcpError(401, 'Bearer token required', wwwAuth)
  const rec = await verifyToken(c.env.DB, tok)
  if (!rec) {
    console.log(JSON.stringify({ level: 'warn', msg: 'mcp_auth_failed' }))
    return mcpError(401, 'Invalid, expired or revoked token', wwwAuth)
  }
  if (!(await consumeRate(c.env.DB, rec.id))) return mcpError(429, `Rate limit ${RATE_LIMIT_PER_MIN}/min exceeded`, { 'Retry-After': '60' })
  if (c.req.method === 'GET' || c.req.method === 'DELETE') return mcpError(405, 'Stateless server: use POST', { Allow: 'POST' })
  if (c.req.method !== 'POST') return mcpError(405, 'Method not allowed', { Allow: 'POST' })
  const len = Number(c.req.header('content-length') ?? '0')
  if (len > MCP_MAX_BODY) return mcpError(413, 'Request too large')
  const text = await c.req.text()
  if (text.length > MCP_MAX_BODY) return mcpError(413, 'Request too large')
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }), { status: 400, headers: { 'Content-Type': 'application/json' } })
  }
  c.executionCtx.waitUntil(touchToken(c.env.DB, rec.id))
  const res = await handleMcp(c.req.raw, c.env as Bindings & { DB: D1Database }, rec, body)
  const h = new Headers(res.headers)
  h.set('Cache-Control', 'no-store')
  return new Response(res.body, { status: res.status, headers: h })
})

// ---------- OAuth callback for outbound connector (owner session required) ----------
app.get('/api/connector/oauth/callback', async (c, next) => {
  if (!configured(c.env) || !(await verifySession(c.env.SESSION_SECRET!, getCookie(c, SESSION_COOKIE)))) {
    return c.html('<!doctype html><meta charset="utf-8"><p>Sign in to NALUKESA first, then restart the authorization.</p><a href="/">Sign in</a>', 401)
  }
  await next()
}, (c) => oauthCallback(c as never))

// ---------- auth gate for everything else under /api ----------
async function requireOwner(c: Context<Env>, next: Next) {
  if (!configured(c.env)) return fail(c, 503, 'Owner access is not configured on the server')
  const ok = await verifySession(c.env.SESSION_SECRET!, getCookie(c, SESSION_COOKIE))
  if (!ok) return fail(c, 401, 'Authentication required')
  // CSRF defence in depth (cookie is SameSite=Strict too)
  if (c.req.method !== 'GET' && c.req.header('x-nk-client') !== 'web') return fail(c, 403, 'Missing client header')
  await next()
}
app.use('/api/*', requireOwner)

// ---------- overview ----------
app.get('/api/overview', async (c) => {
  const db = c.env.DB
  const t = today()
  const counts: Record<string, number> = {}
  const countStmts = Object.keys(ENTITIES).map((k) => db.prepare(`SELECT COUNT(*) AS n FROM ${k}`))
  const countRes = await db.batch<{ n: number }>(countStmts)
  Object.keys(ENTITIES).forEach((k, i) => (counts[k] = countRes[i].results[0]?.n ?? 0))

  const [byStatus, staleProducts, dueReviews, expNoDecision, publishedNoPerf, recentDecisions, perfTotals] = await db.batch([
    db.prepare('SELECT status, COUNT(*) AS n FROM niches GROUP BY status'),
    db.prepare(
      `SELECT p.id, p.name, MAX(o.checked_at) AS last_checked
       FROM products p LEFT JOIN offer_snapshots o ON o.product_id = p.id
       WHERE p.status NOT IN ('Rejected','Hold')
       GROUP BY p.id HAVING last_checked IS NULL OR last_checked < ?
       ORDER BY last_checked IS NOT NULL, last_checked LIMIT 10`,
    ).bind(daysAgo(STALE_DAYS)),
    db.prepare(
      `SELECT 'niches' AS entity, id, name AS title, next_review_date AS due FROM niches WHERE next_review_date IS NOT NULL AND next_review_date <= date(?, '+7 day') AND status != 'Rejected'
       UNION ALL
       SELECT 'experiments', id, name, review_date FROM experiments WHERE review_date IS NOT NULL AND review_date <= date(?, '+7 day') AND status IN ('Planned','Running')
       ORDER BY due LIMIT 10`,
    ).bind(t, t),
    db.prepare(
      `SELECT e.id, e.name, e.status FROM experiments e
       WHERE e.status IN ('Running','Completed')
       AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.entity_type='experiments' AND d.entity_id=e.id)
       LIMIT 10`,
    ),
    db.prepare(
      `SELECT ci.id, ci.title FROM content_items ci WHERE ci.status='Published'
       AND NOT EXISTS (SELECT 1 FROM performance_snapshots ps WHERE ps.content_item_id = ci.id) LIMIT 10`,
    ),
    db.prepare('SELECT * FROM decisions ORDER BY decided_at DESC, id DESC LIMIT 5'),
    db.prepare(
      `SELECT COUNT(*) AS snapshots,
        SUM(clicks) AS clicks, COUNT(clicks) AS clicks_recorded,
        SUM(orders) AS orders, COUNT(orders) AS orders_recorded,
        SUM(approved_commission_idr) AS approved_commission_idr, COUNT(approved_commission_idr) AS commission_recorded
       FROM performance_snapshots`,
    ),
  ])
  return c.json({
    counts,
    nichesByStatus: byStatus.results,
    staleProducts: staleProducts.results,
    staleDays: STALE_DAYS,
    dueReviews: dueReviews.results,
    experimentsWithoutDecision: expNoDecision.results,
    publishedWithoutPerformance: publishedNoPerf.results,
    recentDecisions: recentDecisions.results,
    performance: perfTotals.results[0],
  })
})

app.get('/api/audit', async (c) => {
  const r = await c.env.DB.prepare('SELECT * FROM audit_events ORDER BY id DESC LIMIT 100').all()
  return c.json({ items: r.results })
})

// ---------- lookups for select inputs ----------
app.get('/api/lookup/:entity', async (c) => {
  const entity = c.req.param('entity')
  if (!isEntityKey(entity)) return fail(c, 404, 'Unknown entity')
  const tf = ENTITIES[entity].titleField
  const r = await c.env.DB.prepare(`SELECT id, ${tf} AS title FROM ${entity} ORDER BY id DESC LIMIT 1000`).all()
  return c.json({ items: r.results })
})

// ---------- CSV export ----------
app.get('/api/export/:file', async (c) => {
  const m = /^([a-z_]+)\.csv$/.exec(c.req.param('file'))
  if (!m || !isEntityKey(m[1])) return fail(c, 404, 'Unknown entity')
  const entity = m[1]
  const cols = ['id', ...fieldKeys(entity), 'created_at', ...(ENTITIES[entity].appendOnly ? [] : ['updated_at'])]
  const r = await c.env.DB.prepare(`SELECT ${cols.join(',')} FROM ${entity} ORDER BY id`).all<Record<string, unknown>>()
  await audit(c.env, 'export', entity, null, { rows: r.results.length })
  return new Response(toCsv(cols, r.results), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="nalukesa-${entity}-${today()}.csv"`,
      'Cache-Control': 'no-store',
    },
  })
})

// ---------- CSV import (validate → explicit commit) ----------
interface RowReport { line: number; ok: boolean; errors: { field: string; message: string }[]; value?: Row }

async function analyzeCsv(env: Bindings, entity: EntityKey, text: string) {
  const rows = parseCsv(text)
  if (rows.length < 2) return { error: 'CSV needs a header row and at least one data row' as const }
  const header = rows[0].map((h) => h.trim())
  const allowed = new Set(fieldKeys(entity))
  const ignored = header.filter((h) => !allowed.has(h) && h !== 'id' && h !== 'created_at' && h !== 'updated_at')
  const unknownCols = header.filter((h) => !allowed.has(h) && !['id', 'created_at', 'updated_at'].includes(h))
  const used = header.filter((h) => allowed.has(h))
  const missingRequired = ENTITIES[entity].fields.filter((f) => f.required && !used.includes(f.key)).map((f) => f.key)
  const data = rows.slice(1)
  if (data.length > MAX_IMPORT_ROWS) return { error: `Max ${MAX_IMPORT_ROWS} rows per import` as const }
  const reports: RowReport[] = []
  for (let i = 0; i < data.length; i++) {
    const obj: Record<string, string> = {}
    header.forEach((h, j) => {
      if (allowed.has(h)) obj[h] = data[i][j] ?? ''
    })
    const v = validateEntity(entity, obj, 'create')
    if (!v.ok) reports.push({ line: i + 2, ok: false, errors: v.errors })
    else {
      const refErrs = await checkRefs(env, entity, v.value)
      reports.push(refErrs.length ? { line: i + 2, ok: false, errors: refErrs } : { line: i + 2, ok: true, errors: [], value: v.value })
    }
  }
  return { header, used, ignored: unknownCols.length ? unknownCols : ignored, missingRequired, reports }
}

const writeLimit = bodyLimit({ maxSize: 64 * 1024, onError: (c) => fail(c, 413, 'Payload too large') })
const writeLimitSmall = () => bodyLimit({ maxSize: 4 * 1024, onError: (c) => fail(c, 413, 'Payload too large') })
const importLimit = bodyLimit({ maxSize: 1024 * 1024, onError: (c) => fail(c, 413, 'CSV larger than 1 MB') })

app.post('/api/import/:entity/validate', importLimit, async (c) => {
  const entity = c.req.param('entity')
  if (!isEntityKey(entity) || !ENTITIES[entity].csvImport) return fail(c, 404, 'Import not supported for this entity')
  const res = await analyzeCsv(c.env, entity, await c.req.text())
  if ('error' in res) return fail(c, 400, res.error!)
  const valid = res.reports.filter((r) => r.ok).length
  return c.json({ ...res, total: res.reports.length, valid, invalid: res.reports.length - valid })
})

app.post('/api/import/:entity/commit', importLimit, async (c) => {
  const entity = c.req.param('entity')
  if (!isEntityKey(entity) || !ENTITIES[entity].csvImport) return fail(c, 404, 'Import not supported for this entity')
  const res = await analyzeCsv(c.env, entity, await c.req.text())
  if ('error' in res) return fail(c, 400, res.error!)
  const bad = res.reports.filter((r) => !r.ok)
  if (bad.length) return fail(c, 400, `${bad.length} row(s) invalid — nothing imported`, bad)
  const stmts = res.reports.map((r) => {
    const keys = Object.keys(r.value!)
    return c.env.DB.prepare(`INSERT INTO ${entity} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).bind(...keys.map((k) => r.value![k]))
  })
  await c.env.DB.batch(stmts) // atomic
  await audit(c.env, 'import', entity, null, { rows: stmts.length })
  return c.json({ imported: stmts.length })
})

// ---------- MCP token management & hub (owner session only) ----------
app.get('/api/mcp/info', async (c) => {
  const r = await c.env.DB.prepare('SELECT id, name, token_prefix, scopes, created_at, expires_at, revoked_at, last_used_at FROM mcp_tokens ORDER BY id DESC').all()
  return c.json({
    enabled: c.env.MCP_ENABLED !== 'false',
    endpoint: new URL('/mcp', c.req.url).toString(),
    transport: 'streamable-http (stateless, JSON responses)',
    server: SERVER_INFO,
    scopes: MCP_SCOPES,
    tools: TOOL_DEFS,
    rate_limit_per_min: RATE_LIMIT_PER_MIN,
    tokens: r.results,
  })
})
app.post('/api/mcp/tokens', writeLimitSmall(), async (c) => {
  let b: { name?: unknown; scopes?: unknown; ttl_days?: unknown }
  try {
    b = await c.req.json()
  } catch {
    return fail(c, 400, 'Invalid JSON')
  }
  const name = typeof b.name === 'string' ? b.name.trim() : ''
  if (!name || name.length > 80) return fail(c, 400, 'Validation failed', [{ field: 'name', message: 'Required, max 80 characters' }])
  const scopes = parseScopes(b.scopes)
  if (!scopes) return fail(c, 400, 'Validation failed', [{ field: 'scopes', message: `One or more of: ${MCP_SCOPES.join(', ')}` }])
  const ttl = typeof b.ttl_days === 'number' ? b.ttl_days : 90
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 365) return fail(c, 400, 'Validation failed', [{ field: 'ttl_days', message: '1–365' }])
  const { token, record } = await createToken(c.env.DB, name, scopes, ttl)
  await audit(c.env, 'mcp_token_create', 'mcp_tokens', (record as { id: number }).id, { scopes, ttl })
  // token is returned exactly once and never stored in plaintext
  return c.json({ token, record, warning: 'Copy this token now. It cannot be shown again.' }, 201)
})
app.post('/api/mcp/tokens/:id{[0-9]+}/revoke', async (c) => {
  const id = Number(c.req.param('id'))
  const r = await c.env.DB.prepare(`UPDATE mcp_tokens SET revoked_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ? AND revoked_at IS NULL`).bind(id).run()
  if (!r.meta.changes) return fail(c, 404, 'Token not found or already revoked')
  await audit(c.env, 'mcp_token_revoke', 'mcp_tokens', id)
  return c.json({ ok: true })
})
app.get('/api/hub/providers', async (c) => c.json({ providers: await providerStatusReport(c.env.DB, c.env) }))
app.post('/api/hub/providers/:id/check', async (c) => {
  const def = PROVIDERS.find((p) => p.id === c.req.param('id'))
  if (!def) return fail(c, 404, 'Unknown provider')
  const r = await checkProvider(def, c.env)
  const secrets = def.secretEnv ? [c.env[def.secretEnv] as string | undefined] : []
  const detail = r.error ? redact(r.error, secrets) : null
  if (r.status !== 'not_configured') {
    await c.env.DB.prepare('INSERT INTO provider_checks (provider_id, status, latency_ms, detail) VALUES (?,?,?,?)').bind(def.id, r.status, r.latency_ms, detail).run()
  }
  await audit(c.env, 'provider_check', 'provider', null, { provider: def.id, status: r.status })
  return c.json({ provider_id: def.id, status: r.status, observed_at: r.observed_at, latency_ms: r.latency_ms, detail })
})

app.route('/api/connector', connectorRoutes as never)

// ---------- generic CRUD ----------

app.get('/api/:entity', async (c) => {
  const entity = c.req.param('entity')
  if (!isEntityKey(entity)) return fail(c, 404, 'Unknown entity')
  const def = ENTITIES[entity]
  const where: string[] = []
  const binds: unknown[] = []
  const q = (c.req.query('q') ?? '').trim().slice(0, 100)
  if (q) {
    where.push('(' + def.searchable.map((s) => `${s} LIKE ? ESCAPE '\\'`).join(' OR ') + ')')
    const like = '%' + q.replace(/[\\%_]/g, (m) => '\\' + m) + '%'
    def.searchable.forEach(() => binds.push(like))
  }
  for (const f of def.filterable) {
    const v = c.req.query(f)
    if (v !== undefined && v !== '') {
      where.push(`${f} = ?`)
      binds.push(v)
    }
  }
  const sortable = new Set(['id', 'created_at', ...fieldKeys(entity)])
  const sort = sortable.has(c.req.query('sort') ?? '') ? c.req.query('sort')! : 'id'
  const dir = c.req.query('dir') === 'asc' ? 'ASC' : 'DESC'
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') ?? '50', 10) || 50, 1), MAX_LIMIT)
  const page = Math.max(parseInt(c.req.query('page') ?? '1', 10) || 1, 1)
  const w = where.length ? 'WHERE ' + where.join(' AND ') : ''
  const [rows, total] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT * FROM ${entity} ${w} ORDER BY ${sort} ${dir} NULLS LAST, id DESC LIMIT ? OFFSET ?`).bind(...binds, limit, (page - 1) * limit),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM ${entity} ${w}`).bind(...binds),
  ])
  return c.json({ items: rows.results, total: (total.results[0] as { n: number }).n, page, limit })
})

app.get('/api/:entity/:id{[0-9]+}', async (c) => {
  const entity = c.req.param('entity')
  if (!isEntityKey(entity)) return fail(c, 404, 'Unknown entity')
  const row = await c.env.DB.prepare(`SELECT * FROM ${entity} WHERE id = ?`).bind(Number(c.req.param('id'))).first()
  if (!row) return fail(c, 404, 'Not found')
  return c.json(row)
})

app.post('/api/:entity', writeLimit, async (c) => {
  const entity = c.req.param('entity')
  if (!isEntityKey(entity)) return fail(c, 404, 'Unknown entity')
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return fail(c, 400, 'Invalid JSON')
  }
  const v = validateEntity(entity, body, 'create')
  if (!v.ok) return fail(c, 400, 'Validation failed', v.errors)
  const refErrs = await checkRefs(c.env, entity, v.value)
  if (refErrs.length) return fail(c, 400, 'Validation failed', refErrs)
  const keys = Object.keys(v.value)
  const r = await c.env.DB.prepare(`INSERT INTO ${entity} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')}) RETURNING *`)
    .bind(...keys.map((k) => v.value[k]))
    .first<{ id: number }>()
  await audit(c.env, 'create', entity, r?.id)
  return c.json(r, 201)
})

app.patch('/api/:entity/:id{[0-9]+}', writeLimit, async (c) => {
  const entity = c.req.param('entity')
  if (!isEntityKey(entity)) return fail(c, 404, 'Unknown entity')
  if (ENTITIES[entity].appendOnly) return fail(c, 409, `${ENTITIES[entity].label} are append-only history; add a new record instead`)
  const id = Number(c.req.param('id'))
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return fail(c, 400, 'Invalid JSON')
  }
  const existing = await c.env.DB.prepare(`SELECT * FROM ${entity} WHERE id = ?`).bind(id).first<Row>()
  if (!existing) return fail(c, 404, 'Not found')
  const v = validateEntity(entity, body, 'update')
  if (!v.ok) return fail(c, 400, 'Validation failed', v.errors)
  // re-run cross-field rules on the merged record
  const merged: Record<string, unknown> = {}
  for (const k of fieldKeys(entity)) merged[k] = existing[k]
  Object.assign(merged, v.value)
  const full = validateEntity(entity, merged, 'create')
  if (!full.ok) return fail(c, 400, 'Validation failed', full.errors)
  const refErrs = await checkRefs(c.env, entity, v.value)
  if (refErrs.length) return fail(c, 400, 'Validation failed', refErrs)
  const keys = Object.keys(v.value)
  const r = await c.env.DB.prepare(
    `UPDATE ${entity} SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ? RETURNING *`,
  )
    .bind(...keys.map((k) => v.value[k]), id)
    .first()
  const changed = keys.filter((k) => existing[k] !== v.value[k])
  await audit(c.env, 'update', entity, id, { fields: changed })
  return c.json(r)
})

app.delete('/api/:entity/:id{[0-9]+}', async (c) => {
  const entity = c.req.param('entity')
  if (!isEntityKey(entity)) return fail(c, 404, 'Unknown entity')
  if (ENTITIES[entity].appendOnly) return fail(c, 409, `${ENTITIES[entity].label} are append-only history and cannot be deleted`)
  const id = Number(c.req.param('id'))
  try {
    const r = await c.env.DB.prepare(`DELETE FROM ${entity} WHERE id = ?`).bind(id).run()
    if (!r.meta.changes) return fail(c, 404, 'Not found')
  } catch (e) {
    if (/FOREIGN KEY/i.test(String(e))) return fail(c, 409, 'Other records depend on this one. Remove or reassign them first.')
    throw e
  }
  await audit(c.env, 'delete', entity, id)
  return c.json({ ok: true })
})

app.all('/api/*', (c) => fail(c, 404, 'Not found'))

// Non-API requests: hand over to static assets (Pages advanced mode).
app.all('*', (c) => (c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.text('Not found', 404)))

export default app
