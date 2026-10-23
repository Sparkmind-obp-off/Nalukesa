// Bundles the Hono API + MCP server into dist/_worker.js (Cloudflare Pages advanced mode)
import { build } from 'esbuild'
import { writeFileSync } from 'node:fs'

// The MCP SDK statically imports an Ajv-based validator as a default. Ajv compiles
// schemas with `new Function`, which the Workers runtime forbids. We always pass
// CfWorkerJsonSchemaValidator explicitly, so the Ajv provider is replaced by a stub.
const stubAjv = {
  name: 'stub-ajv-provider',
  setup(b) {
    b.onResolve({ filter: /validation\/ajv-provider\.js$/ }, () => ({ path: 'ajv-stub', namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: `export class AjvJsonSchemaValidator { constructor(){} getValidator(){ throw new Error('Ajv is not available in Workers; use CfWorkerJsonSchemaValidator') } }`,
      loader: 'js',
    }))
  },
}

const result = await build({
  entryPoints: ['src/worker/index.ts'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'browser',
  conditions: ['workerd', 'worker', 'browser', 'import'],
  mainFields: ['module', 'main'],
  minify: true,
  metafile: true,
  plugins: [stubAjv],
  outfile: 'dist/_worker.js',
  logLevel: 'info',
})
const inputs = Object.keys(result.metafile.inputs)
if (inputs.some((p) => /node_modules\/ajv\//.test(p))) throw new Error('Ajv leaked into the Worker bundle')
// Only /api/* and /mcp invoke the Worker; everything else is static (SPA fallback by Pages).
writeFileSync('dist/_routes.json', JSON.stringify({ version: 1, include: ['/api/*', '/mcp'], exclude: [] }, null, 2))
console.log('wrote dist/_routes.json')
