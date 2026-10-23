import { useEffect, useState } from 'react'
import { ENTITIES, LANE_STATUS, type EntityKey } from '../../src/shared/entities'
import { api } from './api'
import { fmtIdr, fmtNum } from './format'
import { Badge, Spinner, Unknown } from './ui'

interface OverviewData {
  counts: Record<string, number>
  nichesByStatus: { status: string; n: number }[]
  staleProducts: { id: number; name: string; last_checked: string | null }[]
  staleDays: number
  dueReviews: { entity: EntityKey; id: number; title: string; due: string }[]
  experimentsWithoutDecision: { id: number; name: string; status: string }[]
  publishedWithoutPerformance: { id: number; title: string }[]
  recentDecisions: Record<string, unknown>[]
  performance: {
    snapshots: number
    clicks: number | null
    clicks_recorded: number
    orders: number | null
    orders_recorded: number
    approved_commission_idr: number | null
    commission_recorded: number
  }
}

const WORKFLOW: { entity: EntityKey; label: string; hint: string }[] = [
  { entity: 'niches', label: 'Register a niche hypothesis', hint: 'Audience, problem, confidence' },
  { entity: 'evidence_sources', label: 'Add an evidence source', hint: 'URL, accessed date, grade A–D' },
  { entity: 'products', label: 'Add a product listing', hint: 'Exact URL, seller, checked date' },
  { entity: 'offer_snapshots', label: 'Record an offer snapshot', hint: 'Price & advertised commission, dated' },
  { entity: 'observations', label: 'Log observations', hint: 'Fact vs interpretation, linked to source' },
  { entity: 'experiments', label: 'Plan a bounded experiment', hint: 'Decision rule before launch' },
  { entity: 'content_items', label: 'Draft content', hint: 'Verified proof point, disclosure, rights' },
  { entity: 'performance_snapshots', label: 'Record real performance', hint: 'Blank = not recorded' },
  { entity: 'decisions', label: 'Log a decision', hint: 'Scale / iterate / hold / stop' },
]

export function Overview() {
  const [d, setD] = useState<OverviewData | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api<OverviewData>('/overview').then(setD).catch((e) => setError(e.message))
  }, [])

  if (error) return <div className="notice error" role="alert">{error}</div>
  if (!d) return <Spinner />

  const isEmpty = Object.values(d.counts).every((n) => n === 0)
  const p = d.performance
  const nextStep = WORKFLOW.find((w) => d.counts[w.entity] === 0)
  const statusMap = Object.fromEntries(d.nichesByStatus.map((s) => [s.status, s.n]))

  return (
    <>
      <div className="pagehead">
        <div>
          <p className="eyebrow">Portfolio overview</p>
          <h1 className="title">Discover evidence. Test deliberately. Scale what earns it.</h1>
          <p className="lede">Every number on this page is computed from records you have stored. Nothing is estimated or sampled.</p>
        </div>
        {nextStep && (
          <a className="btn primary" href={`#/${nextStep.entity}`}>
            Next: {nextStep.label} →
          </a>
        )}
      </div>

      {isEmpty && (
        <div className="notice" style={{ marginBottom: 20 }}>
          <strong>Workspace is empty.</strong> This is the honest starting point — no demand, sales, or commission has been recorded yet. Follow the workflow below; the
          three initial lanes (Beauty & personal care, Everyday fashion, Useful home goods) are hypotheses to register and test, not proven winners.
        </div>
      )}

      <div className="grid k4">
        <div className="stat">
          <div className="label">Niches</div>
          <div className="value">{d.counts.niches}</div>
          <div className="note">{statusMap['Testing'] ?? 0} testing · {statusMap['Scale candidate'] ?? 0} scale candidates</div>
        </div>
        <div className="stat">
          <div className="label">Products researched</div>
          <div className="value">{d.counts.products}</div>
          <div className="note">{d.counts.offer_snapshots} offer snapshots</div>
        </div>
        <div className="stat">
          <div className="label">Evidence</div>
          <div className="value">{d.counts.evidence_sources}</div>
          <div className="note">{d.counts.observations} observations</div>
        </div>
        <div className="stat">
          <div className="label">Experiments</div>
          <div className="value">{d.counts.experiments}</div>
          <div className="note">{d.counts.content_items} content items</div>
        </div>
      </div>

      <section className="panel" style={{ marginTop: 16 }} aria-labelledby="perf-h">
        <h3 id="perf-h">Recorded outcomes (all time)</h3>
        <p className="muted small" style={{ marginTop: 0 }}>
          Summed only across snapshots where the metric was actually recorded. Views, clicks, orders and approved commission are separate measures.
        </p>
        {p.snapshots === 0 ? (
          <p className="muted">No performance snapshots recorded yet. Approved earnings: <Unknown /></p>
        ) : (
          <div className="grid k3">
            <div>
              <div className="muted small">Clicks</div>
              <div className="mono" style={{ fontSize: 20 }}>{p.clicks_recorded ? fmtNum(p.clicks) : <Unknown />}</div>
              <div className="muted small">from {p.clicks_recorded} of {p.snapshots} snapshots</div>
            </div>
            <div>
              <div className="muted small">Orders</div>
              <div className="mono" style={{ fontSize: 20 }}>{p.orders_recorded ? fmtNum(p.orders) : <Unknown />}</div>
              <div className="muted small">from {p.orders_recorded} of {p.snapshots} snapshots</div>
            </div>
            <div>
              <div className="muted small">Approved commission</div>
              <div className="mono" style={{ fontSize: 20 }}>{p.commission_recorded ? fmtIdr(p.approved_commission_idr) : <Unknown />}</div>
              <div className="muted small">from {p.commission_recorded} of {p.snapshots} snapshots</div>
            </div>
          </div>
        )}
      </section>

      <div className="grid k2" style={{ marginTop: 16 }}>
        <section className="panel" aria-labelledby="actions-h">
          <h3 id="actions-h">Needs attention</h3>
          <p className="muted small" style={{ marginTop: 0 }}>Derived from your data.</p>
          <ul className="listplain">
            {d.staleProducts.map((s) => (
              <li key={'s' + s.id}>
                <a href={`#/products/${s.id}`}>{s.name}</a>
                <span className="badge warn">{s.last_checked ? `Offer checked ${s.last_checked}` : 'No offer snapshot'}</span>
              </li>
            ))}
            {d.dueReviews.map((r) => (
              <li key={r.entity + r.id}>
                <a href={`#/${r.entity}/${r.id}`}>{r.title}</a>
                <span className="badge warn">Review {r.due}</span>
              </li>
            ))}
            {d.experimentsWithoutDecision.map((e) => (
              <li key={'e' + e.id}>
                <a href={`#/experiments/${e.id}`}>{e.name}</a>
                <span className="badge">{e.status} · no decision</span>
              </li>
            ))}
            {d.publishedWithoutPerformance.map((c) => (
              <li key={'c' + c.id}>
                <a href={`#/content_items/${c.id}`}>{c.title}</a>
                <span className="badge">Published · no performance</span>
              </li>
            ))}
            {!d.staleProducts.length && !d.dueReviews.length && !d.experimentsWithoutDecision.length && !d.publishedWithoutPerformance.length && (
              <li className="muted">Nothing flagged right now.</li>
            )}
          </ul>
        </section>

        <section className="panel" aria-labelledby="wf-h">
          <h3 id="wf-h">Research workflow</h3>
          <p className="muted small" style={{ marginTop: 0 }}>Smallest complete loop, in order.</p>
          <ol className="steps">
            {WORKFLOW.map((w) => (
              <li key={w.entity}>
                <span>
                  <a href={`#/${w.entity}`}>{w.label}</a>
                  <span className="muted small" style={{ display: 'block' }}>{w.hint}</span>
                </span>
                {d.counts[w.entity] > 0 ? <span className="badge good">{d.counts[w.entity]} recorded</span> : <span className="badge">Not started</span>}
              </li>
            ))}
          </ol>
        </section>
      </div>

      <div className="grid k2" style={{ marginTop: 16 }}>
        <section className="panel" aria-labelledby="ns-h">
          <h3 id="ns-h">Niches by status</h3>
          <ul className="listplain">
            {LANE_STATUS.map((s) => (
              <li key={s}>
                <Badge>{s}</Badge>
                <span className="mono">{statusMap[s] ?? 0}</span>
              </li>
            ))}
          </ul>
        </section>
        <section className="panel" aria-labelledby="rd-h">
          <h3 id="rd-h">Recent decisions</h3>
          {d.recentDecisions.length === 0 ? (
            <p className="muted">No decisions logged yet.</p>
          ) : (
            <ul className="listplain">
              {d.recentDecisions.map((r) => (
                <li key={String(r.id)}>
                  <span>
                    <a href={`#/decisions/${r.id}`}>{ENTITIES[r.entity_type as EntityKey]?.singular ?? String(r.entity_type)} #{String(r.entity_id)}</a>
                    <span className="muted small" style={{ display: 'block' }}>{String(r.decided_at)}</span>
                  </span>
                  <Badge>{String(r.decision)}</Badge>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  )
}
