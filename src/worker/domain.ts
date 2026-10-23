/**
 * Shared, read-oriented domain services used by the MCP server (and available
 * to the web API). All functions:
 *  - use parameterized SQL only,
 *  - return only stored data (no invention),
 *  - keep unknown values as null and say so explicitly.
 */

export const OFFER_STALE_DAYS = 30
export const SOURCE_STALE_DAYS = 90

type DB = D1Database
type Row = Record<string, unknown>

export function daysSince(date: unknown, now = Date.now()): number | null {
  if (typeof date !== 'string' || !date) return null
  const t = new Date(date.slice(0, 10) + 'T00:00:00Z').getTime()
  return Number.isNaN(t) ? null : Math.floor((now - t) / 86400000)
}

export async function recordAudit(db: DB, actor: string, action: string, entity?: string | null, id?: number | null, meta?: Record<string, unknown>) {
  try {
    await db
      .prepare('INSERT INTO audit_events (actor, action, entity_type, entity_id, metadata) VALUES (?,?,?,?,?)')
      .bind(actor, action, entity ?? null, id ?? null, meta ? JSON.stringify(meta).slice(0, 2000) : null)
      .run()
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', msg: 'audit_failed', action, err: String(e).slice(0, 200) }))
  }
}

// ---------------- products ----------------
export interface ProductSearch {
  query?: string
  niche_id?: number
  platform?: string
  status?: string
  limit?: number
}

export async function searchProducts(db: DB, p: ProductSearch) {
  const where: string[] = []
  const binds: unknown[] = []
  if (p.query) {
    const like = '%' + p.query.replace(/[\\%_]/g, (m) => '\\' + m) + '%'
    where.push(`(p.name LIKE ? ESCAPE '\\' OR p.seller LIKE ? ESCAPE '\\' OR p.trust_notes LIKE ? ESCAPE '\\')`)
    binds.push(like, like, like)
  }
  if (p.niche_id) {
    where.push('p.niche_id = ?')
    binds.push(p.niche_id)
  }
  if (p.platform) {
    where.push('p.platform = ?')
    binds.push(p.platform)
  }
  if (p.status) {
    where.push('p.status = ?')
    binds.push(p.status)
  }
  const limit = Math.min(Math.max(p.limit ?? 10, 1), 25)
  const w = where.length ? 'WHERE ' + where.join(' AND ') : ''
  const [rows, total] = await db.batch([
    db
      .prepare(
        `SELECT p.id, p.name, p.platform, p.listing_url, p.seller, p.status, p.checked_at,
                p.niche_id, n.name AS niche_name,
                (SELECT MAX(o.checked_at) FROM offer_snapshots o WHERE o.product_id = p.id) AS last_offer_checked_at
         FROM products p JOIN niches n ON n.id = p.niche_id ${w}
         ORDER BY p.id DESC LIMIT ?`,
      )
      .bind(...binds, limit),
    db.prepare(`SELECT COUNT(*) AS n FROM products p ${w}`).bind(...binds),
  ])
  return {
    total_matching: (total.results[0] as { n: number }).n,
    returned: rows.results.length,
    products: rows.results,
  }
}

export async function getProduct(db: DB, id: number): Promise<Row | null> {
  return db
    .prepare('SELECT p.*, n.name AS niche_name FROM products p JOIN niches n ON n.id = p.niche_id WHERE p.id = ?')
    .bind(id)
    .first<Row>()
}

// ---------------- evidence ----------------
export async function getProductEvidence(db: DB, productId: number, now = Date.now()) {
  const product = await getProduct(db, productId)
  if (!product) return null
  const [obs, offers, nicheObs] = await db.batch<Row>([
    db
      .prepare(
        `SELECT o.id, o.observed_fact, o.interpretation, o.observed_at, o.confidence, o.caveats,
                s.id AS source_id, s.title AS source_title, s.url AS source_url, s.source_type,
                s.publisher, s.accessed_at, s.evidence_grade
         FROM observations o JOIN evidence_sources s ON s.id = o.source_id
         WHERE o.product_id = ? ORDER BY o.observed_at DESC, o.id DESC LIMIT 100`,
      )
      .bind(productId),
    db.prepare('SELECT * FROM offer_snapshots WHERE product_id = ? ORDER BY checked_at DESC, id DESC LIMIT 50').bind(productId),
    db
      .prepare(
        `SELECT o.id, o.observed_fact, o.interpretation, o.observed_at, o.confidence,
                s.title AS source_title, s.url AS source_url, s.evidence_grade, s.accessed_at
         FROM observations o JOIN evidence_sources s ON s.id = o.source_id
         WHERE o.niche_id = ? AND o.product_id IS NULL ORDER BY o.observed_at DESC LIMIT 25`,
      )
      .bind(product.niche_id),
  ])
  const observations = obs.results.map((r) => {
    const age = daysSince(r.accessed_at, now)
    return { ...r, source_age_days: age, source_stale: age !== null && age > SOURCE_STALE_DAYS }
  })
  const offerSnapshots = offers.results.map((r) => {
    const age = daysSince(r.checked_at, now)
    return { ...r, age_days: age, stale: age !== null && age > OFFER_STALE_DAYS }
  })
  const notes: string[] = []
  if (!observations.length) notes.push('No product-level observations recorded.')
  if (!offerSnapshots.length) notes.push('No offer snapshots recorded; price and commission are unknown.')
  if (offerSnapshots[0]?.stale) notes.push(`Latest offer snapshot is older than ${OFFER_STALE_DAYS} days.`)
  notes.push('advertised_commission_pct is the advertised rate only, not earned or approved commission.')
  notes.push('"interpretation" fields are the operator\'s reading, not observed fact.')
  return {
    product,
    observations,
    offer_snapshots: offerSnapshots,
    niche_level_observations: nicheObs.results,
    notes,
  }
}

// ---------------- performance ----------------
const METRICS = ['views', 'clicks', 'orders', 'approved_commission_idr', 'cancellations_returns'] as const

export function summarizeMetrics(rows: Row[]) {
  const totals: Record<string, { sum: number | null; recorded_in: number; of_snapshots: number }> = {}
  for (const m of METRICS) {
    const vals = rows.map((r) => r[m]).filter((v): v is number => typeof v === 'number')
    totals[m] = { sum: vals.length ? vals.reduce((a, b) => a + b, 0) : null, recorded_in: vals.length, of_snapshots: rows.length }
  }
  return totals
}

export interface PerformanceQuery {
  product_id?: number
  content_item_id?: number
  experiment_id?: number
  period_from?: string
  period_to?: string
}

export async function getAffiliatePerformance(db: DB, q: PerformanceQuery) {
  const where: string[] = []
  const binds: unknown[] = []
  if (q.content_item_id) {
    where.push('ps.content_item_id = ?')
    binds.push(q.content_item_id)
  }
  if (q.product_id) {
    where.push('ci.product_id = ?')
    binds.push(q.product_id)
  }
  if (q.experiment_id) {
    where.push('ci.experiment_id = ?')
    binds.push(q.experiment_id)
  }
  if (q.period_from) {
    where.push('ps.period_end >= ?')
    binds.push(q.period_from)
  }
  if (q.period_to) {
    where.push('ps.period_start <= ?')
    binds.push(q.period_to)
  }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : ''
  const r = await db
    .prepare(
      `SELECT ps.*, ci.title AS content_title, ci.channel, ci.product_id, ci.experiment_id
       FROM performance_snapshots ps JOIN content_items ci ON ci.id = ps.content_item_id
       ${w} ORDER BY ps.period_end DESC, ps.id DESC LIMIT 200`,
    )
    .bind(...binds)
    .all<Row>()
  return {
    snapshots: r.results,
    totals: summarizeMetrics(r.results),
    notes: [
      'Only stored snapshots are returned. null means the metric was not recorded — it is not zero.',
      'Totals sum only snapshots where the metric was recorded (see recorded_in).',
      'Views, clicks, orders and approved commission are separate measures; none is inferred from another.',
      ...(r.results.length === 0 ? ['No performance snapshots match this query.'] : []),
    ],
  }
}

// ---------------- comparison ----------------
export async function compareOpportunities(db: DB, productIds: number[], now = Date.now()) {
  const ids = [...new Set(productIds)].slice(0, 10)
  const items = []
  const notFound: number[] = []
  for (const id of ids) {
    const product = await getProduct(db, id)
    if (!product) {
      notFound.push(id)
      continue
    }
    const [offer, ev, perfRows, decision] = await db.batch([
      db.prepare('SELECT * FROM offer_snapshots WHERE product_id = ? ORDER BY checked_at DESC, id DESC LIMIT 1').bind(id),
      db
        .prepare(
          `SELECT s.evidence_grade AS grade, COUNT(*) AS n FROM observations o JOIN evidence_sources s ON s.id = o.source_id
           WHERE o.product_id = ? GROUP BY s.evidence_grade`,
        )
        .bind(id),
      db
        .prepare('SELECT ps.* FROM performance_snapshots ps JOIN content_items ci ON ci.id = ps.content_item_id WHERE ci.product_id = ?')
        .bind(id),
      db
        .prepare(`SELECT decision, decided_at, rationale FROM decisions WHERE entity_type = 'products' AND entity_id = ? ORDER BY decided_at DESC, id DESC LIMIT 1`)
        .bind(id),
    ])
    const o = offer.results[0] as Row | undefined
    const price = typeof o?.price_idr === 'number' ? o.price_idr : null
    const pct = typeof o?.advertised_commission_pct === 'number' ? o.advertised_commission_pct : null
    const age = o ? daysSince(o.checked_at, now) : null
    const grades: Record<string, number> = { A: 0, B: 0, C: 0, D: 0 }
    for (const g of ev.results as { grade: string; n: number }[]) grades[g.grade] = g.n
    const missing: string[] = []
    if (!o) missing.push('offer_snapshot')
    else {
      if (price === null) missing.push('price_idr')
      if (pct === null) missing.push('advertised_commission_pct')
    }
    if (Object.values(grades).every((n) => n === 0)) missing.push('product_observations')
    if (!perfRows.results.length) missing.push('performance_snapshots')
    items.push({
      product_id: id,
      name: product.name,
      niche: product.niche_name,
      platform: product.platform,
      status: product.status,
      latest_offer: o
        ? {
            checked_at: o.checked_at,
            age_days: age,
            stale: age !== null && age > OFFER_STALE_DAYS,
            price_idr: price,
            advertised_commission_pct: pct,
            advertised_commission_per_sale_idr: price !== null && pct !== null ? Math.round((price * pct) / 100) : null,
          }
        : null,
      evidence_by_grade: grades,
      recorded_performance: summarizeMetrics(perfRows.results as Row[]),
      latest_decision: decision.results[0] ?? null,
      missing_fields: missing,
    })
  }
  return {
    items,
    not_found: notFound,
    method:
      'Side-by-side of stored records only. No score or ranking is computed. advertised_commission_per_sale_idr = price × advertised % from the latest snapshot; it is a theoretical advertised figure, not earned or approved commission, and says nothing about demand.',
  }
}
