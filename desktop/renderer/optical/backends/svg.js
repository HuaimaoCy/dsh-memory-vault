/**
 * 后端 A：SVG 位移滤镜（实时 DOM 背景）。
 *
 * 这是唯一能「直接折射真实界面」的路线：把位移贴图喂给 feDisplacementMap，
 * 再用 backdrop-filter 采样玻璃背后的合成结果。代价是每个面一张独立滤镜，
 * 所以这里做了两级缓存：
 *   mapCache    按几何 + 光学参数缓存位移贴图（PNG data URI，最贵的一步）
 *   filterCache 按同一 key 缓存 <filter> 节点（DOM 创建也不便宜）
 *
 * 滤镜区域固定 -50% / 200%：100% 会在元素边界裁掉贴边取样的位移，
 * 实测强度只剩 2.3 分之一（18.9 vs 43.0）。
 */
import { buildDisplacementMap, encodeMapDataUrl } from '../optics.js'

const SVG_NS = 'http://www.w3.org/2000/svg'
export const FILTER_PREFIX = 'alaya-optical'

export function createSvgBackend({ document: doc = globalThis.document, maxFilters = 16 } = {}) {
  if (!doc?.createElementNS) return { supported: false, apply: () => null, release: () => {}, dispose: () => {}, metrics: () => ({ supported: false }) }
  const mapCache = new Map()
  const filterCache = new Map()
  let svg = null
  let defs = null
  let metrics = { supported: true, mapHits: 0, mapMisses: 0, filterHits: 0, filterMisses: 0, evictions: 0 }

  const mount = () => {
    if (svg) return
    svg = doc.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('aria-hidden', 'true')
    svg.setAttribute('class', 'alaya-optical-filters')
    svg.setAttribute('width', '0')
    svg.setAttribute('height', '0')
    svg.style.position = 'absolute'
    svg.style.pointerEvents = 'none'
    defs = doc.createElementNS(SVG_NS, 'defs')
    svg.append(defs)
    doc.body.append(svg)
  }

  const keyOf = params => [
    Math.round(params.width), Math.round(params.height), Math.round(params.radius || 0),
    Math.round(params.bezelWidth || 0), (Number(params.thickness) || 0).toFixed(2),
    (Number(params.ior) || 1.5).toFixed(2), Math.round(params.displacementScale || 30), params.profile || 'smooth',
  ].join(':')

  const mapFor = (key, params) => {
    const cached = mapCache.get(key)
    if (cached) { metrics.mapHits++; return cached }
    metrics.mapMisses++
    const map = buildDisplacementMap(params)
    const url = encodeMapDataUrl(map, { document: doc })
    const entry = url ? { url, filterScale: map.filterScale } : null
    if (entry) mapCache.set(key, entry)
    return entry
  }

  const filterFor = (key, params, entry) => {
    const cached = filterCache.get(key)
    if (cached) { metrics.filterHits++; return cached }
    if (filterCache.size >= maxFilters) {
      // 触顶时复用面积最接近的一张，而不是让这个面干脆没有折射
      let closest = null
      for (const [candidate, id] of filterCache) {
        const [w, h] = candidate.split(':').map(Number)
        if (!closest || Math.abs(w * h - params.width * params.height) < Math.abs(closest.area - params.width * params.height)) {
          closest = { id, area: w * h }
        }
      }
      if (closest) { metrics.evictions++; return closest.id }
    }
    metrics.filterMisses++
    mount()
    const id = `${FILTER_PREFIX}-${filterCache.size}`
    const filter = doc.createElementNS(SVG_NS, 'filter')
    filter.setAttribute('id', id)
    filter.setAttribute('x', '-50%')
    filter.setAttribute('y', '-50%')
    filter.setAttribute('width', '200%')
    filter.setAttribute('height', '200%')
    filter.setAttribute('color-interpolation-filters', 'sRGB')
    const image = doc.createElementNS(SVG_NS, 'feImage')
    image.setAttribute('href', entry.url)
    image.setAttribute('x', '0')
    image.setAttribute('y', '0')
    image.setAttribute('width', String(Math.round(params.width)))
    image.setAttribute('height', String(Math.round(params.height)))
    image.setAttribute('preserveAspectRatio', 'none')
    image.setAttribute('result', 'map')
    const displacement = doc.createElementNS(SVG_NS, 'feDisplacementMap')
    displacement.setAttribute('in', 'SourceGraphic')
    displacement.setAttribute('in2', 'map')
    displacement.setAttribute('scale', String(entry.filterScale))
    displacement.setAttribute('xChannelSelector', 'R')
    displacement.setAttribute('yChannelSelector', 'G')
    filter.append(image, displacement)
    defs.append(filter)
    filterCache.set(key, id)
    return id
  }

  return {
    supported: true,
    /** 给一个元素套上折射滤镜；返回 { id, filterScale, cached } 或 null。 */
    apply(node, params) {
      const key = keyOf(params)
      const mapHit = mapCache.has(key)
      const map = mapFor(key, params)
      if (!map) return null
      const id = filterFor(key, params, map)
      node.style.setProperty('--glass-refraction-filter', `url(#${id})`)
      node.setAttribute('data-glass-refraction', 'on')
      return { id, filterScale: map.filterScale, cached: mapHit && filterCache.has(key) }
    },
    release(node) {
      node.removeAttribute('data-glass-refraction')
      node.style.removeProperty('--glass-refraction-filter')
    },
    dispose() {
      svg?.remove()
      svg = null
      defs = null
      mapCache.clear()
      filterCache.clear()
    },
    metrics() { return { ...metrics, maps: mapCache.size, filters: filterCache.size } }
  }
}
