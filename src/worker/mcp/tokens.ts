/**
 * Inbound MCP bearer tokens.
 *  - Separate from the owner browser session and owner password.
 *  - Generated server-side, shown to the owner exactly once, stored only as SHA-256 hash.
 *  - Scoped (least privilege), expiring, revocable, rate-limited.
 */
import { sha256, timingSafeEqual } from '../auth'

export const MCP_SCOPES = ['products:read', 'evidence:read', 'performance:read', 'providers:read'] as const
export type McpScope = (typeof MCP_SCOPES)[number]
export const TOKEN_PREFIX = 'nkmcp_'
export const RATE_LIMIT_PER_MIN = 60

export interface TokenRecord {
  id: number
  name: string
  scopes: McpScope[]
  expires_at: string | null
}

function b64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function generateToken(): string {
  return TOKEN_PREFIX + b64url(crypto.getRandomValues(new Uint8Array(32)))
}

export async function hashToken(token: string): Promise<string> {
  return sha256('mcp:' + token)
}

export function parseScopes(input: unknown): McpScope[] | null {
  if (!Array.isArray(input) || input.length === 0) return null
  const out = new Set<McpScope>()
  for (const s of input) {
    if (typeof s !== 'string' || !(MCP_SCOPES as readonly string[]).includes(s)) return null
    out.add(s as McpScope)
  }
  return [...out]
}

export async function createToken(db: D1Database, name: string, scopes: McpScope[], ttlDays: number) {
  const token = generateToken()
  const expires = new Date(Date.now() + ttlDays * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const row = await db
    .prepare('INSERT INTO mcp_tokens (name, token_hash, token_prefix, scopes, expires_at) VALUES (?,?,?,?,?) RETURNING id, name, token_prefix, scopes, created_at, expires_at')
    .bind(name, await hashToken(token), token.slice(0, TOKEN_PREFIX.length + 4), scopes.join(' '), expires)
    .first()
  return { token, record: row }
}

/** Extract a bearer token from an Authorization header; returns null if absent/malformed. */
export function bearer(header: string | undefined | null): string | null {
  if (!header) return null
  const m = /^Bearer\s+([A-Za-z0-9_\-.]{10,200})$/.exec(header.trim())
  return m ? m[1] : null
}

export async function verifyToken(db: D1Database, token: string, now = new Date()): Promise<TokenRecord | null> {
  if (!token.startsWith(TOKEN_PREFIX)) return null
  const h = await hashToken(token)
  const row = await db
    .prepare('SELECT id, name, token_hash, scopes, expires_at, revoked_at FROM mcp_tokens WHERE token_hash = ?')
    .bind(h)
    .first<{ id: number; name: string; token_hash: string; scopes: string; expires_at: string | null; revoked_at: string | null }>()
  if (!row || !timingSafeEqual(row.token_hash, h)) return null
  if (row.revoked_at) return null
  if (row.expires_at && new Date(row.expires_at).getTime() <= now.getTime()) return null
  return { id: row.id, name: row.name, scopes: row.scopes.split(' ').filter(Boolean) as McpScope[], expires_at: row.expires_at }
}

/** Fixed one-minute window. Returns false if over the limit. */
export async function consumeRate(db: D1Database, tokenId: number, limit = RATE_LIMIT_PER_MIN, nowMs = Date.now()): Promise<boolean> {
  const window = Math.floor(nowMs / 60000)
  const row = await db
    .prepare(
      `INSERT INTO mcp_rate (token_id, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT(token_id, window_start) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(tokenId, window)
    .first<{ count: number }>()
  // opportunistic cleanup of old windows
  if ((row?.count ?? 0) === 1) await db.prepare('DELETE FROM mcp_rate WHERE window_start < ?').bind(window - 5).run()
  return (row?.count ?? 0) <= limit
}

export async function touchToken(db: D1Database, id: number) {
  await db.prepare(`UPDATE mcp_tokens SET last_used_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`).bind(id).run()
}
