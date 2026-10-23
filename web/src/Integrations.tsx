import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api } from './api'
import { Badge, Dialog, Spinner, toast } from './ui'
import { Connections } from './Connections'

interface TokenRow { id: number; name: string; token_prefix: string; scopes: string; created_at: string; expires_at: string | null; revoked_at: string | null; last_used_at: string | null }
interface Info {
  enabled: boolean
  endpoint: string
  transport: string
  server: { name: string; version: string }
  scopes: string[]
  tools: { name: string; scope: string; title: string; description: string }[]
  rate_limit_per_min: number
  tokens: TokenRow[]
}
interface Provider {
  id: string; name: string; kind: string; description: string; config_status: string; missing_config: string[]
  last_check: { status: string; checked_at: string; latency_ms: number | null; detail: string | null } | null
  verified: boolean
}

function tokenState(t: TokenRow): string {
  if (t.revoked_at) return 'Revoked'
  if (t.expires_at && new Date(t.expires_at) < new Date()) return 'Expired'
  return 'Active'
}

export function Integrations() {
  const [info, setInfo] = useState<Info | null>(null)
  const [providers, setProviders] = useState<Provider[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newToken, setNewToken] = useState<string | null>(null)
  const [revoke, setRevoke] = useState<TokenRow | null>(null)
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<string[]>(['products:read'])
  const [ttl, setTtl] = useState(30)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    api<Info>('/mcp/info').then(setInfo).catch((e) => setError(e.message))
    api<{ providers: Provider[] }>('/hub/providers').then((r) => setProviders(r.providers)).catch((e) => setError(e.message))
  }, [])
  useEffect(load, [load])

  async function create(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const r = await api<{ token: string }>('/mcp/tokens', { method: 'POST', json: { name, scopes, ttl_days: ttl } })
      setCreating(false)
      setNewToken(r.token)
      setName('')
      load()
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', true)
    } finally {
      setBusy(false)
    }
  }
  async function doRevoke() {
    if (!revoke) return
    try {
      await api(`/mcp/tokens/${revoke.id}/revoke`, { method: 'POST' })
      toast('Token revoked.')
      setRevoke(null)
      load()
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', true)
    }
  }
  async function check(id: string) {
    try {
      const r = await api<{ status: string; detail: string | null }>(`/hub/providers/${id}/check`, { method: 'POST' })
      toast(`${id}: ${r.status}${r.detail ? ' — ' + r.detail : ''}`, r.status !== 'available')
      load()
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', true)
    }
  }

  if (error) return <div className="notice error" role="alert">{error}</div>
  if (!info || !providers) return <Spinner />

  return (
    <>
      <div className="pagehead">
        <div>
          <p className="eyebrow">System</p>
          <h1 className="title">MCP & integrations</h1>
          <p className="lede">Inbound: let approved AI clients read selected NALUKESA data through MCP. Outbound: connect NALUKESA to any external MCP server, approve individual tools, and call them.</p>
        </div>
      </div>

      <section className="panel" aria-labelledby="srv-h">
        <h3 id="srv-h">NALUKESA MCP server (inbound)</h3>
        <ul className="listplain">
          <li>Status <Badge>{info.enabled ? 'Enabled' : 'Disabled'}</Badge></li>
          <li>Endpoint <code className="mono small">{info.endpoint}</code></li>
          <li>Transport <span className="small">{info.transport}</span></li>
          <li>Auth <span className="small">Bearer token (scoped, expiring, revocable) · {info.rate_limit_per_min} requests/min per token</span></li>
        </ul>
        <div className="tablewrap" style={{ marginTop: 12 }}>
          <table>
            <thead><tr><th scope="col">Tool</th><th scope="col">Required scope</th><th scope="col">Description</th></tr></thead>
            <tbody>
              {info.tools.map((t) => (
                <tr key={t.name}><td className="mono">{t.name}</td><td><span className="badge">{t.scope}</span></td><td className="small">{t.description}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel" aria-labelledby="tok-h">
        <div className="pagehead" style={{ marginBottom: 8 }}>
          <div>
            <h3 id="tok-h">Access tokens</h3>
            <p className="muted small" style={{ margin: 0 }}>Each token is shown once at creation and stored only as a hash. These tokens are separate from your owner password.</p>
          </div>
          <button className="btn primary sm" onClick={() => setCreating(true)}>+ New token</button>
        </div>
        {info.tokens.length === 0 ? <p className="muted">No tokens yet. The MCP endpoint rejects every request until a token exists.</p> : (
          <div className="tablewrap">
            <table>
              <thead><tr><th scope="col">Name</th><th scope="col">Prefix</th><th scope="col">Scopes</th><th scope="col">Expires</th><th scope="col">Last used</th><th scope="col">State</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {info.tokens.map((t) => (
                  <tr key={t.id}>
                    <td>{t.name}</td>
                    <td className="mono small">{t.token_prefix}…</td>
                    <td className="small">{t.scopes}</td>
                    <td className="mono small">{t.expires_at ?? '—'}</td>
                    <td className="mono small">{t.last_used_at ?? <span className="unknown">Never</span>}</td>
                    <td><Badge>{tokenState(t)}</Badge></td>
                    <td>{tokenState(t) === 'Active' && <button className="btn danger sm" onClick={() => setRevoke(t)}>Revoke</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Connections />

      <section className="panel" aria-labelledby="hub-h">
        <h3 id="hub-h">Built-in provider templates (legacy registry)</h3>
        <p className="muted small" style={{ marginTop: 0 }}>Explicit allowlist. A provider is contacted only when you press Check, and only after its URL and secret are set as Cloudflare secrets. “Configured” means unverified.</p>
        <ul className="listplain">
          {providers.map((p) => (
            <li key={p.id}>
              <span>
                <strong style={{ fontWeight: 560 }}>{p.name}</strong> <span className="badge">{p.kind.toUpperCase()}</span>
                <span className="muted small" style={{ display: 'block' }}>{p.description}</span>
                {p.missing_config.length > 0 && <span className="muted small" style={{ display: 'block' }}>Missing: {p.missing_config.join(', ')}</span>}
                {p.last_check && <span className="muted small" style={{ display: 'block' }}>Last check {p.last_check.checked_at}: {p.last_check.status}{p.last_check.detail ? ` — ${p.last_check.detail}` : ''}</span>}
              </span>
              <span className="actions">
                <Badge>{p.verified ? 'Verified' : p.config_status === 'not_configured' ? 'Not configured' : 'Unverified'}</Badge>
                <button className="btn sm" disabled={p.config_status === 'not_configured'} onClick={() => check(p.id)}>Check</button>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <Dialog open={creating} title="New MCP access token" onClose={() => setCreating(false)}>
        <form onSubmit={create}>
          <div className="form">
            <div className="field full">
              <label htmlFor="t-name">Name (which client uses it)</label>
              <input id="t-name" className="input" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Claude Desktop – laptop" />
            </div>
            <fieldset className="field full" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend style={{ fontSize: 12, marginBottom: 6 }}>Scopes (least privilege)</legend>
              {info.scopes.map((s) => (
                <label key={s} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, padding: '3px 0' }}>
                  <input type="checkbox" checked={scopes.includes(s)} onChange={(e) => setScopes((x) => (e.target.checked ? [...x, s] : x.filter((y) => y !== s)))} /> {s}
                </label>
              ))}
            </fieldset>
            <div className="field">
              <label htmlFor="t-ttl">Expires after (days)</label>
              <input id="t-ttl" className="input" type="number" min={1} max={365} value={ttl} onChange={(e) => setTtl(Number(e.target.value))} />
            </div>
          </div>
          <div className="actions" style={{ justifyContent: 'flex-end', marginTop: 18 }}>
            <button type="button" className="btn" onClick={() => setCreating(false)}>Cancel</button>
            <button type="submit" className="btn primary" disabled={busy || !name.trim() || scopes.length === 0}>{busy ? 'Creating…' : 'Create token'}</button>
          </div>
        </form>
      </Dialog>

      <Dialog open={!!newToken} title="Copy your token now" onClose={() => setNewToken(null)}
        footer={<button className="btn primary" onClick={() => setNewToken(null)}>I have stored it</button>}>
        <p className="notice">This token is shown <strong>only once</strong>. Store it in your MCP client's secret configuration. Do not commit it or paste it anywhere public.</p>
        <pre className="brief" style={{ wordBreak: 'break-all' }}>{newToken}</pre>
        <div className="actions" style={{ marginTop: 10 }}>
          <button className="btn sm" onClick={() => navigator.clipboard.writeText(newToken ?? '').then(() => toast('Copied.')).catch(() => toast('Copy unavailable — select manually.', true))}>Copy token</button>
        </div>
      </Dialog>

      <Dialog open={!!revoke} title="Revoke token?" onClose={() => setRevoke(null)}
        footer={<><button className="btn" onClick={() => setRevoke(null)}>Cancel</button><button className="btn danger" onClick={doRevoke}>Revoke</button></>}>
        <p>“{revoke?.name}” will stop working immediately. This cannot be undone.</p>
      </Dialog>
    </>
  )
}
