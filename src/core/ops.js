/**
 * The vault's generic operation surface.
 *
 * This is the one op vocabulary every machine caller shares: the DSH Web panel
 * (`src/http.js` serves it over the harness's web server), the CLI
 * (`bin/memory-vault.mjs` dispatches it in-process), and the loopback RPC
 * server (`memory-vault serve`) expose exactly these operations over exactly
 * the same validation. A rule that lives here — the write limits, the kind
 * allowlist, the base-layer flag — is therefore a rule no surface can skip.
 *
 * Nothing in this module knows about DSH: it consumes a `MemoryStore`, a
 * resolved config, a change broadcaster, and an optional curation entry point.
 *
 * @module dsh-memory-vault/src/core/ops
 */

import { ENTRY_KINDS, SCOPES } from '../store.js'
import {
  intParam, limitDefaults, normalizePriority, normalizeTags, validateEntryWrite,
  validateGroupDescription, validateGroupName,
} from '../policy.js'

/**
 * Every operation the vault serves, and whether it changes the vault.
 *
 * The transport alone cannot decide whether a request is a mutation: `op` is
 * chosen by the caller, so a safe method carrying a write operation would walk
 * straight past any method-based check. Reads and writes are named here once
 * so every transport can enforce the same rule.
 */
export const VAULT_OPS = {
  'image.list': { write: false },
  'image.read': { write: false },
  'image.add': { write: true },
  'image.delete': { write: true },
  'updates.status': { write: false },
  'updates.check': { write: false },
  state: { write: false },
  entries: { write: false },
  'apply.get': { write: false },
  'entry.write': { write: true },
  'entry.update': { write: true },
  'entry.delete': { write: true },
  'entry.hide': { write: true },
  'group.create': { write: true },
  'group.update': { write: true },
  'group.delete': { write: true },
  assign: { write: true },
  'apply.set': { write: true },
  'settings.set': { write: true },
  curate: { write: true },
  'session.bind': { write: true },
}

// 扩展（如笔记本）经注入的 extensions 挂载，核心对它们零静态依赖：
// 每个扩展是 { ops: {name:{write}}, handlers: {name: fn}, scope }。核心
// 仓库可以整体去掉扩展模块而照常工作——独立性由构建保证。
export const extensionOps = extensions => Object.fromEntries(
  (extensions ?? []).flatMap(extension => Object.entries(extension.ops ?? {})))

/** Provenance labels a non-panel caller may declare on an `entry.write`. */
const WRITE_SOURCES = ['panel', 'cli', 'codex', 'api']

/**
 * Project the vault for a caller that needs the whole picture: counts,
 * groups, tags, and the limits the next write will be judged by.
 *
 * @param {import('../store.js').MemoryStore} store - Open vault.
 * @param {import('../config.js').VaultConfig} config - Resolved plugin config.
 * @returns {Record<string, unknown>} Vault state.
 */
export function stateOf(store, config) {
  return {
    stats: store.stats(),
    groups: store.listGroups(),
    tags: store.tagInventory(),
    scopes: SCOPES,
    kinds: ENTRY_KINDS,
    limits: {
      autoSummaryTurns: config.autoSummaryTurns,
      autoSummaryChars: config.autoSummaryChars,
      searchLimit: config.searchLimit,
      maxEntryChars: config.maxEntryChars,
    },
    autoSummary: config.autoSummary,
    summarizer: config.summarizer,
    apply: {
      byDefault: config.applyByDefault,
      defaults: config.applyDefaultGroups,
      // The resolved numbers, not the deployment defaults: the panel edits
      // these and must show what the next request will actually use.
      ...store.readLimits(limitDefaults(config)),
      defaultsApplied: limitDefaults(config),
    },
  }
}

/**
 * Run one vault operation.
 *
 * @param {object} deps - Vault services.
 * @param {import('../store.js').MemoryStore} deps.store - Open vault.
 * @param {import('../config.js').VaultConfig} deps.config - Resolved plugin config.
 * @param {() => void} deps.notify - Change broadcaster.
 * @param {(request: Record<string, any>) => Promise<Record<string, unknown>>} [deps.curate] - AI curation entry point.
 * @param {Record<string, unknown>} body - Parsed request body carrying `op` plus its parameters.
 * @returns {Promise<Record<string, unknown>>} Operation result.
 * @throws {Error} When the op is unknown or its parameters break a rule.
 */
export async function operateVault({ store, config, notify, curate, updates, extensions }, body) {
  const op = body.op
  // 扩展操作优先交给注入的扩展表（笔记本等）；核心不认识它们的名字。
  for (const extension of extensions ?? []) {
    if (extension?.ops && Object.prototype.hasOwnProperty.call(extension.ops, op)) {
      return extension.handlers[op](extension.scope ?? {}, body)
    }
  }
  switch (op) {
    case 'image.list': return { images: store.listImages(String(body.entryId ?? '')) }
    case 'image.read': return { image: store.readImage(String(body.id ?? '')) }
    case 'image.add': {
      const images = store.addImage(String(body.entryId ?? ''), body)
      notify(); return { images }
    }
    case 'image.delete': {
      const image = store.deleteImage(String(body.id ?? ''))
      notify(); return { image }
    }
    case 'updates.status':
    case 'updates.check':
      if (!updates) throw new Error('此宿主未接入更新服务')
      return body.op === 'updates.check' ? updates.check() : updates.status()
    case 'state':
      return stateOf(store, config)
    case 'entries': {
      const groupReference = typeof body.group === 'string' && body.group !== '' ? body.group : undefined
      const group = groupReference === undefined ? undefined : store.requireGroup(groupReference)
      const scope = typeof body.scope === 'string' && SCOPES.includes(body.scope) ? body.scope : undefined
      const tags = normalizeTags(Array.isArray(body.tag) ? body.tag : body.tag === undefined || body.tag === '' ? [] : [body.tag])
      const query = typeof body.query === 'string' ? body.query.trim() : ''
      const includeHidden = body.includeHidden === true || body.includeHidden === 'true'
      const limit = intParam(body.limit, { min: 1, max: 500, fallback: 100 }, 'limit')
      const offset = intParam(body.offset, { min: 0, max: 1000000, fallback: 0 }, 'offset')
      const filter = {
        ...(group === undefined ? {} : body.includeChildren === true ? { groupIds: [group.id, ...store.descendantIds(group.id)] } : { groupId: group.id }),
        scope, tags, includeHidden, limit: limit + 1, offset,
        ...(body.onlyHidden === true ? { hidden: true } : {}),
      }
      // One row past the page proves another page exists without a second
      // counting query over the whole table.
      const rows = query === ''
        ? store.listEntries(filter)
        : store.searchEntries({ ...filter, query })
      const hasMore = rows.length > limit
      return {
        entries: hasMore ? rows.slice(0, limit) : rows,
        group: group ?? null,
        limit,
        offset,
        hasMore,
        nextOffset: hasMore ? offset + limit : null,
      }
    }
    case 'entry.hide': {
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : []
      if (ids.length === 0) throw new Error('entry.hide requires `ids`')
      const result = store.setHidden({ ids, hidden: body.hidden !== false })
      notify()
      return result
    }
    case 'apply.get': {
      const sessionId = String(body.sessionId ?? '')
      if (sessionId === '') throw new Error('apply.get requires `sessionId`')
      // The caller reads the very plan the prompt renderer reads, so a preview
      // cannot claim memories the model never receives.
      const plan = store.planInjection({
        sessionId,
        defaults: config.applyByDefault ? config.applyDefaultGroups : [],
        ...store.readLimits(limitDefaults(config)),
        enabled: config.injectIndex,
      })
      return {
        sessionId,
        // What this session chose for itself, which stays visible even while
        // the effective set comes from the deployment default.
        ...store.appliedGroups(sessionId),
        effective: plan.source,
        enabled: plan.enabled,
        injected: plan.entries.length + plan.base.length,
        truncated: plan.truncated,
        skipped: plan.skipped,
        usedChars: plan.usedChars,
        // The knowledge panel shows what the session actually receives, not
        // just how many memories that is.
        entries: plan.entries,
        base: plan.base,
        // Groups the effective set resolved to, so the tiles match the正文.
        effectiveGroups: plan.groups.map(group => group.id),
        // Where this session's summaries go; a separate axis from what it reads.
        boundGroupId: store.sessionState(sessionId).groupId,
        defaultGroupId: store.readMeta('default_conversation_group') ?? null,
        defaults: config.applyDefaultGroups,
        applyByDefault: config.applyByDefault,
        ...store.readLimits(limitDefaults(config)),
      }
    }
    case 'apply.set': {
      const sessionId = String(body.sessionId ?? '')
      if (sessionId === '') throw new Error('apply.set requires `sessionId`')
      // `groups: null` clears the session's choice so the deployment default
      // applies again; `groups: []` applies nothing on purpose. `entries` adds
      // memories picked one by one alongside whatever groups were chosen.
      const groups = body.groups === null ? null : Array.isArray(body.groups) ? body.groups.map(String) : undefined
      if (groups === undefined) throw new Error('apply.set requires `groups` (an array, or null to reset)')
      const entries = Array.isArray(body.entries) ? body.entries.map(String) : []
      const stored = store.setApplications(sessionId, groups, entries)
      notify()
      return { sessionId, ...stored }
    }
    case 'group.create': {
      const group = store.createGroup({
        name: validateGroupName(body.name),
        scope: typeof body.scope === 'string' && SCOPES.includes(body.scope) ? body.scope : 'conversation',
        description: validateGroupDescription(body.description),
        tags: normalizeTags(body.tags),
        sessionId: typeof body.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : null,
        autoSummary: body.autoSummary === true,
        priority: normalizePriority(body.priority),
        // A caller-created group can be born inside another one; an empty value
        // means the top level.
        parent: typeof body.parent === 'string' && body.parent !== '' ? body.parent : null,
      })
      notify()
      return { group }
    }
    case 'group.update': {
      const { group, movedEntries } = store.updateGroup(String(body.id ?? body.group ?? ''), {
        ...(body.name === undefined ? {} : { name: validateGroupName(body.name) }),
        ...(typeof body.scope === 'string' && SCOPES.includes(body.scope) ? { scope: body.scope } : {}),
        ...(body.description === undefined ? {} : { description: validateGroupDescription(body.description) }),
        ...(body.tags === undefined ? {} : { tags: normalizeTags(body.tags) }),
        ...(typeof body.autoSummary === 'boolean' ? { autoSummary: body.autoSummary } : {}),
        ...(body.priority === undefined ? {} : { priority: normalizePriority(body.priority) }),
        // Moves are explicit: only a supplied `parent` changes the tree, and
        // null/'' is how the caller says "make this a top-level group".
        ...(body.parent === undefined ? {} : { parent: typeof body.parent === 'string' && body.parent !== '' ? body.parent : null }),
      })
      notify()
      return { group, movedEntries }
    }
    case 'group.delete': {
      const removed = store.deleteGroup(String(body.id ?? body.group ?? ''))
      notify()
      return { removed }
    }
    case 'entry.write': {
      const groupId = String(body.groupId ?? body.group ?? '')
      const fields = validateEntryWrite(body, ENTRY_KINDS, config, { allowEmpty: Array.isArray(body.images) && body.images.length > 0 })
      const entry = store.createEntry({
        groupId,
        ...fields,
        images: body.images ?? [],
        // Provenance follows the surface the write came through; a caller may
        // only pick from the declared labels, never free-text one.
        source: typeof body.source === 'string' && WRITE_SOURCES.includes(body.source) ? body.source : 'panel',
        sessionId: typeof body.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : null,
        scope: typeof body.scope === 'string' && SCOPES.includes(body.scope) ? body.scope : null,
      })
      notify()
      return { entry }
    }
    case 'entry.update': {
      // Validating the resulting entry rather than the patch keeps the rules
      // identical to a write: an edit cannot smuggle in what a write refuses.
      const current = store.requireEntry(String(body.id ?? ''))
      const fields = validateEntryWrite({
        content: body.content === undefined ? current.content : body.content,
        title: body.title === undefined ? current.title : body.title,
        kind: body.kind === undefined || body.kind === '' ? current.kind : body.kind,
        tags: body.tags === undefined ? current.tags : body.tags,
        priority: body.priority === undefined ? current.priority : body.priority,
        // Base-layer membership has to round-trip through the validator too:
        // leaving it out defaulted every save to `false`, which silently
        // cleared the flag on any edit and made the panel's toggle a no-op.
        base: body.base === undefined ? current.base : body.base,
      }, ENTRY_KINDS, config, { allowEmpty: body.images === undefined ? current.imageCount > 0 : Array.isArray(body.images) && body.images.length > 0 })
      if (body.scope !== undefined && !SCOPES.includes(body.scope)) throw new Error('scope 必须为 conversation 或 knowledge')
      const target = body.groupId === undefined ? undefined : store.requireGroup(String(body.groupId))
      const entry = store.transaction(() => {
        store.updateEntry(current.id, { ...fields, allowEmpty: Array.isArray(body.images) && body.images.length > 0 })
        if (body.images !== undefined) store.replaceImages(current.id, body.images)
        if (target !== undefined || body.scope !== undefined) store.assignEntries({
          ids: [current.id], scope: body.scope ?? null, groupId: target?.id ?? null, assignedBy: 'manual',
        })
        return store.requireEntry(current.id)
      })
      notify()
      return { entry }
    }
    case 'session.bind': {
      const sessionId = String(body.sessionId ?? '')
      if (sessionId === '') throw new Error('session.bind requires `sessionId`')
      const reference = body.group === null || body.group === undefined || body.group === ''
        ? null
        : String(body.group)
      const stored = store.bindSession(sessionId, reference)
      notify()
      return {
        sessionId,
        ...stored,
        group: stored.groupId === null ? null : store.findGroup(stored.groupId) ?? null,
      }
    }
    case 'entry.delete': {
      const entry = store.deleteEntry(String(body.id ?? ''))
      notify()
      return { entry }
    }
    case 'assign': {
      // A base-layer flag rides the same operation as assignment: both answer
      // "what does this memory mean to me".
      if (body.base !== undefined && Array.isArray(body.ids)) {
        const entries = body.ids.map(String).map(id => store.updateEntry(id, { base: body.base === true }))
        notify()
        return { entries, base: body.base === true }
      }
      if (body.priority !== undefined && Array.isArray(body.ids)) {
        const entries = body.ids.map(String).map(id => store.updateEntry(id, { priority: body.priority }))
        notify()
        return { entries, priority: normalizePriority(body.priority) }
      }
      if (typeof body.group === 'string' && body.group !== '' && !Array.isArray(body.ids)) {
        const { group, movedEntries } = store.updateGroup(body.group, {
          scope: /** @type {string} */ (body.scope),
        })
        notify()
        return { group, movedEntries }
      }
      const result = store.assignEntries({
        ids: Array.isArray(body.ids) ? body.ids.map(String) : [],
        scope: typeof body.scope === 'string' && SCOPES.includes(body.scope) ? body.scope : null,
        groupId: typeof body.targetGroup === 'string' && body.targetGroup !== '' ? body.targetGroup : null,
        assignedBy: body.followGroup === true ? 'group' : 'manual',
      })
      notify()
      return result
    }
    case 'settings.set': {
      // Injection limits are stored in the vault rather than only in the profile
      // file, so the count can be tuned without a host restart.
      const defaults = limitDefaults(config)
      const limits = store.writeLimits({
        ...(body.maxEntries === undefined ? {} : { maxEntries: body.maxEntries }),
        ...(body.maxChars === undefined ? {} : { maxChars: body.maxChars }),
        ...(body.baseMaxEntries === undefined ? {} : { baseMaxEntries: body.baseMaxEntries }),
        ...(body.baseMaxChars === undefined ? {} : { baseMaxChars: body.baseMaxChars }),
      }, defaults)
      notify()
      return { limits, defaults }
    }
    case 'curate': {
      if (curate === undefined) {
        throw new Error('该宿主没有接入模型服务，无法做 AI 整理；请在接入了模型的宿主（如 DSH 插件）里执行')
      }
      const result = await curate({
        ids: Array.isArray(body.ids) ? body.ids.map(String) : undefined,
        group: typeof body.group === 'string' && body.group !== '' ? body.group : undefined,
        limit: intParam(body.limit, { min: 1, max: 50, fallback: 20 }, 'limit'),
        apply: body.apply === true,
        applyPriority: body.applyPriority === true,
        // Default generated: a memory a person typed in is left alone unless
        // the caller explicitly widens the pass.
        origin: body.origin === 'all' || body.origin === 'manual' ? body.origin : 'generated',
      })
      notify()
      return result
    }
    default:
      throw new Error(`unknown vault operation "${String(op)}"`)
  }
}
