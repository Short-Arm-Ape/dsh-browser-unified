/**
 * Reproduce dsh's unpublished `clientBundle` output: a lazy-CJS factory that
 * the web module table loads via `window.__ModuleLoader__.load`.
 *
 * Usage: node scripts/bundle-client.mjs
 * (cwd = the plugin package directory, i.e. this repository root)
 */
import * as esbuild from 'esbuild'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
const pkgDir = process.cwd()
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
if (typeof pkg.name !== 'string' || !pkg.name) {
  throw new Error('bundle-client: package.json is missing name')
}

const id = JSON.stringify(pkg.name)

await esbuild.build({
  absWorkingDir: pkgDir,
  entryPoints: ['src/client/index.ts'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  sourcemap: true,
  sourcesContent: true,
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  external: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
  plugins: [{
    name: 'external-deepseek-ai',
    setup(build) {
      build.onResolve({ filter: /^@deepseek-ai\// }, (args) => ({
        path: args.path,
        external: true,
      }))
    },
  }],
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${id}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;\n`,
  },
  footer: {
    js: '\nreturn module.exports; } });\n',
  },
})
