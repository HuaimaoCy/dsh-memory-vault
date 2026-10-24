/** 用真实 Electron 跑可保存视图的界面测试：独立 profile + 临时数据库，不碰用户数据。 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const desktop = join(root, 'desktop')
const electron = join(desktop, 'node_modules', 'electron', 'dist',
  process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron')
if (!existsSync(electron)) throw new Error('Install the desktop dependencies before running the views test')
const parent = join(root, 'test-tmp', 'work')
mkdirSync(parent, { recursive: true })
const temporary = mkdtempSync(join(parent, 'views-test-'))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
// 额外参数原样透传（例如 `--shots test-tmp/views-shots` 让测试自己落截图）。
// 注意不要传 --shot：主进程那个出口不会建目录，目录由测试模块自己 mkdir。
const passthrough = process.argv.slice(2)
try {
  // --no-sandbox：本机环境里 Chromium 沙箱与作业对象不兼容，不加会直接以 0x80000003 退出。
  // 只在测试进程里这么做，发布的安装包不受影响。
  const result = spawnSync(electron, [desktop, '--no-sandbox', '--selftest', ...passthrough,
    '--user-data', join(temporary, 'profile'), '--db', join(temporary, 'views-test.sqlite'),
    '--test-module', join(root, 'tests', 'desktop-views.mjs')],
  { cwd: root, env, windowsHide: true, stdio: 'inherit', timeout: 180000 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Views selftest failed (${result.status ?? result.signal})`)
} finally {
  if (dirname(temporary) !== parent) throw new Error('Unexpected test cleanup path')
  rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
