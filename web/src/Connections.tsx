import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, ApiError } from './api'
import { Badge, Dialog, Spinner, toast } from './ui'

interface Conn {
  id: number; name: string; endpoint_url: string; transport: string; auth_type: 'none' | 'bearer' | 'oauth'; auth_hint: string | null
  has_credential: boolean; enabled: boolean; timeout_ms: number; max_response_bytes: number; calls_per_minute: number
  status: string; readiness: string; server_name: string | null; server_version: string | null; protocol_version: string | null
  last_check_at: string | null; last_verified_at: string | null; tools_refreshed_at: string | null; last_error: string | null
  tools_total?: number; tools_allowed?: number
  oauth_mode?: 'auto' | 'preregistered'; oauth_client_id?: string | null; oauth_token_auth_method?: string | null; oauth_scopes?: string | null
  has_client_secret?: boolean; oauth_strategy?: string | null; oauth_authorized_at?: string | null; oauth_token_expires_at?: string | null; oauth_last_refresh_at?: string | null
  oauth_diagnostics?: Diag | null
  stages?: Record<string, string>
}
interface Diag {
  stage_reached?: string; message?: string; next_action?: string | null; selected?: string | null
  resource_metadata?: { found: boolean; source: string | null; resource: string | null; authorization_servers: string[]; scopes_supported: string[] }
  authorization_server?: { found: boolean; issuer: string | null; discovery: string | null; pkce_s256: boolean | null; dcr: boolean; cimd: boolean; token_endpoint_auth_methods: string[] }
  strategies?: { preregistered: boolean; cimd: boolean; dcr: boolean }
}
interface Tool {
  name: string; title: string | null; description: string | null; input_schema: Record<string, unknown>; annotations: Record<string, unknown> | null
  risk: 'read' | 'write' | 'destructive'; permission: 'allowed' | 'denied'; present: boolean; changed_at: string | null; last_success_at: string | null; last_error_at: string | null
}
interface Meta { encryption_configured: boolean; local_mock_allowed: boolean; auth_types: { id: string; label: string; supported: boolean; note?: string }[]; oauth?: { redirect_uri: string; client_id_metadata_document: string | null } }

const READINESS: Record<string, string> = {
  disabled: 'Disabled', not_configured: 'Not configured', auth_required: 'Authentication required', untested: 'Not tested',
  connection_failed: 'Connection failed', auth_failed: 'Authentication failed', connected_unverified: 'Connected · not verified',
  tools_discovered: 'Tools discovered · none approved', tools_discovered_unverified: 'Tools approved · not yet verified by a call',
  verified_no_tools_allowed: 'Verified · no tools approved', ready: 'Ready to use',
}
const tone = (r: string) => (r === 'ready' ? 'good' : ['connection_failed', 'auth_failed', 'disabled'].includes(r) ? 'bad' : r === 'untested' || r === 'not_configured' ? '' : 'warn')
function RBadge({ r }: { r: string }) {
  return <span className={`badge ${tone(r)}`}>{READINESS[r] ?? r}</span>
}
function RiskBadge({ risk }: { risk: string }) {
  return <span className={`badge ${risk === 'read' ? 'good' : risk === 'destructive' ? 'bad' : 'warn'}`}>{risk === 'read' ? 'Read-only' : risk === 'write' ? 'May write' : 'Destructive'}</span>
}

// ---------- form ----------
function ConnectionForm({ initial, meta, onDone, onCancel }: { initial?: Conn; meta: Meta; onDone: (c: Conn) => void; onCancel: () => void }) {
  const [name, setName] = useState(initial?.name ?? '')
  const [url, setUrl] = useState(initial?.endpoint_url ?? '')
  const [auth, setAuth] = useState<Conn['auth_type']>(initial?.auth_type ?? 'bearer')
  const [token, setToken] = useState('')
  const [oauthMode, setOauthMode] = useState<'auto' | 'preregistered'>(initial?.oauth_mode ?? 'auto')
  const [clientId, setClientId] = useState(initial?.oauth_client_id ?? '')
  const [clientSecret, setClientSecret] = useState('')
  const [tokenAuth, setTokenAuth] = useState(initial?.oauth_token_auth_method ?? 'none')
  const [scopes, setScopes] = useState(initial?.oauth_scopes ?? '')
  const [timeout, setTimeoutMs] = useState(initial?.timeout_ms ?? 15000)
  const [maxBytes, setMaxBytes] = useState(initial?.max_response_bytes ?? 1048576)
  const [rate, setRate] = useState(initial?.calls_per_minute ?? 30)
  const [errs, setErrs] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setErrs({})
    const body: Record<string, unknown> = { name, endpoint_url: url, auth_type: auth, timeout_ms: timeout, max_response_bytes: maxBytes, calls_per_minute: rate }
    if (auth === 'bearer' && token) body.bearer_token = token
    if (auth === 'oauth') {
      body.oauth_mode = oauthMode
      body.oauth_scopes = scopes.trim() || null
      if (oauthMode === 'preregistered') {
        body.oauth_client_id = clientId.trim()
        body.oauth_token_auth_method = tokenAuth
        if (clientSecret) body.oauth_client_secret = clientSecret
      }
    }
    try {
      const r = initial
        ? await api<Conn>(`/connector/connections/${initial.id}`, { method: 'PATCH', json: body })
        : await api<Conn>('/connector/connections', { method: 'POST', json: body })
      toast(initial ? 'Connection updated.' : 'Connection added. Run “Test & discover” next.')
      onDone(r)
    } catch (err) {
      if (err instanceof ApiError && Array.isArray(err.details)) setErrs(Object.fromEntries((err.details as { field: string; message: string }[]).map((d) => [d.field, d.message])))
      toast(err instanceof Error ? err.message : 'Failed', true)
    } finally {
      setBusy(false)
    }
  }
  const F = ({ id, label, children, help }: { id: string; label: string; children: React.ReactNode; help?: string }) => (
    <div className="field">
      <label htmlFor={`c-${id}`}>{label}</label>
      {children}
      {help && <span className="help">{help}</span>}
      {errs[id] && <span className="err">{errs[id]}</span>}
    </div>
  )
  return (
    <form onSubmit={submit}>
      {!meta.encryption_configured && <p className="notice error">CONNECTOR_ENC_KEY is not configured on the server. Credentials cannot be stored until it is set.</p>}
      <div className="form">
        <div className="field full">
          <label htmlFor="c-name">Name</label>
          <input id="c-name" className="input" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Research provider" />
          {errs.name && <span className="err">{errs.name}</span>}
        </div>
        <div className="field full">
          <label htmlFor="c-url">MCP endpoint URL</label>
          <input id="c-url" className="input" type="url" required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" aria-invalid={!!errs.endpoint_url} />
          <span className="help">Public https only. Private, loopback, link-local, metadata and NALUKESA's own hosts are rejected. Changing the URL drops the credential and resets every tool approval.</span>
          {errs.endpoint_url && <span className="err">{errs.endpoint_url}</span>}
        </div>
        <F id="transport" label="Transport"><select id="c-transport" className="select" disabled value="streamable_http"><option value="streamable_http">Streamable HTTP</option></select></F>
        <F id="auth_type" label="Authentication">
          <select id="c-auth_type" className="select" value={auth} onChange={(e) => setAuth(e.target.value as Conn['auth_type'])}>
            {meta.auth_types.map((a) => <option key={a.id} value={a.id} disabled={!a.supported}>{a.label}</option>)}
          </select>
        </F>
        {auth === 'bearer' && (
          <div className="field full">
            <label htmlFor="c-token">Bearer token / API key {initial?.has_credential && <span className="muted">(stored: {initial.auth_hint}; leave blank to keep)</span>}</label>
            <input id="c-token" className="input" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} required={!initial?.has_credential} />
            <span className="help">Stored encrypted (AES-256-GCM). It is never shown again or sent to the browser.</span>
            {errs.bearer_token && <span className="err">{errs.bearer_token}</span>}
          </div>
        )}
        {auth === 'oauth' && (
          <fieldset className="full" style={{ gridColumn: '1 / -1', border: '1px solid var(--line)', borderRadius: 12, padding: 14, margin: 0 }}>
            <legend className="small" style={{ padding: '0 6px' }}>OAuth 2.1 (authorization code + PKCE S256)</legend>
            <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '6px 0' }}>
              <input type="radio" name="oauth-mode" checked={oauthMode === 'auto'} onChange={() => setOauthMode('auto')} />
              <span><strong>Recommended: Sign in with OAuth</strong><span className="muted small" style={{ display: 'block' }}>NALUKESA discovers the provider’s OAuth metadata and registers itself automatically, using a Client ID Metadata Document or Dynamic Client Registration, whichever the provider supports.</span></span>
            </label>
            <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '6px 0' }}>
              <input type="radio" name="oauth-mode" checked={oauthMode === 'preregistered'} onChange={() => setOauthMode('preregistered')} />
              <span><strong>Use a pre-registered OAuth app</strong><span className="muted small" style={{ display: 'block' }}>For providers that require you to create an OAuth app in their developer console.</span></span>
            </label>
            {meta.oauth && (
              <p className="small muted" style={{ margin: '8px 0' }}>
                Callback URL to register with the provider: <code className="mono">{meta.oauth.redirect_uri}</code>
                {meta.oauth.client_id_metadata_document && <> · Client metadata document: <code className="mono">{meta.oauth.client_id_metadata_document}</code></>}
              </p>
            )}
            {oauthMode === 'preregistered' && (
              <div className="form" style={{ marginTop: 8 }}>
                <div className="field">
                  <label htmlFor="c-oauth_client_id">Client ID</label>
                  <input id="c-oauth_client_id" className="input" autoComplete="off" required value={clientId} onChange={(e) => setClientId(e.target.value)} />
                  {errs.oauth_client_id && <span className="err">{errs.oauth_client_id}</span>}
                </div>
                <div className="field">
                  <label htmlFor="c-oauth_token_auth_method">Client type / token auth</label>
                  <select id="c-oauth_token_auth_method" className="select" value={tokenAuth} onChange={(e) => setTokenAuth(e.target.value)}>
                    <option value="none">Public client (no secret)</option>
                    <option value="client_secret_basic">Confidential: client_secret_basic</option>
                    <option value="client_secret_post">Confidential: client_secret_post</option>
                  </select>
                </div>
                {tokenAuth !== 'none' && (
                  <div className="field full">
                    <label htmlFor="c-oauth_client_secret">Client secret {initial?.has_client_secret && <span className="muted">(stored; leave blank to keep)</span>}</label>
                    <input id="c-oauth_client_secret" className="input" type="password" autoComplete="off" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} required={!initial?.has_client_secret} />
                    <span className="help">Encrypted server-side and never shown again. Enter it here only. Never paste it into chat.</span>
                    {errs.oauth_client_secret && <span className="err">{errs.oauth_client_secret}</span>}
                  </div>
                )}
              </div>
            )}
            <div className="field" style={{ marginTop: 8 }}>
              <label htmlFor="c-oauth_scopes">Scopes (optional override)</label>
              <input id="c-oauth_scopes" className="input" value={scopes} onChange={(e) => setScopes(e.target.value)} placeholder="Leave blank to use the scopes the provider advertises" />
              {errs.oauth_scopes && <span className="err">{errs.oauth_scopes}</span>}
            </div>
          </fieldset>
        )}
        <F id="timeout_ms" label="Timeout (ms)" help="1000–30000"><input id="c-timeout_ms" className="input" type="number" min={1000} max={30000} value={timeout} onChange={(e) => setTimeoutMs(Number(e.target.value))} /></F>
        <F id="max_response_bytes" label="Max response (bytes)" help="1 KB – 4 MB"><input id="c-max_response_bytes" className="input" type="number" min={1024} max={4194304} value={maxBytes} onChange={(e) => setMaxBytes(Number(e.target.value))} /></F>
        <F id="calls_per_minute" label="Calls per minute" help="1–120"><input id="c-calls_per_minute" className="input" type="number" min={1} max={120} value={rate} onChange={(e) => setRate(Number(e.target.value))} /></F>
      </div>
      <div className="actions" style={{ justifyContent: 'flex-end', marginTop: 18 }}>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Saving…' : initial ? 'Save changes' : 'Add connection'}</button>
      </div>
    </form>
  )
}

// ---------- invoke ----------
function exampleFor(schema: Record<string, unknown>): string {
  const props = (schema.properties ?? {}) as Record<string, { type?: string; enum?: unknown[] }>
  const out: Record<string, unknown> = {}
  for (const [k, p] of Object.entries(props)) out[k] = p.enum ? p.enum[0] : p.type === 'number' || p.type === 'integer' ? 0 : p.type === 'boolean' ? false : p.type === 'array' ? [] : p.type === 'object' ? {} : ''
  return JSON.stringify(out, null, 2)
}
function InvokePanel({ conn, tool, onClose }: { conn: Conn; tool: Tool; onClose: () => void }) {
  const [args, setArgs] = useState(() => exampleFor(tool.input_schema))
  const [res, setRes] = useState<Record<string, unknown> | null>(null)
  const [busy, setBusy] = useState(false)
  async function run() {
    let parsed: unknown
    try {
      parsed = JSON.parse(args || '{}')
    } catch {
      return toast('Arguments must be valid JSON.', true)
    }
    if (tool.risk !== 'read' && !confirm(`“${tool.name}” is classified ${tool.risk.toUpperCase()}. It may change data on the remote service. Run it?`)) return
    setBusy(true)
    try {
      setRes(await api(`/connector/connections/${conn.id}/tools/${encodeURIComponent(tool.name)}/invoke`, { method: 'POST', json: { arguments: parsed } }))
    } catch (e) {
      setRes({ ok: false, error: { message: e instanceof Error ? e.message : String(e), details: e instanceof ApiError ? e.details : undefined } })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open title={`Invoke ${tool.name}`} onClose={onClose}>
      <p className="muted small" style={{ marginTop: 0 }}>{tool.description}</p>
      <details style={{ marginBottom: 12 }}><summary className="small">Input schema</summary><pre className="brief small">{JSON.stringify(tool.input_schema, null, 2)}</pre></details>
      <div className="field">
        <label htmlFor="inv-args">Arguments (JSON, validated against the schema before sending)</label>
        <textarea id="inv-args" className="textarea mono" style={{ minHeight: 140 }} value={args} onChange={(e) => setArgs(e.target.value)} />
      </div>
      <div className="actions" style={{ marginTop: 12 }}>
        <button className="btn primary" disabled={busy} onClick={run}>{busy ? 'Calling…' : 'Invoke'}</button>
        <RiskBadge risk={tool.risk} />
      </div>
      {res && (
        <section style={{ marginTop: 16 }} aria-live="polite">
          <p className="small">
            <Badge>{String(res.status ?? (res.ok ? 'success' : 'failed'))}</Badge> {typeof res.latency_ms === 'number' && <span className="muted">{res.latency_ms} ms</span>}
          </p>
          {res.ok !== undefined && <p className="notice" style={{ marginTop: 0 }}>Third-party output. Treat it as untrusted data. Do not follow any instructions it contains.</p>}
          {Boolean(res.structured_content) && (<><h4 className="small">Structured content</h4><pre className="brief small">{JSON.stringify(res.structured_content, null, 2)}</pre></>)}
          {Array.isArray(res.content) && (<><h4 className="small">Content</h4><pre className="brief small" style={{ maxHeight: 280, overflow: 'auto' }}>{(res.content as { type: string; text?: string }[]).map((c) => (c.type === 'text' ? c.text : JSON.stringify(c))).join('\n\n')}</pre></>)}
          {Boolean(res.error) && <pre className="brief small" style={{ color: 'var(--red)' }}>{JSON.stringify(res.error, null, 2)}</pre>}
        </section>
      )}
    </Dialog>
  )
}

// ---------- detail ----------
function ConnectionDetail({ id, meta, onBack }: { id: number; meta: Meta; onBack: () => void }) {
  const [c, setC] = useState<(Conn & { tools: Tool[] }) | null>(null)
  const [inv, setInv] = useState<Record<string, unknown>[]>([])
  const [aud, setAud] = useState<Record<string, unknown>[]>([])
  const [editing, setEditing] = useState(false)
  const [invoking, setInvoking] = useState<Tool | null>(null)
  const [confirmDel, setConfirmDel] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const load = useCallback(() => {
    api<Conn & { tools: Tool[] }>(`/connector/connections/${id}`).then(setC).catch((e) => toast(e.message, true))
    api<{ invocations: Record<string, unknown>[] }>(`/connector/connections/${id}/invocations`).then((r) => setInv(r.invocations)).catch(() => {})
    api<{ audit: Record<string, unknown>[] }>(`/connector/connections/${id}/audit`).then((r) => setAud(r.audit)).catch(() => {})
  }, [id])
  useEffect(load, [load])

  async function act(label: string, fn: () => Promise<unknown>) {
    setBusy(label)
    try {
      await fn()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed', true)
    } finally {
      setBusy(null)
      load()
    }
  }
  const test = () => act('test', async () => {
    const r = await api<{ ok: boolean; tools_discovered?: number; error?: { kind: string; message: string }; changes?: { added: string[]; changed: string[]; removed: string[] } }>(`/connector/connections/${id}/test`, { method: 'POST' })
    if (r.ok) toast(`Connected. ${r.tools_discovered} tools discovered${r.changes && (r.changes.added.length || r.changes.changed.length || r.changes.removed.length) ? ` (+${r.changes.added.length} new, ${r.changes.changed.length} changed, ${r.changes.removed.length} removed)` : ''}.`)
    else toast(`${r.error?.kind}: ${r.error?.message}`, true)
  })
  const setPerm = (t: Tool, permission: 'allowed' | 'denied') => act('perm', async () => {
    let confirm_risk: string | undefined
    if (permission === 'allowed' && t.risk !== 'read') {
      if (!confirm(`“${t.name}” is classified ${t.risk.toUpperCase()}. Approving it lets NALUKESA (owner UI only) call an operation that may change or delete data on the remote service. Approve?`)) return
      confirm_risk = t.risk
    }
    await api(`/connector/connections/${id}/tools/${encodeURIComponent(t.name)}/permission`, { method: 'PUT', json: { permission, confirm_risk } })
  })
  const authorize = () => act('oauth', async () => {
    try {
      const r = await api<{ ok: boolean; authorization_url: string; strategy: string }>(`/connector/connections/${id}/oauth/start`, { method: 'POST' })
      window.open(r.authorization_url, '_blank', 'noopener,noreferrer')
      toast(`Authorizing via ${r.strategy}. Complete sign-in in the new tab, then run “Test & discover”.`)
    } catch (e) {
      const d = e instanceof ApiError ? (e.details as unknown) : null
      const body = (e instanceof ApiError ? e : null) as (ApiError & { message: string }) | null
      toast(body?.message ?? 'Authorization could not start', true)
      void d
    }
  })
  const diagnose = () => act('diag', async () => {
    const r = await api<{ ok: boolean; message?: string; diagnostics?: Diag }>(`/connector/connections/${id}/oauth/diagnose`, { method: 'POST' })
    toast(r.ok ? `OAuth ready: ${r.diagnostics?.selected}` : (r.message ?? 'Discovery failed'), !r.ok)
  })

  if (!c) return <Spinner />
  return (
    <>
      <nav className="crumb" style={{ marginBottom: 10 }}><button className="btn ghost sm" onClick={onBack}>← All connections</button></nav>
      <div className="pagehead">
        <div>
          <p className="eyebrow">External MCP connection</p>
          <h1 className="title">{c.name}</h1>
          <p className="muted small mono" style={{ margin: 0 }}>{c.endpoint_url}</p>
        </div>
        <div className="actions">
          <RBadge r={c.readiness} />
          <button className="btn primary" disabled={!!busy || !c.enabled} onClick={test}>{busy === 'test' ? 'Testing…' : 'Test & discover'}</button>
          {c.auth_type === 'oauth' && <button className="btn" disabled={!!busy} onClick={diagnose}>{busy === 'diag' ? 'Checking…' : 'Check OAuth'}</button>}
          {c.auth_type === 'oauth' && <button className="btn" disabled={!!busy || !meta.encryption_configured} onClick={authorize}>{c.has_credential ? 'Re-authorize' : 'Sign in with OAuth'}</button>}
          <button className="btn" onClick={() => setEditing(true)}>Edit</button>
          <button className="btn" onClick={() => act('toggle', () => api(`/connector/connections/${id}`, { method: 'PATCH', json: { enabled: !c.enabled } }))}>{c.enabled ? 'Disable' : 'Enable'}</button>
          {c.has_credential && <button className="btn danger" onClick={() => confirm('Revoke and erase the stored credential?') && act('revoke', () => api(`/connector/connections/${id}/revoke-credential`, { method: 'POST' }))}>Revoke credential</button>}
          <button className="btn danger" onClick={() => setConfirmDel(true)}>Delete</button>
        </div>
      </div>

      <section className="panel">
        <dl className="kv">
          <dt>Status</dt><dd>{c.status}{c.last_error ? ` — ${c.last_error}` : ''}</dd>
          <dt>Server</dt><dd>{c.server_name ? `${c.server_name} ${c.server_version ?? ''}` : <span className="unknown">Not yet contacted</span>}</dd>
          <dt>Protocol</dt><dd>{c.protocol_version ?? <span className="unknown">—</span>} · Streamable HTTP</dd>
          <dt>Authentication</dt><dd>{c.auth_type}{c.auth_type === 'oauth' ? ` · ${c.oauth_mode === 'preregistered' ? `pre-registered app (${c.oauth_client_id ?? 'no client id'}${c.has_client_secret ? ', confidential' : ''})` : 'automatic registration'}` : ''}{c.has_credential ? ` · stored ${c.auth_hint ?? ''}` : c.auth_type !== 'none' ? ' · no credential' : ''}</dd>
          {c.auth_type === 'oauth' && <><dt>OAuth</dt><dd>{c.oauth_authorized_at ? `Authorized ${c.oauth_authorized_at}` : 'Not authorized'}{c.oauth_token_expires_at ? ` · token expires ${c.oauth_token_expires_at}` : ''}{c.oauth_last_refresh_at ? ` · last refresh ${c.oauth_last_refresh_at}` : ''}</dd></>}
          <dt>Limits</dt><dd>{c.timeout_ms} ms · {Math.round(c.max_response_bytes / 1024)} KB · {c.calls_per_minute}/min</dd>
          <dt>Last check</dt><dd>{c.last_check_at ?? <span className="unknown">Never</span>}</dd>
          <dt>Last verified call</dt><dd>{c.last_verified_at ?? <span className="unknown">Never: a successful health check does not prove invocation works</span>}</dd>
          <dt>Tools refreshed</dt><dd>{c.tools_refreshed_at ?? <span className="unknown">Never</span>}</dd>
        </dl>
      </section>

      {c.stages && (
        <section className="panel" aria-labelledby="stages-h">
          <h3 id="stages-h">Connection stages</h3>
          <ol className="steps" style={{ marginTop: 10 }}>
            {([
              ['endpoint_reachable', 'Endpoint reachable'],
              ['oauth_configured', 'OAuth configured'],
              ['account_authorized', 'Account authorized'],
              ['mcp_initialized', 'MCP initialized'],
              ['tools_discovered', 'Tools discovered'],
              ['invocation_verified', 'Tool invocation verified'],
            ] as const).map(([k, label]) => {
              const v = c.stages![k]
              return (
                <li key={k}>
                  <span>{label}</span>
                  <span className={`badge ${v === 'ok' ? 'good' : v === 'failed' || v === 'missing' || v === 'missing_client_id' ? 'bad' : ''}`}>{v === 'ok' ? 'Passed' : v === 'n/a' ? 'Not applicable' : v === 'unknown' ? 'Pending' : v.replace(/_/g, ' ')}</span>
                </li>
              )
            })}
          </ol>
          <p className="muted small" style={{ marginBottom: 0 }}>Completing OAuth sign-in does not prove data access. A connection becomes <strong>Ready</strong> only after a test, tool discovery, an approval, and a successful invocation.</p>
        </section>
      )}

      {c.auth_type === 'oauth' && c.oauth_diagnostics && (
        <section className="panel" aria-labelledby="diag-h">
          <h3 id="diag-h">OAuth discovery</h3>
          {c.oauth_diagnostics.message && <p className={`notice ${c.oauth_diagnostics.stage_reached === 'ready' ? 'info' : 'error'}`} style={{ marginTop: 6 }}>{c.oauth_diagnostics.message}{c.oauth_diagnostics.next_action ? <><br /><strong>Next:</strong> {c.oauth_diagnostics.next_action}</> : null}</p>}
          <dl className="kv">
            <dt>Protected resource metadata</dt><dd>{c.oauth_diagnostics.resource_metadata?.found ? `Found (${c.oauth_diagnostics.resource_metadata.source})` : 'Not found'}</dd>
            <dt>Authorization server</dt><dd>{c.oauth_diagnostics.authorization_server?.found ? `${c.oauth_diagnostics.authorization_server.issuer ?? ''} (${c.oauth_diagnostics.authorization_server.discovery})` : 'Not found'}</dd>
            <dt>PKCE S256</dt><dd>{c.oauth_diagnostics.authorization_server?.pkce_s256 === null ? 'Not advertised (S256 will be sent)' : c.oauth_diagnostics.authorization_server?.pkce_s256 ? 'Supported' : 'Not supported'}</dd>
            <dt>Registration methods</dt><dd>{[c.oauth_diagnostics.authorization_server?.cimd && 'Client ID Metadata Document', c.oauth_diagnostics.authorization_server?.dcr && 'Dynamic Client Registration'].filter(Boolean).join(', ') || 'None advertised; a pre-registered OAuth app is required'}</dd>
            <dt>Selected strategy</dt><dd>{c.oauth_diagnostics.selected ?? '—'}</dd>
            {c.oauth_diagnostics.resource_metadata?.scopes_supported?.length ? <><dt>Scopes</dt><dd>{c.oauth_diagnostics.resource_metadata.scopes_supported.join(' ')}</dd></> : null}
          </dl>
        </section>
      )}

      <section className="panel">
        <h3>Tools ({c.tools.filter((t) => t.present).length})</h3>
        <p className="muted small" style={{ marginTop: 0 }}>Every discovered tool starts as denied, and new tools are never run automatically. If a tool's schema or description changes, its approval is revoked. Approving a write or destructive tool requires explicit confirmation, and those tools cannot be called through the NALUKESA MCP bridge.</p>
        {c.tools.length === 0 ? <p className="muted">No tools discovered yet. Press “Test & discover”.</p> : (
          <div className="tablewrap">
            <table>
              <thead><tr><th scope="col">Tool</th><th scope="col">Risk</th><th scope="col">Permission</th><th scope="col">Last result</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {c.tools.map((t) => (
                  <tr key={t.name} style={{ opacity: t.present ? 1 : 0.5 }}>
                    <td><span className="mono">{t.name}</span>{!t.present && <span className="badge bad" style={{ marginLeft: 6 }}>Removed upstream</span>}{t.changed_at && <span className="badge warn" style={{ marginLeft: 6 }} title={`Changed ${t.changed_at}`}>Changed — re-review</span>}<span className="muted small" style={{ display: 'block', maxWidth: 420, whiteSpace: 'normal' }}>{t.description}</span></td>
                    <td><RiskBadge risk={t.risk} /></td>
                    <td><span className={`badge ${t.permission === 'allowed' ? 'good' : ''}`}>{t.permission === 'allowed' ? 'Approved' : 'Denied'}</span></td>
                    <td className="small mono">{t.last_success_at ? `✓ ${t.last_success_at}` : t.last_error_at ? `✕ ${t.last_error_at}` : '—'}</td>
                    <td>
                      <span className="actions" style={{ flexWrap: 'nowrap' }}>
                        {t.permission === 'allowed'
                          ? <button className="btn sm" onClick={() => setPerm(t, 'denied')}>Deny</button>
                          : <button className="btn sm" disabled={!t.present} onClick={() => setPerm(t, 'allowed')}>Approve</button>}
                        <button className="btn primary sm" disabled={t.permission !== 'allowed' || !t.present || !c.enabled} onClick={() => setInvoking(t)}>Invoke</button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="grid k2" style={{ marginTop: 16 }}>
        <section className="panel">
          <h3>Recent invocations</h3>
          {inv.length === 0 ? <p className="muted">None yet.</p> : (
            <ul className="listplain">{inv.slice(0, 15).map((i) => (
              <li key={String(i.id)}><span><span className="mono small">{String(i.tool_name)}</span><span className="muted small" style={{ display: 'block' }}>{String(i.created_at)} · {String(i.caller)}{i.error ? ` · ${String(i.error).slice(0, 80)}` : ''}</span></span><Badge>{String(i.status)}</Badge></li>
            ))}</ul>
          )}
        </section>
        <section className="panel">
          <h3>Audit history</h3>
          {aud.length === 0 ? <p className="muted">None.</p> : (
            <ul className="listplain">{aud.slice(0, 15).map((a) => (
              <li key={String(a.id)}><span><span className="small">{String(a.action).replace('connector_', '')}</span><span className="muted small" style={{ display: 'block' }}>{String(a.created_at)}</span></span><span className="muted small" style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>{String(a.metadata ?? '')}</span></li>
            ))}</ul>
          )}
        </section>
      </div>

      <Dialog open={editing} title="Edit connection" onClose={() => setEditing(false)}>
        <ConnectionForm initial={c} meta={meta} onCancel={() => setEditing(false)} onDone={() => { setEditing(false); load() }} />
      </Dialog>
      {invoking && <InvokePanel conn={c} tool={invoking} onClose={() => { setInvoking(null); load() }} />}
      <Dialog open={confirmDel} title="Delete connection?" onClose={() => setConfirmDel(false)}
        footer={<><button className="btn" onClick={() => setConfirmDel(false)}>Cancel</button><button className="btn danger" onClick={async () => { try { await api(`/connector/connections/${id}`, { method: 'DELETE' }); toast('Connection deleted.'); onBack() } catch (e) { toast(e instanceof Error ? e.message : 'Failed', true) } }}>Delete permanently</button></>}>
        <p>This erases the stored credential and every tool approval. The invocation history is kept for audit.</p>
      </Dialog>
    </>
  )
}

// ---------- list ----------
export function Connections() {
  const [meta, setMeta] = useState<Meta | null>(null)
  const [list, setList] = useState<Conn[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [open, setOpen] = useState<number | null>(null)
  const load = useCallback(() => {
    api<Meta>('/connector/meta').then(setMeta).catch(() => {})
    api<{ connections: Conn[] }>('/connector/connections').then((r) => setList(r.connections)).catch((e) => toast(e.message, true))
  }, [])
  useEffect(load, [load])
  if (!meta || !list) return <Spinner />
  if (open) return <ConnectionDetail id={open} meta={meta} onBack={() => { setOpen(null); load() }} />
  return (
    <section className="panel" aria-labelledby="conn-h">
      <div className="pagehead" style={{ marginBottom: 8 }}>
        <div>
          <h3 id="conn-h">External MCP connections (outbound)</h3>
          <p className="muted small" style={{ margin: 0 }}>Connect any standard MCP server over Streamable HTTP, with no new code needed. Credentials are encrypted at rest and never returned to the browser.</p>
        </div>
        <button className="btn primary sm" onClick={() => setAdding(true)}>+ Add connection</button>
      </div>
      {!meta.encryption_configured && <p className="notice error">CONNECTOR_ENC_KEY is not set on the server. Only connections with no authentication can be added.</p>}
      {list.length === 0 ? <p className="muted">No external connections yet.</p> : (
        <div className="tablewrap">
          <table>
            <thead><tr><th scope="col">Name</th><th scope="col">Endpoint</th><th scope="col">Auth</th><th scope="col">Tools</th><th scope="col">State</th><th scope="col">Last check</th></tr></thead>
            <tbody>{list.map((c) => (
              <tr key={c.id}>
                <td><button className="btn ghost sm" style={{ padding: 0 }} onClick={() => setOpen(c.id)}>{c.name}</button></td>
                <td className="mono small">{new URL(c.endpoint_url).host}</td>
                <td className="small">{c.auth_type}{c.auth_type !== 'none' && !c.has_credential ? ' · missing' : ''}</td>
                <td className="small">{c.tools_allowed ?? 0} approved / {c.tools_total ?? 0}</td>
                <td><RBadge r={c.readiness} /></td>
                <td className="mono small">{c.last_check_at ?? '—'}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <Dialog open={adding} title="Add external MCP connection" onClose={() => setAdding(false)}>
        <ConnectionForm meta={meta} onCancel={() => setAdding(false)} onDone={(c) => { setAdding(false); load(); setOpen(c.id) }} />
      </Dialog>
    </section>
  )
}
