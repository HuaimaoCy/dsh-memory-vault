const radius = 116
const rim = 27
const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

function svg(tag, attributes = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag)
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value)
  return node
}

function glyph(...parts) {
  const node = svg('svg', { viewBox: '0 0 24 24', class: 'icon', fill: 'none', stroke: 'currentColor',
    'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })
  node.append(...parts)
  return node
}

export function createCanvasQuickPalette({ h, icon, selectTool, setColor, setWidth, undo, redo }) {
  let anchor = null
  let tool = 'select'
  const button = (label, image, onClick, attributes = {}) => h('button', {
    type: 'button', class: 'mb-quick-control', 'aria-label': label, title: label, onClick, ...attributes,
  }, image)
  const instrument = (id, label, image) => button(label, image, () => {
    close()
    selectTool(id)
  }, { 'data-quick-tool': id, 'aria-pressed': 'false' })
  const pen = instrument('pen', '画笔 · B', icon('pen'))
  const marker = instrument('marker', '荧光笔 · H', glyph(svg('path', { d: 'm13 4 7 7-8 8H6v-6L13 4Zm-5 9 5 5M4 21h10' })))
  const eraser = instrument('erase', '橡皮 · E', glyph(svg('path', { d: 'm4 13 9-9a2 2 0 0 1 3 0l4 4a2 2 0 0 1 0 3l-9 9H8l-4-4a2 2 0 0 1 0-3Zm4-4 7 7m-4 4h9' })))
  const selection = instrument('box-select', '框选挪动 · M', glyph(svg('rect', { x: '4', y: '4', width: '16', height: '16', rx: '2', 'stroke-dasharray': '2.8 2.8' })))
  const color = h('input', { type: 'color', class: 'mb-quick-control mb-quick-color', title: '选择笔色',
    'aria-label': '选择笔色', onInput: event => setColor(event.target.value) })
  const width = h('input', { type: 'range', 'aria-label': '笔迹粗细', onInput: event => setWidth(event.target.valueAsNumber) })
  const widthValue = h('output', { class: 'mb-quick-width-value' })
  const widthPanel = h('div', { class: 'mb-quick-width-panel', id: 'mb-quick-width-panel', hidden: true }, width, widthValue)
  const thickness = button('笔迹粗细', glyph(svg('path', { d: 'M5 6h14M5 12h14M5 18h14' }),
    svg('path', { d: 'M5 18h14', 'stroke-width': '3.4' })), () => {
    setWidthPanel(widthPanel.hidden)
    if (!widthPanel.hidden) width.focus({ preventScroll: true })
  }, { 'aria-expanded': 'false', 'aria-controls': widthPanel.id })
  const undoButton = button('撤销', icon('undo'), undo)
  const redoButton = button('重做', icon('redo'), redo)
  const controls = [thickness, color, marker, pen, eraser, selection, undoButton, redoButton]
  const backing = svg('svg', { class: 'mb-quick-arc', 'aria-hidden': 'true' })
  const border = svg('path', { class: 'mb-quick-arc-border' })
  const fill = svg('path', { class: 'mb-quick-arc-fill' })
  backing.append(border, fill)
  const element = h('div', { class: 'mb-canvas-quick-palette', id: 'mb-canvas-quick-palette', hidden: true,
    role: 'toolbar', 'aria-label': '画布工具盘' }, backing, controls, widthPanel)

  function layout() {
    if (!anchor || element.hidden) return
    const { clientWidth: w, clientHeight: h } = element
    if (!w || !h) return
    const arcRadius = Math.min(radius, (h - 2 * rim) / 2)
    const safe = arcRadius + rim + 4
    const left = anchor.x >= w / 2
    const x = clamp(anchor.x, left ? safe : rim, left ? w - rim : w - safe)
    const chrome = w < 1040 ? 132 : 76
    const top = h >= chrome + safe * 2 ? chrome + safe : safe
    const y = clamp(anchor.y, top, h - safe)
    const points = controls.map((control, index) => {
      const angle = (index - (controls.length - 1) / 2) * Math.PI * 22 / 180
      const cx = x + (left ? -1 : 1) * arcRadius * Math.cos(angle)
      const cy = y + arcRadius * Math.sin(angle)
      control.style.left = `${cx}px`
      control.style.top = `${cy}px`
      return [cx, cy]
    })
    const path = `M${points[0].join(' ')} A${arcRadius} ${arcRadius} 0 0 ${left ? 0 : 1} ${points.at(-1).join(' ')}`
    border.setAttribute('d', path)
    fill.setAttribute('d', path)
    if (!widthPanel.hidden) {
      const widthBox = widthPanel.offsetWidth, heightBox = widthPanel.offsetHeight
      const below = y + arcRadius + rim + 8
      const above = y - arcRadius - rim - heightBox - 8
      widthPanel.style.left = `${clamp(x - widthBox / 2, 8, w - widthBox - 8)}px`
      widthPanel.style.top = `${clamp(below + heightBox <= h - 8 ? below : above, 8, h - heightBox - 8)}px`
    }
  }

  function setWidthPanel(open) {
    widthPanel.hidden = !open
    thickness.setAttribute('aria-expanded', String(open))
    if (open) layout()
  }

  function open(point) {
    anchor = point
    setWidthPanel(false)
    element.hidden = false
    layout()
    const focusedTool = controls.find(control => control.dataset.quickTool === tool) ?? pen
    focusedTool.focus({ preventScroll: true })
  }
  function close() {
    element.hidden = true
    anchor = null
    setWidthPanel(false)
  }
  function update(state) {
    tool = state.tool
    for (const control of [pen, marker, eraser, selection]) control.setAttribute('aria-pressed', String(control.dataset.quickTool === tool))
    if (color.value !== state.color) color.value = state.color
    width.min = state.minWidth
    width.max = state.maxWidth
    width.step = state.step
    width.value = state.width
    widthValue.value = state.width
    undoButton.disabled = !state.canUndo
    redoButton.disabled = !state.canRedo
  }
  new ResizeObserver(layout).observe(element)
  return { element, open, close, update, isOpen: () => !element.hidden }
}
