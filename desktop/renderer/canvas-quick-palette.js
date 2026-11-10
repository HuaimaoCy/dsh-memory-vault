import { SHAPE_KINDS } from '../../addons/mistakebook/canvas-shapes.mjs'

const radius = 124
const rim = 27
const clamp = (value, min, max) => Math.max(min, Math.min(max, value))
const hexColor = value => /^#?[\da-f]{6}$/i.test(value) ? `#${value.replace('#', '').toLowerCase()}` : null

function toHSV(color, fallbackHue) {
  const [r, g, b] = color.slice(1).match(/../g).map(channel => parseInt(channel, 16) / 255)
  const v = Math.max(r, g, b), delta = v - Math.min(r, g, b)
  let h = fallbackHue
  if (delta) {
    if (v === r) h = (g - b) / delta
    else if (v === g) h = 2 + (b - r) / delta
    else h = 4 + (r - g) / delta
    h = (h * 60 + 360) % 360
  }
  return { h, s: v ? 100 * delta / v : 0, v: v * 100 }
}

function fromHSV({ h, s, v }) {
  const brightness = v / 100
  const channel = offset => {
    const k = (offset + h / 60) % 6
    const amount = Math.max(0, Math.min(k, 4 - k, 1))
    return Math.round(255 * brightness * (1 - s / 100 * amount)).toString(16).padStart(2, '0')
  }
  return `#${channel(5)}${channel(3)}${channel(1)}`
}

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

export function createCanvasQuickPalette({ h, icon, selectTool, selectShape, setColor, toggleFavorite, setWidth, undo, redo }) {
  let anchor = null
  let tool = 'select'
  let shapeTool = null
  let activePanel = null
  let currentColor = '#1267ed', previewColor = null, favoriteKey = ''
  let hsv = toHSV(currentColor, 0)
  let swatches = []
  const button = (label, image, onClick, attributes = {}) => h('button', {
    type: 'button', class: 'mb-quick-control', 'aria-label': label, title: label, onClick, ...attributes,
  }, image)
  const panelButton = (id, label, image, panelId) => button(label, image, () => {
    setPanel(activePanel === id ? null : id)
  }, { 'data-quick-panel': id, 'aria-expanded': 'false', 'aria-controls': panelId })
  const instrument = (id, label, image) => button(label, image, () => {
    close()
    selectTool(id)
  }, { 'data-quick-tool': id, 'aria-pressed': 'false' })
  const pen = instrument('pen', '画笔 · B', icon('pen'))
  const marker = instrument('marker', '荧光笔 · H', glyph(svg('path', { d: 'm13 4 7 7-8 8H6v-6L13 4Zm-5 9 5 5M4 21h10' })))
  const eraser = instrument('erase', '橡皮 · E', glyph(svg('path', { d: 'm4 13 9-9a2 2 0 0 1 3 0l4 4a2 2 0 0 1 0 3l-9 9H8l-4-4a2 2 0 0 1 0-3Zm4-4 7 7m-4 4h9' })))
  const selection = instrument('box-select', '框选挪动 · M', glyph(svg('rect', { x: '4', y: '4', width: '16', height: '16', rx: '2', 'stroke-dasharray': '2.8 2.8' })))
  const colorSample = h('span', { class: 'mb-quick-color-sample', 'aria-hidden': 'true' })
  const color = panelButton('colors', '常用色和自定义颜色', colorSample, 'mb-quick-color-panel')
  const common = h('div', { class: 'mb-quick-swatches', role: 'group', 'aria-label': '常用颜色' })
  const sliders = [
    ['h', 'hue', '色相', 359], ['s', 'saturation', '饱和度', 100], ['v', 'brightness', '亮度', 100],
  ].map(([key, id, label, max]) => {
    const input = h('input', { type: 'range', min: '0', max, 'data-quick-color-channel': id, [`data-quick-${id}`]: '',
      onInput: event => {
        hsv[key] = event.target.valueAsNumber
        previewColor = fromHSV(hsv)
        paintColor()
      },
      onChange: () => {
        if (!previewColor) return
        const next = previewColor
        previewColor = null
        currentColor = next
        setColor(next)
        paintColor()
      },
    })
    return { key, input, row: h('label', { class: 'mb-quick-channel' }, h('span', {}, label), input) }
  })
  const applyHex = event => {
    const next = hexColor(event.target.value)
    if (next && next !== currentColor) setColor(next)
  }
  const hex = h('input', { type: 'text', maxlength: '7', class: 'mb-quick-hex', 'aria-label': '十六进制颜色',
    'data-quick-hex': '', spellcheck: 'false', autocomplete: 'off',
    onInput: applyHex, onChange: applyHex,
    onBlur: () => { hex.value = currentColor },
  })
  const favorite = h('button', { type: 'button', class: 'mb-quick-favorite', 'data-quick-favorite': '',
    onClick: () => toggleFavorite?.(currentColor) })
  const colorPanel = h('div', { class: 'mb-quick-panel mb-quick-color-panel', id: 'mb-quick-color-panel', hidden: true,
    role: 'group', 'aria-label': '颜色' }, common, sliders.map(({ row }) => row), h('div', { class: 'mb-quick-color-actions' }, hex, favorite))
  const width = h('input', { type: 'range', 'aria-label': '笔迹粗细', onInput: event => setWidth(event.target.valueAsNumber) })
  const widthValue = h('output', { class: 'mb-quick-width-value' })
  const widthPanel = h('div', { class: 'mb-quick-panel mb-quick-width-panel', id: 'mb-quick-width-panel', hidden: true }, width, widthValue)
  const thickness = panelButton('width', '笔迹粗细', glyph(svg('path', { d: 'M5 6h14M5 12h14M5 18h14' }),
    svg('path', { d: 'M5 18h14', 'stroke-width': '3.4' })), widthPanel.id)
  const shapeButtons = Object.entries(SHAPE_KINDS).map(([kind, label]) => h('button', {
    type: 'button', class: 'mb-quick-shape', 'data-quick-shape': kind, 'aria-label': label, title: label,
    onClick: () => { close(); selectShape?.(kind) },
  }, icon(`shape-${kind}`)))
  const shapePanel = h('div', { class: 'mb-quick-panel mb-quick-shape-panel', id: 'mb-quick-shape-panel', hidden: true,
    role: 'group', 'aria-label': '绘制图形' }, shapeButtons)
  const shapes = panelButton('shapes', '切换图形', icon('board-shapes'), shapePanel.id)
  const panels = [
    { id: 'colors', button: color, node: colorPanel, focus: () => swatches.find(item => item.value === currentColor)?.node ?? swatches[0]?.node ?? hex },
    { id: 'width', button: thickness, node: widthPanel, focus: () => width },
    { id: 'shapes', button: shapes, node: shapePanel, focus: () => shapeButtons.find(item => item.dataset.quickShape === shapeTool) ?? shapeButtons[0] },
  ]
  const undoButton = button('撤销', icon('undo'), undo)
  const redoButton = button('重做', icon('redo'), redo)
  const controls = [thickness, color, marker, pen, eraser, shapes, selection, undoButton, redoButton]
  const backing = svg('svg', { class: 'mb-quick-arc', 'aria-hidden': 'true' })
  const border = svg('path', { class: 'mb-quick-arc-border' })
  const fill = svg('path', { class: 'mb-quick-arc-fill' })
  backing.append(border, fill)
  const element = h('div', { class: 'mb-canvas-quick-palette', id: 'mb-canvas-quick-palette', hidden: true,
    role: 'toolbar', 'aria-label': '画布工具盘' }, backing, controls, widthPanel, colorPanel, shapePanel)

  function layout() {
    if (!anchor || element.hidden) return
    const { clientWidth: w, clientHeight: h } = element
    if (!w || !h) return
    const arcRadius = Math.max(1, Math.min(radius, (h - 2 * rim) / 2 - 4))
    const safe = arcRadius + rim + 4
    const left = anchor.x >= w / 2
    const x = clamp(anchor.x, left ? safe : rim, left ? w - rim : w - safe)
    const chrome = w < 1040 ? 132 : 76
    const top = h >= chrome + safe * 2 ? chrome + safe : safe
    const y = clamp(anchor.y, top, h - safe)
    const points = controls.map((control, index) => {
      const angle = (index - (controls.length - 1) / 2) * Math.PI / 9
      const cx = x + (left ? -1 : 1) * arcRadius * Math.cos(angle)
      const cy = y + arcRadius * Math.sin(angle)
      control.style.left = `${cx}px`
      control.style.top = `${cy}px`
      return [cx, cy]
    })
    const path = `M${points[0].join(' ')} A${arcRadius} ${arcRadius} 0 0 ${left ? 0 : 1} ${points.at(-1).join(' ')}`
    border.setAttribute('d', path)
    fill.setAttribute('d', path)
    const panel = panels.find(item => item.id === activePanel)?.node
    if (panel) {
      const widthBox = panel.offsetWidth, heightBox = panel.offsetHeight
      const inside = left ? x + rim : x - rim - widthBox
      const outside = left ? x - safe - widthBox : x + safe
      const fits = value => value >= 8 && value + widthBox <= w - 8
      const panelX = fits(inside) ? inside : outside
      panel.style.left = `${clamp(panelX, 8, w - widthBox - 8)}px`
      panel.style.top = `${clamp(y - heightBox / 2, 8, h - heightBox - 8)}px`
    }
  }

  function setPanel(id) {
    if (previewColor && id !== 'colors') {
      previewColor = null
      hsv = toHSV(currentColor, hsv.h)
      paintColor()
    }
    activePanel = id
    for (const { id: name, button, node } of panels) {
      node.hidden = name !== id
      button.setAttribute('aria-expanded', String(name === id))
    }
    if (!id) return
    layout()
    panels.find(item => item.id === id)?.focus().focus({ preventScroll: true })
  }

  function open(point, panel = null) {
    anchor = point
    element.hidden = false
    setPanel(panel)
    if (panel) return
    layout()
    const focusedTool = shapeTool ? shapes : controls.find(control => control.dataset.quickTool === tool) ?? pen
    focusedTool.focus({ preventScroll: true })
  }
  function close() {
    element.hidden = true
    anchor = null
    setPanel(null)
  }
  function paintColor() {
    const displayed = previewColor ?? currentColor
    colorSample.style.setProperty('--quick-swatch', displayed)
    colorPanel.style.setProperty('--quick-saturation-low', fromHSV({ ...hsv, s: 0 }))
    colorPanel.style.setProperty('--quick-saturation-high', fromHSV({ ...hsv, s: 100 }))
    colorPanel.style.setProperty('--quick-brightness-high', fromHSV({ ...hsv, v: 100 }))
    if (document.activeElement !== hex) hex.value = displayed
    for (const { key, input } of sliders) {
      const value = Math.round(hsv[key])
      if (input.valueAsNumber !== value) input.value = value
    }
    for (const { node, value } of swatches) node.setAttribute('aria-pressed', String(value === displayed))
  }
  function update(state) {
    tool = state.tool
    shapeTool = state.shapeTool
    for (const control of [pen, marker, eraser, selection]) control.setAttribute('aria-pressed', String(control.dataset.quickTool === tool))
    shapes.toggleAttribute('data-tool-active', Boolean(shapeTool))
    for (const option of shapeButtons) option.setAttribute('aria-pressed', String(option.dataset.quickShape === shapeTool))
    const selected = hexColor(state.color) ?? currentColor
    if (selected !== currentColor) {
      currentColor = selected
      previewColor = null
      hsv = toHSV(currentColor, hsv.h)
    }
    const presets = new Map((state.presets ?? []).map(({ value, label }) => [hexColor(value), label]))
    const saved = new Set((state.favorites ?? []).map(hexColor).filter(Boolean))
    const colors = new Map(presets)
    for (const value of saved) if (!colors.has(value)) colors.set(value, `常用色 ${value.toUpperCase()}`)
    colors.delete(null)
    const key = JSON.stringify([...colors])
    if (key !== favoriteKey) {
      favoriteKey = key
      swatches = [...colors].map(([value, label]) => ({ value, node: h('button', {
        type: 'button', class: 'mb-quick-swatch', style: `--quick-swatch:${value}`, 'data-quick-color': value,
        title: `${label} ${value.toUpperCase()}`, 'aria-label': label, onClick: () => setColor(value),
      }) }))
      common.replaceChildren(...swatches.map(item => item.node))
      if (activePanel === 'colors') layout()
    }
    const stored = saved.has(currentColor), preset = presets.has(currentColor)
    favorite.disabled = preset || (!stored && saved.size >= (state.maxFavorites ?? 8))
    favorite.textContent = stored ? '移除常用色' : '保存常用色'
    favorite.title = preset ? '已在预设颜色中' : favorite.disabled ? '常用色已满，请先移除一种颜色' : favorite.textContent
    paintColor()
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
