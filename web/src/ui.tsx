import { useEffect, useRef, useState, type ReactNode } from 'react'
import { statusTone, isSafeUrl } from './format'
import { api } from './api'
import type { EntityKey } from '../../src/shared/entities'

export function Badge({ children }: { children: string }) {
  return <span className={`badge ${statusTone(children)}`}>{children}</span>
}

export function Unknown({ label = 'Not recorded' }: { label?: string }) {
  return <span className="unknown">{label}</span>
}

/** Renders external links only for http(s) URLs; rel=noopener noreferrer. */
export function SafeLink({ href, children }: { href: string | null | undefined; children?: ReactNode }) {
  if (!href) return <Unknown />
  if (!isSafeUrl(href)) return <span className="unknown">Unsafe URL hidden</span>
  let label: ReactNode = children
  if (!label) {
    try {
      label = new URL(href).hostname.replace(/^www\./, '')
    } catch {
      label = href
    }
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow">
      {label} <span aria-hidden="true">↗</span>
      <span className="sr-only"> (opens in new tab)</span>
    </a>
  )
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <span role="status">
      <span className="spinner" aria-hidden="true" /> <span className="muted small">{label}…</span>
    </span>
  )
}

export function Dialog({ open, title, onClose, children, footer }: { open: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby="dlg-title">
      {open && (
        <>
          <div className="dialoghead">
            <h2 id="dlg-title" className="section">{title}</h2>
            <button className="btn ghost" onClick={onClose} aria-label="Close dialog">✕</button>
          </div>
          <div className="dialogbody">{children}</div>
          {footer && <div className="dialogfoot">{footer}</div>}
        </>
      )}
    </dialog>
  )
}

// ---- Toasts ----
type ToastMsg = { id: number; text: string; error?: boolean }
let pushToast: (t: Omit<ToastMsg, 'id'>) => void = () => {}
export function toast(text: string, error = false) {
  pushToast({ text, error })
}
export function ToastHost() {
  const [items, setItems] = useState<ToastMsg[]>([])
  useEffect(() => {
    pushToast = (t) => {
      const id = Date.now() + Math.random()
      setItems((x) => [...x, { ...t, id }])
      setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), 4200)
    }
  }, [])
  return (
    <div aria-live="polite" aria-atomic="true">
      {items.map((t, i) => (
        <div key={t.id} className={`toast ${t.error ? 'error' : ''}`} style={{ bottom: 20 + i * 56 }} role={t.error ? 'alert' : 'status'}>
          {t.text}
        </div>
      ))}
    </div>
  )
}

// ---- Lookups (id → title) for reference fields ----
const lookupCache = new Map<EntityKey, Promise<{ id: number; title: string }[]>>()
export function invalidateLookup(e: EntityKey) {
  lookupCache.delete(e)
}
export function useLookup(e: EntityKey | undefined) {
  const [items, setItems] = useState<{ id: number; title: string }[] | null>(null)
  useEffect(() => {
    if (!e) return
    let alive = true
    if (!lookupCache.has(e)) {
      lookupCache.set(
        e,
        api<{ items: { id: number; title: string }[] }>(`/lookup/${e}`).then((r) => r.items).catch((err) => {
          lookupCache.delete(e)
          throw err
        }),
      )
    }
    lookupCache.get(e)!.then((x) => alive && setItems(x)).catch(() => alive && setItems([]))
    return () => {
      alive = false
    }
  }, [e])
  return items
}

export function RefLabel({ entity, id }: { entity: EntityKey; id: unknown }) {
  const items = useLookup(entity)
  if (id === null || id === undefined || id === '') return <Unknown label="—" />
  const hit = items?.find((i) => i.id === Number(id))
  return (
    <a href={`#/${entity}/${id}`}>
      {hit ? String(hit.title).slice(0, 60) : `#${id}`}
    </a>
  )
}
