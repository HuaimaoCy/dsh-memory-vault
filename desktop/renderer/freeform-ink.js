import { INK_COLORS, INK_LIMITS, inkBounds, inkCoordinate, inkIntersects, inkPressure, inkSVGAttributes, stabilizeInkPoint } from '../../addons/mistakebook/canvas-ink.mjs'
import { CANVAS_LIMITS, screenToWorld, zoomAt } from '../../addons/mistakebook/canvas.mjs'
import { createGpuInkPreview } from './freeform-ink-gpu.js'

const SVG = 'http://www.w3.org/2000/svg'
const ERASER_RADIUS = 9

export function createCanvasInk({ surface, layer, h, icon, current, setView, commit, notify, onToolChange, onCursorChange, openColors, allowsPoint }) {
  const nodes = new Map()
  const gpuPreview = createGpuInkPreview(surface)
  const styles = { pen: { width: 2 }, marker: { width: 16 } }
  let color = '#1267ed'
  const touches = new Map()
  let touchView = null
  let tool = 'select'
  let drawWithTouch = false
  let gesture = null
  let frame = 0
  let paintedInk

  const toggle = h('button', {
    class: 'mb-canvas-tool', type: 'button', id: 'mb-canvas-ink-tool',
    'aria-label': '手写', 'aria-controls': 'mb-canvas-ink-tools', 'aria-expanded': 'false',
    title: '手写 · B　工具盘 · Q　手指书写 · Shift+B', onClick: () => setTool(tool === 'select' ? 'pen' : 'select'),
  }, icon('board-ink'))
  const modes = [
    ['pen', '笔 · B'], ['marker', '荧光笔 · H'], ['erase', '橡皮 · E'],
  ].map(([id, label]) => [id, h('button', {
    class: 'mb-ink-instrument-button', type: 'button', id: `mb-canvas-ink-${id}`,
    title: label, 'aria-label': label, onClick: () => setTool(id),
  }, h('span', { class: `mb-ink-instrument ${id}`, 'aria-hidden': 'true' }))])
  const presets = INK_COLORS.map(({ value, label }) => h('button', {
    type: 'button', class: 'mb-canvas-ink-color', style: `--ink-color:${value}`,
    'aria-label': label, title: label, 'data-ink-color': value,
    onClick: () => { setBrushStyle({ color: value }); surface.focus({ preventScroll: true }) },
  }))
  const customColor = h('button', {
    type: 'button', class: 'mb-canvas-ink-custom', id: 'mb-canvas-ink-color', title: '更多颜色', 'aria-label': '更多颜色',
    onClick: event => openColors(event.currentTarget),
  })
  const palette = h('div', { class: 'mb-canvas-ink-colors', role: 'group', 'aria-label': '笔色' }, presets, customColor)
  const widthLabel = h('output', { class: 'mb-ink-width-label', for: 'mb-canvas-ink-width' })
  const range = h('input', {
    type: 'range', id: 'mb-canvas-ink-width', max: String(INK_LIMITS.maxWidth), title: '笔迹粗细', 'aria-label': '笔迹粗细',
    onInput: event => setBrushStyle({ width: event.target.valueAsNumber }),
  })
  const widths = h('label', { class: 'mb-canvas-ink-widths' }, range, widthLabel)
  const panel = h('div', {
    class: 'mb-canvas-ink-tools', id: 'mb-canvas-ink-tools', hidden: true, role: 'toolbar', 'aria-label': '手写工具',
    'data-glass-surface': 'float',
  }, ...modes.map(([, button]) => button), palette, widths)

  function setTool(next) {
    if (!current()) return false
    cancel()
    tool = next
    const enabled = tool !== 'select'
    if (styles[tool]) gpuPreview.prepare()
    panel.hidden = !enabled
    toggle.setAttribute('aria-expanded', String(enabled))
    surface.dataset.inkTool = tool
    for (const [id, button] of modes) button.setAttribute('aria-pressed', String(id === tool))
    paintSettings()
    onToolChange?.(enabled)
    surface.focus({ preventScroll: true })
    return true
  }

  function toggleTouch() {
    if (!setTool(tool === 'select' ? 'pen' : tool)) return
    drawWithTouch = !drawWithTouch
    notify(drawWithTouch ? '已开启手指书写' : '已恢复单指平移')
  }

  function brushSettings() {
    const step = tool === 'marker' ? 1 : INK_LIMITS.minWidth
    return { tool, color, ...(styles[tool] ?? styles.pen), minWidth: step, maxWidth: INK_LIMITS.maxWidth, step }
  }

  function setBrushStyle(style) {
    if (style.color) color = style.color
    if (Number.isFinite(style.width)) (styles[tool] ?? styles.pen).width = style.width
    paintSettings()
  }

  function paintSettings() {
    const style = styles[tool]
    palette.hidden = widths.hidden = !style
    onCursorChange?.()
    if (!style) return
    for (const button of presets) button.setAttribute('aria-pressed', String(button.dataset.inkColor === color))
    customColor.value = color
    range.min = range.step = String(brushSettings().step)
    range.value = String(style.width)
    widthLabel.value = String(style.width)
    range.setAttribute('aria-valuetext', `${style.width} 像素（100% 缩放）`)
    panel.style.setProperty('--ink-active-color', color)
  }

  function strokeNode(stroke) {
    const node = document.createElementNS(SVG, 'path')
    node.setAttribute('data-stroke-id', stroke.id)
    return node
  }

  function paintStroke(node, stroke, range) {
    const { d, ...attributes } = inkSVGAttributes(stroke, range)
    // Composite the marker once even when its preview has multiple paths.
    const style = range ? node.parentElement : node
    for (const [name, value] of Object.entries(attributes)) {
      if (style.getAttribute(name) !== String(value)) style.setAttribute(name, String(value))
    }
    node.setAttribute('d', d)
  }

  function paint() {
    const ink = current()?.ink
    if (ink === paintedInk) return
    if (paintedInk && ink?.length === paintedInk.length + 1 && paintedInk.every((stroke, index) => stroke === ink[index])) {
      const stroke = ink.at(-1), node = strokeNode(stroke)
      paintStroke(node, stroke)
      nodes.set(stroke.id, { stroke, node })
      layer.insertBefore(node, gesture?.node ?? null)
      paintedInk = ink
      return
    }
    paintedInk = ink
    const previous = new Map(nodes)
    nodes.clear()
    const paths = (ink ?? []).map(stroke => {
      const old = previous.get(stroke.id)
      const node = old?.stroke === stroke ? old.node : strokeNode(stroke)
      if (node !== old?.node) paintStroke(node, stroke)
      nodes.set(stroke.id, { stroke, node })
      return node
    })
    if (gesture?.node) paths.push(gesture.node)
    layer.replaceChildren(...paths)
  }

  function capture(pointerId) {
    try { surface.setPointerCapture(pointerId) } catch { /* 测试合成指针或已离开窗口 */ }
  }
  function release(pointerId) {
    if (surface.hasPointerCapture(pointerId)) surface.releasePointerCapture(pointerId)
  }
  function point(event, rect) {
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }
  function inkPoint(event, rect, view) {
    const worldPoint = screenToWorld(view, point(event, rect))
    const limit = CANVAS_LIMITS.coordinate
    const coordinate = value => inkCoordinate(Math.max(-limit, Math.min(limit, value)))
    const pressure = event.pointerType === 'pen' && event.pressure > 0 ? inkPressure(event.pressure * 100) : 50
    return [coordinate(worldPoint.x), coordinate(worldPoint.y), pressure]
  }

  function touchCenter() {
    const [first, second] = touches.values()
    if (!second) return { point: first, distance: 0 }
    return {
      point: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
      distance: Math.hypot(first.x - second.x, first.y - second.y),
    }
  }
  function rebaseTouch() {
    touchView = touches.size ? { ...touchCenter(), view: { ...current().view } } : null
  }

  function pointerDown(event, spaceHeld) {
    const canvas = current()
    if (!canvas) return false
    if (gesture) {
      if (event.pointerType === 'touch' && gesture.pointerType === 'touch' && gesture.id !== event.pointerId) {
        const first = gesture
        discardGesture()
        touches.set(first.id, first.lastPoint)
        touches.set(event.pointerId, point(event, first.rect))
        capture(first.id)
        capture(event.pointerId)
        rebaseTouch()
      }
      return true
    }
    const hardwareEraser = event.pointerType === 'pen' && (event.button === 5 || Boolean(event.buttons & 32))
    if (tool === 'select' && !hardwareEraser) return false
    if (event.button === 1 || spaceHeld) return false
    if (event.button !== 0 && !hardwareEraser) return true
    if (touches.size && event.pointerType === 'pen') cancel()
    if (touches.size && event.pointerType !== 'touch') return true
    const rect = surface.getBoundingClientRect()
    event.preventDefault()
    if (event.pointerType === 'touch' && (!drawWithTouch || touches.size)) {
      if (touches.size < 2) {
        touches.set(event.pointerId, point(event, rect))
        capture(event.pointerId)
        rebaseTouch()
      }
      return true
    }
    if (!allowsPoint(screenToWorld(canvas.view, point(event, rect)))) return false
    surface.focus({ preventScroll: true })
    capture(event.pointerId)
    const type = hardwareEraser ? 'erase' : tool
    const base = { id: event.pointerId, pointerType: event.pointerType, canvasId: canvas.id, type, rect, view: { ...canvas.view } }
    if (type === 'erase') {
      const candidates = canvas.ink.map(stroke => ({ stroke, bounds: inkBounds(stroke) }))
      gesture = { ...base, candidates, erased: new Set(), previous: inkPoint(event, rect, base.view) }
      onCursorChange?.()
    } else {
      const stroke = { id: globalThis.crypto.randomUUID(), tool: type, color, ...styles[type], points: [] }
      const node = document.createElementNS(SVG, 'g')
      const tail = document.createElementNS(SVG, 'path')
      node.setAttribute('data-stroke-preview', stroke.id)
      node.append(tail)
      layer.append(node)
      const gpu = gpuPreview.begin(rect, base.view, canvas.paper)
      gesture = { ...base, stroke, node, tail, gpu, previewStart: 1, previewOutline: false, previousSample: null }
    }
    surface.classList.add('ink-stroking')
    record(event)
    return true
  }

  function record(event) {
    gesture.lastPoint = point(event, gesture.rect)
    const sample = inkPoint(event, gesture.rect, gesture.view)
    if (gesture.type === 'erase') {
      for (const { stroke, bounds } of gesture.candidates) {
        if (gesture.erased.has(stroke.id) || !inkIntersects(stroke, bounds, gesture.previous, sample, ERASER_RADIUS / gesture.view.scale)) continue
        gesture.erased.add(stroke.id)
        nodes.get(stroke.id)?.node.setAttribute('visibility', 'hidden')
      }
      gesture.previous = sample
      return
    }
    const points = gesture.stroke.points
    const last = points.at(-1)
    const finishing = event.type === 'pointerup'
    if (last && finishing) sample[2] = last[2]
    const distance = last ? Math.hypot(sample[0] - last[0], sample[1] - last[1]) * gesture.view.scale : Infinity
    if (distance === 0 || (!finishing && distance < 0.6)) return
    if (points.length >= INK_LIMITS.points) { gesture.full = true; return }
    if (gesture.stroke.tool === 'pen' && last && sample[2] !== last[2]) gesture.variableWidth = true
    // Leave the live tip under the pointer. Its position becomes final as soon as the next sample arrives.
    if (gesture.previousSample) points[points.length - 1] = stabilizeInkPoint(gesture.previousSample, last, sample, gesture.view.scale)
    gesture.previousSample = last
    points.push(sample)
    if (!frame) frame = requestAnimationFrame(paintGesture)
  }

  function paintGesture() {
    frame = 0
    if (!gesture?.stroke) return
    const { stroke, node, tail } = gesture
    if (gesture.gpu) {
      if (gpuPreview.paint(stroke)) return
      gesture.gpu = false
      gpuPreview.clear()
    }
    const variableWidth = Boolean(gesture.variableWidth)
    if (gesture.previewOutline !== variableWidth) {
      // The first pressure change can turn a formerly uniform line into an outline.
      node.replaceChildren(tail)
      gesture.previewStart = 0
      gesture.previewOutline = variableWidth
    }
    const chunk = 96
    // The newest sample is provisional. A centerline corner also uses its next point.
    const stableEnd = stroke.points.length - (variableWidth ? 1 : 2)
    while (gesture.previewStart + chunk <= stableEnd) {
      const part = document.createElementNS(SVG, 'path')
      node.insertBefore(part, tail)
      const start = gesture.previewStart, end = start + chunk
      paintStroke(part, stroke, { variableWidth, start, end })
      gesture.previewStart = end
    }
    paintStroke(tail, stroke, { variableWidth, start: gesture.previewStart })
  }

  function pointerMove(event) {
    if (touches.has(event.pointerId)) {
      touches.set(event.pointerId, point(event, surface.getBoundingClientRect()))
      const target = touchCenter()
      const scale = touchView.distance ? touchView.view.scale * target.distance / touchView.distance : touchView.view.scale
      const view = zoomAt(touchView.view, touchView.point, scale)
      setView({ ...view, x: view.x + target.point.x - touchView.point.x, y: view.y + target.point.y - touchView.point.y })
      return true
    }
    if (!gesture) return false
    if (event.pointerId !== gesture.id) return true
    if (event.pointerType === 'mouse' && event.buttons === 0) return finish(event, true)
    for (const sample of event.getCoalescedEvents?.() ?? []) record(sample)
    record(event)
    return true
  }

  function discardGesture() {
    if (!gesture) return
    cancelAnimationFrame(frame)
    frame = 0
    const finished = gesture
    gesture = null
    surface.classList.remove('ink-stroking')
    if (finished.type === 'erase') onCursorChange?.()
    if (finished.gpu) gpuPreview.clear()
    finished.node?.remove()
    for (const id of finished.erased ?? []) nodes.get(id)?.node.removeAttribute('visibility')
    release(finished.id)
  }

  function finish(event, accept) {
    if (touches.delete(event.pointerId)) {
      rebaseTouch()
      release(event.pointerId)
      return true
    }
    if (!gesture || gesture.id !== event.pointerId) return false
    const finished = gesture
    if (accept && event.type === 'pointerup') record(event)
    discardGesture()
    const canvas = current()
    if (!accept || canvas?.id !== finished.canvasId) return true
    if (finished.stroke) {
      if (commit([...canvas.ink, finished.stroke], finished.stroke) && finished.full) notify('已保存本笔。单笔已达长度上限，可以继续写下一笔。')
    } else if (finished.erased.size) {
      commit(canvas.ink.filter(stroke => !finished.erased.has(stroke.id)))
    }
    return true
  }

  function cancel() {
    discardGesture()
    const ids = [...touches.keys()]
    touches.clear()
    touchView = null
    for (const id of ids) release(id)
  }

  function cursorStyle(scale) {
    if (tool === 'erase' || gesture?.type === 'erase') return { color: '#697588', diameter: ERASER_RADIUS * 2 }
    const style = styles[tool]
    return style ? { color, diameter: style.width * scale } : null
  }

  return {
    panel, toggle, paint, pointerDown, pointerMove, finish, cancel, setTool, toggleTouch, penStyle: () => ({ color, ...styles.pen }),
    cursorStyle, brushSettings, setBrushStyle,
    active: () => tool !== 'select',
    busy: () => Boolean(gesture) || touches.size > 0,
  }
}
