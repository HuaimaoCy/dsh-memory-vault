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
 * This module is the DSH adapter. The vault itself — the store, seeded tree,
 * threshold summarization, AI curation, the observed transcript — lives in the
 * host-free core (`src/core/vault.js`), so the same vault is drivable from DSH
 * (this plugin), from Codex or any shell (`bin/memory-vault.mjs`), and from any
 * Node host (`createMemoryVault`). What this adapter adds is exactly the DSH
 * half: tools, the prompt index, the panel route, the `session/event` feed,
 * and model calls through `ctx.llm.stream`.
 *
 * @module dsh-memory-vault
 */

import { buildTools } from './src/tools.js'
import { registerIndexSection } from './src/prompt.js'
import { registerVaultRoutes } from './src/http.js'
import { callLlmStream, routeFromSession } from './src/summarize.js'
import { createMemoryVault, messageText } from './src/core/vault.js'

export { Config, CONFIG_DEFAULTS } from './src/config.js'
export { MemoryStore, SCOPES, ENTRY_KINDS } from './src/store.js'
export { SUMMARY_SYSTEM_PROMPT } from './src/summarize.js'
export { createMemoryVault, defaultDatabasePath } from './src/core/vault.js'
export { operateVault, VAULT_OPS } from './src/core/ops.js'

/** Cordis plugin name. */
export const name = 'memory-vault'

/**
 * Required services. Everything else — the LLM, the system prompt, the web
 * server — is optional and resolved per use, so a headless composition without
 * a web server still gets the full tool surface.
 */
export const inject = ['tools']

/**
 * Whether one committed user message is part of the human conversation rather
 * than plugin- or harness-injected context.
 *
 * @param {Record<string, any>} data - `user/message` event payload.
 * @returns {boolean} True when the message should enter the observed transcript.
 */
function isHumanMessage(data) {
  const kind = data?.source?.kind
  return kind === undefined || kind === 'user'
}

/**
 * Register the vault as a DSH plugin.
 *
 * @param {object} ctx - Plugin context carrying the tools registry.
 * @param {import('./src/config.js').VaultConfig} config - Resolved plugin config.
 * @returns {void}
 */
export function apply(ctx, config) {
  const vault = createMemoryVault({
    config,
    logger: {
      warn: (message) => { ctx.logger.warn(`memory-vault: ${message}`) },
      info: (message) => { ctx.logger.info(`memory-vault: ${message}`) },
    },
    // The DSH half of a model call: one out-of-band `ctx.llm.stream`, drained
    // and deadline-guarded by the shared, host-free driver. The call never
    // enters a session log and never wakes an idle agent.
    callModel: (call) => {
      const llm = ctx.get('llm')
      if (llm === undefined || llm === null || typeof llm.stream !== 'function') {
        throw new Error(call.purpose === 'curate'
          ? '当前宿主没有提供可用的模型服务（ctx.llm），无法做 AI 整理'
          : 'no llm service is available for out-of-band summarization')
      }
      return callLlmStream(llm, call)
    },
    resolveRoute: ({ purpose, session }) => {
      // Summarization follows the session it belongs to, and only that.
      if (session !== undefined) {
        const route = routeFromSession(session)
        if (route !== undefined) return route
      }
      if (purpose !== 'curate') return undefined
      // The deployment's own default model selection: the harness's configured
      // default, credentials and all, and what a call that belongs to no
      // session should use — the vault asks for a route by name and never sees
      // or handles a key.
      try {
        const service = ctx.get('agentDefaultModel')
        if (service === undefined || service === null || typeof service.currentSelection !== 'function') return undefined
        const selection = service.currentSelection()
        const provider = selection?.provider
        const model = selection?.model
        if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') return undefined
        return { provider, model }
      } catch (_error) {
        // A host without the service simply has no default to offer.
        return undefined
      }
    },
  })
  const { store, notify } = vault

  // Tools are the vault's primary surface: everything a person can do from the
  // Web panel, the model can do from a turn.
  for (const definition of buildTools({ store, config: vault.config, summarize: vault.summarize, curate: vault.curate, notify, updates: vault.updates,
    saveImageAttachment: async (image, signal) => {
      signal?.throwIfAborted()
      const attachments = ctx.get('attachments')
      if (!attachments?.saveImage) throw new Error('DSH 图片附件服务不可用，请升级宿主或通过记忆库界面查看')
      const ref = await attachments.saveImage({ data: Buffer.from(image.data, 'base64'), mediaType: image.mimeType, name: image.name })
      signal?.throwIfAborted()
      return ref
    },
  })) {
    ctx.tools.register(definition)
  }

  ctx.effect(() => {
    const dispose = registerIndexSection(ctx, { store, config: vault.config })
    return () => { dispose?.() }
  }, 'memory-vault: prompt index')

  ctx.effect(() => {
    const dispose = registerVaultRoutes(ctx, { store, config: vault.config, notify, curate: vault.curate, updates: vault.updates })
    return () => { dispose?.() }
  }, 'memory-vault: panel routes')

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
    const decision = vault.shouldAutoSummarize(session.id)
    if (decision === undefined) return
    void (async () => {
      try {
        const result = await vault.summarize({
          session,
          full: false,
          mode: 'auto',
        })
        ctx.logger.info(
          `memory-vault: summarized ${String(decision.verdict.messages)} messages into "${decision.group.name}"`
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
      // one is what gives a session-less call something to call with.
      const seen = routeFromSession(session)
      if (seen !== undefined) vault.noteRoute(seen)
      if (event.type === 'user/message') {
        if (isHumanMessage(event.data)) {
          vault.observe({
            sessionId,
            seq: event.seq,
            role: 'user',
            text: messageText(event.data.content),
            time: event.time,
          })
        }
        return
      }
      if (event.type === 'assistant/message') {
        vault.observe({
          sessionId,
          seq: event.seq,
          role: 'assistant',
          text: messageText(event.data.message?.content),
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
    vault.dispose()
  }, 'memory-vault: close vault')

  ctx.logger.info(`memory-vault: vault ready at ${vault.databasePath}`)
}
