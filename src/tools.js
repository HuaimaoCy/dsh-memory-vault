/**
 * Model-facing tools: memory groups, memory entries, retrieval, assignment
 * between conversation memory and the knowledge base, and summarization.
 *
 * Tools register as raw JSON-Schema definitions rather than through the
 * harness's typed `defineTool` helper, because this bundle is out-of-tree and
 * keeps a zero runtime-import surface: the registry accepts raw definitions
 * (the same path MCP-sourced tools arrive through), and argument validation,
 * cancellation, and result materialization stay identical.
 *
 * @module dsh-memory-vault/src/tools
 */

import { ENTRY_KINDS, SCOPES, normalizePriority } from './store.js'
import { validateEntryBatch } from './policy.js'

/** Output declaration shared by every tool: an open object the renderer turns into text. */
const OPEN_OBJECT_OUTPUT = { type: 'object', additionalProperties: true }

/**
 * Build one tool definition.
 * @param {object} spec - Tool specification.
 * @param {string} spec.name - Tool name.
 * @param {string} spec.description - Model-facing description.
 * @param {Record<string, unknown>} spec.parameters - JSON Schema for the arguments.
 * @param {(args: Record<string, any>, exec: Record<string, any>) => Promise<Record<string, unknown>>} spec.execute - Body.
 * @param {(args: Record<string, any>, value: Record<string, any>) => string} spec.render - Model-facing text projection.
 * @returns {Record<string, unknown>} A registry-ready definition.
 */
function tool(spec) {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: {
      schema: OPEN_OBJECT_OUTPUT,
      render: (args, value) => [{ type: 'text', text: spec.render(args, value) }],
    },
    execute: spec.execute,
  }
}

/**
 * Render an entry as one compact block of model-facing text. Assignment and
 * container are named separately because they can disagree once a memory has
 * been assigned by hand.
 * @param {Record<string, any>} entry - Entry view from the store.
 * @param {boolean} [withContent] - Whether to include the body.
 * @returns {string} One entry's text.
 */
function entryLine(entry, withContent = true) {
  const tags = entry.tags.length === 0 ? '' : ` [${entry.tags.join(', ')}]`
  const assignment = entry.scope === 'knowledge' ? '知识库' : '对话记忆'
  const manual = entry.assigned === 'manual' ? '（手动）' : ''
  const hidden = entry.hidden === true ? '（已隐藏）' : ''
  const priority = Number(entry.priority ?? 0) > 0 ? ` · P${String(entry.priority)}` : ''
  const group = entry.groupName === undefined || entry.groupName === null || entry.groupName === assignment
    ? ''
    : ` · 记忆组「${entry.groupName}」`
  const head = `- ${entry.id} · 归属 ${assignment}${manual}${hidden}${group} · ${entry.kind}${priority}${tags}`
  const title = entry.title === '' ? '' : `\n  标题: ${entry.title}`
  return withContent ? `${head}${title}\n  ${entry.content.replace(/\n/g, '\n  ')}` : `${head}${title}`
}

/**
 * Render a group as one compact line. The count is the group's own contents,
 * which can differ from its assignment count once memories are reassigned.
 * @param {Record<string, any>} group - Group view from the store.
 * @returns {string} One group's text.
 */
function groupLine(group) {
  const tags = group.tags.length === 0 ? '' : ` [${group.tags.join(', ')}]`
  const auto = group.autoSummary ? ' · 自动总结' : ''
  const priority = Number(group.priority ?? 0) > 0 ? ` · P${String(group.priority)}` : ''
  const description = group.description === '' ? '' : ` — ${group.description}`
  return `- ${group.id} · ${group.scope === 'knowledge' ? '知识库' : '对话记忆'} · ${group.name}${tags}${auto}${priority} · 组内 ${group.entryCount} 条${description}`
}

/**
 * Describe the assignment vocabulary once, so every schema reuses one wording.
 * @param {string} subject - What is being assigned.
 * @returns {string} Parameter description.
 */
function scopeDescription(subject) {
  return `归属：conversation = 对话记忆（属于产生它的会话）；knowledge = 知识库（跨会话复用）。省略时${subject}保持原归属。`
}

/**
 * Build the vault tool set.
 * @param {object} deps - Plugin services the tools call.
 * @param {import('./store.js').MemoryStore} deps.store - Open vault.
 * @param {import('./config.js').VaultConfig} deps.config - Resolved plugin config.
 * @param {(input: Record<string, any>) => Promise<Record<string, unknown>>} deps.summarize - Summarization entry point.
 * @param {() => void} deps.notify - Invalidate the memory index and Web page.
 * @returns {Record<string, unknown>[]} Definitions to register.
 */
export function buildTools({ store, config, summarize, notify }) {
  /** @type {Record<string, unknown>[]} */
  const definitions = []

  /**
   * Describe what one session currently applies, and how much of it reaches
   * the prompt.
   * @param {string} sessionId - Session id.
   * @returns {Record<string, unknown>} Application state for the tools and the panel.
   */
  const describeApplications = (sessionId) => {
    const defaults = config.applyByDefault ? config.applyDefaultGroups : []
    // The tools read the same injection plan the prompt renderer reads, so a
    // tool result can never claim a memory the model did not receive.
    const plan = store.planInjection({
      sessionId,
      defaults,
      maxEntries: config.applyMaxEntries,
      maxChars: config.applyMaxChars,
      enabled: config.injectIndex,
    })
    return {
      source: plan.source,
      groups: plan.groups,
      entries: plan.entries,
      defaults: config.applyDefaultGroups,
      applyByDefault: config.applyByDefault,
      injected: plan.entries.length,
      truncated: plan.truncated,
      maxEntries: plan.maxEntries,
      maxChars: plan.maxChars,
    }
  }

  definitions.push(tool({
    name: 'memory_group',
    description: [
      '管理知识与记忆库的记忆组：列出、创建、修改、删除，或整体切换一个记忆组的归属（对话记忆 / 知识库）。',
      '记忆组是记忆条目的一级容器；条目既可以在组之间移动，也可以单独改归属。',
      'action=list 查看全部记忆组（含条目数），其余 action 需要 name 或 id 定位目标组。',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'create', 'update', 'delete', 'assign', 'bind', 'unbind'],
          description: '要执行的操作。bind 把本会话的总结写入目标绑定到某个记忆组，unbind 解除绑定回到默认组。',
        },
        name: { type: 'string', description: '记忆组名称：创建时必填；其他操作可与 id 二选一。' },
        id: { type: 'string', description: '记忆组 id；与 name 二选一。' },
        scope: { type: 'string', enum: SCOPES, description: scopeDescription('整个组及其默认归属') },
        description: { type: 'string', description: '记忆组用途说明，写入后出现在记忆索引里。' },
        tags: { type: 'array', items: { type: 'string' }, description: '记忆组标签。' },
        autoSummary: {
          type: 'boolean',
          description: '是否把本会话的阈值自动总结写入该组（通常只对一个对话记忆组开启）。',
        },
        priority: {
          type: 'number',
          description: '记忆组优先级 0-100，越大越优先：索引里排得更前，注入预算不够时先取该组的记忆。',
        },
        sessionId: {
          type: 'string',
          description: '可选的会话 id：把该组限定为这个会话的对话记忆容器。',
        },
      },
      required: ['action'],
    },
    execute: async (args, exec) => {
      switch (args.action) {
        case 'list': {
          const groups = store.listGroups(args.scope === undefined ? {} : { scope: args.scope })
          return { action: 'list', groups, count: groups.length }
        }
        case 'create': {
          if (args.name === undefined) throw new Error('action=create requires `name`')
          const scope = args.scope ?? 'conversation'
          const sessionId = args.sessionId ?? (scope === 'conversation' ? exec.agent?.session?.id ?? null : null)
          const group = store.createGroup({
            name: args.name,
            scope,
            description: args.description ?? '',
            tags: args.tags ?? [],
            sessionId,
            autoSummary: args.autoSummary === true,
            priority: args.priority ?? 0,
          })
          notify()
          return { action: 'create', group }
        }
        case 'update':
        case 'assign': {
          const reference = args.id ?? args.name
          if (reference === undefined) throw new Error(`action=${args.action} requires \`id\` or \`name\``)
          const scope = args.action === 'assign'
            ? args.scope ?? (() => { throw new Error('action=assign requires `scope`') })()
            : args.scope
          const { group, movedEntries } = store.updateGroup(reference, {
            ...(args.name !== undefined && args.id !== undefined ? { name: args.name } : {}),
            ...(scope === undefined ? {} : { scope }),
            ...(args.description === undefined ? {} : { description: args.description }),
            ...(args.tags === undefined ? {} : { tags: args.tags }),
            ...(args.autoSummary === undefined ? {} : { autoSummary: args.autoSummary }),
            ...(args.priority === undefined ? {} : { priority: args.priority }),
          })
          notify()
          return { action: args.action, group, movedEntries }
        }
        case 'delete': {
          const reference = args.id ?? args.name
          if (reference === undefined) throw new Error('action=delete requires `id` or `name`')
          const removed = store.deleteGroup(reference)
          notify()
          return { action: 'delete', removed }
        }
        case 'bind':
        case 'unbind': {
          // A binding says where this session's summaries go; knowledge
          // application says what this session reads. They are separate axes and
          // the vault keeps them apart.
          const sessionId = args.sessionId ?? exec.agent?.session?.id
          if (sessionId === undefined) {
            throw new Error(`action=${args.action} 需要在一个会话内调用，或显式传入 sessionId`)
          }
          const reference = args.action === 'unbind' ? null : args.id ?? args.name
          if (args.action === 'bind' && reference === undefined) {
            throw new Error('action=bind 需要 `id` 或 `name`')
          }
          const binding = store.bindSession(sessionId, reference)
          notify()
          return {
            action: args.action,
            sessionId,
            group: binding.groupId === null ? null : store.findGroup(binding.groupId),
            defaultGroupId: store.readMeta('default_conversation_group') ?? null,
          }
        }
        default:
          throw new Error(`unknown memory_group action "${String(args.action)}"`)
      }
    },
    render: (args, value) => {
      if (value.action === 'list') {
        const groups = /** @type {Record<string, any>[]} */ (value.groups)
        if (groups.length === 0) return '记忆库为空：还没有任何记忆组。'
        return `记忆组 ${groups.length} 个：\n${groups.map(groupLine).join('\n')}`
      }
      if (value.action === 'delete') {
        const removed = /** @type {Record<string, any>} */ (value.removed)
        return `已删除记忆组「${removed.name}」，同时移除 ${removed.removedEntries} 条记忆条目。`
      }
      if (value.action === 'bind' || value.action === 'unbind') {
        if (value.group === null || value.group === undefined) {
          return '已解除本会话的记忆组绑定：后续总结写回默认对话记忆组。'
        }
        return `已把本会话的总结目标绑定到记忆组「${String(/** @type {Record<string, any>} */ (value.group).name)}」：`
          + '自动总结与未指定组的 memory_summarize 都会写入该组。'
      }
      const group = /** @type {Record<string, any>} */ (value.group)
      const moved = Number(value.movedEntries ?? 0)
      const suffix = moved === 0 ? '' : `；${moved} 条随组条目已同步归属`
      return `${value.action === 'create' ? '已创建' : '已更新'}记忆组：\n${groupLine(group)}${suffix}`
    },
  }))

  definitions.push(tool({
    name: 'memory_write',
    description: [
      '把值得长期保留的内容写入知识与记忆库，可以一次写多条。',
      '每条记忆归属一个记忆组，并带一个归属（对话记忆 / 知识库）：默认跟随记忆组，也可以用 scope 单独指定。',
      '正文支持 Markdown（标题、列表、表格、代码块、引用、链接）与 LaTeX 公式：行内用 $...$，独立成行用 $$...$$；面板会渲染它们。',
      '适合写入：用户的长期偏好、项目约定、关键结论、可复用的操作步骤、排错结论。不要写入一次性的中间过程。',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        group: { type: 'string', description: '目标记忆组名称或 id。不存在时按 createIfMissing 决定是否创建。' },
        entries: {
          type: 'array',
          description: '要写入的记忆条目，按顺序写入。',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              content: { type: 'string', description: '记忆正文，自包含、可脱离当前对话理解。' },
              title: { type: 'string', description: '可选标题，用于列表展示与检索。' },
              kind: {
                type: 'string',
                enum: ENTRY_KINDS,
                description: '条目类型：summary 摘要、fact 事实、preference 偏好、decision 决策、task 任务、note 其他。',
              },
              priority: {
                type: 'number',
                description: '优先级 0-100，越大越优先；写入重要结论时给高分，注入预算不够时它不会被新记忆挤掉。',
              },
              tags: { type: 'array', items: { type: 'string' }, description: '条目标签。' },
            },
            required: ['content'],
          },
        },
        scope: { type: 'string', enum: SCOPES, description: scopeDescription('新条目') },
        createIfMissing: { type: 'boolean', description: '记忆组不存在时是否自动创建，默认 true。' },
      },
      required: ['group', 'entries'],
    },
    execute: async (args, exec) => {
      const sessionId = exec.agent?.session?.id ?? null
      let group = store.findGroup(args.group)
      if (group === undefined) {
        if (args.createIfMissing === false) throw new Error(`记忆组 "${args.group}" 不存在，且 createIfMissing 为 false`)
        group = store.createGroup({
          name: args.group,
          scope: args.scope ?? 'knowledge',
          description: '',
          tags: [],
          sessionId: args.scope === 'conversation' ? sessionId : null,
        })
      }
      if (args.entries.length === 0) throw new Error('entries 不能为空')
      // Validate the whole batch before opening the transaction, so a bad last
      // entry cannot leave the earlier ones written for a retry to duplicate.
      const batch = validateEntryBatch(args.entries, ENTRY_KINDS, config)
      const written = store.createEntries(batch.map(fields => ({
        groupId: group.id,
        ...fields,
        source: 'manual',
        sessionId,
        scope: args.scope ?? null,
      })))
      notify()
      return { group, entries: written }
    },
    render: (_args, value) => {
      const group = /** @type {Record<string, any>} */ (value.group)
      const entries = /** @type {Record<string, any>[]} */ (value.entries)
      return `已写入 ${entries.length} 条记忆到「${group.name}」（当前 ${group.scope === 'knowledge' ? '知识库' : '对话记忆'}）：\n`
        + entries.map(entry => entryLine(entry)).join('\n')
    },
  }))

  definitions.push(tool({
    name: 'memory_recall',
    description: [
      '检索知识与记忆库：按关键词搜索记忆条目，或按 id 读取单条，或列出一个记忆组 / 某一归属下的条目。',
      'query 支持多个以空格分隔的关键词，全部命中才返回（标题、正文、标签一起匹配），结果按匹配强度与更新时间排序。',
      '在动手之前、或在需要确认既有约定与结论时先检索一次，通常比重新推导更省时间。',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '关键词，空格分隔；省略时按 group/scope 列出条目。' },
        id: { type: 'string', description: '直接读取某条记忆的 id。' },
        group: { type: 'string', description: '限定记忆组名称或 id。' },
        tag: { type: 'string', description: '限定标签，精确匹配；系统标签「AI自动总结」「人工输入」可用于只看机器总结或只看人工写入的记忆。' },
        scope: { type: 'string', enum: SCOPES, description: '限定归属：conversation 对话记忆 / knowledge 知识库。' },
        limit: { type: 'integer', description: `返回条数上限，默认 ${config.searchLimit}。` },
        withContent: { type: 'boolean', description: '是否返回正文，默认 true；只做目录浏览时可设 false。' },
        includeHidden: { type: 'boolean', description: '是否连已隐藏的记忆一起返回，默认 false。' },
      },
    },
    execute: async (args) => {
      const limit = Math.max(1, Math.min(200, args.limit ?? config.searchLimit))
      if (args.id !== undefined) {
        const entry = store.findEntry(args.id)
        return { mode: 'id', entries: entry === undefined ? [] : [entry], missing: entry === undefined ? [args.id] : [] }
      }
      const group = args.group === undefined ? undefined : store.requireGroup(args.group)
      const tag = args.tag === undefined ? undefined : String(args.tag).trim()
      const includeHidden = args.includeHidden === true
      if (args.query === undefined || String(args.query).trim() === '') {
        const entries = store.listEntries({ groupId: group?.id, scope: args.scope, tag, includeHidden, limit })
        return { mode: 'list', entries, total: entries.length, group: group ?? null, tag: tag ?? null }
      }
      const entries = store.searchEntries({
        query: args.query,
        scope: args.scope,
        groupId: group?.id,
        tag,
        includeHidden,
        limit,
      })
      return { mode: 'search', entries, total: entries.length, group: group ?? null, tag: tag ?? null, query: args.query }
    },
    render: (args, value) => {
      const entries = /** @type {Record<string, any>[]} */ (value.entries)
      const scope = args.scope === undefined ? '' : `，归属 ${args.scope === 'knowledge' ? '知识库' : '对话记忆'}`
      const tag = args.tag === undefined ? '' : `，标签「${String(args.tag)}」`
      if (entries.length === 0) {
        if (value.mode === 'id') return `没有 id 为 ${String(/** @type {string[]} */ (value.missing)[0])} 的记忆条目。`
        if (value.mode === 'search') return `没有匹配「${String(value.query)}」的记忆${scope}${tag}。`
        return `该范围内还没有记忆条目${scope}${tag}。`
      }
      const header = value.mode === 'search'
        ? `匹配「${String(value.query)}」的记忆 ${entries.length} 条${scope}${tag}：`
        : `记忆条目 ${entries.length} 条${scope}${tag}：`
      const withContent = args.withContent !== false
      return `${header}\n${entries.map(entry => entryLine(entry, withContent)).join('\n')}`
    },
  }))

  definitions.push(tool({
    name: 'memory_assign',
    description: [
      '调整记忆的归档状态：把指定条目（或整个记忆组）在「对话记忆」与「知识库」之间移动、改挂到另一个记忆组、设置优先级，或把没用的记忆隐藏起来。',
      '归属的移动是显式决定：被移动的条目会标记为手动归属，之后不再随记忆组的归属变化而整体移动。',
      '优先级是 0-100，越大越优先：决定记忆在提示索引里的排序，以及注入预算不够时谁先进入系统提示——把真正重要的结论调高，它就不会被后来的新记忆挤掉。',
      '隐藏是可逆的下架：条目、标签与记忆组都保留，但默认不再出现在检索与提示索引里，随时可以恢复。',
      '典型用法：把当前会话里已沉淀为通用结论的记忆提升到知识库；把反复要用到的结论调到高优先级；把过时或走错方向的记忆隐藏掉。',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: '要调整的记忆条目 id 列表。' },
        group: { type: 'string', description: '与 ids 二选一：直接调整整个记忆组的归属。' },
        scope: { type: 'string', enum: SCOPES, description: '目标归属：conversation 对话记忆 / knowledge 知识库。' },
        targetGroup: { type: 'string', description: '可选：同时把条目改挂到这个记忆组。' },
        followGroup: {
          type: 'boolean',
          description: '设为 true 时条目恢复“跟随记忆组”的默认归属，而不是被锁定为手动归属。',
        },
        hidden: {
          type: 'boolean',
          description: '配合 ids 使用：true 隐藏这些记忆，false 恢复显示。给出时只改可见性，不动归属。',
        },
        priority: {
          type: 'number',
          description: '配合 ids 使用：把这批记忆的优先级设为 0-100。给出时只改优先级，不动归属。',
        },
      },
    },
    execute: async (args) => {
      if (args.priority !== undefined) {
        if (!Array.isArray(args.ids) || args.ids.length === 0) {
          throw new Error('memory_assign 用 priority 调整优先级时，必须给出 ids')
        }
        /** @type {Record<string, unknown>[]} */
        const entries = []
        /** @type {string[]} */
        const missing = []
        for (const id of args.ids) {
          if (store.findEntry(id) === undefined) {
            missing.push(id)
            continue
          }
          entries.push(store.updateEntry(id, { priority: args.priority }))
        }
        notify()
        return { mode: 'priority', priority: normalizePriority(args.priority), entries, missing }
      }
      if (args.hidden !== undefined) {
        if (!Array.isArray(args.ids) || args.ids.length === 0) {
          throw new Error('memory_assign 用 hidden 调整可见性时，必须给出 ids')
        }
        const result = store.setHidden({ ids: args.ids, hidden: args.hidden === true })
        notify()
        return { mode: 'hidden', hidden: args.hidden === true, ...result }
      }
      if (args.scope === undefined) {
        throw new Error('memory_assign 需要 `scope`（调整归属）或 `hidden`（调整可见性）')
      }
      if (args.group !== undefined && args.ids === undefined) {
        const { group, movedEntries } = store.updateGroup(args.group, { scope: args.scope })
        notify()
        return { mode: 'group', group, movedEntries }
      }
      if (!Array.isArray(args.ids) || args.ids.length === 0) {
        throw new Error('memory_assign requires `ids` or `group`')
      }
      const result = store.assignEntries({
        ids: args.ids,
        scope: args.scope,
        groupId: args.targetGroup ?? null,
        assignedBy: args.followGroup === true ? 'group' : 'manual',
      })
      notify()
      return { mode: 'entries', ...result }
    },
    render: (_args, value) => {
      if (value.mode === 'priority') {
        const entries = /** @type {Record<string, any>[]} */ (value.entries)
        const missing = /** @type {string[]} */ (value.missing)
        const absent = missing.length === 0 ? '' : `\n未找到 ${missing.length} 个 id：${missing.join(', ')}`
        return `已把 ${entries.length} 条记忆的优先级设为 P${String(value.priority)}`
          + `（越高越优先：索引里排得更前，注入预算不够时先取）：\n${entries.map(entry => entryLine(entry, false)).join('\n')}${absent}`
      }
      if (value.mode === 'hidden') {
        const entries = /** @type {Record<string, any>[]} */ (value.entries)
        const missing = /** @type {string[]} */ (value.missing)
        const verb = value.hidden === true ? '已隐藏' : '已恢复显示'
        const absent = missing.length === 0 ? '' : `\n未找到 ${missing.length} 个 id：${missing.join(', ')}`
        return `${verb} ${entries.length} 条记忆：\n${entries.map(entry => entryLine(entry, false)).join('\n')}${absent}`
      }
      if (value.mode === 'group') {
        const group = /** @type {Record<string, any>} */ (value.group)
        return `记忆组已迁移：\n${groupLine(group)}\n随组条目同步归属 ${String(value.movedEntries)} 条。`
      }
      const entries = /** @type {Record<string, any>[]} */ (value.entries)
      const missing = /** @type {string[]} */ (value.missing)
      const lines = entries.map(entry => entryLine(entry, false))
      const absent = missing.length === 0 ? '' : `\n未找到 ${missing.length} 个 id：${missing.join(', ')}`
      return `已调整 ${entries.length} 条记忆的归属：\n${lines.join('\n')}${absent}`
    },
  }))

  definitions.push(tool({
    name: 'memory_apply',
    description: [
      '把记忆组「应用」到当前会话，实现跨对话同步记忆。',
      '被应用记忆组里的记忆会直接进入本会话的系统提示，不必再检索；其他会话沉淀的知识因此可以在本会话直接使用。',
      'action=list 查看本会话当前的应用情况；action=set 用 groups 指定（空数组＝明确不应用任何知识）；action=reset 清除本会话的选择，回到部署默认。',
      '需要注意上下文长度：应用越多，每次请求的提示越长；只应用当前任务真正用得上的记忆组。',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'set', 'reset'], description: 'list 查看；set 指定；reset 回到默认。' },
        groups: {
          type: 'array',
          items: { type: 'string' },
          description: 'action=set 时的记忆组名称或 id；空数组表示明确不应用任何知识。',
        },
        entries: {
          type: 'array',
          items: { type: 'string' },
          description: 'action=set 时额外按条目应用的单条记忆 id：把一条具体结论接进本会话，而不必应用它所在的整个组。',
        },
      },
      required: ['action'],
    },
    execute: async (args, exec) => {
      if (exec.agent === undefined) throw new Error('memory_apply 需要在一个会话内调用')
      const sessionId = exec.agent.session.id
      if (args.action === 'set') {
        if (!Array.isArray(args.groups)) throw new Error('action=set 需要 `groups`')
        store.setApplications(sessionId, args.groups, Array.isArray(args.entries) ? args.entries : [])
        notify()
        return { action: 'set', sessionId, ...describeApplications(sessionId) }
      }
      if (args.action === 'reset') {
        store.setApplications(sessionId, null)
        notify()
        return { action: 'reset', sessionId, ...describeApplications(sessionId) }
      }
      return { action: 'list', sessionId, ...describeApplications(sessionId) }
    },
    render: (_args, value) => {
      const groups = /** @type {Record<string, any>[]} */ (value.groups)
      const single = /** @type {Record<string, any>[]} */ (value.entries ?? [])
      const defaults = /** @type {string[]} */ (value.defaults)
      const origin = value.source === 'explicit'
        ? '本会话选择'
        : value.source === 'default' ? '部署默认' : '无'
      if (groups.length === 0 && single.length === 0) {
        return [
          '本会话当前没有应用任何记忆组。',
          value.applyByDefault === true
            ? `部署默认会应用：${defaults.join('、')}（当前这些组不存在或已被清空）。`
            : '部署默认不自动应用（applyByDefault = false）。',
        ].join('\n')
      }
      return [
        `本会话应用了 ${groups.length} 个记忆组（来源：${origin}）：${groups.map(group => group.name).join('、')}`,
        single.length === 0 ? '' : `另有单独应用的记忆 ${single.length} 条：`
          + single.map(entry => entry.title === ''
            ? String(entry.content).replace(/\s+/g, ' ').slice(0, 24)
            : entry.title).join('、'),
        `已注入 ${String(value.injected)} 条记忆到系统提示${value.truncated === true ? '（已达上限，其余内容可用 memory_recall 检索）' : ''}。`,
      ].filter(line => line !== '').join('\n')
    },
  }))

  definitions.push(tool({
    name: 'memory_summarize',
    description: [
      '把当前会话（或指定会话）的一段对话压缩成一条记忆，写入指定记忆组。',
      '两种用法：给出 content 时，直接把你写好的总结存为记忆；不给 content 时，插件会调用模型对尚未总结的对话增量做一次总结。',
      '增量总结只覆盖上次总结之后的新对话；full=true 时改为覆盖整个会话的可见历史。',
      '上下文即将被压缩、或一段工作告一段落时，先调用它固化记忆，比事后回忆更可靠。',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        group: { type: 'string', description: '目标记忆组名称或 id；省略时写入当前会话绑定的对话记忆组。' },
        scope: { type: 'string', enum: SCOPES, description: '写入条目的归属；省略时跟随记忆组。' },
        content: { type: 'string', description: '你自己写好的记忆正文；给出时不会再调用模型。' },
        title: { type: 'string', description: '配合 content 使用的标题。' },
        instructions: { type: 'string', description: '额外强调的总结重点，仅在插件调用模型时生效。' },
        full: { type: 'boolean', description: 'true 时总结整个会话，而不是只总结未总结的增量。' },
      },
    },
    execute: async (args, exec) => {
      if (exec.agent === undefined) {
        throw new Error('memory_summarize 需要在一个会话内调用')
      }
      return await summarize({
        agent: exec.agent,
        session: exec.agent.session,
        signal: exec.signal,
        groupReference: args.group,
        scope: args.scope,
        content: args.content,
        title: args.title,
        instructions: args.instructions,
        full: args.full === true,
        mode: 'manual',
      })
    },
    render: (_args, value) => {
      const group = /** @type {Record<string, any>} */ (value.group)
      const entry = /** @type {Record<string, any>} */ (value.entry)
      const covered = /** @type {Record<string, any>} */ (value.covered)
      const model = value.model === null || value.model === undefined
        ? '由调用方提供的正文'
        : `模型 ${/** @type {Record<string, any>} */ (value.model).provider}/${/** @type {Record<string, any>} */ (value.model).model}`
      return [
        `已把 ${String(covered.messages)} 条对话（事件序号 ${String(covered.fromSeq)}–${String(covered.toSeq)}）总结为一条记忆（${model}）：`,
        entryLine(entry),
        `归属：${group.scope === 'knowledge' ? '知识库' : '对话记忆'} · 记忆组「${group.name}」`,
      ].join('\n')
    },
  }))

  return definitions
}
