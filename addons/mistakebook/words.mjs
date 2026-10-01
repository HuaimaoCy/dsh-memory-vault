// Vocabulary capture helpers shared by the renderer and the services module.
// Kept free of Node APIs so the sandboxed renderer can import it directly.
export const normalizeWord = value => String(value ?? '').normalize('NFKC').trim().toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ')

const LINE_PREFIX = /^\s*(?:#{1,6}\s*)?(?:[-*+]\s+|>\s*|\d{1,3}[.、)]\s*)?/
// A handwritten accumulation page usually lists one entry per line: an English
// word or phrase first, then an optional IPA transcription and a Chinese gloss.
const ENGLISH_RUN = /^[A-Za-z][A-Za-z'’\-]*(?: [A-Za-z][A-Za-z'’\-]*){0,5}/
const IPA = /^(?:[\s|:：,，\-—–·]*)?(\/[^/]{2,60}\/)/

export function parseWordLine(line) {
  const cleaned = String(line ?? '').replace(/\r$/, '').replace(LINE_PREFIX, '').replace(/[*`]/g, '').trim()
  if (!cleaned) return null
  const match = cleaned.match(ENGLISH_RUN)
  if (!match) return null
  const word = match[0].replace(/\s+/g, ' ')
  let rest = cleaned.slice(match[0].length)
  if (/^\s*\d/.test(rest)) return null
  if (!rest.trim() && word.replace(/\s/g, '').length < 2) return null
  let phonetic = ''
  const ipa = rest.match(IPA)
  if (ipa) { phonetic = ipa[1]; rest = rest.slice(ipa[0].length) }
  const columns = rest.split(/[|\t]/).map(part => part.replace(/^[\s:：,，、\-—–·.。]+/, '').trim())
  while (columns.length > 1 && !columns[0]) columns.shift()
  const meaning = columns.shift() ?? ''
  const examples = columns.filter(Boolean).join(' | ')
  return { word, phonetic, meaning, examples }
}

export function extractWords(text) {
  const source = String(text ?? '')
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
