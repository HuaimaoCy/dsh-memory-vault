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

import { callLlmStream } from './summarize.js'
import { normalizeTags } from './policy.js'

/** The JSON contract the model is asked to answer in. */
export const CURATE_SYSTEM_PROMPT = [
  '你是知识库整理器。你会收到一批记忆条目，请逐条判断它的性质，并只输出一个 JSON 对象，不要任何解释或代码块标记。',
  '',
  '输出格式：',
  '{"items":[{"id":"mem_...","verdict":"reusable|oneoff","reason":"一句话理由","group":"建议的记忆组名称","parent":"该组应挂在哪个现有父组下，没有合适的就留空字符串","tags":["标签1","标签2"]}],'
    + '"tagMap":[{"from":"现有标签","to":"统一后的写法","reason":"一句话理由"}]}',
  '',
  '判断标准：',
  '- reusable（可复用）：结论、事实、约定、偏好、可复用的操作步骤或排错结论——换个任务、换个会话仍然成立，值得长期保留。',
  '- oneoff（单次性）：只对某一次任务、某一次对话、某个临时环境成立的细节；进度、临时决定、一次性排查过程、已被后续结论取代的旧状态。',
  '',
  '其它要求：',
  '- 每条都必须给出 verdict，不确定时倾向 oneoff（宁可少收录，不要把一次性内容固化）。',
  '- 输入标着「人工输入」的记忆是人特意写下的，已经被人整理过一次：除非它明显只对某一次任务成立，否则倾向 reusable。',
  '- 输入标着「AI 生成」的记忆是模型写的（自动总结或在会话中写入），它们才是主要需要判断的对象：进度、过程与临时状态多半在这里。',
  '- group 用简短的中文名词短语（4-12 字），同一批里语义相同的必须用完全相同的名称，便于归并成组；不要用「其他」「杂项」这类无信息量的名称。',
  '- parent 只能从「现有记忆组」里原样挑一个名称，或留空。平铺的组已经太多了，所以**只要语义上说得通，就把新组挂到已有父组下**，不要每批都新建一个顶层组。',
  '- reason 不超过 30 字，说清判断依据。',
  '- 不要编造 id，只能使用输入里出现过的 id。',
  '',
  '标签要和记忆一起整理，两部分输出缺一不可：',
  '- items[].tags：这条记忆应有的标签，2-5 个、每个 2-8 字的名词短语。**优先复用「现有标签」里已有的写法**，不要为同一个概念另造新词；'
    + '不要写「其他」「杂项」这类无信息量的标签；不要写系统标签（「人工输入」「AI 生成」由来源自动决定）。'
    + '记忆组与标签是两个维度：记忆组回答"属于哪个主题"，标签回答"还跟什么有关"，所以别拿记忆组名重复充当标签。',
  '- tagMap：把「现有标签」里重复、同义、写法不一致的合并成一个。from 必须是「现有标签」里**原样出现**的写法；to 是统一后的写法，'
    + '或空字符串（表示这个标签没有价值，应当删掉）。大小写或写法不一致的（如 dsh / DSH）必须合并；每条 reason 不超过 20 字。',
  '- 两者必须自洽：items[].tags 里用到的写法要与 tagMap 合并后的结果一致，不要一边要求合并、一边继续用旧写法。',
].join('\n')

/**
 * Render the batch the model decides on.
 * @param {Record<string, any>[]} entries - Candidate memories.
 * @param {Record<string, any>[]} [groups] - Existing groups, so a new group can be nested under one.
 * @returns {string} The user message.
 */
export function buildCurationMessage(entries, groups = [], tags = []) {
  const lines = entries.map(entry => {
    const title = entry.title === '' ? '(无标题)' : entry.title
    const body = String(entry.content).replace(/\s+/g, ' ').slice(0, 400)
    return [
      `id: ${String(entry.id)}`,
      `标题: ${title}`,
      `来源: ${entry.modelWritten === true ? 'AI 生成' : '人工输入'}`,
      `当前归属: ${entry.scope === 'knowledge' ? '知识库' : '对话记忆'}`,
      `当前记忆组: ${String(entry.groupName ?? '')}`,
      `当前标签: ${entry.tags.length === 0 ? '(无)' : entry.tags.join('、')}`,
      `类型: ${String(entry.kind)}`,
      `正文: ${body}`,
    ].join('\n')
  })
  // The group list is what lets the answer reuse the tree instead of adding
  // another dozen peers to it, so it is shown as the tree it is.
  const groupList = groups.length === 0
    ? '（暂无记忆组）'
    : groups.map(group => `${'  '.repeat(Math.max(0, Number(group.depth ?? 1) - 1))}- ${String(group.name)}`
      + `（${group.scope === 'knowledge' ? '知识库' : '对话记忆'} · ${String(group.entryCount)} 条）`).join('\n')
  // The tag vocabulary is shown with counts for the same reason as the group
  // tree: a merge is only possible if the model can see which labels exist and
  // how much each one carries.
  const tagList = tags.length === 0
    ? '（暂无标签）'
    : tags.map(item => `${String(item.tag)}（${String(item.count)}）`).join('、')
  return `现有记忆组：\n${groupList}\n\n现有标签：\n${tagList}\n\n共 ${String(entries.length)} 条记忆，请逐条判断（记忆、分组、标签一起整理）：\n\n${lines.join('\n\n')}`
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
      // What the memory's labels should be afterwards. Normalised here so a
      // model that answers with blanks or duplicates cannot write them down.
      tags: normalizeTags(Array.isArray(item?.tags) ? item.tags : []),
      // Where the suggested group should hang. Kept as a name: the caller
      // resolves it and falls back to the top level when it names nothing real.
      parent: String(item?.parent ?? '').trim().slice(0, 40),
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
 * Read the tag merges out of a curation answer.
 *
 * Kept apart from `parseCuration` so a caller that only needs the verdicts —
 * a review, say — does not have to unpack a second shape, and so the existing
 * verdict contract does not change under its callers.
 * @param {string} text - Raw model output.
 * @returns {{ from: string, to: string, reason: string }[]} Merges to apply, in output order.
 */
export function parseTagMap(text) {
  const raw = String(text ?? '').trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw)
  const body = fenced === null ? raw : fenced[1].trim()
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return []
  let parsed
  try {
    parsed = JSON.parse(body.slice(start, end + 1))
  } catch (_error) {
    // The verdicts already parsed; a malformed map is not worth failing over.
    return []
  }
  const list = Array.isArray(parsed) ? parsed.tagMap : parsed.tagMap
  if (!Array.isArray(list)) return []
  return list.map(item => ({
    from: String(item?.from ?? '').trim().slice(0, 40),
    to: String(item?.to ?? '').trim().slice(0, 40),
    reason: String(item?.reason ?? '').trim().slice(0, 80),
  })).filter(item => item.from !== '')
}

/**
 * Make the one curation call.
 *
 * Compatibility wrapper over `callLlmStream` for callers that hold a plugin
 * context rather than an `llm` service; the vault core goes through its own
 * `callModel` adapter instead. Like summarization this is an out-of-band
 * `ctx.llm.stream`: it never enters a session log and never wakes an idle
 * agent, and the terminal `finish` chunk is checked explicitly because a
 * truncation arrives as data rather than an error.
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
  return callLlmStream(llm, {
    purpose: 'curate',
    route: request.route,
    system: CURATE_SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: buildCurationMessage(request.entries, request.groups ?? [], request.tags ?? []) }],
    }],
    maxTokens: request.maxTokens,
    timeoutMs: request.timeoutMs,
    signal: request.signal,
    sessionId: request.sessionId,
  })
}
