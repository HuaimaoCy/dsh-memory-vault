/**
 * 实验档：真·像素折射（backdrop-filter + feDisplacementMap）。
 *
 * 为什么默认关闭：实测 Chromium 支持 `backdrop-filter: url(#filter)`，背景确实会被
 * 位移，但圆角裁剪会失效、位移贴图在面边缘有接缝，而且不同尺寸下表现不一致
 * （证据见 test-tmp/glass-probe/probe3.png / probe4.png）。这是一种「能跑但不可靠」
 * 的能力，只适合在 glass-lab.html 里对照调参，不适合作为发布默认。
 *
 * 这个模块保持两件事分离：
 * - 纯几何（rimNormalAt / createRimMap）：不碰 DOM，Node 里可测；
 * - DOM 装配（enableRefraction / disableRefraction）：只在调用时才碰 document。
 */

const clampByte = value => Math.min(255, Math.max(0, Math.round(value)))

/**
 * 圆角矩形内侧的法线。signedDistance < 0 在形状内。
 * 先算点到圆角矩形边界的带符号距离，再在 band 宽度内把「离边界多远」映射成
 * 朝外（或朝内）的单位法线：中心为 0 位移，越靠边越强，正好是厚玻璃的观感。
 */
export function rimNormalAt({ width, height, radius = 0, band = 14, x, y }) {
  const w = Math.max(Number(width) || 0, 1)
  const h = Math.max(Number(height) || 0, 1)
  const r = Math.min(Math.max(Number(radius) || 0, 0), Math.min(w, h) / 2)
  const bw = Math.max(Number(band) || 0, 1)
  const px = Number(x) || 0
  const py = Number(y) || 0
  const qx = Math.abs(px - w / 2) - (w / 2 - r)
  const qy = Math.abs(py - h / 2) - (h / 2 - r)
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
  const inside = Math.min(Math.max(qx, qy), 0)
  const distance = outside + inside - r
  if (distance > 0) return { r: 128, g: 128, b: 128, nx: 0, ny: 0, amount: 0, distance }
  // 离边界越近位移越强：边界处 amount=1，深入 band 之后归零（中心因此完全中性）。
  const depth = Math.min(1, -distance / bw)
  const amount = 1 - depth
  let nx = 0
  let ny = 0
  const ax = w / 2 - r
  const ay = h / 2 - r
  const dx = px - w / 2
  const dy = py - h / 2
  if (Math.abs(dx) > ax || Math.abs(dy) > ay) {
    // 圆角区：法线朝外且归一化
    const ox = Math.max(Math.abs(dx) - ax, 0) * Math.sign(dx || 1)
    const oy = Math.max(Math.abs(dy) - ay, 0) * Math.sign(dy || 1)
    const length = Math.hypot(ox, oy) || 1
    nx = ox / length
    ny = oy / length
  } else if (Math.abs(dx) > Math.abs(dy)) nx = Math.sign(dx)
  else ny = Math.sign(dy)
  return {
    r: clampByte(128 + nx * amount * 127),
    g: clampByte(128 + ny * amount * 127),
    b: 128,
    nx, ny, amount, distance,
  }
}

/**
 * 生成一张 RGBA 法线贴图（R=x 通道、G=y 通道、B 固定 128）。
 * 中心平坦（128,128,128 在 feDisplacementMap 里等于不位移），只有边缘带位移。
 */
export function createRimMap({ width, height, radius = 0, band = 14 }) {
  const w = Math.max(Math.round(Number(width) || 1), 1)
  const h = Math.max(Math.round(Number(height) || 1), 1)
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const normal = rimNormalAt({ width: w, height: h, radius, band, x: x + 0.5, y: y + 0.5 })
      const offset = (y * w + x) * 4
      data[offset] = normal.r
      data[offset + 1] = normal.g
      data[offset + 2] = normal.b
      data[offset + 3] = 255
    }
  }
  return { width: w, height: h, data }
}

/** 把参数化成一张 data:image/png（走 canvas → toDataURL，feImage 只认 data URI）。 */
export function rimMapDataUrl({ width, height, radius, band }) {
  if (typeof document === 'undefined') throw new Error('生成贴图需要 document')
  const map = createRimMap({ width, height, radius, band })
  const canvas = document.createElement('canvas')
  canvas.width = map.width
  canvas.height = map.height
  const context = canvas.getContext('2d')
  context.putImageData(new ImageData(map.data, map.width, map.height), 0, 0)
  return canvas.toDataURL('image/png')
}

const SVG_NS = 'http://www.w3.org/2000/svg'
const FILTER_PREFIX = 'alaya-glass-rim'
const REFRACTION_ATTRIBUTE = 'data-glass-refraction'
let mounted = null

/**
 * 打开实验档。返回 { supported, filters, surfaces }；
 * 不支持 backdrop-filter: url() 时什么都不做，调用方据此保持默认档位。
 */
export function enableRefraction(root = document, { band = 14, scale = 30, maxFilters = 8 } = {}) {
  if (typeof document === 'undefined' || typeof CSS === 'undefined' || !CSS.supports?.('backdrop-filter', 'url(#probe)')) {
    return { supported: false, filters: 0, surfaces: 0 }
  }
  disableRefraction()
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('class', 'alaya-glass-filters')
  svg.setAttribute('width', '0')
  svg.setAttribute('height', '0')
  svg.style.position = 'absolute'
  svg.style.pointerEvents = 'none'
  const defs = document.createElementNS(SVG_NS, 'defs')
  svg.append(defs)
  document.body.append(svg)

  const filters = new Map()
  const created = []
  let surfaces = 0
  const nodes = root.querySelectorAll('[data-glass-surface]')
  for (const node of nodes) {
    const rect = node.getBoundingClientRect()
    // 贴图按元素**精确尺寸**生成：分桶会让贴图被拉伸不到 1%，但位移在边缘是二阶敏感量，
    // 这点拉伸就足以让沿边剖面与中位剖面对不上（实测：边缘不稳 12–17 → 6 以下）。
    const width = Math.max(17, Math.round(rect.width))
    const height = Math.max(17, Math.round(rect.height))
    const radius = Math.max(0, Math.round(Number.parseFloat(getComputedStyle(node).borderTopLeftRadius) || 0))
    const key = `${width}x${height}r${radius}`
    if (!filters.has(key)) {
      if (created.length < maxFilters) {
        const id = `${FILTER_PREFIX}-${created.length}`
        const filter = document.createElementNS(SVG_NS, 'filter')
        filter.setAttribute('id', id)
        // 滤镜区域必须比元素大：100% 只覆盖元素本身，贴边取样的位移被裁掉，
        // 实测同一张图在 -50%/200% 下的位移强度是 100% 的 2.3 倍（43.0 vs 18.9）。
        filter.setAttribute('x', '-50%'); filter.setAttribute('y', '-50%')
        filter.setAttribute('width', '200%'); filter.setAttribute('height', '200%')
        filter.setAttribute('color-interpolation-filters', 'sRGB')
        const image = document.createElementNS(SVG_NS, 'feImage')
        image.setAttribute('href', rimMapDataUrl({ width, height, radius, band }))
        image.setAttribute('x', '0'); image.setAttribute('y', '0')
        image.setAttribute('width', String(width)); image.setAttribute('height', String(height))
        image.setAttribute('preserveAspectRatio', 'none')
        image.setAttribute('result', 'map')
        const displacement = document.createElementNS(SVG_NS, 'feDisplacementMap')
        displacement.setAttribute('in', 'SourceGraphic')
        displacement.setAttribute('in2', 'map')
        displacement.setAttribute('scale', String(scale))
        displacement.setAttribute('xChannelSelector', 'R')
        displacement.setAttribute('yChannelSelector', 'G')
        filter.append(image, displacement)
        defs.append(filter)
        created.push(id)
        filters.set(key, id)
      } else {
        // 到达上限时不是跳过这个面，而是复用最接近的一张：宁可尺寸差几像素，
        // 也不要出现「同一块界面里有的面在折射、有的面没有」的割裂。
        const [closest] = [...filters.entries()].sort((a, b) => {
          const [aw, ah] = a[0].split('x').map(Number)
          const [bw, bh] = b[0].split('x').map(Number)
          return Math.abs(aw * ah - width * height) - Math.abs(bw * bh - width * height)
        })[0]
        filters.set(key, filters.get(closest))
      }
    }
    const id = filters.get(key)
    node.setAttribute(REFRACTION_ATTRIBUTE, 'on')
    node.style.setProperty('--glass-refraction-filter', `url(#${id})`)
    surfaces++
  }
  mounted = { svg, filters }
  document.documentElement.dataset.glassRefraction = 'on'
  return { supported: true, filters: created.length, surfaces, reused: filters.size - created.length }
}

export function disableRefraction(root = document) {
  if (typeof document === 'undefined') return false
  mounted?.svg.remove()
  mounted = null
  delete document.documentElement.dataset.glassRefraction
  for (const node of root.querySelectorAll(`[${REFRACTION_ATTRIBUTE}]`)) {
    node.removeAttribute(REFRACTION_ATTRIBUTE)
    node.style.removeProperty('--glass-refraction-filter')
  }
  return true
}
