/**
 * Generic MCP session against ANY standard Streamable-HTTP MCP server.
 * Uses the official SDK Client; every byte goes through guardedFetch.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker'
import { guardedFetch, NetBlocked, NetHttpStatus, NetTimeout, NetTooLarge, type GuardOptions } from './net'

export type FailureKind = 'blocked' | 'timeout' | 'too_large' | 'auth_failed' | 'auth_required' | 'rate_limited' | 'invalid_response' | 'unavailable'

export class ConnectorError extends Error {
  constructor(public kind: FailureKind, message: string, public wwwAuthenticate: string | null = null) {
    super(message)
    this.name = 'ConnectorError'
  }
}

export function classify(e: unknown): ConnectorError {
  let cur: unknown = e
  for (let i = 0; i < 6 && cur; i++) {
    if (cur instanceof ConnectorError) return cur
    if (cur instanceof NetBlocked) return new ConnectorError('blocked', cur.message)
    if (cur instanceof NetTimeout) return new ConnectorError('timeout', 'Timeout')
    if (cur instanceof NetTooLarge) return new ConnectorError('too_large', cur.message)
    if (cur instanceof NetHttpStatus) {
      if (cur.code === 429) return new ConnectorError('rate_limited', 'Remote server rate limited the request')
      return new ConnectorError(cur.code === 401 ? 'auth_required' : 'auth_failed', `Remote server returned HTTP ${cur.code}`, cur.wwwAuthenticate)
    }
    cur = (cur as { cause?: unknown }).cause
  }
  const err = e as Error & { code?: number }
  const msg = String(err?.message ?? e)
  if (/Unexpected token|JSON|parse|Invalid|validation|schema/i.test(msg)) return new ConnectorError('invalid_response', 'Malformed or non-conforming MCP response')
  if (err?.name === 'AbortError') return new ConnectorError('timeout', 'Timeout')
  return new ConnectorError('unavailable', msg.slice(0, 200))
}

export interface SessionInfo {
  serverName: string | null
  serverVersion: string | null
  protocolVersion: string | null
  hasTools: boolean
}

export interface RemoteTool {
  name: string
  title: string | null
  description: string | null
  inputSchema: Record<string, unknown>
  annotations: Record<string, unknown> | null
}

export interface ToolCallOutput {
  isError: boolean
  content: unknown[]
  structuredContent: Record<string, unknown> | null
}

const MAX_TOOLS = 200
const MAX_PAGES = 10

export async function withSession<T>(url: URL, guard: GuardOptions, fn: (c: Client, info: SessionInfo) => Promise<T>): Promise<T> {
  const client = new Client({ name: 'nalukesa-connector', version: '0.4.0' }, { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() })
  const transport = new StreamableHTTPClientTransport(url, { fetch: guardedFetch(guard) })
  // Hard ceiling over the whole operation, independent of per-request deadlines
  let timer: ReturnType<typeof setTimeout> | undefined
  const ceiling = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new NetTimeout()), guard.deadlineMs * 3)
  })
  try {
    await Promise.race([client.connect(transport), ceiling])
    const v = client.getServerVersion()
    const info: SessionInfo = {
      serverName: v?.name ?? null,
      serverVersion: v?.version ?? null,
      protocolVersion: transport.protocolVersion ?? null,
      hasTools: !!client.getServerCapabilities()?.tools,
    }
    return await Promise.race([fn(client, info), ceiling])
  } catch (e) {
    throw classify(e)
  } finally {
    if (timer) clearTimeout(timer)
    await transport.terminateSession().catch(() => {})
    await client.close().catch(() => {})
  }
}

export async function listAllTools(c: Client): Promise<RemoteTool[]> {
  const out: RemoteTool[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await c.listTools(cursor ? { cursor } : undefined)
    for (const t of r.tools) {
      if (out.length >= MAX_TOOLS) break
      if (typeof t.name !== 'string' || !/^[A-Za-z0-9_.\-/]{1,128}$/.test(t.name)) continue
      out.push({
        name: t.name,
        title: (t.title as string | undefined)?.slice(0, 200) ?? (t.annotations?.title as string | undefined)?.slice(0, 200) ?? null,
        description: t.description?.slice(0, 2000) ?? null,
        inputSchema: (t.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
        annotations: (t.annotations as Record<string, unknown> | undefined) ?? null,
      })
    }
    cursor = r.nextCursor
    if (!cursor || out.length >= MAX_TOOLS) break
  }
  return out
}

export async function callRemoteTool(c: Client, name: string, args: Record<string, unknown>): Promise<ToolCallOutput> {
  const r = await c.callTool({ name, arguments: args })
  if (!Array.isArray(r.content)) throw new ConnectorError('invalid_response', 'Tool result has no content array')
  return {
    isError: !!r.isError,
    content: r.content as unknown[],
    structuredContent: (r.structuredContent as Record<string, unknown> | undefined) ?? null,
  }
}
