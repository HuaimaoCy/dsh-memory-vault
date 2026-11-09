import { inkCoordinate } from './canvas-ink.mjs'

export const SHAPE_KINDS = { arrow: '箭头', line: '直线', circle: '圆', square: '正方形' }
export const SHAPE_LIMIT = 400

export function normalizeShapes(raw, coordinateLimit) {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > SHAPE_LIMIT) throw new Error('画布图形数量无效')
  const ids = new Set()
  return Array.from(raw, shape => {
    if (!shape || typeof shape.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(shape.id) || ids.has(shape.id)
      || !Object.hasOwn(SHAPE_KINDS, shape.kind) || typeof shape.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(shape.color)
      || !Number.isFinite(shape.width) || shape.width < 1 || shape.width > 32
      || ![shape.x1, shape.y1, shape.x2, shape.y2].every(Number.isFinite)) throw new Error('画布图形数据无效')
    ids.add(shape.id)
    const position = value => inkCoordinate(Math.min(coordinateLimit, Math.max(-coordinateLimit, value)))
    return { id: shape.id, kind: shape.kind, color: shape.color, width: shape.width,
      x1: position(shape.x1), y1: position(shape.y1), x2: position(shape.x2), y2: position(shape.y2) }
  })
}

function shapeBox({ x1, y1, x2, y2 }) {
  const size = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1))
  return { x: x2 < x1 ? x1 - size : x1, y: y2 < y1 ? y1 - size : y1, size }
}

function arrowWings({ x1, y1, x2, y2, width }) {
  const dx = x2 - x1, dy = y2 - y1
  const length = Math.hypot(dx, dy)
  if (!length) return []
  const head = Math.min(Math.max(8, width * 2), length * 0.42)
  const ux = dx / length, uy = dy / length
  const tailX = x2 - ux * head, tailY = y2 - uy * head, wing = head * 0.36
  return [[tailX + uy * wing, tailY - ux * wing], [tailX - uy * wing, tailY + ux * wing]]
}

export function shapeBounds(shape) {
  const padding = shape.width / 2
  if (shape.kind === 'circle' || shape.kind === 'square') {
    const { x, y, size } = shapeBox(shape)
    return { x: x - padding, y: y - padding, w: size + 2 * padding, h: size + 2 * padding }
  }
  const points = [[shape.x1, shape.y1], [shape.x2, shape.y2]]
  if (shape.kind === 'arrow') points.push(...arrowWings(shape))
  const xs = points.map(([x]) => x), ys = points.map(([, y]) => y)
  const left = Math.min(...xs), top = Math.min(...ys)
  return { x: left - padding, y: top - padding,
    w: Math.max(...xs) - left + 2 * padding, h: Math.max(...ys) - top + 2 * padding }
}

/** Both the editor and the exported sheet use the same SVG geometry. */
export function shapeParts(shape) {
  const { x1, y1, x2, y2, kind } = shape
  if (kind === 'square' || kind === 'circle') {
    const { x, y, size } = shapeBox(shape)
    if (kind === 'square') return [['rect', { x, y, width: size, height: size }]]
    return [['circle', { cx: x + size / 2, cy: y + size / 2, r: size / 2 }]]
  }
  const parts = [['line', { x1, y1, x2, y2 }]]
  if (kind === 'arrow') {
    const [first, last] = arrowWings(shape)
    if (first) parts.push(['polyline', { points: [first, [x2, y2], last].map(point => point.join(',')).join(' ') }])
  }
  return parts
}
