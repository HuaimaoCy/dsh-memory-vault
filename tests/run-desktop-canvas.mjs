/** 用临时数据目录跑自由画布的真实界面测试（不碰用户的本机资料库）。 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const desktop = join(root, 'desktop')
const electron = join(desktop, 'node_modules', 'electron', 'dist',
  process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron')
if (!existsSync(electron)) throw new Error('Install the desktop dependencies before running the canvas test')
const parent = join(root, 'test-tmp', 'work')
mkdirSync(parent, { recursive: true })
const temporary = mkdtempSync(join(parent, 'canvas-test-'))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
// --shot <输出 png>：把画布截图落在指定目录（验收看图用），不影响默认的纯文本断言。
const shotIndex = process.argv.indexOf('--shot')
const shot = shotIndex > 0 && process.argv[shotIndex + 1] ? ['--shot', resolve(process.argv[shotIndex + 1])] : []
try {
  // 本机 Chromium 沙箱与作业对象不兼容：electron.exe 直接启动会崩（0x80000003），
  // 必须加 --no-sandbox；只在测试进程里这么做，发布的安装包不受影响。
  const result = spawnSync(electron, [desktop, '--no-sandbox', '--selftest', ...shot,
    '--user-data', join(temporary, 'profile'), '--db', join(temporary, 'canvas-test.sqlite'),
    '--test-module', join(root, 'tests', 'desktop-canvas.mjs')],
  { cwd: root, env, windowsHide: true, stdio: 'inherit', timeout: 90000 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Canvas selftest failed (${result.status ?? result.signal})`)
} finally {
  if (dirname(temporary) !== parent) throw new Error('Unexpected test cleanup path')
  rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
