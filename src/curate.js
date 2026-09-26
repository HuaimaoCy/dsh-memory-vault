/**
 * AI curation: decide whether each memory is reusable knowledge or a one-off
 * note, and where it belongs.
 *
 * The vault can hold both kinds and cannot tell them apart by itself — a
 * conclusion that will matter for months and a detail that only mattered for
 * one task look the same once written. One model call over a batch of memories
 * produces the judgement, and the caller decides whether to act on it.
 *
 * @module dsh-memory-vault/src/curate
 */

import { finishError, withDeadline } from './summarize.js'

/** The JSON contract the model is asked to answer in. */
export const CURATE_SYSTEM_PROMPT = [
  '你是知识库整理器。你会收到一批记忆条目，请逐条判断它的性质，并只输出一个 JSON 对象，不要任何解释或代码块标记。',
  '',
  '输出格式：',
  '{"items":[{"id":"mem_...","verdict":"reusable|oneoff","reason":"一句话理由","group":"建议的记忆组名称"}]}',
  '',
  '判断标准：',
  '- reusable（可复用）：结论、事实、约定、偏好、可复用的操作步骤或排错结论——换个任务、换个会话仍然成立，值得长期保留。',
  '- oneoff（单次性）：只对某一次任务、某一次对话、某个临时环境成立的细节；进度、临时决定、一次性排查过程、已被后续结论取代的旧状态。',
  '',
  '其它要求：',
  '- 每条都必须给出 verdict，不确定时倾向 oneoff（宁可少收录，不要把一次性内容固化）。',
  '- group 用简短的中文名词短语（4-12 字），同一批里语义相同的必须用完全相同的名称，便于归并成组；不要用「其他」「杂项」这类无信息量的名称。',
  '- reason 不超过 30 字，说清判断依据。',
  '- 不要编造 id，只能使用输入里出现过的 id。',
].join('\n')

/**
 * Render the batch the model decides on.
 * @param {Record<string, any>[]} entries - Candidate memories.
 * @returns {string} The user message.
 */
export function buildCurationMessage(entries) {
  const lines = entries.map(entry => {
    const title = entry.title === '' ? '(无标题)' : entry.title
    const body = String(entry.content).replace(/\s+/g, ' ').slice(0, 400)
    return [
      `id: ${String(entry.id)}`,
      `标题: ${title}`,
      `当前归属: ${entry.scope === 'knowledge' ? '知识库' : '对话记忆'}`,
      `当前记忆组: ${String(entry.groupName ?? '')}`,
      `类型: ${String(entry.kind)}`,
      `正文: ${body}`,
    ].join('\n')
  })
  return `共 ${String(entries.length)} 条记忆，请逐条判断：\n\n${lines.join('\n\n')}`
}

/**
 * Read one curation answer.
 *
 * The model is asked for bare JSON, but a fenced block is a common enough slip
 * that unwrapping it is cheaper than failing the whole call.
 * @param {string} text - Raw model output.
 * @returns {{ id: string, verdict: 'reusable'|'oneoff', reason: string, group: string }[]} Verdicts in output order.
 * @throws {Error} When the answer is not usable JSON with the expected shape.
 */
export function parseCuration(text) {
  const raw = String(text ?? '').trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw)
  const body = fenced === null ? raw : fenced[1].trim()
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) throw new Error('整理结果不是 JSON 对象，请重试或缩小整理范围')
  let parsed
  try {
    parsed = JSON.parse(body.slice(start, end + 1))
  } catch (error) {
    throw new Error(`整理结果无法解析为 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
  const items = Array.isArray(parsed) ? parsed : parsed.items
  if (!Array.isArray(items)) throw new Error('整理结果缺少 items 数组')
  return items.map(item => {
    const verdict = item?.verdict === 'reusable' ? 'reusable' : 'oneoff'
    return {
      id: String(item?.id ?? ''),
      verdict,
      reason: String(item?.reason ?? '').slice(0, 120),
      group: String(item?.group ?? '').trim().slice(0, 40),
    }
  }).filter(item => item.id !== '')
}

/**
 * The group name a curated, reusable memory should be filed under, falling back
 * to the knowledge base when the model declined to name one.
 * @param {{ group: string }} verdict - One verdict.
 * @param {string} fallback - Group name to use when the verdict names none.
 * @returns {string} Group name.
 */
export function targetGroupFor(verdict, fallback) {
  return verdict.group === '' ? fallback : verdict.group
}

/**
 * Make the one curation call.
 *
 * Like summarization this is an out-of-band `ctx.llm.stream`: it never enters a
 * session log and never wakes an idle agent, and the terminal `finish` chunk is
 * checked explicitly because a truncation arrives as data rather than an error.
 * @param {object} ctx - Plugin context.
 * @param {object} request - Call request.
 * @param {{ provider: string, model: string }} request.route - Resolved route.
 * @param {Record<string, any>[]} request.entries - Memories to judge.
 * @param {string} [request.sessionId] - Session whose route this uses.
 * @param {number} request.maxTokens - Output cap.
 * @param {number} request.timeoutMs - Deadline.
 * @param {AbortSignal} [request.signal] - Caller cancellation.
 * @returns {Promise<{ text: string, usage: unknown, provider: string, model: string }>} The raw answer.
 * @throws {Error} When the model is unavailable, fails, or answers nothing.
 */
export async function curateWithModel(ctx, request) {
  const llm = ctx.get('llm')
  if (llm === undefined || llm === null || typeof llm.stream !== 'function') {
    throw new Error('当前宿主没有提供可用的模型服务（ctx.llm），无法做 AI 整理')
  }
  const deadline = withDeadline(request.signal, request.timeoutMs)
  try {
    let text = ''
    let usage
    /** @type {{ kind: string, failure?: { code?: string, message?: string } }|undefined} */
    let finish
    for await (const chunk of llm.stream({
      provider: request.route.provider,
      model: request.route.model,
      system: CURATE_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: buildCurationMessage(request.entries) }],
      }],
      maxTokens: request.maxTokens,
      signal: deadline.signal,
      ...(request.sessionId === undefined || request.sessionId === null ? {} : { sessionId: request.sessionId }),
    })) {
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'usage') usage = chunk.usage
      else if (chunk.type === 'finish') finish = chunk.reason
    }
    if (deadline.signal.aborted) throw new Error('整理被取消或超时')
    const failure = finishError(finish)
    if (failure !== undefined) throw failure
    if (text.trim() === '') throw new Error('模型没有返回整理结果')
    return { text: text.trim(), usage, provider: request.route.provider, model: request.route.model }
  } finally {
    deadline.dispose()
  }
}
