/**
 * Standalone smoke test for the vault.
 *
 * It drives the Host half through a mock Cordis context — the same shape the
 * real loader supplies — so tool bodies, transcript observation, threshold
 * summarization, hiding, knowledge application, and the panel route can be
 * exercised without booting DSH. The browser half is loaded the way the shell
 * loads it, with its one `__ModuleLoader__.load()` call stubbed, which reaches
 * the pure helpers the panel keeps.
 *
 * Run with: `node tests/smoke.mjs`
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import assert from 'node:assert/strict'

import { apply, Config } from '../index.js'
import { MemoryStore } from '../src/store.js'

/** Collected failures. */
const failures = []

/**
 * Assert one condition and record the outcome.
 * @param {string} label - What is being checked.
 * @param {() => void} check - Assertion body.
 * @returns {void}
 */
function check(label, check) {
  try {
    check()
    console.log(`  ok   ${label}`)
  } catch (error) {
    failures.push(label)
    console.log(`  FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Build a mock Cordis context that records registrations.
 * @param {Record<string, unknown>} services - Optional services the plugin resolves through `ctx.get`.
 * @returns {Record<string, any>} Mock context.
 */
function mockContext(services) {
  const tools = new Map()
  const handlers = new Map()
  const disposers = []
  const routes = []
  return {
    tools,
    handlers,
    routes,
    disposers,
    ctx: {
      logger: {
        info: () => {},
        warn: (message) => { console.log(`  [warn] ${String(message)}`) },
      },
      tools: {
        register: (definition) => {
          tools.set(definition.name, definition)
          return () => tools.delete(definition.name)
        },
      },
      on: (event, handler) => { handlers.set(event, handler) },
      effect: (run) => {
        const disposer = run()
        if (typeof disposer === 'function') disposers.push(disposer)
      },
      get: (name) => services[name],
    },
    dispose: () => {
      for (const disposer of disposers.reverse()) disposer()
    },
  }
}

/**
 * A session stub carrying the identity and route the plugin reads.
 * @param {string} id - Session id.
 * @returns {Record<string, any>} Session stub.
 */
function sessionStub(id) {
  return {
    id,
    requestHeader: () => ({ config: { provider: 'test-provider', model: 'test-model' } }),
    deriveMessages: () => [
      { role: 'user', content: [{ type: 'text', text: '请把构建脚本改成 pnpm。' }] },
      { role: 'assistant', content: [{ type: 'text', text: '已改为 pnpm，脚本在 scripts/build.ts。' }] },
    ],
  }
}

/**
 * A streaming LLM stub that answers with one fixed record.
 * @param {string} text - Text the stream yields.
 * @param {{ calls: Record<string, unknown>[] }} sink - Collector for call options.
 * @returns {Record<string, any>} LLM service stub.
 */
function llmStub(text, sink) {
  return {
    stream: async function* stream(options) {
      sink.calls.push(options)
      yield { type: 'text-delta', text }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

/**
 * Drive one HTTP request through a registered route handler.
 * @param {{ handler: (req: unknown, res: unknown) => Promise<void> }} route - Registered route.
 * @param {string} method - HTTP method.
 * @param {string} url - Request URL.
 * @param {Record<string, unknown>} [body] - JSON body.
 * @param {Record<string, string>} [extraHeaders] - Headers beyond the default marker/host pair.
 * @param {boolean} [withMarker] - Whether the marker header is sent; false models a foreign caller.
 * @returns {Promise<{ status: number, payload: any }>} Captured response.
 */
async function request(route, method, url, body, extraHeaders = {}, withMarker = true) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  const req = {
    method,
    url,
    headers: {
      host: '127.0.0.1:3080',
      ...(withMarker ? { 'x-dsh-memory-vault': '1' } : {}),
      ...extraHeaders,
    },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
  let status = 0
  let text = ''
  const res = {
    writeHead: (code) => { status = code },
    end: (payload) => { text = String(payload ?? '') },
  }
  await route.handler(req, res)
  return { status, payload: text === '' ? null : JSON.parse(text) }
}

const dir = mkdtempSync(join(tmpdir(), 'memory-vault-'))
const databasePath = join(dir, 'vault.sqlite')
const sink = { calls: [] }
const llm = llmStub('## 摘要\n- 构建脚本改用 pnpm。\n\n## 关键事实\n- 脚本位于 scripts/build.ts。\n\n## 决策\n- (无)\n\n## 未决\n- (无)', sink)
const routes = []
const harness = mockContext({
  llm,
  systemPrompt: {
    section: (section) => {
      routes.push({ kind: 'prompt-section', section })
      return () => {}
    },
  },
  webServer: {
    register: (route) => {
      routes.push(route)
      return () => {}
    },
  },
})

const validated = Config['~standard'].validate({
  databasePath,
  autoSummaryTurns: 2,
  autoSummaryChars: 100,
  // Small enough that an oversized body is cheap to produce in a test, and
  // large enough for every other record this file writes.
  maxEntryChars: 200,
  conversationGroupName: '对话记忆',
  knowledgeGroupName: '知识库',
})
assert.ok(!('issues' in validated), 'config must validate')
apply(harness.ctx, validated.value)

const tool = (name) => {
  const definition = harness.tools.get(name)
  assert.ok(definition !== undefined, `tool ${name} must be registered`)
  return definition
}
const exec = { agent: { session: sessionStub('session-smoke') }, signal: new AbortController().signal }
const panelRoute = routes.find(entry => entry.kind === 'prefix')
const indexSection = () => routes.find(entry => entry.kind === 'prompt-section').section

console.log('registration')
check('six tools are registered', () => {
  assert.deepEqual([...harness.tools.keys()].sort(), [
    'memory_apply', 'memory_assign', 'memory_group', 'memory_recall', 'memory_summarize', 'memory_write',
  ])
})
check('a session/event listener is installed', () => {
  assert.ok(harness.handlers.has('session/event'))
})
check('a prompt section and a panel route are installed', () => {
  assert.equal(routes.filter(entry => entry.kind === 'prompt-section').length, 1)
  assert.equal(routes.filter(entry => entry.kind === 'prefix').length, 1)
  assert.equal(panelRoute.path, '/memory-vault')
})

console.log('groups and entries')
const created = await tool('memory_group').execute({ action: 'create', name: '项目约定', scope: 'knowledge', description: '团队约定' }, exec)
const knowledgeGroupId = created.group.id
check('create returns the new group', () => {
  assert.equal(created.group.name, '项目约定')
  assert.equal(created.group.scope, 'knowledge')
})
const listed = await tool('memory_group').execute({ action: 'list' }, exec)
check('list includes seeded and created groups', () => {
  assert.deepEqual(listed.groups.map(group => group.name).sort(), ['对话记忆', '知识库', '项目约定'].sort())
})
check('the seeded conversation group summarizes automatically', () => {
  assert.equal(listed.groups.find(group => group.name === '对话记忆').autoSummary, true)
})

const written = await tool('memory_write').execute({
  group: '项目约定',
  entries: [
    { content: '所有包脚本统一用 pnpm 执行。', title: '包管理器', kind: 'decision', tags: ['构建'] },
    { content: '构建入口是 scripts/build.ts。', kind: 'fact' },
  ],
}, exec)
check('write files every entry through the group assignment', () => {
  assert.equal(written.entries.length, 2)
  assert.equal(written.entries[0].scope, 'knowledge')
  assert.equal(written.entries[0].kind, 'decision')
})

console.log('recall')
const found = await tool('memory_recall').execute({ query: 'pnpm', scope: 'knowledge' }, exec)
check('search matches content and reports scope', () => {
  assert.equal(found.entries.length, 1)
  assert.equal(found.entries[0].title, '包管理器')
})
const missed = await tool('memory_recall').execute({ query: 'pnpm', scope: 'conversation' }, exec)
check('search respects the assignment filter', () => {
  assert.equal(missed.entries.length, 0)
})

console.log('system tags')
check('a hand-written memory carries the manual system tag', () => {
  assert.equal(written.entries[0].autoTag, '人工输入')
  assert.ok(written.entries[0].tags.includes('人工输入'))
})
const forged = await tool('memory_write').execute({
  group: '知识库',
  entries: [{ content: '试图伪装成 AI 总结。', tags: ['AI自动总结', '真实标签'] }],
}, exec)
check('the system tag follows provenance, not the caller', () => {
  assert.deepEqual(forged.entries[0].tags, ['真实标签', '人工输入'])
})
const tagged = await tool('memory_recall').execute({ tag: '人工输入' }, exec)
check('the system tag filters the vault', () => {
  assert.ok(tagged.entries.length >= 2)
  assert.ok(tagged.entries.every(entry => entry.tags.includes('人工输入')))
})
const taggedUser = await tool('memory_recall').execute({ tag: '构建' }, exec)
check('a user tag filters the vault exactly', () => {
  assert.equal(taggedUser.entries.length, 1)
  assert.equal(taggedUser.entries[0].title, '包管理器')
})
const partial = await tool('memory_recall').execute({ tag: '构建脚本' }, exec)
check('a partial tag name matches nothing', () => {
  assert.equal(partial.entries.length, 0)
})

console.log('assignment')
const assigned = await tool('memory_assign').execute({ ids: [written.entries[0].id], scope: 'conversation' }, exec)
check('an entry moves between assignments and is marked manual', () => {
  assert.equal(assigned.entries[0].scope, 'conversation')
  assert.equal(assigned.entries[0].assigned, 'manual')
})
const flipped = await tool('memory_group').execute({ action: 'assign', name: '项目约定', scope: 'conversation' }, exec)
check('a group switch carries only entries that still follow it', () => {
  assert.equal(flipped.group.scope, 'conversation')
  assert.equal(flipped.movedEntries, 1)
})
const after = await tool('memory_recall').execute({ query: 'pnpm', scope: 'conversation' }, exec)
check('the manually assigned entry stayed where it was put', () => {
  assert.equal(after.entries.length, 1)
  assert.equal(after.entries[0].title, '包管理器')
})

console.log('transcript and threshold summarization')
check('the prompt index names the groups and their assignments', () => {
  const section = indexSection()
  assert.equal(section.name, 'memory-vault-index')
  const text = section.text({})
  assert.ok(text.includes('知识与记忆库'))
  assert.ok(text.includes('项目约定'))
  assert.ok(!text.includes('所有包脚本统一用 pnpm 执行'), 'the index must not leak entry bodies')
})

harness.handlers.get('session/event')(sessionStub('session-smoke'), {
  type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: '把构建改成 pnpm。' }], source: { kind: 'user' } },
})
harness.handlers.get('session/event')(sessionStub('session-smoke'), {
  type: 'assistant/message', seq: 2, time: 2, data: { message: { content: [{ type: 'text', text: '已改好，见 scripts/build.ts。' }] } },
})
harness.handlers.get('session/event')(sessionStub('session-smoke'), { type: 'turn/end', seq: 3, time: 3, data: {} })
await new Promise(resolve => setTimeout(resolve, 50))
check('the threshold trip made one model call with the session route', () => {
  assert.equal(sink.calls.length, 1)
  assert.equal(sink.calls[0].provider, 'test-provider')
  assert.equal(sink.calls[0].model, 'test-model')
  assert.ok(String(sink.calls[0].system).includes('memory engine'))
  assert.ok(JSON.stringify(sink.calls[0].messages).includes('把构建改成 pnpm'))
})

console.log('manual summarization')
const manual = await tool('memory_summarize').execute({ group: '知识库', content: '结论：构建统一用 pnpm。', title: '构建约定' }, exec)
check('a caller-written record is filed without a model call', () => {
  assert.equal(manual.model, null)
  assert.equal(manual.entry.scope, 'knowledge')
  assert.equal(sink.calls.length, 1)
})
harness.handlers.get('session/event')(sessionStub('session-smoke'), {
  type: 'user/message', seq: 4, time: 4, data: { content: [{ type: 'text', text: '再把测试脚本也统一。' }], source: { kind: 'user' } },
})
const modelSummarized = await tool('memory_summarize').execute({ group: '知识库' }, exec)
check('the model path files the record and advances the watermark', () => {
  assert.equal(modelSummarized.model.model, 'test-model')
  assert.equal(modelSummarized.covered.messages, 1)
  assert.equal(modelSummarized.covered.fromSeq, 4)
  assert.equal(sink.calls.length, 2)
})
const afterSummarize = await tool('memory_summarize').execute({ group: '知识库' }, exec).then(
  () => 'resolved',
  (error) => error.message,
)
check('a second call with nothing new reports the empty increment', () => {
  assert.ok(String(afterSummarize).includes('没有尚未总结的对话内容'))
})

console.log('rendering')
/**
 * Run one tool's result renderer and return its text.
 * @param {string} name - Tool name.
 * @param {Record<string, unknown>} args - Arguments the call was made with.
 * @param {Record<string, unknown>} value - Canonical result value.
 * @returns {string} Rendered text.
 */
function renderOf(name, args, value) {
  const blocks = tool(name).output.render(args, value)
  assert.ok(Array.isArray(blocks) && blocks.length > 0, `${name} must render at least one block`)
  assert.equal(blocks[0].type, 'text')
  assert.ok(String(blocks[0].text).length > 0, `${name} must render non-empty text`)
  return String(blocks[0].text)
}
check('group listing renders names and counts', () => {
  const text = renderOf('memory_group', { action: 'list' }, listed)
  assert.ok(text.includes('项目约定'))
  assert.ok(text.includes('组内'))
})
check('write output renders every filed entry', () => {
  const text = renderOf('memory_write', { group: '项目约定' }, written)
  assert.ok(text.includes('包管理器'))
  assert.ok(text.includes('归属 知识库'))
})
check('recall output names the query and each match', () => {
  const text = renderOf('memory_recall', { query: 'pnpm' }, found)
  assert.ok(text.includes('pnpm'))
  assert.ok(text.includes('mem_'))
})
check('assignment output distinguishes a manual assignment from its group', () => {
  const text = renderOf('memory_assign', { ids: [written.entries[0].id], scope: 'conversation' }, assigned)
  assert.ok(text.includes('归属 对话记忆（手动）'))
  assert.ok(text.includes('记忆组「项目约定」'))
})
check('summarize output reports the covered event range', () => {
  const text = renderOf('memory_summarize', {}, modelSummarized)
  assert.ok(text.includes('事件序号'))
  assert.ok(text.includes('test-provider/test-model'))
})
check('an empty recall renders an explicit miss', () => {
  const text = renderOf('memory_recall', { query: 'nothing-matches-this' }, { mode: 'search', entries: [], query: 'nothing-matches-this' })
  assert.ok(text.includes('没有匹配'))
})

console.log('hiding')
const hidden = await tool('memory_assign').execute({ ids: [forged.entries[0].id], hidden: true }, exec)
check('hiding reports the new state', () => {
  assert.equal(hidden.hidden, true)
  assert.equal(hidden.entries[0].hidden, true)
})
const afterHide = await tool('memory_recall').execute({ tag: '人工输入' }, exec)
check('a hidden memory leaves every default read', () => {
  assert.ok(!afterHide.entries.some(entry => entry.id === forged.entries[0].id))
})
const withHidden = await tool('memory_recall').execute({ tag: '人工输入', includeHidden: true }, exec)
check('includeHidden returns it, marked hidden', () => {
  assert.ok(withHidden.entries.some(entry => entry.id === forged.entries[0].id && entry.hidden === true))
})
const hiddenSearch = await tool('memory_recall').execute({ query: '试图伪装' }, exec)
check('search skips hidden memories too', () => {
  assert.equal(hiddenSearch.entries.length, 0)
})
check('the hidden state is visible in rendered output', () => {
  assert.ok(renderOf('memory_assign', { ids: [forged.entries[0].id], hidden: true }, hidden).includes('已隐藏'))
})
const hiddenState = await request(panelRoute, 'GET', '/memory-vault?op=state')
check('the panel state counts hidden memories outside the totals', () => {
  assert.equal(hiddenState.payload.result.stats.hidden, 1)
  assert.equal(hiddenState.payload.result.stats.totals.hidden, 1)
})
const restored = await tool('memory_assign').execute({ ids: [forged.entries[0].id], hidden: false }, exec)
check('restoring puts it back', () => {
  assert.equal(restored.entries[0].hidden, false)
})
const afterRestore = await tool('memory_recall').execute({ query: '试图伪装' }, exec)
check('a restored memory is searchable again', () => {
  assert.equal(afterRestore.entries.length, 1)
})

console.log('knowledge application')
const applySection = () => indexSection().text({ agent: { session: { id: 'session-smoke' } } })
check('a session with no choice inherits the deployment default', () => {
  const text = applySection()
  assert.ok(text.includes('已应用的知识'))
  assert.ok(text.includes('按默认设置应用'))
})
const applied = await tool('memory_apply').execute({ action: 'set', groups: ['知识库'] }, exec)
check('applying a group records an explicit choice and injects its memories', () => {
  assert.equal(applied.source, 'explicit')
  assert.deepEqual(applied.groups.map(group => group.name), ['知识库'])
  assert.ok(applied.injected >= 1)
  assert.ok(applySection().includes('本会话选择应用'))
})
const appliedNames = await tool('memory_apply').execute({ action: 'list' }, exec)
check('listing reports the same state the set returned', () => {
  assert.equal(appliedNames.source, 'explicit')
  assert.equal(appliedNames.groups.length, 1)
})
const appliedLess = await tool('memory_apply').execute({ action: 'set', groups: [] }, exec)
check('an explicit empty set applies nothing at all', () => {
  assert.equal(appliedLess.source, 'explicit')
  assert.equal(appliedLess.groups.length, 0)
  assert.equal(appliedLess.injected, 0)
  assert.ok(!applySection().includes('已应用的知识'))
})
const appliedReset = await tool('memory_apply').execute({ action: 'reset' }, exec)
check('reset hands the session back to the deployment default', () => {
  assert.equal(appliedReset.source, 'default')
  assert.ok(appliedReset.injected >= 1)
})
check('the application result names the groups and the injected count', () => {
  const text = renderOf('memory_apply', { action: 'set', groups: ['知识库'] }, applied)
  assert.ok(text.includes('知识库'))
  assert.ok(text.includes('已注入'))
})
const outsideSession = await tool('memory_apply').execute({ action: 'list' }, { agent: undefined, signal: exec.signal })
  .then(() => 'resolved', (error) => error.message)
check('applying outside a session is refused', () => {
  assert.ok(String(outsideSession).includes('需要在一个会话内调用'))
})

console.log('panel route')
const state = await request(panelRoute, 'GET', '/memory-vault?op=state')
check('state reports counts and groups', () => {
  assert.equal(state.status, 200)
  assert.equal(state.payload.ok, true)
  assert.ok(state.payload.result.stats.totals.groups >= 3)
})
check('state publishes the tag vocabulary the panel filters with', () => {
  const tags = state.payload.result.tags
  assert.ok(Array.isArray(tags) && tags.length >= 3)
  assert.ok(tags.some(item => item.tag === '人工输入' && item.system === true))
  assert.ok(tags.some(item => item.tag === 'AI自动总结' && item.system === true))
  assert.ok(tags.some(item => item.tag === '构建' && item.system === false))
})
check('state publishes the deployment default the panel shows', () => {
  assert.equal(state.payload.result.apply.byDefault, true)
  assert.deepEqual(state.payload.result.apply.defaults, ['知识库'])
})
const byTag = await request(panelRoute, 'GET', '/memory-vault?op=entries&tag=%E4%BA%BA%E5%B7%A5%E8%BE%93%E5%85%A5')
check('the panel can filter by tag', () => {
  assert.ok(byTag.payload.result.entries.length >= 2)
  assert.ok(byTag.payload.result.entries.every(entry => entry.tags.includes('人工输入')))
})
const stripped = await request(panelRoute, 'POST', '/memory-vault', { op: 'entry.update', id: forged.entries[0].id, tags: [] })
check('clearing tags through the panel keeps the provenance tag', () => {
  assert.deepEqual(stripped.payload.result.entry.tags, ['人工输入'])
})
const panelHidden = await request(panelRoute, 'POST', '/memory-vault', { op: 'entry.hide', ids: [forged.entries[0].id], hidden: true })
check('the panel can hide a memory', () => {
  assert.equal(panelHidden.payload.result.entries[0].hidden, true)
})
const panelShowHidden = await request(panelRoute, 'GET', '/memory-vault?op=entries&includeHidden=true')
check('the panel can list hidden memories when asked', () => {
  assert.ok(panelShowHidden.payload.result.entries.some(entry => entry.hidden === true))
})
const hiddenOmitted = await request(panelRoute, 'GET', '/memory-vault?op=entries')
check('hidden memories stay out of the default listing', () => {
  assert.ok(!hiddenOmitted.payload.result.entries.some(entry => entry.hidden === true))
})
await request(panelRoute, 'POST', '/memory-vault', { op: 'entry.hide', ids: [forged.entries[0].id], hidden: false })
const applyRead = await request(panelRoute, 'GET', '/memory-vault?op=apply.get&sessionId=session-panel')
check('the composer reads its application state for one session', () => {
  assert.equal(applyRead.payload.result.explicit, false)
  assert.equal(applyRead.payload.result.effective, 'default')
})
const applyWrite = await request(panelRoute, 'POST', '/memory-vault', {
  op: 'apply.set',
  sessionId: 'session-panel',
  groups: ['项目约定'],
})
check('the composer applies a group to its session', () => {
  assert.equal(applyWrite.payload.result.explicit, true)
  assert.deepEqual(applyWrite.payload.result.groups.map(group => group.name), ['项目约定'])
})
const applyAfterWrite = await request(panelRoute, 'GET', '/memory-vault?op=apply.get&sessionId=session-panel')
check('the knowledge panel receives the memories that are actually injected', () => {
  const result = applyAfterWrite.payload.result
  assert.ok(Array.isArray(result.entries))
  assert.equal(result.entries.length, result.injected)
  assert.ok(result.entries.every(entry => entry.groupName === '项目约定'))
  assert.equal(typeof result.maxEntries, 'number')
  assert.equal(typeof result.maxChars, 'number')
})
const applyClear = await request(panelRoute, 'POST', '/memory-vault', { op: 'apply.set', sessionId: 'session-panel', groups: null })
check('the composer can hand the session back to the default', () => {
  assert.equal(applyClear.payload.result.explicit, false)
  assert.equal(applyClear.payload.result.groups.length, 0)
})
const refused = await request(panelRoute, 'POST', '/memory-vault', { op: 'group.delete', id: knowledgeGroupId }, {}, false)
check('a mutating call without the marker header is refused', () => {
  assert.equal(refused.status, 403)
})
const crossOriginRefused = await request(panelRoute, 'GET', '/memory-vault?op=state', undefined, { origin: 'https://evil.example' })
check('a cross-origin caller is refused', () => {
  assert.equal(crossOriginRefused.status, 403)
})
const sameOriginRead = await request(panelRoute, 'GET', '/memory-vault?op=state', undefined, { origin: 'http://127.0.0.1:3080' })
check('a same-origin caller is served', () => {
  assert.equal(sameOriginRead.status, 200)
})
const entriesRead = await request(panelRoute, 'GET', '/memory-vault?op=entries&scope=knowledge')
check('the panel can read entries by assignment', () => {
  assert.equal(entriesRead.payload.result.entries.every(entry => entry.scope === 'knowledge'), true)
})
const panelWrote = await request(panelRoute, 'POST', '/memory-vault', { op: 'entry.write', group: '知识库', content: '面板写入的记忆。' })
check('the panel can write a memory through the same operation table', () => {
  assert.equal(panelWrote.status, 200)
  assert.equal(panelWrote.payload.result.entry.scope, 'knowledge')
})
const panelAssigned = await request(panelRoute, 'POST', '/memory-vault', {
  op: 'assign',
  ids: [panelWrote.payload.result.entry.id],
  scope: 'conversation',
})
check('the panel can reassign a memory', () => {
  assert.equal(panelAssigned.payload.result.entries[0].scope, 'conversation')
})
const panelDeleted = await request(panelRoute, 'POST', '/memory-vault', { op: 'entry.delete', id: panelWrote.payload.result.entry.id })
check('the panel can delete a memory', () => {
  assert.equal(panelDeleted.payload.result.entry.id, panelWrote.payload.result.entry.id)
})

console.log('legacy migration')
{
  const legacyPath = join(dir, 'legacy.sqlite')
  const legacy = new MemoryStore({ path: legacyPath })
  const legacyGroup = legacy.createGroup({ name: '旧库', scope: 'knowledge' })
  const legacyEntry = legacy.createEntry({ groupId: legacyGroup.id, content: '旧版本写入的记忆。' })
  legacy.close()
  // Rewrite the row the way a pre-system-tag, pre-hidden schema left it.
  const raw = new DatabaseSync(legacyPath)
  raw.prepare('UPDATE entries SET tags = ? WHERE id = ?').run(JSON.stringify(['旧标签']), legacyEntry.id)
  raw.exec('ALTER TABLE entries DROP COLUMN hidden')
  raw.close()
  const reopened = new MemoryStore({ path: legacyPath })
  check('a row written before system tags gains its provenance tag on open', () => {
    assert.deepEqual(reopened.findEntry(legacyEntry.id).tags, ['旧标签', '人工输入'])
  })
  check('a database without the hidden column is migrated in place', () => {
    assert.equal(reopened.findEntry(legacyEntry.id).hidden, false)
  })
  check('reopening again is idempotent', () => {
    reopened.close()
    const third = new MemoryStore({ path: legacyPath })
    assert.deepEqual(third.findEntry(legacyEntry.id).tags, ['旧标签', '人工输入'])
    assert.equal(third.findEntry(legacyEntry.id).hidden, false)
    third.close()
  })

  // A vault written by a newer plugin must not be opened by an older one.
  const futurePath = join(dir, 'future.sqlite')
  new MemoryStore({ path: futurePath }).close()
  const rawFuture = new DatabaseSync(futurePath)
  rawFuture.prepare('UPDATE meta SET value = ? WHERE key = ?').run('99', 'schema_version')
  rawFuture.close()
  const refusedFuture = (() => {
    try {
      new MemoryStore({ path: futurePath }).close()
      return 'opened'
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  })()
  check('a vault from a newer plugin refuses to open instead of being downgraded', () => {
    assert.ok(String(refusedFuture).includes('更新版本'), String(refusedFuture))
  })

  // Orphaned references left behind by the older delete path are repaired once.
  const orphanPath = join(dir, 'orphan.sqlite')
  const orphanStore = new MemoryStore({ path: orphanPath })
  const doomed = orphanStore.createGroup({ name: '被绕过删除的组', scope: 'knowledge' })
  orphanStore.setApplications('session-orphan', [doomed.id])
  orphanStore.bindSession('session-orphan-bound', doomed.id)
  orphanStore.close()
  const rawOrphan = new DatabaseSync(orphanPath)
  // Delete the way the previous build did: the group alone, with no foreign key
  // on `applications` or `sessions.group_id` to catch the references.
  rawOrphan.prepare('DELETE FROM groups WHERE id = ?').run(doomed.id)
  rawOrphan.close()
  const repaired = new MemoryStore({ path: orphanPath, logger: { warn: () => {} } })
  check('opening the vault repairs references to a deleted group', () => {
    assert.equal(repaired.appliedGroups('session-orphan').groups.length, 0)
    assert.equal(repaired.sessionState('session-orphan-bound').groupId, null)
  })
  repaired.close()

  // Upgrading an older vault leaves something to recover from.
  const upgradePath = join(dir, 'upgrade.sqlite')
  new MemoryStore({ path: upgradePath }).close()
  const rawOld = new DatabaseSync(upgradePath)
  rawOld.prepare('UPDATE meta SET value = ? WHERE key = ?').run('1', 'schema_version')
  rawOld.close()
  const upgraded = new MemoryStore({ path: upgradePath, logger: { warn: () => {} } })
  check('upgrading an older vault writes a backup first', () => {
    assert.ok(existsSync(`${upgradePath}.v1.bak`), 'expected a .v1.bak beside the database')
  })
  check('the upgraded vault records the version it now has', () => {
    assert.equal(upgraded.readMeta('schema_version'), '2')
  })
  upgraded.close()
}

console.log('browser half')
{
  // The browser half is a plain script that hands a factory to the shell's
  // module loader. Stubbing that one call is enough to drive the pure helpers
  // the panel keeps, which are the parts no browser is needed for.
  let definition
  globalThis.window = {
    __ModuleLoader__: { load: (value) => { definition = value } },
    location: { origin: 'http://127.0.0.1:3080' },
    // The components add real listeners and timers; running their effects is
    // what lets the render tests see data instead of empty state.
    addEventListener: () => {},
    removeEventListener: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    confirm: () => true,
  }
  globalThis.document = { documentElement: { lang: 'zh-CN' } }
  await import('../client.js')
  check('the browser half registers itself under the package name', () => {
    assert.equal(definition.id, 'dsh-memory-vault')
  })

  /** Names the bundle asked the module table for. */
  const requested = []
  /** Minimal stand-ins for the shell primitives the bundle renders with. */
  const primitives = {
    Button: 'Button', Pill: 'Pill', Tag: 'Tag', Input: 'Input', Switch: 'Switch',
    Checkbox: 'Checkbox', MarkdownText: 'MarkdownText',
    extractMarkdownPlainText: (markdown) => String(markdown)
      .replace(/```[A-Za-z0-9_+-]*\n?/g, '')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/[*_`>|$#-]/g, ' '),
    IconSearchOutlineMedium: 'IconSearch', IconPlusOutlineMedium: 'IconPlus',
    IconRefreshOutlineMedium: 'IconRefresh', IconTrashOutlineMedium: 'IconTrash',
    IconChevronLeftOutlineMedium: 'IconChevronLeft', IconContextInjectionOutlineMedium: 'IconInjection',
  }
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Fragment: 'Fragment',
  }
  /** @param {string} specifier - Requested module. @returns {unknown} The stub. */
  const requireStub = (specifier) => {
    requested.push(specifier)
    if (specifier === 'react') return react
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`the bundle must not require ${specifier}`)
  }
  const plugin = definition.factory(requireStub)
  const { termsOf, tagsOf, autoTagOf, deriveTagInventory, plainPreview, highlighted } = plugin.helpers

  check('the bundle requires only baseline module table entries', () => {
    assert.deepEqual([...new Set(requested)].sort(), [
      '@deepseek-ai/dsh-client-ui-primitives', 'react',
    ])
    assert.deepEqual(plugin.inject, ['slots'])
    assert.equal(typeof plugin.apply, 'function')
  })
  check('search terms are lowercased, trimmed and de-duplicated', () => {
    assert.deepEqual(termsOf('  Pnpm   pnpm 构建 '), ['pnpm', '构建'])
    assert.deepEqual(termsOf(''), [])
  })
  check('provenance resolves with and without the Host-provided field', () => {
    assert.equal(autoTagOf({ source: 'auto-summary' }), 'AI自动总结')
    assert.equal(autoTagOf({ source: 'manual' }), '人工输入')
    assert.equal(autoTagOf({ source: 'panel' }), '人工输入')
    assert.equal(autoTagOf({ autoTag: '人工输入', source: 'auto-summary' }), '人工输入')
  })
  check('the system tag leads the tag list and never repeats', () => {
    assert.deepEqual(tagsOf({ source: 'auto-summary', tags: ['人工输入', '架构'] }), ['AI自动总结', '架构'])
    assert.deepEqual(tagsOf({ source: 'manual', tags: [] }), ['人工输入'])
  })
  check('the fallback tag inventory counts entries and orders system tags first', () => {
    const inventory = deriveTagInventory([
      { source: 'manual', tags: ['人工输入', '架构'] },
      { source: 'manual', tags: ['人工输入', '架构', 'dsh'] },
      { source: 'auto-summary', tags: ['AI自动总结'] },
    ])
    assert.deepEqual(inventory.map(item => item.tag), ['人工输入', '架构', 'AI自动总结', 'dsh'])
    assert.equal(inventory[0].count, 2)
    assert.equal(inventory[0].system, true)
    assert.equal(inventory[3].system, false)
  })
  check('tile previews reduce Markdown to one line and truncate', () => {
    const preview = plainPreview('## 标题\n\n- **粗体** 与 `代码`', 200)
    assert.ok(preview.includes('标题'))
    assert.ok(preview.includes('粗体'))
    assert.ok(!preview.includes('#') && !preview.includes('*') && !preview.includes('`'))
    assert.ok(!preview.includes('\n'))
    assert.ok(plainPreview('x'.repeat(400), 40).endsWith('…'))
  })
  check('search terms are wrapped in highlight marks', () => {
    const nodes = highlighted('构建脚本：pnpm 构建', ['构建'])
    const marks = nodes.filter(node => typeof node === 'object' && node.type === 'mark')
    assert.equal(marks.length, 2)
    assert.equal(marks[0].children[0], '构建')
    assert.equal(highlighted('无匹配', ['zzz']), '无匹配')
    assert.equal(highlighted('原样', []), '原样')
  })

  // The slot registrations are the contract with the shell: a wrong id, order,
  // or label silently loses the sidebar entry or the tab.
  const registrations = []
  const components = new Map()
  plugin.apply({
    get: () => undefined,
    effect: (run) => { run() },
    slots: {
      inject: (_name, run) => {
        const result = run()
        if (result !== null && typeof result === 'object' && typeof result.next === 'function') {
          while (result.next().done !== true) { /* drain the generator so it registers */ }
        }
      },
      register: (options, component) => {
        registrations.push(options)
        components.set(options.name, component)
        return () => {}
      },
    },
  })
  const registration = (name) => registrations.find(options => options.name === name)

  /**
   * Render one registered component once, with the shell's hooks stubbed.
   *
   * A single pass is enough to catch the class of bug that leaves a tab blank:
   * an identifier that only exists inside another component's scope throws the
   * moment the body runs.
   * @param {string} name - Slot name the component registered into.
   * @param {Record<string, unknown>} props - Business props for the component.
   * @returns {Record<string, any>} The element tree the component built.
   */
  const cells = []
  const effects = []
  let cursor = 0
  Object.assign(react, {
    useState: (initial) => {
      const at = cursor++
      if (!(at in cells)) cells[at] = typeof initial === 'function' ? initial() : initial
      return [cells[at], (next) => { cells[at] = typeof next === 'function' ? next(cells[at]) : next }]
    },
    useCallback: (run) => { cursor += 1; return run },
    useEffect: (run) => { cursor += 1; effects.push(run) },
    useMemo: (run) => { cursor += 1; return run() },
    useRef: (value) => {
      const at = cursor++
      cells[at] = cells[at] ?? { current: value }
      return cells[at]
    },
  })
  const renderSlot = (name, props) => {
    const component = components.get(name)
    assert.ok(component !== undefined, `slot ${name} must have registered a component`)
    // Hook slots belong to one component: carrying them into the next render
    // would hand a component another component's state.
    cursor = 0
    cells.length = 0
    effects.length = 0
    return component(props)
  }

  /**
   * Render a component, run its effects against a stubbed vault, and render again.
   * @param {string} name - Slot name.
   * @param {Record<string, unknown>} props - Business props.
   * @returns {Promise<Record<string, any>>} The second render's tree, with data.
   */
  const renderWithData = async (name, props) => {
    renderSlot(name, props)
    for (const run of [...effects]) run()
    await new Promise(resolve => setTimeout(resolve, 0))
    cursor = 0
    effects.length = 0
    return components.get(name)(props)
  }

  // A stubbed transport: the components fetch real shapes, so the render tests
  // exercise the tree the browser would build rather than its empty state.
  const sampleGroup = {
    id: 'grp-1', name: '知识库', scope: 'knowledge', description: '跨会话复用', tags: [],
    sessionId: null, autoSummary: false, entryCount: 2, createdAt: 1, updatedAt: 2,
  }
  const sampleEntry = {
    id: 'mem-1', groupId: 'grp-1', groupName: '知识库', scope: 'knowledge', assigned: 'group',
    title: '构建约定', content: '**统一用 pnpm**。', kind: 'decision', source: 'manual', sessionId: null,
    tags: ['人工输入', '构建'], hidden: false, autoTag: '人工输入', createdAt: 1, updatedAt: 2,
  }
  globalThis.fetch = async (url) => {
    const op = new URL(String(url)).searchParams.get('op')
    const results = {
      state: {
        stats: { groups: { conversation: 1, knowledge: 1 }, entries: { conversation: 0, knowledge: 1 }, hidden: 0, totals: { groups: 2, entries: 1, hidden: 0 } },
        groups: [sampleGroup], tags: [{ tag: '人工输入', count: 1, system: true }],
        scopes: ['conversation', 'knowledge'], kinds: ['note'],
        limits: { searchLimit: 20, maxEntryChars: 20000 },
        autoSummary: true, summarizer: 'llm',
        apply: { byDefault: true, defaults: ['知识库'], maxEntries: 12, maxChars: 2400 },
      },
      entries: { entries: [sampleEntry], group: null, limit: 120, offset: 0, hasMore: false, nextOffset: null },
      'apply.get': {
        sessionId: 's1', explicit: false, groups: [], effective: 'default', enabled: true,
        injected: 1, truncated: false, skipped: [], usedChars: 12, entries: [sampleEntry],
        effectiveGroups: ['grp-1'], boundGroupId: null, defaultGroupId: 'grp-0',
        defaults: ['知识库'], applyByDefault: true, maxEntries: 12, maxChars: 2400,
      },
      'session.bind': { sessionId: 's1', groupId: null, group: null },
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: results[op] ?? {} }),
    }
  }

  check('the knowledge view renders without reaching out of its own scope', () => {
    const tree = renderSlot('conversation.view', { sessionId: 'session-render', t: (key) => key, markdownLabels: {} })
    assert.equal(tree.type, 'div')
    assert.ok(JSON.stringify(tree).length > 0)
  })
  check('the board renders too', () => {
    const tree = renderSlot('main', { t: (key) => key, markdownLabels: {} })
    assert.equal(tree.type, 'div')
  })

  /**
   * Expand a tree into host elements, rendering nested components the way React
   * would, so assertions see the shape the browser builds rather than the
   * component elements that produce it.
   * @param {unknown} node - Node to expand.
   * @param {number} [depth] - Recursion guard.
   * @returns {Record<string, any>[]} Host elements.
   */
  const allElements = (node, depth = 0) => {
    if (node === null || node === undefined || typeof node !== 'object') return []
    if (Array.isArray(node)) return node.flatMap(item => allElements(item, depth))
    if (depth > 40) return []
    if (typeof node.type === 'function') {
      // Each component gets its own hook frame; sharing one would hand a child
      // the parent's state.
      const frame = { cursor, cells: [...cells], effects: [...effects] }
      cursor = 0
      cells.length = 0
      effects.length = 0
      let rendered
      try {
        // React hands a component its children through props; keeping them in a
        // side field would drop every element a parent passes down.
        const children = node.children.length === 0
          ? undefined
          : node.children.length === 1 ? node.children[0] : node.children
        rendered = node.type({ ...(node.props ?? {}), children })
      } finally {
        cursor = frame.cursor
        cells.length = 0
        cells.push(...frame.cells)
        effects.length = 0
        effects.push(...frame.effects)
      }
      return allElements(rendered, depth + 1)
    }
    const children = Array.isArray(node.children)
      ? node.children.flatMap(child => allElements(child, depth))
      : []
    return [node, ...children]
  }
  const withClass = (tree, className) => allElements(tree)
    .filter(element => String(element.props?.className ?? '').split(' ').includes(className))

  const boardTree = await renderWithData('main', { t: (key) => key, markdownLabels: {} })
  const knowledgeTree = await renderWithData('conversation.view', { sessionId: 's1', t: (key) => key, markdownLabels: {} })

  check('the board renders the memories it loaded', () => {
    const classes = [...new Set(allElements(boardTree).map(node => node.props?.className).filter(Boolean))]
    assert.equal(withClass(boardTree, 'dsmv-tile').length, 1, classes.join(','))
  })
  check('board tiles are operable without a pointer', () => {
    const tile = withClass(boardTree, 'dsmv-tile')[0]
    assert.equal(tile.props.role, 'button')
    assert.equal(tile.props.tabIndex, 0)
    assert.equal(typeof tile.props.onKeyDown, 'function')
    assert.equal(tile.props['aria-label'], '构建约定')
  })
  check('tag controls are operable without a pointer', () => {
    const tags = withClass(boardTree, 'dsmv-tagbtn')
    assert.ok(tags.length > 0)
    for (const tag of tags) {
      assert.equal(tag.props.role, 'button')
      assert.equal(tag.props.tabIndex, 0)
      assert.equal(typeof tag.props.onKeyDown, 'function')
    }
  })
  check('knowledge group tiles are operable without a pointer', () => {
    const tiles = [...withClass(knowledgeTree, 'dsmv-gtile')]
    assert.ok(tiles.length > 0)
    for (const tile of tiles) {
      assert.equal(tile.props.role, 'button')
      assert.equal(tile.props.tabIndex, 0)
      assert.equal(typeof tile.props.onKeyDown, 'function')
      assert.equal(tile.props['aria-pressed'], false)
    }
  })
  check('the knowledge view shows the injected memory the plan reported', () => {
    assert.equal(withClass(knowledgeTree, 'dsmv-kitem').length, 1)
  })

  check('the panel, the sidebar entry, and the knowledge view are contributed', () => {
    assert.deepEqual(registrations.map(options => options.name).sort(), [
      'conversation.view', 'main', 'sidebar.panellist',
    ])
  })
  check('the knowledge view is a conversation tab ordered after chat and trajectory', () => {
    const view = registration('conversation.view')
    assert.equal(view.id, 'memory-vault')
    assert.equal(view.order, 20)
    assert.equal(view.label(), '知识')
    assert.equal(typeof view.inject, 'function')
  })
  check('the board is a main panel keyed by the panel id', () => {
    const main = registration('main')
    assert.equal(main.key, 'memory-vault')
    assert.deepEqual(Object.keys(main.inject()).sort(), ['markdownLabels', 't'])
  })
  check('the sidebar entry opens that same panel id', () => {
    const entry = registration('sidebar.panellist')
    assert.equal(entry.id, registration('main').key)
    assert.equal(typeof entry.label(), 'string')
    assert.ok(entry.label().length > 0)
  })
  check('nothing is registered into the composer dock any more', () => {
    assert.equal(registration('conversation.input.dock'), undefined)
  })

  delete globalThis.window
  delete globalThis.document
}

console.log('regressions from the review')

// F01 — RFC 9110 §9.2.1: the operation decides, not the method. Every write
// must be unreachable over a safe method, marker header or not.
const writeOperations = [
  'entry.write', 'entry.update', 'entry.delete', 'entry.hide',
  'group.create', 'group.update', 'group.delete', 'assign', 'apply.set', 'session.bind',
]
const methodAttempts = []
for (const op of writeOperations) {
  methodAttempts.push({ op, response: await request(panelRoute, 'GET', `/memory-vault?op=${op}&id=nope`, undefined, {}, false) })
}
check('no write operation is reachable by GET, with or without the marker', () => {
  for (const attempt of methodAttempts) {
    assert.equal(attempt.response.status, 405, `${attempt.op} answered ${String(attempt.response.status)}`)
  }
})
const survives = await request(panelRoute, 'GET', '/memory-vault?op=state')
check('the group a forged GET aimed at is still there', () => {
  assert.ok(survives.payload.result.groups.some(group => group.id === knowledgeGroupId))
})
const safeRead = await request(panelRoute, 'GET', '/memory-vault?op=entries&limit=1', undefined, {}, false)
check('a read still works from a plain GET without the marker', () => {
  assert.equal(safeRead.status, 200)
})

// F07 — a request for more rows than the default page must be honoured, and the
// rest of the vault must stay reachable.
const PAGING_GROUP = '%E5%88%86%E9%A1%B5%E6%B5%8B%E8%AF%95'
await tool('memory_group').execute({ action: 'create', name: '分页测试', scope: 'knowledge' }, exec)
for (let batch = 0; batch < 3; batch += 1) {
  await tool('memory_write').execute({
    group: '分页测试',
    entries: Array.from({ length: 50 }, (_unused, index) => ({ content: `分页样本 ${String(batch * 50 + index)}` })),
  }, exec)
}
const pageOne = await request(panelRoute, 'GET', `/memory-vault?op=entries&group=${PAGING_GROUP}&limit=120`)
check('a page honours the requested limit and says there is more', () => {
  assert.equal(pageOne.payload.result.entries.length, 120)
  assert.equal(pageOne.payload.result.hasMore, true)
  assert.equal(pageOne.payload.result.nextOffset, 120)
})
const pageTwo = await request(panelRoute, 'GET', `/memory-vault?op=entries&group=${PAGING_GROUP}&limit=120&offset=120`)
check('the remaining rows are reachable through the offset', () => {
  assert.equal(pageTwo.payload.result.entries.length, 30)
  assert.equal(pageTwo.payload.result.hasMore, false)
})
check('the two pages do not overlap', () => {
  const first = new Set(pageOne.payload.result.entries.map(entry => entry.id))
  assert.ok(pageTwo.payload.result.entries.every(entry => !first.has(entry.id)))
})
const badLimit = await request(panelRoute, 'GET', '/memory-vault?op=entries&limit=abc')
check('a non-numeric limit is refused rather than silently defaulted', () => {
  assert.equal(badLimit.status, 400)
  assert.ok(String(badLimit.payload.error).includes('limit'))
})

// F08 — one rule, three entry points.
const bigBody = 'x'.repeat(201)
const toolRefusal = await tool('memory_write').execute({ group: '分页测试', entries: [{ content: bigBody }] }, exec)
  .then(() => 'accepted', (error) => error.message)
check('the model tool refuses an oversized body', () => {
  assert.ok(String(toolRefusal).includes('超过'), String(toolRefusal))
})
const httpRefusal = await request(panelRoute, 'POST', '/memory-vault', { op: 'entry.write', group: '分页测试', content: bigBody })
check('the panel route refuses the same body with the same rule', () => {
  assert.equal(httpRefusal.status, 400)
  assert.ok(String(httpRefusal.payload.error).includes('超过'), String(httpRefusal.payload.error))
})
const kindRefusal = await request(panelRoute, 'POST', '/memory-vault', {
  op: 'entry.write', group: '分页测试', content: '合法正文', kind: '不存在的类型',
})
check('an unknown kind is refused instead of stored verbatim', () => {
  assert.equal(kindRefusal.status, 400)
})

// F05 — a batch is all-or-nothing.
const countPages = async () => (await request(panelRoute, 'GET', `/memory-vault?op=entries&group=${PAGING_GROUP}&limit=500`)).payload.result.entries.length
const beforeBatch = await countPages()
const batchRefusal = await tool('memory_write').execute({
  group: '分页测试',
  entries: [{ content: '第一条本身合法' }, { content: bigBody }],
}, exec).then(() => 'accepted', (error) => error.message)
const afterBatch = await countPages()
check('a batch that fails on its last entry writes nothing at all', () => {
  assert.ok(String(batchRefusal).includes('第 2 条'), String(batchRefusal))
  assert.equal(afterBatch, beforeBatch)
})

// F12 — tags are stored as JSON, so membership must be tested on the element.
const quotedTag = await tool('memory_write').execute({
  group: '分页测试',
  entries: [{ content: '带特殊字符标签的记忆。', tags: ['a"b', '反斜杠\\标签'] }],
}, exec)
const foundQuoted = await tool('memory_recall').execute({ tag: 'a"b' }, exec)
check('a tag containing a quote is findable by its own value', () => {
  assert.equal(foundQuoted.entries.length, 1)
  assert.equal(foundQuoted.entries[0].id, quotedTag.entries[0].id)
})
const foundBackslash = await tool('memory_recall').execute({ tag: '反斜杠\\标签' }, exec)
check('a tag containing a backslash round-trips too', () => {
  assert.equal(foundBackslash.entries.length, 1)
})

// F03 — the default group is read fresh, so its switch takes effect at once.
const seededDefaults = await tool('memory_group').execute({ action: 'list' }, exec)
const defaultConversation = seededDefaults.groups.find(group => group.name === '对话记忆')
await tool('memory_group').execute({ action: 'update', id: defaultConversation.id, autoSummary: false }, exec)
const callsBeforeQuiet = sink.calls.length
for (const event of [
  { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: '这条不该触发模型调用。' }], source: { kind: 'user' } } },
  { type: 'assistant/message', seq: 2, time: 2, data: { message: { content: [{ type: 'text', text: '收到。' }] } } },
  { type: 'turn/end', seq: 3, time: 3, data: {} },
]) {
  harness.handlers.get('session/event')(sessionStub('session-quiet'), event)
}
await new Promise(resolve => setTimeout(resolve, 60))
check('turning the default group off stops the model call immediately', () => {
  assert.equal(sink.calls.length, callsBeforeQuiet)
})
await tool('memory_group').execute({ action: 'update', id: defaultConversation.id, autoSummary: true }, exec)
const deleteDefault = await request(panelRoute, 'POST', '/memory-vault', { op: 'group.delete', id: defaultConversation.id })
check('a seeded default group refuses deletion instead of vanishing', () => {
  assert.equal(deleteDefault.status, 400)
  assert.ok(String(deleteDefault.payload.error).includes('默认记忆组'), String(deleteDefault.payload.error))
})

// F04 — a session can point its summaries at its own group.
const boundGroup = await tool('memory_group').execute({
  action: 'create', name: '会话专属', scope: 'conversation', autoSummary: true,
}, exec)
const bindExec = { agent: { session: sessionStub('session-bind') }, signal: new AbortController().signal }
const bindResult = await tool('memory_group').execute({ action: 'bind', name: '会话专属' }, bindExec)
const boundSummary = await tool('memory_summarize').execute({ content: '绑定验证：这条应当写入绑定组。' }, bindExec)
check('a bound session summarizes into its own group without naming it', () => {
  assert.equal(boundSummary.group.name, '会话专属')
  assert.equal(boundSummary.entry.groupId, boundGroup.group.id)
})
const unbound = await tool('memory_group').execute({ action: 'unbind' }, bindExec)
const unboundSummary = await tool('memory_summarize').execute({ content: '解绑验证：这条应当回到默认组。' }, bindExec)
check('unbinding sends the next summary back to the default group', () => {
  assert.equal(unbound.action, 'unbind')
  assert.equal(unboundSummary.group.name, '对话记忆')
})
check('the binding is reported in words the model can act on', () => {
  const blocks = tool('memory_group').output.render({ action: 'bind' }, bindResult)
  assert.ok(String(blocks[0].text).includes('会话专属'), String(blocks[0].text))
})

// F11 — deleting a group leaves no references behind.
await request(panelRoute, 'POST', '/memory-vault', { op: 'apply.set', sessionId: 'session-cleanup', groups: ['会话专属'] })
const beforeCleanup = await request(panelRoute, 'GET', '/memory-vault?op=apply.get&sessionId=session-cleanup')
check('the group is applied before the delete', () => {
  assert.equal(beforeCleanup.payload.result.groups.length, 1)
})
await request(panelRoute, 'POST', '/memory-vault', { op: 'group.delete', id: boundGroup.group.id })
const afterCleanup = await request(panelRoute, 'GET', '/memory-vault?op=apply.get&sessionId=session-cleanup')
check('deleting a group also removes its applications', () => {
  assert.equal(afterCleanup.payload.result.groups.length, 0)
})

// F06 — two runs over the same increment must not both commit.
const raceExec = { agent: { session: sessionStub('session-race') }, signal: new AbortController().signal }
harness.handlers.get('session/event')(sessionStub('session-race'), {
  type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: '并发总结样本。' }], source: { kind: 'user' } },
})
const race = await Promise.allSettled([
  tool('memory_summarize').execute({ group: '知识库' }, raceExec),
  tool('memory_summarize').execute({ group: '知识库' }, raceExec),
])
check('concurrent summarizations of one session commit exactly once', () => {
  const fulfilled = race.filter(result => result.status === 'fulfilled')
  const refused = race.filter(result => result.status === 'rejected')
  assert.equal(fulfilled.length, 1)
  assert.equal(refused.length, 1)
  assert.ok(String(refused[0].reason.message).includes('进行中'), String(refused[0].reason.message))
})

// F10 — the tag follows how the text was produced, not which button started it.
harness.handlers.get('session/event')(sessionStub('session-model-tag'), {
  type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: '模型标签样本。' }], source: { kind: 'user' } },
})
const modelTagExec = { agent: { session: sessionStub('session-model-tag') }, signal: new AbortController().signal }
const modelWritten = await tool('memory_summarize').execute({ group: '知识库' }, modelTagExec)
check('a model-written record is tagged as generated even when asked for by hand', () => {
  assert.equal(modelWritten.entry.source, 'model-summary')
  assert.ok(modelWritten.entry.tags.includes('AI自动总结'), JSON.stringify(modelWritten.entry.tags))
})
const handWritten = await tool('memory_summarize').execute({ group: '知识库', content: '手写结论。' }, exec)
check('a caller-written record stays hand-written', () => {
  assert.ok(handWritten.entry.tags.includes('人工输入'))
})

// F09 — the preview and the prompt read the same plan.
const planProbe = await request(panelRoute, 'GET', '/memory-vault?op=apply.get&sessionId=session-plan-probe')
check('the knowledge plan reports effective groups, skips and budget', () => {
  const result = planProbe.payload.result
  assert.ok(Array.isArray(result.effectiveGroups))
  assert.equal(typeof result.enabled, 'boolean')
  assert.ok(Array.isArray(result.skipped))
  assert.equal(result.injected, result.entries.length)
  assert.equal(typeof result.usedChars, 'number')
})

console.log('disposal')
harness.dispose()
check('disposal closes the vault', () => {
  rmSync(dir, { recursive: true, force: true })
})

console.log(failures.length === 0 ? '\nall smoke checks passed' : `\n${String(failures.length)} check(s) failed: ${failures.join(', ')}`)
process.exitCode = failures.length === 0 ? 0 : 1
