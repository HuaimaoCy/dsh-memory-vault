// Vocabulary capture helpers shared by the renderer and the services module.
// Kept free of Node APIs so the sandboxed renderer can import it directly.
export const normalizeWord = value => String(value ?? '').normalize('NFKC').trim().toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ')

const LINE_PREFIX = /^\s*(?:#{1,6}\s*)?(?:[-*+>|]\s+)?(?:[√✓×]\s*|[xX](?=\s*\d)\s*)?(?:\d{1,3}[.、)]\s*|第\s*\d+\s*题\s*)?/
// A handwritten accumulation page usually lists one entry per line: an English
// word or phrase first, then an optional IPA transcription and a Chinese gloss.
const ENGLISH_RUN = /^[A-Za-z][A-Za-z'’\-]*(?: [A-Za-z][A-Za-z'’\-]*){0,5}/
const IPA = /^(?:[\s|:：,，\-—–·]*)?(\/[^/]{2,60}\/)/

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
const decodeEntities = text => text.replace(/&#(\d+);/g, (_, code) => {
  const point = Number(code)
  return point > 0 && point < 0x110000 ? String.fromCodePoint(point) : ''
}).replace(/&([a-z]+);/gi, (match, name) => ENTITIES[name.toLowerCase()] ?? match)

// OCR engines often return handwritten pages as HTML or markdown tables with
// two columns of numbered entries; flatten them back into one entry per line.
export function flattenSource(text) {
  const broken = decodeEntities(String(text ?? ''))
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:td|th|tr|p|div|li|h[1-6]|table)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
  return broken.split(/\r?\n/).flatMap(line => {
    const trimmed = line.trim()
    if (!trimmed) return []
    if (/^[|: -]+$/.test(trimmed)) return []
    if (trimmed.startsWith('|')) return trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|')
    return [line]
  }).join('\n')
}

export function parseWordLine(line) {
  const cleaned = String(line ?? '').replace(/\r$/, '').replace(LINE_PREFIX, '').replace(/[*`]/g, '').trim()
  if (!cleaned) return null
  const match = cleaned.match(ENGLISH_RUN)
  if (!match) return null
  let word = match[0].replace(/\s+/g, ' ')
  let rest = cleaned.slice(match[0].length)
  // "belt n.带" has no space before the part-of-speech tag, so the tag ends up
  // inside the word run; move it back to the meaning.
  const posTag = word.match(/\s(n|v|adj|adv|vt|vi|prep|pron|conj|aux|num|art)$/i)
  if (posTag && word.length > posTag[1].length + 1) { word = word.slice(0, posTag.index); rest = ` ${posTag[1]}.${rest.replace(/^\s*\./, '')}` }
  if (/^\s*\d/.test(rest)) return null
  if (!rest.trim() && word.replace(/\s/g, '').length < 2) return null
  let phonetic = ''
  const ipa = rest.match(IPA)
  if (ipa) { phonetic = ipa[1]; rest = rest.slice(ipa[0].length) }
  const columns = rest.split(/[|\t]/).map(part => part.replace(/^[\s:：,，、\-—–·.。=]+/, '').trim())
  while (columns.length > 1 && !columns[0]) columns.shift()
  const meaning = columns.shift() ?? ''
  const examples = columns.filter(Boolean).join(' | ')
  return { word, phonetic, meaning, examples }
}

export function extractWords(text) {
  const source = flattenSource(text)
  if (source.length > 1000000) throw new Error('识别文字过多，请分批识别')
  const seen = new Map()
  for (const line of source.split(/\r?\n/)) {
    const entry = parseWordLine(line)
    if (!entry) continue
    const key = normalizeWord(entry.word)
    if (!key || seen.has(key)) continue
    seen.set(key, entry)
  }
  const entries = [...seen.values()]
  if (!entries.length) return entries
  if (entries.length > 1000) throw new Error('一次最多识别 1000 个词条，请分批上传')
  return entries
}

// 关联词语解析：从自由文本（近义词/反义词/词形变化字段）里提取英语单词或
// 短语。支持逗号、顿号、分号分隔，可夹中文注释；单个词性缩写与单字母视为
// 注释丢弃。输出经 normalizeWord 归一，去重且每字段最多 12 个。
const RELATED_RUN = /[A-Za-z][A-Za-z'’\-]*(?: [A-Za-z][A-Za-z'’\-]*){0,5}/g
const RELATED_STOP = new Set(['vt', 'vi', 'adj', 'adv', 'abbr', 'pl', 'sb', 'sth', 'etc'])
export function parseRelatedWords(text) {
  const source = String(text ?? '')
  if (!source.trim() || source.length > 20000) return []
  const found = [], seen = new Set()
  for (const match of source.normalize('NFKC').matchAll(RELATED_RUN)) {
    const word = normalizeWord(match[0])
    if (!word || word.length < 2 || RELATED_STOP.has(word) || seen.has(word)) continue
    seen.add(word)
    found.push(word)
    if (found.length >= 12) break
  }
  return found
}
// 词条的类型化关联边：近义/反义/词形三类，供通用关系树消费。
export function relationsOf(vocabulary = {}) {
  const self = normalizeWord(vocabulary.word)
  const output = []
  for (const [type, field] of [['synonym', 'synonyms'], ['antonym', 'antonyms'], ['form', 'forms']]) {
    for (const word of parseRelatedWords(vocabulary[field])) {
      if (word === self) continue
      output.push({ type, word })
      if (output.length >= 30) return output
    }
  }
  return output
}
