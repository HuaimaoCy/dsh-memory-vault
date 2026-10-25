/**
 * 光学几何：圆角矩形的有符号距离场（SDF）。
 *
 * 约定：x/y 以元素左上角为原点，y 向下（与 DOM 一致，不是数学课本的 y 向上）。
 * 返回值 d：d < 0 在玻璃内部，d = 0 在边界，d > 0 在外部，单位是 CSS px。
 *
 * 所有模块共享这一套坐标与符号约定；换成 WebGL 时只需要把 y 轴翻一次，
 * 不要在别处再做符号翻转，否则法线与位移会互相抵消。
 */

/** 形状预设。radius 传 null 表示「按形状自动」：pill 取半高，circle 取半宽。 */
export function radiusFor({ shape = 'roundedRect', width, height, radius = 0 }) {
  const half = Math.min(width, height) / 2
  if (shape === 'circle') return half
  if (shape === 'pill') return half
  return Math.min(Math.max(Number(radius) || 0, 0), half)
}

/** 圆角矩形 SDF：q = |p - c| - (b - r)，再取 max 与长度。 */
export function signedDistance({ x, y, width, height, radius = 0 }) {
  const w = Math.max(Number(width) || 0, 1)
  const h = Math.max(Number(height) || 0, 1)
  const r = radiusFor({ shape: 'roundedRect', width: w, height: h, radius })
  const qx = Math.abs(x - w / 2) - (w / 2 - r)
  const qy = Math.abs(y - h / 2) - (h / 2 - r)
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
  const inside = Math.min(Math.max(qx, qy), 0)
  return outside + inside - r
}

/**
 * SDF 的解析梯度（指向形状外部，单位向量）。
 * 直边段就是轴向单位向量；圆角段是「圆心 → 该点」的方向。
 * 用解析值而不是有限差分：法线在边缘是二阶敏感量，差分会在圆角处出现台阶。
 */
export function sdfGradient({ x, y, width, height, radius = 0 }) {
  const w = Math.max(Number(width) || 0, 1)
  const h = Math.max(Number(height) || 0, 1)
  const r = radiusFor({ shape: 'roundedRect', width: w, height: h, radius })
  const dx = x - w / 2
  const dy = y - h / 2
  const ax = w / 2 - r
  const ay = h / 2 - r
  if (Math.abs(dx) > ax || Math.abs(dy) > ay) {
    const ox = Math.max(Math.abs(dx) - ax, 0) * Math.sign(dx || 1)
    const oy = Math.max(Math.abs(dy) - ay, 0) * Math.sign(dy || 1)
    const length = Math.hypot(ox, oy)
    if (length < 1e-6) return { x: 0, y: 0 }
    return { x: ox / length, y: oy / length }
  }
  if (Math.abs(dx) > Math.abs(dy)) return { x: Math.sign(dx || 1), y: 0 }
  return { x: 0, y: Math.sign(dy || 1) }
}

/** 采样一张 SDF 图：给调试与 CPU 单元测试用，也是 WebGL 版的对照物。 */
export function buildDistanceField({ width, height, radius = 0, shape = 'roundedRect' }) {
  const w = Math.max(Math.round(width) || 1, 1)
  const h = Math.max(Math.round(height) || 1, 1)
  const r = radiusFor({ shape, width: w, height: h, radius })
  const data = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) data[y * w + x] = signedDistance({ x: x + 0.5, y: y + 0.5, width: w, height: h, radius: r })
  }
  return { width: w, height: h, data }
}

/** 形状的包围盒里「有效玻璃区域」的采样范围（外扩 bezel 用于取到边缘外侧的法线）。 */
export function sampleBounds({ width, height, bezelWidth = 0 }) {
  const pad = Math.max(0, Number(bezelWidth) || 0) + 2
  return { x: -pad, y: -pad, width: Math.round(width + pad * 2), height: Math.round(height + pad * 2) }
}
