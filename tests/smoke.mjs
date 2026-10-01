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
import { MemoryStore, SCHEMA_VERSION } from '../src/store.js'

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
 * One stub answers both out-of-band calls the vault makes: the summarizer asks
 * for prose, the curator asks for JSON, and the system prompt says which.
 * @param {{ messages?: unknown }} options - Call options.
 * @returns {string} The answer to yield.
 */
function curationAnswer(options) {
  const body = JSON.stringify(options.messages ?? [])
  const ids = [...body.matchAll(/id:\s*(mem_[0-9a-f-]+)/g)].map(match => match[1])
  // Every answer carries labels as well as a verdict, and one merge for the
  // whole vault: labelling is part of curating, not a second pass.
  const items = ids.map((id, index) => index === 0
    ? { id, verdict: 'reusable', reason: '换个会话仍然成立', group: '整理产出的知识', tags: ['规范标签', '整理'] }
    : { id, verdict: 'oneoff', reason: '只对本次任务成立', group: '', tags: ['规范标签'] })
  return JSON.stringify({
    items,
    tagMap: [
      { from: '旧标签', to: '统一标签', reason: '同一个概念的两种写法' },
      // Hostile entries: the vault owns its system tags, so neither of these
      // may do anything, however the answer is worded.
      { from: 'AI 生成', to: '机器写的', reason: '敌意样本' },
      { from: '保留', to: '人工输入', reason: '想把用户标签搬到系统标签上' },
    ],
  })
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
      const answer = String(options.system ?? '').includes('知识库整理器') ? curationAnswer(options) : text
      yield { type: 'text-delta', text: answer }
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
  // The deployment's own default route, which is what a call belonging to no
  // session should use — the vault never sees the credential behind it.
  agentDefaultModel: { currentSelection: () => ({ provider: 'ds-default', model: 'ds-model' }) },
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
  // Deliberately no summarizerProvider/summarizerModel: a panel-initiated call
  // must reach a model on the route of the last observed turn instead.
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
check('nine tools are registered', () => {
  assert.deepEqual([...harness.tools.keys()].sort(), [
    'memory_apply', 'memory_assign', 'memory_curate', 'memory_group', 'memory_image', 'memory_recall',
    'memory_summarize', 'memory_updates', 'memory_write',
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

console.log('origin: 人工输入 vs AI 生成')
check('a memory the model writes is tagged AI 生成, never 人工输入', () => {
  assert.equal(written.entries[0].autoTag, 'AI 生成')
  assert.ok(written.entries[0].tags.includes('AI 生成'))
  assert.equal(written.entries[0].source, 'model-write')
  assert.equal(written.entries[0].modelWritten, true)
})
const forged = await tool('memory_write').execute({
  group: '知识库',
  entries: [{ content: '试图伪装成 AI 总结。', tags: ['AI自动总结', '真实标签'] }],
}, exec)
check('the system tag follows provenance, not the caller', () => {
  // A model write cannot pass itself off as human input, and the legacy tag a
  // caller supplies is stripped rather than stored.
  assert.deepEqual(forged.entries[0].tags, ['真实标签', 'AI 生成'])
})
const tagged = await tool('memory_recall').execute({ tag: 'AI 生成' }, exec)
check('the system tag filters the vault', () => {
  assert.ok(tagged.entries.length >= 2)
  assert.ok(tagged.entries.every(entry => entry.tags.includes('AI 生成')))
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
const afterHide = await tool('memory_recall').execute({ tag: 'AI 生成' }, exec)
check('a hidden memory leaves every default read', () => {
  assert.ok(!afterHide.entries.some(entry => entry.id === forged.entries[0].id))
})
const withHidden = await tool('memory_recall').execute({ tag: 'AI 生成', includeHidden: true }, exec)
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
  assert.ok(tags.some(item => item.tag === 'AI 生成' && item.system === true))
  assert.ok(tags.some(item => item.tag === '构建' && item.system === false))
})
check('state publishes the deployment default the panel shows', () => {
  assert.equal(state.payload.result.apply.byDefault, true)
  assert.deepEqual(state.payload.result.apply.defaults, ['知识库'])
})
const byTag = await request(panelRoute, 'GET', '/memory-vault?op=entries&tag=AI%20%E7%94%9F%E6%88%90')
check('the panel can filter by tag', () => {
  assert.ok(byTag.payload.result.entries.length >= 2)
  assert.ok(byTag.payload.result.entries.every(entry => entry.tags.includes('AI 生成')))
})
const stripped = await request(panelRoute, 'POST', '/memory-vault', { op: 'entry.update', id: forged.entries[0].id, tags: [] })
check('clearing tags through the panel keeps the provenance tag', () => {
  assert.deepEqual(stripped.payload.result.entry.tags, ['AI 生成'])
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

console.log('origin migration: 人工输入 vs AI 生成')
{
  // A v4 vault as the old code left it: the model's own writes were filed as
  // `manual` with a session id, and machine-written rows carried the tag that
  // only named the summarizer.
  const v4Path = join(dir, 'origin-v4.sqlite')
  const v4 = new MemoryStore({ path: v4Path })
  const v4Group = v4.createGroup({ name: 'v4 组', scope: 'knowledge' })
  const byModel = v4.createEntry({
    groupId: v4Group.id, content: '模型在会话里写下的结论。', source: 'manual', sessionId: 'session-old',
  })
  const byPerson = v4.createEntry({ groupId: v4Group.id, content: '人在面板里手写的。', source: 'panel' })
  const bySummary = v4.createEntry({ groupId: v4Group.id, content: '自动总结出来的。', source: 'auto-summary' })
  // The trap: summarizing with a caller-supplied body records `manual` and a
  // session id, exactly like a model write — but that body may be a person's
  // words, so the migration must not convict it.
  const byManualSummary = v4.createEntry({
    groupId: v4Group.id, content: '手动总结时由人给出的正文。', source: 'manual', sessionId: 'session-old', kind: 'summary',
  })
  v4.close()
  const rawV4 = new DatabaseSync(v4Path)
  rawV4.prepare('UPDATE entries SET tags = ? WHERE id = ?').run(JSON.stringify(['人工输入', '架构']), byModel.id)
  rawV4.prepare('UPDATE entries SET tags = ? WHERE id = ?').run(JSON.stringify(['AI自动总结']), bySummary.id)
  rawV4.exec('PRAGMA user_version = 4')
  rawV4.close()

  const migrated = new MemoryStore({ path: v4Path })
  check('a model-written row from the old schema is reclassified as AI-written', () => {
    const entry = migrated.findEntry(byModel.id)
    assert.equal(entry.source, 'model-write')
    assert.equal(entry.modelWritten, true)
    // The migration rewrites the tag in place, so it keeps the position it had;
    // display order is decided by the readers, not by the stored array.
    assert.deepEqual(entry.tags, ['AI 生成', '架构'])
  })
  check('a hand-written row keeps 人工输入', () => {
    const entry = migrated.findEntry(byPerson.id)
    assert.equal(entry.source, 'panel')
    assert.equal(entry.modelWritten, false)
    assert.ok(entry.tags.includes('人工输入'))
  })
  check('the retired tag is rewritten wherever it survived', () => {
    const entry = migrated.findEntry(bySummary.id)
    assert.ok(entry.tags.includes('AI 生成'), JSON.stringify(entry.tags))
    assert.ok(!entry.tags.includes('AI自动总结'), JSON.stringify(entry.tags))
  })
  check('a summarizing path that only looks like a model write is left alone', () => {
    const entry = migrated.findEntry(byManualSummary.id)
    assert.equal(entry.source, 'manual')
    assert.equal(entry.modelWritten, false)
    assert.ok(entry.tags.includes('人工输入'), JSON.stringify(entry.tags))
  })
  check('a caller cannot reintroduce the retired tag', () => {
    const smuggled = migrated.createEntry({
      groupId: v4Group.id, content: '试图塞回旧标签。', tags: ['AI自动总结', '人工输入', '保留'],
    })
    assert.deepEqual(smuggled.tags, ['保留', '人工输入'])
  })
  check('origin scoping reads the migrated rows correctly', () => {
    const generated = migrated.listEntries({ origin: 'generated' }).map(entry => entry.id)
    const manual = migrated.listEntries({ origin: 'manual' }).map(entry => entry.id)
    assert.ok(generated.includes(byModel.id) && generated.includes(bySummary.id))
    assert.ok(!generated.includes(byPerson.id))
    assert.ok(manual.includes(byPerson.id) && !manual.includes(byModel.id))
  })
  migrated.close()
}

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
    assert.equal(upgraded.readMeta('schema_version'), String(SCHEMA_VERSION))
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
    assert.equal(autoTagOf({ source: 'auto-summary' }), 'AI 生成')
    assert.equal(autoTagOf({ source: 'model-write' }), 'AI 生成')
    assert.equal(autoTagOf({ source: 'manual' }), '人工输入')
    assert.equal(autoTagOf({ source: 'panel' }), '人工输入')
    assert.equal(autoTagOf({ autoTag: '人工输入', source: 'auto-summary' }), '人工输入')
  })
  check('the system tag leads the tag list and never repeats', () => {
    assert.deepEqual(tagsOf({ source: 'auto-summary', tags: ['人工输入', '架构'] }), ['AI 生成', '架构'])
    assert.deepEqual(tagsOf({ source: 'model-write', tags: ['AI自动总结', '架构'] }), ['AI 生成', '架构'])
    assert.deepEqual(tagsOf({ source: 'manual', tags: [] }), ['人工输入'])
  })
  check('the fallback tag inventory counts entries and orders system tags first', () => {
    const inventory = deriveTagInventory([
      { source: 'manual', tags: ['人工输入', '架构'] },
      { source: 'model-write', tags: ['人工输入', '架构', 'dsh'] },
      { source: 'auto-summary', tags: ['AI 生成'] },
    ])
    // Sorted by count, then system tags first, then by name: 架构 and AI 生成
    // both have two, and the system tag wins the tie.
    assert.deepEqual(inventory.map(item => item.tag), ['AI 生成', '架构', '人工输入', 'dsh'])
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
    tags: ['人工输入', '构建'], hidden: false, priority: 90, base: true, autoTag: '人工输入', createdAt: 1, updatedAt: 2,
  }
  // A second live memory under a different label, so one group has two buckets,
  // and a hidden one, so the board has something to quarantine.
  const secondEntry = {
    id: 'mem-2', groupId: 'grp-1', groupName: '知识库', scope: 'knowledge', assigned: 'group',
    title: '发布流程', content: '先打 tag 再发 Release。', kind: 'note', source: 'model-write', sessionId: null,
    tags: ['AI 生成', '发布'], hidden: false, priority: 0, base: false, autoTag: 'AI 生成', createdAt: 3, updatedAt: 4,
  }
  const hiddenEntry = {
    id: 'mem-3', groupId: 'grp-1', groupName: '知识库', scope: 'knowledge', assigned: 'group',
    title: '过时结论', content: '已被后续结论取代。', kind: 'note', source: 'model-write', sessionId: null,
    tags: ['AI 生成', '构建'], hidden: true, priority: 0, base: false, autoTag: 'AI 生成', createdAt: 5, updatedAt: 6,
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
      entries: {
        entries: [sampleEntry, secondEntry, hiddenEntry],
        group: null, limit: 120, offset: 0, hasMore: false, nextOffset: null,
      },
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

  // The render tests echo dictionary keys, except where a label is asserted:
  // the priority badge is built from one, so it needs a real value here.
  const testT = (key) => (key === 'priorityShort' ? 'P' : key)
  const boardTree = await renderWithData('main', { t: testT, markdownLabels: {} })
  const knowledgeTree = await renderWithData('conversation.view', { sessionId: 's1', t: (key) => key, markdownLabels: {} })

  check('the board renders the memories it loaded', () => {
    const classes = [...new Set(allElements(boardTree).map(node => node.props?.className).filter(Boolean))]
    // Three loaded, three drawn: the hidden one is quarantined, not dropped.
    assert.equal(withClass(boardTree, 'dsmv-tile').length, 3, classes.join(','))
  })
  check('one group splits its tiles by their own label', () => {
    // Two live memories, two different first tags: two sub-headings.
    assert.equal(withClass(boardTree, 'dsmv-subhead').length, 2)
  })
  check('hidden memories are quarantined to the end of the board', () => {
    // The tile's own props live on the div it renders, so its label is the
    // accessible name rather than the entry object.
    const titles = withClass(boardTree, 'dsmv-tile').map(node => node.props['aria-label'])
    assert.deepEqual(titles.slice(-1), ['过时结论'], titles.join('|'))
    assert.ok(!titles.slice(0, -1).includes('过时结论'), 'a hidden tile must not sit among the live ones')
  })
  check('a prioritised memory shows its priority on the tile', () => {
    // Expanded, because the badge lives inside the Tile component rather than
    // in the element the board itself builds.
    const tree = JSON.stringify(allElements(boardTree))
    assert.ok(tree.includes('P90'), 'the tile must mark a raised priority')
    assert.ok(tree.includes('baseBadge'), 'and mark a base-prompt memory')
  })
  check('the board offers a curation button of its own', () => {
    const tree = JSON.stringify(allElements(boardTree))
    // One press files the verdicts; the scope pills say which origin is judged.
    assert.ok(tree.includes('curateNow'), 'curation must be reachable in one press')
    assert.ok(tree.includes('curateScopeGenerated'))
    assert.ok(tree.includes('curateScopeAll'))
    assert.ok(tree.includes('select'))
  })
  check('the group manager can nest and move groups', () => {
    const tree = JSON.stringify(allElements(boardTree))
    assert.ok(tree.includes('parentTop'), 'creating a group must offer a parent')
    assert.ok(tree.includes('parentHint'), 'moving an existing group must be possible')
  })
  check('a tile offers to edit its tags in place', () => {
    assert.ok(JSON.stringify(allElements(boardTree)).includes('editTags'))
  })
  check('board tiles are operable without a pointer', () => {
    const tiles = withClass(boardTree, 'dsmv-tile')
    assert.ok(tiles.length > 0)
    for (const tile of tiles) {
      assert.equal(tile.props.role, 'button')
      assert.equal(tile.props.tabIndex, 0)
      assert.equal(typeof tile.props.onKeyDown, 'function')
      assert.equal(typeof tile.props['aria-label'], 'string')
    }
    // Title order is not asserted: sub-headings sort by size and then by name,
    // so which tile comes first is a presentation choice, not a contract.
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

  // The new-conversation strip: the only surface a blank session can reach,
  // because the shell renders no conversation views while a session is blank.
  const blankStrip = await renderWithData('conversation.input.dock', {
    sessionId: 's1', session: { blank: true }, t: (key) => key, markdownLabels: {},
  })
  const startedStrip = await renderWithData('conversation.input.dock', {
    sessionId: 's1', session: { blank: false }, t: (key) => key, markdownLabels: {},
  })
  check('the memory strip renders while the conversation is blank', () => {
    assert.equal(withClass(blankStrip, 'dsmv-dock').length, 1)
    assert.ok(withClass(blankStrip, 'dsmv-tagbtn').length + 1 > 0)
  })
  check('the memory strip disappears once the conversation has started', () => {
    assert.equal(startedStrip, null)
  })
  check('the strip offers every memory group as a choice', () => {
    const strip = JSON.stringify(blankStrip)
    assert.ok(strip.includes('知识库'), 'the seeded group must be offered')
  })

  check('the panel, the sidebar entry, the knowledge view and the new-conversation strip are contributed', () => {
    assert.deepEqual(registrations.map(options => options.name).sort(), [
      'conversation.input.dock', 'conversation.view', 'main', 'sidebar.panellist',
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
  check('the new-conversation memory strip is a composer dock entry', () => {
    const dock = registration('conversation.input.dock')
    assert.ok(dock !== undefined, 'the blank-session strip must register into the dock')
    assert.equal(dock.id, 'memory-vault')
    assert.equal(dock.order, 30)
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
  assert.ok(modelWritten.entry.tags.includes('AI 生成'), JSON.stringify(modelWritten.entry.tags))
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

console.log('knowledge priority and index')

const prioGroup = await tool('memory_group').execute({
  action: 'create', name: '优先级测试', scope: 'knowledge', priority: 80,
}, exec)
check('a memory group carries its priority', () => {
  assert.equal(prioGroup.group.priority, 80)
})
const clampedGroup = await tool('memory_group').execute({ action: 'update', id: prioGroup.group.id, priority: 500 }, exec)
check('an out-of-range group priority is clamped to the scale', () => {
  assert.equal(clampedGroup.group.priority, 100)
})
await tool('memory_group').execute({ action: 'update', id: prioGroup.group.id, priority: 0 }, exec)

// The important conclusion is written first and must still win over the
// fourteen newer memories that follow it.
const important = await tool('memory_write').execute({
  group: '优先级测试',
  entries: [{ content: '高优先级的重要结论。', priority: 90 }],
}, exec)
const filler = []
for (let index = 0; index < 14; index += 1) {
  filler.push(await tool('memory_write').execute({
    group: '优先级测试',
    entries: [{ content: `低优先级的后续结论 ${String(index)}。` }],
  }, exec))
}
const ranked = await tool('memory_recall').execute({ group: '优先级测试', limit: 20 }, exec)
check('higher priority is listed before newer memories', () => {
  assert.equal(ranked.entries[0].id, important.entries[0].id)
})
check('the priority is visible in rendered output', () => {
  const text = renderOf('memory_recall', { group: '优先级测试' }, ranked)
  assert.ok(text.includes('P90'), text.slice(0, 200))
})
const clampedEntry = await tool('memory_assign').execute({
  ids: [filler[0].entries[0].id], priority: -5,
}, exec)
check('an out-of-range entry priority is clamped too', () => {
  assert.equal(clampedEntry.priority, 0)
  assert.equal(clampedEntry.entries[0].priority, 0)
})

// The injection budget is 12 by default, so 15 memories cannot all fit: what
// survives is the point of having a priority at all.
const prioApply = await request(panelRoute, 'POST', '/memory-vault', {
  op: 'apply.set', sessionId: 'session-priority', groups: ['优先级测试'],
})
check('the applied group reports every memory it holds', () => {
  assert.equal(prioApply.payload.result.groups.length, 1)
})
const prioPlan = await request(panelRoute, 'GET', '/memory-vault?op=apply.get&sessionId=session-priority')
check('priority decides who fits the injection budget', () => {
  const ids = prioPlan.payload.result.entries.map(entry => entry.id)
  assert.ok(ids.includes(important.entries[0].id), 'the high-priority memory must be injected')
  assert.equal(ids[0], important.entries[0].id, 'and it must come first')
})
check('the memories that did not fit say why', () => {
  const plan = prioPlan.payload.result
  assert.equal(plan.truncated, true)
  assert.ok(plan.skipped.length > 0)
  assert.ok(plan.skipped.every(item => item.reason === 'entry-budget' || item.reason === 'char-budget'))
})

// A single memory can be carried into a conversation without its whole group.
const singleApply = await request(panelRoute, 'POST', '/memory-vault', {
  op: 'apply.set', sessionId: 'session-single', groups: [], entries: [important.entries[0].id],
})
check('one memory can be applied on its own', () => {
  assert.equal(singleApply.payload.result.entries.length, 1)
  assert.equal(singleApply.payload.result.entries[0].id, important.entries[0].id)
})
const singlePlan = await request(panelRoute, 'GET', '/memory-vault?op=apply.get&sessionId=session-single')
check('the injected plan marks a hand-picked memory as such', () => {
  assert.equal(singlePlan.payload.result.injected, 1)
  assert.equal(singlePlan.payload.result.entries[0].via, 'session')
})
const singleTool = await tool('memory_apply').execute({
  action: 'set', groups: [], entries: [important.entries[0].id],
}, { agent: { session: sessionStub('session-single-tool') }, signal: exec.signal })
check('the model tool can apply a single memory too', () => {
  assert.equal(singleTool.entries.length, 1)
  assert.equal(singleTool.injected, 1)
})
check('the applied single memory is named in the tool result', () => {
  const text = renderOf('memory_apply', { action: 'set' }, singleTool)
  assert.ok(text.includes('高优先级的重要结论'), text.slice(0, 200))
})

// The index is what lets the model choose without searching blind.
check('the prompt index is a catalogue, not just a table of contents', () => {
  const text = indexSection().text({ agent: { session: { id: 'session-smoke' } } })
  assert.ok(text.includes('知识索引'), 'the index says what it is')
  assert.ok(text.includes('P90'), 'priorities are visible')
  assert.ok(text.includes('高优先级的重要结论。'), 'titles are listed so the model can choose')
  assert.ok(text.includes('memory_apply'), 'and the index says how to act on it')
  assert.ok(text.includes('priority=0-100'), 'including how to raise a memory')
})

console.log('base prompt layer, custom quota and AI curation')

// The base layer is a floor, not a preference: it reaches a conversation that
// applies nothing at all, and it is not billed against that conversation.
const baseGroup = await tool('memory_group').execute({ action: 'create', name: '底层样本', scope: 'knowledge' }, exec)
const baseEntry = await tool('memory_write').execute({
  group: '底层样本',
  entries: [{ content: '底层约定：所有编码任务都要用 git 留痕。', base: true }],
}, exec)
check('a memory can be written straight into the base layer', () => {
  assert.equal(baseEntry.entries[0].base, true)
})
const baseOnly = await request(panelRoute, 'GET', '/memory-vault?op=apply.get&sessionId=session-base-only')
check('the base layer is injected separately from the applied quota', () => {
  assert.ok(baseOnly.payload.result.base.some(entry => entry.id === baseEntry.entries[0].id))
  assert.ok(!baseOnly.payload.result.entries.some(entry => entry.id === baseEntry.entries[0].id))
})
const unflagged = await tool('memory_assign').execute({ ids: [baseEntry.entries[0].id], base: false }, exec)
check('the base flag can be taken off again', () => {
  assert.equal(unflagged.base, false)
  assert.equal(unflagged.entries[0].base, false)
})
await tool('memory_assign').execute({ ids: [baseEntry.entries[0].id], base: true }, exec)
check('the base flag round-trips', () => {
  assert.equal(renderOf('memory_assign', { base: true },
    { mode: 'base', base: true, entries: [baseEntry.entries[0]], missing: [] }).includes('底层'), true)
})

// The quota is editable at runtime rather than only from a profile file.
const quotaBefore = (await request(panelRoute, 'GET', '/memory-vault?op=state')).payload.result.apply
check('the panel can read the resolved quota', () => {
  assert.ok(Number.isFinite(quotaBefore.maxEntries))
  assert.ok(quotaBefore.defaultsApplied.maxEntries > 0)
})
const quotaSet = await request(panelRoute, 'POST', '/memory-vault', { op: 'settings.set', maxEntries: 3 })
check('the knowledge quota can be changed without a restart', () => {
  assert.equal(quotaSet.payload.result.limits.maxEntries, 3)
})
const capped = await request(panelRoute, 'GET', '/memory-vault?op=apply.get&sessionId=session-priority')
check('the plan uses the custom quota', () => {
  assert.equal(capped.payload.result.maxEntries, 3)
  assert.equal(capped.payload.result.entries.length, 3)
})
check('the base layer still rides outside that quota', () => {
  assert.ok(capped.payload.result.base.some(entry => entry.id === baseEntry.entries[0].id))
  assert.equal(capped.payload.result.truncated, true)
})
const quotaBad = await request(panelRoute, 'POST', '/memory-vault', { op: 'settings.set', maxEntries: 'many' })
check('a non-numeric quota is refused', () => {
  assert.equal(quotaBad.status, 400)
})
const quotaRestored = await request(panelRoute, 'POST', '/memory-vault', {
  op: 'settings.set', maxEntries: quotaBefore.defaultsApplied.maxEntries,
})
check('the quota can be restored to the deployment default', () => {
  assert.equal(quotaRestored.payload.result.limits.maxEntries, quotaBefore.defaultsApplied.maxEntries)
})

// AI curation: one model call sorts reusable knowledge from one-off notes.
const curation = await tool('memory_curate').execute({ action: 'review', group: '优先级测试', limit: 3 }, exec)
check('a curation review decides without writing', () => {
  assert.equal(curation.mode, 'review')
  assert.equal(curation.applied.length, 0)
  assert.equal(curation.verdicts.length, 3)
  assert.ok(curation.verdicts.some(item => item.verdict === 'reusable'))
  assert.ok(curation.verdicts.some(item => item.verdict === 'oneoff'))
})
check('the review names the group a reusable memory should move to', () => {
  const reusable = curation.verdicts.find(item => item.verdict === 'reusable')
  assert.equal(reusable.group, '整理产出的知识')
})
const beforeApply = await tool('memory_recall').execute({ group: '优先级测试', limit: 3 }, exec)
check('the review leaves the memory where it was', () => {
  assert.ok(beforeApply.entries.every(entry => entry.groupName === '优先级测试'))
})
const curationApplied = await tool('memory_curate').execute({
  action: 'apply', group: '优先级测试', limit: 3, applyPriority: true,
}, exec)
check('applying the verdicts files reusable knowledge and demotes one-off notes', () => {
  assert.equal(curationApplied.mode, 'applied')
  const reusable = curationApplied.applied.find(item => item.verdict === 'reusable')
  const oneoff = curationApplied.applied.find(item => item.verdict === 'oneoff')
  assert.equal(reusable.scope, 'knowledge')
  assert.equal(oneoff.scope, 'conversation')
})
const afterCuration = await tool('memory_group').execute({ action: 'list' }, exec)
check('curation creates the group it decided on', () => {
  assert.ok(afterCuration.groups.some(group => group.name === '整理产出的知识'))
})
const movedItem = curationApplied.applied.find(item => item.verdict === 'reusable')
const movedEntry = movedItem === undefined
  ? { entries: [{ scope: 'missing', priority: 0 }] }
  : await tool('memory_recall').execute({ id: movedItem.id }, exec)
check('a curated reusable memory carries the raised priority', () => {
  assert.equal(movedEntry.entries[0].scope, 'knowledge')
  assert.ok(Number(movedEntry.entries[0].priority) >= 60, String(movedEntry.entries[0].priority))
})
const curationRendered = renderOf('memory_curate', { action: 'review' }, curation)
check('the curation result separates the two verdicts', () => {
  assert.ok(curationRendered.includes('可复用'))
  assert.ok(curationRendered.includes('单次性'))
})
const panelCuration = await request(panelRoute, 'POST', '/memory-vault', {
  op: 'curate', group: '优先级测试', limit: 2, apply: false, origin: 'all',
})
check('the panel curates on the deployment default model, with no provider configured', () => {
  assert.equal(panelCuration.status, 200, JSON.stringify(panelCuration.payload))
  assert.equal(panelCuration.payload.result.mode, 'review')
  assert.equal(panelCuration.payload.result.verdicts.length, 2)
  // The call itself has to have gone there, not merely resolved.
  const last = sink.calls[sink.calls.length - 1]
  assert.equal(last.provider, 'ds-default', JSON.stringify(last.provider))
  assert.equal(last.model, 'ds-model', JSON.stringify(last.model))
})
check('a review reports the label merges without applying them', () => {
  // Three merges in the stub: one legitimate and two that the vault must
  // refuse. A review writes none of them.
  assert.equal(panelCuration.payload.result.tagMap.length, 3)
  assert.equal(panelCuration.payload.result.tagMap[0].to, '统一标签')
  assert.deepEqual(panelCuration.payload.result.tagChanges, [])
})
// Origin is the axis the panel must not blur: by default a curation pass judges
// what the model wrote and leaves what a person typed alone.
const manualOnly = await request(panelRoute, 'POST', '/memory-vault', {
  op: 'curate', origin: 'manual', limit: 3, apply: false,
})
check('a curation pass can be scoped to human input', () => {
  assert.equal(manualOnly.status, 200, JSON.stringify(manualOnly.payload))
  assert.equal(manualOnly.payload.result.origin, 'manual')
  assert.ok(manualOnly.payload.result.candidates.every(entry => entry.modelWritten === false))
})
const generatedDefault = await tool('memory_curate').execute({ action: 'review', limit: 5 }, exec)
check('the default scope judges only AI-written memories', () => {
  assert.equal(generatedDefault.origin, 'generated')
  assert.equal(generatedDefault.candidates.length, 5)
  assert.ok(generatedDefault.candidates.every(entry => entry.modelWritten === true))
  assert.ok(generatedDefault.verdicts.every(item => item.modelWritten === true))
})
const handWrittenRow = await request(panelRoute, 'POST', '/memory-vault', {
  op: 'entry.write', group: '知识库', content: '人工写下的一条，用来验证整理范围。', title: '人工样本',
})
const handId = handWrittenRow.payload.result.entry.id
check('a memory typed into the panel is human input, not AI output', () => {
  assert.equal(handWrittenRow.payload.result.entry.source, 'panel')
  assert.equal(handWrittenRow.payload.result.entry.modelWritten, false)
  assert.ok(handWrittenRow.payload.result.entry.tags.includes('人工输入'))
})
const widened = await tool('memory_curate').execute({
  action: 'review', origin: 'all', ids: [handId, generatedDefault.candidates[0].id],
}, exec)
check('widening the scope reaches human input too', () => {
  assert.equal(widened.origin, 'all')
  assert.equal(widened.candidates.length, 2)
  assert.ok(widened.candidates.some(entry => entry.modelWritten === false))
  assert.ok(widened.candidates.some(entry => entry.modelWritten === true))
})
const outOfScope = await tool('memory_curate').execute({ action: 'review', origin: 'generated', ids: [handId] }, exec)
  .then(() => 'resolved', (error) => error.message)
check('a scoped pass refuses an id that sits outside its scope', () => {
  assert.ok(String(outOfScope).includes('没有可整理的记忆'), String(outOfScope))
  assert.ok(String(outOfScope).includes('范围'), String(outOfScope))
})
const emptyCuration = await tool('memory_curate').execute({ action: 'review', ids: ['mem_missing'] }, exec)
  .then(() => 'resolved', (error) => error.message)
check('a curation over nothing explains why instead of failing silently', () => {
  assert.ok(String(emptyCuration).includes('没有可整理的记忆'), String(emptyCuration))
})

console.log('sub-groups')
{
  const root = await tool('memory_group').execute({ action: 'create', name: '父组样本', scope: 'knowledge' }, exec)
  const child = await tool('memory_group').execute({
    action: 'create', name: '子组样本', scope: 'knowledge', parent: '父组样本',
  }, exec)
  check('a group can be created inside another one', () => {
    assert.equal(child.group.parentId, root.group.id)
    assert.equal(child.group.depth, 2)
    assert.deepEqual(child.group.path, ['父组样本'])
  })
  check('a group list renders the tree by indentation', () => {
    const rendered = renderOf('memory_group', { action: 'list' }, {
      action: 'list', count: 2, groups: [root.group, child.group],
    })
    assert.ok(rendered.includes('\n  - '), rendered)
    assert.ok(rendered.includes('父组样本 下'), rendered)
  })

  // Applying the heading is what makes nesting worth having.
  await tool('memory_write').execute({
    group: '子组样本', entries: [{ content: '子组里的一条知识。', title: '子组条目' }],
  }, exec)
  await tool('memory_apply').execute({ session: sessionStub('session-subgroup'), action: 'set', groups: ['父组样本'] }, {
    agent: { session: sessionStub('session-subgroup') },
    signal: new AbortController().signal,
  })
  const plan = await request(panelRoute, 'GET', '/memory-vault?op=apply.get&sessionId=session-subgroup')
  check('applying a parent applies its sub-groups too', () => {
    // `groups` is what the session picked; `effectiveGroups` is what that
    // resolves to once the subtree is folded in.
    assert.deepEqual(plan.payload.result.groups.map(group => group.name), ['父组样本'])
    assert.ok(plan.payload.result.effectiveGroups.includes(root.group.id), JSON.stringify(plan.payload.result.effectiveGroups))
    assert.ok(plan.payload.result.effectiveGroups.includes(child.group.id), JSON.stringify(plan.payload.result.effectiveGroups))
  })
  const wide = await tool('memory_recall').execute({ group: '父组样本' }, exec)
  check('reading a group reads its sub-groups', () => {
    assert.ok(wide.entries.some(entry => entry.groupName === '子组样本'))
  })
  const exact = await tool('memory_recall').execute({ group: '父组样本', includeChildren: false }, exec)
  check('a caller can read one group alone', () => {
    assert.ok(!exact.entries.some(entry => entry.groupName === '子组样本'))
  })

  const deep = await tool('memory_group').execute({
    action: 'create', name: '孙组样本', scope: 'knowledge', parent: '子组样本',
  }, exec)
  check('a third level is allowed', () => {
    assert.equal(deep.group.depth, 3)
    assert.deepEqual(deep.group.path, ['父组样本', '子组样本'])
  })
  const tooDeep = await tool('memory_group').execute({
    action: 'create', name: '曾孙组', scope: 'knowledge', parent: '孙组样本',
  }, exec).then(() => 'resolved', (error) => error.message)
  check('a fourth level is refused by the depth ceiling', () => {
    assert.ok(String(tooDeep).includes('最多 3 层'), String(tooDeep))
  })
  const cycle = await tool('memory_group').execute({ action: 'update', name: '父组样本', parent: '孙组样本' }, exec)
    .then(() => 'resolved', (error) => error.message)
  check('a group cannot be moved under its own descendant', () => {
    assert.ok(String(cycle).includes('不能反过来'), String(cycle))
  })
  const orphan = await tool('memory_group').execute({ action: 'delete', name: '父组样本' }, exec)
    .then(() => 'resolved', (error) => error.message)
  check('deleting a parent with children is refused rather than orphaning them', () => {
    assert.ok(String(orphan).includes('子记忆组'), String(orphan))
  })
  const moved = await tool('memory_group').execute({ action: 'update', name: '子组样本', parent: '' }, exec)
  check('a sub-group can be moved back to the top level', () => {
    assert.equal(moved.group.parentId, null)
    assert.equal(moved.group.depth, 1)
  })
  const prompt = await request(panelRoute, 'GET', '/memory-vault?op=apply.get&sessionId=session-subgroup')
  check('the knowledge plan still resolves after the tree moved', () => {
    assert.equal(prompt.status, 200)
    assert.ok(Array.isArray(prompt.payload.result.groups))
  })
}

console.log("editing one memory's tags in place")
{
  const seededTags = await tool('memory_write').execute({
    group: '知识库', entries: [{ content: '用来验证就地改标签。', tags: ['旧标签'] }],
  }, exec)
  const tagId = seededTags.entries[0].id
  const added = await tool('memory_assign').execute({ ids: [tagId], tags: ['新增', '另一个'] }, exec)
  check('a tool can add tags to a memory that already exists', () => {
    assert.equal(added.mode, 'tags')
    assert.equal(added.tagsMode, 'add')
    assert.ok(added.entries[0].tags.includes('新增'))
    assert.ok(added.entries[0].tags.includes('旧标签'))
  })
  check('editing tags leaves provenance alone', () => {
    assert.ok(added.entries[0].tags.includes('AI 生成'), JSON.stringify(added.entries[0].tags))
    assert.ok(!added.entries[0].tags.includes('人工输入'))
  })
  const removed = await tool('memory_assign').execute({ ids: [tagId], tags: ['旧标签'], tagsMode: 'remove' }, exec)
  check('one tag can be removed without touching the rest', () => {
    assert.ok(!removed.entries[0].tags.includes('旧标签'))
    assert.ok(removed.entries[0].tags.includes('新增'))
  })
  const replaced = await tool('memory_assign').execute({ ids: [tagId], tags: ['只剩这个'], tagsMode: 'set' }, exec)
  check('tagsMode=set replaces the whole set', () => {
    assert.deepEqual(replaced.entries[0].tags, ['只剩这个', 'AI 生成'])
  })
  const cleared = await tool('memory_assign').execute({ ids: [tagId], tags: [], tagsMode: 'set' }, exec)
  check('an empty set clears user tags and keeps the system one', () => {
    assert.deepEqual(cleared.entries[0].tags, ['AI 生成'])
  })
  const noIds = await tool('memory_assign').execute({ tags: ['x'] }, exec)
    .then(() => 'resolved', (error) => error.message)
  check('editing tags without ids is refused', () => {
    assert.ok(String(noIds).includes('必须给出 ids'), String(noIds))
  })
  const emptyAdd = await tool('memory_assign').execute({ ids: [tagId], tags: [] }, exec)
    .then(() => 'resolved', (error) => error.message)
  check('an empty add says what to do instead', () => {
    assert.ok(String(emptyAdd).includes('tagsMode=set'), String(emptyAdd))
  })
  const renderedTags = renderOf('memory_assign', { tags: ['新增'] }, added)
  check('the tag edit is reported in words', () => {
    assert.ok(renderedTags.includes('已添加标签'), renderedTags)
    assert.ok(renderedTags.includes('新增'), renderedTags)
  })
  // The label that the curation answer below merges away, plus a second row
  // carrying it that is *not* in the batch — the merge has to reach the vault,
  // not just the memories the model happened to look at.
  const labelled = await tool('memory_write').execute({
    group: '知识库', entries: [{ content: '标签合并的样本。', tags: ['旧标签', '保留'] }],
  }, exec)
  const outside = await tool('memory_write').execute({
    group: '知识库', entries: [{ content: '没被整理到、但仍带着旧标签的一条。', tags: ['旧标签'] }],
  }, exec)
  const curatedTags = await tool('memory_curate').execute({ action: 'apply', ids: [labelled.entries[0].id] }, exec)
  check('applying curation writes the labels it decided on', () => {
    assert.equal(curatedTags.mode, 'applied')
    assert.deepEqual(curatedTags.verdicts[0].tags, ['规范标签', '整理'])
    assert.ok(curatedTags.applied[0].tags.includes('规范标签'))
  })
  check('applying curation merges labels across the whole vault', () => {
    const merged = /** @type {Record<string, any>[]} */ (curatedTags.tagChanges).find(change => change.from === '旧标签')
    assert.ok(merged !== undefined, JSON.stringify(curatedTags.tagChanges))
    assert.ok(Number(merged.updated) >= 1, JSON.stringify(merged))
  })
  const outsideAfter = await tool('memory_recall').execute({ id: outside.entries[0].id }, exec)
  check('the merge reached a memory that was not in the batch', () => {
    assert.ok(outsideAfter.entries[0].tags.includes('统一标签'), JSON.stringify(outsideAfter.entries[0].tags))
    assert.ok(!outsideAfter.entries[0].tags.includes('旧标签'), JSON.stringify(outsideAfter.entries[0].tags))
  })
  check('a system tag cannot be renamed by a merge', () => {
    const hostile = /** @type {Record<string, any>[]} */ (curatedTags.tagChanges).find(change => change.from === 'AI 生成')
    assert.equal(Number(hostile?.updated ?? -1), 0, JSON.stringify(curatedTags.tagChanges))
    assert.ok(outsideAfter.entries[0].tags.includes('AI 生成'), JSON.stringify(outsideAfter.entries[0].tags))
    assert.ok(!outsideAfter.entries[0].tags.includes('机器写的'), JSON.stringify(outsideAfter.entries[0].tags))
  })
  check('a user label cannot be renamed onto a system tag', () => {
    const hostile = /** @type {Record<string, any>[]} */ (curatedTags.tagChanges).find(change => change.from === '保留')
    assert.equal(Number(hostile?.updated ?? -1), 0, JSON.stringify(curatedTags.tagChanges))
  })
}

console.log('disposal')
harness.dispose()
check('disposal closes the vault', () => {
  rmSync(dir, { recursive: true, force: true })
})

console.log(failures.length === 0 ? '\nall smoke checks passed' : `\n${String(failures.length)} check(s) failed: ${failures.join(', ')}`)
process.exitCode = failures.length === 0 ? 0 : 1
