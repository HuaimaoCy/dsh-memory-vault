/**
 * 错题 PDF 排版视图：一块 A4 版面，题目可以自由拖动、改宽、跨页，导出前先看清
 * 打印效果。
 *
 * 分工：
 * - 几何、分页、越界与重叠判定、打印 HTML 拼装都在
 *   `addons/mistakebook/print-layout.mjs`（纯函数、可在 Node 下测）；
 * - 本文件只做 DOM 与交互：题池、页面、拖拽、缩放、字段开关、导出调用；
 * - 主进程拿自包含 HTML 打印成 PDF（`notebook.export.pdf`）。
 *
 * 版面坐标一律用毫米：页面与题目块都直接写 `mm`，拖拽时按 96dpi 把位移换算回
 * 毫米，缩放只是页面容器的 CSS transform，不参与坐标计算。
 *
 * @module dsh-memory-vault/desktop/renderer/pdf-export
 */

import {
  PRINT_DEFAULTS, PRINT_FIELDS, PRINT_LIMITS, PRINT_PAPERS, autoPlace, columnSlots,
  contentBox, documentHTML, findOverflow, findOverlaps, normalizeLayout, normalizeSettings,
  paperSize, readingOrder,
} from '../../addons/mistakebook/print-layout.mjs'
import { NOTE_TYPES, STRUCTURED_FIELDS, typeAlias } from '../../addons/mistakebook/fields.mjs'

/** 1mm 在 96dpi 下的 CSS 像素数。 */
const PX_PER_MM = 96 / 25.4
/** 拖拽阈值：小于这个位移当作点击，不产生一次撤销记录。 */
const DRAG_SLOP = 1.5
const ZOOM_MIN = 0.4
const ZOOM_MAX = 1.6

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const round = value => Math.round(value * 10) / 10
const shortDate = value => value ? new Date(value).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }) : ''

/**
 * 建立错题 PDF 排版视图。
 *
 * @param {object} options - 依赖。
 * @param {HTMLElement} options.host - `.mb-workspace`，视图插在页脚之前。
 * @param {HTMLElement} options.shell - `.mb-shell`，用来切换 pdf-on 类。
 * @param {Function} options.h - 节点工厂（与笔记本其余界面同一份）。
 * @param {Function} options.icon - 图标工厂。
 * @param {(action: string, body?: object) => Promise<any>} options.call - 笔记本 op 通道。
 * @param {(message: string, error?: boolean) => void} options.notify - 底部提示。
 * @param {(message: string) => Promise<boolean>} options.confirm - 确认框。
 * @param {Function} options.renderRich - Markdown + LaTeX 渲染（与阅读页同一份）。
 * @param {(rows: unknown[]) => void} options.savePrefs - 写入界面偏好（记住上次排版）。
 * @param {() => object} options.readPrefs - 读取界面偏好。
 * @param {() => Map<string, string>} options.names - 学科/知识点 id → 名称。
 * @param {() => string} [options.mode] - 当前页面标题的备用标题。
 * @returns {{open: Function, isOpen: Function, close: Function}} 视图句柄。
 */
export function createPdfExport({ host, shell, h, icon, call, notify, confirm, renderRich, savePrefs, readPrefs, names }) {
  const state = {
    open: false, busy: false,
    settings: normalizeSettings(PRINT_DEFAULTS),
    layout: { version: 1, pages: 1, blocks: [] },
    candidates: [],
    records: new Map(),
    order: [],
    custom: false,
    selected: '',
    zoom: 0.82,
    reflowToken: 0,
    undo: [], redo: [],
  }
  const draftPrefs = () => {
    const prefs = readPrefs() ?? {}
    const draft = prefs.pdf
    return draft && typeof draft === 'object' ? draft : null
  }
  const saveDraft = () => {
    const prefs = readPrefs() ?? {}
    savePrefs({ ...prefs, pdf: { settings: state.settings, ids: state.order, pages: state.layout.pages, blocks: state.layout.blocks } })
  }

  // —— DOM ——
  const status = h('p', { class: 'mb-pdf-hint', id: 'mb-pdf-hint', role: 'status', 'aria-live': 'polite' })
  const poolList = h('div', { class: 'mb-pdf-pool-list', id: 'mb-pdf-pool-list' })
  const poolSearch = h('input', { class: 'input', type: 'search', id: 'mb-pdf-search', placeholder: '搜索题目标题或题干', 'aria-label': '搜索可导出的笔记' })
  const poolCount = h('span', { class: 'cap', id: 'mb-pdf-pool-count' })
  const pagesHost = h('div', { class: 'mb-pdf-pages', id: 'mb-pdf-pages' })
  const zoomLabel = h('span', { class: 'cap mb-pdf-zoom-label', id: 'mb-pdf-zoom-label', text: '82%' })
  const selectedInfo = h('div', { class: 'mb-pdf-selected', id: 'mb-pdf-selected' })
  const exportButton = h('button', { type: 'button', class: 'btn primary', id: 'mb-pdf-export', text: '导出 PDF', onClick: () => void run(exportPDF) })
  const closeButton = h('button', { type: 'button', class: 'icon-button mb-pdf-close', id: 'mb-pdf-close', title: '回到笔记列表（Esc）', 'aria-label': '回到笔记列表', onClick: () => void close() }, icon('chevron-right'))

  const paperSelect = h('select', { class: 'select', id: 'mb-pdf-paper', 'aria-label': '纸张' },
    Object.entries(PRINT_PAPERS).map(([value, paper]) => h('option', { value, text: paper.label })))
  const columnSelect = h('select', { class: 'select', id: 'mb-pdf-columns', 'aria-label': '自动排列的栏数' },
    [1, 2].map(value => h('option', { value: String(value), text: `${value} 栏` })))
  const fontInput = h('input', { class: 'input mb-pdf-number', type: 'number', id: 'mb-pdf-font', min: String(PRINT_LIMITS.fontSize[0]), max: String(PRINT_LIMITS.fontSize[1]), step: '0.5', 'aria-label': '正文字号（磅）' })
  const marginInput = h('input', { class: 'input mb-pdf-number', type: 'number', id: 'mb-pdf-margin', min: String(PRINT_LIMITS.margin[0]), max: String(PRINT_LIMITS.margin[1]), step: '1', 'aria-label': '页边距（毫米）' })
  const headerInput = h('input', { class: 'input', id: 'mb-pdf-header', placeholder: '页眉（留空用文档标题）', maxlength: String(PRINT_LIMITS.text), 'aria-label': '页眉' })
  const footerInput = h('input', { class: 'input', id: 'mb-pdf-footer', placeholder: '页脚（页码始终在右下角）', maxlength: String(PRINT_LIMITS.text), 'aria-label': '页脚' })
  const numberingInput = h('input', { type: 'checkbox', id: 'mb-pdf-numbering' })
  const fieldToggles = Object.fromEntries(PRINT_FIELDS.map(([key, label]) => [key, h('input', {
    type: 'checkbox', 'data-pdf-field': key, id: `mb-pdf-field-${key}`,
    // 直接落到 state，不经过 run()：run 的 busy 门闩会静默丢掉紧接着的第二次改动
    // （连点两个字段开关时，第二个永远不生效）。
    onChange: () => apply(() => changeFields()),
  })]))

  const bar = h('div', { class: 'mb-pdf-bar', id: 'mb-pdf-bar' },
    h('div', { class: 'mb-pdf-bar-title' }, closeButton,
      h('div', {}, h('strong', { text: '排版与导出' }), h('span', { class: 'cap', text: 'A4 · 拖动题目块自由摆放' }))),
    h('span', { class: 'spacer' }),
    h('div', { class: 'mb-pdf-bar-actions' },
      h('label', { class: 'mb-pdf-control', title: '纸张方向' }, h('span', { class: 'cap', text: '纸张' }), paperSelect),
      h('label', { class: 'mb-pdf-control', title: '自动排列时的栏数；题目块仍可自由拖动' }, h('span', { class: 'cap', text: '栏数' }), columnSelect),
      h('label', { class: 'mb-pdf-control', title: '正文字号' }, h('span', { class: 'cap', text: '字号' }), fontInput),
      h('label', { class: 'mb-pdf-control', title: '页边距' }, h('span', { class: 'cap', text: '边距' }), marginInput),
      h('button', { type: 'button', class: 'btn ghost', id: 'mb-pdf-arrange', text: '重新排列', onClick: () => void run(() => rearrange(true)) }),
      h('button', { type: 'button', class: 'btn ghost', id: 'mb-pdf-undo', text: '撤销', disabled: true, onClick: () => void run(undo) }),
      exportButton))

  const optionsPanel = h('div', { class: 'mb-pdf-options', id: 'mb-pdf-options' },
    h('div', { class: 'mb-pdf-field-row' },
      h('span', { class: 'label', text: '显示内容' }),
      ...PRINT_FIELDS.map(([key, label]) => h('label', { class: 'mb-pdf-chip' }, fieldToggles[key], h('span', { text: label }))),
      h('label', { class: 'mb-pdf-chip' }, numberingInput, h('span', { text: '题号' }))),
    h('div', { class: 'mb-pdf-text-row' }, headerInput, footerInput))

  const sidebar = h('aside', { class: 'mb-pdf-side', id: 'mb-pdf-side' },
    h('div', { class: 'mb-pdf-side-head' }, h('strong', { text: '可导出的笔记' }), h('span', { class: 'spacer' }), poolCount),
    poolSearch, poolList)

  const stage = h('div', { class: 'mb-pdf-stage' },
    h('div', { class: 'mb-pdf-stage-head' },
      h('div', { class: 'row' }, status),
      h('div', { class: 'row mb-pdf-zoom' },
        h('button', { type: 'button', class: 'btn ghost', id: 'mb-pdf-zoom-out', title: '缩小', onClick: () => setZoom(state.zoom / 1.15) }, '−'),
        zoomLabel,
        h('button', { type: 'button', class: 'btn ghost', id: 'mb-pdf-zoom-in', title: '放大', onClick: () => setZoom(state.zoom * 1.15) }, '＋'),
        h('button', { type: 'button', class: 'btn ghost', id: 'mb-pdf-zoom-fit', title: '缩放到适应宽度', onClick: () => fitZoom() }, '适应宽度'))),
    pagesHost,
    selectedInfo)

  const section = h('section', { class: 'mb-pdf', id: 'mb-pdf', hidden: true, 'aria-label': '错题 PDF 排版' },
    bar, optionsPanel, h('div', { class: 'mb-pdf-body' }, sidebar, stage))
  host.insertBefore(section, host.lastElementChild)

  // —— 设置与控件同步 ——
  // 按钮态与输入值分开同步：`run()` 开头的同步**不能**回写输入值，否则用户刚勾上
  // 的复选框会在动作读到它之前被旧的 state 值抹掉（真的发生过：参考答案开关无效）。
  function syncButtons() {
    exportButton.disabled = state.busy || !state.layout.blocks.length
    bar.querySelector('#mb-pdf-undo').disabled = state.busy || !state.undo.length
    bar.querySelector('#mb-pdf-arrange').disabled = state.busy || !state.order.length
  }
  function syncControls() {
    const settings = state.settings
    paperSelect.value = settings.paper
    columnSelect.value = String(settings.columns)
    fontInput.value = String(settings.fontSize)
    marginInput.value = String(settings.margin)
    headerInput.value = settings.header
    footerInput.value = settings.footer
    numberingInput.checked = settings.numbering
    for (const [key] of PRINT_FIELDS) fieldToggles[key].checked = Boolean(settings.fields[key])
    syncButtons()
  }
  const readSettings = () => normalizeSettings({
    ...state.settings,
    paper: paperSelect.value,
    columns: Number(columnSelect.value),
    fontSize: fontInput.value,
    margin: marginInput.value,
    header: headerInput.value,
    footer: footerInput.value,
    numbering: numberingInput.checked,
    fields: Object.fromEntries(PRINT_FIELDS.map(([key]) => [key, fieldToggles[key].checked])),
  })
  for (const input of [paperSelect, columnSelect, fontInput, marginInput, headerInput, footerInput, numberingInput]) {
    input.addEventListener('change', () => apply(changeSettings))
  }
  /** 设置类改动一步落地，失败就提示，不经过 run 的忙碌门闩。 */
  function apply(action) {
    try { action() }
    catch (error) { notify(error.message || String(error), true) }
  }

  function changeSettings() {
    const next = readSettings()
    const structural = next.paper !== state.settings.paper || next.fontSize !== state.settings.fontSize
      || next.margin !== state.settings.margin || next.columns !== state.settings.columns
      || JSON.stringify(next.fields) !== JSON.stringify(state.settings.fields)
    state.settings = next
    syncControls()
    if (!state.layout.blocks.length) { state.custom = false; return }
    if (structural) {
      // 版面尺度变了，保留旧坐标只会互相压字：明确重排，并在提示里说清楚。
      state.custom = false
      rearrange(false)
      notify('版式已更新，题目已重新排列')
    } else {
      repaintBlocks()
      saveDraft()
    }
  }
  function changeFields() {
    state.settings = readSettings()
    syncControls()
    // 字段显隐会改变块高度：还没有任何手工拖动时整体重排（最常见的一路），
    // 已经有手工位置时保留坐标，只把越界与遮挡标出来，不擅自挪用户的版面。
    if (state.layout.blocks.length && state.layout.blocks.every(block => block.manual !== true)) {
      rearrange(false)
    } else {
      repaintBlocks()
    }
    saveDraft()
  }
  function setZoom(value) {
    state.zoom = clamp(Math.round(value * 100) / 100, ZOOM_MIN, ZOOM_MAX)
    zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`
    pagesHost.style.setProperty('--mb-pdf-zoom', String(state.zoom))
  }
  function fitZoom() {
    const available = pagesHost.clientWidth - 32
    const page = paperSize(state.settings)
    if (available > 0) setZoom(clamp(available / (page.width * PX_PER_MM), ZOOM_MIN, ZOOM_MAX))
  }

  // —— 题池 ——
  function paintPool() {
    const term = poolSearch.value.trim().toLocaleLowerCase()
    const placed = new Set(state.order)
    const rows = state.candidates.filter(row => `${row.title ?? ''}\n${row.stem ?? ''}`.toLocaleLowerCase().includes(term))
    poolCount.textContent = `已放 ${placed.size} / ${state.candidates.length}`
    poolList.replaceChildren(...(rows.length ? rows.map(row => {
      const on = placed.has(row.id)
      return h('label', { class: `mb-pdf-pool-row${on ? ' placed' : ''}`, 'data-pool-id': row.id },
        h('input', {
          type: 'checkbox', checked: on, 'data-pool-add': row.id,
          onChange: event => void run(() => (event.target.checked ? addQuestion(row.id) : removeQuestion(row.id))),
        }),
        h('span', { class: 'mb-pdf-pool-text' },
          h('strong', { text: row.title || (row.stem ?? '').split('\n')[0].slice(0, 60) || '未命名' }),
          h('small', { text: `${NOTE_TYPES[typeAlias(row.type)]?.label ?? '笔记'}${row.subjectID ? ` · ${names().get(row.subjectID) ?? ''}` : ''}` })))
    }) : [h('p', { class: 'cap', text: state.candidates.length ? '没有匹配的笔记' : '当前列表里没有可导出的笔记' })]))
  }

  // —— 题目块内容 ——
  const fieldLabels = { stem: '题目', studentWork: '我的作答', referenceAnswer: '参考答案', cause: '错因', notes: '复盘' }
  function fieldBlock(label, value) {
    return h('div', { class: `blk-field blk-${label}` },
      h('div', { class: 'blk-label', text: fieldLabels[label] ?? label }),
      renderRich(value))
  }
  function structuredBlocks(record) {
    const type = typeAlias(record.type)
    const layout = STRUCTURED_FIELDS[type] ?? []
    return layout.map(([key, label]) => {
      const value = record[type]?.[key] ?? ''
      if (typeof value !== 'string' || !value.trim()) return null
      if (type === 'vocabulary' && key === 'word') return null
      return h('div', { class: 'blk-field' }, h('div', { class: 'blk-label', text: label }), renderRich(value))
    }).filter(Boolean)
  }
  /**
   * 一道题在版面上的正文。预览与导出共用，保证「看到的就是打印出来的」。
   *
   * @param {object} record - 笔记记录。
   * @param {string[]} imageURLs - 已就绪的原图地址。
   * @returns {HTMLElement}
   */
  function blockContent(record, imageURLs) {
    const settings = state.settings
    const meta = [names().get(record.subjectID), names().get(record.nodeID), shortDate(record.updatedAt)].filter(Boolean).join(' · ')
    const title = record.title || record.vocabulary?.word || (record.stem ?? '').split('\n')[0].slice(0, 80) || '未命名笔记'
    const children = [
      h('div', { class: 'blk-head' },
        h('span', { class: 'blk-title', text: title }),
        settings.fields.meta && meta ? h('span', { class: 'blk-meta', text: meta }) : null),
    ]
    if (settings.fields.meta && Array.isArray(record.tags) && record.tags.length) children.push(h('div', { class: 'blk-tags', text: record.tags.slice(0, 6).map(tag => `#${tag}`).join(' ') }))
    if (record.stem) children.push(fieldBlock('stem', record.stem))
    if (settings.fields.image && imageURLs.length) children.push(h('div', { class: 'blk-images' }, imageURLs.map((url, index) => h('img', { src: url, alt: `${title} 原图 ${index + 1}`, loading: 'eager' }))))
    children.push(...structuredBlocks(record))
    if (settings.fields.studentWork && record.studentWork) children.push(fieldBlock('studentWork', record.studentWork))
    if (settings.fields.referenceAnswer && record.referenceAnswer) children.push(fieldBlock('referenceAnswer', record.referenceAnswer))
    if (settings.fields.cause && record.cause) children.push(fieldBlock('cause', record.cause))
    if (settings.fields.notes && record.notes) children.push(fieldBlock('notes', record.notes))
    if (children.length <= 1) children.push(h('p', { class: 'blk-missing', text: '这道笔记没有可打印的正文。' }))
    return h('div', { class: 'blk-inner' }, children)
  }
  const imageURL = image => `data:${image.mimeType};base64,${image.data}`

  // —— 页面渲染 ——
  function pageLayer(index) {
    return pagesHost.querySelector(`[data-pdf-page="${index}"] .mb-pdf-layer`)
  }
  function renderPages() {
    const size = paperSize(state.settings)
    const nodes = []
    for (let index = 1; index <= state.layout.pages; index++) {
      // 外层 frame 按缩放后的尺寸占位，内层页面用 transform 缩放：transform 不参与
      // 布局，若直接缩放页面元素，缩小时页与页之间会留下原来的空隙。
      nodes.push(h('div', {
        class: 'mb-pdf-page-frame',
        style: `width:calc(${size.width}mm * var(--mb-pdf-zoom));height:calc(${size.height}mm * var(--mb-pdf-zoom))`,
      },
      h('section', {
        class: 'mb-pdf-page', 'data-pdf-page': index, tabindex: '-1',
        style: `width:${size.width}mm;height:${size.height}mm`,
        'aria-label': `第 ${index} 页`,
      },
      h('header', { class: 'mb-pdf-page-head', style: `left:${state.settings.margin}mm;right:${state.settings.margin}mm` },
        h('span', { text: state.settings.header || '错题' }),
        h('span', { class: 'spacer' }),
        h('span', { text: `第 ${index} / ${state.layout.pages} 页` })),
      h('div', { class: 'mb-pdf-layer', 'data-pdf-layer': index }))))
    }
    pagesHost.replaceChildren(...nodes)
    repaintBlocks()
    pagesHost.style.setProperty('--mb-pdf-zoom', String(state.zoom))
  }
  function repaintBlocks() {
    const order = readingOrder(state.layout.blocks)
    const number = new Map(order.map((block, index) => [block.questionId, index + 1]))
    for (const layer of pagesHost.querySelectorAll('.mb-pdf-layer')) layer.replaceChildren()
    for (const block of order) {
      const record = state.records.get(block.questionId)
      const layer = pageLayer(block.page)
      if (!layer) continue
      const urls = state.settings.fields.image ? (record?.images ?? []).map(imageURL) : []
      const node = h('article', {
        class: `mb-pdf-block${state.selected === block.questionId ? ' selected' : ''}`,
        'data-pdf-block': block.questionId, tabindex: '0',
        style: `left:${block.x}mm;top:${block.y}mm;width:${block.w}mm`,
        'aria-label': `第 ${number.get(block.questionId)} 题`,
      },
        h('span', { class: 'mb-pdf-block-num', text: String(number.get(block.questionId)) }),
        h('button', { type: 'button', class: 'mb-pdf-block-remove', 'aria-label': '从版面移除', title: '从版面移除（Delete）', onClick: event => { event.stopPropagation(); void run(() => removeQuestion(block.questionId)) } }, '×'),
        h('span', { class: 'mb-pdf-block-grip', 'aria-hidden': 'true' }, '⠿'),
        blockContent(record ?? { title: '题目未加载' }, urls),
        h('span', { class: 'mb-pdf-block-resize', 'data-resize': 'true', 'aria-hidden': 'true', title: '拖动改变宽度' }))
      node.addEventListener('pointerdown', event => beginDrag(event, block.questionId))
      layer.append(node)
      block.h = Math.round(node.offsetHeight / PX_PER_MM * 10) / 10
    }
    paintWarnings()
    syncButtons()
    paintSelected()
  }
  function paintWarnings() {
    const overlaps = findOverlaps(state.layout.blocks)
    const overflow = findOverflow(state.layout.blocks, state.settings)
    const empty = !state.layout.blocks.length
    const parts = []
    if (empty) parts.push('把左侧的笔记勾进来，或直接拖到页面上。')
    else {
      parts.push(`共 ${state.layout.blocks.length} 道题 · ${state.layout.pages} 页`)
      if (overflow.length) parts.push(`${overflow.length} 道题超出页面下沿，会被裁掉`)
      if (overlaps.length) parts.push(`${overlaps.length} 处题目互相遮挡`)
    }
    status.textContent = parts.join(' · ')
    status.className = `mb-pdf-hint${overflow.length || overlaps.length ? ' warn' : ''}`
  }
  function paintSelected() {
    if (!state.selected) { selectedInfo.replaceChildren(h('span', { class: 'cap', text: '选中题目块后可用方向键微调（Shift 5mm），Delete 移出版面。' })); return }
    const block = state.layout.blocks.find(row => row.questionId === state.selected)
    const record = state.records.get(state.selected)
    if (!block) { state.selected = ''; paintSelected(); return }
    selectedInfo.replaceChildren(
      h('strong', { text: record?.title || '已选题目' }),
      h('span', { class: 'cap', text: `第 ${block.page} 页 · x ${block.x}mm · y ${block.y}mm · 宽 ${block.w}mm` }),
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn ghost', id: 'mb-pdf-to-width', text: '占满内容宽', onClick: () => void run(() => setWidth(block.questionId, contentBox(state.settings).width)) }),
      h('button', { type: 'button', class: 'btn ghost', id: 'mb-pdf-to-column', text: '半宽', onClick: () => void run(() => setWidth(block.questionId, columnSlots(state.settings)[0].width)) }),
      h('button', { type: 'button', class: 'btn ghost', id: 'mb-pdf-next-page', text: '下一页', onClick: () => void run(() => shiftPage(block.questionId, 1)) }),
      h('button', { type: 'button', class: 'btn ghost', id: 'mb-pdf-prev-page', text: '上一页', onClick: () => void run(() => shiftPage(block.questionId, -1)) }),
      h('button', { type: 'button', class: 'btn ghost', id: 'mb-pdf-remove', text: '移出版面', onClick: () => void run(() => removeQuestion(block.questionId)) }))
  }

  // —— 版面变更 ——
  function snapshot() {
    state.undo.push({ blocks: state.layout.blocks.map(block => ({ ...block })), pages: state.layout.pages })
    if (state.undo.length > 50) state.undo.shift()
    state.redo = []
  }
  function applyLayout(next) {
    state.layout = next
    if (state.layout.pages !== pagesHost.querySelectorAll('.mb-pdf-page').length) renderPages()
    else repaintBlocks()
    saveDraft()
  }
  function commit() { applyLayout(normalizeLayout(state.layout, state.order, state.settings)) }
  function rearrange(auto) {
    if (!state.order.length) { notify('版面里还没有题目', true); return }
    if (auto) snapshot()
    const token = ++state.reflowToken
    const items = state.order.map(questionId => ({ questionId, record: state.records.get(questionId) ?? {}, height: state.layout.blocks.find(block => block.questionId === questionId)?.h }))
    state.layout = autoPlace(items, state.settings)
    state.custom = false
    renderPages()
    // 第一次排是估算高度；量完真实高度再排一次，避免长题压到下沿。
    // 用户在这一帧里已经开始拖动时（custom 或 token 变化）就放弃重排，
    // 不能把刚摆好的位置覆盖掉。
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      if (token !== state.reflowToken || state.custom) return
      const items2 = state.order.map(questionId => ({ questionId, record: state.records.get(questionId) ?? {}, height: state.layout.blocks.find(block => block.questionId === questionId)?.h }))
      state.layout = autoPlace(items2, state.settings)
      renderPages(); saveDraft()
      if (auto) notify(`已按 ${state.settings.columns} 栏重新排列`)
    }))
  }
  async function addQuestion(id) {
    if (state.order.includes(id)) return
    if (state.order.length >= PRINT_LIMITS.blocks) { notify(`最多 ${PRINT_LIMITS.blocks} 道题`, true); return }
    const row = state.candidates.find(item => item.id === id)
    if (row?.type === 'paper') { notify('试卷请从「导出 PDF」入口打开，会展开成其中的题目', true); return }
    snapshot()
    const record = await loadRecord(id)
    if (!record) { state.undo.pop(); return }
    state.records.set(id, record)
    state.order.push(id)
    const pages = Math.max(state.layout.pages, 1)
    if (state.custom) {
      const slot = columnSlots(state.settings)[0]
      const box = contentBox(state.settings)
      const used = state.layout.blocks.filter(block => block.page === pages)
      const y = used.length ? Math.max(...used.map(block => block.y + (block.h ?? 20))) + state.settings.gap : box.y
      state.layout.blocks.push({ questionId: id, page: Math.min(pages, PRINT_LIMITS.pages), x: slot.x, y: Math.min(y, box.y + box.height - PRINT_LIMITS.minHeight), w: slot.width })
      renderPages()
    } else {
      rearrange(false)
    }
    paintPool(); saveDraft()
  }
  function removeQuestion(id) {
    if (!state.order.includes(id)) return
    snapshot()
    state.order = state.order.filter(item => item !== id)
    state.layout.blocks = state.layout.blocks.filter(block => block.questionId !== id)
    if (state.selected === id) state.selected = ''
    const deepest = state.layout.blocks.reduce((max, block) => Math.max(max, block.page), 1)
    state.layout.pages = Math.max(1, deepest)
    state.layout = normalizeLayout(state.layout, state.order, state.settings)
    renderPages(); paintPool(); saveDraft()
  }
  function setWidth(id, width) {
    const block = state.layout.blocks.find(row => row.questionId === id)
    if (!block) return
    snapshot()
    block.manual = true
    block.w = round(clamp(width, Math.min(PRINT_LIMITS.minWidth, contentBox(state.settings).width), contentBox(state.settings).width))
    commit()
  }
  function shiftPage(id, delta) {
    const block = state.layout.blocks.find(row => row.questionId === id)
    if (!block) return
    snapshot()
    const target = clamp(block.page + delta, 1, PRINT_LIMITS.pages)
    if (target === block.page) return
    block.manual = true
    block.page = target
    block.y = contentBox(state.settings).y
    state.layout.pages = Math.max(state.layout.pages, target)
    commit()
  }
  function undo() {
    const previous = state.undo.pop()
    if (!previous) return
    state.redo.push({ blocks: state.layout.blocks.map(block => ({ ...block })), pages: state.layout.pages })
    state.layout = { version: 1, pages: previous.pages, blocks: previous.blocks }
    state.layout = normalizeLayout(state.layout, state.order, state.settings)
    renderPages(); paintPool(); saveDraft()
  }
  async function loadRecord(id) {
    try {
      const record = await call('read', { id })
      if (!record || record.type === 'paper') throw new Error('这道笔记不能导出为 PDF')
      return record
    } catch (error) {
      notify(error.message || String(error), true)
      return null
    }
  }

  // —— 拖拽 ——
  let drag = null
  let opener = null
  /** 按 dataset 找题目块节点：id 里可能有需要转义的字符，遍历比拼选择器稳。 */
  const blockNode = questionId => [...pagesHost.querySelectorAll('[data-pdf-block]')].find(node => node.dataset.pdfBlock === questionId) ?? null
  function beginDrag(event, questionId) {
    if (state.busy || event.button > 0) return
    const block = state.layout.blocks.find(row => row.questionId === questionId)
    if (!block) return
    state.selected = questionId
    for (const node of pagesHost.querySelectorAll('.mb-pdf-block')) node.classList.toggle('selected', node.dataset.pdfBlock === questionId)
    paintSelected()
    const resize = Boolean(event.target.closest('.mb-pdf-block-resize'))
    if (event.target.closest('button')) return
    const start = { x: event.clientX, y: event.clientY }
    drag = {
      questionId, moved: false, resize, start,
      origin: { x: block.x, y: block.y, w: block.w, page: block.page },
      node: blockNode(questionId),
    }
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* 合成事件没有活动指针 */ }
    event.preventDefault()
    window.addEventListener('pointermove', moveDrag)
    window.addEventListener('pointerup', endDrag, { once: true })
    window.addEventListener('pointercancel', endDrag, { once: true })
  }
  function moveDrag(event) {
    if (!drag) return
    const dx = (event.clientX - drag.start.x) / PX_PER_MM / state.zoom
    const dy = (event.clientY - drag.start.y) / PX_PER_MM / state.zoom
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_SLOP) return
    if (!drag.moved) { drag.moved = true; state.custom = true; snapshot(); drag.node?.classList.add('dragging') }
    const block = state.layout.blocks.find(row => row.questionId === drag.questionId)
    if (!block || !drag.node) return
    const box = contentBox(state.settings), size = paperSize(state.settings)
    if (drag.resize) {
      block.w = round(clamp(drag.origin.w + dx, Math.min(PRINT_LIMITS.minWidth, box.width), box.width))
      block.x = round(clamp(drag.origin.x, box.x, size.width - state.settings.margin - block.w))
    } else {
      block.x = round(clamp(drag.origin.x + dx, box.x, size.width - state.settings.margin - block.w))
      block.y = round(drag.origin.y + dy)
    }
    drag.node.style.left = `${block.x}mm`
    drag.node.style.top = `${block.y}mm`
    drag.node.style.width = `${block.w}mm`
  }
  function endDrag() {
    window.removeEventListener('pointermove', moveDrag)
    if (!drag) return
    const block = state.layout.blocks.find(row => row.questionId === drag.questionId)
    const node = drag.node
    node?.classList.remove('dragging')
    const moved = drag.moved
    drag = null
    if (!block || !moved) { paintWarnings(); return }
    state.custom = true
    block.manual = true
    // 拖到页面外：落在哪一页就归哪一页；页面之间的空隙按最近的一页算。
    const page = pageAt(state.layout.blocks.find(row => row.questionId === block.questionId))
    if (page !== block.page) { block.page = page }
    const pageHeight = paperSize(state.settings).height
    if (block.y < 0) block.y = contentBox(state.settings).y
    if (block.y > pageHeight - PRINT_LIMITS.minHeight) block.y = pageHeight - state.settings.margin - PRINT_LIMITS.minHeight
    state.layout.pages = Math.max(state.layout.pages, block.page)
    commit()
  }
  /** 指针所在的页：块中心点落在哪一页的纵向范围内。 */
  function pageAt(block) {
    const node = blockNode(block.questionId)
    if (!node) return block.page
    const rect = node.getBoundingClientRect()
    const center = rect.top + rect.height / 2
    let best = block.page, distance = Infinity
    for (const page of pagesHost.querySelectorAll('.mb-pdf-page')) {
      const box = page.getBoundingClientRect()
      const offset = center < box.top ? box.top - center : center > box.bottom ? center - box.bottom : 0
      if (offset < distance) { distance = offset; best = Number(page.dataset.pdfPage) }
    }
    return best || block.page
  }

  // —— 导出 ——
  async function shrinkImage(image, maxWidth = 1400) {
    const url = imageURL(image)
    try {
      const decoded = new Image()
      decoded.src = url
      await decoded.decode()
      if (decoded.naturalWidth <= maxWidth) return url
      const width = maxWidth
      const height = Math.max(1, Math.round(decoded.naturalHeight * (maxWidth / decoded.naturalWidth)))
      const canvas = document.createElement('canvas')
      canvas.width = width; canvas.height = height
      const context = canvas.getContext('2d')
      context.fillStyle = '#fff'; context.fillRect(0, 0, width, height)
      context.drawImage(decoded, 0, 0, width, height)
      return canvas.toDataURL('image/jpeg', 0.86)
    } catch { return url }
  }
  async function exportPDF() {
    if (!state.layout.blocks.length) throw new Error('版面里还没有题目')
    const bodies = {}
    for (const block of state.layout.blocks) {
      const record = state.records.get(block.questionId) ?? await loadRecord(block.questionId)
      if (!record) throw new Error('有题目未加载，请重试')
      const urls = state.settings.fields.image ? await Promise.all((record.images ?? []).map(image => shrinkImage(image))) : []
      bodies[block.questionId] = blockContent(record, urls).outerHTML
    }
    const title = state.settings.header || `错题 · ${new Date().toISOString().slice(0, 10)}`
    const html = documentHTML({
      settings: state.settings, layout: state.layout, bodies, title,
      subtitle: `${state.layout.blocks.length} 道题 · ${PRINT_PAPERS[state.settings.paper].label}`,
    })
    const reply = await call('export.pdf', { html })
    if (!reply) { notify('已取消导出'); return }
    saveDraft()
    notify(`已导出 PDF：${reply.path}`)
  }
  async function run(action) {
    if (state.busy) return
    state.busy = true; section.classList.add('busy'); syncButtons()
    try { await action() }
    catch (error) { notify(error.message || String(error), true) }
    finally { state.busy = false; section.classList.remove('busy'); syncButtons() }
  }

  // —— 打开与关闭 ——
  async function open({ ids = [] } = {}) {
    if (state.open) return
    opener = document.activeElement
    const list = await call('list', { view: 'all', order: 'updated' })
    state.candidates = (list.records ?? []).filter(row => row.type !== 'paper' && !row.isSoftDeleted)
    const draft = draftPrefs()
    state.settings = normalizeSettings(draft?.settings ?? PRINT_DEFAULTS)
    state.layout = { version: 1, pages: 1, blocks: [] }
    state.order = []
    state.records.clear()
    state.custom = false
    state.selected = ''
    state.undo = []; state.redo = []
    const requested = [...new Set((ids.length ? ids : Array.isArray(draft?.ids) ? draft.ids : []).filter(id => state.candidates.some(row => row.id === id)))]
    for (const id of requested.slice(0, PRINT_LIMITS.blocks)) {
      const record = await loadRecord(id)
      if (!record) continue
      state.records.set(id, record); state.order.push(id)
    }
    const restored = draft && Array.isArray(draft.blocks) && requested.length && Array.isArray(draft.ids)
      && state.order.every(id => draft.ids.includes(id))
    if (restored) {
      state.layout = normalizeLayout({ pages: draft.pages, blocks: draft.blocks }, state.order, state.settings)
      state.custom = true
    }
    state.open = true
    section.hidden = false
    shell.classList.add('pdf-on')
    syncControls(); paintPool(); setZoom(state.zoom)
    if (state.order.length && state.custom) { renderPages(); fitZoom() }
    else if (state.order.length) { rearrange(false); fitZoom() }
    else { renderPages(); fitZoom() }
    window.setTimeout(fitZoom, 60)
    document.getElementById('mb-pdf-close')?.focus()
  }
  async function close() {
    if (state.busy) return
    if (!state.open) return
    if (state.order.length) saveDraft()
    state.open = false
    section.hidden = true
    shell.classList.remove('pdf-on')
    pagesHost.replaceChildren()
    state.selected = ''
    if (opener?.isConnected) opener.focus({ preventScroll: true })
    else document.getElementById('mb-open-canvas')?.focus()
  }
  const isOpen = () => state.open && !section.hidden

  // —— 键盘 ——
  function nudge(block, dx, dy) {
    snapshot()
    block.manual = true
    const box = contentBox(state.settings), size = paperSize(state.settings)
    block.x = round(clamp(block.x + dx, box.x, size.width - state.settings.margin - block.w))
    block.y = round(clamp(block.y + dy, 0, size.height - PRINT_LIMITS.minHeight))
    state.custom = true
    commit()
  }
  section.addEventListener('keydown', event => {
    if (!state.open) return
    const typing = event.target.closest('input, select, textarea')
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      if (typing && event.target.tagName !== 'SELECT') return
      event.preventDefault()
      void run(undo)
      return
    }
    if (event.key === 'Escape') { event.preventDefault(); void close(); return }
    if (typing) return
    const block = state.layout.blocks.find(row => row.questionId === state.selected)
    if (!block) return
    const step = event.shiftKey ? 5 : 1
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
    if (moves[event.key]) { event.preventDefault(); void run(() => nudge(block, ...moves[event.key])); return }
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); void run(() => removeQuestion(block.questionId)) }
  })
  poolSearch.addEventListener('input', paintPool)

  return { open, isOpen, close }
}
