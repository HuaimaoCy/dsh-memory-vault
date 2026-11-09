/** 笔迹用世界坐标记录，第三个分量是 0–100 的笔压。 */
export const INK_LIMITS = { strokes: 4000, points: 8192, bytes: 4 * 1024 * 1024, minWidth: 0.25, maxWidth: 32 }
export const INK_COLORS = [
  { value: '#18202e', label: '墨黑' }, { value: '#1267ed', label: '亮蓝' },
  { value: '#22c65d', label: '亮绿' }, { value: '#ffbd00', label: '亮黄' },
  { value: '#ff3652', label: '亮红' },
]
export const inkCoordinate = value => Math.round(value * 1000) / 1000
export const inkPressure = value => Math.round(value * 10) / 10

/** Reduce small lateral deviations while keeping pen pressure and intentional turns. */
export function stabilizeInkPoint(previous, point, next, scale) {
  const dx = next[0] - previous[0], dy = next[1] - previous[1]
  const lengthSquared = dx * dx + dy * dy
  if (!lengthSquared) return point
  const fraction = ((point[0] - previous[0]) * dx + (point[1] - previous[1]) * dy) / lengthSquared
  if (fraction <= 0 || fraction >= 1) return point
  const shiftX = previous[0] + dx * fraction - point[0]
  const shiftY = previous[1] + dy * fraction - point[1]
  const deviation = Math.hypot(shiftX, shiftY) * scale
  // Measure the correction on screen so zooming does not change the jitter threshold.
  if (deviation === 0 || deviation >= 2.5) return point
  const weight = 0.6 * Math.min(1, (2.5 - deviation) / 1.25)
  return [inkCoordinate(point[0] + shiftX * weight), inkCoordinate(point[1] + shiftY * weight), point[2]]
}

export function normalizeInk(raw, coordinateLimit) {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > INK_LIMITS.strokes) throw new Error('画布笔迹数量无效')
  const ids = new Set()
  return raw.map(stroke => {
    if (!stroke || typeof stroke.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(stroke.id) || ids.has(stroke.id)
      || !['pen', 'marker'].includes(stroke.tool) || typeof stroke.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(stroke.color)
      || !Number.isFinite(stroke.width) || stroke.width < INK_LIMITS.minWidth || stroke.width > INK_LIMITS.maxWidth
      || !Array.isArray(stroke.points) || !stroke.points.length || stroke.points.length > INK_LIMITS.points) {
      throw new Error('画布笔迹数据无效')
    }
    ids.add(stroke.id)
    const points = stroke.points.map(point => {
      if (!Array.isArray(point) || point.length !== 3 || !point.every(Number.isFinite)
        || Math.abs(point[0]) > coordinateLimit || Math.abs(point[1]) > coordinateLimit
        || point[2] < 0 || point[2] > 100) throw new Error('画布笔迹坐标无效')
      return [inkCoordinate(point[0]), inkCoordinate(point[1]), inkPressure(point[2])]
    })
    return { id: stroke.id, tool: stroke.tool, color: stroke.color, width: stroke.width, points }
  })
}

export function inkRadius(stroke, point) {
  return stroke.width / 2 * (stroke.tool === 'marker' ? 1 : 0.35 + 1.3 * point[2] / 100)
}

function outlineRadius(stroke, index) {
  const { points } = stroke
  const radius = inkRadius(stroke, points[index])
  if (stroke.tool === 'marker' || index === 0 || index === points.length - 1) return radius
  // Blend pressure changes across adjacent samples, keeping the true endpoint radii.
  return (inkRadius(stroke, points[index - 1]) + radius * 2 + inkRadius(stroke, points[index + 1])) / 4
}

export function inkBounds(stroke) {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity
  for (let index = 0; index < stroke.points.length; index += 1) {
    const [x, y] = stroke.points[index]
    const radius = outlineRadius(stroke, index)
    left = Math.min(left, x - radius)
    top = Math.min(top, y - radius)
    right = Math.max(right, x + radius)
    bottom = Math.max(bottom, y + radius)
  }
  return { x: left, y: top, w: right - left, h: bottom - top }
}

function pointDistance(point, start, end) {
  const dx = end[0] - start[0], dy = end[1] - start[1]
  const length = dx * dx + dy * dy
  const fraction = length ? Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / length)) : 0
  return Math.hypot(point[0] - start[0] - dx * fraction, point[1] - start[1] - dy * fraction)
}

function segmentsCross(a, b, c, d) {
  const side = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
  return side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0
}

/** 橡皮检测整段移动，快速扫过笔迹也能擦除。 */
export function inkIntersects(stroke, bounds, start, end, radius) {
  if (Math.max(start[0], end[0]) + radius < bounds.x || Math.min(start[0], end[0]) - radius > bounds.x + bounds.w
    || Math.max(start[1], end[1]) + radius < bounds.y || Math.min(start[1], end[1]) - radius > bounds.y + bounds.h) return false
  const points = stroke.points
  if (points.length === 1) return pointDistance(points[0], start, end) <= radius + inkRadius(stroke, points[0])
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1], b = points[index]
    const reach = radius + Math.max(outlineRadius(stroke, index - 1), outlineRadius(stroke, index))
    if (segmentsCross(a, b, start, end) || Math.min(pointDistance(a, start, end), pointDistance(b, start, end),
      pointDistance(start, a, b), pointDistance(end, a, b)) <= reach) return true
  }
  return false
}

const pair = (x, y) => `${inkCoordinate(x)} ${inkCoordinate(y)}`

function smoothCenterline(points, width) {
  const [firstX, firstY] = points[0]
  let path = `M${pair(firstX, firstY)}`
  if (points.length === 1) return path + 'l0 0'
  const span = Math.max(1.5, Math.min(4, width))
  for (let index = 1; index < points.length - 1; index += 1) {
    const [previousX, previousY] = points[index - 1]
    const [x, y] = points[index]
    const [nextX, nextY] = points[index + 1]
    const inX = x - previousX, inY = y - previousY
    const outX = nextX - x, outY = nextY - y
    const incoming = Math.hypot(inX, inY), outgoing = Math.hypot(outX, outY)
    const cosine = incoming && outgoing ? (inX * outX + inY * outY) / (incoming * outgoing) : 1
    // A tiny staircase step may be perpendicular, but a longer corner is intentional.
    if (cosine > 0.9998 || cosine < -0.65 || (cosine < 0.35 && Math.min(incoming, outgoing) > span)) {
      path += `L${pair(x, y)}`
      continue
    }
    const before = Math.min(0.5, span / incoming), after = Math.min(0.5, span / outgoing)
    path += `L${pair(x - inX * before, y - inY * before)}Q${pair(x, y)} ${pair(x + outX * after, y + outY * after)}`
  }
  const [lastX, lastY] = points.at(-1)
  return path + `L${pair(lastX, lastY)}`
}

/** Shared SVG styling for live strokes, reopened boards and exported paper. */
export function inkSVGAttributes(stroke, pressureOutline) {
  const opacity = stroke.tool === 'marker' ? '.35' : '1'
  const first = stroke.points[0]
  if (pressureOutline !== undefined || (stroke.tool === 'pen' && stroke.points.some(point => point[2] !== first[2]))) {
    return { d: pressureOutline ?? inkOutline(stroke), fill: stroke.color, stroke: 'none', opacity }
  }
  const width = inkRadius(stroke, first) * 2
  return { d: smoothCenterline(stroke.points, width), fill: 'none', stroke: stroke.color,
    'stroke-width': inkCoordinate(width), 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity }
}

// One compound fill keeps the pressure-sensitive outline continuous at its joins.
export function inkOutline(stroke, start = 0, end = stroke.points.length) {
  let path = ''
  for (let index = start; index < end; index += 1) {
    const [x, y] = stroke.points[index]
    const r = inkCoordinate(outlineRadius(stroke, index))
    const diameter = inkCoordinate(r * 2)
    path += `M${pair(x - r, y)}a${r} ${r} 0 1 0 ${diameter} 0a${r} ${r} 0 1 0 -${diameter} 0Z`
    const previous = stroke.points[index - 1]
    if (!previous) continue
    const [px, py] = previous
    const length = Math.hypot(x - px, y - py)
    if (!length) continue
    const nx = (py - y) / length, ny = (x - px) / length
    const previousRadius = inkCoordinate(outlineRadius(stroke, index - 1))
    path += `M${pair(px + nx * previousRadius, py + ny * previousRadius)}L${pair(x + nx * r, y + ny * r)}`
      + `L${pair(x - nx * r, y - ny * r)}L${pair(px - nx * previousRadius, py - ny * previousRadius)}Z`
  }
  return path
}
