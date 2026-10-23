import type { FieldDef } from '../../src/shared/entities'
import { fmtIdr, fmtNum, daysSince } from './format'
import { Badge, RefLabel, SafeLink, Unknown } from './ui'

export function Cell({ f, value, staleDays }: { f: FieldDef; value: unknown; staleDays?: number }) {
  if (value === null || value === undefined || value === '') {
    return f.type === 'ref' ? <Unknown label="—" /> : <Unknown />
  }
  switch (f.type) {
    case 'ref':
      return <RefLabel entity={f.ref!} id={value} />
    case 'url':
      return <SafeLink href={String(value)} />
    case 'select':
      return <Badge>{String(value)}</Badge>
    case 'money':
      return <span className="mono">{fmtIdr(value)}</span>
    case 'int':
      return <span className="mono">{fmtNum(value)}</span>
    case 'percent':
      return <span className="mono">{String(value)}%</span>
    case 'date': {
      const d = daysSince(String(value))
      const stale = staleDays !== undefined && d !== null && d > staleDays
      return (
        <span className="mono">
          {String(value)}
          {stale && (
            <>
              {' '}
              <span className="badge warn" title={`Older than ${staleDays} days`}>
                Stale · {d}d
              </span>
            </>
          )}
        </span>
      )
    }
    case 'textarea':
      return <span className="clamp">{String(value)}</span>
    default:
      return <>{String(value)}</>
  }
}
