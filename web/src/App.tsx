import { useEffect, useState, type FormEvent } from 'react'
import { ENTITIES, isEntityKey, type EntityKey } from '../../src/shared/entities'
import { api, setUnauthorizedHandler } from './api'
import { EntityList } from './EntityList'
import { EntityDetail } from './EntityDetail'
import { Overview } from './Overview'
import { ImportExport } from './ImportExport'
import { Settings } from './Settings'
import { Spinner, ToastHost } from './ui'

type Route = { page: 'overview' | 'import' | 'settings' } | { page: 'list'; entity: EntityKey } | { page: 'detail'; entity: EntityKey; id: number } | { page: 'notfound' }

function parseHash(): Route {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean)
  if (parts.length === 0 || parts[0] === 'overview') return { page: 'overview' }
  if (parts[0] === 'import') return { page: 'import' }
  if (parts[0] === 'settings') return { page: 'settings' }
  if (isEntityKey(parts[0])) {
    if (parts[1] && /^\d+$/.test(parts[1])) return { page: 'detail', entity: parts[0], id: Number(parts[1]) }
    return { page: 'list', entity: parts[0] }
  }
  return { page: 'notfound' }
}

const NAV: { group: string; items: { href: string; label: string; ico: string; entity?: EntityKey }[] }[] = [
  { group: 'Workspace', items: [{ href: '#/overview', label: 'Overview', ico: '◎' }] },
  {
    group: 'Research',
    items: [
      { href: '#/niches', label: 'Niches', ico: '◇', entity: 'niches' },
      { href: '#/products', label: 'Products', ico: '▣', entity: 'products' },
      { href: '#/offer_snapshots', label: 'Offer snapshots', ico: '◔', entity: 'offer_snapshots' },
      { href: '#/evidence_sources', label: 'Evidence sources', ico: '❏', entity: 'evidence_sources' },
      { href: '#/observations', label: 'Observations', ico: '◉', entity: 'observations' },
    ],
  },
  {
    group: 'Testing',
    items: [
      { href: '#/experiments', label: 'Experiments', ico: '◷', entity: 'experiments' },
      { href: '#/content_items', label: 'Content studio', ico: '✎', entity: 'content_items' },
      { href: '#/performance_snapshots', label: 'Performance', ico: '▤', entity: 'performance_snapshots' },
      { href: '#/decisions', label: 'Decision log', ico: '⚖', entity: 'decisions' },
    ],
  },
  {
    group: 'System',
    items: [
      { href: '#/import', label: 'Import / export', ico: '⇅' },
      { href: '#/settings', label: 'Settings', ico: '⚙' },
    ],
  },
]

function Login({ configured, onDone }: { configured: boolean; onDone: () => void }) {
  const [pw, setPw] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    try {
      await api('/auth/login', { method: 'POST', json: { password: pw } })
      onDone()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Login failed')
    } finally {
      setBusy(false)
    }
  }
  return (
    <main className="login">
      <div className="panel">
        <div className="wordmark">NALU<span>KESA</span></div>
        <p className="tagline" style={{ marginBottom: 24 }}>Discovery Intelligence · Private workspace</p>
        {!configured ? (
          <p className="notice error" role="alert">
            Owner access is not configured on the server. Set <code>OWNER_PASSWORD</code> and <code>SESSION_SECRET</code> as Cloudflare Pages secrets.
          </p>
        ) : (
          <form onSubmit={submit}>
            <input type="text" name="username" autoComplete="username" value="owner" readOnly hidden aria-hidden="true" />
            <div className="field">
              <label htmlFor="pw">Owner password</label>
              <input id="pw" className="input" type="password" autoComplete="current-password" required value={pw} onChange={(e) => setPw(e.target.value)} autoFocus aria-invalid={!!err} aria-describedby={err ? 'pw-err' : undefined} />
              {err && <span id="pw-err" className="err" role="alert">{err}</span>}
            </div>
            <button type="submit" className="btn primary" style={{ width: '100%', justifyContent: 'center', marginTop: 16 }} disabled={busy || !pw}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
            <p className="muted small" style={{ marginTop: 16, marginBottom: 0 }}>Single-owner private pilot. Session expires after 12 hours.</p>
          </form>
        )}
      </div>
    </main>
  )
}

export function App() {
  const [auth, setAuth] = useState<{ authenticated: boolean; configured: boolean } | null>(null)
  const [route, setRoute] = useState<Route>(parseHash)
  const [menuOpen, setMenuOpen] = useState(false)

  const checkAuth = () => api<{ authenticated: boolean; configured: boolean }>('/auth/me').then(setAuth).catch(() => setAuth({ authenticated: false, configured: true }))
  useEffect(() => {
    checkAuth()
    setUnauthorizedHandler(() => setAuth((a) => (a ? { ...a, authenticated: false } : a)))
    const onHash = () => {
      setRoute(parseHash())
      setMenuOpen(false)
      window.scrollTo(0, 0)
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const title =
    'entity' in route
      ? ENTITIES[route.entity].label
      : ({ overview: 'Overview', import: 'Import / export', settings: 'Settings', notfound: 'Not found' } as const)[route.page]
  useEffect(() => {
    document.title = `${title} — NALUKESA`
  }, [title])

  if (!auth) return <div className="login"><Spinner /></div>
  if (!auth.authenticated) return (<><Login configured={auth.configured} onDone={checkAuth} /><ToastHost /></>)

  const activeHref = route.page === 'list' || route.page === 'detail' ? `#/${route.entity}` : `#/${route.page}`

  async function logout() {
    await api('/auth/logout', { method: 'POST' }).catch(() => {})
    setAuth({ authenticated: false, configured: true })
  }

  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <div className="shell">
        <aside className={`sidebar ${menuOpen ? 'open' : ''}`} aria-label="Primary">
          <div className="brand">
            <div className="wordmark">NALU<span>KESA</span></div>
            <div className="tagline">Discovery Intelligence</div>
          </div>
          <nav aria-label="Main navigation">
            {NAV.map((g) => (
              <div key={g.group} className="navgroup" style={{ marginBottom: 18 }}>
                <p className="navlabel">{g.group}</p>
                {g.items.map((i) => (
                  <a key={i.href} href={i.href} className="navlink" aria-current={activeHref === i.href ? 'page' : undefined} style={{ textDecoration: 'none' }}>
                    <span className="ico" aria-hidden="true">{i.ico}</span>
                    {i.label}
                  </a>
                ))}
              </div>
            ))}
          </nav>
          <div className="sidefoot">
            <span>Private pilot · owner only</span>
            <button className="btn sm" onClick={logout}>Sign out</button>
          </div>
        </aside>
        <div className="main">
          <header className="topbar">
            <div className="actions">
              <button className="btn sm menu-toggle" aria-expanded={menuOpen} aria-label="Toggle navigation" onClick={() => setMenuOpen((x) => !x)}>☰</button>
              <span className="crumb">NALUKESA / {title}</span>
            </div>
            <span className="badge good">Connected · D1</span>
          </header>
          <main id="main" className="content" tabIndex={-1}>
            {route.page === 'overview' && <Overview />}
            {route.page === 'import' && <ImportExport />}
            {route.page === 'settings' && <Settings />}
            {route.page === 'notfound' && <div className="notice">Page not found. <a href="#/overview">Go to overview</a></div>}
            {route.page === 'list' && (
              <>
                <div className="pagehead">
                  <div>
                    <p className="eyebrow">{NAV.find((g) => g.items.some((i) => i.entity === route.entity))?.group}</p>
                    <h1 className="title">{ENTITIES[route.entity].label}</h1>
                    <p className="lede">{ENTITIES[route.entity].description}</p>
                  </div>
                </div>
                <EntityList key={route.entity} entity={route.entity} />
              </>
            )}
            {route.page === 'detail' && <EntityDetail key={`${route.entity}-${route.id}`} entity={route.entity} id={route.id} />}
          </main>
        </div>
      </div>
      <ToastHost />
    </>
  )
}
