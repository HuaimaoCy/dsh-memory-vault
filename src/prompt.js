/**
 * The model-facing memory index: one system-prompt section naming the memory
 * groups that exist right now, plus the tool vocabulary for using them, plus
 * the memories this session has applied from the rest of the vault.
 *
 * The index is rendered at each assembly from live store state, but its
 * ordering is name-sorted and its size is capped, so writing a memory does not
 * reshuffle the prompt and invalidate the provider's prefix cache. The applied
 * block is the one part that grows with the vault: it is bounded by
 * `applyMaxEntries` and `applyMaxChars`, and a session that applies nothing
 * pays nothing.
 *
 * @module dsh-memory-vault/src/prompt
 */

/** Section order: after the session-query tool section, before the tool sections that follow it. */
export const MEMORY_INDEX_ORDER = 2500

/**
 * Render the block of memories this session has applied.
 *
 * The block is the rendering of the vault's injection plan, not a second
 * selection of its own: the panel previews that same plan, so neither side can
 * claim a memory the other does not have.
 * @param {object} input - Render input.
 * @param {import('./store.js').MemoryStore} input.store - Open vault.
 * @param {import('./config.js').VaultConfig} input.config - Resolved plugin config.
 * @param {string|undefined} input.sessionId - Session whose applications are read.
 * @returns {string[]} The block's lines, empty when nothing applies.
 */
function appliedBlock({ store, config, sessionId }) {
  if (sessionId === undefined) return []
  const plan = store.planInjection({
    sessionId,
    defaults: config.applyByDefault ? config.applyDefaultGroups : [],
    maxEntries: config.applyMaxEntries,
    maxChars: config.applyMaxChars,
    enabled: config.injectIndex,
  })
  if (plan.groups.length === 0) return []
  const names = plan.groups.map(group => group.name).join('、')
  const origin = plan.source === 'default' ? '按默认设置应用' : '本会话选择应用'
  const lines = [
    '',
    `### 已应用的知识（${names} · ${origin}）`,
    '下面的记忆来自其他会话或此前的整理，已直接应用到本会话：直接采用，不必再检索。需要更多细节时可用 `memory_recall` 检索对应记忆组。',
  ]
  if (plan.entries.length === 0) {
    lines.push(`（「${names}」目前没有可见的记忆。）`)
    return lines
  }
  for (const entry of plan.entries) {
    const title = entry.title === '' ? entry.kind : entry.title
    lines.push(`- 【${entry.groupName ?? ''}】${title}`, `  ${String(entry.content).replace(/\n/g, '\n  ')}`)
  }
  if (plan.truncated) lines.push(`（内容较多已截断，完整内容用 memory_recall 检索「${names}」。）`)
  return lines
}

/**
 * Render the index text for one assembly.
 * @param {object} input - Render input.
 * @param {import('./store.js').MemoryStore} input.store - Open vault.
 * @param {import('./config.js').VaultConfig} input.config - Resolved plugin config.
 * @param {string|undefined} input.sessionId - Session whose binding is highlighted.
 * @returns {string} The section text, or an empty string when the index is off.
 */
export function renderIndex({ store, config, sessionId }) {
  if (!config.injectIndex) return ''
  // `listGroups` is already priority-ordered: priority is a deliberate setting,
  // so the order only moves when somebody moves it and the prompt prefix stays
  // cacheable.
  const groups = store.listGroups()
  if (groups.length === 0) return ''
  const stats = store.stats()
  const bound = sessionId === undefined ? null : store.sessionState(sessionId).groupId
  const shown = groups.slice(0, config.injectMaxGroups)
  const omitted = groups.length - shown.length
  const mark = (/** @type {Record<string, any>} */ group) => group.id === bound ? ' ← 本会话' : ''
  // The catalogue is what turns the index from a table of contents into a menu:
  // titles let the model decide what to read or apply *before* spending a
  // search, which is the whole point of showing an index at all.
  const catalogue = config.indexEntryTitles <= 0
    ? new Map()
    : store.indexEntries({ groupIds: shown.map(group => group.id), perGroup: config.indexEntryTitles })
  const line = (/** @type {Record<string, any>} */ group) => {
    const tags = group.tags.length === 0 ? '' : ` [${group.tags.join(', ')}]`
    const auto = group.autoSummary ? ' · 自动总结' : ''
    const priority = group.priority > 0 ? ` · P${String(group.priority)}` : ''
    const description = group.description === '' ? '' : ` — ${group.description}`
    const head = `- ${group.name}${tags}${auto}${priority} · 组内 ${group.entryCount} 条${description}${mark(group)}`
    const titles = (catalogue.get(group.id) ?? []).map((/** @type {Record<string, any>} */ entry) => {
      const title = entry.title === '' ? String(entry.content).slice(0, 40) : entry.title
      return entry.priority > 0 ? `  · [P${String(entry.priority)}] ${title}` : `  · ${title}`
    })
    return [head, ...titles].join('\n')
  }
  const conversation = shown.filter(group => group.scope === 'conversation')
  const knowledge = shown.filter(group => group.scope === 'knowledge')
  // Counts are stated twice on purpose: an entry can be reassigned by hand, so
  // "how many memories are filed in this group" and "how many carry this
  // assignment" are different questions with different answers.
  const header = `记忆库：${stats.totals.groups} 个记忆组；按归属计 ${stats.totals.entries} 条记忆`
    + `（对话记忆 ${stats.entries.conversation} 条、知识库 ${stats.entries.knowledge} 条）。`
  const usage = '下面按优先级列出记忆组（P 后的数字越大越优先）以及每组里优先级最高的几条记忆标题——这是当前可用的知识索引。'
    + '需要正文时用 `memory_recall`（可按记忆组、标签、归属或关键词检索）；把某个组接进本会话用 `memory_apply` action=set groups=["组名"]；'
    + '只接某一条记忆用 `memory_apply` action=set entries=["mem_..."]；调整优先级用 `memory_assign` priority=0-100（单条）或 `memory_group` action=update priority=0-100（整组）。'
  return [
    '## 知识与记忆库',
    header,
    '记忆组是一级容器；每个记忆组和每条记忆都归属「对话记忆」（属于产生它的会话）或「知识库」（跨会话复用）。下面每组括注的是该组的条目数，与归属计数可以不同。',
    '记忆正文支持 Markdown 与 LaTeX：行内公式写 $...$，独立公式写 $$...$$，面板按原样渲染。',
    '`memory_recall` 检索、`memory_write` 写入、`memory_group` 管理记忆组与归属、`memory_assign` 调整单条记忆的归属与优先级、`memory_apply` 把知识接进本会话、`memory_summarize` 把本段对话固化为记忆。',
    '在需要既有约定或结论时先检索；在上下文被压缩前或一段工作结束时先固化记忆。',
    usage,
    ...(knowledge.length === 0 ? [] : ['', `知识库（${stats.groups.knowledge} 组）：`, ...knowledge.map(line)]),
    ...(conversation.length === 0 ? [] : ['', `对话记忆（${stats.groups.conversation} 组）：`, ...conversation.map(line)]),
    ...(omitted === 0 ? [] : ['', `（另有 ${omitted} 个记忆组未列出，可用 memory_group action=list 查看。）`]),
    ...(stats.hidden === 0 ? [] : ['', `另有 ${stats.hidden} 条记忆已被隐藏，默认不出现在检索结果里。`]),
    ...appliedBlock({ store, config, sessionId }),
  ].join('\n')
}

/**
 * Register the index as a system-prompt section.
 * @param {object} ctx - Plugin context.
 * @param {object} deps - Render inputs.
 * @param {import('./store.js').MemoryStore} deps.store - Open vault.
 * @param {import('./config.js').VaultConfig} deps.config - Resolved plugin config.
 * @returns {(() => void)|undefined} The section disposer, or undefined when no prompt service is present.
 */
export function registerIndexSection(ctx, deps) {
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt === undefined || systemPrompt === null) return undefined
  return systemPrompt.section({
    name: 'memory-vault-index',
    order: MEMORY_INDEX_ORDER,
    text: (context) => renderIndex({
      store: deps.store,
      config: deps.config,
      sessionId: context?.agent?.session?.id,
    }),
  })
}
