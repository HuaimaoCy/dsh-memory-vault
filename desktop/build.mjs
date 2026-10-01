import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'electron-builder'
import { VERSION } from '../src/version.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const runtime = join(here, '.runtime')
if (dirname(runtime) !== here) throw new Error('Invalid staging path')
rmSync(runtime, { recursive: true, force: true })
mkdirSync(join(runtime, 'desktop'), { recursive: true })
for (const name of ['src', 'bin', 'addons', 'index.js', 'client.js', 'cordis.patch.yml']) cpSync(join(root, name), join(runtime, name), { recursive: true })
for (const name of ['main.mjs', 'preload.cjs', 'renderer', 'lib', 'assets']) cpSync(join(here, name), join(runtime, 'desktop', name), { recursive: true })
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))
if (pkg.version !== VERSION || JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version !== VERSION) throw new Error('Release versions must match')
writeFileSync(join(runtime, 'package.json'), JSON.stringify({
  name: 'memory-vault-mistakebook', version: pkg.version, description: 'Alaya memory and study notebook',
  type: 'module', main: 'desktop/main.mjs', author: 'Memory Vault contributors',
}, null, 2))
// electron-builder 26 invokes its NSIS uninstaller helper with an environment
// containing only __COMPAT_LAYER. Preserve Windows variables and give that
// helper a known writable temp directory without changing the app's runtime.
const require = createRequire(import.meta.url)
const wine = require('app-builder-lib/out/wine.js')
const originalExecWine = wine.execWine
if (process.platform === 'win32') {
  wine.execWine = (file, file64 = null, appArgs = [], options = {}) => {
    if (options.env?.__COMPAT_LAYER !== 'RunAsInvoker') return originalExecWine(file, file64, appArgs, options)
    const nsisTemp = join(here, 'dist', '.nsis-temp')
    mkdirSync(nsisTemp, { recursive: true })
    return originalExecWine(file, file64, appArgs, {
      ...options, env: { ...process.env, ...options.env, TEMP: nsisTemp, TMP: nsisTemp },
    })
  }
}
try {
await build({ projectDir: here, config: {
  ...pkg.build, electronVersion: pkg.devDependencies.electron,
  electronDist: join(here, 'node_modules', 'electron', 'dist'),
  directories: { app: runtime, output: join(here, 'dist') }, npmRebuild: false,
  artifactName: 'Alaya-${version}-Setup.${ext}',
  win: { target: ['nsis'], icon: join(here, 'assets', 'memory-vault.ico'), signAndEditExecutable: true },
  nsis: { ...pkg.build.nsis, oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, deleteAppDataOnUninstall: false },
}, ...(process.argv.includes('--dir') ? { dir: true } : {}) })
} finally {
  wine.execWine = originalExecWine
}
