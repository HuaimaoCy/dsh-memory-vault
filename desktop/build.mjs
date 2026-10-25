import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { CORE_VERSION, NOTEBOOK_VERSION, NOTEBOOK_DISPLAY_VERSION } from '../src/version.js'
import { PRODUCTS } from './products.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.json', '.html', '.css', '.svg', '.png', '.ico', '.yml', '.md'])
const NOTEBOOK_RENDERER = new Set(['notebook.html', 'notebook-app.js', 'mistakebook.js', 'mistakebook.css', 'freeform-canvas.js', 'freeform-canvas.css', 'pdf-export.js', 'pdf-export.css', 'papers.js', 'relations.js', 'sidebar.js', 'tags.js', 'markdown.js', 'tex.js'])
const DATABASE_RENDERER = new Set(['index.html', 'app.js', 'grouping.js', 'views.js', 'views.css', 'command-palette.js', 'quick-capture.js', 'quick-capture.css'])

export function parseBuildArguments(args) {
  let kind = 'unified', dir = false, stageOnly = false, corePackage = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--product') kind = args[++i]
    else if (args[i].startsWith('--product=')) kind = args[i].slice('--product='.length)
    else if (args[i] === '--dir') dir = true
    else if (args[i] === '--stage-only') stageOnly = true
    else if (args[i] === '--core-package') corePackage = true
    else throw new Error(`Unknown build argument: ${args[i]}`)
  }
  if (!Object.hasOwn(PRODUCTS, kind)) throw new Error(`Unknown product: ${kind}`)
  if (corePackage && (kind !== 'database' || dir)) throw new Error('--core-package requires --product database and cannot use --dir')
  return { kind, dir, stageOnly, corePackage }
}

function inside(parent, target) {
  const path = relative(resolve(parent), resolve(target))
  return path !== '' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && path !== '..' && !isAbsolute(path)
}

// Every recursive removal is restricted to one generated staging directory.
export function stagingPath(repositoryRoot, stagingParent, kind, prefix = '.runtime') {
  if (!Object.hasOwn(PRODUCTS, kind) || !['.runtime', '.package'].includes(prefix)) throw new Error('Invalid staging product or prefix')
  const parent = resolve(stagingParent)
  if (!inside(repositoryRoot, parent)) throw new Error('Staging parent must be inside the repository')
  const runtime = resolve(parent, kind === 'unified' ? prefix : `${prefix}-${kind}`)
  if (dirname(runtime) !== parent || !inside(repositoryRoot, runtime)) throw new Error('Invalid staging path')
  return runtime
}

function copySource(source, target, include = () => true, prefix = '') {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`Source symlinks cannot be packaged: ${join(source, entry.name)}`)
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (!include(path, entry)) continue
    if (entry.isDirectory()) {
      if (['node_modules', 'test-tmp', '.git', '.connectors', 'dist'].includes(entry.name) || entry.name.startsWith('.runtime') || entry.name.startsWith('.package')) continue
      copySource(join(source, entry.name), join(target, entry.name), include, path)
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
      mkdirSync(target, { recursive: true })
      cpSync(join(source, entry.name), join(target, entry.name))
    }
  }
}

const includeBackend = kind => path => kind !== 'database' || !['notebook_tools.js', 'core/notebook_ops.mjs'].includes(path)

function stageBackend(repositoryRoot, target, kind, { plugin = false } = {}) {
  copySource(join(repositoryRoot, 'src'), join(target, 'src'), includeBackend(kind))
  if (kind !== 'database') copySource(join(repositoryRoot, 'addons'), join(target, 'addons'))
  mkdirSync(target, { recursive: true })
  const entry = kind === 'notebook' && plugin ? 'notebook-plugin.js' : 'index.js'
  cpSync(join(repositoryRoot, entry), join(target, 'index.js'))
  if (!plugin) {
    copySource(join(repositoryRoot, 'bin'), join(target, 'bin'))
    cpSync(join(repositoryRoot, 'client.js'), join(target, 'client.js'))
    cpSync(join(repositoryRoot, 'cordis.patch.yml'), join(target, 'cordis.patch.yml'))
    if (kind === 'notebook') cpSync(join(repositoryRoot, 'notebook-plugin.js'), join(target, 'notebook-plugin.js'))
  } else if (kind !== 'notebook') cpSync(join(repositoryRoot, 'client.js'), join(target, 'client.js'))
}

export function productVersion(kind) {
  return kind === 'database' ? CORE_VERSION : NOTEBOOK_VERSION
}

export function artifactName(kind) {
  const prefix = kind === 'unified' ? 'Alaya' : kind === 'database' ? 'Alaya-Database' : 'Alaya-Notebook'
  return `${prefix}-${kind === 'database' ? CORE_VERSION : NOTEBOOK_DISPLAY_VERSION}-Setup.\${ext}`
}

function readPackages(repositoryRoot) {
  const desktopPackage = JSON.parse(readFileSync(join(repositoryRoot, 'desktop', 'package.json'), 'utf8'))
  const corePackage = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'))
  if (desktopPackage.version !== NOTEBOOK_VERSION) throw new Error(`Notebook version mismatch: desktop ${desktopPackage.version} != ${NOTEBOOK_VERSION}`)
  if (corePackage.version !== CORE_VERSION) throw new Error(`Core version mismatch: root ${corePackage.version} != ${CORE_VERSION}`)
  return { desktopPackage, corePackage }
}

function stageSkills(repositoryRoot, runtime, kind) {
  if (existsSync(join(repositoryRoot, 'skills'))) copySource(join(repositoryRoot, 'skills'), join(runtime, 'skills'), path => kind !== 'database' || !path.startsWith('alaya-notebook'))
}

export function prepareProduct({ kind = 'unified', repositoryRoot = root, stagingParent = join(repositoryRoot, 'desktop') } = {}) {
  const product = PRODUCTS[kind]
  if (!product) throw new Error(`Unknown product: ${kind}`)
  const desktopRoot = join(repositoryRoot, 'desktop')
  const { desktopPackage, corePackage } = readPackages(repositoryRoot)
  const runtime = stagingPath(repositoryRoot, stagingParent, kind)
  rmSync(runtime, { recursive: true, force: true })
  mkdirSync(join(runtime, 'desktop'), { recursive: true })
  stageBackend(repositoryRoot, runtime, kind)
  for (const name of ['main.mjs', 'preload.cjs', 'products.mjs']) cpSync(join(desktopRoot, name), join(runtime, 'desktop', name))
  writeFileSync(join(runtime, 'desktop', 'product.json'), JSON.stringify({ kind }, null, 2) + '\n')
  for (const name of ['lib', 'assets']) copySource(join(desktopRoot, name), join(runtime, 'desktop', name))
  copySource(join(desktopRoot, 'renderer'), join(runtime, 'desktop', 'renderer'), path => {
    if (path === 'glass-lab.html') return false
    if (kind === 'notebook' && DATABASE_RENDERER.has(path)) return false
    if (kind === 'database' && NOTEBOOK_RENDERER.has(path)) return false
    return true
  })
  if (kind === 'database') {
    const htmlPath = join(runtime, 'desktop', 'renderer', 'index.html')
    const html = readFileSync(htmlPath, 'utf8')
      .replace('<html ', '<html data-product="database" ')
      .replace(/\s*<link\b[^>]*href="mistakebook\.css"[^>]*>/g, '')
      .replace(/<button\b[^>]*id="mode-switch"[^>]*>([\s\S]*?)<\/button>/, '<span class="brand-mark" aria-hidden="true">$1</span>')
    writeFileSync(htmlPath, html)
  }
  stageSkills(repositoryRoot, runtime, kind)
  writeFileSync(join(runtime, 'package.json'), JSON.stringify({
    name: product.packageName, version: productVersion(kind), description: product.name,
    type: 'module', main: 'desktop/main.mjs', author: 'Memory Vault contributors',
  }, null, 2) + '\n')
  const plugin = join(runtime, '.dsh-plugin')
  stageBackend(repositoryRoot, plugin, kind, { plugin: true })
  writeFileSync(join(plugin, 'package.json'), JSON.stringify({
    name: kind === 'notebook' ? 'alaya-notebook' : 'dsh-memory-vault', version: productVersion(kind), type: 'module', main: 'index.js',
    peerDependencies: corePackage.peerDependencies, peerDependenciesMeta: corePackage.peerDependenciesMeta,
  }, null, 2) + '\n')
  return { kind, product, runtime, plugin, desktopPackage, desktopRoot, output: join(desktopRoot, 'dist', ...(kind === 'unified' ? [] : [kind])) }
}

export function prepareCorePackage({ repositoryRoot = root, stagingParent = join(repositoryRoot, 'desktop') } = {}) {
  const { corePackage } = readPackages(repositoryRoot)
  const runtime = stagingPath(repositoryRoot, stagingParent, 'database', '.package')
  rmSync(runtime, { recursive: true, force: true })
  stageBackend(repositoryRoot, runtime, 'database')
  stageSkills(repositoryRoot, runtime, 'database')
  for (const name of ['README.md', 'README.zh.md']) if (existsSync(join(repositoryRoot, name))) cpSync(join(repositoryRoot, name), join(runtime, name))
  const files = ['index.js', 'client.js', 'bin', 'src', 'skills', 'cordis.patch.yml', 'README.md', 'README.zh.md']
  writeFileSync(join(runtime, 'package.json'), JSON.stringify({ ...corePackage, scripts: undefined, files }, null, 2) + '\n')
  return { runtime, output: join(repositoryRoot, 'desktop', 'dist', 'database') }
}

export function buildConfiguration(staged) {
  const { kind, product, runtime, plugin, desktopPackage: pkg, desktopRoot, output } = staged
  return {
    ...pkg.build, appId: product.appId, productName: product.name, executableName: product.executable,
    electronVersion: pkg.devDependencies.electron, electronDist: join(desktopRoot, 'node_modules', 'electron', 'dist'),
    directories: { app: runtime, output }, npmRebuild: false,
    files: ['desktop/**', 'src/**', 'bin/**', 'addons/**', 'skills/**', 'index.js', 'notebook-plugin.js', 'client.js', 'cordis.patch.yml', '!**/.dsh-plugin/**'],
    extraResources: [{ from: plugin, to: 'dsh-plugin' }], artifactName: artifactName(kind),
    win: { target: ['nsis'], icon: join(desktopRoot, 'assets', 'memory-vault.ico'), signAndEditExecutable: true },
    nsis: { ...pkg.build.nsis, shortcutName: product.name, oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, deleteAppDataOnUninstall: false },
  }
}

async function main() {
  const options = parseBuildArguments(process.argv.slice(2))
  const staged = options.corePackage ? prepareCorePackage() : prepareProduct(options)
  if (options.stageOnly) { process.stdout.write(`${staged.runtime}\n`); return }
  if (options.corePackage) {
    mkdirSync(staged.output, { recursive: true })
    const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', staged.runtime, '--pack-destination', staged.output, '--ignore-scripts'], { stdio: 'inherit', shell: process.platform === 'win32' })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`npm pack failed: ${result.status}`)
    return
  }
  const { build } = await import('electron-builder')
  // electron-builder 26 loses Windows variables when running its NSIS helper.
  const require = createRequire(import.meta.url)
  const wine = require('app-builder-lib/out/wine.js')
  const originalExecWine = wine.execWine
  if (process.platform === 'win32') {
    wine.execWine = (file, file64 = null, appArgs = [], execOptions = {}) => {
      if (execOptions.env?.__COMPAT_LAYER !== 'RunAsInvoker') return originalExecWine(file, file64, appArgs, execOptions)
      const nsisTemp = join(staged.output, '.nsis-temp')
      mkdirSync(nsisTemp, { recursive: true })
      return originalExecWine(file, file64, appArgs, { ...execOptions, env: { ...process.env, ...execOptions.env, TEMP: nsisTemp, TMP: nsisTemp } })
    }
  }
  try { await build({ projectDir: staged.desktopRoot, config: buildConfiguration(staged), ...(options.dir ? { dir: true } : {}) }) }
  finally { wine.execWine = originalExecWine }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
