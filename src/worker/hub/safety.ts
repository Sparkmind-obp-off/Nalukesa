/**
 * Outbound destination safety (SSRF defence).
 * Only https URLs whose exact host is on the provider's allowlist are permitted.
 * Literal IPs, localhost, private/link-local/metadata ranges and non-default
 * ports are rejected. Redirects are never followed automatically.
 */

export class DestinationBlocked extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'DestinationBlocked'
  }
}

const BLOCKED_HOSTS = new Set(['localhost', 'metadata.google.internal', 'metadata'])
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home', '.corp']

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[') || host.includes(':') || /^0x[0-9a-f]+$/i.test(host) || /^\d+$/.test(host)
}

export interface DestinationPolicy {
  allowedHosts: string[]
  /** Only for local tests: allows http://127.0.0.1:<port> mock servers. Never enabled in production. */
  allowInsecureLocalForTests?: boolean
}

export function assertSafeDestination(raw: string, policy: DestinationPolicy): URL {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new DestinationBlocked('Invalid URL')
  }
  if (u.username || u.password) throw new DestinationBlocked('Credentials in URL are not allowed')
  const host = u.hostname.toLowerCase()

  if (policy.allowInsecureLocalForTests && u.protocol === 'http:' && host === '127.0.0.1') {
    if (!policy.allowedHosts.includes(`127.0.0.1:${u.port}`)) throw new DestinationBlocked('Host not on allowlist')
    return u
  }
  if (u.protocol !== 'https:') throw new DestinationBlocked('Only https is allowed')
  if (u.port && u.port !== '443') throw new DestinationBlocked('Non-default ports are not allowed')
  if (isIpLiteral(host)) throw new DestinationBlocked('IP literal hosts are not allowed')
  if (BLOCKED_HOSTS.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) throw new DestinationBlocked('Internal hostnames are not allowed')
  if (!policy.allowedHosts.map((h) => h.toLowerCase()).includes(host)) throw new DestinationBlocked('Host not on allowlist')
  return u
}

/** Remove anything that looks like a credential before logging or returning text. */
export function redact(text: string, secrets: (string | undefined)[] = []): string {
  let out = text
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join('[REDACTED]')
  return out
    .replace(/Bearer\s+[A-Za-z0-9_\-.~+/=]+/gi, 'Bearer [REDACTED]')
    .replace(/nkmcp_[A-Za-z0-9_-]+/g, 'nkmcp_[REDACTED]')
    .replace(/(authorization|x-api-key|api[_-]?key|token|secret|password|cookie)(["'\s:=]+)(?!Bearer \[REDACTED\])([^\s"',}]+)/gi, '$1$2[REDACTED]')
    .slice(0, 300)
}
