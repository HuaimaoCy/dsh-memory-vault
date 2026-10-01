import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createMemoryVault } from '../src/core/vault.js'

/** Exercise the actual transport; can also run against a packaged executable. */
export async function exerciseMcp(command, args, databasePath, environment = {}) {
  const child = spawn(command, [...args, '--db', databasePath], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, ...environment } })
  let id = 0, buffer = '', stderr = ''
  const pending = new Map()
  child.stderr.on('data', chunk => { stderr += chunk.toString() })
  const exited = new Promise((res, rej) => { child.once('error', rej); child.once('exit', (code, signal) => res({ code, signal })) })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    buffer += chunk
    let end
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
      try {
        const result = JSON.parse(line)
        const waiter = pending.get(result.id)
        if (waiter) { pending.delete(result.id); waiter(result) }
      } catch (error) { for (const waiter of pending.values()) waiter({ error: { message: `non-JSON stdout: ${line}` } }); pending.clear() }
    }
  })
  const request = (method, params = {}) => new Promise((res, rej) => {
    const current = ++id
    const timer = setTimeout(() => { pending.delete(current); rej(new Error(`MCP timeout ${method}: ${stderr}`)) }, 20000)
    pending.set(current, value => { clearTimeout(timer); res(value) })
    // Deliberately fragment a message to verify framing across chunks.
    const line = JSON.stringify({ jsonrpc: '2.0', id: current, method, params }) + '\n'
    child.stdin.write(line.slice(0, 9)); child.stdin.write(line.slice(9))
  })
  const call = async (name, arguments_) => {
    const reply = await request('tools/call', { name, arguments: arguments_ })
    assert.equal(reply.error, undefined, JSON.stringify(reply))
    assert.equal(reply.result.isError, false, JSON.stringify(reply))
    assert.deepEqual(JSON.parse(reply.result.content[0].text), reply.result.structuredContent)
    return reply.result.structuredContent
  }
  try {
    const beforeInit = await request('tools/list')
    assert.equal(beforeInit.error?.code, -32000, JSON.stringify(beforeInit))
    const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'vault-test', version: '1' } })
    assert.equal(init.result.protocolVersion, '2025-06-18')
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    const listed = await request('tools/list')
    assert.equal(listed.result.tools.length, 10)
    assert.ok(listed.result.tools.find(tool => tool.name === 'memory_context').annotations.readOnlyHint)
    assert.ok(listed.result.tools.find(tool => tool.name === 'memory_updates').annotations.readOnlyHint)
    assert.equal((await call('memory_updates', { action: 'status' })).currentVersion, init.result.serverInfo.version)
    assert.equal((await request('tools/call', { name: 'memory_updates', arguments: { action: 'install' } })).error.code, -32602)
    assert.equal((await request('tools/call', { name: 'missing' })).error.code, -32602)
    assert.equal((await request('tools/call', { name: 'memory_write', arguments: { group: 'MCP' } })).error.code, -32602)
    assert.equal((await request('tools/call', { name: 'memory_recall', arguments: { extra: 1 } })).error.code, -32602)
    const written = await call('memory_write', { group: 'MCP 测试', scope: 'knowledge', entries: [{ title: '跨宿主约定', content: '中文 😀：Codex 与 DSH 共用数据库。', priority: 90, tags: ['接口'] }], sessionId: 'task-a' })
    const entry = written.entries[0]
    assert.equal(entry.source, 'model-write')
    assert.ok(entry.tags.includes('AI 生成'))
    const observer = createMemoryVault({ databasePath })
    try { assert.equal(observer.store.requireEntry(entry.id).content, entry.content) } finally { observer.dispose() }
    await call('memory_apply', { action: 'set', groups: ['MCP 测试'], sessionId: 'task-a' })
    await call('memory_apply', { action: 'set', groups: [], sessionId: 'task-b' })
    assert.ok((await call('memory_context', { sessionId: 'task-a' })).context.includes(entry.content))
    assert.ok(!(await call('memory_context', { sessionId: 'task-b' })).context.includes(entry.content))
    assert.equal((await call('memory_recall', { id: entry.id })).entries[0].content, entry.content)
    const imageData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU9sAAAAASUVORK5CYII='
    const attached = await call('memory_image', { action: 'add', entryId: entry.id, name: '测试.png', mimeType: 'image/png', data: imageData })
    assert.equal(attached.images.length, 1)
    const pictured = await request('tools/call', { name: 'memory_image', arguments: { action: 'read', id: attached.images[0].id } })
    assert.equal(pictured.result.isError, false)
    assert.equal(pictured.result.content[1].type, 'image')
    assert.equal(pictured.result.content[1].mimeType, 'image/png')
    assert.equal(pictured.result.content[1].data, imageData)
    assert.equal(pictured.result.structuredContent.image.data, undefined)
    assert.equal((await call('memory_recall', { id: entry.id })).entries[0].imageCount, 1)
    await call('memory_assign', { ids: [entry.id], hidden: true })
    assert.equal((await call('memory_recall', { query: '中文' })).entries.length, 0)
    assert.equal((await call('memory_recall', { query: '中文', includeHidden: true })).entries.length, 1)
    const summary = await call('memory_summarize', { content: '已验证的结论。', title: '总结', sessionId: 'task-a' })
    assert.equal(summary.entry.source, 'model-write')
    assert.equal(summary.entry.sessionId, 'task-a')
    const invalid = await request('tools/call', { name: 'memory_group', arguments: { action: 'delete', id: 'unknown' } })
    assert.equal(invalid.result.isError, true)
    assert.equal((await request('unknown')).error.code, -32601)
    assert.deepEqual((await request('ping')).result, {})
    console.log('MCP: initialization, schemas, Unicode framing, tools, session isolation, shared DB and shutdown passed')
  } finally {
    child.stdin.end()
    const timeout = setTimeout(() => child.kill(), 3000)
    const outcome = await exited
    clearTimeout(timeout)
    assert.equal(outcome.code, 0, stderr)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const dir = mkdtempSync(join(tmpdir(), 'memory-vault-mcp-'))
  try { await exerciseMcp(process.execPath, ['--no-warnings', resolve('bin/memory-vault.mjs'), 'mcp'], join(dir, 'vault.sqlite')) }
  finally { rmSync(dir, { recursive: true, force: true }) }
}
