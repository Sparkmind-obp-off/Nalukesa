/**
 * Owner-only session auth for the private pilot.
 *
 * - Password is a Cloudflare secret (OWNER_PASSWORD), never in code/bundle.
 * - Session = HMAC-SHA256 signed token (SESSION_SECRET) in an HttpOnly,
 *   Secure, SameSite=Strict cookie. 12h expiry.
 * - Constant-time comparisons. Login throttled via D1 (hashed client key).
 *
 * Recommended upgrade: put Cloudflare Access in front of the whole site.
 */
const enc = new TextEncoder()
export const SESSION_COOKIE = 'nk_session'
export const SESSION_TTL_S = 60 * 60 * 12

function b64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(data)))
}

export async function sha256(data: string): Promise<string> {
  return b64url(await crypto.subtle.digest('SHA-256', enc.encode(data)))
}

export function timingSafeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a)
  const bb = enc.encode(b)
  let diff = ab.length ^ bb.length
  const len = Math.max(ab.length, bb.length)
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0)
  return diff === 0
}

/** Compare hashes so length of the real password is not leaked. */
export async function passwordMatches(given: string, expected: string): Promise<boolean> {
  const [g, e] = await Promise.all([sha256('pw:' + given), sha256('pw:' + expected)])
  return timingSafeEqual(g, e)
}

export async function createSession(secret: string, nowS = Math.floor(Date.now() / 1000)): Promise<string> {
  const payload = `owner.${nowS + SESSION_TTL_S}.${b64url(crypto.getRandomValues(new Uint8Array(12)))}`
  return `${payload}.${await hmac(secret, payload)}`
}

export async function verifySession(secret: string, token: string | undefined, nowS = Math.floor(Date.now() / 1000)): Promise<boolean> {
  if (!token) return false
  const parts = token.split('.')
  if (parts.length !== 4 || parts[0] !== 'owner') return false
  const exp = Number(parts[1])
  if (!Number.isFinite(exp) || exp < nowS) return false
  const payload = parts.slice(0, 3).join('.')
  return timingSafeEqual(await hmac(secret, payload), parts[3])
}
