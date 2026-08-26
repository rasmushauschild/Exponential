// Bundles the MCP server (plus its deps) into one self-contained file for shipping inside the app.
import { build } from 'esbuild';
await build({
  entryPoints: ['mcp/server.mjs'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'mcp/server.bundle.mjs',
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'warning',
});
