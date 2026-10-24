/**
 * 自由画布的数据模型。
 *
 * 「无限画布」指世界坐标里的自由布局，不是一张固定像素的纸：每张卡片有
 * 自己的 (x, y, w, h)，视口是屏幕上的一次平移 + 缩放。这里只放纯函数：
 * 归一化/校验、视口数学、卡片与画布的基本操作。它同时被主进程（写库前的
 * 校验）和渲染层（拖动、缩放、撤销）使用，所以不碰 DOM，也不 import 任何
 * 渲染模块——Node 里可以直接跑单元测试。
 *
 * 数据归笔记本域：整份文档存在笔记本元信息的 `canvas` 键里，随笔记本导出、
 * import 与备份一起走，绝不进入数据库（记忆）域的表中。
 *
 * @module dsh-memory-vault/addons/mistakebook/canvas
 */

/** 文档版本：结构变化时递增，读取端按版本兼容。 */
export const CANVAS_VERSION = 1

/** 硬上限：越界即拒绝，避免一条坏数据拖垮整份笔记本。 */
export const CANVAS_LIMITS = {
  canvases: 40,
  cards: 300,
  edges: 600,
  text: 4000,
  title: 120,
  noteTitle: 200,
  minSize: 120,
  maxSize: 2000,
  minScale: 0.2,
  maxScale: 2.5,
  coordinate: 1000000,
  bytes: 512000,
}

export const CARD_KINDS = ['text', 'sticky', 'reference']
export const STICKY_TONES = ['sand', 'mint', 'sky', 'rose']
export const DEFAULT_SIZES = {
  text: { w: 320, h: 200 },
  sticky: { w: 240, h: 200 },
  reference: { w: 280, h: 170 },
}

const uuid = () => (typeof globalThis.crypto?.randomUUID === 'function'
  ? globalThis.crypto.randomUUID()
  : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`)

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const finite = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback)
const string = value => (typeof value === 'string' ? value : '')
const round = value => Math.round(value)
const list = value => (Array.isArray(value) ? value : [])

function identifier(value, prefix) {
  const text = string(value).trim()
  return text && text.length <= 64 && /^[A-Za-z0-9._-]+$/.test(text) ? text : `${prefix}-${uuid()}`
}

function timestamp(value) {
  const time = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(time) ? new Date(time).toISOString() : new Date().toISOString()
}

/** 视口默认值：世界原点对齐屏幕左上角，1:1。 */
export const defaultView = () => ({ x: 0, y: 0, scale: 1 })

/** 空文档：没有画布时 UI 显示空状态，不会凭空造画布。 */
export const emptyDocument = () => ({ version: CANVAS_VERSION, activeId: null, canvases: [] })

/** 屏幕坐标 → 世界坐标。 */
export const screenToWorld = (view, point) => ({
  x: (point.x - view.x) / view.scale,
  y: (point.y - view.y) / view.scale,
})

/** 世界坐标 → 屏幕坐标。 */
export const worldToScreen = (view, point) => ({
  x: point.x * view.scale + view.x,
  y: point.y * view.scale + view.y,
})

/**
 * 以指针为锚点缩放：屏幕上的这个点保持贴在同一个世界坐标上。
 * 这是「指针中心缩放」的全部数学，滚轮与按钮共用。
 */
export function zoomAt(view, point, scale) {
  const next = clamp(finite(scale, view.scale), CANVAS_LIMITS.minScale, CANVAS_LIMITS.maxScale)
  const world = screenToWorld(view, point)
  return { x: point.x - world.x * next, y: point.y - world.y * next, scale: next }
}

/** 平移视口（拖动空白处）。 */
export const panBy = (view, dx, dy) => ({
  x: view.x + finite(dx, 0),
  y: view.y + finite(dy, 0),
  scale: view.scale,
})

/** 所有卡片占据的世界矩形；没有卡片时返回 null。 */
export function contentBounds(cards, padding = 40) {
  const rows = list(cards).filter(card => card && Number.isFinite(card.x) && Number.isFinite(card.y))
  if (!rows.length) return null
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity
  for (const card of rows) {
    left = Math.min(left, card.x)
    top = Math.min(top, card.y)
    right = Math.max(right, card.x + card.w)
    bottom = Math.max(bottom, card.y + card.h)
  }
  return { x: left - padding, y: top - padding, w: right - left + padding * 2, h: bottom - top + padding * 2 }
}

/**
 * 「回到内容」：把全部卡片装进视口并居中。单张卡片最多放大到 1:1，
 * 免得一张便签占满整屏。
 */
export function fitView(bounds, size, padding = 48) {
  if (!bounds || !size || size.w <= 0 || size.h <= 0) return defaultView()
  const scale = clamp(Math.min((size.w - padding * 2) / Math.max(bounds.w, 1), (size.h - padding * 2) / Math.max(bounds.h, 1), 1),
    CANVAS_LIMITS.minScale, 1)
  return {
    x: size.w / 2 - (bounds.x + bounds.w / 2) * scale,
    y: size.h / 2 - (bounds.y + bounds.h / 2) * scale,
    scale,
  }
}

/**
 * 视口是否真的装下了全部卡片。fitView 在超大内容上会被最小缩放卡住，
 * 此时不能声称「都在视野里」——渲染层据此给出诚实的提示。
 */
export function contentFits(cards, view, size, padding = 0) {
  const rows = list(cards).filter(card => card && Number.isFinite(card.x) && Number.isFinite(card.y))
  if (!rows.length) return true
  if (!view || !size || size.w <= 0 || size.h <= 0) return false
  return rows.every(card => {
    const topLeft = worldToScreen(view, { x: card.x, y: card.y })
    const bottomRight = worldToScreen(view, { x: card.x + card.w, y: card.y + card.h })
    return topLeft.x >= padding - 0.5 && topLeft.y >= padding - 0.5
      && bottomRight.x <= size.w - padding + 0.5 && bottomRight.y <= size.h - padding + 0.5
  })
}

function normalizeView(raw) {
  const view = raw && typeof raw === 'object' ? raw : {}
  return {
    x: clamp(round(finite(view.x, 0)), -CANVAS_LIMITS.coordinate, CANVAS_LIMITS.coordinate),
    y: clamp(round(finite(view.y, 0)), -CANVAS_LIMITS.coordinate, CANVAS_LIMITS.coordinate),
    scale: clamp(finite(view.scale, 1), CANVAS_LIMITS.minScale, CANVAS_LIMITS.maxScale),
  }
}

function normalizeCard(raw, seen) {
  if (!raw || typeof raw !== 'object') throw new Error('画布卡片数据无效')
  const kind = CARD_KINDS.includes(raw.kind) ? raw.kind : 'text'
  const size = DEFAULT_SIZES[kind]
  let id = identifier(raw.id, 'card')
  if (seen.has(id)) id = `card-${uuid()}`
  seen.add(id)
  const text = string(raw.text)
  if (text.length > CANVAS_LIMITS.text) throw new Error(`卡片文字不能超过 ${CANVAS_LIMITS.text} 字`)
  const noteTitle = string(raw.noteTitle)
  return {
    id,
    kind,
    x: clamp(round(finite(raw.x, 0)), -CANVAS_LIMITS.coordinate, CANVAS_LIMITS.coordinate),
    y: clamp(round(finite(raw.y, 0)), -CANVAS_LIMITS.coordinate, CANVAS_LIMITS.coordinate),
    w: clamp(round(finite(raw.w, size.w)), CANVAS_LIMITS.minSize, CANVAS_LIMITS.maxSize),
    h: clamp(round(finite(raw.h, size.h)), CANVAS_LIMITS.minSize, CANVAS_LIMITS.maxSize),
    z: clamp(round(finite(raw.z, 0)), 0, 1000000),
    text,
    tone: STICKY_TONES.includes(raw.tone) ? raw.tone : STICKY_TONES[0],
    noteId: string(raw.noteId).slice(0, 64),
    noteType: string(raw.noteType).slice(0, 20),
    noteTitle: noteTitle.slice(0, CANVAS_LIMITS.noteTitle),
  }
}

function normalizeEdge(raw, cards) {
  if (!raw || typeof raw !== 'object') return null
  const from = string(raw.from), to = string(raw.to)
  if (!cards.has(from) || !cards.has(to) || from === to) return null
  return { id: identifier(raw.id, 'edge'), from, to }
}

function normalizeCanvas(raw, seen) {
  if (!raw || typeof raw !== 'object') throw new Error('画布数据无效')
  let id = identifier(raw.id, 'canvas')
  if (seen.has(id)) id = `canvas-${uuid()}`
  seen.add(id)
  if (raw.cards !== undefined && !Array.isArray(raw.cards)) throw new Error('画布卡片数据无效')
  if (raw.edges !== undefined && !Array.isArray(raw.edges)) throw new Error('画布连线数据无效')
  const rawCards = list(raw.cards)
  if (rawCards.length > CANVAS_LIMITS.cards) throw new Error(`每个画布最多 ${CANVAS_LIMITS.cards} 张卡片`)
  const cardIds = new Set()
  const cards = rawCards.map(card => normalizeCard(card, cardIds))
  const rawEdges = list(raw.edges)
  if (rawEdges.length > CANVAS_LIMITS.edges) throw new Error(`每个画布最多 ${CANVAS_LIMITS.edges} 条连线`)
  const pairs = new Set(), edges = []
  for (const candidate of rawEdges) {
    const edge = normalizeEdge(candidate, cardIds)
    if (!edge) continue
    const key = [edge.from, edge.to].sort().join('|')
    if (pairs.has(key)) continue
    pairs.add(key)
    edges.push(edge)
  }
  const title = string(raw.title).trim().slice(0, CANVAS_LIMITS.title) || '未命名画布'
  return { id, title, createdAt: timestamp(raw.createdAt), updatedAt: timestamp(raw.updatedAt), view: normalizeView(raw.view), cards, edges }
}

/**
 * 把任意输入归一化成一份合法文档；结构性错误直接抛错（写库端会拒绝），
 * 数值越界则收敛到合法区间（缩放滑块不会因此存不进去）。
 */
export function normalizeDocument(raw) {
  if (raw === undefined || raw === null) return emptyDocument()
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('画布数据无效')
  if (raw.canvases !== undefined && !Array.isArray(raw.canvases)) throw new Error('画布数据无效')
  const rawCanvases = list(raw.canvases)
  if (rawCanvases.length > CANVAS_LIMITS.canvases) throw new Error(`最多 ${CANVAS_LIMITS.canvases} 个画布`)
  const seen = new Set()
  const canvases = rawCanvases.map(canvas => normalizeCanvas(canvas, seen))
  const requested = string(raw.activeId)
  return { version: CANVAS_VERSION, activeId: canvases.some(canvas => canvas.id === requested) ? requested : canvases[0]?.id ?? null, canvases }
}

/** 序列化后的大小（UTF-16 字符数），写库前的字节闸门。 */
export const documentSize = document => JSON.stringify(document).length

/** 取一份画布的副本；不存在返回 null。 */
export const canvasById = (document, id) => document.canvases.find(canvas => canvas.id === id) ?? null

/** 当前激活的画布；没有画布时返回 null。 */
export function activeCanvas(document) {
  return canvasById(document, document.activeId) ?? document.canvases[0] ?? null
}

/** 新建一个空画布并设为激活；返回 { document, canvas }。 */
export function createCanvas(document, title = '') {
  if (document.canvases.length >= CANVAS_LIMITS.canvases) throw new Error(`最多 ${CANVAS_LIMITS.canvases} 个画布`)
  const canvas = { id: `canvas-${uuid()}`, title: string(title).trim().slice(0, CANVAS_LIMITS.title) || `画布 ${document.canvases.length + 1}`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), view: defaultView(), cards: [], edges: [] }
  return { document: { ...document, activeId: canvas.id, canvases: [...document.canvases, canvas] }, canvas }
}

/** 改名；空标题回落为「未命名画布」。 */
export function renameCanvas(document, id, title) {
  return { ...document, canvases: document.canvases.map(canvas => canvas.id === id ? { ...canvas, title: string(title).trim().slice(0, CANVAS_LIMITS.title) || '未命名画布', updatedAt: new Date().toISOString() } : canvas) }
}

/** 删除画布，并自动激活相邻的一个；返回 { document, removed }。 */
export function deleteCanvas(document, id) {
  const canvases = document.canvases.filter(canvas => canvas.id !== id)
  const removed = canvases.length !== document.canvases.length
  const activeId = canvases.some(canvas => canvas.id === document.activeId) ? document.activeId : canvases[0]?.id ?? null
  return { document: { ...document, canvases, activeId }, removed }
}

/**
 * 新卡片的落点：以给定世界中心为中心，遇到已有卡片就沿斜向让开，
 * 保证两张新卡片不会叠在一起（拖动后当然可以随意重叠）。
 */
export function placement(cards, size, center = { x: 0, y: 0 }) {
  const rows = list(cards)
  const overlaps = (x, y) => rows.some(card => x < card.x + card.w + 16 && x + size.w + 16 > card.x && y < card.y + card.h + 16 && y + size.h + 16 > card.y)
  let x = Math.round(center.x - size.w / 2), y = Math.round(center.y - size.h / 2)
  for (let attempt = 0; attempt < 80 && overlaps(x, y); attempt++) { x += 36; y += 32 }
  return {
    x: clamp(x, -CANVAS_LIMITS.coordinate, CANVAS_LIMITS.coordinate),
    y: clamp(y, -CANVAS_LIMITS.coordinate, CANVAS_LIMITS.coordinate),
  }
}

/** 新卡片的 z：总在最上。 */
export const nextZ = cards => list(cards).reduce((top, card) => Math.max(top, finite(card.z, 0)), 0) + 1

/** 在画布上追加一张卡片；返回新画布（不可变更新，方便撤销）。 */
export function addCard(canvas, card) {
  if (canvas.cards.length >= CANVAS_LIMITS.cards) throw new Error(`每个画布最多 ${CANVAS_LIMITS.cards} 张卡片`)
  const normalized = normalizeCard({ ...card, z: card.z ?? nextZ(canvas.cards) }, new Set(canvas.cards.map(row => row.id)))
  return { ...canvas, cards: [...canvas.cards, normalized], updatedAt: new Date().toISOString() }
}

/** 移除卡片，连带剪掉指向它们的连线。 */
export function removeCards(canvas, ids) {
  const drop = new Set(list(ids).map(String))
  if (!drop.size) return canvas
  return {
    ...canvas,
    cards: canvas.cards.filter(card => !drop.has(card.id)),
    edges: canvas.edges.filter(edge => !drop.has(edge.from) && !drop.has(edge.to)),
    updatedAt: new Date().toISOString(),
  }
}

/** 更新一张卡片的部分字段（位置、尺寸、文字、层级）。 */
export function updateCard(canvas, id, patch) {
  return {
    ...canvas,
    cards: canvas.cards.map(card => card.id === id ? normalizeCard({ ...card, ...patch }, new Set(canvas.cards.map(row => row.id).filter(row => row !== id))) : card),
    updatedAt: new Date().toISOString(),
  }
}

/** 连接两张卡片；同一对卡片只保留一条线。 */
export function linkCards(canvas, from, to) {
  if (from === to) throw new Error('请选择两张不同的卡片')
  const ids = new Set(canvas.cards.map(card => card.id))
  if (!ids.has(from) || !ids.has(to)) throw new Error('请选择画布上的卡片')
  const key = [from, to].sort().join('|')
  if (canvas.edges.some(edge => [edge.from, edge.to].sort().join('|') === key)) throw new Error('这两张卡片已经连在一起了')
  if (canvas.edges.length >= CANVAS_LIMITS.edges) throw new Error(`每个画布最多 ${CANVAS_LIMITS.edges} 条连线`)
  return { ...canvas, edges: [...canvas.edges, { id: `edge-${uuid()}`, from, to }], updatedAt: new Date().toISOString() }
}

/** 移除一条连线。 */
export const removeEdge = (canvas, id) => ({ ...canvas, edges: canvas.edges.filter(edge => edge.id !== id), updatedAt: new Date().toISOString() })

/** 一条连线两端卡片中心的世界坐标（渲染层画线用）。 */
export function edgeGeometry(canvas, edge) {
  const from = canvas.cards.find(card => card.id === edge.from)
  const to = canvas.cards.find(card => card.id === edge.to)
  if (!from || !to) return null
  const a = { x: from.x + from.w / 2, y: from.y + from.h / 2 }
  const b = { x: to.x + to.w / 2, y: to.y + to.h / 2 }
  const dx = b.x - a.x, dy = b.y - a.y
  return { x1: a.x, y1: a.y, x2: b.x, y2: b.y, length: Math.hypot(dx, dy), angle: Math.atan2(dy, dx) }
}

/**
 * 导入时的画布合并：按 id 覆盖同名画布、追加新画布，其余的画布保持不动。
 * 这样「导出 → 在另一台机器导入」能原样恢复，而不会抹掉本机已有的画布。
 */
export function mergeDocument(current, incoming) {
  const source = normalizeDocument(incoming)
  const merged = normalizeDocument(current)
  if (!source.canvases.length) return merged
  const byId = new Map(merged.canvases.map(canvas => [canvas.id, canvas]))
  for (const canvas of source.canvases) byId.set(canvas.id, canvas)
  const canvases = [...byId.values()].slice(0, CANVAS_LIMITS.canvases)
  return normalizeDocument({ version: CANVAS_VERSION, activeId: merged.activeId, canvases })
}
