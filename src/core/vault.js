/**
 * The host-free memory-vault core.
 *
 * Everything the vault does that is worth doing — the store, the seeded tree,
 * threshold-driven summarization with per-session locks, AI curation with its
 * all-or-nothing application, the observed transcript that feeds both — lives
 * here, with no import of any harness API. The DSH plugin (`index.js`) is one
 * adapter over this core; the CLI and the loopback RPC server
 * (`bin/memory-vault.mjs`) are others, which is how DSH, Codex, and any Node
 * host can call the same vault through the same generic interface.
 *
 * The core takes the outside world through two optional hooks:
 *
 * - `callModel` — one out-of-band model call (`{ purpose, route, system,
 *   messages, maxTokens, timeoutMs, signal, sessionId }` → `{ text, usage,
 *   provider, model }`). The DSH adapter implements it over `ctx.llm.stream`;
 *   a host without a model service simply never gets model-written records,
 *   while caller-written ones (`summarize` with `content`) still work.
 * - `resolveRoute` — "which provider/model should this call run on?", asked
 *   per purpose. DSH answers with the session's own route and, for curation,
 *   the deployment's default model.
 *
 * @module dsh-memory-vault/src/core/vault
 */

import { homedir } from 'node:os'
import { createUpdateChecker } from '../updates.js'
import { join, resolve } from 'node:path'
import { ENTRY_KINDS, MemoryStore } from '../store.js'
import { resolveVaultConfig } from '../config.js'
import { validateEntryWrite } from '../policy.js'
import { SUMMARY_SYSTEM_PROMPT, buildSummaryRequest, titleFromRecord } from '../summarize.js'
import { CURATE_SYSTEM_PROMPT, buildCurationMessage, parseCuration, parseTagMap, targetGroupFor } from '../curate.js'

/**
 * Where the vault database lives when nothing configured a path:
 * `$DSH_HOME/memory-vault/vault.sqlite`, falling back to `~/.dsh`.
 *
 * One default path is what makes the vault shared by every caller on the
 * machine — the DSH host, the CLI, the RPC server all open the same file.
 *
 * @returns {string} Absolute default database path.
 */
export function defaultDatabasePath() {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'memory-vault', 'vault.sqlite')
}

/**
 * Extract the readable text of one message's content blocks.
 *
 * @param {unknown} content - Message content blocks.
 * @returns {string} Joined text, empty when the message carries no text.
 */
export function messageText(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (/** @type {Record<string, unknown>} */ (block).type === 'text') {
      parts.push(String(/** @type {Record<string, unknown>} */ (block).text ?? ''))
    }
  }
  return parts.join('\n').trim()
}

/**
 * Create one vault: the store plus every orchestration the surfaces share.
 *
 * @param {object} options - Vault options.
 * @param {string} [options.databasePath] - SQLite path; defaults to the configured path, else {@link defaultDatabasePath}.
 * @param {import('../config.js').VaultConfig|Record<string, unknown>} [options.config] - Resolved config, or a raw row normalized here.
 * @param {(call: Record<string, any>) => Promise<{ text: string, usage: unknown, provider: string, model: string }>} [options.callModel] - Host adapter for out-of-band model calls.
 * @param {(input: { purpose: 'summarize'|'curate', session?: Record<string, any> }) => { provider: string, model: string }|undefined} [options.resolveRoute] - Host hook for picking a route.
 * @param {{ warn?: (message: string) => void, info?: (message: string) => void }} [options.logger] - Diagnostic sink.
 * @returns {Record<string, any>} The vault handle.
 * @throws {Error} When the config does not validate.
 */
export function createMemoryVault(options = {}) {
  const resolvedConfig = resolveVaultConfig(options.config ?? {})
  if ('issues' in resolvedConfig) {
    const first = resolvedConfig.issues[0]
    throw new Error(`memory-vault config invalid at ${first.path.length === 0 ? '(root)' : first.path.join('.')}: ${first.message}`)
  }
  const config = resolvedConfig.value
  const updates = options.updates ?? createUpdateChecker()
  const requestedPath = options.databasePath
    ?? (config.databasePath !== null ? config.databasePath : defaultDatabasePath())
  const databasePath = requestedPath === ':memory:' ? requestedPath : resolve(requestedPath)
  const logger = options.logger ?? {}
  const log = { warn: logger.warn ?? (() => {}), info: logger.info ?? (() => {}) }

  const store = new MemoryStore({
    path: databasePath,
    logger: { warn: (message) => { log.warn(`memory-vault: ${message}`) } },
  })
  const seeded = store.seed({
    conversation: config.conversationGroupName,
    knowledge: config.knowledgeGroupName,
  })

  /**
   * Sessions with a summarization in flight, automatic or manual.
   *
   * Both triggers reach the same orchestration, so both must respect the same
   * lock: without it a manual call could run against a slice the automatic run
   * is already covering, and the two results would file the same conversation
   * twice.
   */
  const locks = new Map()
  let changeVersion = 0
  /** @type {(() => void)[]} */
  const listeners = []

  /**
   * The last route a host observed a call running on.
   *
   * A caller outside any session — the Web panel, the RPC server — has no
   * route of its own. Remembering the latest observed route is what lets such
   * a call work without the operator configuring a provider by hand, and it is
   * always a route that demonstrably worked.
   */
  let lastRoute

  /** Record that the vault changed, for listeners that derive state from it. */
  const notify = () => {
    changeVersion += 1
    for (const listener of listeners) {
      try {
        listener()
      } catch (error) {
        log.warn(`memory-vault: change listener failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /**
   * Resolve the group a session's conversation memory belongs to.
   *
   * The default group is re-read from the database on every call rather than
   * from the snapshot taken when the vault was created: its auto-summary
   * switch, its name, and even its existence can change while the process
   * runs, and a stale object would silently keep summarizing after the switch
   * was turned off.
   * @param {string} sessionId - Session id.
   * @returns {Record<string, any>} The bound group, or the current default.
   */
  const groupForSession = (sessionId) => {
    const state = store.sessionState(sessionId)
    const bound = state.groupId === null ? undefined : store.findGroup(state.groupId)
    if (bound !== undefined) return bound
    const seededId = store.readMeta('default_conversation_group')
    const current = seededId === undefined ? undefined : store.findGroup(seededId)
    if (current !== undefined) return current
    const named = store.findGroup(config.conversationGroupName)
    if (named !== undefined) return named
    // The default group was removed by hand at some point; rebuilding it is
    // the only outcome that leaves a usable default target.
    return store.seed({
      conversation: config.conversationGroupName,
      knowledge: config.knowledgeGroupName,
    }).conversation
  }

  /**
   * Read the conversation slice one summarization should cover.
   *
   * A session is whatever carries an `id`; `deriveMessages()` (a live DSH
   * session) and a plain `messages` array (any other host) are both accepted.
   * @param {object} input - Slice request.
   * @param {Record<string, any>} input.session - Session being summarized.
   * @param {boolean} input.full - Whether to cover the whole visible session rather than the increment.
   * @returns {{ messages: { role: string, text: string }[], fromSeq: number, toSeq: number }} The slice.
   */
  const sliceFor = ({ session, full }) => {
    const sessionId = session.id
    if (!full) {
      const pending = store.unsummarized(sessionId, 400)
      return {
        messages: pending.map(message => ({ role: message.role, text: message.text })),
        fromSeq: pending.length === 0 ? 0 : pending[0].seq,
        toSeq: pending.length === 0 ? 0 : pending[pending.length - 1].seq,
      }
    }
    const messages = []
    if (typeof session.deriveMessages === 'function') {
      for (const message of session.deriveMessages()) {
        const text = messageText(message.content)
        if (text === '') continue
        messages.push({ role: message.role, text })
      }
    } else if (Array.isArray(session.messages)) {
      for (const message of session.messages) {
        const text = messageText(message.content ?? (typeof message.text === 'string' ? [{ type: 'text', text: message.text }] : undefined))
        if (text === '') continue
        messages.push({ role: message.role, text })
      }
    }
    return { messages, fromSeq: 0, toSeq: store.sessionState(sessionId).lastSeq }
  }

  /**
   * Require the host's model adapter, with the failure named for the purpose.
   * @param {'summarize'|'curate'} purpose - Which call needs a model.
   * @returns {(call: Record<string, any>) => Promise<{ text: string, usage: unknown, provider: string, model: string }>} The adapter.
   */
  const requireCallModel = (purpose) => {
    if (typeof options.callModel !== 'function') {
      throw new Error(purpose === 'curate'
        ? '该宿主没有接入模型服务，无法做 AI 整理；请在接入了模型的宿主（如 DSH 插件）里执行'
        : '该宿主没有接入模型服务，无法自动总结；请改为传入 content，由调用方直接书写记忆正文')
    }
    return options.callModel
  }

  /**
   * Turn one conversation slice into a filed memory.
   *
   * Two paths reach the same store: the caller supplies the record text (the
   * model consolidating in its own turn, or a CLI agent writing its own
   * conclusion), or the vault makes an out-of-band model call. Nothing is
   * filed unless the record is complete.
   * @param {object} request - Summarization request.
   * @param {Record<string, any>} request.session - Session being summarized; needs at least `id`.
   * @param {AbortSignal|undefined} request.signal - Caller cancellation.
   * @param {string|undefined} request.groupReference - Target group name or id.
   * @param {string|undefined} request.scope - Assignment for the created entry.
   * @param {string|undefined} request.content - Caller-written record text.
   * @param {string|undefined} request.title - Title for a caller-written record.
   * @param {string|undefined} request.instructions - Emphasis for a model-written record.
   * @param {boolean} request.full - Whether to cover the whole session.
   * @param {'auto'|'manual'} request.mode - Trigger that produced this call.
   * @param {{ provider: string, model: string }} [request.route] - Explicit route for the model call.
   * @returns {Promise<Record<string, unknown>>} The filed memory and what it covered.
   */
  const runSummarize = async (request) => {
    const group = request.groupReference === undefined
      ? groupForSession(request.session.id)
      : store.requireGroup(request.groupReference)
    const sessionId = request.session.id
    // The tag follows how the text was produced, not which button started the
    // run: a model-written record is never labelled as hand-written.
    const source = request.source === 'model-write' ? 'model-write' : request.mode === 'auto' ? 'auto-summary' : 'manual'

    if (request.content !== undefined && String(request.content).trim() !== '') {
      const fields = validateEntryWrite(
        { content: request.content, title: request.title ?? '', kind: 'summary', tags: [] },
        ENTRY_KINDS,
        config,
      )
      const entry = store.createEntry({
        groupId: group.id,
        content: fields.content,
        title: fields.title === '' ? titleFromRecord(fields.content, `会话记忆 ${new Date().toISOString().slice(0, 16)}`) : fields.title,
        kind: 'summary',
        source,
        sessionId,
        tags: [],
        scope: request.scope ?? null,
      })
      const state = store.sessionState(sessionId)
      notify()
      return {
        group,
        entry,
        covered: { messages: 0, fromSeq: state.summarizedSeq, toSeq: state.summarizedSeq },
        model: null,
        usage: null,
      }
    }

    const slice = sliceFor({ session: request.session, full: request.full })
    if (slice.messages.length === 0) {
      throw new Error('没有尚未总结的对话内容；若要把当前结论固定下来，请把正文直接传给 memory_summarize 的 content 参数')
    }
    // The adapter is asked for first: a host with no model service can never
    // produce a route either, and the refusal should name the real gap.
    const callModel = requireCallModel('summarize')
    const configuredRoute = config.summarizerProvider !== null && config.summarizerModel !== null
      ? { provider: config.summarizerProvider, model: config.summarizerModel }
      : undefined
    const route = request.route
      ?? configuredRoute
      ?? (typeof options.resolveRoute === 'function' ? options.resolveRoute({ purpose: 'summarize', session: request.session }) : undefined)
    if (route === undefined) {
      throw new Error('该会话还没有已路由的 provider/model，无法自动总结；请改为传入 content，由你直接书写记忆正文')
    }
    const record = await callModel({
      purpose: 'summarize',
      route,
      system: SUMMARY_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [{
          type: 'text',
          text: buildSummaryRequest({
            groupName: group.name,
            scope: group.scope,
            messages: slice.messages,
            instructions: request.instructions,
          }),
        }],
      }],
      maxTokens: config.summarizerMaxTokens,
      timeoutMs: config.summarizerTimeoutMs,
      signal: request.signal,
      sessionId,
    })
    // Entry, summary record, transcript marking and watermark go in as one
    // unit: a failure between them would file the same slice again next time.
    const committed = store.commitSummary({
      entry: {
        groupId: group.id,
        content: record.text,
        title: titleFromRecord(record.text, `${group.name} · ${new Date().toISOString().slice(0, 16)}`),
        kind: 'summary',
        source: 'model-summary',
        sessionId,
        tags: [],
        scope: request.scope ?? null,
      },
      mode: request.mode,
      model: `${record.provider}/${record.model}`,
      fromSeq: slice.fromSeq,
      toSeq: slice.toSeq,
      messageCount: slice.messages.length,
    })
    const entry = committed.entry
    store.pruneTranscript(sessionId, config.transcriptRetention)
    notify()
    return {
      group,
      entry,
      covered: { messages: slice.messages.length, fromSeq: slice.fromSeq, toSeq: slice.toSeq },
      model: { provider: record.provider, model: record.model },
      usage: record.usage ?? null,
    }
  }

  /**
   * Summarize one session, with at most one run in flight per session.
   *
   * The lock is taken synchronously before the first `await`, so two triggers
   * arriving in the same tick cannot both start; the second is told the session
   * is busy rather than being allowed to duplicate the work.
   * @param {object} request - Summarization request, as {@link runSummarize} takes it.
   * @returns {Promise<Record<string, unknown>>} The filed memory and what it covered.
   */
  const summarize = async (request) => {
    const sessionId = request.session.id
    if (locks.has(sessionId)) {
      throw new Error('该会话已有总结任务在进行中，请等它结束后再试')
    }
    const controller = new AbortController()
    locks.set(sessionId, controller)
    try {
      return await runSummarize(request)
    } finally {
      locks.delete(sessionId)
    }
  }

  /**
   * Curate a batch of memories with one model call.
   *
   * The vault cannot tell a conclusion that will matter for months from a
   * detail that mattered once — both look like text. The model judges; this
   * function decides what to do with the judgement, and never writes when the
   * caller only asked for a review.
   * @param {object} request - Curation request.
   * @param {Record<string, any>} [request.session] - Session whose route the call uses.
   * @param {string[]} [request.ids] - Specific memories to judge.
   * @param {string} [request.group] - Group to judge instead.
   * @param {number} [request.limit] - Batch cap.
   * @param {boolean} [request.apply] - Whether to write the verdicts.
   * @param {boolean} [request.applyPriority] - Whether reusable memories also get a priority bump.
   * @param {'generated'|'manual'|'all'} [request.origin] - Which origin to judge; `generated` by default.
   * @param {AbortSignal} [request.signal] - Caller cancellation.
   * @param {{ provider: string, model: string }} [request.route] - Explicit route for the model call.
   * @returns {Promise<Record<string, unknown>>} The verdicts and, when applied, what changed.
   */
  const curate = async ({ session, ids, group, limit = 20, apply = false, applyPriority = false, origin = 'generated', signal, route: explicitRoute }) => {
    const cap = Math.max(1, Math.min(50, Math.trunc(Number(limit) || 20)))
    // Origin decides the batch. A memory a person deliberately typed in has
    // already been curated by them, so by default only machine-written memories
    // are judged; `all` is there for the deliberate wider pass.
    const scope = origin === 'all' ? undefined : origin === 'manual' ? 'manual' : 'generated'
    const candidates = Array.isArray(ids) && ids.length > 0
      ? ids.map(id => store.findEntry(String(id)))
          .filter(entry => entry !== undefined)
          .filter(entry => scope === undefined || entry.modelWritten === (scope === 'generated'))
          .slice(0, cap)
      : store.listEntries({
          groupId: group === undefined || group === '' ? undefined : store.requireGroup(group).id,
          origin: scope,
          limit: cap,
        })
    if (candidates.length === 0) {
      const scopeLabel = scope === 'manual' ? '人工输入' : 'AI 生成'
      throw new Error(Array.isArray(ids) && ids.length > 0
        ? `给出的 ${ids.length} 个 id 里没有可整理的记忆：可能不存在，或不在「${scopeLabel}」范围内`
        : scope === 'generated'
          ? '没有可整理的 AI 生成记忆：把范围改成「全部」可以连人工输入的一起整理'
          : '没有可整理的记忆：换一个记忆组，或先用 memory_write 写入内容')
    }
    // Where the call runs, in order of how deliberate each answer is: an
    // explicit route, the plugin's own config, then the host's answer (the
    // session's route, then the deployment's default model), then whatever
    // the last observed call ran on. The default model is what makes a
    // session-less call work with nothing configured: the host resolves that
    // provider's credentials itself, so the vault never handles a key.
    const configuredRoute = config.summarizerProvider !== null && config.summarizerModel !== null
      ? { provider: config.summarizerProvider, model: config.summarizerModel }
      : undefined
    const route = explicitRoute
      ?? configuredRoute
      ?? (typeof options.resolveRoute === 'function' ? options.resolveRoute({ purpose: 'curate', session }) : undefined)
      ?? lastRoute
    if (route === undefined) {
      throw new Error(
        '没有可用的 provider/model 来做整理：配置 summarizerProvider 与 summarizerModel，'
        + '或在任意会话里发一条消息（插件会记住该会话的路由）',
      )
    }
    const record = await requireCallModel('curate')({
      purpose: 'curate',
      route,
      system: CURATE_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [{
          type: 'text',
          // The existing tree and the existing tag vocabulary, so the answer
          // reuses the headings and the labels instead of inventing more of each.
          text: buildCurationMessage(
            candidates,
            store.listGroups(),
            store.tagInventory().filter(item => item.system !== true),
          ),
        }],
      }],
      maxTokens: config.summarizerMaxTokens,
      timeoutMs: config.summarizerTimeoutMs,
      signal,
      sessionId: session?.id,
    })
    const known = new Map(candidates.map(entry => [entry.id, entry]))
    const verdicts = parseCuration(record.text)
      .filter(verdict => known.has(verdict.id))
      // Each verdict carries its origin, so every caller can show which side
      // of the line a memory sits on.
      .map(verdict => ({ ...verdict, modelWritten: known.get(verdict.id).modelWritten === true }))
    const model = { provider: record.provider, model: record.model }
    // Label merges are read from the same answer and applied vault-wide: half a
    // vault using each spelling is the problem a merge exists to fix.
    const tagMap = parseTagMap(record.text)
    if (!apply) {
      return { mode: 'review', origin: scope ?? 'all', candidates, verdicts, applied: [], tagMap, tagChanges: [], model }
    }

    // Every verdict lands in one transaction: a half-curated batch would leave
    // the vault in a state neither the old nor the new reading explains.
    const result = store.transaction(() => {
      const applied = verdicts.map(verdict => {
      const entry = /** @type {Record<string, any>} */ (known.get(verdict.id))
      const originLabel = entry.modelWritten === true ? 'AI 生成' : '人工输入'
      // Labels first: they are the part that can be applied without moving
      // anything, and the move below is what makes the entry a different thing.
      if (verdict.tags.length > 0) store.updateEntry(entry.id, { tags: verdict.tags })
      if (verdict.verdict === 'oneoff') {
        store.assignEntries({ ids: [entry.id], scope: 'conversation', groupId: null, assignedBy: 'manual' })
        return { id: entry.id, verdict: 'oneoff', scope: 'conversation', group: entry.groupName ?? '', reason: verdict.reason, origin: originLabel, tags: verdict.tags }
      }
      const name = targetGroupFor(verdict, config.knowledgeGroupName)
      let target = store.findGroup(name)
      if (target === undefined) {
        // A group the model invented is nested where it said it belongs, and
        // falls back to the top level when that name is not a real group.
        const parent = verdict.parent === '' ? undefined : store.findGroup(String(verdict.parent))
        target = store.createGroup({
          name,
          scope: 'knowledge',
          description: '由 AI 整理归类建立',
          parent: parent === undefined ? null : parent.id,
        })
      }
      store.assignEntries({ ids: [entry.id], scope: 'knowledge', groupId: target.id, assignedBy: 'manual' })
      if (applyPriority) store.updateEntry(entry.id, { priority: Math.max(60, Number(entry.priority ?? 0)) })
      return { id: entry.id, verdict: 'reusable', scope: 'knowledge', group: target.name, reason: verdict.reason, origin: originLabel, tags: verdict.tags }
      })
      const tagChanges = tagMap.map(change => store.renameTag(change.from, change.to))
      return { applied, tagChanges }
    })
    notify()
    return {
      mode: 'applied',
      origin: scope ?? 'all',
      candidates,
      verdicts,
      applied: result.applied,
      tagMap,
      tagChanges: result.tagChanges,
      model,
    }
  }

  /**
   * Whether a session has accumulated enough unsummarized material to justify
   * one model call.
   * @param {string} sessionId - Session id.
   * @returns {{ trip: boolean, messages: number, chars: number }} Threshold verdict.
   */
  const threshold = (sessionId) => {
    const pending = store.unsummarized(sessionId, 400)
    const chars = pending.reduce((total, message) => total + message.text.length, 0)
    return {
      trip: pending.length >= config.autoSummaryTurns || chars >= config.autoSummaryChars,
      messages: pending.length,
      chars,
    }
  }

  return {
    /** Open vault store; the same surface the DSH tools and panel read. */
    store,
    /** Resolved config the vault runs under. */
    config,
    /** Absolute database path this vault owns. */
    databasePath,
    /** Groups the vault was seeded with, for whoever logs readiness. */
    seeded,
    updates,

    /** Record a change and wake listeners that derive state from the vault. */
    notify,
    /** Subscribe to changes; returns an unsubscribe function. */
    onChange(listener) {
      listeners.push(listener)
      return () => {
        const at = listeners.indexOf(listener)
        if (at >= 0) listeners.splice(at, 1)
      }
    },
    /** How many changes this vault has seen; lets callers detect drift. */
    version: () => changeVersion,

    /** Remember a route a host observed, so session-less calls have one to use. */
    noteRoute(route) {
      if (route !== undefined && route !== null) lastRoute = route
    },
    /** Feed one observed message into the transcript; hosts decide what counts as human. */
    observe({ sessionId, seq, role, text, time }) {
      store.appendMessage({ sessionId, seq: Number(seq) || 0, role, text, time: time ?? Date.now() })
    },
    /** Whether a summarization is in flight for one session. */
    isSummarizing: (sessionId) => locks.has(sessionId),
    groupForSession,
    threshold,

    /**
     * Decide whether an automatic summarization should start now.
     *
     * Everything the automatic trigger checks, in one place: the deployment
     * switches, the in-flight lock, the bound group's own auto-summary switch,
     * and the threshold. Returns the verdict with the group when it trips.
     * @param {string} sessionId - Session that just closed a turn.
     * @returns {{ group: Record<string, any>, verdict: { trip: true, messages: number, chars: number } }|undefined} The decision.
     */
    shouldAutoSummarize(sessionId) {
      if (!config.autoSummary || config.summarizer !== 'llm') return undefined
      // `summarize` takes the lock itself; this check only avoids queueing a
      // task that would immediately be refused.
      if (locks.has(sessionId)) return undefined
      const group = groupForSession(sessionId)
      if (group.autoSummary !== true) return undefined
      const verdict = threshold(sessionId)
      if (!verdict.trip) return undefined
      return { group, verdict }
    },

    /** @type {typeof summarize} */
    summarize,
    /** @type {typeof curate} */
    curate,

    /** Abort in-flight summarizations and close the store. */
    dispose() {
      if (!options.updates) updates.dispose()
      for (const controller of locks.values()) controller.abort(new Error('memory vault unloaded'))
      locks.clear()
      listeners.length = 0
      store.close()
    },
  }
}
