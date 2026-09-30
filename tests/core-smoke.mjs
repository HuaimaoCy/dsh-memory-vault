/**
 * Core smoke test: the host-free vault, the generic op surface, the CLI, and
 * the loopback RPC server — the split-out core that DSH and Codex share.
 *
 * The main suite (tests/smoke.mjs) drives the DSH plugin adapter; this one
 * proves the same vault works with no DSH anywhere: a bare `createMemoryVault`,
 * the shared `operateVault` ops, `runCli` in-process, and `serve` over real
 * HTTP, plus two processes (two vaults) over one database file.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:http'
import assert from 'node:assert/strict'

import { createMemoryVault } from '../src/core/vault.js'
import { operateVault, VAULT_OPS } from '../src/core/ops.js'
import { runCli, serve } from '../bin/memory-vault.mjs'

const failures = []

/**
 * Assert one condition and record the outcome.
 * @param {string} label - What is being checked.
 * @param {() => void | Promise<void>} check - Assertion body.
 */
async function check(label, check) {
  try {
    await check()
    console.log(`  ok   ${label}`)
  } catch (error) {
    failures.push(label)
    console.log(`  FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const dir = mkdtempSync(join(tmpdir(), 'memory-vault-core-'))
const databasePath = join(dir, 'vault.sqlite')

/**
 * One vault over the shared temp database.
 * @param {Record<string, unknown>} [overrides] - Extra options.
 * @returns {Record<string, any>} Vault handle.
 */
function vault(overrides = {}) {
  return createMemoryVault({ databasePath, ...overrides })
}

await check('the core seeds the default groups with no host anywhere', async () => {
  const v = vault()
  const groups = v.store.listGroups().map(group => group.name)
  assert.ok(groups.includes('对话记忆'), `seeded groups: ${JSON.stringify(groups)}`)
  assert.ok(groups.includes('知识库'), `seeded groups: ${JSON.stringify(groups)}`)
  v.dispose()
})

await check('the shared op surface writes and reads back through the core', async () => {
  const v = vault()
  const deps = { store: v.store, config: v.config, notify: v.notify, curate: v.curate }
  const written = await operateVault(deps, {
    op: 'entry.write',
    group: '知识库',
    content: '构建统一用 pnpm；脚本在 scripts/build.ts。',
    title: '构建约定',
    tags: ['构建'],
    source: 'cli',
  })
  const id = written.entry.id
  assert.equal(written.entry.source, 'cli', 'non-panel provenance survives')
  const found = await operateVault(deps, { op: 'entries', query: 'pnpm 构建', scope: 'knowledge' })
  assert.ok(found.entries.some(entry => entry.id === id), 'written entry is searchable')
  const refused = await operateVault(deps, { op: 'entry.write', group: '知识库', content: '' }).then(
    () => { throw new Error('empty write must be refused') },
    error => error.message,
  )
  assert.ok(refused.includes('不能为空'), `refusal message: ${refused}`)
  v.dispose()
})

await check('caller-written summarize works without any model adapter', async () => {
  const v = vault()
  const result = await v.summarize({
    session: { id: 'core-session' },
    groupReference: '知识库',
    content: '## 摘要\n- 核心可以在无宿主环境运行。',
    title: '核心自检',
    mode: 'manual',
  })
  assert.equal(result.entry.kind, 'summary')
  assert.equal(result.entry.title, '核心自检')
  assert.equal(result.model, null, 'no model call happened')
  // Without an adapter the model path is refused, and only after there is a
  // transcript worth summarizing: the empty-slice guard fires first.
  v.observe({ sessionId: 'core-session', role: 'user', text: '这段需要总结。', seq: 1 })
  const refused = await v.summarize({ session: { id: 'core-session' } }).then(
    () => { throw new Error('model summarize must be refused without an adapter') },
    error => error.message,
  )
  assert.ok(refused.includes('该宿主没有接入模型服务'), `refusal message: ${refused}`)
  v.dispose()
})

await check('curation is refused cleanly without a model adapter', async () => {
  const v = vault()
  // An explicit route skips the route-resolution refusal so the missing-adapter
  // refusal is the one that surfaces.
  const refused = await v.curate({ origin: 'all', route: { provider: 'p', model: 'm' } }).then(
    () => { throw new Error('curate must be refused without an adapter') },
    error => error.message,
  )
  assert.ok(refused.includes('该宿主没有接入模型服务'), `refusal message: ${refused}`)
  v.dispose()
})

await check('observe feeds the transcript and threshold counts it', async () => {
  const v = vault({ config: { autoSummaryTurns: 2, autoSummaryChars: 100000 } })
  v.observe({ sessionId: 'feed', role: 'user', text: '把构建改成 pnpm。', seq: 1 })
  v.observe({ sessionId: 'feed', role: 'assistant', text: '已改为 pnpm。', seq: 2 })
  const verdict = v.threshold('feed')
  assert.equal(verdict.messages, 2)
  assert.equal(verdict.trip, true, 'two messages trip a threshold of two')
  const decision = v.shouldAutoSummarize('feed')
  assert.ok(decision !== undefined && decision.group.name === '对话记忆')
  v.dispose()
})

await check('a model adapter and route hook drive summarize through the core', async () => {
  /** @type {Record<string, unknown>[]} */
  const calls = []
  const v = vault({
    callModel: async (call) => {
      calls.push(call)
      return { text: '## 摘要\n- 经适配器总结。', usage: { outputTokens: 5 }, provider: call.route.provider, model: call.route.model }
    },
    resolveRoute: () => ({ provider: 'codex-provider', model: 'codex-model' }),
  })
  v.observe({ sessionId: 'adapted', role: 'user', text: '请总结这段。', seq: 1 })
  const result = await v.summarize({ session: { id: 'adapted' }, mode: 'manual' })
  assert.equal(calls.length, 1, 'exactly one model call')
  assert.equal(calls[0].route.provider, 'codex-provider')
  assert.ok(String(calls[0].system).includes('memory engine'), 'system prompt is the summarizer one')
  assert.equal(result.model.provider, 'codex-provider')
  assert.equal(result.entry.source, 'model-summary')
  v.dispose()
})

await check('two vaults share one database file (DSH host and CLI side by side)', async () => {
  const host = vault()
  const cli = vault()
  const deps = { store: cli.store, config: cli.config, notify: cli.notify, curate: cli.curate }
  const written = await operateVault(deps, { op: 'entry.write', group: '知识库', content: '并发写入验证。', source: 'cli' })
  const seen = host.store.findEntry(written.entry.id)
  assert.ok(seen !== undefined, 'the other process sees the write')
  cli.dispose()
  host.dispose()
})

await check('the CLI writes, recalls, shows, and summarizes over the same database', async () => {
  /** @type {string[]} */
  const out = []
  const capture = { stdout: (text) => { out.push(text) } }
  const flags = ['--db', databasePath]
  let code = await runCli(['write', ...flags, '--content', 'CLI 写入的结论：接口统一走 operateVault。', '--title', 'CLI 写入', '--tags', 'cli,接口'], capture)
  assert.equal(code, 0)
  const written = JSON.parse(out[out.length - 1])
  code = await runCli(['recall', ...flags, '--query', 'CLI 接口'], capture)
  assert.equal(code, 0)
  const found = JSON.parse(out[out.length - 1])
  assert.ok(found.entries.some(entry => entry.id === written.entry.id), 'recall finds the CLI write')
  code = await runCli(['show', ...flags, written.entry.id], capture)
  assert.equal(code, 0)
  const shown = JSON.parse(out[out.length - 1])
  assert.equal(shown.entry.id, written.entry.id)
  code = await runCli(['summarize', ...flags, '--session', 'cli-session', '--content', 'CLI 总结正文。', '--title', 'CLI 总结'], capture)
  assert.equal(code, 0)
  const summarized = JSON.parse(out[out.length - 1])
  assert.equal(summarized.entry.kind, 'summary')
  code = await runCli(['nonsense', ...flags], capture)
  assert.equal(code, 1, 'unknown command exits 1')
})

await check('serve answers /health and the op surface over loopback HTTP', async () => {
  const v = vault()
  /** @type {{ port: number, host: string, close: () => void }|undefined} */
  let listening
  const stopped = serve({
    vault: v,
    port: 0,
    host: '127.0.0.1',
    onListening: (resolved) => { listening = resolved },
  })
  for (let spin = 0; listening === undefined && spin < 100; spin += 1) {
    await new Promise(resolve => { setTimeout(resolve, 10) })
  }
  assert.ok(listening !== undefined, 'server must report its listening address')
  const base = `http://${String(listening?.host)}:${String(listening?.port)}`

  const health = await post(base, '/health', undefined, false)
  assert.equal(health.status, 200)
  assert.equal(health.payload.ok, true)

  const noMarker = await post(base, '/rpc', { op: 'state' }, false)
  assert.equal(noMarker.status, 403, 'rpc without the client marker is refused')

  const write = await post(base, '/rpc', { op: 'entry.write', group: '知识库', content: '经 RPC 写入的记忆。', source: 'codex' }, true)
  assert.equal(write.status, 200, JSON.stringify(write.payload))
  assert.equal(write.payload.ok, true)
  const id = write.payload.result.entry.id
  assert.equal(write.payload.result.entry.source, 'codex', 'codex provenance survives the RPC hop')

  const read = await post(base, '/rpc', { op: 'entries', query: 'RPC' }, true)
  assert.equal(read.status, 200)
  assert.ok(read.payload.result.entries.some(entry => entry.id === id), 'rpc write is searchable')

  const crossOrigin = await post(base, '/rpc', { op: 'state' }, true, { origin: 'https://evil.example' })
  assert.equal(crossOrigin.status, 403, 'cross-origin rpc is refused')

  // The same row must be visible to a second vault: the server and a CLI
  // process are exactly this arrangement.
  const other = vault()
  assert.ok(other.store.findEntry(id) !== undefined)
  other.dispose()
  listening?.close()
  await stopped
})

await check('the op vocabulary is shared: every VAULT_OPS entry is servable', async () => {
  const ops = Object.keys(VAULT_OPS)
  for (const must of ['state', 'entries', 'entry.write', 'group.create', 'assign', 'apply.set', 'curate', 'session.bind']) {
    assert.ok(ops.includes(must), `VAULT_OPS must list ${must}`)
  }
  const v = vault()
  const unknown = await operateVault({ store: v.store, config: v.config, notify: v.notify }, { op: 'nope' }).then(
    () => { throw new Error('unknown op must be refused') },
    error => error.message,
  )
  assert.ok(unknown.includes('unknown vault operation'), `refusal message: ${unknown}`)
  const noCurate = await operateVault({ store: v.store, config: v.config, notify: v.notify }, { op: 'curate', apply: false }).then(
    () => { throw new Error('curate without an adapter must be refused') },
    error => error.message,
  )
  assert.ok(noCurate.includes('该宿主没有接入模型服务'), `refusal message: ${noCurate}`)
  v.dispose()
})

// Windows can hold the SQLite file for a moment after close; retry instead of
// failing a suite whose checks all passed.
try {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
} catch (_error) {
  console.log(`  (note: temp dir kept: ${dir})`)
}
console.log(failures.length === 0 ? '\ncore smoke: all checks passed' : `\ncore smoke: ${String(failures.length)} failure(s): ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)

/**
 * Drive one HTTP request against the loopback server.
 * @param {string} base - Base URL.
 * @param {string} path - Request path.
 * @param {Record<string, unknown>|undefined} body - JSON body, or none for GET.
 * @param {boolean} marker - Whether the client marker header is set.
 * @param {Record<string, string>} [extraHeaders] - Additional headers.
 * @returns {Promise<{ status: number, payload: any }>} The response.
 */
function post(base, path, body, marker, extraHeaders = {}) {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8')
  return new Promise((resolve, reject) => {
    const req = request(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        // Keep-alive would hold the socket open and keep server.close() (and
        // with it the test) waiting forever.
        connection: 'close',
        ...(payload === undefined ? {} : { 'content-length': String(payload.byteLength) }),
        ...(marker ? { 'x-dsh-memory-vault': '1' } : {}),
        ...extraHeaders,
      },
    }, (res) => {
      const chunks = []
      res.on('data', chunk => { chunks.push(chunk) })
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve({ status: res.statusCode ?? 0, payload: text === '' ? null : JSON.parse(text) })
      })
    })
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}
