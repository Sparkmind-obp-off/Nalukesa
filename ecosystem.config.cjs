module.exports = {
  apps: [
    {
      name: 'nalukesa',
      script: 'npx',
      args: 'wrangler pages dev dist --ip 0.0.0.0 --port 3000',
      env: { NODE_ENV: 'development' },
      watch: false,
      instances: 1,
      exec_mode: 'fork',
    },
    {
      // local-only deterministic mock MCP provider for connector tests
      name: 'mock-mcp',
      script: 'scripts/mock-mcp-server.mjs',
      env: { MOCK_PORT: '8788' },
      watch: false,
      autorestart: false,
    },
  ],
}
