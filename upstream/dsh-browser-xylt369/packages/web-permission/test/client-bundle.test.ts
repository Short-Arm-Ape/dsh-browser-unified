import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const clientJs = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')

test('client bundle is the lazy-CJS ModuleLoader factory', (t) => {
  if (!existsSync(clientJs)) {
    t.skip('lib/client.js is produced by pnpm build')
    return
  }
  const source = readFileSync(clientJs, 'utf8')
  assert.match(source, /window\.__ModuleLoader__\.load\(\{ id: "@yeesy369\/dsh-web-permission"/)
  assert.match(source, /factory: \(require\) =>/)
  assert.match(source, /return module\.exports/)
})
