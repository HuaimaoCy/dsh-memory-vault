import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { createMemoryVault } from '../src/core/vault.js'
import { operateVault } from '../src/core/ops.js'
import { createModelAdapter, validateModelSettings } from '../src/model.js'
import { connectorConfig } from '../desktop/lib/connectors.mjs'
import { validateVaultFile } from '../desktop/lib/databases.mjs'
import { DatabaseSync } from 'node:sqlite'

const dir = mkdtempSync(join(tmpdir(), 'memory-vault-standalone-'))
const vault = createMemoryVault({ databasePath: join(dir, 'vault.sqlite') })
const deps = { ...vault }
const op = body => operateVault(deps, body)
try {
  assert.ok(isAbsolute(vault.databasePath))
  const parent = (await op({ op: 'group.create', name: '项目', scope: 'knowledge' })).group
  const child = (await op({ op: 'group.create', name: '子组', parent: parent.id })).group
  const entry = (await op({ op: 'entry.write', groupId: child.id, content: '正文', title: '初始' })).entry
  const changed = (await op({ op: 'entry.update', id: entry.id, title: '新标题', scope: 'knowledge', groupId: parent.id, base: true })).entry
  assert.equal(changed.scope, 'knowledge'); assert.equal(changed.groupId, parent.id); assert.equal(changed.base, true)
  await assert.rejects(op({ op: 'entry.update', id: entry.id, title: '不能留下', groupId: 'missing' }))
  assert.equal(vault.store.requireEntry(entry.id).title, '新标题')
  await op({ op: 'entry.write', groupId: child.id, content: '子组内容' })
  assert.equal((await op({ op: 'entries', group: parent.id, includeChildren: true })).entries.length, 2)
  assert.equal((await op({ op: 'entries', group: child.id, includeChildren: true })).entries.length, 1)
  await op({ op: 'entry.hide', ids: [entry.id], hidden: true })
  assert.equal((await op({ op: 'entries', onlyHidden: true, includeHidden: true })).entries.length, 1)
  assert.equal((await op({ op: 'entries', onlyHidden: true, includeHidden: true, query: '正文' })).entries.length, 1)
  const bulk = Array.from({ length: 502 }, (_, i) => ({ groupId: parent.id, content: `分页 ${i}`, title: `分页 ${i}`, source: 'panel' }))
  vault.store.createEntries(bulk)
  const page = await op({ op: 'entries', query: '分页', limit: 500 })
  assert.equal(page.entries.length, 500); assert.equal(page.hasMore, true); assert.equal(page.nextOffset, 500)
  assert.equal((await op({ op: 'entries', query: '分页', offset: 500, limit: 500 })).entries.length, 2)
  const backupPath = join(dir, 'backup.sqlite')
  vault.store.backupTo(backupPath)
  validateVaultFile(backupPath)
  const otherPath = join(dir, 'other.sqlite')
  const other = new DatabaseSync(otherPath)
  other.exec('CREATE TABLE unrelated (id INTEGER)'); other.close()
  assert.throws(() => validateVaultFile(otherPath), /不是 Alaya/)
  const backup = createMemoryVault({ databasePath: backupPath })
  try {
    assert.equal(backup.store.stats().totals.entries, vault.store.stats().totals.entries)
    assert.equal(backup.store.requireEntry(entry.id).hidden, true)
  } finally { backup.dispose() }
  const snippet = connectorConfig({ command: 'C:\\软件\\Memory Vault.exe', args: ['memory-vault.mjs', 'mcp'], databasePath: vault.databasePath })
  assert.ok(snippet.codex.includes('"mcp"')); assert.ok(snippet.codex.includes('C:\\\\软件'))
  assert.throws(() => validateModelSettings({ baseUrl: 'http://remote.example/v1', model: 'x' }), /HTTPS/)
  assert.throws(() => validateModelSettings({ baseUrl: 'https://user:pass@example.com/v1', model: 'x' }), /凭据/)
  let finishReason = 'stop', status = 200, seen
  const server = createServer(async (req, res) => {
    let data = ''
    for await (const chunk of req) data += chunk
    seen = { path: req.url, auth: req.headers.authorization, body: JSON.parse(data) }
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ finish_reason: finishReason, message: { content: '完整结果' } }], usage: { total_tokens: 1 } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const adapter = createModelAdapter(() => ({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'test' }), () => 'dummy-test-key')
    const request = { system: '规则', messages: [{ role: 'user', content: [{ type: 'text', text: '待整理记忆' }] }], maxTokens: 50, timeoutMs: 1000 }
    assert.equal((await adapter.callModel(request)).text, '完整结果')
    assert.equal(seen.path, '/v1/chat/completions'); assert.equal(seen.auth, 'Bearer dummy-test-key')
    assert.equal(seen.body.messages[1].content, '待整理记忆')
    finishReason = 'length'; await assert.rejects(adapter.callModel(request), /未完整/)
    status = 401; await assert.rejects(adapter.callModel(request), /HTTP 401/)
    const controller = new AbortController(); controller.abort(); await assert.rejects(adapter.callModel({ ...request, signal: controller.signal }))
  } finally { await new Promise(resolve => server.close(resolve)) }
  console.log('Standalone: atomic edit and assignment, group tree, hidden search, pagination, WAL backup, connectors and model failures passed')
} finally { vault.dispose(); rmSync(dir, { recursive: true, force: true }) }
