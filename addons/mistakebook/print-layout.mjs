/**
 * 错题 PDF 导出：A4 页面的排版模型（纯函数，不依赖 DOM 与 Electron）。
 *
 * 划分：
 * - 本文件负责**几何**（纸张、页边距、栏位、分页、越界与重叠判定）与**文档拼装**
 *   （把每道题已经渲染好的正文 HTML 摆到页面坐标上，输出可直接 printToPDF 的
 *   HTML 字符串）。所有坐标单位是毫米，与 CSS 的 mm 一一对应。
 * - 渲染层负责**内容**（Markdown/LaTeX 渲染、原图缩放），把每道题的正文 HTML
 *   交给这里；主进程只负责把这份 HTML 交给 Chromium 打印成 PDF。
 *
 * 这样几何逻辑可以在 Node 下直接测（tests/pdf-layout-smoke.mjs），不需要浏览器。
 *
 * @module dsh-memory-vault/addons/mistakebook/print-layout
 */

/** 支持的纸张。宽高单位为毫米，竖版为基准。 */
export const PRINT_PAPERS = {
  a4: { label: 'A4 竖版', width: 210, height: 297 },
  'a4-landscape': { label: 'A4 横版', width: 297, height: 210 },
}

/** 各项上限与下限。超过上限一律夹紧，不抛错——排版不该因为一个输入框打不开。 */
export const PRINT_LIMITS = {
  margin: [6, 20],
  fontSize: [8, 16],
  gap: [2, 12],
  blocks: 100,
  pages: 40,
  text: 80,
  minWidth: 30,
  minHeight: 10,
}

/** 可以在 PDF 里逐项开关的内容。 */
export const PRINT_FIELDS = [
  ['image', '原图'],
  ['studentWork', '我的作答'],
  ['referenceAnswer', '参考答案'],
  ['cause', '错因'],
  ['notes', '复盘'],
  ['meta', '学科与日期'],
]

/** 默认排版。两栏、12mm 页边距、11pt 正文：一张 A4 能放 2–4 道中等长度的错题。 */
export const PRINT_DEFAULTS = {
  paper: 'a4',
  margin: 12,
  columns: 2,
  fontSize: 11,
  gap: 6,
  numbering: true,
  header: '',
  footer: '',
  fields: { image: true, studentWork: true, referenceAnswer: false, cause: true, notes: false, meta: true },
}

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const number = (value, [min, max], fallback) => {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.round(Math.min(max, Math.max(min, parsed)) * 10) / 10
}
const text = (value, limit) => (typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, limit) : '')
const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback)

/**
 * 把任意输入夹成一份可用的排版设置。
 *
 * @param {unknown} raw - 来自偏好、界面或旧版本设置的对象。
 * @returns {{paper: string, margin: number, columns: number, fontSize: number, gap: number, numbering: boolean, header: string, footer: string, fields: Record<string, boolean>}} 设置。
 */
export function normalizeSettings(raw) {
  const input = isObject(raw) ? raw : {}
  const fields = isObject(input.fields) ? input.fields : {}
  return {
    paper: Object.hasOwn(PRINT_PAPERS, input.paper) ? input.paper : PRINT_DEFAULTS.paper,
    margin: number(input.margin, PRINT_LIMITS.margin, PRINT_DEFAULTS.margin),
    columns: Number(input.columns) === 1 ? 1 : 2,
    fontSize: number(input.fontSize, PRINT_LIMITS.fontSize, PRINT_DEFAULTS.fontSize),
    gap: number(input.gap, PRINT_LIMITS.gap, PRINT_DEFAULTS.gap),
    numbering: bool(input.numbering, PRINT_DEFAULTS.numbering),
    header: text(input.header, PRINT_LIMITS.text),
    footer: text(input.footer, PRINT_LIMITS.text),
    fields: Object.fromEntries(PRINT_FIELDS.map(([key]) => [key, bool(fields[key], PRINT_DEFAULTS.fields[key])])),
  }
}

/** 纸张的毫米尺寸。 */
export function paperSize(settings) {
  const paper = PRINT_PAPERS[normalizeSettings(settings).paper]
  return { width: paper.width, height: paper.height }
}

/** 页边距内可排版的内容框（毫米，相对页面左上角）。 */
export function contentBox(settings) {
  const normalized = normalizeSettings(settings)
  const { width, height } = paperSize(normalized)
  return { x: normalized.margin, y: normalized.margin, width: width - normalized.margin * 2, height: height - normalized.margin * 2 }
}

/** 每一栏的起点与宽度（毫米）。 */
export function columnSlots(settings) {
  const normalized = normalizeSettings(settings)
  const box = contentBox(normalized)
  const width = (box.width - normalized.gap * (normalized.columns - 1)) / normalized.columns
  return Array.from({ length: normalized.columns }, (_, index) => ({ x: box.x + index * (width + normalized.gap), width }))
}

const PARAGRAPHS = value => (typeof value === 'string' ? value.replace(/\r\n?/g, '\n').split('\n') : [])

/**
 * 估算一段文字在给定宽度里占的高度（毫米）。
 *
 * 只用于首次自动排版；界面渲染完成后会用实测高度重排，所以允许粗略。
 */
export function estimateTextHeight(value, width, fontSize) {
  const charWidth = fontSize * 0.3528
  const perLine = Math.max(4, Math.floor(width / Math.max(charWidth, 0.1)))
  const lines = PARAGRAPHS(value).reduce((total, line) => total + Math.max(1, Math.ceil([...line].length / perLine)), 0)
  return lines * charWidth * 1.7
}

/**
 * 估算一道题在某一栏宽下占的高度（毫米）。
 *
 * @param {object} record - 笔记记录（含 images、cause 等字段）。
 * @param {number} width - 栏宽（毫米）。
 * @param {object} settings - 排版设置。
 * @returns {number} 估算高度。
 */
export function estimateHeight(record, width, settings) {
  const normalized = normalizeSettings(settings)
  const fields = normalized.fields
  let height = 8 // 标题行与内边距
  height += estimateTextHeight(record?.stem ?? '', width - 4, normalized.fontSize)
  if (fields.studentWork) height += 4 + estimateTextHeight(record?.studentWork ?? '', width - 4, normalized.fontSize)
  if (fields.referenceAnswer) height += 4 + estimateTextHeight(record?.referenceAnswer ?? '', width - 4, normalized.fontSize)
  if (fields.cause) height += 4 + estimateTextHeight(record?.cause ?? '', width - 4, normalized.fontSize)
  if (fields.notes) height += 4 + estimateTextHeight(record?.notes ?? '', width - 4, normalized.fontSize)
  if (fields.image) {
    for (const image of Array.isArray(record?.images) ? record.images : []) {
      const ratio = Number(image?.width) > 0 && Number(image?.height) > 0 ? Number(image.height) / Number(image.width) : 0.75
      height += 3 + Math.min(110, width * ratio)
    }
  }
  return Math.max(PRINT_LIMITS.minHeight, Math.min(260, Math.round(height * 10) / 10))
}

/**
 * 按阅读顺序把题目铺进栏位，排满就换页。
 *
 * @param {Array<{questionId: string, record?: object, height?: number}>} items - 题目顺序。
 * @param {object} settings - 排版设置。
 * @returns {{version: number, pages: number, blocks: Array<{questionId: string, page: number, x: number, y: number, w: number}>}} 版面。
 */
export function autoPlace(items, settings) {
  const normalized = normalizeSettings(settings)
  const box = contentBox(normalized)
  const slots = columnSlots(normalized)
  const blocks = []
  let page = 1
  let column = 0
  let y = box.y
  const bottom = box.y + box.height
  for (const item of Array.isArray(items) ? items.slice(0, PRINT_LIMITS.blocks) : []) {
    const questionId = typeof item?.questionId === 'string' ? item.questionId : ''
    if (!questionId) continue
    const slot = slots[column]
    const height = Number.isFinite(item?.height) && Number(item.height) > 0
      ? Math.min(PRINT_LIMITS.pages * 0 + 260, Math.max(PRINT_LIMITS.minHeight, Number(item.height)))
      : estimateHeight(item?.record ?? {}, slot.width, normalized)
    if (y + height > bottom + 0.01) {
      column += 1
      if (column >= slots.length) { column = 0; page += 1 }
      y = box.y
    }
    if (page > PRINT_LIMITS.pages) break
    blocks.push({ questionId, page, x: slots[column].x, y, w: slots[column].width })
    y += height + normalized.gap
  }
  return { version: 1, pages: Math.max(1, page), blocks }
}

/**
 * 把外部数据夹成一份可渲染、可保存的版面。
 *
 * 风险点全部在这里收口：题目不存在、重复、页数越界、坐标越界、宽度超出栏位。
 * 返回的版面一定自洽，调用方不需要再做防御。
 *
 * @param {unknown} raw - 之前保存的版面。
 * @param {string[]} questionIds - 允许出现在版面里的题目 id。
 * @param {object} settings - 排版设置。
 * @returns {{version: number, pages: number, blocks: Array<{questionId: string, page: number, x: number, y: number, w: number, h?: number}>}} 版面。
 */
export function normalizeLayout(raw, questionIds, settings) {
  const normalized = normalizeSettings(settings)
  const box = contentBox(normalized)
  const { width: paperWidth, height: paperHeight } = paperSize(normalized)
  const allowed = new Set((Array.isArray(questionIds) ? questionIds : []).filter(id => typeof id === 'string' && id).slice(0, PRINT_LIMITS.blocks))
  const source = isObject(raw) && Array.isArray(raw.blocks) ? raw.blocks : []
  const minWidth = Math.min(PRINT_LIMITS.minWidth, box.width)
  const seen = new Set()
  const blocks = []
  for (const block of source) {
    const questionId = typeof block?.questionId === 'string' ? block.questionId : ''
    if (!allowed.has(questionId) || seen.has(questionId)) continue
    seen.add(questionId)
    const w = number(block?.w, [minWidth, box.width], box.width)
    const x = number(block?.x, [box.x, Math.max(box.x, paperWidth - normalized.margin - w)], box.x)
    const y = number(block?.y, [box.y, Math.max(box.y, paperHeight - normalized.margin - PRINT_LIMITS.minHeight)], box.y)
    const page = Math.min(PRINT_LIMITS.pages, Math.max(1, Math.round(Number(block?.page) || 1)))
    const h = Number.isFinite(Number(block?.h)) && Number(block.h) > 0 ? Math.min(400, Math.max(PRINT_LIMITS.minHeight, Math.round(Number(block.h) * 10) / 10)) : undefined
    // manual：这一块被用户亲手摆过。字段显隐会改高度，自动版面可以整体重排，
    // 手工版面不行——重排会把用户摆好的位置冲掉。
    blocks.push({ questionId, page, x, y, w, ...(h ? { h } : {}), ...(block?.manual === true ? { manual: true } : {}) })
    if (blocks.length >= PRINT_LIMITS.blocks) break
  }
  const deepest = blocks.reduce((max, block) => Math.max(max, block.page), 1)
  const pages = Math.min(PRINT_LIMITS.pages, Math.max(1, Math.round(Number(raw?.pages) || 1), deepest))
  return { version: 1, pages, blocks }
}

/** 版面里是否一道题都没有。 */
export const isEmptyLayout = layout => !Array.isArray(layout?.blocks) || layout.blocks.length === 0

/** 按阅读顺序（页、上、左）排序，编号与打印顺序都用它。 */
export function readingOrder(blocks) {
  return [...(Array.isArray(blocks) ? blocks : [])].sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x)
}

/**
 * 找出相互重叠的题目块。
 *
 * 完全自由摆放必然允许重叠（用户可能就想要压角），所以这里只报告、不阻止，
 * 由界面给出「可能互相遮挡」的提示。
 *
 * @param {Array<{questionId: string, page: number, x: number, y: number, w: number, h?: number}>} blocks - 带实测高度的题目块。
 * @param {number} [epsilon] - 小于这个面积的重叠忽略（毫米²）。
 * @returns {Array<[string, string]>} 重叠的题目对。
 */
export function findOverlaps(blocks, epsilon = 4) {
  const rows = (Array.isArray(blocks) ? blocks : []).filter(block => Number(block?.h) > 0)
  const pairs = []
  for (let index = 0; index < rows.length; index++) {
    for (let other = index + 1; other < rows.length; other++) {
      const a = rows[index], b = rows[other]
      if (a.page !== b.page) continue
      const width = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
      const height = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
      if (width > 0 && height > 0 && width * height > epsilon) pairs.push([a.questionId, b.questionId])
    }
  }
  return pairs
}

/**
 * 找出超出页面下沿（会被裁掉）的题目。
 *
 * @param {Array<{questionId: string, page: number, y: number, h?: number}>} blocks - 带实测高度的题目块。
 * @param {object} settings - 排版设置。
 * @returns {string[]} 越界题目的 id。
 */
export function findOverflow(blocks, settings) {
  const normalized = normalizeSettings(settings)
  const { height } = paperSize(normalized)
  const bottom = height - normalized.margin
  return (Array.isArray(blocks) ? blocks : []).filter(block => Number(block?.h) > 0 && block.y + block.h > bottom + 0.5).map(block => block.questionId)
}

/** HTML 文本转义。正文由渲染层用 DOM 生成，这里只处理模型自己拼进去的文字。 */
export function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
}

/**
 * 打印样式。与界面同名的 mb-tex-* 类保持一致的排版，数学公式在 PDF 里不会退化。
 *
 * @param {object} settings - 排版设置。
 * @returns {string} CSS 文本。
 */
export function printCSS(settings) {
  const normalized = normalizeSettings(settings)
  const { width, height } = paperSize(normalized)
  const gap = normalized.gap
  return `@page { size: ${width}mm ${height}mm; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; }
body { color: #14171a; font-family: "MiSans", "HarmonyOS Sans SC", "Microsoft YaHei", "Source Han Sans SC", "Noto Sans CJK SC", sans-serif;
  -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.pg { position: relative; width: ${width}mm; height: ${height}mm; overflow: hidden; page-break-after: always; break-after: page; }
.pg:last-child { page-break-after: auto; break-after: auto; }
.pg-head { position: absolute; left: ${normalized.margin}mm; right: ${normalized.margin}mm; top: 4mm;
  display: flex; align-items: flex-end; gap: 4mm; font-size: 8pt; color: #5b6570;
  border-bottom: .2mm solid #d6dbe0; padding-bottom: 1mm; }
.pg-head .spacer { flex: 1; }
.pg-foot { position: absolute; left: ${normalized.margin}mm; right: ${normalized.margin}mm; bottom: 4mm;
  display: flex; align-items: center; gap: 4mm; font-size: 8pt; color: #5b6570; }
.pg-foot .spacer { flex: 1; }
.blk { position: absolute; font-size: ${normalized.fontSize}pt; line-height: 1.6; overflow: hidden; }
.blk-num { display: inline-block; min-width: 5mm; font-weight: 700; color: #2f6b46; }
.blk-title { font-weight: 650; }
.blk-meta { font-size: 8pt; color: #5b6570; margin-left: 2mm; }
.blk-field { margin-top: ${gap / 2}mm; }
.blk-label { font-size: 8pt; color: #5b6570; letter-spacing: .02em; margin-bottom: .6mm; }
.blk-label::before { content: ""; }
.blk-stem { font-size: ${normalized.fontSize}pt; }
.blk img { display: block; max-width: 100%; height: auto; margin: 1.4mm 0; border: .2mm solid #e3e6e9; border-radius: 1mm; }
.blk-missing { font-size: 8pt; color: #a8443a; }
.mb-md p { margin: 0 0 1.2mm; }
.mb-md :is(h3,h4,h5,h6) { margin: 1.6mm 0 .8mm; font-size: 1.02em; }
.mb-md ul, .mb-md ol { margin: .8mm 0 1.2mm; padding-left: 5mm; }
.mb-md blockquote { margin: 1mm 0; padding: 1mm 2.5mm; border-left: .6mm solid #c9d4c4; background: #f5f7f2; }
.mb-md code { font-family: ui-monospace, Consolas, monospace; font-size: .92em; background: #f1f3ef; padding: 0 .6mm; }
.mb-md pre { background: #f3f5f0; border: .2mm solid #e0e4d9; border-radius: 1.4mm; padding: 2mm; font-size: .88em; white-space: pre-wrap; }
.mb-md table { border-collapse: collapse; margin: 1mm 0; }
.mb-md :is(th,td) { border: .2mm solid #dfe3d6; padding: 1mm 2mm; font-size: .92em; }
.mb-md hr { border: none; border-top: .2mm solid #e4e8de; margin: 2mm 0; }
.mb-tex { font-family: "Cambria Math", "Times New Roman", serif; font-style: italic; }
.mb-tex-frac { display: inline-flex; flex-direction: column; vertical-align: middle; text-align: center; margin: 0 .4mm; }
.mb-tex-num { border-bottom: .2mm solid currentColor; padding: 0 .7mm .2mm; }
.mb-tex-den { padding: .2mm .7mm 0; }
.mb-tex sup, .mb-tex sub { font-size: .72em; line-height: 0; }
.mb-tex-sqrt { display: inline-flex; align-items: flex-start; }
.mb-tex-sqrt-sign { font-style: normal; }
.mb-tex-sqrt-body { border-top: .2mm solid currentColor; padding: 0 .4mm; }
.mb-tex-root-index { font-size: .6em; }
.mb-tex-text, .mb-tex-bold { font-style: normal; }
.mb-tex-bold { font-weight: 600; }
.mb-math-block { text-align: center; font-family: "Cambria Math", "Times New Roman", serif; font-style: italic; padding: 1.6mm 0; margin: 1.2mm 0; }
.mb-code-inline { font-family: ui-monospace, Consolas, monospace; }
`
}

/**
 * 拼出交给 printToPDF 的完整 HTML。
 *
 * @param {object} options - 文档内容。
 * @param {object} options.settings - 排版设置。
 * @param {{pages: number, blocks: Array<object>}} options.layout - 版面。
 * @param {Record<string, string>} options.bodies - 题目 id → 正文 HTML（由渲染层生成）。
 * @param {string} [options.title] - 文档标题（也用作未填页眉时的默认页眉）。
 * @param {string} [options.subtitle] - 页眉右侧的补充说明（例如「共 12 题」）。
 * @returns {string} 完整的 HTML 文档。
 */
export function documentHTML({ settings, layout, bodies, title = '错题导出', subtitle = '' } = {}) {
  const normalized = normalizeSettings(settings ?? layout?.settings)
  const normalizedLayout = {
    pages: Math.max(1, Math.min(PRINT_LIMITS.pages, Math.round(Number(layout?.pages) || 1))),
    blocks: Array.isArray(layout?.blocks) ? layout.blocks : [],
  }
  const order = readingOrder(normalizedLayout.blocks)
  const number = new Map(order.map((block, index) => [block.questionId, index + 1]))
  const head = normalized.header || title
  const pages = []
  for (let page = 1; page <= normalizedLayout.pages; page++) {
    const blocks = order.filter(block => block.page === page).map(block => {
      const body = typeof bodies?.[block.questionId] === 'string' && bodies[block.questionId].trim()
        ? bodies[block.questionId]
        : '<p class="blk-missing">这道题的内容没有加载，导出前请重试。</p>'
      const label = normalized.numbering ? `<span class="blk-num">${number.get(block.questionId)}</span>` : ''
      const width = Number(block.w) > 0 ? Number(block.w) : contentBox(normalized).width
      const top = Number(block.y) > 0 ? Number(block.y) : normalized.margin
      const left = Number(block.x) > 0 ? Number(block.x) : normalized.margin
      return `<section class="blk" data-question="${escapeHTML(block.questionId)}" style="left:${left}mm;top:${top}mm;width:${width}mm">${label}${body}</section>`
    }).join('\n')
    pages.push(`<section class="pg" data-page="${page}">
<header class="pg-head"><span>${escapeHTML(head)}</span><span class="spacer"></span><span>${escapeHTML(subtitle)}</span></header>
${blocks}
<footer class="pg-foot"><span>${escapeHTML(normalized.footer)}</span><span class="spacer"></span><span>第 ${page} / ${normalizedLayout.pages} 页</span></footer>
</section>`)
  }
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHTML(title)}</title><style>${printCSS(normalized)}</style></head>
<body>${pages.join('\n')}</body></html>`
}
