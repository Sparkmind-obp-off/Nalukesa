/**
 * Generic external MCP connector service — shared by the owner API and the
 * inbound MCP bridge tools. Provider-agnostic: any standard Streamable-HTTP
 * MCP server can be registered without new code.
 */
import { Validator } from '@cfworker/json-schema'
import { sealJson, openJson, CryptoUnavailable } from './crypto'
import { validateEndpoint, hostKeyOf, type NetPolicy, type Resolver, type FetchLike } from './net'
import { withSession, listAllTools, callRemoteTool, classify, ConnectorError, type RemoteTool } from './client'
import { refreshOAuth, type OAuthCredential, type PreregisteredClient, type TokenAuthMethod } from './oauth'
import { redact } from '../hub/safety'
import { sha256 } from '../auth'

export type AuthType = 'none' | 'bearer' | 'oauth'
export type ConnStatus = 'untested' | 'failed' | 'auth_failed' | 'auth_required' | 'connected' | 'verified'
export type Risk = 'read' | 'write' | 'destructive'

export interface ConnectorEnv {
  DB: D1Database
  CONNECTOR_ENC_KEY?: string
  /** "true" only in local development: allows http://127.0.0.1 mock servers */
  CONNECTOR_ALLOW_LOCAL?: string
  APP_ENV?: string
  [k: string]: unknown
}
export interface ConnectorDeps {
  resolver?: Resolver
  fetchImpl?: FetchLike
  selfHost?: string
}

export interface ConnectionRow {
  id: number
  name: string
  endpoint_url: string
  transport: string
  auth_type: AuthType
  auth_ciphertext: string | null
  auth_hint: string | null
  enabled: number
  owner: string
  timeout_ms: number
  max_response_bytes: number
  calls_per_minute: number
  extra_allowed_hosts: string | null
  status: ConnStatus
  server_name: string | null
  server_version: string | null
  protocol_version: string | null
  last_check_at: string | null
  last_verified_at: string | null
  tools_refreshed_at: string | null
  last_error: string | null
  created_at: string
  updated_at: string
  oauth_mode: 'auto' | 'preregistered'
  oauth_client_id: string | null
  oauth_token_auth_method: TokenAuthMethod | null
  oauth_scopes: string | null
  oauth_client_ciphertext: string | null
  oauth_strategy: string | null
  oauth_diagnostics: string | null
  oauth_authorized_at: string | null
  oauth_token_expires_at: string | null
  oauth_last_refresh_at: string | null
}

export class ServiceError extends Error {
  constructor(public status: 400 | 403 | 404 | 409 | 429 | 502 | 503, message: string, public details?: unknown) {
    super(message)
  }
}

const AUTH_PURPOSE = (id: number) => `mcp-connection-auth:${id}`
const CLIENT_PURPOSE = (id: number) => `mcp-connection-oauth-client:${id}`
const MAX_ARG_BYTES = 32 * 1024
const PREVIEW_BYTES = 4000
const NOW = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

export function allowLocal(env: ConnectorEnv) {
  return env.CONNECTOR_ALLOW_LOCAL === 'true' && env.APP_ENV === 'development'
}

/** Public projection — never includes ciphertext. */
export function publicConnection(c: ConnectionRow) {
  const { auth_ciphertext, oauth_client_ciphertext, oauth_diagnostics, ...rest } = c
  let diagnostics: unknown = null
  try {
    diagnostics = oauth_diagnostics ? JSON.parse(oauth_diagnostics) : null
  } catch {
    diagnostics = null
  }
  return {
    ...rest,
    enabled: !!c.enabled,
    has_credential: !!auth_ciphertext,
    has_client_secret: !!oauth_client_ciphertext && c.oauth_mode === 'preregistered',
    oauth_diagnostics: diagnostics,
    extra_allowed_hosts: c.extra_allowed_hosts?.split(' ').filter(Boolean) ?? [],
    stages: stages(c),
  }
}

/** Distinct, honest per-stage status for the UI. */
export function stages(c: Pick<ConnectionRow, 'auth_type' | 'auth_ciphertext' | 'status' | 'last_check_at' | 'tools_refreshed_at' | 'last_verified_at' | 'oauth_authorized_at' | 'oauth_diagnostics' | 'oauth_mode' | 'oauth_client_id'>) {
  let diag: { stage_reached?: string; selected?: string | null } | null = null
  try {
    diag = c.oauth_diagnostics ? JSON.parse(c.oauth_diagnostics) : null
  } catch {
    diag = null
  }
  return {
    endpoint_reachable: c.status === 'failed' ? 'failed' : c.last_check_at ? 'ok' : 'unknown',
    oauth_configured: c.auth_type !== 'oauth' ? 'n/a' : c.oauth_mode === 'preregistered' ? (c.oauth_client_id ? 'ok' : 'missing_client_id') : diag?.stage_reached === 'ready' ? 'ok' : diag ? 'failed' : 'unknown',
    account_authorized: c.auth_type === 'none' ? 'n/a' : c.auth_ciphertext ? (c.status === 'auth_failed' || c.status === 'auth_required' ? 'failed' : 'ok') : 'missing',
    mcp_initialized: c.tools_refreshed_at && (c.status === 'connected' || c.status === 'verified') ? 'ok' : c.status === 'failed' ? 'failed' : 'unknown',
    tools_discovered: c.tools_refreshed_at ? 'ok' : 'unknown',
    invocation_verified: c.last_verified_at && c.status === 'verified' ? 'ok' : 'unknown',
  }
}

export function riskOf(t: Pick<RemoteTool, 'annotations'>): Risk {
  const a = t.annotations ?? {}
  if (a.destructiveHint === true) return 'destructive'
  if (a.readOnlyHint === true) return 'read'
  return 'write' // per MCP spec, absent hints must be treated as potentially mutating
}

function endpointHostKey(c: Pick<ConnectionRow, 'endpoint_url'>, env: ConnectorEnv) {
  return hostKeyOf(new URL(c.endpoint_url), allowLocal(env))
}

function policyFor(c: Pick<ConnectionRow, 'endpoint_url' | 'extra_allowed_hosts'>, env: ConnectorEnv, deps: ConnectorDeps): NetPolicy {
  const u = new URL(c.endpoint_url)
  const local = allowLocal(env) && u.protocol === 'http:' && u.hostname === '127.0.0.1'
  return {
    allowedHosts: [local ? `127.0.0.1:${u.port}` : u.hostname.toLowerCase(), ...(c.extra_allowed_hosts?.split(' ').filter(Boolean) ?? [])],
    selfHosts: deps.selfHost ? [deps.selfHost] : [],
    allowLocalHttp: allowLocal(env),
    resolver: deps.resolver,
  }
}

async function audit(db: D1Database, action: string, id: number | null, meta: Record<string, unknown>) {
  await db
    .prepare('INSERT INTO audit_events (actor, action, entity_type, entity_id, metadata) VALUES (?,?,?,?,?)')
    .bind('owner', action, 'mcp_connections', id, JSON.stringify(meta).slice(0, 2000))
    .run()
    .catch(() => {})
}

// ---------------- validation of owner input ----------------
export interface ConnectionInput {
  name?: unknown
  endpoint_url?: unknown
  auth_type?: unknown
  bearer_token?: unknown
  timeout_ms?: unknown
  max_response_bytes?: unknown
  calls_per_minute?: unknown
  enabled?: unknown
  oauth_mode?: unknown
  oauth_client_id?: unknown
  oauth_client_secret?: unknown
  oauth_token_auth_method?: unknown
  oauth_scopes?: unknown
  clear_oauth_client_secret?: unknown
}

function intIn(v: unknown, lo: number, hi: number, field: string, errs: { field: string; message: string }[]): number | undefined {
  if (v === undefined) return undefined
  if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) {
    errs.push({ field, message: `Integer ${lo}–${hi}` })
    return undefined
  }
  return v
}

export function validateConnectionInput(input: ConnectionInput, mode: 'create' | 'update', env: ConnectorEnv, deps: ConnectorDeps = {}) {
  const errs: { field: string; message: string }[] = []
  const out: Record<string, unknown> = {}
  const allowed = new Set(['name', 'endpoint_url', 'auth_type', 'bearer_token', 'timeout_ms', 'max_response_bytes', 'calls_per_minute', 'enabled', 'oauth_mode', 'oauth_client_id', 'oauth_client_secret', 'oauth_token_auth_method', 'oauth_scopes', 'clear_oauth_client_secret'])
  for (const k of Object.keys(input ?? {})) if (!allowed.has(k)) errs.push({ field: k, message: 'Unknown field' })
  if (mode === 'create' || input.name !== undefined) {
    const n = typeof input.name === 'string' ? input.name.trim() : ''
    if (!n || n.length > 80) errs.push({ field: 'name', message: 'Required, max 80 characters' })
    else out.name = n
  }
  if (mode === 'create' || input.endpoint_url !== undefined) {
    if (typeof input.endpoint_url !== 'string') errs.push({ field: 'endpoint_url', message: 'Required' })
    else {
      try {
        out.endpoint_url = validateEndpoint(input.endpoint_url.trim(), { allowLocalHttp: allowLocal(env), selfHosts: deps.selfHost ? [deps.selfHost] : [] }).toString()
      } catch (e) {
        errs.push({ field: 'endpoint_url', message: (e as Error).message })
      }
    }
  }
  if (mode === 'create' || input.auth_type !== undefined) {
    if (!['none', 'bearer', 'oauth'].includes(String(input.auth_type))) errs.push({ field: 'auth_type', message: 'One of: none, bearer, oauth' })
    else out.auth_type = input.auth_type
  }
  if (input.bearer_token !== undefined) {
    if (typeof input.bearer_token !== 'string' || !/^[\x21-\x7e]{8,4096}$/.test(input.bearer_token)) errs.push({ field: 'bearer_token', message: '8–4096 printable characters, no spaces' })
    else out.bearer_token = input.bearer_token
  }
  if (mode === 'create' && out.auth_type === 'bearer' && !out.bearer_token) errs.push({ field: 'bearer_token', message: 'Required for bearer authentication' })
  const t = intIn(input.timeout_ms, 1000, 30000, 'timeout_ms', errs)
  if (t !== undefined) out.timeout_ms = t
  const m = intIn(input.max_response_bytes, 1024, 4194304, 'max_response_bytes', errs)
  if (m !== undefined) out.max_response_bytes = m
  const r = intIn(input.calls_per_minute, 1, 120, 'calls_per_minute', errs)
  if (r !== undefined) out.calls_per_minute = r
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') errs.push({ field: 'enabled', message: 'Boolean' })
    else out.enabled = input.enabled ? 1 : 0
  }
  if (input.oauth_mode !== undefined) {
    if (input.oauth_mode !== 'auto' && input.oauth_mode !== 'preregistered') errs.push({ field: 'oauth_mode', message: 'auto or preregistered' })
    else out.oauth_mode = input.oauth_mode
  }
  if (input.oauth_client_id !== undefined) {
    if (input.oauth_client_id === null || input.oauth_client_id === '') out.oauth_client_id = null
    else if (typeof input.oauth_client_id !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(input.oauth_client_id)) errs.push({ field: 'oauth_client_id', message: '1–512 printable characters' })
    else out.oauth_client_id = input.oauth_client_id
  }
  if (input.oauth_client_secret !== undefined && input.oauth_client_secret !== '') {
    if (typeof input.oauth_client_secret !== 'string' || !/^[\x21-\x7e]{1,2048}$/.test(input.oauth_client_secret)) errs.push({ field: 'oauth_client_secret', message: '1–2048 printable characters' })
    else out.oauth_client_secret = input.oauth_client_secret
  }
  if (input.oauth_token_auth_method !== undefined && input.oauth_token_auth_method !== null && input.oauth_token_auth_method !== '') {
    if (!['none', 'client_secret_basic', 'client_secret_post'].includes(String(input.oauth_token_auth_method))) errs.push({ field: 'oauth_token_auth_method', message: 'none, client_secret_basic or client_secret_post' })
    else out.oauth_token_auth_method = input.oauth_token_auth_method
  } else if (input.oauth_token_auth_method === null || input.oauth_token_auth_method === '') out.oauth_token_auth_method = null
  if (input.oauth_scopes !== undefined) {
    if (input.oauth_scopes === null || input.oauth_scopes === '') out.oauth_scopes = null
    else if (typeof input.oauth_scopes !== 'string' || !/^[\x21\x23-\x5b\x5d-\x7e ]{1,500}$/.test(input.oauth_scopes)) errs.push({ field: 'oauth_scopes', message: 'Space-separated scope tokens, max 500 characters' })
    else out.oauth_scopes = input.oauth_scopes.trim().replace(/\s+/g, ' ')
  }
  if (input.clear_oauth_client_secret !== undefined) {
    if (typeof input.clear_oauth_client_secret !== 'boolean') errs.push({ field: 'clear_oauth_client_secret', message: 'Boolean' })
    else if (input.clear_oauth_client_secret) out.clear_oauth_client_secret = true
  }
  const finalAuth = out.auth_type
  if (mode === 'create' && finalAuth === 'oauth' && out.oauth_mode === 'preregistered' && !out.oauth_client_id) errs.push({ field: 'oauth_client_id', message: 'Required for a pre-registered OAuth app' })
  if (out.oauth_token_auth_method && out.oauth_token_auth_method !== 'none' && mode === 'create' && !out.oauth_client_secret) errs.push({ field: 'oauth_client_secret', message: 'Required for client_secret_basic / client_secret_post' })
  if (mode === 'update' && !Object.keys(out).length && !errs.length) errs.push({ field: '_', message: 'No fields to update' })
  if (errs.length) throw new ServiceError(400, 'Validation failed', errs)
  return out
}

// ---------------- CRUD ----------------
export async function listConnections(db: D1Database) {
  const r = await db.prepare(`SELECT * FROM mcp_connections WHERE owner = 'owner' ORDER BY id DESC`).all<ConnectionRow>()
  const counts = await db
    .prepare(`SELECT connection_id, COUNT(*) AS total, SUM(permission = 'allowed' AND present = 1) AS allowed FROM mcp_connection_tools WHERE present = 1 GROUP BY connection_id`)
    .all<{ connection_id: number; total: number; allowed: number }>()
  const map = new Map(counts.results.map((c) => [c.connection_id, c]))
  return r.results.map((c) => ({ ...publicConnection(c), tools_total: map.get(c.id)?.total ?? 0, tools_allowed: map.get(c.id)?.allowed ?? 0, readiness: readiness(c, map.get(c.id)?.allowed ?? 0) }))
}

export function readiness(c: Pick<ConnectionRow, 'enabled' | 'status' | 'auth_type' | 'auth_ciphertext' | 'tools_refreshed_at'> & Partial<Pick<ConnectionRow, 'oauth_mode' | 'oauth_client_id'>>, allowed: number): string {
  if (!c.enabled) return 'disabled'
  if (c.auth_type === 'oauth' && c.oauth_mode === 'preregistered' && !c.oauth_client_id) return 'not_configured'
  if (c.auth_type !== 'none' && !c.auth_ciphertext) return c.auth_type === 'oauth' ? 'auth_required' : 'not_configured'
  if (c.status === 'untested') return 'untested'
  if (c.status === 'failed') return 'connection_failed'
  if (c.status === 'auth_failed' || c.status === 'auth_required') return c.status
  if (!c.tools_refreshed_at) return 'connected_unverified'
  if (c.status === 'connected') return allowed > 0 ? 'tools_discovered_unverified' : 'tools_discovered'
  return allowed > 0 ? 'ready' : 'verified_no_tools_allowed'
}

export async function getConnection(db: D1Database, id: number): Promise<ConnectionRow> {
  const c = await db.prepare(`SELECT * FROM mcp_connections WHERE id = ? AND owner = 'owner'`).bind(id).first<ConnectionRow>()
  if (!c) throw new ServiceError(404, 'Connection not found')
  return c
}

function hint(secret: string) {
  return '…' + secret.slice(-4)
}

export async function createConnection(env: ConnectorEnv, input: ConnectionInput, deps: ConnectorDeps = {}) {
  const v = validateConnectionInput(input, 'create', env, deps)
  if (v.auth_type !== 'none' && !env.CONNECTOR_ENC_KEY) throw new ServiceError(503, 'CONNECTOR_ENC_KEY is not configured; credentials cannot be stored safely')
  const isOAuth = v.auth_type === 'oauth'
  const row = await env.DB.prepare(
    `INSERT INTO mcp_connections (name, endpoint_url, auth_type, timeout_ms, max_response_bytes, calls_per_minute, enabled, oauth_mode, oauth_client_id, oauth_token_auth_method, oauth_scopes)
     VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING *`,
  )
    .bind(
      v.name, v.endpoint_url, v.auth_type, v.timeout_ms ?? 15000, v.max_response_bytes ?? 1048576, v.calls_per_minute ?? 30, v.enabled ?? 1,
      isOAuth ? (v.oauth_mode ?? 'auto') : 'auto',
      isOAuth && v.oauth_mode === 'preregistered' ? (v.oauth_client_id ?? null) : null,
      isOAuth && v.oauth_mode === 'preregistered' ? (v.oauth_token_auth_method ?? null) : null,
      isOAuth ? (v.oauth_scopes ?? null) : null,
    )
    .first<ConnectionRow>()
  if (!row) throw new ServiceError(502, 'Insert failed')
  if (v.auth_type === 'bearer' && typeof v.bearer_token === 'string') {
    const ct = await sealJson(env.CONNECTOR_ENC_KEY, AUTH_PURPOSE(row.id), { type: 'bearer', token: v.bearer_token })
    await env.DB.prepare('UPDATE mcp_connections SET auth_ciphertext = ?, auth_hint = ? WHERE id = ?').bind(ct, hint(v.bearer_token), row.id).run()
  }
  if (isOAuth && v.oauth_mode === 'preregistered' && typeof v.oauth_client_secret === 'string') {
    await writeClientBlob(env, row.id, { client_secret: v.oauth_client_secret })
  }
  await audit(env.DB, 'connector_create', row.id, { name: v.name, host: new URL(String(v.endpoint_url)).host, auth_type: v.auth_type, oauth_mode: isOAuth ? (v.oauth_mode ?? 'auto') : undefined })
  return publicConnection(await getConnection(env.DB, row.id))
}

export async function updateConnection(env: ConnectorEnv, id: number, input: ConnectionInput, deps: ConnectorDeps = {}) {
  const existing = await getConnection(env.DB, id)
  const v = validateConnectionInput(input, 'update', env, deps)
  const sets: string[] = []
  const binds: unknown[] = []
  const endpointChanged = typeof v.endpoint_url === 'string' && v.endpoint_url !== existing.endpoint_url
  const authChanged = v.auth_type !== undefined && v.auth_type !== existing.auth_type
  const oauthClientChanged = (v.oauth_mode !== undefined && v.oauth_mode !== existing.oauth_mode) || (v.oauth_client_id !== undefined && v.oauth_client_id !== existing.oauth_client_id) || v.oauth_client_secret !== undefined || v.clear_oauth_client_secret === true
  if (oauthClientChanged) {
    // a different OAuth client must re-authorize; old tokens were issued to the old client
    sets.push('auth_ciphertext = NULL', 'auth_hint = NULL', `status = 'untested'`, 'oauth_authorized_at = NULL', 'oauth_token_expires_at = NULL')
  }
  {
    // Compute the final encrypted client blob from the existing one in a single step
    const blob = await readClientBlob(env, existing)
    let changed = false
    if ((v.oauth_mode !== undefined && v.oauth_mode !== existing.oauth_mode) || (v.endpoint_url && v.endpoint_url !== existing.endpoint_url)) {
      if (blob.dcr) {
        delete blob.dcr // cached DCR registration belongs to the old strategy / destination
        changed = true
      }
    }
    if (v.oauth_client_secret !== undefined) {
      if (!env.CONNECTOR_ENC_KEY) throw new ServiceError(503, 'CONNECTOR_ENC_KEY is not configured')
      blob.client_secret = String(v.oauth_client_secret)
      changed = true
    } else if (v.clear_oauth_client_secret === true && blob.client_secret) {
      delete blob.client_secret
      changed = true
    }
    if (changed) await writeClientBlob(env, id, blob)
  }
  for (const k of ['name', 'endpoint_url', 'auth_type', 'timeout_ms', 'max_response_bytes', 'calls_per_minute', 'enabled', 'oauth_mode', 'oauth_client_id', 'oauth_token_auth_method', 'oauth_scopes'] as const) {
    if (v[k] !== undefined) {
      sets.push(`${k} = ?`)
      binds.push(v[k])
    }
  }
  if (endpointChanged || authChanged) {
    // a new destination or auth method must be re-verified, and must never receive the old credential
    sets.push(`status = 'untested'`, `last_verified_at = NULL`, `extra_allowed_hosts = NULL`, 'oauth_diagnostics = NULL', 'oauth_strategy = NULL', 'oauth_authorized_at = NULL', 'oauth_token_expires_at = NULL')
    if (!v.bearer_token) sets.push('auth_ciphertext = NULL', 'auth_hint = NULL')
    await env.DB.prepare(`UPDATE mcp_connection_tools SET permission = 'denied' WHERE connection_id = ?`).bind(id).run()
  }
  if (typeof v.bearer_token === 'string') {
    const authType = (v.auth_type ?? existing.auth_type) as AuthType
    if (authType !== 'bearer') throw new ServiceError(400, 'bearer_token is only valid with auth_type "bearer"')
    if (!env.CONNECTOR_ENC_KEY) throw new ServiceError(503, 'CONNECTOR_ENC_KEY is not configured')
    sets.push('auth_ciphertext = ?', 'auth_hint = ?', `status = 'untested'`)
    binds.push(await sealJson(env.CONNECTOR_ENC_KEY, AUTH_PURPOSE(id), { type: 'bearer', token: v.bearer_token }), hint(v.bearer_token))
  }
  sets.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`)
  await env.DB.prepare(`UPDATE mcp_connections SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, id).run()
  await audit(env.DB, 'connector_update', id, { fields: Object.keys(v).filter((k) => k !== 'bearer_token' && k !== 'oauth_client_secret'), credential_rotated: !!v.bearer_token, client_secret_changed: v.oauth_client_secret !== undefined || v.clear_oauth_client_secret === true, reset_permissions: endpointChanged || authChanged })
  return publicConnection(await getConnection(env.DB, id))
}

export async function revokeCredential(env: ConnectorEnv, id: number) {
  await getConnection(env.DB, id)
  await env.DB.prepare(`UPDATE mcp_connections SET auth_ciphertext = NULL, auth_hint = NULL, status = 'untested', last_verified_at = NULL, oauth_authorized_at = NULL, oauth_token_expires_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`).bind(id).run()
  await audit(env.DB, 'connector_revoke_credential', id, {})
  return publicConnection(await getConnection(env.DB, id))
}

export async function deleteConnection(env: ConnectorEnv, id: number) {
  const c = await getConnection(env.DB, id)
  await env.DB.batch([
    env.DB.prepare('DELETE FROM mcp_connection_tools WHERE connection_id = ?').bind(id),
    env.DB.prepare('DELETE FROM mcp_oauth_states WHERE connection_id = ?').bind(id),
    env.DB.prepare('DELETE FROM connector_rate WHERE connection_id = ?').bind(id),
    env.DB.prepare('DELETE FROM mcp_connections WHERE id = ?').bind(id),
  ])
  await audit(env.DB, 'connector_delete', id, { name: c.name })
}

// ---------------- credentials ----------------
async function authHeaders(env: ConnectorEnv, c: ConnectionRow, deps: ConnectorDeps): Promise<Record<string, string>> {
  if (c.auth_type === 'none') return {}
  if (!c.auth_ciphertext) throw new ConnectorError(c.auth_type === 'oauth' ? 'auth_required' : 'auth_failed', c.auth_type === 'oauth' ? 'OAuth authorization required' : 'No credential configured')
  let cred: { type: string; token?: string } & Partial<OAuthCredential>
  try {
    cred = await openJson(env.CONNECTOR_ENC_KEY, AUTH_PURPOSE(c.id), c.auth_ciphertext)
  } catch (e) {
    if (e instanceof CryptoUnavailable) throw new ConnectorError('auth_failed', e.message)
    throw new ConnectorError('auth_failed', 'Stored credential cannot be decrypted; re-enter it')
  }
  if (cred.type === 'bearer' && cred.token) return { Authorization: `Bearer ${cred.token}` }
  if (cred.type === 'oauth' && cred.access_token) {
    let oc = cred as OAuthCredential & { type: string }
    if (oc.expires_at && oc.expires_at - 60 < Date.now() / 1000) {
      try {
        const prevRefresh = oc.refresh_token
        oc = { ...(await refreshOAuth(oc, policyFor(c, env, deps), deps.fetchImpl)), type: 'oauth' }
        const ct = await sealJson(env.CONNECTOR_ENC_KEY, AUTH_PURPOSE(c.id), oc)
        c.auth_ciphertext = ct // keep the in-memory row current for any later read in this operation
        await env.DB.prepare(`UPDATE mcp_connections SET auth_ciphertext = ?, oauth_token_expires_at = ?, oauth_last_refresh_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`)
          .bind(ct, oc.expires_at ? new Date(oc.expires_at * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') : null, c.id)
          .run()
        await audit(env.DB, 'connector_oauth_refresh', c.id, { rotated: !!oc.refresh_token && oc.refresh_token !== prevRefresh })
      } catch {
        await env.DB.prepare(`UPDATE mcp_connections SET status = 'auth_required', last_error = 'refresh: token refresh failed; re-authorize' WHERE id = ?`).bind(c.id).run()
        await audit(env.DB, 'connector_oauth_refresh_failed', c.id, {})
        throw new ConnectorError('auth_required', 'OAuth token expired and could not be refreshed; re-authorize')
      }
    }
    return { Authorization: `Bearer ${oc.access_token}` }
  }
  throw new ConnectorError('auth_failed', 'Unsupported stored credential')
}

export async function secretsOf(env: ConnectorEnv, c: ConnectionRow): Promise<string[]> {
  if (!env.CONNECTOR_ENC_KEY) return []
  const out: string[] = []
  if (c.auth_ciphertext) {
    try {
      const cred = await openJson<Record<string, unknown>>(env.CONNECTOR_ENC_KEY, AUTH_PURPOSE(c.id), c.auth_ciphertext)
      for (const k of ['token', 'access_token', 'refresh_token']) if (typeof cred[k] === 'string') out.push(cred[k] as string)
      const ci = cred.client_information as Record<string, unknown> | undefined
      if (ci && typeof ci.client_secret === 'string') out.push(ci.client_secret)
    } catch {
      /* ignore */
    }
  }
  const blob = await readClientBlob(env, c)
  if (blob.client_secret) out.push(blob.client_secret)
  return out
}

function guard(env: ConnectorEnv, c: ConnectionRow, deps: ConnectorDeps) {
  // One credential resolution per operation: a refresh (with rotation) must happen at most once,
  // and every request in the same MCP session must reuse the refreshed token.
  let cached: Promise<Record<string, string>> | null = null
  return {
    policy: policyFor(c, env, deps),
    deadlineMs: c.timeout_ms,
    maxBytes: c.max_response_bytes,
    inject: () => (cached ??= authHeaders(env, c, deps).catch((e) => {
      cached = null
      throw e
    })),
    injectHost: endpointHostKey(c, env),
    fetchImpl: deps.fetchImpl,
  }
}

function statusFromError(e: ConnectorError): ConnStatus {
  if (e.kind === 'auth_required') return 'auth_required'
  if (e.kind === 'auth_failed') return 'auth_failed'
  return 'failed'
}

// ---------------- test / discover ----------------
async function storeTools(db: D1Database, id: number, tools: RemoteTool[]) {
  const existing = await db.prepare('SELECT name, schema_hash, risk, permission FROM mcp_connection_tools WHERE connection_id = ?').bind(id).all<{ name: string; schema_hash: string; risk: Risk; permission: string }>()
  const prev = new Map(existing.results.map((r) => [r.name, r]))
  const stmts: D1PreparedStatement[] = [db.prepare('UPDATE mcp_connection_tools SET present = 0 WHERE connection_id = ?').bind(id)]
  const changes = { added: [] as string[], changed: [] as string[], removed: [] as string[] }
  for (const t of tools) {
    const schema = JSON.stringify(t.inputSchema).slice(0, 32000)
    const ann = t.annotations ? JSON.stringify(t.annotations).slice(0, 4000) : null
    const hash = await sha256(schema + '|' + (ann ?? '') + '|' + (t.description ?? ''))
    const risk = riskOf(t)
    const p = prev.get(t.name)
    if (!p) changes.added.push(t.name)
    // Any change to schema/annotations/description revokes approval (re-review required)
    const changed = !!p && p.schema_hash !== hash
    if (changed) changes.changed.push(t.name)
    stmts.push(
      db
        .prepare(
          `INSERT INTO mcp_connection_tools (connection_id, name, title, description, input_schema, annotations, schema_hash, risk, permission, present, discovered_at)
           VALUES (?,?,?,?,?,?,?,?, 'denied', 1, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
           ON CONFLICT(connection_id, name) DO UPDATE SET title = excluded.title, description = excluded.description,
             input_schema = excluded.input_schema, annotations = excluded.annotations, risk = excluded.risk, present = 1,
             permission = CASE WHEN mcp_connection_tools.schema_hash != excluded.schema_hash THEN 'denied' ELSE mcp_connection_tools.permission END,
             changed_at = CASE WHEN mcp_connection_tools.schema_hash != excluded.schema_hash THEN strftime('%Y-%m-%dT%H:%M:%SZ','now') ELSE mcp_connection_tools.changed_at END,
             schema_hash = excluded.schema_hash`,
        )
        .bind(id, t.name, t.title, t.description, schema, ann, hash, risk),
    )
  }
  for (const name of prev.keys()) if (!tools.find((t) => t.name === name)) changes.removed.push(name)
  await db.batch(stmts)
  return changes
}

/** Initialize + tools/list. Updates status. Never implies invocation works. */
export async function testConnection(env: ConnectorEnv, id: number, deps: ConnectorDeps = {}) {
  const c = await getConnection(env.DB, id)
  if (!c.enabled) throw new ServiceError(409, 'Connection is disabled')
  const secrets = await secretsOf(env, c)
  const started = Date.now()
  try {
    const { info, tools } = await withSession(new URL(c.endpoint_url), guard(env, c, deps), async (client, info) => ({ info, tools: info.hasTools ? await listAllTools(client) : [] }))
    const changes = await storeTools(env.DB, id, tools)
    await env.DB.prepare(
      `UPDATE mcp_connections SET status = CASE WHEN status = 'verified' THEN 'verified' ELSE 'connected' END, server_name = ?, server_version = ?, protocol_version = ?,
       last_check_at = ?, tools_refreshed_at = ?, last_error = NULL WHERE id = ?`,
    )
      .bind(info.serverName?.slice(0, 120) ?? null, info.serverVersion?.slice(0, 60) ?? null, info.protocolVersion, NOW(), NOW(), id)
      .run()
    await audit(env.DB, 'connector_test', id, { ok: true, tools: tools.length, ...changes })
    return { ok: true, latency_ms: Date.now() - started, server: info, tools_discovered: tools.length, changes, connection: publicConnection(await getConnection(env.DB, id)) }
  } catch (e) {
    const ce = classify(e)
    const safe = redact(ce.message, secrets)
    await env.DB.prepare('UPDATE mcp_connections SET status = ?, last_check_at = ?, last_error = ? WHERE id = ?').bind(statusFromError(ce), NOW(), `${ce.kind}: ${safe}`, id).run()
    await audit(env.DB, 'connector_test', id, { ok: false, kind: ce.kind })
    return { ok: false, latency_ms: Date.now() - started, error: { kind: ce.kind, message: safe, oauth_hint: ce.kind === 'auth_required' && !!ce.wwwAuthenticate }, connection: publicConnection(await getConnection(env.DB, id)) }
  }
}

export interface ToolView {
  name: string
  title: string | null
  description: string | null
  input_schema: Record<string, unknown>
  annotations: Record<string, unknown> | null
  risk: Risk
  permission: 'allowed' | 'denied'
  present: boolean
  changed_at: string | null
  discovered_at: string
  last_success_at: string | null
  last_error_at: string | null
}

export async function listTools(db: D1Database, id: number, onlyAllowed = false): Promise<ToolView[]> {
  await getConnection(db, id)
  const r = await db
    .prepare(`SELECT name, title, description, input_schema, annotations, risk, permission, present, changed_at, discovered_at, last_success_at, last_error_at FROM mcp_connection_tools WHERE connection_id = ? ${onlyAllowed ? "AND permission = 'allowed' AND present = 1" : ''} ORDER BY present DESC, name`)
    .bind(id)
    .all<Record<string, unknown>>()
  return r.results.map((t) => ({ ...t, present: !!t.present, input_schema: JSON.parse(String(t.input_schema)), annotations: t.annotations ? JSON.parse(String(t.annotations)) : null }) as unknown as ToolView)
}

export async function setToolPermission(env: ConnectorEnv, id: number, tool: string, permission: unknown, confirmRisk: unknown) {
  if (permission !== 'allowed' && permission !== 'denied') throw new ServiceError(400, 'permission must be "allowed" or "denied"')
  await getConnection(env.DB, id)
  const t = await env.DB.prepare('SELECT risk, present FROM mcp_connection_tools WHERE connection_id = ? AND name = ?').bind(id, tool).first<{ risk: Risk; present: number }>()
  if (!t) throw new ServiceError(404, 'Tool not found; refresh discovery first')
  if (permission === 'allowed') {
    if (!t.present) throw new ServiceError(409, 'Tool is no longer offered by the remote server')
    if (t.risk !== 'read' && confirmRisk !== t.risk) throw new ServiceError(400, `This tool is classified "${t.risk}". Re-send with confirm_risk: "${t.risk}" to approve it explicitly.`)
  }
  await env.DB.prepare('UPDATE mcp_connection_tools SET permission = ? WHERE connection_id = ? AND name = ?').bind(permission, id, tool).run()
  await audit(env.DB, 'connector_tool_permission', id, { tool, permission, risk: t.risk })
  return { tool, permission, risk: t.risk }
}

// ---------------- invoke ----------------
async function consumeRate(db: D1Database, id: number, limit: number) {
  const w = Math.floor(Date.now() / 60000)
  const r = await db
    .prepare('INSERT INTO connector_rate (connection_id, window_start, count) VALUES (?,?,1) ON CONFLICT(connection_id, window_start) DO UPDATE SET count = count + 1 RETURNING count')
    .bind(id, w)
    .first<{ count: number }>()
  if ((r?.count ?? 0) === 1) await db.prepare('DELETE FROM connector_rate WHERE window_start < ?').bind(w - 5).run()
  return (r?.count ?? 0) <= limit
}

function normalizeContent(content: unknown[]) {
  return content.slice(0, 50).map((c) => {
    const item = c as Record<string, unknown>
    switch (item?.type) {
      case 'text':
        return { type: 'text', text: String(item.text ?? '').slice(0, 100_000) }
      case 'image':
      case 'audio':
        return { type: item.type, mimeType: String(item.mimeType ?? ''), omitted: 'binary content not forwarded', bytes: typeof item.data === 'string' ? Math.floor((item.data.length * 3) / 4) : null }
      case 'resource_link':
        return { type: 'resource_link', uri: String(item.uri ?? ''), name: item.name ?? null }
      case 'resource': {
        const r = (item.resource ?? {}) as Record<string, unknown>
        return { type: 'resource', uri: String(r.uri ?? ''), mimeType: r.mimeType ?? null, text: typeof r.text === 'string' ? r.text.slice(0, 100_000) : null }
      }
      default:
        return { type: 'unsupported', original_type: String(item?.type ?? 'unknown') }
    }
  })
}

export interface InvokeResult {
  ok: boolean
  status: string
  connection_id: number
  tool: string
  latency_ms: number | null
  is_error?: boolean
  content?: unknown[]
  structured_content?: Record<string, unknown> | null
  error?: { kind: string; message: string; details?: unknown }
  provenance: { source: 'external_mcp'; server_name: string | null; endpoint_host: string; observed_at: string; untrusted: true }
}

export async function invokeTool(env: ConnectorEnv, id: number, tool: string, args: unknown, caller: string, deps: ConnectorDeps = {}): Promise<InvokeResult> {
  const c = await getConnection(env.DB, id)
  const prov = { source: 'external_mcp' as const, server_name: c.server_name, endpoint_host: new URL(c.endpoint_url).host, observed_at: NOW(), untrusted: true as const }
  const base = { connection_id: id, tool, provenance: prov }
  const record = async (status: string, latency: number | null, extra: { arg_keys?: string; arg_bytes?: number; result_bytes?: number; preview?: string; error?: string } = {}) => {
    await env.DB.prepare(
      'INSERT INTO mcp_invocations (connection_id, connection_name, tool_name, caller, status, latency_ms, arg_keys, arg_bytes, result_bytes, result_preview, error) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    )
      .bind(id, c.name, tool.slice(0, 128), caller, status, latency, extra.arg_keys ?? null, extra.arg_bytes ?? null, extra.result_bytes ?? null, extra.preview ?? null, extra.error ?? null)
      .run()
  }
  const reject = async (status: string, kind: string, message: string, details?: unknown): Promise<InvokeResult> => {
    await record(status, null, { error: message })
    return { ...base, ok: false, status, latency_ms: null, error: { kind, message, details } }
  }

  if (!c.enabled) return reject('blocked', 'disabled', 'Connection is disabled')
  if (!['connected', 'verified'].includes(c.status) || !c.tools_refreshed_at) return reject('blocked', 'not_ready', 'Connection has not been tested successfully; run Test & discover first')
  const t = await env.DB.prepare('SELECT input_schema, risk, permission, present FROM mcp_connection_tools WHERE connection_id = ? AND name = ?').bind(id, tool).first<{ input_schema: string; risk: Risk; permission: string; present: number }>()
  if (!t || !t.present) return reject('blocked', 'unknown_tool', 'Tool is not in the discovered catalog')
  if (t.permission !== 'allowed') return reject('blocked', 'not_allowed', 'Tool has not been approved for this connection')
  if (args === undefined || args === null) args = {}
  if (typeof args !== 'object' || Array.isArray(args)) return reject('invalid_arguments', 'invalid_arguments', 'Arguments must be a JSON object')
  const argText = JSON.stringify(args)
  if (argText.length > MAX_ARG_BYTES) return reject('invalid_arguments', 'invalid_arguments', `Arguments exceed ${MAX_ARG_BYTES} bytes`)
  let schema: Record<string, unknown>
  try {
    schema = JSON.parse(t.input_schema)
  } catch {
    return reject('blocked', 'invalid_schema', 'Stored input schema is invalid; refresh discovery')
  }
  const v = new Validator(schema as never, '2020-12', false).validate(args)
  if (!v.valid) {
    const details = v.errors.slice(0, 10).map((e) => ({ path: e.instanceLocation, message: e.error }))
    await record('invalid_arguments', null, { arg_keys: Object.keys(args as object).join(',').slice(0, 300), arg_bytes: argText.length, error: 'Schema validation failed' })
    return { ...base, ok: false, status: 'invalid_arguments', latency_ms: null, error: { kind: 'invalid_arguments', message: 'Arguments do not match the tool input schema', details } }
  }
  if (!(await consumeRate(env.DB, id, c.calls_per_minute))) return reject('rate_limited', 'rate_limited', `Connection limit of ${c.calls_per_minute} calls/min reached`)

  const secrets = await secretsOf(env, c)
  const started = Date.now()
  try {
    const out = await withSession(new URL(c.endpoint_url), guard(env, c, deps), (client) => callRemoteTool(client, tool, args as Record<string, unknown>))
    const content = normalizeContent(out.content)
    const structured = out.structuredContent
    let resultText = JSON.stringify({ content, structured })
    // never echo our own credentials back, even if a hostile server reflects them
    for (const s of secrets) if (s.length >= 4) resultText = resultText.split(s).join('[REDACTED]')
    const safe = JSON.parse(resultText) as { content: unknown[]; structured: Record<string, unknown> | null }
    const latency = Date.now() - started
    const status = out.isError ? 'tool_error' : 'success'
    await record(status, latency, { arg_keys: Object.keys(args as object).join(',').slice(0, 300), arg_bytes: argText.length, result_bytes: resultText.length, preview: resultText.slice(0, PREVIEW_BYTES) })
    await env.DB.prepare(`UPDATE mcp_connection_tools SET ${out.isError ? 'last_error_at' : 'last_success_at'} = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE connection_id = ? AND name = ?`).bind(id, tool).run()
    if (!out.isError) await env.DB.prepare(`UPDATE mcp_connections SET status = 'verified', last_verified_at = ?, last_error = NULL WHERE id = ?`).bind(NOW(), id).run()
    return { ...base, ok: !out.isError, status, latency_ms: latency, is_error: out.isError, content: safe.content, structured_content: safe.structured }
  } catch (e) {
    const ce = classify(e)
    const msg = redact(ce.message, secrets)
    const status = ce.kind === 'timeout' ? 'timeout' : ce.kind === 'invalid_response' || ce.kind === 'too_large' ? 'invalid_response' : ce.kind === 'auth_failed' || ce.kind === 'auth_required' ? 'auth_failed' : ce.kind === 'rate_limited' ? 'rate_limited' : ce.kind === 'blocked' ? 'blocked' : 'failed'
    await record(status, Date.now() - started, { arg_keys: Object.keys(args as object).join(',').slice(0, 300), arg_bytes: argText.length, error: `${ce.kind}: ${msg}` })
    await env.DB.prepare(`UPDATE mcp_connection_tools SET last_error_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE connection_id = ? AND name = ?`).bind(id, tool).run()
    if (ce.kind === 'auth_failed' || ce.kind === 'auth_required') await env.DB.prepare('UPDATE mcp_connections SET status = ?, last_error = ? WHERE id = ?').bind(statusFromError(ce), `${ce.kind}: ${msg}`, id).run()
    return { ...base, ok: false, status, latency_ms: Date.now() - started, error: { kind: ce.kind, message: msg } }
  }
}

export async function listInvocations(db: D1Database, id: number | null, limit = 50) {
  const r = id
    ? await db.prepare('SELECT * FROM mcp_invocations WHERE connection_id = ? ORDER BY id DESC LIMIT ?').bind(id, limit).all()
    : await db.prepare('SELECT * FROM mcp_invocations ORDER BY id DESC LIMIT ?').bind(limit).all()
  return r.results
}

export async function connectionAudit(db: D1Database, id: number) {
  const r = await db.prepare(`SELECT id, action, metadata, created_at FROM audit_events WHERE entity_type = 'mcp_connections' AND entity_id = ? ORDER BY id DESC LIMIT 50`).bind(id).all()
  return r.results
}

// ---------------- OAuth persistence helpers ----------------
export async function saveOAuthCredential(env: ConnectorEnv, id: number, cred: OAuthCredential, hosts: string[]) {
  const ct = await sealJson(env.CONNECTOR_ENC_KEY, AUTH_PURPOSE(id), { ...cred, type: 'oauth' })
  await env.DB.prepare(
    `UPDATE mcp_connections SET auth_ciphertext = ?, auth_hint = ?, extra_allowed_hosts = ?, status = 'untested', last_error = NULL, oauth_strategy = ?,
       oauth_authorized_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), oauth_token_expires_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`,
  )
    .bind(ct, `OAuth (${cred.strategy ?? 'unknown'})`, hosts.join(' '), cred.strategy ?? null, cred.expires_at ? new Date(cred.expires_at * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') : null, id)
    .run()
  await audit(env.DB, 'connector_oauth_authorized', id, { hosts, strategy: cred.strategy, has_refresh_token: !!cred.refresh_token })
}

// ---------------- OAuth client configuration (encrypted) ----------------
export interface ClientBlob {
  client_secret?: string
  dcr?: { client_information: Record<string, unknown>; redirect_uri: string; issuer: string }
}
export async function readClientBlob(env: ConnectorEnv, c: Pick<ConnectionRow, 'id' | 'oauth_client_ciphertext'>): Promise<ClientBlob> {
  if (!c.oauth_client_ciphertext) return {}
  try {
    return await openJson<ClientBlob>(env.CONNECTOR_ENC_KEY, CLIENT_PURPOSE(c.id), c.oauth_client_ciphertext)
  } catch {
    return {}
  }
}
export async function writeClientBlob(env: ConnectorEnv, id: number, blob: ClientBlob) {
  const empty = !blob.client_secret && !blob.dcr
  const ct = empty ? null : await sealJson(env.CONNECTOR_ENC_KEY, CLIENT_PURPOSE(id), blob)
  await env.DB.prepare('UPDATE mcp_connections SET oauth_client_ciphertext = ? WHERE id = ?').bind(ct, id).run()
}
export async function preregisteredClient(env: ConnectorEnv, c: ConnectionRow): Promise<PreregisteredClient | null> {
  if (c.oauth_mode !== 'preregistered' || !c.oauth_client_id) return null
  const blob = await readClientBlob(env, c)
  return { client_id: c.oauth_client_id, client_secret: blob.client_secret, token_endpoint_auth_method: c.oauth_token_auth_method ?? undefined }
}
export async function saveDiagnostics(env: ConnectorEnv, id: number, diag: unknown) {
  await env.DB.prepare('UPDATE mcp_connections SET oauth_diagnostics = ? WHERE id = ?').bind(JSON.stringify(diag).slice(0, 8000), id).run()
}

export { policyFor }
