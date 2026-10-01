import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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
  name: 'memory-vault-mistakebook', version: pkg.version, description: 'Memory Vault with a study notebook and AI learning tools',
  type: 'module', main: 'desktop/main.mjs', author: 'Memory Vault contributors',
}, null, 2))
await build({ projectDir: here, config: {
  ...pkg.build, electronVersion: pkg.devDependencies.electron,
  electronDist: join(here, 'node_modules', 'electron', 'dist'),
  directories: { app: runtime, output: join(here, 'dist') }, npmRebuild: false,
  artifactName: 'Memory-Vault-Notebook-${version}-Setup.${ext}',
  win: { target: ['nsis'], icon: join(here, 'assets', 'memory-vault.ico'), signAndEditExecutable: true },
  nsis: { ...pkg.build.nsis, oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, deleteAppDataOnUninstall: false },
}, ...(process.argv.includes('--dir') ? { dir: true } : {}) })
