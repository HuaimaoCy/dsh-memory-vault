export const CANVAS_QUESTION_HEADER = 32

export const CANVAS_QUESTION_SECTIONS = [
  { id: 'stem', label: '题干' },
  { id: 'images', label: '题图' },
  { id: 'studentWork', label: '作答过程' },
  { id: 'referenceAnswer', label: '参考答案' },
  { id: 'errorType', label: '错因分类' },
  { id: 'cause', label: '错因分析' },
  { id: 'notes', label: '备注' },
]

export const CANVAS_QUESTION_FIELDS = [
  { id: 'title', label: '标题', limit: 500 },
  ...CANVAS_QUESTION_SECTIONS.filter(({ id }) => id !== 'images')
    .map(section => ({ ...section, limit: { errorType: 100, cause: 30000 }[section.id] ?? 100000 })),
]

function offset(value) {
  return Number.isFinite(value) ? Math.max(0, Math.min(1000000, Math.round(value))) : 0
}

export function normalizeCanvasQuestion(value) {
  const fields = {}
  for (const { id, limit } of CANVAS_QUESTION_FIELDS) {
    const field = value?.fields?.[id]
    if (typeof field === 'string') fields[id] = field.slice(0, limit)
  }
  const sections = Array.isArray(value?.sections)
    ? CANVAS_QUESTION_SECTIONS.filter(({ id }) => value.sections.includes(id)).map(({ id }) => id)
    : null
  return {
    fields,
    sections: sections?.length === CANVAS_QUESTION_SECTIONS.length ? null : sections,
    scrollTop: offset(value?.scrollTop),
    scrollLeft: offset(value?.scrollLeft),
  }
}

export function canvasQuestionImageURI(image) {
  const mimeType = image?.mimeType
  const data = image?.data
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mimeType)
      || typeof data !== 'string' || data.length > 14 * 1024 * 1024
      || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return ''
  return 'data:' + mimeType + ';base64,' + data
}

export function canvasQuestionContent(card, record) {
  const { fields, sections } = normalizeCanvasQuestion(card.question)
  const source = record ?? { title: card.noteTitle, stem: card.text }
  const field = id => fields[id] ?? source[id] ?? ''
  const content = []
  for (const { id, label } of CANVAS_QUESTION_SECTIONS) {
    if (sections && !sections.includes(id)) continue
    if (id === 'images') {
      const images = Array.isArray(source.images) ? source.images.filter(canvasQuestionImageURI) : []
      if (images.length) content.push({ id, label, images })
    } else {
      const text = field(id)
      if (text.trim()) content.push({ id, label, text })
    }
  }
  return { title: field('title').trim() || '未命名题目', sections: content }
}
