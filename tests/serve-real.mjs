/** Quick real-process check of serve mode: node client against node server. */
import { spawn } from 'node:child_process'
import { request } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'

const dir = mkdtempSync(join(tmpdir(), 'mv-serve-real-'))
const db = join(dir, 'vault.sqlite')
const child = spawn(process.execPath, ['bin/memory-vault.mjs', 'serve', '--port', '0'], {
  cwd: process.cwd(),
  env: { ...process.env, MEMORY_VAULT_DB: db },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let listening = ''
child.stdout.on('data', chunk => { listening += String(chunk) })
child.stderr.on('data', chunk => { process.stderr.write(`[server] ${String(chunk)}`) })

const port = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('server did not report a port')), 10000)
  child.stdout.on('data', chunk => {
    const match = /listening on http:\/\/([\d.]+):(\d+)/.exec(String(chunk))
    if (match !== null) { clearTimeout(timer); resolve(Number(match[2])) }
  })
})
console.log(`server listening (line: ${listening.trim()}) on port ${String(port)}`)

const call = (path, body, marker = true) => new Promise((resolve, reject) => {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8')
  const req = request(`http://127.0.0.1:${String(port)}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      connection: 'close',
      ...(payload === undefined ? {} : { 'content-length': String(payload.byteLength) }),
      ...(marker ? { 'x-dsh-memory-vault': '1' } : {}),
    },
  }, res => {
    const chunks = []
    res.on('data', chunk => { chunks.push(chunk) })
    res.on('end', () => resolve({ status: res.statusCode, payload: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') }))
  })
  req.on('error', reject)
  if (payload !== undefined) req.write(payload)
  req.end()
})

const health = await call('/health')
console.log(`health: ${String(health.status)} ok=${String(health.payload.ok)}`)
const write = await call('/rpc', { op: 'entry.write', group: '知识库', content: '真实进程 RPC 写入。', source: 'codex' })
console.log(`write: ${String(write.status)} ok=${String(write.payload.ok)} id=${String(write.payload.result?.entry?.id)}`)
const read = await call('/rpc', { op: 'entries', query: 'RPC 写入' })
console.log(`read: ${String(read.status)} count=${String(read.payload.result.entries.length)}`)
const noMarker = await call('/rpc', { op: 'state' }, false)
console.log(`no-marker: ${String(noMarker.status)} (expect 403)`)

child.kill('SIGTERM')
await new Promise(resolve => { child.on('exit', resolve) })
try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) } catch { /* temp */ }
console.log('serve smoke done')
