import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUpdateChecker, compareVersions, fetchUpdate, parseRelease, updateUrl } from '../src/updates.js'
import { createDesktopUpdater } from '../desktop/lib/updates.mjs'
import { writeReleaseManifest } from '../desktop/lib/release.mjs'
import { createMemoryVault } from '../src/core/vault.js'
import { operateVault } from '../src/core/ops.js'
import { runCli as cli } from '../bin/memory-vault.mjs'
import { VERSION } from '../src/version.js'

const dir = await mkdtemp(join(tmpdir(), 'vault-updates-'))
const binary = Buffer.alloc(65536, 42)
const sha256 = createHash('sha256').update(binary).digest('hex')
let manifest, hits = 0, mode = 'normal'
const server = createServer((req, res) => {
  if (req.url === '/latest.json') { hits++; res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(manifest)) }
  if (req.url === '/missing') { res.writeHead(404); return res.end() }
  if (req.url === '/bad') return res.end('{bad')
  if (req.url === '/large') return res.end(' '.repeat(1024 * 1024 + 1))
  if (req.url === '/slow') { const timer = setTimeout(() => res.end(JSON.stringify(manifest)), 500); res.on('close', () => clearTimeout(timer)); return }
  if (req.url === '/redirect') { res.writeHead(302, { location: '/latest.json' }); return res.end() }
  if (req.url === '/installer.exe') {
    if (mode === 'wrong') return res.end(Buffer.alloc(binary.length, 2))
    if (mode === 'short') return res.end(binary.subarray(0, 16))
    if (mode === 'excess') return res.end(Buffer.alloc(binary.length + 1))
    if (mode === 'slow') {
      res.write(binary.subarray(0, 4096))
      const timer = setTimeout(() => res.end(binary.subarray(4096)), 1000)
      res.on('close', () => clearTimeout(timer)); return
    }
    return res.end(binary)
  }
  res.writeHead(404); res.end()
})
server.listen(0, '127.0.0.1'); await once(server, 'listening')
const base = `http://127.0.0.1:${server.address().port}`
manifest = { schemaVersion: 1, product: 'memory-vault', channel: 'stable', version: '0.6.3', notes: '测试更新\n中文说明', releaseUrl: `${base}/release`, assets: { 'win32-x64': { url: `${base}/installer.exe`, size: binary.length, sha256 } } }
const checker = createUpdateChecker({ currentVersion: '0.6.2', feedUrl: `${base}/latest.json`, platform: 'win32-x64' })
const pushed = []
const updater = createDesktopUpdater({ currentVersion: '0.6.2', cacheDir: join(dir, 'downloads'), settings: { feedUrl: `${base}/latest.json` }, platform: 'win32-x64', onChange: state => pushed.push(state) })
try {
  assert.equal(compareVersions('0.10.0', '0.9.99'), 1)
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1)
  assert.equal(compareVersions('0.6.2', '0.6.2'), 0)
  assert.throws(() => compareVersions('v0.6.2', '0.6.2'))
  for (const url of ['file:///a.exe', 'http://example.com/a', 'https://user:secret@example.com/a', 'javascript:alert(1)']) assert.throws(() => updateUrl(url))
  assert.throws(() => parseRelease({ ...manifest, product: 'other' }, 'win32-x64'))
  assert.throws(() => parseRelease({ ...manifest, assets: { 'win32-x64': { ...manifest.assets['win32-x64'], sha256: 'none' } } }, 'win32-x64'))
  assert.throws(() => parseRelease(manifest, 'linux-x64'))
  await assert.rejects(fetchUpdate('https://example.com/a', { fetchImpl: async () => new Response(null, { status: 302, headers: { location: `${base}/latest.json` } }) }), /不安全/)
  const results = await Promise.all([checker.check(), checker.check()])
  assert.equal(hits, 1); assert.equal(results[0].status, 'available')
  assert.deepEqual(results[0], results[1])
  manifest.version = '0.6.2'; assert.equal((await checker.check()).status, 'up_to_date')
  manifest.version = '0.6.1'; assert.equal((await checker.check()).status, 'up_to_date')
  for (const [path, expected] of [['missing', 'unpublished'], ['bad', 'error'], ['large', 'error'], ['redirect', 'up_to_date']]) {
    checker.configure(`${base}/${path}`); assert.equal((await checker.check()).status, expected)
  }
  const timeout = createUpdateChecker({ currentVersion: '0.6.2', feedUrl: `${base}/slow`, platform: 'win32-x64', timeoutMs: 20 })
  assert.equal((await timeout.check()).status, 'error')
  manifest.version = '0.6.3'; await updater.check()
  await updater.download(); assert.equal(updater.status().download.status, 'ready')
  const downloaded = await updater.installer(); assert.deepEqual(await readFile(downloaded), binary)
  await writeFile(downloaded, Buffer.alloc(binary.length)); await assert.rejects(updater.installer(), /校验失败/)
  for (mode of ['wrong', 'short', 'excess']) { await updater.download(); assert.equal(updater.status().download.status, 'error'); await assert.rejects(updater.installer()) }
  mode = 'slow'
  const downloading = updater.download()
  assert.throws(() => updater.configure({ notify: false }), /下载/)
  await assert.rejects(updater.check(), /下载/)
  await new Promise(resolve => setTimeout(resolve, 50)); updater.cancel(); await downloading
  assert.equal(updater.status().download.status, 'cancelled')
  assert.ok(!(await readdir(join(dir, 'downloads'))).some(name => name.endsWith('.part')))
  mode = 'normal'; await updater.download(); assert.equal(updater.status().download.status, 'ready')
  assert.ok(pushed.some(state => state.download.status === 'downloading'))
  assert.ok(pushed.some(state => state.status === 'checking'))
  updater.dismiss(); assert.equal(updater.status().settings.dismissedVersion, '0.6.3')
  updater.configure({ feedUrl: `${base}/redirect`, autoCheck: false })
  assert.equal(updater.status().download.status, 'idle'); await assert.rejects(updater.installer())
  const vault = createMemoryVault({ databasePath: ':memory:', updates: updater })
  const deps = { store: vault.store, config: vault.config, notify: vault.notify, updates: vault.updates }
  assert.equal((await operateVault(deps, { op: 'updates.check' })).status, 'available')
  assert.equal((await operateVault(deps, { op: 'updates.status' })).currentVersion, '0.6.2')
  await assert.rejects(operateVault(deps, { op: 'updates.install' }))
  vault.dispose(); assert.equal(updater.status().currentVersion, '0.6.2')
  let stdout = ''
  assert.equal(await cli(['updates', '--db', join(dir, 'cli.sqlite')], { stdout: text => { stdout += text }, stderr: text => { throw new Error(text) } }), 0)
  assert.equal(JSON.parse(stdout).currentVersion, VERSION)
  const installer = join(dir, 'Memory-Vault-0.6.2-Setup.exe'), output = join(dir, 'latest.json')
  await writeFile(installer, binary)
  const published = await writeReleaseManifest({ installer, output, version: '0.6.2', notes: '发布测试' })
  assert.equal(published.assets['win32-x64'].sha256, sha256)
  assert.equal(JSON.parse(await readFile(output, 'utf8')).version, '0.6.2')
  console.log('Updates: feed validation, version ordering, redirects, errors, deduplication, progress, cancellation, hash verification, read-only adapters and release manifest passed')
} finally {
  checker.dispose(); updater.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true })
}
