/** Normalized outbound provider model for the NALUKESA MCP Hub. */

export type ProviderKind = 'mcp' | 'rest'

export type ProviderStatus =
  | 'not_configured' // credentials/URL missing — never contacted
  | 'configured' // config present, never checked (unverified)
  | 'available'
  | 'unavailable'
  | 'rate_limited'
  | 'auth_failed'
  | 'invalid_response'
  | 'blocked' // destination rejected by safety policy

export interface ProviderDefinition {
  id: string
  name: string
  kind: ProviderKind
  description: string
  /** Name of the env var holding the endpoint URL (non-secret config) */
  urlEnv: string
  /** Name of the secret env var holding the credential (value never logged/returned) */
  secretEnv?: string
  /** Exact hostnames allowed for this provider */
  allowedHosts: string[]
  /** For REST providers: path used for health check */
  healthPath?: string
  readOnly: true
}

export interface ProviderResult<T = unknown> {
  ok: boolean
  status: ProviderStatus
  provider_id: string
  observed_at: string
  latency_ms: number | null
  source_url: string | null
  data?: T
  error?: string // redacted
}

export interface HubLimits {
  timeoutMs: number
  maxResponseBytes: number
  maxRetries: number
}

export const DEFAULT_LIMITS: HubLimits = { timeoutMs: 8000, maxResponseBytes: 512 * 1024, maxRetries: 1 }
