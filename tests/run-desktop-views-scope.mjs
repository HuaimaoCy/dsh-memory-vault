/** 用临时库跑「筛选只作用于已加载的一页」的真实界面验证。 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const desktop = join(root, 'desktop')
const electron = join(desktop, 'node_modules', 'electron', 'dist',
  process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron')
if (!existsSync(electron)) throw new Error('Install the desktop dependencies before running the views scope test')
const parent = join(root, 'test-tmp', 'work')
mkdirSync(parent, { recursive: true })
const temporary = mkdtempSync(join(parent, 'views-scope-test-'))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
try {
  const result = spawnSync(electron, [desktop, '--no-sandbox', '--selftest',
    '--user-data', join(temporary, 'profile'), '--db', join(temporary, 'views-scope-test.sqlite'),
    '--test-module', join(root, 'tests', 'desktop-views-scope.mjs')],
  { cwd: root, env, windowsHide: true, stdio: 'inherit', timeout: 180000 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Views scope selftest failed (${result.status ?? result.signal})`)
} finally {
  if (dirname(temporary) !== parent) throw new Error('Unexpected test cleanup path')
  rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
