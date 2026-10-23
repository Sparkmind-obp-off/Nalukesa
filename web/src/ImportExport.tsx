import { useState } from 'react'
import { ENTITIES, ENTITY_KEYS, type EntityKey } from '../../src/shared/entities'
import { toCsv } from '../../src/shared/csv'
import { api, ApiError } from './api'
import { toast, invalidateLookup } from './ui'

interface Report {
  header: string[]
  used: string[]
  ignored: string[]
  missingRequired: string[]
  reports: { line: number; ok: boolean; errors: { field: string; message: string }[]; value?: Record<string, unknown> }[]
  total: number
  valid: number
  invalid: number
}

const MAX_BYTES = 1024 * 1024

export function ImportExport() {
  const importable = ENTITY_KEYS.filter((k) => ENTITIES[k].csvImport)
  const [entity, setEntity] = useState<EntityKey>('niches')
  const [text, setText] = useState('')
  const [fileName, setFileName] = useState('')
  const [report, setReport] = useState<Report | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  function template() {
    const cols = ENTITIES[entity].fields.map((f) => f.key)
    const blob = new Blob([toCsv(cols, [])], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `nalukesa-${entity}-template.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  async function onFile(f: File | undefined) {
    setReport(null)
    setError(null)
    if (!f) return
    if (f.size > MAX_BYTES) return setError('File is larger than 1 MB.')
    setFileName(f.name)
    setText(await f.text())
  }

  async function validate() {
    setBusy(true)
    setError(null)
    setReport(null)
    try {
      setReport(await api<Report>(`/import/${entity}/validate`, { method: 'POST', body: text, headers: { 'Content-Type': 'text/csv' } }))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Validation failed')
    } finally {
      setBusy(false)
    }
  }

  async function commit() {
    if (!report || report.invalid > 0) return
    if (!confirm(`Import ${report.valid} ${ENTITIES[entity].label.toLowerCase()} rows? This writes to the database.`)) return
    setBusy(true)
    try {
      const r = await api<{ imported: number }>(`/import/${entity}/commit`, { method: 'POST', body: text, headers: { 'Content-Type': 'text/csv' } })
      invalidateLookup(entity)
      toast(`Imported ${r.imported} rows.`)
      setReport(null)
      setText('')
      setFileName('')
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Import failed')
    } finally {
      setBusy(false)
    }
  }

  const def = ENTITIES[entity]
  return (
    <>
      <div className="pagehead">
        <div>
          <p className="eyebrow">Data transfer</p>
          <h1 className="title">Import & export</h1>
          <p className="lede">CSV first. Imports are validated row-by-row and only written after you confirm. If any row is invalid, nothing is imported.</p>
        </div>
      </div>

      <section className="panel" aria-labelledby="exp-h">
        <h3 id="exp-h">Export</h3>
        <p className="muted small" style={{ marginTop: 0 }}>All columns are exported, including IDs and timestamps. Blank cells mean “not recorded”.</p>
        <div className="actions">
          {ENTITY_KEYS.map((k) => (
            <a key={k} className="btn sm" href={`/api/export/${k}.csv`} download>
              {ENTITIES[k].label}.csv
            </a>
          ))}
        </div>
      </section>

      <section className="panel" aria-labelledby="imp-h">
        <h3 id="imp-h">Import</h3>
        <div className="form" style={{ marginTop: 12 }}>
          <div className="field">
            <label htmlFor="imp-entity">Target</label>
            <select id="imp-entity" className="select" value={entity} onChange={(e) => { setEntity(e.target.value as EntityKey); setReport(null) }}>
              {importable.map((k) => (
                <option key={k} value={k}>{ENTITIES[k].label}</option>
              ))}
            </select>
            <span className="help">
              Columns: {def.fields.map((f) => f.key + (f.required ? '*' : '')).join(', ')}. Reference columns (…_id) take the numeric ID of an existing record.
            </span>
          </div>
          <div className="field">
            <label htmlFor="imp-file">CSV file (max 1 MB, 500 rows)</label>
            <input id="imp-file" className="input" type="file" accept=".csv,text/csv" onChange={(e) => onFile(e.target.files?.[0])} />
            <span className="help">{fileName ? `Loaded: ${fileName}` : 'UTF-8, header row required.'}</span>
          </div>
        </div>
        <div className="actions" style={{ marginTop: 14 }}>
          <button className="btn sm" onClick={template}>Download blank template</button>
          <span style={{ flex: 1 }} />
          <button className="btn" disabled={!text || busy} onClick={validate}>{busy ? 'Working…' : 'Validate & preview'}</button>
          <button className="btn primary" disabled={!report || report.invalid > 0 || report.valid === 0 || busy} onClick={commit}>
            Import {report?.valid ?? 0} rows
          </button>
        </div>
        {error && <p className="notice error" role="alert">{error}</p>}
      </section>

      {report && (
        <section className="panel" aria-labelledby="rep-h" aria-live="polite">
          <h3 id="rep-h">Preview</h3>
          <p className="small">
            <span className="badge good">{report.valid} valid</span> <span className={`badge ${report.invalid ? 'bad' : ''}`}>{report.invalid} invalid</span>{' '}
            <span className="muted">of {report.total} rows</span>
          </p>
          {report.missingRequired.length > 0 && <p className="notice error">Missing required columns: {report.missingRequired.join(', ')}</p>}
          {report.ignored.length > 0 && <p className="notice">Ignored columns (not part of schema): {report.ignored.join(', ')}</p>}
          <div className="tablewrap" style={{ marginTop: 12, maxHeight: 420, overflow: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th scope="col">Line</th>
                  <th scope="col">Status</th>
                  {report.used.map((c) => <th key={c} scope="col">{c}</th>)}
                </tr>
              </thead>
              <tbody>
                {report.reports.slice(0, 200).map((r) => (
                  <tr key={r.line}>
                    <td className="mono">{r.line}</td>
                    <td>
                      {r.ok ? <span className="badge good">OK</span> : (
                        <>
                          <span className="badge bad">Error</span>
                          <ul className="small" style={{ margin: '6px 0 0', paddingLeft: 16, color: 'var(--red)' }}>
                            {r.errors.map((e, i) => <li key={i}>{e.field}: {e.message}</li>)}
                          </ul>
                        </>
                      )}
                    </td>
                    {report.used.map((c) => (
                      <td key={c}>{r.value ? (r.value[c] === null ? <span className="unknown">null</span> : String(r.value[c])) : ''}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  )
}
