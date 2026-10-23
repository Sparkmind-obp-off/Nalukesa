/**
 * Explicit provider allowlist. A provider is only ever contacted when:
 *  1. it is defined here,
 *  2. its URL env var is set (non-secret config),
 *  3. its secret env var is set if it requires one,
 *  4. the owner explicitly triggers a check (no background polling).
 *
 * The built-in entries are placeholders for future approved integrations.
 * None are configured in production by this change.
 */
import type { ProviderDefinition, ProviderStatus } from './types'
import { restGetJson, type FetchLike } from './rest'
import { mcpListTools } from './mcpClient'

export const PROVIDERS: ProviderDefinition[] = [
  {
    id: 'example-mcp',
    name: 'Example remote MCP server',
    kind: 'mcp',
    description: 'Template for an approved third-party MCP server (Streamable HTTP). Not configured.',
    urlEnv: 'HUB_EXAMPLE_MCP_URL',
    secretEnv: 'HUB_EXAMPLE_MCP_TOKEN',
    allowedHosts: [],
    readOnly: true,
  },
  {
    id: 'example-rest',
    name: 'Example REST API',
    kind: 'rest',
    description: 'Template for an approved read-only REST provider. Not configured.',
    urlEnv: 'HUB_EXAMPLE_REST_URL',
    secretEnv: 'HUB_EXAMPLE_REST_KEY',
    allowedHosts: [],
    healthPath: '/health',
    readOnly: true,
  },
]

type Env = Record<string, unknown>

export function providerHosts(def: ProviderDefinition, env: Env): string[] {
  // Allowlist = static hosts + host of the configured URL only if explicitly mirrored in HUB_ALLOWED_HOSTS
  const extra = typeof env.HUB_ALLOWED_HOSTS === 'string' ? env.HUB_ALLOWED_HOSTS.split(',').map((s) => s.trim()).filter(Boolean) : []
  return [...def.allowedHosts, ...extra]
}

export function configStatus(def: ProviderDefinition, env: Env): { status: ProviderStatus; missing: string[] } {
  const missing: string[] = []
  if (typeof env[def.urlEnv] !== 'string' || !env[def.urlEnv]) missing.push(def.urlEnv)
  if (def.secretEnv && (typeof env[def.secretEnv] !== 'string' || !env[def.secretEnv])) missing.push(def.secretEnv)
  return { status: missing.length ? 'not_configured' : 'configured', missing }
}

export async function checkProvider(def: ProviderDefinition, env: Env, opts: { fetchImpl?: FetchLike; allowInsecureLocalForTests?: boolean } = {}) {
  const cfg = configStatus(def, env)
  if (cfg.status === 'not_configured') {
    return { ok: false, status: 'not_configured' as ProviderStatus, provider_id: def.id, observed_at: new Date().toISOString(), latency_ms: null, source_url: null, error: `Missing: ${cfg.missing.join(', ')}` }
  }
  const url = String(env[def.urlEnv])
  const secret = def.secretEnv ? String(env[def.secretEnv]) : undefined
  const policy = { allowedHosts: providerHosts(def, env), allowInsecureLocalForTests: opts.allowInsecureLocalForTests }
  if (def.kind === 'mcp') {
    const r = await mcpListTools({ providerId: def.id, url, policy, secret, fetchImpl: opts.fetchImpl })
    return { ...r, data: r.ok ? { tool_count: (r.data as unknown[]).length } : undefined }
  }
  const r = await restGetJson({ providerId: def.id, url: url.replace(/\/$/, '') + (def.healthPath ?? ''), policy, secret, fetchImpl: opts.fetchImpl })
  return { ...r, data: undefined }
}

export async function latestChecks(db: D1Database) {
  const r = await db
    .prepare(
      `SELECT pc.provider_id, pc.status, pc.checked_at, pc.latency_ms, pc.detail FROM provider_checks pc
       JOIN (SELECT provider_id, MAX(id) AS id FROM provider_checks GROUP BY provider_id) m ON m.id = pc.id`,
    )
    .all<{ provider_id: string; status: string; checked_at: string; latency_ms: number | null; detail: string | null }>()
  return Object.fromEntries(r.results.map((x) => [x.provider_id, x]))
}

export async function providerStatusReport(db: D1Database, env: Env) {
  const last = await latestChecks(db)
  return PROVIDERS.map((p) => {
    const cfg = configStatus(p, env)
    const l = last[p.id]
    return {
      id: p.id,
      name: p.name,
      kind: p.kind,
      description: p.description,
      read_only: p.readOnly,
      config_status: cfg.status,
      missing_config: cfg.missing, // names only, never values
      last_check: l ? { status: l.status, checked_at: l.checked_at, latency_ms: l.latency_ms, detail: l.detail } : null,
      verified: l?.status === 'available',
    }
  })
}
