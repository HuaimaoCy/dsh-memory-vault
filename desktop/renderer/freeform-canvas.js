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
import {
  CANVAS_LIMITS, DEFAULT_SIZES, STICKY_TONES, activeCanvas, addCard, canvasById, contentBounds,
  contentFits, createCanvas, defaultView, deleteCanvas, edgeGeometry, emptyDocument, fitView, linkCards,
  normalizeDocument, panBy, placement, removeCards, removeEdge, renameCanvas, screenToWorld,
  updateCard, zoomAt,
} from '../../addons/mistakebook/canvas.mjs'

const kindLabels = { text: '文本', sticky: '便签', reference: '笔记' }
const noteLabel = type => NOTE_TYPES[type]?.label ?? '笔记'
const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const round = value => Math.round(value)

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
  const { host, shell, h, icon, dialog, call, notify, confirm, openNote, notes } = options

  const stateChip = h('button', { type: 'button', class: 'mb-canvas-save cap', id: 'mb-canvas-save-state', title: '画布保存状态；失败时点击重试', text: '已保存' })
  const picker = h('select', { class: 'select', id: 'mb-canvas-picker', 'aria-label': '切换画布' })
  const zoomLabel = h('span', { class: 'mb-canvas-zoom-label', id: 'mb-canvas-zoom', text: '100%' })
  const undoButton = h('button', { type: 'button', class: 'mb-canvas-icon', id: 'mb-canvas-undo', title: '撤销 · Ctrl / ⌘ Z', 'aria-label': '撤销', disabled: true, onClick: () => undo() }, icon('undo'))
  const redoButton = h('button', { type: 'button', class: 'mb-canvas-icon', id: 'mb-canvas-redo', title: '重做 · Ctrl / ⌘ Shift Z', 'aria-label': '重做', disabled: true, onClick: () => redo() }, icon('redo'))

  const surface = h('div', {
    class: 'mb-canvas-surface', id: 'mb-canvas-surface', tabindex: '0', role: 'application',
    'aria-label': '自由画布：拖动空白处平移，滚轮以指针为中心缩放，点击卡片选中',
  })
  const world = h('div', { class: 'mb-canvas-world', id: 'mb-canvas-world' })
  const hint = h('div', { class: 'mb-canvas-hint', id: 'mb-canvas-hint' })
  surface.append(world, hint)

  const bar = h('div', { class: 'mb-canvas-bar', id: 'mb-canvas-bar' },
    h('div', {class:'mb-canvas-title-group', 'data-glass-surface':'float'},
      h('button', { type: 'button', class: 'mb-canvas-icon mb-canvas-back', id: 'mb-canvas-back', title: '回到笔记列表（Esc）', 'aria-label':'回到笔记', onClick: () => void close() }, icon('chevron-right')),
      picker),
    h('div', {class:'mb-canvas-actions', 'data-glass-surface':'float'},
    h('button', { type: 'button', class: 'mb-canvas-icon', id: 'mb-canvas-new', title: '新建画布', 'aria-label': '新建画布', onClick: () => void newCanvas() }, icon('plus')),
    h('button', { type: 'button', class: 'mb-canvas-icon', id: 'mb-canvas-rename', title: '重命名当前画布', 'aria-label': '重命名当前画布', onClick: () => void renameActive() }, icon('pen')),
    h('button', { type: 'button', class: 'mb-canvas-icon danger', id: 'mb-canvas-delete', title: '删除当前画布', 'aria-label': '删除当前画布', onClick: () => void deleteActive() }, icon('close')),
    stateChip))

  const tools = h('div', { class: 'mb-canvas-tools', id: 'mb-canvas-tools', role: 'toolbar', 'aria-label': '画布工具', 'data-glass-surface':'float' },
    undoButton, redoButton,
    h('span', { class: 'mb-canvas-bar-sep' }),
    h('button', { type: 'button', class: 'mb-canvas-tool', id: 'mb-canvas-text', title: '添加文本卡片', onClick: () => addKind('text') }, [icon('note'), h('span', { text: '文本' })]),
    h('button', { type: 'button', class: 'mb-canvas-tool', id: 'mb-canvas-sticky', title: '添加便签', onClick: () => addKind('sticky') }, [icon('pen'), h('span', { text: '便签' })]),
    h('button', { type: 'button', class: 'mb-canvas-tool', id: 'mb-canvas-reference', title: '引用现有笔记', onClick: () => void pickReference() }, [icon('book'), h('span', { text: '笔记' })]),
    h('button', { type: 'button', class: 'mb-canvas-tool', id: 'mb-canvas-link', title: '把选中的两张卡片连起来', onClick: () => linkSelected() }, [icon('layers'), h('span', { text: '连接' })]))

  const zoomControls = h('div', { class: 'mb-canvas-zoom', id: 'mb-canvas-zoom-controls', 'data-glass-surface':'float' },
    h('button', { type: 'button', class: 'mb-canvas-icon', id: 'mb-canvas-zoom-out', title: '缩小', 'aria-label': '缩小', onClick: () => zoomStep(1 / 1.25) }, '−'),
    zoomLabel,
    h('button', { type: 'button', class: 'mb-canvas-icon', id: 'mb-canvas-zoom-in', title: '放大', 'aria-label': '放大', onClick: () => zoomStep(1.25) }, '＋'),
    h('button', { type: 'button', class: 'btn ghost', id: 'mb-canvas-fit', title: '把画布上的卡片装进视野', onClick: () => fitContent() }, '回到内容'),
    h('button', { type: 'button', class: 'btn ghost', id: 'mb-canvas-reset', title: '视口回到原点与 100%', onClick: () => resetView() }, '重置视口'))

  const section = h('section', { class: 'mb-canvas', id: 'mb-canvas', hidden: true, 'aria-label': '自由画布' }, bar, surface, tools, zoomControls)
  const footer = host.querySelector('.mb-foot')
  if (footer) host.insertBefore(section, footer); else host.append(section)

  let doc = emptyDocument()
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
  const selection = { cards: new Set(), edges: new Set() }
  const cardNodes = new Map(), edgeNodes = new Map()

  const current = () => activeCanvas(doc)
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
        doc = normalizeDocument(doc)
        await call('save', { docs: doc })
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
  const paintView = () => {
    const canvas = current()
    if (!canvas) return
    const view = canvas.view
    world.style.transform = `translate3d(${round(view.x)}px, ${round(view.y)}px, 0) scale(${view.scale})`
    surface.style.setProperty('--mb-canvas-cell', `${round(26 * view.scale)}px`)
    surface.style.setProperty('--mb-canvas-x', `${round(view.x)}px`)
    surface.style.setProperty('--mb-canvas-y', `${round(view.y)}px`)
    zoomLabel.textContent = `${round(view.scale * 100)}%`
  }
  const setView = next => {
    const canvas = current()
    if (!canvas) return
    canvas.view = { x: Math.round(next.x), y: Math.round(next.y), scale: clamp(next.scale, CANVAS_LIMITS.minScale, CANVAS_LIMITS.maxScale) }
    paintView()
    markDirty()
  }
  const viewportCenter = () => { const size = surfaceSize(); return { x: size.w / 2, y: size.h / 2 } }
  const worldCenter = () => screenToWorld(current()?.view ?? defaultView(), viewportCenter())
  const zoomStep = factor => {
    const canvas = current()
    if (!canvas) return
    setView(zoomAt(canvas.view, viewportCenter(), canvas.view.scale * factor))
  }
  const resetView = () => { setView(defaultView()); notify('视口已回到原点与 100%') }
  const fitContent = () => {
    const canvas = current()
    if (!canvas) return
    const bounds = contentBounds(canvas.cards)
    if (!bounds) { setView(defaultView()); notify('画布上还没有卡片，视口已重置'); return }
    const size = surfaceSize()
    setView(fitView(bounds, size))
    const view = current()?.view
    // fitView 会被最小缩放（20%）卡住：装不下时不要谎称「都在视野里」。
    const complete = view ? contentFits(canvas.cards, view, size, 1) : false
    notify(complete
      ? '已回到内容，全部卡片都在视野里'
      : `已回到内容，但画布太大：当前已缩到 ${Math.round((view?.scale ?? CANVAS_LIMITS.minScale) * 100)}%，仍有卡片在视野外`,
    !complete)
  }

  // —— 选择 ——
  const paintSelection = () => {
    for (const [id, node] of cardNodes) node.classList.toggle('selected', selection.cards.has(id))
    for (const [id, node] of edgeNodes) node.classList.toggle('selected', selection.edges.has(id))
    section.classList.toggle('has-selection', selection.cards.size + selection.edges.size > 0)
  }
  const clearSelection = () => {
    if (!selection.cards.size && !selection.edges.size) return
    selection.cards.clear(); selection.edges.clear(); paintSelection()
  }
  const selectOnly = id => {
    selection.edges.clear()
    selection.cards.clear(); selection.cards.add(id); paintSelection()
  }
  const toggleCard = id => {
    selection.edges.clear()
    if (selection.cards.has(id)) selection.cards.delete(id); else selection.cards.add(id)
    paintSelection()
  }
  const selectEdge = id => {
    selection.cards.clear(); selection.edges.clear(); selection.edges.add(id); paintSelection()
  }

  // —— 渲染 ——
  const kindLabelText = card => card.kind === 'reference' ? `引用 · ${noteLabel(card.noteType)}` : kindLabels[card.kind]
  const cardStyle = card => `transform:translate(${card.x}px,${card.y}px);width:${card.w}px;height:${card.h}px;z-index:${card.z}`
  function cardElement(card) {
    const close = h('button', {
      type: 'button', class: 'mb-canvas-card-close', 'aria-label': '删除这张卡片', title: '删除这张卡片（可撤销）',
      onClick: event => { event.stopPropagation(); selectOnly(card.id); void removeSelected() },
    }, '×')
    const head = h('div', { class: 'mb-canvas-card-head' },
      h('span', { class: 'mb-canvas-kind', text: kindLabelText(card) }),
      card.kind === 'sticky' ? h('button', {
        type: 'button', class: 'mb-canvas-tone', 'data-tone': card.tone, title: '切换便签颜色', 'aria-label': '切换便签颜色',
        onClick: event => { event.stopPropagation(); cycleTone(card.id) },
      }) : null,
      h('span', { class: 'spacer' }), close)
    const body = card.kind === 'reference'
      ? h('div', { class: 'mb-canvas-ref' },
        h('strong', { class: 'mb-canvas-ref-title', text: card.noteTitle || '未命名笔记' }),
        h('p', { class: 'mb-canvas-ref-stem', text: card.text || '打开笔记查看内容' }),
        h('button', {
          type: 'button', class: 'btn ghost mb-canvas-ref-open',
          onClick: event => { event.stopPropagation(); void openReference(card) },
        }, '打开笔记'))
      : h('textarea', {
        class: 'mb-canvas-text', rows: 4, maxlength: String(CANVAS_LIMITS.text), spellcheck: 'false',
        placeholder: card.kind === 'sticky' ? '写一张便签…' : '输入文字…', value: card.text,
        onInput: event => writeText(card.id, event.target.value),
        onFocus: () => beginTyping(card.id),
        onBlur: () => endTyping(card.id),
      })
    const node = h('div', {
      class: `mb-canvas-card ${card.kind}${card.kind === 'sticky' ? ` tone-${card.tone}` : ''}`,
      'data-card-id': card.id, 'data-kind': card.kind, style: cardStyle(card),
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
    cardNodes.clear()
    for (const node of world.querySelectorAll('.mb-canvas-card')) node.remove()
    if (!canvas) return
    const nodes = [...canvas.cards].sort((a, b) => a.z - b.z).map(card => { const node = cardElement(card); cardNodes.set(card.id, node); return node })
    world.append(...nodes)
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
    undoButton.disabled = history.past.length === 0
    redoButton.disabled = history.future.length === 0
  }
  function render() {
    paintCards()
    paintEdges()
    paintView()
    paintPicker()
    paintHistory()
    paintHint()
  }

  // —— 变更 ——
  const replaceCanvas = next => { doc = { ...doc, canvases: doc.canvases.map(canvas => canvas.id === next.id ? next : canvas) } }
  const pushHistory = before => {
    history.past.push(before)
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
    const before = JSON.stringify(doc)
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
    if (!card) return
    // 输入会话以「写入」为准而不是只靠 focus/blur：卡片会被 render 重建，
    // 重建后不一定有 blur，focus 也不一定再触发。没有会话就从这里开一段新的，
    // 这样撤销永远只回退最近这一段输入。
    if (!typing || typing.id !== id) {
      settleTyping()
      typing = { id, before: JSON.stringify(doc) }
    }
    card.text = String(value).slice(0, CANVAS_LIMITS.text)
    markDirty()
  }
  function beginTyping(id) {
    // 同一张卡片的输入只有「输入框仍持有焦点」时才算连续输入；焦点已经不在
    // （render 重建、点了别处却没触发 blur）就先把上一段结算掉。
    if (typing && (typing.id !== id || document.activeElement?.closest?.(`[data-card-id="${typing.id}"]`) === null)) settleTyping()
    if (typing?.id === id) return
    typing = { id, before: JSON.stringify(doc) }
  }
  function settleTyping() {
    if (typing) endTyping(typing.id)
  }
  function endTyping(id) {
    if (!typing || typing.id !== id) return
    const before = typing.before
    typing = null
    if (JSON.stringify(doc) === before) return
    pushHistory(before)
  }
  function cycleTone(id) {
    const canvas = current()
    const card = canvas?.cards.find(row => row.id === id)
    if (!card) return
    mutate(row => updateCard(row, id, { tone: STICKY_TONES[(STICKY_TONES.indexOf(card.tone) + 1) % STICKY_TONES.length] }))
  }

  // —— 卡片与画布管理 ——
  function addKind(kind) {
    if (loadError) { notify('画布读取失败：请先重试读取，再添加卡片', true); return }
    const canvas = current()
    if (!canvas) { void newCanvas(); return }
    const size = DEFAULT_SIZES[kind]
    const spot = placement(canvas.cards, size, worldCenter())
    const card = { kind, x: spot.x, y: spot.y, w: size.w, h: size.h, tone: STICKY_TONES[0], text: '' }
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
      const size = DEFAULT_SIZES.reference
      const spot = placement(canvas.cards, size, worldCenter())
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
  async function openReference(card) {
    if (!card.noteId) { notify('这张卡片没有关联笔记', true); return }
    await flush()
    try { await openNote(card.noteId) } catch (error) { notify(error?.message || String(error), true) }
  }
  async function removeSelected() {
    const canvas = current()
    if (!canvas) return
    const cardCount = selection.cards.size, edgeCount = selection.edges.size
    if (!cardCount && !edgeCount) return
    const label = cardCount && edgeCount ? `${cardCount} 张卡片与 ${edgeCount} 条连线` : cardCount ? `${cardCount} 张卡片` : `${edgeCount} 条连线`
    if (!(await confirm(`删除${label}？删除后可以用 Ctrl / ⌘ Z 撤销。`))) return
    const before = JSON.stringify(doc)
    const ids = [...selection.cards], edges = [...selection.edges]
    let next = cardCount ? removeCards(canvas, ids) : canvas
    for (const id of edges) next = removeEdge(next, id)
    replaceCanvas(next)
    pushHistory(before)
    clearSelection()
    render()
    markDirty()
    notify(`已删除${label} · 可撤销`)
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
  function undo() {
    settleTyping()
    const current_ = current()
    if (!current_ || !history.past.length) return
    const before = history.past.pop()
    history.future.push(JSON.stringify(doc))
    if (!applySnapshot(before)) return
    paintHistory()
  }
  function redo() {
    settleTyping()
    if (!history.future.length) return
    const next = history.future.pop()
    history.past.push(JSON.stringify(doc))
    if (!applySnapshot(next)) return
    paintHistory()
  }
  function applySnapshot(text) {
    try { doc = normalizeDocument(JSON.parse(text)) } catch { return false }
    clearSelection()
    render()
    markDirty()
    return true
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
    const title = await askTitle('新建画布', '', '创建', 'mb-canvas-title-input')
    if (title === null) return
    let created
    try { created = createCanvas(doc, title) } catch (error) { notify(error?.message || String(error), true); return }
    const before = JSON.stringify(doc)
    doc = created.document
    pushHistory(before)
    render()
    markDirty()
    notify(`已新建画布「${created.canvas.title}」`)
  }
  async function renameActive() {
    const canvas = current()
    if (!canvas) return
    const title = await askTitle('重命名画布', canvas.title, '保存', 'mb-canvas-title-input')
    if (title === null) return
    doc = renameCanvas(doc, canvas.id, title)
    render()
    markDirty()
    notify('画布已重命名')
  }
  async function deleteActive() {
    const canvas = current()
    if (!canvas) return
    const count = canvas.cards.length
    if (!(await confirm(`删除画布「${canvas.title}」${count ? `及其中 ${count} 张卡片` : ''}？此操作无法撤销。`))) return
    const result = deleteCanvas(doc, canvas.id)
    doc = result.document
    history = { past: [], future: [] }
    clearSelection()
    if (!doc.canvases.length) {
      const created = createCanvas(doc, '')
      doc = created.document
    }
    render()
    markDirty()
    notify('画布已删除，已切换到另一张空白画布')
  }
  const switchCanvas = id => {
    if (!canvasById(doc, id)) return
    if (id === doc.activeId) return
    doc = { ...doc, activeId: id }
    history = { past: [], future: [] }
    clearSelection()
    render()
    markDirty()
  }
  picker.addEventListener('change', () => switchCanvas(picker.value))

  // —— 指针交互：1:1 跟手，指针捕获，拖完才记一步撤销 ——
  let drag = null
  const capture = id => { try { surface.setPointerCapture(id) } catch { /* 合成事件没有活动指针 */ } }
  const release = id => { try { surface.releasePointerCapture(id) } catch { /* 已经释放 */ } }
  const localPoint = event => {
    const rect = surface.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }
  surface.addEventListener('pointerdown', event => {
    if (event.button !== 0 && event.button !== 1) return
    const canvas = current()
    if (!canvas) return
    if (event.target.closest('.mb-canvas-hint')) return
    const cardNode = event.target.closest('.mb-canvas-card')
    const edgeNode = event.target.closest('.mb-canvas-edge')
    if (cardNode) {
      const card = canvas.cards.find(row => row.id === cardNode.dataset.cardId)
      if (!card) return
      if (event.target.closest('.mb-canvas-resize')) {
        event.preventDefault()
        capture(event.pointerId)
        selectOnly(card.id)
        drag = { mode: 'resize', cardId: card.id, start: localPoint(event), origin: { w: card.w, h: card.h }, before: JSON.stringify(doc) }
        surface.classList.add('dragging')
        return
      }
      if (event.target.closest('textarea, input, select, button, .mb-canvas-ref-open')) {
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
      drag = { mode: 'move', ids, origins, start: localPoint(event), before: JSON.stringify(doc), moved: false }
      surface.classList.add('dragging')
      return
    }
    if (edgeNode) { selectEdge(edgeNode.dataset.edgeId); return }
    event.preventDefault()
    capture(event.pointerId)
    drag = { mode: 'pan', start: localPoint(event), origin: { ...canvas.view } }
    if (!event.shiftKey) clearSelection()
    surface.classList.add('panning')
  })
  surface.addEventListener('pointermove', event => {
    if (!drag) return
    // 指针在窗口外释放、捕获丢失时 buttons 会归零：结束拖动，别让卡片粘在指针上。
    if (event.pointerType === 'mouse' && event.buttons === 0) { endDrag(event); return }
    const canvas = current()
    if (!canvas) return
    const point = localPoint(event)
    const dx = point.x - drag.start.x, dy = point.y - drag.start.y
    if (drag.mode === 'pan') {
      const next = panBy(drag.origin, dx, dy)
      canvas.view = { x: round(next.x), y: round(next.y), scale: canvas.view.scale }
      paintView()
      return
    }
    const scale = canvas.view.scale
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
    if (!drag) return
    const finished = drag
    drag = null
    surface.classList.remove('dragging', 'panning')
    release(event.pointerId)
    if (finished.mode === 'pan') { saveSoon(); return }
    if (finished.mode === 'move' && !finished.moved) return
    pushHistory(finished.before)
    const canvas = current()
    if (canvas) render()
    markDirty()
  }
  surface.addEventListener('pointerup', endDrag)
  surface.addEventListener('pointercancel', endDrag)
  // 指针捕获被系统收回时也要结束拖动（否则后续 pointermove 仍按旧起点挪卡片）。
  surface.addEventListener('lostpointercapture', event => { if (drag) endDrag(event) })
  surface.addEventListener('wheel', event => {
    const canvas = current()
    if (!canvas) return
    // 指针在卡片文本里且没有 Ctrl/⌘：把滚轮交还给 textarea，长文本才能滚动阅读；
    // 其余情况仍然以指针为中心缩放。
    if (event.target.closest?.('textarea') && !event.ctrlKey && !event.metaKey) return
    event.preventDefault()
    if (event.shiftKey) {
      setView(panBy(canvas.view, -event.deltaY, 0))
      return
    }
    const rect = surface.getBoundingClientRect()
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top }
    const factor = Math.exp(-event.deltaY * 0.0015)
    setView(zoomAt(canvas.view, point, canvas.view.scale * factor))
  }, { passive: false })
  surface.addEventListener('dblclick', event => {
    const cardNode = event.target.closest('.mb-canvas-card')
    if (!cardNode) return
    const card = current()?.cards.find(row => row.id === cardNode.dataset.cardId)
    if (card?.kind === 'reference') void openReference(card)
  })

  // —— 键盘：删除/撤销/重做/Esc，输入框里交给原生 -- 
  section.addEventListener('keydown', event => {
    if (event.defaultPrevented) return
    const editing = Boolean(event.target.closest?.('textarea, input, select, [contenteditable="true"]'))
    if (event.key === 'Escape') {
      if (editing) return
      if (selection.cards.size || selection.edges.size) { event.stopPropagation(); clearSelection(); return }
      event.stopPropagation()
      void close()
      return
    }
    if (editing) return
    if ((event.key === 'Delete' || event.key === 'Backspace') && (selection.cards.size || selection.edges.size)) {
      event.preventDefault(); event.stopPropagation(); void removeSelected(); return
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault(); event.stopPropagation()
      if (event.shiftKey) redo(); else undo()
      return
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
      event.preventDefault(); event.stopPropagation(); redo()
    }
  })

  // —— 打开 / 关闭 ——
  function failLoad(message) {
    loadError = message
    loaded = false
    doc = emptyDocument()
    pendingChanges = false
    pendingRevision = 0
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
    if (!loaded || !pendingChanges) await load()
    section.hidden = false
    shell.classList.add('canvas-on')
    render()
    setTimeout(() => surface.focus({ preventScroll: true }), 0)
  }
  async function close() {
    if (section.hidden) return
    await flush()
    clearSelection()
    section.hidden = true
    shell.classList.remove('canvas-on')
    document.getElementById('mb-open-canvas')?.focus()
  }
  const isOpen = () => !section.hidden

  return { open, close, isOpen, section, flush }
}
