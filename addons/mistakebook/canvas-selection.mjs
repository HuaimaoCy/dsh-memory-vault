import { A4_SIZE, CANVAS_LIMITS, contentBounds } from './canvas.mjs'
import { inkBounds, inkCoordinate } from './canvas-ink.mjs'
import { shapeBounds } from './canvas-shapes.mjs'

const contains = (outer, inner) => inner.x >= outer.x && inner.y >= outer.y
  && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h

function pointBounds(points) {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity
  for (const [x, y] of points) {
    left = Math.min(left, x)
    top = Math.min(top, y)
    right = Math.max(right, x)
    bottom = Math.max(bottom, y)
  }
  return { x: left, y: top, w: right - left, h: bottom - top }
}

/** Enclosing a small annotation does not also select a larger image behind it. */
export function boxSelection(canvas, bounds) {
  const cards = new Set(), shapes = new Set(), ink = new Set()
  const visibleBounds = [], anchors = []
  const accepts = box => contains(bounds, box) && (!canvas.paper?.enabled || canvas.paper.sheets.some(sheet =>
    box.x < sheet.x + A4_SIZE.w && box.x + box.w > sheet.x
    && box.y < sheet.y + A4_SIZE.h && box.y + box.h > sheet.y))

  for (const card of canvas.cards) {
    if (!accepts(card)) continue
    cards.add(card.id)
    visibleBounds.push(card)
    // Cards only store their top-left coordinate. Their size can extend past the limit.
    anchors.push({ x: card.x, y: card.y, w: 0, h: 0 })
  }
  for (const shape of canvas.shapes) {
    const box = shapeBounds(shape)
    if (!accepts(box)) continue
    shapes.add(shape.id)
    visibleBounds.push(box)
    anchors.push(pointBounds([[shape.x1, shape.y1], [shape.x2, shape.y2]]))
  }
  for (const stroke of canvas.ink) {
    const box = inkBounds(stroke)
    if (!accepts(box)) continue
    ink.add(stroke.id)
    visibleBounds.push(box)
    anchors.push(pointBounds(stroke.points))
  }
  return { cards, shapes, ink, bounds: contentBounds(visibleBounds, 0), anchors: contentBounds(anchors, 0) }
}

/** Use one translation for all objects, with the same precision as document storage. */
export function boxDelta(selection, dx, dy) {
  if (!selection?.anchors) return { dx: 0, dy: 0 }
  const { x, y, w, h } = selection.anchors
  const units = 1000
  const step = selection.cards.size ? units : 1
  const limit = CANVAS_LIMITS.coordinate * units
  const constrain = (distance, start, end) => {
    const lower = Math.ceil((-limit - Math.round(start * units)) / step)
    const upper = Math.floor((limit - Math.round(end * units)) / step)
    const requested = Number.isFinite(distance) ? Math.round(distance * units / step) : 0
    return Math.min(upper, Math.max(lower, requested)) * step / units
  }
  return { dx: constrain(dx, x, x + w), dy: constrain(dy, y, y + h) }
}

/** Keep exactly the selected objects when the same group is dragged again. */
export function offsetBoxSelection(selection, dx, dy) {
  const delta = boxDelta(selection, dx, dy)
  if (!delta.dx && !delta.dy) return selection
  const offset = bounds => ({ ...bounds, x: bounds.x + delta.dx, y: bounds.y + delta.dy })
  return { ...selection, bounds: offset(selection.bounds), anchors: offset(selection.anchors) }
}

export function moveBoxSelection(canvas, selection, dx, dy) {
  const delta = boxDelta(selection, dx, dy)
  if (!delta.dx && !delta.dy) return canvas
  const x = value => inkCoordinate(value + delta.dx)
  const y = value => inkCoordinate(value + delta.dy)
  return {
    ...canvas,
    cards: selection.cards.size ? canvas.cards.map(card => selection.cards.has(card.id)
      ? { ...card, x: x(card.x), y: y(card.y) } : card) : canvas.cards,
    shapes: selection.shapes.size ? canvas.shapes.map(shape => selection.shapes.has(shape.id)
      ? { ...shape, x1: x(shape.x1), y1: y(shape.y1), x2: x(shape.x2), y2: y(shape.y2) } : shape) : canvas.shapes,
    ink: selection.ink.size ? canvas.ink.map(stroke => selection.ink.has(stroke.id)
      ? { ...stroke, points: stroke.points.map(([px, py, pressure]) => [x(px), y(py), pressure]) } : stroke) : canvas.ink,
    updatedAt: new Date().toISOString(),
  }
}
