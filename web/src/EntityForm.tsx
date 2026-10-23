import { useState, type FormEvent } from 'react'
import { ENTITIES, EVIDENCE_GRADE_HELP, type EntityKey, type FieldDef } from '../../src/shared/entities'
import { validateEntity } from '../../src/shared/validate'
import { api, ApiError } from './api'
import { useLookup, invalidateLookup, toast } from './ui'

type Values = Record<string, string>

function toFormValues(entity: EntityKey, row?: Record<string, unknown>, prefill?: Record<string, unknown>): Values {
  const v: Values = {}
  for (const f of ENTITIES[entity].fields) {
    const src = row?.[f.key] ?? prefill?.[f.key]
    v[f.key] = src === null || src === undefined ? '' : String(src)
    if (!row && v[f.key] === '' && f.type === 'select' && f.required && f.options) v[f.key] = f.options[0]
  }
  return v
}

function RefSelect({ f, value, onChange, invalid, describedBy }: { f: FieldDef; value: string; onChange: (v: string) => void; invalid: boolean; describedBy?: string }) {
  const items = useLookup(f.ref)
  return (
    <select id={`f-${f.key}`} className="select" value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={invalid} aria-describedby={describedBy} required={f.required}>
      <option value="">{items === null ? 'Loading…' : f.required ? 'Select…' : '— none —'}</option>
      {items?.map((i) => (
        <option key={i.id} value={i.id}>
          #{i.id} · {String(i.title).slice(0, 80)}
        </option>
      ))}
    </select>
  )
}

export function EntityForm({
  entity,
  row,
  prefill,
  onSaved,
  onCancel,
}: {
  entity: EntityKey
  row?: Record<string, unknown>
  prefill?: Record<string, unknown>
  onSaved: (r: Record<string, unknown>) => void
  onCancel: () => void
}) {
  const def = ENTITIES[entity]
  const [values, setValues] = useState<Values>(() => toFormValues(entity, row, prefill))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const set = (k: string, v: string) => setValues((x) => ({ ...x, [k]: v }))

  async function submit(e: FormEvent) {
    e.preventDefault()
    setFormError(null)
    // client-side validation with the same rules as the server
    const local = validateEntity(entity, values, 'create')
    if (!local.ok) {
      setErrors(Object.fromEntries(local.errors.map((x) => [x.field, x.message])))
      setFormError('Please fix the highlighted fields.')
      const first = local.errors[0]?.field
      document.getElementById(`f-${first}`)?.focus()
      return
    }
    setErrors({})
    setBusy(true)
    try {
      const saved = row
        ? await api<Record<string, unknown>>(`/${entity}/${row.id}`, { method: 'PATCH', json: values })
        : await api<Record<string, unknown>>(`/${entity}`, { method: 'POST', json: values })
      invalidateLookup(entity)
      toast(`${def.singular} ${row ? 'updated' : 'saved'}.`)
      onSaved(saved)
    } catch (err) {
      if (err instanceof ApiError && Array.isArray(err.details)) {
        setErrors(Object.fromEntries((err.details as { field: string; message: string }[]).map((x) => [x.field, x.message])))
      }
      setFormError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      {def.appendOnly && !row && (
        <p className="notice info" style={{ marginTop: 0 }}>
          {def.label} are append-only history. Once saved, this record cannot be edited or deleted — add a newer one instead.
        </p>
      )}
      {formError && (
        <p className="notice error" role="alert" style={{ marginTop: 0 }}>
          {formError}
        </p>
      )}
      <div className="form">
        {def.fields.map((f) => {
          const err = errors[f.key]
          const help = f.key === 'evidence_grade' && values[f.key] ? EVIDENCE_GRADE_HELP[values[f.key]] : f.help
          const descId = [help ? `h-${f.key}` : '', err ? `e-${f.key}` : ''].filter(Boolean).join(' ') || undefined
          const common = { id: `f-${f.key}`, 'aria-invalid': !!err, 'aria-describedby': descId, required: f.required }
          const full = f.type === 'textarea' || f.type === 'url'
          return (
            <div key={f.key} className={`field ${full ? 'full' : ''}`}>
              <label htmlFor={`f-${f.key}`}>
                {f.label} {f.required && <span className="req" aria-hidden="true">*</span>}
                {f.required && <span className="sr-only">(required)</span>}
              </label>
              {f.type === 'textarea' ? (
                <textarea className="textarea" {...common} maxLength={f.max} value={values[f.key]} onChange={(e) => set(f.key, e.target.value)} />
              ) : f.type === 'select' ? (
                <select className="select" {...common} value={values[f.key]} onChange={(e) => set(f.key, e.target.value)}>
                  {!f.required && <option value="">— none —</option>}
                  {f.options?.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              ) : f.type === 'ref' ? (
                <RefSelect f={f} value={values[f.key]} onChange={(v) => set(f.key, v)} invalid={!!err} describedBy={descId} />
              ) : (
                <input
                  className="input"
                  {...common}
                  type={f.type === 'date' ? 'date' : f.type === 'url' ? 'url' : 'text'}
                  inputMode={['int', 'money'].includes(f.type) ? 'numeric' : f.type === 'percent' ? 'decimal' : undefined}
                  placeholder={['int', 'money', 'percent'].includes(f.type) ? 'Leave blank if unknown' : f.type === 'url' ? 'https://…' : undefined}
                  maxLength={f.max}
                  value={values[f.key]}
                  onChange={(e) => set(f.key, e.target.value)}
                />
              )}
              {help && <span id={`h-${f.key}`} className="help">{help}</span>}
              {err && <span id={`e-${f.key}`} className="err">{err}</span>}
            </div>
          )
        })}
      </div>
      <div className="actions" style={{ justifyContent: 'flex-end', marginTop: 20 }}>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? 'Saving…' : row ? 'Save changes' : `Save ${def.singular.toLowerCase()}`}
        </button>
      </div>
    </form>
  )
}
