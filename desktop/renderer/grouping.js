/**
 * The board's arrangement rules, kept apart from the DOM.
 *
 * These are the decisions the window makes about what a person sees first, and
 * they are pure functions of the entries: a section per **root** group, the
 * labels inside it as sub-headings, and hidden memories quarantined last. Being
 * separate from `app.js` is what lets them be tested in plain Node, where this
 * machine can run them.
 *
 * @module dsh-memory-vault/desktop/renderer/grouping
 */

/** Tags the vault owns; they label provenance, not content. */
export const SYSTEM_TAGS = ['AI 生成', '人工输入', 'AI自动总结']

/** The label shown for memories that carry no user tag of their own. */
export const UNTAGGED = '未打标签'

/**
 * Every user tag of one entry, system tags removed.
 * @param {Record<string, any>} entry - Entry view from the vault.
 * @returns {string[]} Tags a person chose.
 */
export function ownTags(entry) {
  return (entry.tags ?? []).filter((tag) => !SYSTEM_TAGS.includes(tag))
}

/**
 * Section entries: one heading per root group, hidden memories last.
 * @param {Record<string, any>[]} rows - Entries to arrange.
 * @param {(entry: Record<string, any>) => string} rootOf - Resolves an entry's root group name.
 * @returns {{ key: string, label: string, entries: Record<string, any>[] }[]} Sections.
 */
export function section(rows, rootOf) {
  const live = rows.filter((entry) => entry.hidden !== true)
  const hidden = rows.filter((entry) => entry.hidden === true)
  /** @type {Map<string, Record<string, any>[]>} */
  const buckets = new Map()
  for (const entry of live) {
    const key = rootOf(entry)
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(entry)
  }
  const sections = [...buckets.entries()]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([label, entries]) => ({ key: label, label, entries }))
  if (hidden.length > 0) sections.push({ key: '__hidden__', label: '隐藏', entries: hidden })
  return sections
}

/**
 * Split one section by each memory's own first label.
 *
 * A memory lands in the bucket of its first user tag, so it is drawn exactly
 * once; its other labels stay visible on the card. Untagged memories collect in
 * one bucket at the end rather than heading the section.
 * @param {Record<string, any>[]} rows - Entries of one section.
 * @returns {{ key: string, label: string, entries: Record<string, any>[] }[]} Sub-sections, biggest first.
 */
export function subsection(rows) {
  /** @type {Map<string, Record<string, any>[]>} */
  const buckets = new Map()
  for (const entry of rows) {
    const own = ownTags(entry)
    const key = own.length === 0 ? UNTAGGED : String(own[0])
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(entry)
  }
  return [...buckets.entries()]
    .sort(([leftKey, left], [rightKey, right]) => {
      if ((leftKey === UNTAGGED) !== (rightKey === UNTAGGED)) return leftKey === UNTAGGED ? 1 : -1
      return right.length - left.length || (leftKey < rightKey ? -1 : 1)
    })
    .map(([label, entries]) => ({ key: label, label, entries }))
}
