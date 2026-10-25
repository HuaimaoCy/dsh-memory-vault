import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const parent = join(root, 'test-tmp/work')
mkdirSync(parent, { recursive: true })
const temporary = mkdtempSync(join(parent, 'liquid-glass-'))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
try {
  const result = spawnSync(join(root, 'desktop/node_modules/electron/dist/electron.exe'), [
    join(root, 'desktop'), '--no-sandbox', '--selftest',
    '--user-data', join(temporary, 'profile'), '--db', join(temporary, 'liquid-glass-test.sqlite'),
    '--test-module', join(root, 'tests/desktop-liquid-glass.mjs'), ...process.argv.slice(2),
  ], { cwd: root, env, windowsHide: true, stdio: 'inherit', timeout: 90000 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Liquid Glass desktop selftest failed (${result.status ?? result.signal})`)
} finally {
  if (resolve(temporary).startsWith(resolve(parent) + '\\')) rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
