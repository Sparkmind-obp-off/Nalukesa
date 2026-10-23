import { useCallback, useEffect, useState } from 'react'
import { ENTITIES, type EntityKey } from '../../src/shared/entities'
import { api, type ListResponse } from './api'
import { Cell } from './Cell'
import { EntityForm } from './EntityForm'
import { Dialog, Spinner, useLookup } from './ui'

export const STALE_FIELDS: Record<string, number> = { checked_at: 30, accessed_at: 90 }

function FilterSelect({ entity, field, value, onChange }: { entity: EntityKey; field: string; value: string; onChange: (v: string) => void }) {
  const f = ENTITIES[entity].fields.find((x) => x.key === field)!
  const items = useLookup(f.type === 'ref' ? f.ref : undefined)
  return (
    <label>
      <span className="sr-only">Filter by {f.label}</span>
      <select className="select" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">All {f.label.toLowerCase()}</option>
        {f.type === 'ref'
          ? items?.map((i) => (
              <option key={i.id} value={i.id}>
                #{i.id} · {String(i.title).slice(0, 40)}
              </option>
            ))
          : f.options?.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
      </select>
    </label>
  )
}

export function EntityList({ entity, presetFilters, compact, onChanged }: { entity: EntityKey; presetFilters?: Record<string, string>; compact?: boolean; onChanged?: () => void }) {
  const def = ENTITIES[entity]
  const [q, setQ] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' }>({ key: 'id', dir: 'desc' })
  const [page, setPage] = useState(1)
  const [data, setData] = useState<ListResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 250)
    return () => clearTimeout(t)
  }, [q])
  useEffect(() => setPage(1), [debouncedQ, filters])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const params = new URLSearchParams({ page: String(page), limit: compact ? '20' : '25', sort: sort.key, dir: sort.dir })
    if (debouncedQ) params.set('q', debouncedQ)
    for (const [k, v] of Object.entries({ ...filters, ...presetFilters })) if (v) params.set(k, v)
    try {
      setData(await api<ListResponse>(`/${entity}?${params}`))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [entity, page, sort, debouncedQ, filters, presetFilters, compact])

  useEffect(() => {
    load()
  }, [load, reload])

  const cols = def.fields.filter((f) => f.list && !(presetFilters && f.key in presetFilters))
  const hasQuery = !!debouncedQ || Object.values(filters).some(Boolean)
  const pages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1
  const toggleSort = (key: string) => setSort((s) => ({ key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' }))

  return (
    <section aria-label={def.label}>
      <div className="toolbar">
        {!compact && (
          <>
            <label className="input" style={{ display: 'flex', padding: 0, border: 0, background: 'none' }}>
              <span className="sr-only">Search {def.label}</span>
              <input className="input" style={{ width: '100%' }} type="search" placeholder={`Search ${def.label.toLowerCase()}…`} value={q} onChange={(e) => setQ(e.target.value)} />
            </label>
            {def.filterable
              .filter((f) => !(presetFilters && f in presetFilters))
              .map((f) => (
                <FilterSelect key={f} entity={entity} field={f} value={filters[f] ?? ''} onChange={(v) => setFilters((x) => ({ ...x, [f]: v }))} />
              ))}
          </>
        )}
        <span style={{ flex: 1 }} />
        {!compact && (
          <a className="btn sm" href={`/api/export/${entity}.csv`} download>
            Export CSV
          </a>
        )}
        <button className="btn primary sm" onClick={() => setAdding(true)}>
          + Add {def.singular.toLowerCase()}
        </button>
      </div>

      {error ? (
        <div className="notice error" role="alert">
          {error}{' '}
          <button className="btn sm" onClick={() => setReload((x) => x + 1)}>
            Retry
          </button>
        </div>
      ) : !data && loading ? (
        <div className="panel">
          <Spinner />
        </div>
      ) : data && data.items.length === 0 ? (
        <div className="tablewrap">
          <div className="empty">
            <strong>{hasQuery ? 'No matching records' : `No ${def.label.toLowerCase()} yet`}</strong>
            {hasQuery ? 'Try a different search or clear filters.' : def.description}
          </div>
        </div>
      ) : (
        data && (
          <>
            <div className="tablewrap" aria-busy={loading}>
              <table>
                <caption className="sr-only">
                  {def.label}, {data.total} records
                </caption>
                <thead>
                  <tr>
                    <th scope="col">
                      <button onClick={() => toggleSort('id')} aria-label="Sort by ID">
                        ID {sort.key === 'id' ? (sort.dir === 'asc' ? '↑' : '↓') : ''}
                      </button>
                    </th>
                    {cols.map((f) => (
                      <th scope="col" key={f.key} aria-sort={sort.key === f.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                        <button onClick={() => toggleSort(f.key)}>
                          {f.label} {sort.key === f.key ? (sort.dir === 'asc' ? '↑' : '↓') : ''}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((r) => (
                    <tr key={String(r.id)}>
                      <td className="mono">
                        <a href={`#/${entity}/${r.id}`} aria-label={`Open ${def.singular} ${r.id}`}>
                          #{String(r.id)}
                        </a>
                      </td>
                      {cols.map((f, i) => (
                        <td key={f.key}>
                          {i === 0 && f.key === def.titleField ? (
                            <a href={`#/${entity}/${r.id}`} style={{ color: 'var(--text)' }}>
                              <Cell f={f} value={r[f.key]} />
                            </a>
                          ) : (
                            <Cell f={f} value={r[f.key]} staleDays={STALE_FIELDS[f.key]} />
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="pager">
              <span>
                {data.total} record{data.total === 1 ? '' : 's'}
                {loading && ' · refreshing…'}
              </span>
              {pages > 1 && (
                <span className="actions">
                  <button className="btn sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                    ← Prev
                  </button>
                  <span>
                    Page {page} / {pages}
                  </span>
                  <button className="btn sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
                    Next →
                  </button>
                </span>
              )}
            </div>
          </>
        )
      )}

      <Dialog open={adding} title={`New ${def.singular.toLowerCase()}`} onClose={() => setAdding(false)}>
        <EntityForm
          entity={entity}
          prefill={presetFilters}
          onCancel={() => setAdding(false)}
          onSaved={() => {
            setAdding(false)
            setReload((x) => x + 1)
            onChanged?.()
          }}
        />
      </Dialog>
    </section>
  )
}
