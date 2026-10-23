/**
 * NALUKESA MCP Server (inbound).
 * Official TypeScript SDK, stateless Streamable HTTP (JSON responses) so it
 * runs per-request inside the Cloudflare Pages Worker without Durable Objects.
 * All tools are read-only and call shared domain services — never raw SQL from
 * the client, never filesystem/shell/URL fetch.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker'
import { z } from 'zod'
import { searchProducts, getProductEvidence, compareOpportunities, getAffiliatePerformance, recordAudit } from '../domain'
import { providerStatusReport } from '../hub/registry'
import { PLATFORMS, LANE_STATUS } from '../../shared/entities'
import type { McpScope, TokenRecord } from './tokens'

export const SERVER_INFO = { name: 'nalukesa', version: '0.3.0' }
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
const ID = z.number().int().positive().max(2 ** 31)

export interface ToolDef {
  name: string
  scope: McpScope
  title: string
  description: string
}

export const TOOL_DEFS: ToolDef[] = [
  { name: 'search_products', scope: 'products:read', title: 'Search products', description: 'Search stored NALUKESA product records by text, niche, platform or status. Returns only existing records.' },
  { name: 'get_product_evidence', scope: 'evidence:read', title: 'Get product evidence', description: 'Return stored observations (with source URL, grade, dates, confidence) and dated offer snapshots for one product.' },
  { name: 'compare_opportunities', scope: 'products:read', title: 'Compare opportunities', description: 'Side-by-side comparison of 2–10 stored products. No score is computed; missing fields are listed explicitly.' },
  { name: 'get_affiliate_performance', scope: 'performance:read', title: 'Get affiliate performance', description: 'Return recorded performance snapshots. Unrecorded metrics are null (unknown), never zero, never inferred.' },
  { name: 'get_provider_status', scope: 'providers:read', title: 'Get provider status', description: 'Configuration and last verified check of outbound providers. Never returns secret values.' },
]

type Env = { DB: D1Database } & Record<string, unknown>

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }], structuredContent: data as Record<string, unknown> }
}
function denied(scope: string) {
  return { isError: true, content: [{ type: 'text' as const, text: `Forbidden: token lacks scope "${scope}"` }] }
}
function notFound(msg: string) {
  return { isError: true, content: [{ type: 'text' as const, text: msg }] }
}

export function buildServer(env: Env, token: TokenRecord) {
  const server = new McpServer(SERVER_INFO, {
    capabilities: { tools: {} },
    jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
    instructions:
      'NALUKESA is a private affiliate research workspace. All tools are read-only and return stored records only. null means "not recorded". Do not present advertised commission as earnings, and do not infer sales from views.',
  })
  const has = (s: McpScope) => token.scopes.includes(s)
  const audit = (tool: string, meta: Record<string, unknown> = {}) => recordAudit(env.DB, `mcp:${token.id}`, 'mcp_tool_call', null, null, { tool, ...meta })
  const ro = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  const def = (n: string) => TOOL_DEFS.find((t) => t.name === n)!

  server.registerTool(
    'search_products',
    {
      title: def('search_products').title,
      description: def('search_products').description,
      annotations: ro,
      inputSchema: {
        query: z.string().trim().min(1).max(100).optional(),
        niche_id: ID.optional(),
        platform: z.enum(PLATFORMS).optional(),
        status: z.enum(LANE_STATUS).optional(),
        limit: z.number().int().min(1).max(25).optional(),
      },
    },
    async (args) => {
      if (!has('products:read')) return denied('products:read')
      const r = await searchProducts(env.DB, args)
      await audit('search_products', { returned: r.returned })
      return ok(r)
    },
  )

  server.registerTool(
    'get_product_evidence',
    {
      title: def('get_product_evidence').title,
      description: def('get_product_evidence').description,
      annotations: ro,
      inputSchema: { product_id: ID },
    },
    async ({ product_id }) => {
      if (!has('evidence:read')) return denied('evidence:read')
      const r = await getProductEvidence(env.DB, product_id)
      await audit('get_product_evidence', { product_id, found: !!r })
      return r ? ok(r) : notFound(`Product #${product_id} not found`)
    },
  )

  server.registerTool(
    'compare_opportunities',
    {
      title: def('compare_opportunities').title,
      description: def('compare_opportunities').description,
      annotations: ro,
      inputSchema: { product_ids: z.array(ID).min(2).max(10) },
    },
    async ({ product_ids }) => {
      if (!has('products:read')) return denied('products:read')
      const r = await compareOpportunities(env.DB, product_ids)
      await audit('compare_opportunities', { n: product_ids.length })
      return ok(r)
    },
  )

  server.registerTool(
    'get_affiliate_performance',
    {
      title: def('get_affiliate_performance').title,
      description: def('get_affiliate_performance').description,
      annotations: ro,
      inputSchema: {
        product_id: ID.optional(),
        content_item_id: ID.optional(),
        experiment_id: ID.optional(),
        period_from: DATE.optional(),
        period_to: DATE.optional(),
      },
    },
    async (args) => {
      if (!has('performance:read')) return denied('performance:read')
      const r = await getAffiliatePerformance(env.DB, args)
      await audit('get_affiliate_performance', { returned: r.snapshots.length })
      return ok(r)
    },
  )

  server.registerTool(
    'get_provider_status',
    {
      title: def('get_provider_status').title,
      description: def('get_provider_status').description,
      annotations: ro,
      inputSchema: {},
    },
    async () => {
      if (!has('providers:read')) return denied('providers:read')
      const providers = await providerStatusReport(env.DB, env)
      await audit('get_provider_status')
      return ok({ providers, note: 'config_status "configured" means unverified until last_check.status is "available".' })
    },
  )

  return server
}

/** Handle one MCP HTTP request statelessly. */
export async function handleMcp(req: Request, env: Env, token: TokenRecord, parsedBody: unknown): Promise<Response> {
  const server = buildServer(env, token)
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  await server.connect(transport)
  try {
    return await transport.handleRequest(req, {
      parsedBody,
      authInfo: { token: 'redacted', clientId: `token:${token.id}`, scopes: token.scopes },
    })
  } finally {
    // stateless: close after response is produced (JSON mode resolves fully)
    queueMicrotask(() => {
      transport.close().catch(() => {})
      server.close().catch(() => {})
    })
  }
}
