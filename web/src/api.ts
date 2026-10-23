export class ApiError extends Error {
  status: number
  details?: { field: string; message: string }[] | unknown
  constructor(status: number, message: string, details?: unknown) {
    super(message)
    this.status = status
    this.details = details as ApiError['details']
  }
}

let onUnauthorized: (() => void) | null = null
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn
}

export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { 'x-nk-client': 'web', ...(init.headers as Record<string, string>) }
  let body = init.body
  if (init.json !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(init.json)
  }
  let res: Response
  try {
    res = await fetch('/api' + path, { ...init, headers, body, credentials: 'same-origin' })
  } catch {
    throw new ApiError(0, 'Network error — check your connection')
  }
  const ct = res.headers.get('content-type') ?? ''
  const data = ct.includes('application/json') ? await res.json().catch(() => null) : await res.text()
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) onUnauthorized?.()
    const d = data as { error?: string; details?: unknown } | null
    throw new ApiError(res.status, d?.error ?? `Request failed (${res.status})`, d?.details)
  }
  return data as T
}

export interface ListResponse<T = Record<string, unknown>> {
  items: T[]
  total: number
  page: number
  limit: number
}
