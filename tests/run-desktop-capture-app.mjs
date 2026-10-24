/** 用临时数据目录跑「已接线」的统一捕获集成测试（不碰用户本机资料库）。 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const desktop = join(root, 'desktop')
const electron = join(desktop, 'node_modules', 'electron', 'dist',
  process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron')
if (!existsSync(electron)) throw new Error('Install the desktop dependencies before running the capture integration test')
const parent = join(root, 'test-tmp', 'work')
mkdirSync(parent, { recursive: true })
const temporary = mkdtempSync(join(parent, 'capture-app-test-'))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
try {
  // 本机 Chromium 沙箱不可用：electron.exe 不带 --no-sandbox 会 0x80000003 直接退出。
  const result = spawnSync(electron, [desktop, '--no-sandbox', '--selftest',
    '--user-data', join(temporary, 'profile'), '--db', join(temporary, 'capture-app-test.sqlite'),
    '--test-module', join(root, 'tests', 'desktop-capture-app.mjs')],
  { cwd: root, env, windowsHide: true, stdio: 'inherit', timeout: 120000 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Capture integration selftest failed (${result.status ?? result.signal})`)
} finally {
  if (dirname(temporary) !== parent) throw new Error('Unexpected test cleanup path')
  rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
