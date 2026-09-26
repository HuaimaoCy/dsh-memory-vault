/**
 * dsh-memory-vault — a knowledge and memory vault for DSH.
 *
 * The vault keeps two things apart that most memory tools conflate: memory
 * groups, which are the containers a person curates, and assignment, which
 * says whether a memory belongs to the conversation that produced it
 * (`conversation`) or to the knowledge base that outlives it (`knowledge`).
 * Either can be moved at any time, by the model through a tool or by a person
 * through the Web panel.
 *
 * Summarization is threshold-driven and incremental: the plugin observes the
 * committed conversation, and once the bound conversation group has
 * accumulated enough unsummarized material it makes one out-of-band model call
 * through `ctx.llm.stream` and files the result as a memory. That call never
 * enters a session log and never wakes an idle agent.
 *
 * @module dsh-memory-vault
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { ENTRY_KINDS, MemoryStore } from './src/store.js'
import { buildTools } from './src/tools.js'
import { registerIndexSection } from './src/prompt.js'
import { registerVaultRoutes } from './src/http.js'
import { validateEntryWrite } from './src/policy.js'
import { curateWithModel, parseCuration, targetGroupFor } from './src/curate.js'
import { routeFromSession, summarizeWithModel, titleFromRecord } from './src/summarize.js'

export { Config, CONFIG_DEFAULTS } from './src/config.js'
export { MemoryStore, SCOPES, ENTRY_KINDS } from './src/store.js'
export { SUMMARY_SYSTEM_PROMPT } from './src/summarize.js'

/** Cordis plugin name. */
export const name = 'memory-vault'

/**
 * Required services. Everything else — the LLM, the system prompt, the web
 * server — is optional and resolved per use, so a headless composition without
 * a web server still gets the full tool surface.
 */
export const inject = ['tools']

/**
 * Resolve the vault database path: the configured path, else
 * `$DSH_HOME/memory-vault/vault.sqlite`.
 * @param {import('./src/config.js').VaultConfig} config - Resolved plugin config.
 * @returns {string} Absolute database path.
 */
function resolveDatabasePath(config) {
  if (config.databasePath !== null) return config.databasePath
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'memory-vault', 'vault.sqlite')
}

/**
 * Extract the readable text of one message's content blocks.
 * @param {unknown} content - Message content blocks.
 * @returns {string} Joined text, empty when the message carries no text.
 */
function textOf(content) {
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
 * Whether one committed user message is part of the human conversation rather
 * than plugin- or harness-injected context.
 * @param {Record<string, any>} data - `user/message` event payload.
 * @returns {boolean} True when the message should enter the observed transcript.
 */
function isHumanMessage(data) {
  const kind = data?.source?.kind
  return kind === undefined || kind === 'user'
}

/**
 * Register the vault.
 * @param {object} ctx - Plugin context carrying the tools registry.
 * @param {import('./src/config.js').VaultConfig} config - Resolved plugin config.
 * @returns {void}
 */
export function apply(ctx, config) {
  const databasePath = resolveDatabasePath(config)
  const store = new MemoryStore({
    path: databasePath,
    logger: { warn: (message) => { ctx.logger.warn(`memory-vault: ${message}`) } },
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

  /**
   * The last provider/model route a turn actually ran on.
   *
   * The Web panel is not inside a session, so a call it starts has no route of
   * its own. Remembering the route of the most recent turn is what lets the
   * panel's curation button work without the operator configuring a provider by
   * hand — and it is always a route that demonstrably works.
   */
  let lastRoute

  /** Record that the vault changed, for listeners that derive state from it. */
  const notify = () => {
    changeVersion += 1
  }

  /**
   * Resolve the group a session's conversation memory belongs to.
   *
   * The default group is re-read from the database on every call rather than
   * from the snapshot taken when the plugin loaded: its auto-summary switch,
   * its name, and even its existence can change while the process runs, and a
   * stale object would silently keep summarizing after the switch was turned
   * off.
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
    for (const message of session.deriveMessages()) {
      const text = textOf(message.content)
      if (text === '') continue
      messages.push({ role: message.role, text })
    }
    return { messages, fromSeq: 0, toSeq: store.sessionState(sessionId).lastSeq }
  }

  /**
   * Turn one conversation slice into a filed memory.
   *
   * Two paths reach the same store: the caller supplies the record text (the
   * model consolidating in its own turn), or the plugin makes an out-of-band
   * model call. Nothing is filed unless the record is complete.
   * @param {object} request - Summarization request.
   * @param {Record<string, any>} request.session - Session being summarized.
   * @param {AbortSignal|undefined} request.signal - Caller cancellation.
   * @param {string|undefined} request.groupReference - Target group name or id.
   * @param {string|undefined} request.scope - Assignment for the created entry.
   * @param {string|undefined} request.content - Caller-written record text.
   * @param {string|undefined} request.title - Title for a caller-written record.
   * @param {string|undefined} request.instructions - Emphasis for a model-written record.
   * @param {boolean} request.full - Whether to cover the whole session.
   * @param {'auto'|'manual'} request.mode - Trigger that produced this call.
   * @returns {Promise<Record<string, unknown>>} The filed memory and what it covered.
   */
  const runSummarize = async (request) => {
    const group = request.groupReference === undefined
      ? groupForSession(request.session.id)
      : store.requireGroup(request.groupReference)
    const sessionId = request.session.id
    // The tag follows how the text was produced, not which button started the
    // run: a model-written record is never labelled as hand-written.
    const source = request.mode === 'auto' ? 'auto-summary' : 'manual'

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
    const route = config.summarizerProvider !== null && config.summarizerModel !== null
      ? { provider: config.summarizerProvider, model: config.summarizerModel }
      : routeFromSession(request.session)
    if (route === undefined) {
      throw new Error('该会话还没有已路由的 provider/model，无法自动总结；请改为传入 content，由你直接书写记忆正文')
    }
    const record = await summarizeWithModel(ctx, {
      route,
      groupName: group.name,
      scope: group.scope,
      messages: slice.messages,
      instructions: request.instructions,
      sessionId,
      maxTokens: config.summarizerMaxTokens,
      timeoutMs: config.summarizerTimeoutMs,
      signal: request.signal,
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
   * @param {AbortSignal} [request.signal] - Caller cancellation.
   * @returns {Promise<Record<string, unknown>>} The verdicts and, when applied, what changed.
   */
  const curate = async ({ session, ids, group, limit = 20, apply = false, applyPriority = false, signal }) => {
    const cap = Math.max(1, Math.min(50, Math.trunc(Number(limit) || 20)))
    const candidates = Array.isArray(ids) && ids.length > 0
      ? ids.map(id => store.findEntry(String(id))).filter(entry => entry !== undefined).slice(0, cap)
      : store.listEntries({
          groupId: group === undefined || group === '' ? undefined : store.requireGroup(group).id,
          limit: cap,
        })
    if (candidates.length === 0) {
      throw new Error('没有可整理的记忆：换一个记忆组，或先用 memory_write 写入内容')
    }
    const route = config.summarizerProvider !== null && config.summarizerModel !== null
      ? { provider: config.summarizerProvider, model: config.summarizerModel }
      : session === undefined
        ? lastRoute
        : routeFromSession(session) ?? lastRoute
    if (route === undefined) {
      throw new Error(
        '没有可用的 provider/model 来做整理：在任意会话里发一条消息即可（插件会记住该会话的路由），'
        + '或配置 summarizerProvider 与 summarizerModel',
      )
    }
    const record = await curateWithModel(ctx, {
      route,
      entries: candidates,
      sessionId: session?.id,
      maxTokens: config.summarizerMaxTokens,
      timeoutMs: config.summarizerTimeoutMs,
      signal,
    })
    const known = new Map(candidates.map(entry => [entry.id, entry]))
    const verdicts = parseCuration(record.text).filter(verdict => known.has(verdict.id))
    const model = { provider: record.provider, model: record.model }
    if (!apply) return { mode: 'review', candidates, verdicts, applied: [], model }

    // Every verdict lands in one transaction: a half-curated batch would leave
    // the vault in a state neither the old nor the new reading explains.
    const applied = store.transaction(() => verdicts.map(verdict => {
      const entry = /** @type {Record<string, any>} */ (known.get(verdict.id))
      if (verdict.verdict === 'oneoff') {
        store.assignEntries({ ids: [entry.id], scope: 'conversation', groupId: null, assignedBy: 'manual' })
        return { id: entry.id, verdict: 'oneoff', scope: 'conversation', group: entry.groupName ?? '', reason: verdict.reason }
      }
      const name = targetGroupFor(verdict, config.knowledgeGroupName)
      const target = store.findGroup(name)
        ?? store.createGroup({ name, scope: 'knowledge', description: '由 AI 整理归类建立' })
      store.assignEntries({ ids: [entry.id], scope: 'knowledge', groupId: target.id, assignedBy: 'manual' })
      if (applyPriority) store.updateEntry(entry.id, { priority: Math.max(60, Number(entry.priority ?? 0)) })
      return { id: entry.id, verdict: 'reusable', scope: 'knowledge', group: target.name, reason: verdict.reason }
    }))
    notify()
    return { mode: 'applied', candidates, verdicts, applied, model }
  }

  // Tools are the vault's primary surface: everything a person can do from the
  // Web panel, the model can do from a turn.
  for (const definition of buildTools({ store, config, summarize, curate, notify })) {
    ctx.tools.register(definition)
  }

  ctx.effect(() => {
    const dispose = registerIndexSection(ctx, { store, config })
    return () => { dispose?.() }
  }, 'memory-vault: prompt index')

  ctx.effect(() => {
    const dispose = registerVaultRoutes(ctx, { store, config, notify, curate })
    return () => { dispose?.() }
  }, 'memory-vault: panel routes')

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

  /**
   * Start one automatic summarization when the thresholds are met.
   *
   * The task is detached: a turn boundary must never wait on a model call the
   * user did not ask for. Failure is reported and swallowed, and at most one
   * run per session is in flight.
   * @param {Record<string, any>} session - Session that just closed a turn.
   * @returns {void}
   */
  const maybeAutoSummarize = (session) => {
    if (!config.autoSummary || config.summarizer !== 'llm') return
    const sessionId = session.id
    // `summarize` takes the lock itself; this check only avoids queueing a task
    // that would immediately be refused.
    if (locks.has(sessionId)) return
    const group = groupForSession(sessionId)
    if (group.autoSummary !== true) return
    const verdict = threshold(sessionId)
    if (!verdict.trip) return
    void (async () => {
      try {
        const result = await summarize({
          session,
          full: false,
          mode: 'auto',
        })
        ctx.logger.info(
          `memory-vault: summarized ${String(verdict.messages)} messages into "${group.name}"`
          + ` as ${String(/** @type {Record<string, any>} */ (result.entry).id)}`,
        )
      } catch (error) {
        // The conversation continues regardless: an automatic summarization is
        // an enhancement, never a precondition for the next turn.
        ctx.logger.warn(`memory-vault: automatic summarization failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    })()
  }

  // The vault observes committed conversation rather than intercepting it:
  // `session/event` is a post-commit feed, so a failure here can never make a
  // committed append fail.
  ctx.on('session/event', (session, event) => {
    try {
      const sessionId = session.id
      // Every observed turn advertises the route it ran on; keeping the latest
      // one is what gives a panel-initiated call something to call with.
      const seen = routeFromSession(session)
      if (seen !== undefined) lastRoute = seen
      if (event.type === 'user/message') {
        if (isHumanMessage(event.data)) {
          store.appendMessage({
            sessionId,
            seq: event.seq,
            role: 'user',
            text: textOf(event.data.content),
            time: event.time,
          })
        }
        return
      }
      if (event.type === 'assistant/message') {
        store.appendMessage({
          sessionId,
          seq: event.seq,
          role: 'assistant',
          text: textOf(event.data.message?.content),
          time: event.time,
        })
        return
      }
      if (event.type === 'turn/end') maybeAutoSummarize(session)
    } catch (error) {
      ctx.logger.warn(`memory-vault: transcript observation failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  ctx.effect(() => () => {
    for (const controller of locks.values()) controller.abort(new Error('memory vault unloaded'))
    locks.clear()
    store.close()
  }, 'memory-vault: close vault')

  ctx.logger.info(`memory-vault: vault ready at ${databasePath}`)
}
