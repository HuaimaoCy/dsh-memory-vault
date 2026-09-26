/**
 * Business rules shared by every write path.
 *
 * The vault is written from three directions — the model's tools, the Web
 * panel's HTTP route, and the summarizer — and a rule that lives in only one
 * of them is a rule the others silently break. Everything here is pure: it
 * normalises and refuses, and never touches the database.
 */

/** Length rules that apply regardless of which surface made the request. */
export const LIMITS = {
  /** Longest accepted entry title. */
  title: 200,
  /** Longest accepted single tag. */
  tag: 64,
  /** Most tags accepted on one entry. */
  tags: 32,
  /** Most entries accepted in one batch write. */
  batch: 50,
  /** Longest accepted group name. */
  groupName: 120,
  /** Longest accepted group description. */
  groupDescription: 500,
}

/**
 * Normalise a tag list: trimmed, non-empty, de-duplicated, length-capped.
 * @param {unknown} tags - Caller-supplied tags.
 * @returns {string[]} The tags to store.
 * @throws {Error} When the value is not a list of short strings.
 */
export function normalizeTags(tags) {
  if (tags === undefined || tags === null) return []
  if (!Array.isArray(tags)) throw new Error('tags must be an array of strings')
  /** @type {string[]} */
  const out = []
  for (const raw of tags) {
    if (typeof raw !== 'string') throw new Error('every tag must be a string')
    const tag = raw.trim()
    if (tag === '') continue
    if (tag.length > LIMITS.tag) throw new Error(`标签「${tag}」超过 ${LIMITS.tag} 字符上限`)
    if (!out.includes(tag)) out.push(tag)
  }
  if (out.length > LIMITS.tags) throw new Error(`一条记忆最多 ${LIMITS.tags} 个标签`)
  return out
}

/**
 * Validate and normalise one entry write.
 *
 * Both the model tools and the panel route call this, so the same content is
 * accepted or refused in exactly the same way on both sides.
 * @param {object} input - Raw write request.
 * @param {unknown} input.content - Entry body.
 * @param {unknown} [input.title] - Short heading.
 * @param {unknown} [input.kind] - Entry kind.
 * @param {unknown} [input.tags] - Tag list.
 * @param {string[]} kinds - Kinds the vault accepts.
 * @param {{ maxEntryChars: number }} config - Resolved plugin config.
 * @returns {{ content: string, title: string, kind: string, tags: string[] }} Normalised fields.
 * @throws {Error} When a rule is broken.
 */
export function validateEntryWrite(input, kinds, config) {
  const content = String(input.content ?? '').trim()
  if (content === '') throw new Error('记忆正文不能为空')
  if (content.length > config.maxEntryChars) {
    throw new Error(`记忆正文 ${content.length} 字符，超过 ${config.maxEntryChars} 字符上限，请拆分后再写入`)
  }
  const title = String(input.title ?? '').trim()
  if (title.length > LIMITS.title) throw new Error(`标题超过 ${LIMITS.title} 字符上限`)
  const kind = String(input.kind ?? '').trim() === '' ? 'note' : String(input.kind).trim()
  if (!kinds.includes(kind)) throw new Error(`kind 必须是 ${kinds.join(' / ')} 之一，收到「${kind}」`)
  return { content, title, kind, tags: normalizeTags(input.tags) }
}

/**
 * Validate a whole batch before any of it is written.
 *
 * All-or-nothing is the point: a batch that fails on its last entry must not
 * leave the earlier ones behind, so validation happens before the transaction
 * opens rather than inside it.
 * @param {unknown} entries - Raw batch.
 * @param {string[]} kinds - Kinds the vault accepts.
 * @param {{ maxEntryChars: number }} config - Resolved plugin config.
 * @returns {{ content: string, title: string, kind: string, tags: string[] }[]} Normalised batch.
 * @throws {Error} When the batch is empty, oversized, or any entry is invalid.
 */
export function validateEntryBatch(entries, kinds, config) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('entries 必须是非空数组')
  if (entries.length > LIMITS.batch) throw new Error(`一次最多写入 ${LIMITS.batch} 条记忆`)
  return entries.map((entry, index) => {
    if (entry === null || typeof entry !== 'object') throw new Error(`第 ${String(index + 1)} 条不是对象`)
    try {
      return validateEntryWrite(entry, kinds, config)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`第 ${String(index + 1)} 条记忆不合法：${reason}`)
    }
  })
}

/**
 * Normalise a group name.
 * @param {unknown} name - Raw name.
 * @returns {string} Trimmed name.
 * @throws {Error} When the name is empty or too long.
 */
export function validateGroupName(name) {
  const value = String(name ?? '').trim()
  if (value === '') throw new Error('记忆组名称不能为空')
  if (value.length > LIMITS.groupName) throw new Error(`记忆组名称超过 ${LIMITS.groupName} 字符上限`)
  return value
}

/**
 * Normalise a group description.
 * @param {unknown} description - Raw description.
 * @returns {string} Trimmed description.
 * @throws {Error} When the description is too long.
 */
export function validateGroupDescription(description) {
  const value = String(description ?? '').trim()
  if (value.length > LIMITS.groupDescription) {
    throw new Error(`记忆组描述超过 ${LIMITS.groupDescription} 字符上限`)
  }
  return value
}

/**
 * Read an integer from request input that may arrive as a string.
 *
 * Query parameters are always strings, so a route that only accepts numbers
 * silently falls back to its default — which is how a request for 300 rows
 * turned into 100.
 * @param {unknown} value - Raw value.
 * @param {object} rule - Accepted range.
 * @param {number} rule.min - Smallest accepted value.
 * @param {number} rule.max - Largest accepted value.
 * @param {number} rule.fallback - Value used when nothing was supplied.
 * @param {string} name - Parameter name, for the error message.
 * @returns {number} A validated integer.
 * @throws {Error} When the value is present but not a usable integer.
 */
export function intParam(value, { min, max, fallback }, name) {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isFinite(parsed)) throw new Error(`${name} 必须是数字，收到「${String(value)}」`)
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}
