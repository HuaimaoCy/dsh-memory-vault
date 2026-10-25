/**
 * 后端 A：SVG 位移滤镜（实时 DOM 背景）。
 *
 * 这是唯一能「直接折射真实界面」的路线：把位移贴图喂给 feDisplacementMap，
 * 再用 backdrop-filter 采样玻璃背后的合成结果。代价是每个面一张独立滤镜，
 * 所以这里做了两级缓存：
 *   mapCache    按几何 + 光学参数缓存位移贴图（PNG data URI，最贵的一步）
 *   filterCache 按同一 key 缓存 <filter> 节点（DOM 创建也不便宜）
 *
 * 滤镜范围按真实位移与模糊支撑区外扩；反射/中央磨砂使用原生合成层。
 */
import { buildDisplacementMap, buildReflectionMap, encodeMapDataUrl } from '../optics.js'

const SVG_NS = 'http://www.w3.org/2000/svg'
export const FILTER_PREFIX = 'alaya-optical'

export function createSvgBackend({ document: doc = globalThis.document, maxFilters = 16 } = {}) {
  if (!doc?.createElementNS) return { supported: false, apply: () => null, release: () => {}, dispose: () => {}, metrics: () => ({ supported: false }) }
  const mapCache = new Map()
  const filterCache = new Map()
  const bindings = new Map()
  let nextId = 0
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
    (Number(params.ior) || 1.5).toFixed(2), Number(params.displacementScale ?? 30).toFixed(2), params.profile || 'smooth', Number(params.blur ?? .6).toFixed(2), Number(params.lensStrength||0).toFixed(2),
  ].join(':')

  const mapFor = (key, params) => {
    const cached = mapCache.get(key)
    if (cached) { metrics.mapHits++; return cached }
    metrics.mapMisses++
    const map = buildDisplacementMap(params)
    const url = encodeMapDataUrl(map, { document: doc })
    const surface = buildReflectionMap(params)
    const reflection = encodeMapDataUrl(surface, { document:doc })
    const frostMask = encodeMapDataUrl(surface.frostMask, { document:doc })
    const edgeMask = encodeMapDataUrl(surface.edgeMask, { document:doc })
    const entry = url ? { url, reflection, frostMask, edgeMask, filterScale: map.filterScale } : null
    if (entry) mapCache.set(key, entry)
    return entry
  }

  const filterFor = (key, params, entry) => {
    const cached = filterCache.get(key)
    if (cached) { metrics.filterHits++; return cached }
    if (filterCache.size >= maxFilters) {
      // 只回收无人使用的精确尺寸贴图，不能把别的尺寸拉伸到当前面上。
      const active = new Set(bindings.values())
      const unused = [...filterCache.keys()].find(candidate => !active.has(candidate))
      if (!unused) { mapCache.delete(key); return null }
      doc.getElementById(filterCache.get(unused))?.remove()
      filterCache.delete(unused)
      mapCache.delete(unused)
      metrics.evictions++
    }
    metrics.filterMisses++
    mount()
    const id = `${FILTER_PREFIX}-${nextId++}`
    const filter = doc.createElementNS(SVG_NS, 'filter')
    filter.setAttribute('id', id)
    // 过去固定 200% 会把大侧栏的每个合成阶段扩大为四倍面积。
    // 现在按真实位移 + 3σ 模糊支撑区外扩，不裁掉需要的背景样本。
    const padding=Math.ceil(Math.max(entry.filterScale/2,(params.blur ?? .6)*3))+2
    filter.setAttribute('filterUnits','userSpaceOnUse')
    filter.setAttribute('primitiveUnits','userSpaceOnUse')
    filter.setAttribute('x',String(-padding))
    filter.setAttribute('y',String(-padding))
    filter.setAttribute('width',String(Math.round(params.width)+padding*2))
    filter.setAttribute('height',String(Math.round(params.height)+padding*2))
    filter.setAttribute('color-interpolation-filters', 'sRGB')
    const image = doc.createElementNS(SVG_NS, 'feImage')
    image.setAttribute('href', entry.url)
    image.setAttribute('x', '0')
    image.setAttribute('y', '0')
    image.setAttribute('width', String(Math.round(params.width)))
    image.setAttribute('height', String(Math.round(params.height)))
    image.setAttribute('preserveAspectRatio', 'none')
    image.setAttribute('result', 'map')
    // 8-bit PNG 的 128 对齐到滤镜的精确 .5，中间平面不能产生全局平移。
    const neutral = doc.createElementNS(SVG_NS, 'feFlood')
    neutral.setAttribute('flood-color', '#808080')
    neutral.setAttribute('result', 'neutral-map')
    const mapOver = doc.createElementNS(SVG_NS, 'feComposite')
    mapOver.setAttribute('in', 'map')
    mapOver.setAttribute('in2', 'neutral-map')
    mapOver.setAttribute('operator', 'over')
    mapOver.setAttribute('result', 'opaque-map')
    const channels = doc.createElementNS(SVG_NS, 'feComponentTransfer')
    channels.setAttribute('in', 'opaque-map')
    channels.setAttribute('result', 'centered-map')
    for (const channel of ['R','G']) {
      const func = doc.createElementNS(SVG_NS, `feFunc${channel}`)
      func.setAttribute('type', 'linear')
      func.setAttribute('slope', String(255/254))
      func.setAttribute('intercept', String(-1/254))
      channels.append(func)
    }
    const displacement = doc.createElementNS(SVG_NS, 'feDisplacementMap')
    displacement.setAttribute('in', 'SourceGraphic')
    displacement.setAttribute('in2', 'centered-map')
    displacement.setAttribute('scale', String(entry.filterScale))
    displacement.setAttribute('xChannelSelector', 'R')
    displacement.setAttribute('yChannelSelector', 'G')
    displacement.setAttribute('result', 'refracted')
    // SVG 只处理倒角位移。中心磨砂由原生 backdrop 合成，Fresnel 贴图走普通图层。
    filter.append(image, neutral, mapOver, channels, displacement)
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
      if (bindings.get(node) !== key) bindings.delete(node)
      const id = filterFor(key, params, map)
      if (!id) {
        node.removeAttribute('data-glass-refraction')
        node.style.removeProperty('--glass-refraction-filter')
        return null
      }
      bindings.set(node, key)
      node.style.setProperty('--glass-refraction-filter', `url(#${id})`)
      node.style.setProperty('--glass-reflection-map', `url("${map.reflection}")`)
      node.style.setProperty('--glass-frost-mask', `url("${map.frostMask}")`)
      node.style.setProperty('--glass-edge-mask', `url("${map.edgeMask}")`)
      node.style.setProperty('--glass-frost-blur', `${params.blur ?? .6}px`)
      node.setAttribute('data-glass-refraction', 'on')
      return { id, filterScale: map.filterScale, cached: mapHit && filterCache.has(key) }
    },
    release(node) {
      bindings.delete(node)
      node.removeAttribute('data-glass-refraction')
      node.style.removeProperty('--glass-refraction-filter')
      for(const property of ['--glass-reflection-map','--glass-frost-mask','--glass-edge-mask','--glass-frost-blur'])node.style.removeProperty(property)
    },
    dispose() {
      svg?.remove()
      svg = null
      defs = null
      mapCache.clear()
      filterCache.clear()
      bindings.clear()
    },
    metrics() { return { ...metrics, maps: mapCache.size, filters: filterCache.size } }
  }
}
