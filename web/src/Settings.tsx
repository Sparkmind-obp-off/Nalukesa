import { useEffect, useState } from 'react'
import { api } from './api'
import { Badge, Spinner } from './ui'

interface Health { status: string; db: string; auth: string; time: string }
interface Audit { id: number; actor: string; action: string; entity_type: string | null; entity_id: number | null; metadata: string | null; created_at: string }

const INTEGRATIONS = [
  { name: 'Shopee Affiliate', status: 'Not connected', note: 'Manual entry / CSV export from your dashboard. Official API eligibility not verified.' },
  { name: 'TikTok Shop Affiliate', status: 'Not connected', note: 'Manual entry / CSV. Official API access, scopes and terms not verified.' },
  { name: 'AI research assistant', status: 'Disabled', note: 'Not configured. Would require a server-side provider adapter, source-grounded output and human review.' },
  { name: 'Cloudflare Access', status: 'Recommended', note: 'Optional extra layer in front of the whole site (Zero Trust). Configure in the Cloudflare dashboard.' },
]

export function Settings() {
  const [h, setH] = useState<Health | null>(null)
  const [audit, setAudit] = useState<Audit[] | null>(null)
  useEffect(() => {
    api<Health>('/health').then(setH).catch(() => setH(null))
    api<{ items: Audit[] }>('/audit').then((r) => setAudit(r.items)).catch(() => setAudit([]))
  }, [])

  return (
    <>
      <div className="pagehead">
        <div>
          <p className="eyebrow">Settings & guardrails</p>
          <h1 className="title">System status</h1>
          <p className="lede">What is actually connected, and the rules this workspace enforces.</p>
        </div>
      </div>

      <div className="grid k2">
        <section className="panel" aria-labelledby="h-h">
          <h3 id="h-h">Health</h3>
          {!h ? <Spinner /> : (
            <ul className="listplain">
              <li>API <Badge>{h.status}</Badge></li>
              <li>Database (Cloudflare D1) <Badge>{h.db}</Badge></li>
              <li>Owner access <Badge>{h.auth}</Badge></li>
              <li>Checked <span className="mono small">{h.time}</span></li>
            </ul>
          )}
        </section>
        <section className="panel" aria-labelledby="g-h">
          <h3 id="g-h">Enforced guardrails</h3>
          <ul className="small" style={{ paddingLeft: 18, margin: 0, color: 'var(--text-2)' }}>
            <li>Blank metrics are stored as NULL and shown as “Not recorded” — never zero.</li>
            <li>Offer snapshots, performance snapshots and decisions are append-only.</li>
            <li>Advertised commission (offers) is separate from approved commission (performance).</li>
            <li>Content cannot be marked Published with unclear asset rights or missing disclosure.</li>
            <li>Only http(s) URLs are accepted; external links open with noopener.</li>
            <li>Offer checks older than 30 days and sources accessed over 90 days ago are flagged stale.</li>
            <li>No platform credentials, cookies or OTPs are collected. No scraping.</li>
            <li>Every write is recorded in the audit log.</li>
          </ul>
        </section>
      </div>

      <section className="panel" aria-labelledby="i-h">
        <h3 id="i-h">Integrations</h3>
        <ul className="listplain">
          {INTEGRATIONS.map((i) => (
            <li key={i.name}>
              <span>
                <strong style={{ fontWeight: 560 }}>{i.name}</strong>
                <span className="muted small" style={{ display: 'block' }}>{i.note}</span>
              </span>
              <span className={`badge ${i.status === 'Recommended' ? 'warn' : ''}`}>{i.status}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="panel" aria-labelledby="a-h">
        <h3 id="a-h">Audit log (latest 100)</h3>
        {!audit ? <Spinner /> : audit.length === 0 ? <p className="muted">No events yet.</p> : (
          <div className="tablewrap" style={{ maxHeight: 380, overflow: 'auto' }}>
            <table>
              <thead><tr><th scope="col">Time (UTC)</th><th scope="col">Action</th><th scope="col">Entity</th><th scope="col">Details</th></tr></thead>
              <tbody>
                {audit.map((a) => (
                  <tr key={a.id}>
                    <td className="mono small">{a.created_at}</td>
                    <td>{a.action}</td>
                    <td>{a.entity_type ? (a.entity_id ? <a href={`#/${a.entity_type}/${a.entity_id}`}>{a.entity_type} #{a.entity_id}</a> : a.entity_type) : '—'}</td>
                    <td className="small muted">{a.metadata ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  )
}
