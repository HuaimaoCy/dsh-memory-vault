/**
 * Out-of-band summarization: turn a slice of observed conversation into one
 * durable memory record using the session's own routed model.
 *
 * The call goes through `ctx.llm.stream` — the harness's one-shot model
 * egress — so it never enters a session log, never wakes an idle agent, and
 * never replays through the agent loop. Cancellation and provider failure
 * arrive as terminal `finish` chunks rather than thrown errors, so the stream
 * is drained to its end and classified explicitly; a truncated or failed
 * record is rejected instead of being filed as memory.
 *
 * @module dsh-memory-vault/src/summarize
 */

/** Instructions for one summarization call. Deliberately provider-neutral and language-following. */
export const SUMMARY_SYSTEM_PROMPT = [
  'You are the memory engine of a coding assistant. Compress the supplied conversation segment into one durable memory record that a later session can use without re-reading the segment.',
  '',
  'Output ONLY the record below, in Markdown, keeping every section in this exact order:',
  '',
  '## 摘要',
  '- [two to five bullets: what happened and where the work now stands]',
  '',
  '## 关键事实',
  '- [durable facts only: exact file paths, commands, identifiers, error strings, numeric values, versions]',
  '',
  '## 决策',
  '- [each decision with its rationale, and what it rules out]',
  '',
  '## 未决',
  '- [open questions, blockers, and unfinished work]',
  '',
  'Rules:',
  '- Write terse bullets, never prose paragraphs. Write "(无)" for an empty section; never drop a section.',
  '- Write the record in the language predominantly used in the conversation.',
  '- Preserve exact paths, commands, identifiers, error strings and numeric values verbatim; never translate them.',
  '- Write every formula as LaTeX math: inline as $...$, and a displayed formula as its own $$...$$ line. The vault renders both.',
  '- Record only what the conversation establishes. Never invent, infer, or generalize beyond it.',
  '- Output the record as plain text. Call no tool, emit no reasoning, and add no preamble, summary of these instructions, or sign-off.',
].join('\n')

/**
 * Build the user payload for one summarization call.
 * @param {object} input - Call input.
 * @param {string} input.groupName - Group the record will be filed into.
 * @param {string} input.scope - `conversation` or `knowledge`.
 * @param {{ role: string, text: string }[]} input.messages - Transcript slice, oldest first.
 * @param {string} [input.instructions] - Caller-supplied emphasis.
 * @returns {string} The user message text.
 */
export function buildSummaryRequest({ groupName, scope, messages, instructions }) {
  const transcript = messages
    .map(message => `<${message.role}>\n${message.text}\n</${message.role}>`)
    .join('\n\n')
  const framing = scope === 'knowledge'
    ? 'This segment is being filed as reusable knowledge, so prefer conclusions, reusable procedures, and facts that outlive this session.'
    : 'This segment is being filed as conversation memory for the session it came from, so keep the local working state, current goal, and immediate next steps.'
  return [
    `Memory group: ${groupName}`,
    framing,
    ...(instructions === undefined || instructions.trim() === ''
      ? []
      : [`Additional emphasis from the caller: ${instructions.trim()}`]),
    '',
    `Conversation segment (${messages.length} messages, oldest first):`,
    '',
    transcript,
  ].join('\n')
}

/**
 * Classify a terminal stream reason.
 * @param {{ kind: string, failure?: { code?: string, message?: string } }|undefined} finish - Terminal reason reported by the stream, when one arrived.
 * @returns {Error|undefined} The failure to raise, or undefined for a complete record.
 */
export function finishError(finish) {
  if (finish === undefined) return undefined
  switch (finish.kind) {
    case 'error':
    case 'aborted':
      return new Error(`model call ended with ${finish.kind}: ${finish.failure?.code ?? 'UNKNOWN'}: ${finish.failure?.message ?? 'no detail'}`)
    case 'max-tokens':
      return new Error('memory record was truncated at the token cap and would be incomplete')
    default:
      return undefined
  }
}

/**
 * Resolve the provider/model a session is routed to.
 * @param {{ requestHeader?: () => { config?: { provider?: string, model?: string } }|undefined }} session - Session the record belongs to.
 * @returns {{ provider: string, model: string }|undefined} Route, or undefined when the session has not routed a request yet.
 */
export function routeFromSession(session) {
  const config = session.requestHeader?.()?.config
  if (config === undefined) return undefined
  const provider = config.provider
  const model = config.model
  if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') return undefined
  return { provider, model }
}

/**
 * Combine a caller signal with a deadline.
 * @param {AbortSignal|undefined} signal - Caller cancellation.
 * @param {number} timeoutMs - Deadline in milliseconds.
 * @returns {{ signal: AbortSignal, dispose: () => void }} The derived signal and its timer cleanup.
 */
export function withDeadline(signal, timeoutMs) {
  const controller = new AbortController()
  const onAbort = () => { controller.abort(signal?.reason) }
  if (signal !== undefined) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => { controller.abort(new Error(`summarization exceeded ${timeoutMs}ms`)) }, timeoutMs)
  if (typeof timer.unref === 'function') timer.unref()
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    },
  }
}

/**
 * Summarize one transcript slice with the session's routed model.
 * @param {object} ctx - Plugin context carrying the optional `llm` service.
 * @param {object} request - Call request.
 * @param {{ provider: string, model: string }} request.route - Provider and model to call.
 * @param {string} request.groupName - Group the record is filed into.
 * @param {string} request.scope - Group assignment.
 * @param {{ role: string, text: string }[]} request.messages - Transcript slice, oldest first.
 * @param {string} [request.instructions] - Caller-supplied emphasis.
 * @param {string|null} [request.sessionId] - Session the call is attributed to.
 * @param {number} request.maxTokens - Output cap.
 * @param {number} request.timeoutMs - Deadline in milliseconds.
 * @param {AbortSignal} [request.signal] - Caller cancellation.
 * @returns {Promise<{ text: string, usage: unknown, provider: string, model: string }>} The memory record.
 * @throws {Error} When the model is unavailable, the call fails, or the record is empty or truncated.
 */
export async function summarizeWithModel(ctx, request) {
  const llm = ctx.get('llm')
  if (llm === undefined || llm === null || typeof llm.stream !== 'function') {
    throw new Error('no llm service is available for out-of-band summarization')
  }
  const deadline = withDeadline(request.signal, request.timeoutMs)
  try {
    /** @type {Record<string, unknown>} */
    const options = {
      provider: request.route.provider,
      model: request.route.model,
      // A one-shot caller owns the system slot; the agent-loop rule that keeps
      // it undefined applies only to loop-built requests.
      system: SUMMARY_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [{
          type: 'text',
          text: buildSummaryRequest({
            groupName: request.groupName,
            scope: request.scope,
            messages: request.messages,
            instructions: request.instructions,
          }),
        }],
      }],
      maxTokens: request.maxTokens,
      signal: deadline.signal,
      ...(request.sessionId === undefined || request.sessionId === null ? {} : { sessionId: request.sessionId }),
    }
    let text = ''
    let usage
    /** @type {{ kind: string, failure?: { code?: string, message?: string } }|undefined} */
    let finish
    for await (const chunk of llm.stream(options)) {
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'usage') usage = chunk.usage
      else if (chunk.type === 'finish') finish = chunk.reason
    }
    if (deadline.signal.aborted) throw new Error('summarization was cancelled or timed out')
    const failure = finishError(finish)
    if (failure !== undefined) throw failure
    const record = text.trim()
    if (record === '') throw new Error('the model produced an empty memory record')
    return { text: record, usage, provider: options.provider, model: options.model }
  } finally {
    deadline.dispose()
  }
}

/**
 * Derive a short entry title from a memory record.
 * @param {string} text - Record body.
 * @param {string} fallback - Title to use when the record has no usable heading.
 * @returns {string} A one-line title.
 */
export function titleFromRecord(text, fallback) {
  const line = text.split('\n').map(part => part.trim()).find(part => part !== '' && !part.startsWith('#'))
  if (line === undefined) return fallback
  const trimmed = line.replace(/^[-*]\s*/, '')
  return trimmed.length <= 80 ? trimmed : `${trimmed.slice(0, 79)}…`
}
