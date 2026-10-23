/**
 * AES-256-GCM envelope for connector credentials stored in D1.
 * Key: base64-encoded 32 bytes in the Cloudflare secret CONNECTOR_ENC_KEY.
 * Format: "v1.<iv b64url>.<ciphertext b64url>". AAD binds ciphertext to its purpose.
 */
const enc = new TextEncoder()
const dec = new TextDecoder()

function b64u(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function fromB64(s: string): Uint8Array<ArrayBuffer> {
  const n = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(n + '='.repeat((4 - (n.length % 4)) % 4))
  const out = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export class CryptoUnavailable extends Error {}

async function key(raw: string | undefined): Promise<CryptoKey> {
  if (!raw) throw new CryptoUnavailable('CONNECTOR_ENC_KEY is not configured')
  let bytes: Uint8Array<ArrayBuffer>
  try {
    bytes = fromB64(raw.trim())
  } catch {
    throw new CryptoUnavailable('CONNECTOR_ENC_KEY is not valid base64')
  }
  if (bytes.length !== 32) throw new CryptoUnavailable('CONNECTOR_ENC_KEY must decode to 32 bytes')
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

export async function sealJson(rawKey: string | undefined, purpose: string, value: unknown): Promise<string> {
  const k = await key(rawKey)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(purpose) }, k, enc.encode(JSON.stringify(value)))
  return `v1.${b64u(iv)}.${b64u(new Uint8Array(ct))}`
}

export async function openJson<T>(rawKey: string | undefined, purpose: string, sealed: string): Promise<T> {
  const k = await key(rawKey)
  const [v, iv, ct] = sealed.split('.')
  if (v !== 'v1' || !iv || !ct) throw new Error('Unsupported ciphertext format')
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv), additionalData: enc.encode(purpose) }, k, fromB64(ct))
  return JSON.parse(dec.decode(pt)) as T
}
