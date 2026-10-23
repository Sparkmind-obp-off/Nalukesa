// Bundles the Hono API into dist/_worker.js (Cloudflare Pages advanced mode)
import { build } from 'esbuild'
import { writeFileSync } from 'node:fs'

await build({
  entryPoints: ['src/worker/index.ts'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'neutral',
  minify: true,
  outfile: 'dist/_worker.js',
  logLevel: 'info',
})
// Only /api/* invokes the Worker; everything else is static (SPA fallback by Pages).
writeFileSync('dist/_routes.json', JSON.stringify({ version: 1, include: ['/api/*'], exclude: [] }, null, 2))
console.log('wrote dist/_routes.json')
