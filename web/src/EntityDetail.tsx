import { useEffect, useState } from 'react'
import { ENTITIES, DECISION_TARGETS, type EntityKey } from '../../src/shared/entities'
import { api, ApiError } from './api'
import { Cell } from './Cell'
import { EntityForm } from './EntityForm'
import { EntityList, STALE_FIELDS } from './EntityList'
import { Dialog, Spinner, toast, invalidateLookup, Badge } from './ui'

/** Related child lists shown on a record's detail page. */
const RELATED: Partial<Record<EntityKey, { entity: EntityKey; fk: string; title: string }[]>> = {
  niches: [
    { entity: 'products', fk: 'niche_id', title: 'Products in this niche' },
    { entity: 'observations', fk: 'niche_id', title: 'Observations' },
    { entity: 'experiments', fk: 'niche_id', title: 'Experiments' },
  ],
  products: [
    { entity: 'offer_snapshots', fk: 'product_id', title: 'Offer history (price & advertised commission)' },
    { entity: 'observations', fk: 'product_id', title: 'Observations' },
    { entity: 'content_items', fk: 'product_id', title: 'Content' },
  ],
  evidence_sources: [{ entity: 'observations', fk: 'source_id', title: 'Observations citing this source' }],
  experiments: [{ entity: 'content_items', fk: 'experiment_id', title: 'Content in this experiment' }],
  content_items: [{ entity: 'performance_snapshots', fk: 'content_item_id', title: 'Performance snapshots' }],
}

function buildBrief(r: Record<string, unknown>): string {
  const v = (k: string, fallback: string) => (r[k] ? String(r[k]) : fallback)
  return [
    'NALUKESA CONTENT BRIEF — DRAFT (human review required)',
    '',
    `Working title: ${v('title', '—')}`,
    `Channel: ${v('channel', '—')}`,
    `Creative angle: ${v('creative_angle', 'NOT SET')}`,
    '',
    `Verified proof point: ${v('proof_point', 'NOT SET — do not publish claims without a verified proof point')}`,
    `Caveats / limitations to state: ${v('caveats', 'None recorded — check before publishing')}`,
    '',
    'Suggested flow:',
    '1) Hook with a real audience problem.',
    '2) Show the product clearly in context.',
    '3) Demonstrate only the verified proof point above.',
    '4) State limitations honestly.',
    `5) CTA: ${v('cta', 'Check current price and details on the listing')}`,
    '',
    `Affiliate disclosure: ${v('disclosure_status', 'Not yet')} — must be clear and visible.`,
    `Asset rights: ${v('asset_rights', 'Unclear')}`,
    '',
    'Rules: no invented personal experience, no fake urgency, no unsupported results.',
  ].join('\n')
}

export function EntityDetail({ entity, id }: { entity: EntityKey; id: number }) {
  const def = ENTITIES[entity]
  const [row, setRow] = useState<Record<string, unknown> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [deciding, setDeciding] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const [v, setV] = useState(0)

  useEffect(() => {
    setRow(null)
    setError(null)
    api<Record<string, unknown>>(`/${entity}/${id}`)
      .then(setRow)
      .catch((e) => setError(e instanceof ApiError && e.status === 404 ? `${def.singular} #${id} not found.` : e.message))
  }, [entity, id, v, def.singular])

  async function remove() {
    try {
      await api(`/${entity}/${id}`, { method: 'DELETE' })
      invalidateLookup(entity)
      toast(`${def.singular} deleted.`)
      location.hash = `#/${entity}`
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Delete failed', true)
      setConfirmDel(false)
    }
  }

  if (error)
    return (
      <div className="notice error" role="alert">
        {error} <a href={`#/${entity}`}>Back to {def.label.toLowerCase()}</a>
      </div>
    )
  if (!row) return <Spinner />

  const title = String(row[def.titleField] ?? `#${id}`)
  const canDecide = (DECISION_TARGETS as readonly string[]).includes(entity)

  return (
    <>
      <nav aria-label="Breadcrumb" className="crumb" style={{ marginBottom: 12 }}>
        <a href={`#/${entity}`}>{def.label}</a> / #{id}
      </nav>
      <div className="pagehead">
        <div>
          <p className="eyebrow">{def.singular}</p>
          <h1 className="title">{title.length > 90 ? title.slice(0, 90) + '…' : title}</h1>
          <p className="muted small">
            Created {String(row.created_at)}
            {row.updated_at ? ` · Updated ${String(row.updated_at)}` : ''}
            {def.appendOnly && ' · Append-only record'}
          </p>
        </div>
        <div className="actions">
          {canDecide && (
            <button className="btn" onClick={() => setDeciding(true)}>
              Log decision
            </button>
          )}
          {!def.appendOnly && (
            <>
              <button className="btn primary" onClick={() => setEditing(true)}>
                Edit
              </button>
              <button className="btn danger" onClick={() => setConfirmDel(true)}>
                Delete
              </button>
            </>
          )}
        </div>
      </div>

      <section className="panel" aria-labelledby="details-h">
        <h2 id="details-h" className="sr-only">
          Details
        </h2>
        <dl className="kv">
          {def.fields.map((f) => (
            <div key={f.key} style={{ display: 'contents' }}>
              <dt>{f.label}</dt>
              <dd>{f.type === 'textarea' && row[f.key] ? String(row[f.key]) : <Cell f={f} value={row[f.key]} staleDays={STALE_FIELDS[f.key]} />}</dd>
            </div>
          ))}
        </dl>
      </section>

      {entity === 'content_items' && <BriefPanel row={row} />}

      {entity === 'decisions' && <DecisionTarget row={row} />}

      {canDecide && (
        <section style={{ marginTop: 28 }}>
          <h2 className="section" style={{ marginBottom: 12 }}>
            Decision history
          </h2>
          <EntityList key={`d-${v}`} entity="decisions" compact presetFilters={{ entity_type: entity, entity_id: String(id) }} />
        </section>
      )}

      {RELATED[entity]?.map((r) => (
        <section key={r.entity + r.fk} style={{ marginTop: 28 }}>
          <h2 className="section" style={{ marginBottom: 12 }}>
            {r.title}
          </h2>
          <EntityList entity={r.entity} compact presetFilters={{ [r.fk]: String(id) }} />
        </section>
      ))}

      <Dialog open={editing} title={`Edit ${def.singular.toLowerCase()}`} onClose={() => setEditing(false)}>
        <EntityForm
          entity={entity}
          row={row}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false)
            setV((x) => x + 1)
          }}
        />
      </Dialog>
      <Dialog open={deciding} title="Log decision" onClose={() => setDeciding(false)}>
        <EntityForm
          entity="decisions"
          prefill={{ entity_type: entity, entity_id: id, decided_at: new Date().toISOString().slice(0, 10) }}
          onCancel={() => setDeciding(false)}
          onSaved={() => {
            setDeciding(false)
            setV((x) => x + 1)
          }}
        />
      </Dialog>
      <Dialog
        open={confirmDel}
        title={`Delete ${def.singular.toLowerCase()}?`}
        onClose={() => setConfirmDel(false)}
        footer={
          <>
            <button className="btn" onClick={() => setConfirmDel(false)}>
              Cancel
            </button>
            <button className="btn danger" onClick={remove}>
              Delete permanently
            </button>
          </>
        }
      >
        <p>
          “{title.slice(0, 80)}” will be permanently removed. Records that depend on it must be removed first. This action is written to the audit log.
        </p>
      </Dialog>
    </>
  )
}

function DecisionTarget({ row }: { row: Record<string, unknown> }) {
  const t = String(row.entity_type)
  return (
    <p className="notice info" style={{ marginTop: 16 }}>
      Applies to <a href={`#/${t}/${row.entity_id}`}>{ENTITIES[t as EntityKey]?.singular ?? t} #{String(row.entity_id)}</a> · Decision <Badge>{String(row.decision)}</Badge>
    </p>
  )
}

function BriefPanel({ row }: { row: Record<string, unknown> }) {
  const text = buildBrief(row)
  const missing = ['proof_point', 'creative_angle'].filter((k) => !row[k])
  return (
    <section className="panel" style={{ marginTop: 16 }} aria-labelledby="brief-h">
      <div className="pagehead" style={{ marginBottom: 12 }}>
        <div>
          <h2 id="brief-h" className="section">
            Content brief (draft)
          </h2>
          <p className="muted small" style={{ margin: 0 }}>
            Generated only from the fields above. No AI, no invented claims.
          </p>
        </div>
        <button
          className="btn sm"
          onClick={() =>
            navigator.clipboard
              .writeText(text)
              .then(() => toast('Brief copied.'))
              .catch(() => toast('Copy unavailable — select the text manually.', true))
          }
        >
          Copy brief
        </button>
      </div>
      {missing.length > 0 && (
        <p className="notice" style={{ marginTop: 0 }}>
          Missing: {missing.join(', ').replace(/_/g, ' ')}. Fill these before using the brief.
        </p>
      )}
      <pre className="brief">{text}</pre>
    </section>
  )
}
