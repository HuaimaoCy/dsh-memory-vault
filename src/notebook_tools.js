/**
 * Notebook tools exposed over MCP (and therefore to Codex).
 *
 * The notebook is a separate data domain from the memory vault, but it shares
 * the same SQLite file and the same `MistakebookStore` validation. These tools
 * are the only place Codex can reach it:
 *
 * - reading never mutates anything;
 * - writing goes through `store.save` (field normalisation, dedupe-free) and
 *   through `normalizeDocument` + `setCanvasDocs` (bounds, counts, byte gate)
 *   instead of writing raw JSON, so a model cannot bypass the limits.
 *
 * Canvas writes are additive on purpose: there is no "replace the whole
 * document" tool, because a corrupt/empty read must never become an overwrite
 * of the user's canvas.
 *
 * @module dsh-memory-vault/src/notebook_tools
 */

import { CANVAS_LIMITS, CARD_KINDS, DEFAULT_SIZES, STICKY_TONES, normalizeDocument } from '../addons/mistakebook/canvas.mjs'
import { NOTE_TYPES } from '../addons/mistakebook/fields.mjs'

const clip = (value, max) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

const summarize = record => ({
  id: record.id,
  type: record.type,
  title: record.title || clip(record.stem, 40),
  preview: clip(record.stem, 160),
  tags: Array.isArray(record.tags) ? record.tags : [],
  reviewState: record.reviewState ?? null,
  nextReviewAt: record.nextReviewAt ?? null,
  subjectID: record.subjectID || '',
  nodeID: record.nodeID || '',
  updatedAt: record.updatedAt ?? null,
  imageCount: Array.isArray(record.images) ? record.images.length : 0,
})

const cardView = card => ({ id: card.id, kind: card.kind, text: card.text ?? '', x: card.x, y: card.y, w: card.w, h: card.h, tone: card.tone ?? null })

const canvasView = canvas => ({ id: canvas.id, title: canvas.title, cards: canvas.cards.map(cardView), edges: canvas.edges.length, view: canvas.view })

const tool = spec => ({ name: spec.name, description: spec.description, parameters: spec.parameters, execute: spec.execute })

/**
 * @param {{ notebook?: object }} options - The MistakebookStore instance.
 * @returns {object[]} MCP tool definitions (empty when no notebook is mounted).
 */
export function buildNotebookTools({ notebook } = {}) {
  if (!notebook) return []
  const requireCanvas = () => {
    const state = notebook.canvasState()
    if (state.corrupted) throw new Error('画布数据损坏，已停止写入以免覆盖原画布；请先用 notebook_canvas_get 查看，再决定是否在桌面端修复')
    return state.docs
  }
  return [
    tool({
      name: 'notebook_list',
      description: '列出笔记本里的笔记、错题、物理模型、解题方法与单词（可按视图、类型、关键词、标签过滤）。返回摘要，不含正文全文；需要正文用 notebook_read。',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          view: { type: 'string', enum: ['all', 'due', 'mastered', 'archived', 'trash'] },
          type: { type: 'string', enum: Object.keys(NOTE_TYPES) },
          query: { type: 'string' },
          tag: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
          offset: { type: 'integer', minimum: 0 },
        },
      },
      execute: async args => {
        const result = notebook.list({ view: args.view ?? 'all', type: args.type ?? '', query: args.query ?? '', tag: args.tag ?? '', order: 'updated' })
        const records = Array.isArray(result.records) ? result.records : []
        const limit = args.limit ?? 20
        const offset = args.offset ?? 0
        return { total: records.length, offset, limit, stats: result.stats ?? null, records: records.slice(offset, offset + limit).map(summarize) }
      },
    }),
    tool({
      name: 'notebook_read',
      description: '读取一篇笔记的完整内容（含结构化字段与图片信息）。默认不返回图片二进制，需要真图时传 includeImages=true。',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { id: { type: 'string' }, includeImages: { type: 'boolean' } },
        required: ['id'],
      },
      execute: async args => {
        const record = notebook.read(args.id)
        const images = (record.images ?? []).map(image => (args.includeImages
          ? { id: image.id, name: image.name, mimeType: image.mimeType, width: image.width, height: image.height, size: image.size, data: image.data }
          : { id: image.id, name: image.name, mimeType: image.mimeType, width: image.width, height: image.height, size: image.size }))
        return { record: { ...summarize(record), stem: record.stem, fields: record.fields ?? null, vocabulary: record.vocabulary ?? null, physics: record.physics ?? null, method: record.method ?? null }, images }
      },
    }),
    tool({
      name: 'notebook_save',
      description: '新建一篇笔记本条目。type 必填（note/mistake/physics/method/vocabulary），正文放 stem；vocabulary 类型额外需要 vocabulary.word。写入会经过笔记本存储的字段校验。',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          type: { type: 'string', enum: Object.keys(NOTE_TYPES) },
          title: { type: 'string' },
          stem: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          subjectID: { type: 'string' },
          nodeID: { type: 'string' },
          vocabulary: { type: 'object', additionalProperties: true },
        },
        required: ['type'],
      },
      execute: async args => {
        if (!NOTE_TYPES[args.type]) throw new Error(`未知的笔记类型：${args.type}`)
        const stem = String(args.stem ?? '').trim()
        const title = String(args.title ?? '').trim()
        if (!stem && !title) throw new Error('stem 与 title 至少填一个')
        const saved = notebook.save({
          type: args.type, title, stem, tags: args.tags ?? [], subjectID: args.subjectID ?? '', nodeID: args.nodeID ?? '',
          ...(args.vocabulary ? { vocabulary: args.vocabulary } : {}),
        })
        return { id: saved.id, type: saved.type, title: saved.title || clip(saved.stem, 40) }
      },
    }),
    tool({
      name: 'notebook_canvas_get',
      description: '读取自由画布的文档（画布列表、卡片、连线数、视口）。传 canvasId 只看其中一张。',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { canvasId: { type: 'string' } },
      },
      execute: async args => {
        const state = notebook.canvasState()
        if (state.corrupted) return { corrupted: true, canvases: [], note: '画布数据损坏，未做任何写入' }
        const canvases = state.docs.canvases ?? []
        if (args.canvasId) {
          const canvas = canvases.find(row => row.id === args.canvasId)
          if (!canvas) throw new Error(`没有这张画布：${args.canvasId}`)
          return { corrupted: false, canvas: canvasView(canvas) }
        }
        return { corrupted: false, activeId: state.docs.activeId, canvases: canvases.map(canvas => ({ id: canvas.id, title: canvas.title, cards: canvas.cards.length, edges: canvas.edges.length })) }
      },
    }),
    tool({
      name: 'notebook_canvas_add',
      description: '往画布加一张卡片（文本或便签）。没有画布时会先建一张；坐标可省略，按已有卡片自动排布。只追加，不会覆盖整份文档。',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          canvasId: { type: 'string' },
          kind: { type: 'string', enum: ['text', 'sticky'] },
          text: { type: 'string' },
          x: { type: 'number' },
          y: { type: 'number' },
          tone: { type: 'string', enum: STICKY_TONES },
        },
        required: ['text'],
      },
      execute: async args => {
        const docs = requireCanvas()
        const kind = CARD_KINDS.includes(args.kind) ? args.kind : 'text'
        if (kind === 'reference') throw new Error('引用卡片需要在桌面端选择笔记，这里只支持 text / sticky')
        const text = String(args.text ?? '').slice(0, CANVAS_LIMITS.text)
        if (!text.trim()) throw new Error('卡片内容不能为空')
        const canvases = [...docs.canvases]
        let index = canvases.findIndex(canvas => canvas.id === (args.canvasId ?? docs.activeId))
        if (index < 0) index = canvases.length ? 0 : -1
        if (index < 0) {
          canvases.push({ id: `canvas-${Date.now().toString(36)}`, title: '画布 1', cards: [], edges: [], view: { x: 0, y: 0, scale: 1 } })
          index = 0
        }
        const canvas = { ...canvases[index], cards: [...canvases[index].cards] }
        if (canvas.cards.length >= CANVAS_LIMITS.cards) throw new Error(`一张画布最多 ${CANVAS_LIMITS.cards} 张卡片`)
        const size = DEFAULT_SIZES[kind] ?? { w: 320, h: 180 }
        const last = canvas.cards.at(-1)
        const x = Number.isFinite(args.x) ? args.x : (last ? last.x + last.w + 24 : 80)
        const y = Number.isFinite(args.y) ? args.y : (last ? last.y : 80)
        const card = { id: `card-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`, kind, text, x, y, w: size.w, h: size.h, tone: kind === 'sticky' ? (args.tone ?? STICKY_TONES[0]) : undefined }
        canvas.cards.push(card)
        canvases[index] = canvas
        const next = normalizeDocument({ ...docs, activeId: canvas.id, canvases })
        notebook.setCanvasDocs(next)
        return { canvasId: canvas.id, cardId: card.id, cards: canvas.cards.length }
      },
    }),
    tool({
      name: 'notebook_canvas_update',
      description: '修改画布上一张卡片的文本、颜色或位置。只改指定卡片，其余内容与视口原样保留。',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          cardId: { type: 'string' },
          text: { type: 'string' },
          tone: { type: 'string', enum: STICKY_TONES },
          x: { type: 'number' },
          y: { type: 'number' },
        },
        required: ['cardId'],
      },
      execute: async args => {
        const docs = requireCanvas()
        let found = null
        const canvases = docs.canvases.map(canvas => {
          const card = canvas.cards.find(row => row.id === args.cardId)
          if (!card) return canvas
          found = card.id
          return {
            ...canvas,
            cards: canvas.cards.map(row => row.id === args.cardId ? {
              ...row,
              ...(args.text !== undefined ? { text: String(args.text).slice(0, CANVAS_LIMITS.text) } : {}),
              ...(args.tone !== undefined && row.kind === 'sticky' ? { tone: args.tone } : {}),
              ...(Number.isFinite(args.x) ? { x: args.x } : {}),
              ...(Number.isFinite(args.y) ? { y: args.y } : {}),
            } : row),
          }
        })
        if (!found) throw new Error(`没有这张卡片：${args.cardId}`)
        notebook.setCanvasDocs(normalizeDocument({ ...docs, canvases }))
        return { cardId: found, saved: true }
      },
    }),
  ]
}
