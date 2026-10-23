/**
 * Hardened outbound networking for the generic MCP connector.
 *
 *  - Endpoint validation: https, port 443, no userinfo, no IP literals,
 *    no internal hostnames, never NALUKESA's own hosts (recursion guard).
 *  - DNS validation via DNS-over-HTTPS: every A/AAAA answer must be a public
 *    unicast address (blocks private, loopback, link-local, CGNAT, metadata …).
 *    Re-checked on every request (narrows DNS-rebinding windows; see docs).
 *  - Per-connection host allowlist (registered endpoint host + OAuth hosts).
 *  - Redirects are never followed.
 *  - Deadline covers headers AND body consumption; byte cap enforced while
 *    streaming, so chunked responses without Content-Length are bounded too.
 */
export class NetBlocked extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NetBlocked'
  }
}
export class NetTimeout extends Error {
  constructor() {
    super('Timeout')
    this.name = 'NetTimeout'
  }
}
export class NetTooLarge extends Error {
  constructor() {
    super('Response exceeds size limit')
    this.name = 'NetTooLarge'
  }
}
export class NetHttpStatus extends Error {
  constructor(public code: number, public wwwAuthenticate: string | null) {
    super(`HTTP ${code}`)
    this.name = 'NetHttpStatus'
  }
}

export const SELF_HOSTS = ['nalukesa.biz.id', 'www.nalukesa.biz.id', 'nalukesa.pages.dev']
const INTERNAL_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home', '.corp', '.intranet', '.private', '.arpa']

export interface NetPolicy {
  /** exact hosts (lowercase) this connection may contact */
  allowedHosts: string[]
  /** extra hosts that must never be contacted (e.g. the current request host) */
  selfHosts?: string[]
  /** development-only: allow http://127.0.0.1:<port> and skip DNS checks for it */
  allowLocalHttp?: boolean
  /** override DNS resolver (tests) */
  resolver?: Resolver
}

export type Resolver = (host: string) => Promise<string[]>

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[') || host.includes(':') || /^0x[0-9a-f.]+$/i.test(host) || /^\d+$/.test(host)
}

/** Validate a URL as a registrable/contactable endpoint. Returns normalized URL. */
export function validateEndpoint(raw: string, policy: Pick<NetPolicy, 'allowLocalHttp' | 'selfHosts'> = {}): URL {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new NetBlocked('Invalid URL')
  }
  if (raw.length > 2000) throw new NetBlocked('URL too long')
  if (u.username || u.password) throw new NetBlocked('Credentials in URL are not allowed')
  if (u.hash) u.hash = ''
  const host = u.hostname.toLowerCase()
  if (policy.allowLocalHttp && u.protocol === 'http:' && host === '127.0.0.1') return u
  if (u.protocol !== 'https:') throw new NetBlocked('Only https endpoints are allowed')
  if (u.port && u.port !== '443') throw new NetBlocked('Only the default https port (443) is allowed')
  if (isIpLiteral(host)) throw new NetBlocked('IP address endpoints are not allowed; use a hostname')
  if (!host.includes('.') || host === 'localhost' || INTERNAL_SUFFIXES.some((s) => host.endsWith(s)) || host.startsWith('metadata')) {
    throw new NetBlocked('Internal hostnames are not allowed')
  }
  const self = [...SELF_HOSTS, ...(policy.selfHosts ?? [])].map((h) => h.toLowerCase())
  if (self.includes(host) || host.endsWith('.nalukesa.pages.dev')) throw new NetBlocked('Connecting NALUKESA to itself is not allowed')
  return u
}

// ---------- IP classification ----------
function v4ToInt(ip: string): number | null {
  const p = ip.split('.').map(Number)
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]
}
const V4_BLOCKS: [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]
export function isPublicIPv4(ip: string): boolean {
  const n = v4ToInt(ip)
  if (n === null) return false
  return !V4_BLOCKS.some(([base, bits]) => {
    const b = v4ToInt(base)!
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
    return ((n & mask) >>> 0) === ((b & mask) >>> 0)
  })
}
export function isPublicIPv6(ip: string): boolean {
  const s = ip.toLowerCase().replace(/^\[|\]$/g, '')
  if (s === '::' || s === '::1') return false
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s)
  if (mapped) return isPublicIPv4(mapped[1])
  const first = parseInt(s.split(':')[0] || '0', 16)
  if (Number.isNaN(first)) return false
  if ((first & 0xfe00) === 0xfc00) return false // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return false // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return false // multicast
  if (s.startsWith('64:ff9b:') || s.startsWith('2001:db8') || s.startsWith('100::')) return false
  if (s.startsWith('2002:')) return false // 6to4 can embed private v4
  return (first & 0xe000) === 0x2000 // only global unicast 2000::/3
}

/** DNS-over-HTTPS resolver (Cloudflare). Returns all A/AAAA answers. */
export const dohResolver: Resolver = async (host) => {
  const out: string[] = []
  for (const type of ['A', 'AAAA']) {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 4000)
    try {
      const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`, {
        headers: { accept: 'application/dns-json' },
        signal: ctrl.signal,
      })
      if (!r.ok) throw new NetBlocked('DNS lookup failed')
      const j = (await r.json()) as { Status: number; Answer?: { type: number; data: string }[] }
      for (const a of j.Answer ?? []) if (a.type === 1 || a.type === 28) out.push(a.data)
    } catch (e) {
      if (e instanceof NetBlocked) throw e
      throw new NetBlocked('DNS lookup failed')
    } finally {
      clearTimeout(t)
    }
  }
  return out
}

export async function assertPublicHost(host: string, resolver: Resolver = dohResolver): Promise<void> {
  const ips = await resolver(host)
  if (!ips.length) throw new NetBlocked('Host does not resolve')
  for (const ip of ips) {
    const pub = ip.includes(':') ? isPublicIPv6(ip) : isPublicIPv4(ip)
    if (!pub) throw new NetBlocked('Host resolves to a private or reserved address')
  }
}

// ---------- guarded fetch ----------
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface GuardOptions {
  policy: NetPolicy
  deadlineMs: number
  maxBytes: number
  /** headers injected server-side (credentials); never visible to the browser */
  inject?: () => Promise<Record<string, string>>
  fetchImpl?: FetchLike
  /** called for 401/403 so OAuth can react; default: throw NetHttpStatus */
  onStatus?: (res: Response) => void
}

function capStream(body: ReadableStream<Uint8Array>, maxBytes: number, deadline: number, ctrl: AbortController): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  let total = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        ctrl.abort()
        await reader.cancel().catch(() => {})
        controller.error(new NetTimeout())
        return
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const r = await Promise.race([
          reader.read(),
          new Promise<never>((_, rej) => {
            timer = setTimeout(() => rej(new NetTimeout()), remaining)
          }),
        ])
        if (r.done) return controller.close()
        total += r.value.byteLength
        if (total > maxBytes) {
          ctrl.abort()
          await reader.cancel().catch(() => {})
          controller.error(new NetTooLarge())
          return
        }
        controller.enqueue(r.value)
      } catch (e) {
        ctrl.abort()
        await reader.cancel().catch(() => {})
        controller.error(e instanceof NetTimeout ? e : e)
      } finally {
        if (timer) clearTimeout(timer)
      }
    },
    async cancel() {
      ctrl.abort()
      await reader.cancel().catch(() => {})
    },
  })
}

export function guardedFetch(o: GuardOptions): FetchLike {
  const f = o.fetchImpl ?? fetch
  const dnsOk = new Set<string>()
  return async (input, init) => {
    const raw = input instanceof Request ? input.url : String(input instanceof URL ? input.href : input)
    const u = validateEndpoint(raw, o.policy)
    const host = u.hostname.toLowerCase()
    const hostKey = u.port ? `${host}:${u.port}` : host
    const local = !!o.policy.allowLocalHttp && u.protocol === 'http:' && host === '127.0.0.1'
    if (!o.policy.allowedHosts.map((h) => h.toLowerCase()).includes(local ? hostKey : host)) throw new NetBlocked('Host is not on this connection’s allowlist')
    if (!local && !dnsOk.has(host)) {
      await assertPublicHost(host, o.policy.resolver)
      dnsOk.add(host)
    }
    const deadline = Date.now() + o.deadlineMs
    const ctrl = new AbortController()
    const outer = init?.signal
    if (outer) outer.addEventListener('abort', () => ctrl.abort(), { once: true })
    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    new Headers(init?.headers).forEach((v, k) => headers.set(k, v))
    if (o.inject) for (const [k, v] of Object.entries(await o.inject())) headers.set(k, v)
    headers.set('X-NK-Hop', '1')
    let timer: ReturnType<typeof setTimeout> | undefined
    let res: Response
    try {
      res = await Promise.race([
        f(u.toString(), { ...init, headers, redirect: 'manual', signal: ctrl.signal }),
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => {
            ctrl.abort()
            rej(new NetTimeout())
          }, o.deadlineMs)
        }),
      ])
    } catch (e) {
      if (e instanceof NetTimeout) throw e
      if ((e as Error)?.name === 'AbortError') throw new NetTimeout()
      throw e
    } finally {
      if (timer) clearTimeout(timer)
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {})
      throw new NetBlocked('Redirects are not followed')
    }
    if (res.status === 401 || res.status === 403 || res.status === 429) {
      const www = res.headers.get('www-authenticate')
      await res.body?.cancel().catch(() => {})
      throw new NetHttpStatus(res.status, www)
    }
    const declared = Number(res.headers.get('content-length') ?? '0')
    if (declared > o.maxBytes) {
      await res.body?.cancel().catch(() => {})
      throw new NetTooLarge()
    }
    if (!res.body) return res
    return new Response(capStream(res.body, o.maxBytes, deadline, ctrl), { status: res.status, statusText: res.statusText, headers: res.headers })
  }
}
