/**
 * 自由画布视图：一块世界坐标版面上的卡片（文本、便签、现有笔记引用）。
 *
 * 「无限」指没有固定纸张：卡片各有世界坐标，视口是一次平移 + 缩放，
 * 滚轮以指针为中心缩放，拖动空白处平移。所有业务规则（校验、视口数学、
 * 卡片操作）在 addons/mistakebook/canvas.mjs；这里只做 DOM 与交互。
 *
 * 持久化：window.vault.canvas('load' | 'save')，落到笔记本域的 canvas 键，
 * 随笔记本导出、导入与备份一起走，不进入数据库（记忆）域。保存失败在
 * 状态芯片与底部提示里都可见，并且不会吞掉内存里的修改。
 *
 * @module dsh-memory-vault/desktop/renderer/freeform-canvas
 */

import { NOTE_TYPES } from '../../addons/mistakebook/fields.mjs'
import { inkBounds, inkCoordinate } from '../../addons/mistakebook/canvas-ink.mjs'
import { canvasQuestionImageURI as imageURI } from '../../addons/mistakebook/canvas-question.mjs'
import { boxDelta, boxSelection as findBoxSelection, moveBoxSelection, offsetBoxSelection } from '../../addons/mistakebook/canvas-selection.mjs'
import { SHAPE_KINDS, SHAPE_LIMIT, shapeBounds, shapeParts } from '../../addons/mistakebook/canvas-shapes.mjs'
import { createCanvasQuestion } from './canvas-question.js'
import { createCanvasQuickPalette } from './canvas-quick-palette.js'
import { createDrawingCursor } from './drawing-cursor.js'
import { createCanvasInk } from './freeform-ink.js'
import {
  A4_SIZE, CANVAS_IMAGE_LIMITS, CANVAS_LIMITS, DEFAULT_SIZES, STICKY_TONES, activeCanvas, activePaperSheet, addCard, addPaperSheet, canvasById, contentBounds,
  checkCanvasImageBudget, checkInkBudget, createCanvas, defaultView, deleteCanvas, edgeGeometry, emptyDocument, fitView, linkCards,
  normalizeDocument, normalizeView, panBy, placement, removeCards, removeEdge, removePaperSheet, renameCanvas, screenToWorld,
  selectPaperSheet, updateCard, zoomAt,
} from '../../addons/mistakebook/canvas.mjs'

const kindLabels = { text: '文本', sticky: '便签', reference: '笔记', image: '图片' }
const isQuestion = card => card?.kind === 'reference' && card.noteType === 'mistake'
const questionViewport = '.mb-canvas-question-viewport'
const noteLabel = type => NOTE_TYPES[type]?.label ?? '笔记'
const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const round = value => Math.round(value)
const coord = value => clamp(round(value), -CANVAS_LIMITS.coordinate, CANVAS_LIMITS.coordinate)
const shapeCoord = value => inkCoordinate(clamp(value, -CANVAS_LIMITS.coordinate, CANVAS_LIMITS.coordinate))
const svg = (tag, attributes) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag)
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value))
  return node
}

/**
 * 建立画布视图。
 *
 * @param {object} options - 宿主能力（全部由 mistakebook.js 注入，模块本身不 import DOM）。
 * @param {HTMLElement} options.host - `.mb-workspace`，画布插在页脚之前。
 * @param {HTMLElement} options.shell - `.mb-shell`，用来切换 canvas-on 类。
 * @param {Function} options.h - 共享的元素构造器。
 * @param {Function} options.icon - 图标构造器。
 * @param {Function} options.dialog - 共享的对话框构造器。
 * @param {(action: string, body?: object) => Promise<any>} options.call - 画布通道（load/save）。
 * @param {(message: string, error?: boolean) => void} options.notify - 底部提示。
 * @param {(message: string) => Promise<boolean>} options.confirm - 破坏性操作确认。
 * @param {(id: string) => Promise<void>} options.openNote - 在笔记本里打开一篇笔记。
 * @param {() => Promise<object[]>} options.notes - 读取全部笔记（引用卡片用）。
 * @param {(message: string, error?: boolean) => void} [options.onState] - 画布打开/关闭的通知。
 * @returns {{ open: () => Promise<void>, close: () => Promise<void>, isOpen: () => boolean, section: HTMLElement }}
 */
export function createCanvasView(options) {
  const { host, shell, h, icon, dialog, call, notify, confirm, openNote, previewNote, notes, readQuestion, readImage, renderRich } = options

  const stateChip = h('button', { type: 'button', class: 'mb-canvas-save cap', id: 'mb-canvas-save-state', title: '画布保存状态；失败时点击重试', text: '已保存' })
  const picker = h('select', { class: 'select', id: 'mb-canvas-picker', 'aria-label': '切换画布' })
  const zoomLabel = h('span', { class: 'mb-canvas-zoom-label', id: 'mb-canvas-zoom', text: '100%' })
  const undoButton = h('button', { type: 'button', class: 'mb-canvas-icon', id: 'mb-canvas-undo', title: '撤销 · Ctrl / ⌘ Z', 'aria-label': '撤销', disabled: true, onClick: () => undo() }, icon('undo'))
  const redoButton = h('button', { type: 'button', class: 'mb-canvas-icon', id: 'mb-canvas-redo', title: '重做 · Ctrl / ⌘ Shift Z', 'aria-label': '重做', disabled: true, onClick: () => redo() }, icon('redo'))

  const surface = h('div', {
    class: 'mb-canvas-surface', id: 'mb-canvas-surface', tabindex: '0', role: 'application',
    'aria-label': '自由画布：拖动空白处平移，滚轮缩放，右键或按 Q 呼出工具盘',
  })
  const world = h('div', { class: 'mb-canvas-world', id: 'mb-canvas-world' })
  const shapeLayer = svg('g', { class: 'mb-canvas-shapes' })
  const inkLayer = svg('g', { class: 'mb-canvas-ink' })
  const vectors = svg('g', {})
  vectors.append(shapeLayer, inkLayer)
  const clip = svg('clipPath', { id: 'mb-canvas-paper-clip', clipPathUnits: 'userSpaceOnUse' })
  const vectorLayer = svg('svg', { class: 'mb-canvas-vectors', preserveAspectRatio: 'none', 'aria-hidden': 'true' })
  const defs = svg('defs', {})
  defs.append(clip)
  vectorLayer.append(defs, vectors)
  const paperLayer = h('div', { class: 'mb-canvas-paper-layer', hidden: true, 'aria-hidden': 'true' })
  const hint = h('div', { class: 'mb-canvas-hint', id: 'mb-canvas-hint' })
  const marquee = h('div', { class: 'mb-canvas-marquee', hidden: true, 'aria-hidden': 'true' })
  surface.append(paperLayer, world, vectorLayer, hint, marquee)
  const cursor = createDrawingCursor(surface)
  const ink = createCanvasInk({ surface, layer: inkLayer, h, icon, current: () => current(), setView: view => setView(view), commit: commitInk, notify,
    onCursorChange: () => { paintDrawingCursor(); paintQuickPalette() },
    onToolChange: enabled => {
      shell.classList.toggle('canvas-inking', enabled)
      if (enabled) { setTextPlacement(false); setShapeTool(null); setBoxTool(false) }
    }, allowsPoint })
  const textButton = h('button', { type: 'button', class: 'mb-canvas-tool', id: 'mb-canvas-text',
    title: '在白板上添加文字 · T', 'aria-label': '添加文字', 'aria-pressed': 'false',
    onClick: () => setTextPlacement(!placingText) }, icon('board-text'))
  const paperButton = h('button', { type: 'button', class: 'mb-canvas-tool', id: 'mb-canvas-paper',
    title: '切换 A4 纸模式', 'aria-label': '切换 A4 纸模式', 'aria-pressed': 'false', onClick: togglePaper }, icon('board-paper'))
  const shapeButton = h('button', { type: 'button', class: 'mb-canvas-tool', id: 'mb-canvas-shape',
    title: '绘制图形 · Esc 退出', 'aria-label': '绘制图形', 'aria-pressed': 'false', 'aria-controls': 'mb-canvas-shape-picker',
    onClick: () => setShapeTool(shapeTool ? null : preferredShape),
  }, icon('board-shapes'))
  const shapeTools = Object.entries(SHAPE_KINDS).map(([kind, label]) => h('button', {
    type: 'button', class: 'mb-canvas-icon', title: label, 'aria-label': label, 'aria-pressed': 'false', 'data-shape-tool': kind,
    onClick: () => setShapeTool(kind),
  }, icon(`shape-${kind}`)))
  const shapeColorInput = h('input', { type: 'color', class: 'mb-canvas-shape-color', id: 'mb-canvas-shape-color',
    'aria-label': '图形颜色', onChange: event => changeShapeColor(event.target.value) })
  const shapePicker = h('div', { class: 'mb-canvas-shape-picker', id: 'mb-canvas-shape-picker', hidden: true,
    role: 'toolbar', 'aria-label': '图形工具', 'data-glass-surface': 'float',
  }, shapeTools, shapeColorInput)
  const exportButton = h('button', { type: 'button', class: 'mb-canvas-icon', id: 'mb-canvas-export',
    title: '导出 A4（PDF、PNG、JPG）', 'aria-label': '导出 A4', disabled: true, onClick: chooseExport }, icon('board-share'))

  const bar = h('div', { class: 'mb-canvas-bar', id: 'mb-canvas-bar' },
    h('div', {class:'mb-canvas-title-group', 'data-glass-surface':'float'},
      h('button', { type: 'button', class: 'mb-canvas-icon mb-canvas-back', id: 'mb-canvas-back', title: '回到笔记列表（Esc）', 'aria-label':'回到笔记', onClick: () => void close() }, icon('chevron-right')),
      picker),
    h('div', {class:'mb-canvas-actions', 'data-glass-surface':'float'},
    undoButton, redoButton, exportButton,
    h('button', { type: 'button', class: 'mb-canvas-icon', id: 'mb-canvas-new', title: '新建画布', 'aria-label': '新建画布', onClick: () => void newCanvas() }, icon('board-compose')),
    h('button', { type: 'button', class: 'mb-canvas-icon', id: 'mb-canvas-rename', title: '重命名当前画布', 'aria-label': '重命名当前画布', onClick: () => void renameActive() }, icon('pen')),
    h('button', { type: 'button', class: 'mb-canvas-icon danger', id: 'mb-canvas-delete', title: '删除当前画布（可撤销）', 'aria-label': '删除当前画布', onClick: deleteActive }, icon('board-trash')),
    stateChip))

  const imagePicker = h('input', { type: 'file', hidden: true, multiple: true, id: 'mb-canvas-image-picker',
    accept: 'image/png,image/jpeg,image/webp,image/gif', 'aria-label': '选择要导入的图片', onChange: event => {
      const files = Array.from(event.target.files)
      event.target.value = ''
      void importImages(files)
    } })
  const imageButton = h('button', { type: 'button', class: 'mb-canvas-tool', id: 'mb-canvas-image',
    title: '导入图片', 'aria-label': '导入图片', onClick: () => {
      if (current() && !loadError && !ink.busy() && !drag) imagePicker.click()
    } }, icon('board-image'))
  const tools = h('div', { class: 'mb-canvas-tools', id: 'mb-canvas-tools', role: 'toolbar', 'aria-label': '画布工具', 'data-glass-surface':'float' },
    ink.toggle, textButton, shapeButton,
    h('button', { type: 'button', class: 'mb-canvas-tool', id: 'mb-canvas-reference', title: '引用现有笔记', 'aria-label': '引用笔记', onClick: () => void pickReference() }, icon('board-note')),
    imageButton,
    h('button', { type: 'button', class: 'mb-canvas-tool', id: 'mb-canvas-link', title: '连接选中的两个对象', 'aria-label': '连接对象', onClick: () => linkSelected() }, icon('board-connect')),
    paperButton)
  bar.insertBefore(tools, bar.lastElementChild)

  const zoomControls = h('div', { class: 'mb-canvas-zoom', id: 'mb-canvas-zoom-controls', 'data-glass-surface':'float' },
    h('button', { type: 'button', class: 'mb-canvas-icon', id: 'mb-canvas-zoom-out', title: '缩小', 'aria-label': '缩小', onClick: () => zoomStep(1 / 1.25) }, icon('minus')),
    zoomLabel,
    h('button', { type: 'button', class: 'mb-canvas-icon', id: 'mb-canvas-zoom-in', title: '放大', 'aria-label': '放大', onClick: () => zoomStep(1.25) }, icon('plus')))

  const paperPicker = h('select', { class: 'select', id: 'mb-canvas-paper-picker', 'aria-label': '定位到 A4 页', onChange: event => jumpToPaper(event.target.value) })
  const addSheetButton = h('button', { type: 'button', class: 'mb-canvas-icon', id: 'mb-canvas-paper-add',
    title: '新增 A4 页', 'aria-label': '新增 A4 页', onClick: addSheet }, icon('plus'))
  const paperControls = h('div', { class: 'mb-canvas-paper-controls', id: 'mb-canvas-paper-controls', hidden: true,
    role: 'toolbar', 'aria-label': 'A4 纸张', 'data-glass-surface': 'float' }, paperPicker, addSheetButton,
    h('button', { type: 'button', class: 'mb-canvas-icon danger', id: 'mb-canvas-paper-remove',
      title: '移除当前 A4 页', 'aria-label': '移除当前 A4 页', onClick: removeSheet }, icon('board-trash')))

  const quickPalette = createCanvasQuickPalette({ h, icon,
    selectTool: tool => tool === 'box-select' ? setBoxTool(true) : ink.setTool(tool),
    setColor: color => ink.setBrushStyle({ color }), setWidth: width => ink.setBrushStyle({ width }),
    undo, redo })
  const section = h('section', { class: 'mb-canvas', id: 'mb-canvas', hidden: true, 'aria-label': '自由画布' },
    bar, surface, shapePicker, ink.panel, zoomControls, paperControls, imagePicker, quickPalette.element)
  const footer = host.querySelector('.mb-foot')
  if (footer) host.insertBefore(section, footer); else host.append(section)

  let doc = emptyDocument()
  let placingText = false
  let shapeTool = null
  let boxTool = false
  let selectedBox = null
  let preferredShape = 'arrow'
  let shapeColor = ink.penStyle().color
  let exporting = false
  let loaded = false
  let pendingChanges = false
  // 保存竞态守卫：每次编辑序号 +1，保存成功后只有序号没变才敢清 dirty。
  let pendingRevision = 0
  // 读取失败（通道失败或库里的数据解析失败）时进入可见错误态：
  // 不再自动建画布、不写库，直到用户重试或明确确认重建。
  let loadError = null
  let saveTimer, saving = false, queued = false
  let history = { past: [], future: [] }
  let typing = null
  const selection = { cards: new Set(), edges: new Set(), shape: null }
  const cardNodes = new Map(), edgeNodes = new Map()
  const shapeNodes = new Map()
  let renderedSheets, sheetNodes = [], paperClipPath = ''

  const current = () => activeCanvas(doc)
  const question = createCanvasQuestion({ h, icon, dialog, renderRich, readQuestion, notify, openOriginal: openReference,
    isCurrent: card => !section.hidden && Boolean(current()?.cards.some(row => row.id === card.id && row.noteId === card.noteId)),
    update: (id, display) => !section.hidden && mutate(canvas => canvas.cards.some(card => card.id === id && isQuestion(card))
      ? updateCard(canvas, id, { question: display }) : canvas),
  })
  const surfaceSize = () => {
    const rect = surface.getBoundingClientRect()
    return { w: Math.max(rect.width, 320), h: Math.max(rect.height, 240) }
  }
  const setSaveState = (text, error = false) => {
    stateChip.textContent = text
    stateChip.classList.toggle('failed', error)
    stateChip.classList.toggle('busy', text === '正在保存…')
  }
  const markDirty = () => {
    if (loadError) return
    pendingRevision += 1
    pendingChanges = true
    setSaveState('未保存')
    saveSoon()
  }

  // —— 持久化：整份文档写回笔记本域；失败可见、内存修改保留、下次改动重试 ——
  const saveSoon = () => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => void flush(), 420)
  }
  async function flush() {
    clearTimeout(saveTimer)
    if (loadError) return
    if (saving) { queued = true; return }
    if (!pendingChanges) return
    saving = true
    let rounds = 0
    try {
      // 保存期间可能又有编辑：版本号变了就保持 dirty 并在同一轮 flush 里再写一次，
      // 不能把「保存中到达的编辑」当成已保存（那会让 close 的 flush 直接返回而丢内容）。
      while (pendingChanges) {
        if (++rounds > 5) { queued = true; break }
        const at = pendingRevision
        setSaveState('正在保存…')
        await call('save', { docs: normalizeDocument(doc) })
        if (pendingRevision === at) {
          pendingChanges = false
          setSaveState('已保存')
        }
      }
    } catch (error) {
      setSaveState('保存失败 · 点击重试', true)
      notify(`画布保存失败：${error?.message || error}`, true)
    } finally {
      saving = false
      if (queued) { queued = false; saveSoon() }
    }
  }
  stateChip.addEventListener('click', () => void (loadError ? retryLoad() : flush()))
  // 关窗或切到后台时先把待写入的改动推上去：别让 420ms 的防抖吞掉最后几下拖动。
  window.addEventListener('pagehide', () => { if (pendingChanges) void flush() })
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && pendingChanges) void flush() })

  // —— 视口 ——
  const paintPaper = (paper, view) => {
    const on = Boolean(paper?.enabled)
    paperLayer.hidden = paperControls.hidden = !on
    paperButton.setAttribute('aria-pressed', String(on))
    exportButton.disabled = !on || exporting
    surface.classList.toggle('paper-mode', on)
    if (!on || !view) {
      world.style.clipPath = ''
      vectors.removeAttribute('clip-path')
      return
    }
    const { sheets, activeId } = paper
    if (renderedSheets !== sheets) {
      renderedSheets = sheets
      sheetNodes = sheets.map(({ id }) => h('div', { class: 'mb-canvas-sheet', 'data-sheet-id': id }))
      paperLayer.replaceChildren(...sheetNodes)
      paperPicker.replaceChildren(...sheets.map(({ id }, index) => h('option', { value: id, text: `第 ${index + 1} 页 / ${sheets.length}` })))
      clip.replaceChildren(...sheets.map(({ x, y }) => svg('rect', { x, y, width: A4_SIZE.w, height: A4_SIZE.h })))
      paperClipPath = `path("${sheets.map(({ x, y }) => `M${x} ${y}H${x + A4_SIZE.w}V${y + A4_SIZE.h}H${x}Z`).join(' ')}")`
    }
    if (paperPicker.value !== activeId) paperPicker.value = activeId
    addSheetButton.disabled = sheets.length >= CANVAS_LIMITS.sheets
    world.style.clipPath = paperClipPath
    vectors.setAttribute('clip-path', 'url(#mb-canvas-paper-clip)')
    for (const [index, sheet] of sheets.entries()) {
      const node = sheetNodes[index]
      node.classList.toggle('active', sheet.id === activeId)
      node.style.left = `${view.x + sheet.x * view.scale}px`
      node.style.top = `${view.y + sheet.y * view.scale}px`
      node.style.width = `${A4_SIZE.w * view.scale}px`
      node.style.height = `${A4_SIZE.h * view.scale}px`
      node.style.setProperty('--mb-canvas-paper-cell', `${20 * view.scale}px`)
    }
  }
  const paintView = () => {
    const canvas = current()
    paintPaper(canvas?.paper, canvas?.view)
    paintDrawingCursor()
    paintMarquee()
    if (!canvas) return
    const { x: offsetX, y: offsetY, scale } = canvas.view
    const { width, height } = surface.getBoundingClientRect()
    // SVG gets a screen-sized viewport and rasterizes the paths at the active scale.
    if (width > 0 && height > 0) vectorLayer.setAttribute('viewBox', `${-offsetX / scale} ${-offsetY / scale} ${width / scale} ${height / scale}`)
    world.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`
    const cell = 26 * scale
    surface.style.setProperty('--mb-canvas-cell', `${cell}px`)
    surface.style.setProperty('--mb-canvas-x', `${offsetX % cell}px`)
    surface.style.setProperty('--mb-canvas-y', `${offsetY % cell}px`)
    zoomLabel.textContent = `${round(scale * 100)}%`
  }
  new ResizeObserver(() => { if (!section.hidden) paintView() }).observe(surface)
  const setView = next => {
    const canvas = current()
    if (!canvas) return
    canvas.view = normalizeView(next)
    paintView()
    markDirty()
  }
  const viewportCenter = () => { const size = surfaceSize(); return { x: size.w / 2, y: size.h / 2 } }
  const worldCenter = () => screenToWorld(current()?.view ?? defaultView(), viewportCenter())
  const zoomStep = factor => {
    const canvas = current()
    if (!canvas || ink.busy()) return
    setView(zoomAt(canvas.view, viewportCenter(), canvas.view.scale * factor))
  }
  function allowsPoint(point) {
    const paper = current()?.paper
    return !paper?.enabled || paper.sheets.some(sheet => point.x >= sheet.x && point.x <= sheet.x + A4_SIZE.w
      && point.y >= sheet.y && point.y <= sheet.y + A4_SIZE.h)
  }
  function withPaper(canvas, paper, focus) {
    const sheet = activePaperSheet(paper)
    if (!focus || !sheet) return { ...canvas, paper, updatedAt: new Date().toISOString() }
    const size = surfaceSize()
    const top = size.w < 1040 ? 140 : 100
    const bottom = size.w <= 850 ? 166 : 104
    const view = fitView({ ...sheet, ...A4_SIZE }, { w: size.w - 64, h: size.h - top - bottom }, 0)
    view.x += 32
    view.y += top
    return { ...canvas, paper, view, updatedAt: new Date().toISOString() }
  }
  function togglePaper() {
    if (ink.busy() || drag) return
    mutate(canvas => {
      if (canvas.paper) {
        const paper = { ...canvas.paper, enabled: !canvas.paper.enabled }
        return withPaper(canvas, paper, paper.enabled)
      }
      const bounds = contentBounds([...canvas.cards, ...canvas.ink.map(inkBounds), ...canvas.shapes.map(shapeBounds)], 32)
      return withPaper(canvas, addPaperSheet(null, { x: coord(bounds?.x ?? 0), y: coord(bounds?.y ?? 0) }), true)
    })
  }
  function addSheet() {
    if (ink.busy() || drag || !current()?.paper?.enabled) return
    try {
      mutate(canvas => {
        const sheets = canvas.paper.sheets
        const x = sheets[0].x
        const gap = A4_SIZE.h + 48
        const below = Math.max(...sheets.map(sheet => sheet.y)) + gap
        const y = below <= CANVAS_LIMITS.coordinate ? below : Math.min(...sheets.map(sheet => sheet.y)) - gap
        if (y < -CANVAS_LIMITS.coordinate) throw new Error('纸张已超出画布可放置范围')
        return withPaper(canvas, addPaperSheet(canvas.paper, { x, y }), true)
      })
    } catch (error) { notify(error.message, true) }
  }
  function jumpToPaper(id) {
    if (ink.busy() || drag || !current()?.paper?.enabled) { paintView(); return }
    mutate(canvas => withPaper(canvas, selectPaperSheet(canvas.paper, id), true), { history: false })
  }
  function removeSheet() {
    if (ink.busy() || drag || !current()?.paper?.enabled) return
    mutate(canvas => withPaper(canvas, removePaperSheet(canvas.paper, canvas.paper.activeId), true))
  }
  function chooseExport() {
    const canvas = current()
    if (!canvas?.paper?.enabled || exporting) return
    const formats = ['pdf', 'png', 'jpg'].map(format => h('button', {
      type: 'button', class: 'btn', 'data-canvas-export': format, text: format.toUpperCase(),
      onClick: async () => {
        node.close()
        exporting = true
        paintView()
        try {
          const result = await call('export', { format, canvas, sheetId: canvas.paper.activeId })
          if (!result?.canceled) notify(`已导出 A4 · ${format.toUpperCase()}`)
        } catch (error) { notify(error?.message || String(error), true) }
        finally { exporting = false; paintView() }
      },
    }))
    const page = canvas.paper.sheets.findIndex(sheet => sheet.id === canvas.paper.activeId) + 1
    const node = dialog('导出 A4', h('div', { class: 'mb-canvas-dialog' },
      h('p', { class: 'cap', text: `PDF 包含全部 ${canvas.paper.sheets.length} 页，PNG 和 JPG 导出当前第 ${page} 页。` }),
      h('div', { class: 'row' }, ...formats)))
  }

  // —— 选择 ——
  const paintSelection = () => {
    for (const [id, node] of cardNodes) node.classList.toggle('selected', selection.cards.has(id))
    for (const [id, node] of edgeNodes) node.classList.toggle('selected', selection.edges.has(id))
    for (const [id, node] of shapeNodes) node.classList.toggle('selected', selection.shape === id)
    section.classList.toggle('has-selection', Boolean(selectedBox || selection.shape || selection.cards.size || selection.edges.size))
    paintShapeTools()
    paintMarquee()
  }
  const clearSelection = () => {
    if (!selectedBox && !selection.shape && !selection.cards.size && !selection.edges.size) return
    selectedBox = null
    selection.cards.clear(); selection.edges.clear(); selection.shape = null; paintSelection()
  }
  const selectOnly = id => {
    selectedBox = null
    selection.shape = null
    selection.edges.clear()
    selection.cards.clear(); selection.cards.add(id); paintSelection()
  }
  const toggleCard = id => {
    selectedBox = null
    selection.shape = null
    selection.edges.clear()
    if (selection.cards.has(id)) selection.cards.delete(id); else selection.cards.add(id)
    paintSelection()
  }
  const selectEdge = id => {
    selectedBox = null
    selection.shape = null
    selection.cards.clear(); selection.edges.clear(); selection.edges.add(id); paintSelection()
  }
  const selectShape = id => {
    selectedBox = null
    selection.cards.clear(); selection.edges.clear(); selection.shape = id; paintSelection()
  }

  // —— 渲染 ——
  const kindLabelText = card => card.kind === 'reference' ? `引用 · ${noteLabel(card.noteType)}` : kindLabels[card.kind]
  const cardStyle = card => `transform:translate(${card.x}px,${card.y}px);width:${card.w}px;height:${card.h}px;z-index:${card.z}`
  function cardElement(card) {
    const close = h('button', {
      type: 'button', class: 'mb-canvas-card-close', 'aria-label': '删除这张卡片', title: '删除这张卡片（可撤销）',
      onClick: event => { event.stopPropagation(); selectOnly(card.id); removeSelected() },
    }, icon('close'))
    const head = h('div', { class: 'mb-canvas-card-head' },
      card.kind === 'text' ? icon('move') : h('span', { class: 'mb-canvas-kind', text: card.image?.name ?? kindLabelText(card) }),
      card.kind === 'sticky' ? h('button', {
        type: 'button', class: 'mb-canvas-tone', 'data-tone': card.tone, title: '切换便签颜色', 'aria-label': '切换便签颜色',
        onClick: event => { event.stopPropagation(); cycleTone(card.id) },
      }) : null,
      h('span', { class: 'spacer' }), isQuestion(card) ? question.actions(card) : null, close)
    const body = isQuestion(card) ? question.render(card) : card.kind === 'reference'
      ? h('div', { class: 'mb-canvas-ref' },
        h('strong', { class: 'mb-canvas-ref-title', text: card.noteTitle || '未命名笔记' }),
        h('p', { class: 'mb-canvas-ref-stem', text: card.text || '打开笔记查看内容' }),
        h('div', { class: 'mb-canvas-ref-actions' },
          h('button', {
            type: 'button', class: 'mb-canvas-icon mb-canvas-ref-preview', title: '预览全文', 'aria-label': '预览全文',
            onClick: event => { event.stopPropagation(); void showReference(card) },
          }, icon('eye')),
          h('button', {
            type: 'button', class: 'mb-canvas-icon mb-canvas-ref-open', title: '打开笔记', 'aria-label': '打开笔记',
            onClick: event => { event.stopPropagation(); void openReference(card) },
          }, icon('external'))))
      : card.kind === 'image' ? h('img', {
        class: 'mb-canvas-image', src: imageURI(card.image), alt: card.image.name, draggable: 'false', loading: 'lazy', decoding: 'async',
      }) : h('textarea', {
        class: 'mb-canvas-text', rows: 4, maxlength: String(CANVAS_LIMITS.text), spellcheck: 'false',
        placeholder: card.kind === 'sticky' ? '写一张便签…' : '输入文字…', 'aria-label': '白板文字', value: card.text,
        onInput: event => writeText(card.id, event.target.value),
        onBlur: () => endTyping(card.id),
      })
    const node = h('div', {
      class: `mb-canvas-card ${card.kind}${card.kind === 'sticky' ? ` tone-${card.tone}` : ''}`,
      'data-card-id': card.id, 'data-kind': card.kind, 'data-note-type': card.noteType, style: cardStyle(card),
    }, head, body, h('span', { class: 'mb-canvas-resize', 'data-resize': 'true', 'aria-hidden': 'true', title: '拖动调整尺寸' }))
    return node
  }
  function edgeElement(edge) {
    const canvas = current()
    const geometry = canvas ? edgeGeometry(canvas, edge) : null
    if (!geometry) return null
    return h('div', {
      class: 'mb-canvas-edge', 'data-edge-id': edge.id,
      style: `width:${Math.max(round(geometry.length), 1)}px;transform:translate(${round(geometry.x1)}px,${round(geometry.y1)}px) rotate(${geometry.angle}rad)`,
      onClick: event => { event.stopPropagation(); selectEdge(edge.id) },
    })
  }
  function paintEdges() {
    const canvas = current()
    edgeNodes.clear()
    for (const node of world.querySelectorAll('.mb-canvas-edge')) node.remove()
    if (!canvas) return
    const nodes = canvas.edges.map(edge => { const node = edgeElement(edge); if (node) edgeNodes.set(edge.id, node); return node }).filter(Boolean)
    world.prepend(...nodes)
    paintSelection()
  }
  function paintCards() {
    // 重建卡片会销毁正在编辑的 textarea（移除节点不保证触发 blur），所以必须先把
    // 这段输入结算成一条历史；否则下一次 focus 会复用同一份旧快照，一次撤销回退两段。
    settleTyping()
    const canvas = current()
    question.beginRender()
    cardNodes.clear()
    for (const node of world.querySelectorAll('.mb-canvas-card')) node.remove()
    if (!canvas) return
    const nodes = [...canvas.cards].sort((a, b) => a.z - b.z).map(card => { const node = cardElement(card); cardNodes.set(card.id, node); return node })
    world.append(...nodes)
    paintSelection()
  }
  function shapeNode(shape, draft = false) {
    const group = svg('g', { class: `mb-canvas-shape${draft ? ' draft' : ''}`, 'data-shape-id': shape.id,
      'data-shape-kind': shape.kind, fill: 'none', stroke: shape.color, 'stroke-width': shape.width,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round' })
    paintShape(group, shape, draft)
    return group
  }
  function paintShape(group, shape, draft) {
    const parts = shapeParts(shape)
    if (draft) {
      for (const [index, [tag, attributes]] of parts.entries()) {
        const node = group.children[index] ?? group.appendChild(svg(tag, {}))
        for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value))
      }
      while (group.childElementCount > parts.length) group.lastElementChild.remove()
      return
    }
    group.replaceChildren(...parts.flatMap(([tag, attributes]) => {
      const visible = svg(tag, attributes)
      return [svg(tag, { ...attributes, class: 'shape-hit', stroke: 'transparent', 'stroke-width': shape.width + 10 }), visible]
    }))
  }
  function paintShapes() {
    shapeNodes.clear()
    const nodes = (current()?.shapes ?? []).map(shape => {
      const node = shapeNode(shape)
      shapeNodes.set(shape.id, node)
      return node
    })
    shapeLayer.replaceChildren(...nodes)
    paintSelection()
  }
  function paintPicker() {
    picker.replaceChildren(...doc.canvases.map(canvas => h('option', { value: canvas.id, text: `${canvas.title}（${canvas.cards.length}）` })))
    if (doc.activeId) picker.value = doc.activeId
    picker.disabled = Boolean(loadError) || doc.canvases.length === 0
  }
  function paintHint() {
    const canvas = current()
    section.classList.toggle('load-failed', Boolean(loadError))
    if (loadError) {
      hint.hidden = false
      hint.replaceChildren(h('div', { class: 'mb-canvas-hint-card mb-canvas-load-error', id: 'mb-canvas-load-error' },
        h('strong', { text: '画布读取失败' }),
        h('p', { class: 'cap', text: loadError }),
        h('p', { class: 'cap', text: '为避免覆盖原画布，已暂停自动保存。请先重试读取；如果数据确实损坏，可以在确认后重建一张空白画布。' }),
        h('div', { class: 'row mb-canvas-hint-actions' },
          h('button', { type: 'button', class: 'btn primary', id: 'mb-canvas-retry', onClick: () => void retryLoad() }, '重试读取'),
          h('button', { type: 'button', class: 'btn', id: 'mb-canvas-rebuild', onClick: () => void rebuildFromError() }, '重建空白画布'))))
      return
    }
    if (!canvas) {
      hint.hidden = false
      hint.replaceChildren(h('div', { class: 'mb-canvas-hint-card' },
        h('strong', { text: '还没有画布' }),
        h('p', { class: 'cap', text: '画布是一块无限大的版面：文本、便签与现有笔记都能随手摆放，位置按世界坐标保存。' }),
        h('button', { type: 'button', class: 'btn primary', id: 'mb-canvas-hint-new', onClick: () => void newCanvas() }, '新建画布')))
      return
    }
    hint.hidden = true
    hint.replaceChildren()
  }
  function paintHistory() {
    undoButton.disabled = !typing && history.past.length === 0
    redoButton.disabled = Boolean(typing) || history.future.length === 0
    paintQuickPalette()
  }
  function render() {
    paintCards()
    paintEdges()
    paintShapes()
    ink.paint()
    paintView()
    paintPicker()
    paintHistory()
    paintHint()
  }

  // —— 变更 ——
  // 快照共享图片与笔迹，避免拖动、打字时反复序列化大对象。
  const assetKey = (canvas, card) => `${canvas.id}/${card.id}`
  const snapshot = () => ({
    text: JSON.stringify(doc.canvases, (key, value) => key === 'ink' || key === 'image' ? undefined : value),
    activeId: doc.activeId,
    ink: new Map(doc.canvases.map(canvas => [canvas.id, canvas.ink])),
    images: new Map(doc.canvases.flatMap(canvas => canvas.cards.filter(card => card.image).map(card => [assetKey(canvas, card), card.image]))),
  })
  const replaceCanvas = next => { doc = { ...doc, canvases: doc.canvases.map(canvas => canvas.id === next.id ? next : canvas) } }
  function commitInk(strokes) {
    const canvas = current()
    if (!canvas || loadError) return false
    const next = { ...canvas, ink: strokes, updatedAt: new Date().toISOString() }
    try {
      if (strokes.length > canvas.ink.length) checkInkBudget({ canvases: doc.canvases.map(row => row.id === next.id ? next : row) })
    } catch (error) {
      notify(error.message, true)
      return false
    }
    settleTyping()
    const before = snapshot()
    replaceCanvas(next)
    pushHistory(before)
    ink.paint()
    markDirty()
    return true
  }
  const pushHistory = before => {
    history.past.push({ state: before, nextId: doc.activeId })
    if (history.past.length > 60) history.past.shift()
    history.future.length = 0
    paintHistory()
  }
  const mutate = (action, { history: record = true } = {}) => {
    if (loadError) return false
    const canvas = current()
    if (!canvas) return false
    // 任何结构性改动都从「已结算」的状态开始，历史边界才不会把两段输入混在一起。
    settleTyping()
    const before = record ? snapshot() : null
    const next = action(canvas)
    if (!next || next === canvas) return false
    replaceCanvas(next)
    if (record) pushHistory(before)
    render()
    markDirty()
    return true
  }
  const patchCard = (id, patch) => {
    const canvas = current()
    const card = canvas?.cards.find(row => row.id === id)
    if (!card) return
    if (patch.x !== undefined) card.x = clamp(round(patch.x), -CANVAS_LIMITS.coordinate, CANVAS_LIMITS.coordinate)
    if (patch.y !== undefined) card.y = clamp(round(patch.y), -CANVAS_LIMITS.coordinate, CANVAS_LIMITS.coordinate)
    if (patch.w !== undefined) card.w = clamp(round(patch.w), CANVAS_LIMITS.minSize, CANVAS_LIMITS.maxSize)
    if (patch.h !== undefined) card.h = clamp(round(patch.h), CANVAS_LIMITS.minSize, CANVAS_LIMITS.maxSize)
    if (patch.tone !== undefined) card.tone = STICKY_TONES.includes(patch.tone) ? patch.tone : card.tone
    if (patch.text !== undefined) card.text = String(patch.text).slice(0, CANVAS_LIMITS.text)
    markDirty()
  }
  const paintCardBox = id => {
    const card = current()?.cards.find(row => row.id === id), node = cardNodes.get(id)
    if (!card || !node) return
    node.style.transform = `translate(${card.x}px,${card.y}px)`
    node.style.width = `${card.w}px`
    node.style.height = `${card.h}px`
  }
  function writeText(id, value) {
    const canvas = current()
    const card = canvas?.cards.find(row => row.id === id)
    const text = String(value).slice(0, CANVAS_LIMITS.text)
    if (!card || card.text === text) return
    // 输入会话以「写入」为准而不是只靠 focus/blur：卡片会被 render 重建，
    // 重建后不一定有 blur，focus 也不一定再触发。没有会话就从这里开一段新的，
    // 这样撤销永远只回退最近这一段输入。
    if (!typing || typing.id !== id) {
      settleTyping()
      typing = { id, text: card.text, before: snapshot() }
      paintHistory()
    }
    card.text = text
    markDirty()
  }
  function settleTyping() {
    if (typing) endTyping(typing.id)
  }
  function endTyping(id) {
    if (!typing || typing.id !== id) return
    const { text, before } = typing
    typing = null
    if (current()?.cards.find(card => card.id === id)?.text !== text) pushHistory(before)
    else paintHistory()
  }
  function cycleTone(id) {
    const canvas = current()
    const card = canvas?.cards.find(row => row.id === id)
    if (!card) return
    mutate(row => updateCard(row, id, { tone: STICKY_TONES[(STICKY_TONES.indexOf(card.tone) + 1) % STICKY_TONES.length] }))
  }

  // —— 卡片与画布管理 ——
  function setTextPlacement(enabled) {
    if (enabled && !current()) return
    if (enabled && ink.active()) ink.setTool('select')
    if (enabled) { setShapeTool(null); setBoxTool(false) }
    placingText = enabled
    surface.classList.toggle('placing-text', enabled)
    textButton.setAttribute('aria-pressed', String(enabled))
    paintShapeTools()
    if (enabled) surface.focus({ preventScroll: true })
  }
  function paintShapeTools() {
    const selected = current()?.shapes.find(shape => shape.id === selection.shape)
    shapePicker.hidden = ink.active() || placingText || (!shapeTool && !selected)
    shapeButton.setAttribute('aria-pressed', String(Boolean(shapeTool)))
    for (const tool of shapeTools) tool.setAttribute('aria-pressed', String(tool.dataset.shapeTool === shapeTool))
    shapeColorInput.value = shapeTool ? shapeColor : selected?.color ?? shapeColor
    shapeColorInput.title = shapeTool ? '新图形的颜色' : '修改选中图形的颜色'
    shapeColorInput.setAttribute('aria-label', shapeColorInput.title)
  }
  function paintDrawingCursor() {
    const scale = current()?.view.scale
    const style = scale && (ink.cursorStyle(scale) ?? (shapeTool
      ? { color: shapeColor, diameter: Math.max(1, ink.penStyle().width) * scale } : null))
    cursor.setStyle(style)
  }
  function paintQuickPalette() {
    const brush = ink.brushSettings()
    quickPalette.update({ ...brush, tool: boxTool ? 'box-select' : brush.tool, canUndo: !undoButton.disabled, canRedo: !redoButton.disabled })
  }
  function openQuickPalette(point) {
    if (!current() || loadError || drag || ink.busy()) return
    paintQuickPalette()
    quickPalette.open(point ?? cursor.position() ?? viewportCenter())
  }
  function changeShapeColor(color) {
    if (shapeTool) { shapeColor = color; paintDrawingCursor(); return }
    mutate(canvas => {
      const selected = canvas.shapes.find(shape => shape.id === selection.shape)
      if (!selected || selected.color === color) return canvas
      return { ...canvas, shapes: canvas.shapes.map(shape => shape === selected ? { ...shape, color } : shape), updatedAt: new Date().toISOString() }
    })
  }
  function setShapeTool(kind) {
    cancelShapeDrag()
    if (kind) {
      if (!current() || loadError || drag) return
      if (ink.active()) ink.setTool('select')
      setBoxTool(false)
      setTextPlacement(false)
      preferredShape = kind
      surface.focus({ preventScroll: true })
    }
    shapeTool = kind
    surface.classList.toggle('drawing-shape', Boolean(kind))
    paintShapeTools()
    paintDrawingCursor()
  }
  function setBoxTool(enabled) {
    if (boxTool === enabled || (enabled && (!current() || loadError || drag))) return
    cancelBoxDrag()
    boxTool = enabled
    if (enabled) {
      if (ink.active()) ink.setTool('select')
      setShapeTool(null)
      setTextPlacement(false)
      surface.focus({ preventScroll: true })
    }
    clearSelection()
    surface.classList.toggle('box-tool', enabled)
    paintQuickPalette()
  }
  function addText(point) {
    const canvas = current()
    if (!canvas || loadError || !allowsPoint(point)) return
    const card = { kind: 'text', x: point.x - 3, y: point.y - 4, ...DEFAULT_SIZES.text, text: '' }
    try {
      if (!mutate(row => addCard(row, card))) return
    } catch (error) {
      notify(error?.message || String(error), true)
      return
    }
    const added = current()?.cards.at(-1)
    if (added) {
      selectOnly(added.id)
      const node = cardNodes.get(added.id)
      node?.querySelector('textarea')?.focus()
    }
  }
  async function pickReference() {
    setTextPlacement(false)
    setShapeTool(null)
    if (loadError) { notify('画布读取失败：请先重试读取，再引用笔记', true); return }
    const canvas = current()
    if (!canvas) return
    let rows
    try { rows = await notes() } catch (error) { notify(error?.message || String(error), true); return }
    const search = h('input', { class: 'input', id: 'mb-canvas-note-search', placeholder: '搜索笔记标题、题干或单词', autocomplete: 'off' })
    const results = h('div', { class: 'mb-canvas-note-list', id: 'mb-canvas-note-list' })
    const title = row => row.title || row.vocabulary?.word || row.stem?.split('\n')[0]?.slice(0, 40) || '未命名笔记'
    const snippet = row => (row.type === 'vocabulary' ? row.vocabulary?.meaning : row.stem || row.physics?.object || row.method?.prerequisites || '')?.replace(/\s+/g, ' ').slice(0, 120) ?? ''
    const paint = () => {
      const term = search.value.trim().toLocaleLowerCase()
      const matched = rows.filter(row => !term || `${row.title} ${row.stem} ${row.vocabulary?.word ?? ''} ${row.tags?.join(' ') ?? ''}`.toLocaleLowerCase().includes(term)).slice(0, 80)
      results.replaceChildren(...(matched.length
        ? matched.map(row => h('button', {
          type: 'button', class: 'mb-canvas-note-row', 'data-note-pick': row.id,
          onClick: () => { node.close(); addReference(row) },
        }, h('span', { class: `mb-type-label ${row.type}`, text: NOTE_TYPES[row.type]?.label ?? '笔记' }), h('strong', { text: title(row) }), h('span', { class: 'cap', text: snippet(row) })))
        : [h('p', { class: 'cap', text: '没有找到笔记：先在笔记本里记一条，再回来引用。' })]))
    }
    search.addEventListener('input', paint)
    const node = dialog('引用现有笔记', h('div', { class: 'mb-canvas-picker' }, search, results), true)
    paint()
    setTimeout(() => search.focus(), 0)
    function addReference(row) {
      const canvas = current()
      if (!canvas) return
      const size = row.type === 'mistake' ? { w: 460, h: 420 } : DEFAULT_SIZES.reference
      const spot = placeCard(canvas, size)
      try {
        mutate(target => addCard(target, {
          kind: 'reference', x: spot.x, y: spot.y, w: size.w, h: size.h,
          noteId: row.id, noteType: row.type, noteTitle: title(row), text: snippet(row),
        }))
      } catch (error) {
        notify(error?.message || String(error), true)
        return
      }
      notify(`已引用「${title(row)}」`)
    }
  }
  function placeCard(canvas, size) {
    const spot = placement(canvas.cards, size, worldCenter())
    if (canvas.paper?.enabled) {
      const page = activePaperSheet(canvas.paper)
      const margin = 16
      spot.x = clamp(spot.x, page.x + margin, page.x + A4_SIZE.w - size.w - margin)
      spot.y = clamp(spot.y, page.y + margin, page.y + A4_SIZE.h - size.h - margin)
    }
    return spot
  }
  async function importImages(files) {
    const canvas = current()
    if (!files.length || !canvas || loadError || imageButton.disabled) return
    imageButton.disabled = true
    try {
      if (files.length > CANVAS_IMAGE_LIMITS.batch) throw new Error(`一次最多导入 ${CANVAS_IMAGE_LIMITS.batch} 张图片`)
      if (files.reduce((total, file) => total + file.size, 0) > CANVAS_IMAGE_LIMITS.total) throw new Error('单批图片不能超过 20 MB')
      const images = []
      for (const file of files) images.push(await readImage(file))
      if (section.hidden || current()?.id !== canvas.id || ink.busy() || drag) throw new Error('画布状态已变化，请重新导入图片')
      ink.setTool('select')
      setTextPlacement(false)
      setShapeTool(null)
      setBoxTool(false)
      if (!mutate(row => {
        let next = row
        for (const image of images) {
          const scale = Math.min(DEFAULT_SIZES.image.w / image.width, DEFAULT_SIZES.image.h / image.height, 1)
          const size = { w: Math.max(CANVAS_LIMITS.minSize, round(image.width * scale)), h: Math.max(CANVAS_LIMITS.minSize, round(image.height * scale)) }
          next = addCard(next, { kind: 'image', image, ...size, ...placeCard(next, size) })
        }
        checkCanvasImageBudget(doc.canvases.map(item => item.id === next.id ? next : item))
        return next
      })) return
      selectOnly(current().cards.at(-1).id)
      notify(`已导入 ${images.length} 张图片`)
    } catch (error) {
      notify(error?.message || '无法导入图片', true)
    } finally {
      imageButton.disabled = false
    }
  }
  async function openReference(card) {
    if (!card.noteId) { notify('这张卡片没有关联笔记', true); return }
    await flush()
    try { await openNote(card.noteId) } catch (error) { notify(error?.message || String(error), true) }
  }
  async function showReference(card) {
    if (!card.noteId) { notify('这张卡片没有关联笔记', true); return }
    try { await previewNote(card.noteId) } catch (error) { notify(error?.message || String(error), true) }
  }
  function removeSelected() {
    if (ink.busy() || drag) return
    const box = selectedBox
    const cards = [...(box?.cards ?? selection.cards)], edges = [...selection.edges], shapeId = selection.shape
    if (!box && !cards.length && !edges.length && !shapeId) return
    if (mutate(canvas => {
      let next = cards.length ? removeCards(canvas, cards) : canvas
      for (const id of edges) next = removeEdge(next, id)
      if (box || shapeId) next = { ...next,
        shapes: next.shapes.filter(shape => shape.id !== shapeId && !box?.shapes.has(shape.id)),
        ink: box ? next.ink.filter(stroke => !box.ink.has(stroke.id)) : next.ink, updatedAt: new Date().toISOString() }
      return next
    })) clearSelection()
  }
  function linkSelected() {
    const ids = [...selection.cards]
    if (ids.length !== 2) { notify('先选中两张卡片（Shift 点选），再连接', true); return }
    const canvas = current()
    if (!canvas) return
    try {
      mutate(row => linkCards(row, ids[0], ids[1]))
      selection.edges.clear()
      paintSelection()
      notify('两张卡片已连线')
    } catch (error) { notify(error?.message || String(error), true) }
  }
  function undo() { travelHistory(history.past, history.future) }
  function redo() { travelHistory(history.future, history.past) }
  function travelHistory(from, to) {
    ink.cancel()
    cancelShapeDrag()
    cancelBoxDrag()
    if (drag || loadError) return
    settleTyping()
    const entry = from.pop()
    if (!entry) return
    const boardId = doc.activeId
    const field = document.activeElement?.matches('.mb-canvas-text') ? document.activeElement : null
    const cardId = field?.closest('[data-card-id]')?.dataset.cardId
    to.push({ state: { ...snapshot(), activeId: entry.nextId }, nextId: entry.state.activeId })
    applySnapshot(entry.state)
    if (cardId && doc.activeId === boardId) {
      const restored = cardNodes.get(cardId)?.querySelector('.mb-canvas-text')
      restored?.focus({ preventScroll: true })
      restored?.setSelectionRange(field.selectionStart, field.selectionEnd)
    }
  }
  function applySnapshot({ text, activeId, ink: strokes, images }) {
    doc = { ...doc, activeId, canvases: JSON.parse(text).map(canvas => ({
      ...canvas, ink: strokes.get(canvas.id) ?? [],
      cards: canvas.cards.map(card => card.kind === 'image' ? { ...card, image: images.get(assetKey(canvas, card)) } : card),
    })) }
    clearSelection()
    render()
    markDirty()
  }

  // —— 画布管理 ——
  const askTitle = (heading, value, label, id) => new Promise(resolve => {
    const input = h('input', { class: 'input', id, value, maxlength: String(CANVAS_LIMITS.title), placeholder: '画布名称', autocomplete: 'off' })
    let settled = false
    const settle = text => { if (settled) return; settled = true; node.close(); resolve(text) }
    const node = dialog(heading, h('div', { class: 'mb-canvas-dialog' },
      h('label', { class: 'col' }, h('span', { class: 'label', text: '画布名称' }), input),
      h('div', { class: 'row' }, h('span', { class: 'spacer' }),
        h('button', { type: 'button', class: 'btn primary', id: 'mb-canvas-title-save', onClick: () => settle(input.value) }, label))))
    node.addEventListener('close', () => { if (!settled) { settled = true; resolve(null) } })
    input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); settle(input.value) } })
    setTimeout(() => { input.focus(); input.select() }, 0)
  })
  async function newCanvas() {
    if (loadError) { notify('画布读取失败：请先重试读取，再新建画布', true); return }
    if (ink.busy() || drag) return
    const title = await askTitle('新建画布', '', '创建', 'mb-canvas-title-input')
    if (title === null) return
    let created
    try { created = createCanvas(doc, title) } catch (error) { notify(error?.message || String(error), true); return }
    ink.cancel()
    setShapeTool(null)
    setBoxTool(false)
    settleTyping()
    const before = snapshot()
    doc = created.document
    pushHistory(before)
    render()
    markDirty()
    notify(`已新建画布「${created.canvas.title}」`)
  }
  async function renameActive() {
    const canvas = current()
    if (!canvas || ink.busy() || drag) return
    const title = await askTitle('重命名画布', canvas.title, '保存', 'mb-canvas-title-input')
    if (title === null || (title.trim() || '未命名画布') === canvas.title || current()?.id !== canvas.id) return
    settleTyping()
    const before = snapshot()
    doc = renameCanvas(doc, canvas.id, title)
    pushHistory(before)
    render()
    markDirty()
    notify('画布已重命名')
  }
  function deleteActive() {
    const canvas = current()
    if (!canvas || ink.busy() || drag) return
    setTextPlacement(false)
    setShapeTool(null)
    setBoxTool(false)
    settleTyping()
    const before = snapshot()
    const result = deleteCanvas(doc, canvas.id)
    doc = result.document.canvases.length ? result.document : createCanvas(result.document, '').document
    pushHistory(before)
    clearSelection()
    render()
    markDirty()
  }
  const switchCanvas = id => {
    if (!canvasById(doc, id)) return
    if (id === doc.activeId) return
    if (drag) { picker.value = doc.activeId; return }
    quickPalette.close()
    ink.cancel()
    setTextPlacement(false)
    setShapeTool(null)
    setBoxTool(false)
    settleTyping()
    doc = { ...doc, activeId: id }
    clearSelection()
    render()
    markDirty()
  }
  picker.addEventListener('change', () => switchCanvas(picker.value))

  // —— 指针交互：1:1 跟手，指针捕获，拖完才记一步撤销 ——
  let drag = null
  let spaceHeld = false
  const capture = id => { try { surface.setPointerCapture(id) } catch { /* 合成事件没有活动指针 */ } }
  const release = id => { try { surface.releasePointerCapture(id) } catch { /* 已经释放 */ } }
  function cancelShapeDrag() {
    if (drag?.mode !== 'draw-shape' && drag?.mode !== 'move-shape') return
    const canceled = drag
    drag = null
    surface.classList.remove('shape-stroking')
    if (canceled.mode === 'draw-shape') canceled.node.remove()
    else canceled.node.removeAttribute('transform')
    release(canceled.pointerId)
  }
  function rectBetween(first, last) {
    return { x: Math.min(first.x, last.x), y: Math.min(first.y, last.y), w: Math.abs(first.x - last.x), h: Math.abs(first.y - last.y) }
  }
  function paintMarquee() {
    const view = current()?.view
    const draft = drag?.mode === 'box-select'
    let rect = draft ? rectBetween(drag.start, drag.end) : null
    if (!draft && selectedBox?.bounds && view) {
      const { x, y, w, h } = selectedBox.bounds
      const { dx, dy } = drag?.mode === 'box-move' ? drag : { dx: 0, dy: 0 }
      rect = { x: view.x + (x + dx) * view.scale, y: view.y + (y + dy) * view.scale, w: w * view.scale, h: h * view.scale }
    }
    marquee.hidden = !rect
    if (!rect) return
    marquee.classList.toggle('settled', !draft)
    marquee.style.transform = `translate(${rect.x}px,${rect.y}px)`
    marquee.style.width = `${rect.w}px`
    marquee.style.height = `${rect.h}px`
  }
  function startBoxDrag(event, canvas, start, point) {
    event.preventDefault()
    surface.focus({ preventScroll: true })
    capture(event.pointerId)
    const base = { pointerId: event.pointerId, start }
    const box = selectedBox
    const bounds = box?.bounds
    const slop = 5 / canvas.view.scale
    if (bounds && point.x >= bounds.x - slop && point.x <= bounds.x + bounds.w + slop
      && point.y >= bounds.y - slop && point.y <= bounds.y + bounds.h + slop) {
      const cards = [...box.cards].map(id => cardNodes.get(id)).filter(Boolean).map(node => [node, node.style.transform])
      const vectors = [...[...box.shapes].map(id => shapeNodes.get(id)),
        ...Array.from(inkLayer.children).filter(node => box.ink.has(node.getAttribute('data-stroke-id')))].filter(Boolean)
      const edges = canvas.edges.filter(edge => box.cards.has(edge.from) || box.cards.has(edge.to)).flatMap(edge => {
        const node = edgeNodes.get(edge.id), geometry = edgeGeometry(canvas, edge)
        return node && geometry ? [{ node, geometry, fromMoves: box.cards.has(edge.from), toMoves: box.cards.has(edge.to) }] : []
      })
      drag = { ...base, mode: 'box-move', box, cards, vectors, edges, dx: 0, dy: 0 }
      surface.classList.add('box-moving')
    } else {
      clearSelection()
      drag = { ...base, mode: 'box-select', end: start }
    }
    paintMarquee()
  }
  function paintBoxMove(gesture, dx, dy) {
    const moved = dx || dy
    for (const [node, transform] of gesture.cards) node.style.transform = moved ? `${transform} translate(${dx}px,${dy}px)` : transform
    for (const node of gesture.vectors) {
      if (moved) node.setAttribute('transform', `translate(${dx} ${dy})`)
      else node.removeAttribute('transform')
    }
    for (const { node, geometry, fromMoves, toMoves } of gesture.edges) {
      const x1 = geometry.x1 + (fromMoves ? dx : 0), y1 = geometry.y1 + (fromMoves ? dy : 0)
      const x2 = geometry.x2 + (toMoves ? dx : 0), y2 = geometry.y2 + (toMoves ? dy : 0)
      node.style.width = `${Math.max(round(Math.hypot(x2 - x1, y2 - y1)), 1)}px`
      node.style.transform = `translate(${round(x1)}px,${round(y1)}px) rotate(${Math.atan2(y2 - y1, x2 - x1)}rad)`
    }
  }
  function cancelBoxDrag() {
    if (drag?.mode !== 'box-select' && drag?.mode !== 'box-move') return
    const canceled = drag
    drag = null
    surface.classList.remove('box-moving')
    if (canceled.mode === 'box-move') paintBoxMove(canceled, 0, 0)
    paintMarquee()
    release(canceled.pointerId)
  }
  const localPoint = event => {
    const rect = surface.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }
  surface.addEventListener('pointerdown', event => {
    if (drag || ink.pointerDown(event, spaceHeld)) return
    if (event.button !== 0 && event.button !== 1) return
    const canvas = current()
    if (!canvas) return
    if (event.target.closest('.mb-canvas-hint')) return
    const panOnly = event.button === 1 || spaceHeld
    const start = localPoint(event)
    const point = screenToWorld(canvas.view, start)
    if (boxTool && !panOnly) { startBoxDrag(event, canvas, start, point); return }
    if (shapeTool && !panOnly) {
      event.preventDefault()
      if (!allowsPoint(point)) { notify('请在 A4 纸内绘制图形'); return }
      if (canvas.shapes.length >= SHAPE_LIMIT) { notify(`每张画布最多 ${SHAPE_LIMIT} 个图形`, true); return }
      const { x, y } = point
      const { width } = ink.penStyle()
      const shape = { id: globalThis.crypto.randomUUID(), kind: shapeTool, color: shapeColor, width: Math.max(1, width),
        x1: shapeCoord(x), y1: shapeCoord(y), x2: shapeCoord(x), y2: shapeCoord(y) }
      const node = shapeNode(shape, true)
      shapeLayer.append(node)
      capture(event.pointerId)
      drag = { mode: 'draw-shape', pointerId: event.pointerId, start, shape, node }
      surface.classList.add('shape-stroking')
      return
    }
    if (placingText && event.button === 0 && !spaceHeld) {
      event.preventDefault()
      setTextPlacement(false)
      addText(point)
      return
    }
    const cardNode = event.target.closest('.mb-canvas-card')
    const edgeNode = event.target.closest('.mb-canvas-edge')
    const figure = event.target.closest('.mb-canvas-shape')
    if (figure && !panOnly && !shapeTool) {
      const shape = canvas.shapes.find(row => row.id === figure.dataset.shapeId)
      if (!shape) return
      event.preventDefault()
      surface.focus({ preventScroll: true })
      selectShape(shape.id)
      capture(event.pointerId)
      drag = { mode: 'move-shape', pointerId: event.pointerId, start, shape, node: figure, dx: 0, dy: 0 }
      return
    }
    if (cardNode && !panOnly) {
      const card = canvas.cards.find(row => row.id === cardNode.dataset.cardId)
      if (!card) return
      if (event.target.closest('.mb-canvas-resize')) {
        event.preventDefault()
        capture(event.pointerId)
        selectOnly(card.id)
        drag = { mode: 'resize', pointerId: event.pointerId, cardId: card.id, start: localPoint(event), origin: { w: card.w, h: card.h }, before: snapshot() }
        surface.classList.add('dragging')
        return
      }
      if (event.target.closest(`textarea, input, select, button, ${questionViewport}`)) {
        if (!selection.cards.has(card.id)) selectOnly(card.id)
        return
      }
      event.preventDefault()
      const wasSelected = selection.cards.has(card.id)
      // Shift 点已选中的卡片是反选：只改选择，不能顺手把它拖走。
      if (event.shiftKey && wasSelected) {
        toggleCard(card.id)
        return
      }
      capture(event.pointerId)
      if (!wasSelected) {
        if (event.shiftKey) toggleCard(card.id); else selectOnly(card.id)
      }
      const ids = [...selection.cards].filter(id => canvas.cards.some(item => item.id === id))
      const origins = new Map(ids.map(id => [id, (() => { const row = canvas.cards.find(item => item.id === id); return { x: row.x, y: row.y } })()]))
      drag = { mode: 'move', pointerId: event.pointerId, ids, origins, start: localPoint(event), before: snapshot(), moved: false }
      surface.classList.add('dragging')
      return
    }
    if (edgeNode && !panOnly) { selectEdge(edgeNode.dataset.edgeId); return }
    event.preventDefault()
    capture(event.pointerId)
    drag = { mode: 'pan', pointerId: event.pointerId, start: localPoint(event), origin: { ...canvas.view } }
    if (!event.shiftKey) clearSelection()
    surface.classList.add('panning')
  })
  surface.addEventListener('pointermove', event => {
    if (ink.pointerMove(event)) return
    if (!drag || event.pointerId !== drag.pointerId) return
    // 指针在窗口外释放、捕获丢失时 buttons 会归零：结束拖动，别让卡片粘在指针上。
    if (event.pointerType === 'mouse' && event.buttons === 0) { endDrag(event); return }
    const canvas = current()
    if (!canvas) return
    const point = localPoint(event)
    const dx = point.x - drag.start.x, dy = point.y - drag.start.y
    if (drag.mode === 'pan') {
      const next = panBy(drag.origin, dx, dy)
      canvas.view = normalizeView(next)
      paintView()
      return
    }
    const scale = canvas.view.scale
    if (drag.mode === 'box-select') {
      drag.end = point
      paintMarquee()
      return
    }
    if (drag.mode === 'box-move') {
      const offset = boxDelta(drag.box, dx / scale, dy / scale)
      Object.assign(drag, offset)
      paintBoxMove(drag, offset.dx, offset.dy)
      paintMarquee()
      return
    }
    if (drag.mode === 'draw-shape') {
      const worldPoint = screenToWorld(canvas.view, point)
      drag.shape.x2 = shapeCoord(worldPoint.x)
      drag.shape.y2 = shapeCoord(worldPoint.y)
      paintShape(drag.node, drag.shape, true)
      return
    }
    if (drag.mode === 'move-shape') {
      drag.dx = inkCoordinate(dx / scale)
      drag.dy = inkCoordinate(dy / scale)
      drag.node.setAttribute('transform', `translate(${drag.dx} ${drag.dy})`)
      return
    }
    if (drag.mode === 'move') {
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) drag.moved = true
      for (const [id, origin] of drag.origins) {
        patchCard(id, { x: origin.x + dx / scale, y: origin.y + dy / scale })
        paintCardBox(id)
      }
      paintEdges()
      return
    }
    if (drag.mode === 'resize') {
      drag.moved = true
      patchCard(drag.cardId, { w: drag.origin.w + dx / scale, h: drag.origin.h + dy / scale })
      paintCardBox(drag.cardId)
    }
  })
  const endDrag = event => {
    if (!drag || event.pointerId !== drag.pointerId) return
    const finished = drag
    drag = null
    surface.classList.remove('dragging', 'panning', 'shape-stroking', 'box-moving')
    release(event.pointerId)
    if (finished.mode === 'pan') { markDirty(); return }
    if (finished.mode === 'box-select' || finished.mode === 'box-move') { finishBoxDrag(finished, event); return }
    if (finished.mode === 'draw-shape') {
      finished.node.remove()
      if (event.type === 'pointercancel' || event.type === 'lostpointercapture') return
      const { shape } = finished
      const canvas = current()
      const end = localPoint(event)
      if (Math.hypot(end.x - finished.start.x, end.y - finished.start.y) < 3) return
      const point = screenToWorld(canvas.view, end)
      shape.x2 = shapeCoord(point.x)
      shape.y2 = shapeCoord(point.y)
      mutate(row => ({ ...row, shapes: [...row.shapes, shape], updatedAt: new Date().toISOString() }))
      selectShape(shape.id)
      return
    }
    if (finished.mode === 'move-shape') {
      finished.node.removeAttribute('transform')
      if (event.type === 'pointercancel' || (!finished.dx && !finished.dy)) return
      const { shape, dx, dy } = finished
      const moved = { ...shape, x1: shapeCoord(shape.x1 + dx), x2: shapeCoord(shape.x2 + dx), y1: shapeCoord(shape.y1 + dy), y2: shapeCoord(shape.y2 + dy) }
      mutate(row => ({ ...row, shapes: row.shapes.map(item => item.id === moved.id ? moved : item), updatedAt: new Date().toISOString() }))
      return
    }
    if (finished.mode === 'move' && !finished.moved) return
    pushHistory(finished.before)
    const canvas = current()
    if (canvas) render()
    markDirty()
  }
  function finishBoxDrag(finished, event) {
    const canceled = event.type === 'pointercancel' || event.type === 'lostpointercapture'
    const canvas = current()
    const end = localPoint(event)
    if (finished.mode === 'box-select') {
      const rect = rectBetween(finished.start, end)
      if (!canceled && canvas && rect.w >= 3 && rect.h >= 3) {
        const { scale } = canvas.view
        const origin = screenToWorld(canvas.view, rect)
        const box = findBoxSelection(canvas, { ...origin, w: rect.w / scale, h: rect.h / scale })
        selectedBox = box.bounds ? box : null
      }
      paintSelection()
      return
    }
    paintBoxMove(finished, 0, 0)
    if (!canceled && canvas) {
      const { scale } = canvas.view
      const { dx, dy } = boxDelta(finished.box, (end.x - finished.start.x) / scale, (end.y - finished.start.y) / scale)
      if (dx || dy) {
        const box = finished.box
        const next = moveBoxSelection(canvas, box, dx, dy)
        try {
          if (box.ink.size) checkInkBudget({ canvases: doc.canvases.map(row => row.id === next.id ? next : row) })
        } catch (error) {
          notify(error.message, true)
          paintMarquee()
          return
        }
        selectedBox = offsetBoxSelection(box, dx, dy)
        mutate(() => next)
        return
      }
    }
    paintMarquee()
  }
  function trackCursor(event) {
    if (event.pointerType === 'touch' && !surface.matches('.ink-stroking,.shape-stroking')) return
    cursor.move(event)
  }
  for (const type of ['pointerenter', 'pointerdown', 'pointermove']) surface.addEventListener(type, trackCursor)
  surface.addEventListener('pointerup', event => {
    trackCursor(event)
    if (!ink.finish(event, true)) endDrag(event)
  })
  surface.addEventListener('pointercancel', event => { if (!ink.finish(event, false)) endDrag(event) })
  // 指针捕获被系统收回时也要结束拖动（否则后续 pointermove 仍按旧起点挪卡片）。
  surface.addEventListener('lostpointercapture', event => { if (!ink.finish(event, false) && drag) endDrag(event) })
  surface.addEventListener('wheel', event => {
    const canvas = current()
    if (!canvas) return
    // 指针在卡片文本里且没有 Ctrl/⌘：把滚轮交还给卡片，长文本才能滚动阅读；
    // 其余情况仍然以指针为中心缩放。
    if (event.target.closest?.(`textarea, ${questionViewport}`) && !event.ctrlKey && !event.metaKey) return
    event.preventDefault()
    if (ink.busy() || drag) return
    if (event.shiftKey) {
      setView(panBy(canvas.view, -event.deltaY, 0))
      return
    }
    const rect = surface.getBoundingClientRect()
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top }
    const factor = Math.exp(-event.deltaY * 0.0015)
    setView(zoomAt(canvas.view, point, canvas.view.scale * factor))
  }, { passive: false })
  surface.addEventListener('contextmenu', event => {
    if (event.target.closest('textarea, input, [contenteditable="true"]')) return
    event.preventDefault()
    openQuickPalette(localPoint(event))
  })
  section.addEventListener('pointerdown', event => {
    if (quickPalette.isOpen() && !quickPalette.element.contains(event.target)) quickPalette.close()
  }, true)
  surface.addEventListener('dblclick', event => {
    if (ink.active() || shapeTool || boxTool) return
    const cardNode = event.target.closest('.mb-canvas-card')
    const canvas = current()
    if (!canvas) return
    if (!cardNode && !event.target.closest('.mb-canvas-edge, .mb-canvas-shape, .mb-canvas-hint')) {
      addText(screenToWorld(canvas.view, localPoint(event)))
      return
    }
    const card = canvas.cards.find(row => row.id === cardNode?.dataset.cardId)
    if (card?.kind !== 'reference' || event.target.closest('button')) return
    if (!isQuestion(card)) void showReference(card)
    else if (event.target.closest('.mb-canvas-card-head')) void question.edit(card)
  })

  // 白板的撤销也要接住重建卡片后落到 body 的焦点。独立对话框保留自己的输入历史。
  document.addEventListener('keydown', event => {
    if (section.hidden || event.defaultPrevented || event.isComposing || document.querySelector('dialog[open]')) return
    const key = event.key.toLowerCase()
    const isEditing = event.target.closest?.('textarea, input, select, [contenteditable="true"]')
    const togglePalette = key === 'q' && !event.ctrlKey && !event.metaKey && !event.altKey
      && (!isEditing || quickPalette.element.contains(event.target))
    if (togglePalette || (key === 'escape' && quickPalette.isOpen())) {
      event.preventDefault(); event.stopPropagation()
      if (event.repeat) return
      if (quickPalette.isOpen()) { quickPalette.close(); surface.focus({ preventScroll: true }) }
      else openQuickPalette()
      return
    }
    if (event.altKey || !(event.ctrlKey || event.metaKey) || (key !== 'z' && key !== 'y')) return
    event.preventDefault()
    event.stopPropagation()
    if (key === 'y' || event.shiftKey) redo(); else undo()
  }, true)

  // —— 键盘：画布工具、删除与 Esc ——
  section.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.isComposing) return
    const editing = Boolean(event.target.closest?.('textarea, input, select, [contenteditable="true"]'))
    if (event.key === 'Escape') {
      if (editing) return
      if (placingText) { event.stopPropagation(); setTextPlacement(false); return }
      if (shapeTool) { event.stopPropagation(); setShapeTool(null); return }
      if (boxTool) { event.stopPropagation(); setBoxTool(false); return }
      if (ink.active()) { event.stopPropagation(); ink.setTool('select'); return }
      if (selection.shape || selection.cards.size || selection.edges.size) { event.stopPropagation(); clearSelection(); return }
      event.stopPropagation()
      void close()
      return
    }
    if (editing) return
    if (!event.ctrlKey && !event.metaKey && !event.altKey) {
      if (event.code === 'Space' && event.target === surface) {
        spaceHeld = true
        event.preventDefault()
        return
      }
      const key = event.key.toLowerCase()
      if (key === 'b' && event.shiftKey) {
        event.preventDefault()
        event.stopPropagation()
        if (!event.repeat) ink.toggleTouch()
        return
      }
      const tool = { b: 'pen', h: 'marker', e: 'erase', v: 'select' }[key]
      if (tool && ink.setTool(tool)) {
        if (tool === 'select') { setShapeTool(null); setBoxTool(false) }
        setTextPlacement(false); event.preventDefault(); event.stopPropagation(); return
      }
      if (key === 't') { setTextPlacement(true); event.preventDefault(); event.stopPropagation(); return }
      if (key === 'm') { if (!event.repeat) setBoxTool(!boxTool); event.preventDefault(); event.stopPropagation(); return }
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && (selectedBox || selection.shape || selection.cards.size || selection.edges.size)) {
      event.preventDefault(); event.stopPropagation(); removeSelected()
    }
  })
  window.addEventListener('keyup', event => { if (event.code === 'Space') spaceHeld = false })
  window.addEventListener('blur', () => { spaceHeld = false; ink.cancel(); cancelShapeDrag(); cancelBoxDrag() })

  // —— 打开 / 关闭 ——
  function failLoad(message) {
    loadError = message
    loaded = false
    doc = emptyDocument()
    pendingChanges = false
    pendingRevision = 0
    typing = null
    history = { past: [], future: [] }
    clearSelection()
    setSaveState('读取失败 · 点击重试', true)
    render()
  }
  async function load() {
    let raw
    try { raw = await call('load') } catch (error) {
      failLoad(`画布读取失败：${error?.message || error}`)
      return false
    }
    // 新主进程返回 { docs, corrupted }，旧主进程直接返回文档；两种都认。
    const wrapped = raw !== null && typeof raw === 'object' && Object.prototype.hasOwnProperty.call(raw, 'docs')
    if (wrapped && raw.corrupted === true) {
      failLoad('画布数据已损坏或无法解析；原数据仍保留在数据库里，未做任何写入。')
      return false
    }
    try {
      doc = normalizeDocument(wrapped ? raw.docs ?? emptyDocument() : raw ?? emptyDocument())
    } catch (error) {
      failLoad(`画布数据无法解析：${error?.message || error}；原数据仍保留在数据库里，未做任何写入。`)
      return false
    }
    loadError = null
    setSaveState('已保存')
    if (!doc.canvases.length) {
      doc = createCanvas(doc, '').document
      try {
        await call('save', { docs: doc })
      } catch (error) {
        notify(`画布保存失败：${error?.message || error}`, true)
        pendingChanges = true
        pendingRevision += 1
        setSaveState('保存失败 · 点击重试', true)
      }
    }
    loaded = true
    typing = null
    history = { past: [], future: [] }
    clearSelection()
    render()
    return true
  }
  async function retryLoad() {
    if (!loadError) { await flush(); return }
    const ok = await load()
    if (ok) notify('画布已重新读取')
    else if (loadError) notify(loadError, true)
  }
  async function rebuildFromError() {
    if (!loadError) return
    if (!(await confirm('当前画布数据读取失败。重建空白画布会用空文档覆盖原画布，且无法撤销。确定继续？'))) return
    loadError = null
    doc = createCanvas(emptyDocument(), '').document
    loaded = true
    history = { past: [], future: [] }
    clearSelection()
    render()
    pendingRevision += 1
    pendingChanges = true
    await flush()
    if (!pendingChanges) notify('已重建空白画布')
  }
  async function open() {
    if (!section.hidden) return
    question.clearCache()
    if (!loaded || !pendingChanges) await load()
    section.hidden = false
    shell.classList.add('canvas-on')
    render()
    setTimeout(() => surface.focus({ preventScroll: true }), 0)
  }
  async function close() {
    if (section.hidden) return
    quickPalette.close()
    ink.setTool('select')
    ink.cancel()
    setTextPlacement(false)
    setShapeTool(null)
    setBoxTool(false)
    cursor.reset()
    spaceHeld = false
    settleTyping()
    await flush()
    clearSelection()
    section.hidden = true
    shell.classList.remove('canvas-on')
    document.getElementById('mb-open-canvas')?.focus()
  }
  const isOpen = () => !section.hidden

  return { open, close, isOpen, section, flush }
}
