/** Run the real renderer without opening the user's profile or memory vault. */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const desktop = join(root, 'desktop')
const electron = join(desktop, 'node_modules', 'electron', 'dist',
  process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron')
if (!existsSync(electron)) throw new Error('Install the desktop dependencies before running test:palette')
const parent = join(root, 'test-tmp', 'work')
mkdirSync(parent, { recursive: true })
const temporary = mkdtempSync(join(parent, 'palette-'))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
try {
  // --no-sandbox：本机 Chromium 沙箱与作业对象不兼容，electron.exe 直接启动会以
  // 0x80000003 崩溃且零输出；只在测试进程里加，发布的安装包不受影响。
  const result = spawnSync(electron, [desktop, '--no-sandbox', '--selftest',
    '--user-data', join(temporary, 'profile'), '--db', join(temporary, 'palette-test.sqlite'),
    '--test-module', join(root, 'tests', 'desktop-palette.mjs')],
  { cwd: root, env, windowsHide: true, stdio: 'inherit', timeout: 60000 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Palette selftest failed (${result.status ?? result.signal})`)
} finally {
  if (dirname(temporary) !== parent) throw new Error('Unexpected test cleanup path')
  rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
