/**
 * 对照实验的页面侧脚本：把四个引擎按**完全相同的几何**装配到同一张底层背景上，
 * 并暴露 window.LG 给 tests/liquid-glass-compare.mjs 驱动量测。
 *
 * 四个引擎：
 *   A  alaya-css           Alaya 现有 CSS 材质层（glass.css，发布形态）
 *   B  alaya-refraction    Alaya 自研折射实验档（glass-refraction.js）
 *   C1 xiaojiaenen-default 第三方原版，按其 preset 的默认参数
 *   C2 xiaojiaenen-aligned 第三方原版，参数对齐 Alaya 的观感前提（tint / backdropBlur）
 *
 * 为什么会同时跑 C1 与 C2：第三方的默认 tint 是 0.03（几乎全透），Alaya 的 float 面是
 * 0.80→0.60 的白。同样一套折射，隔着 0.03 的白和隔着 0.70 的白是完全不同的两件事。
 * 只跑 C1 会把「它更好」错读成光学更好，而真实原因是它根本没着色。
 */
import React from 'react'
import { createRoot } from 'react-dom'
import { enableRefraction } from '../../../desktop/renderer/glass-refraction.js'

const { createElement } = React
const THIRD_PARTY = '/test-tmp/liquid-glass-probe/package/dist/lib/LiquidGlass.js'

/**
 * 四个面的几何：四行共用，任何引擎都不许改。
 *
 * 只用**元素级**材质面（float / hud / control）：Alaya 的 chrome（.side / .bar /
 * .drawer）把玻璃画在 `::after` 上，元素本身的 backdrop-filter 被显式置为 none
 * （glass.css 第 245–278 行）。那是一条「引擎写不到」的路径，放进同一张图里做光学
 * 对照只会搅浑结论；它作为结构性缺口单独在 facts.chromeSlot 里记录。
 */
const SHAPES = [
  { kind: 'bar', x: 130, y: 30, w: 1180, h: 72, r: 0, surface: 'hud', preset: 'card', label: '顶栏 1180×72 · r0' },
  { kind: 'float', x: 130, y: 122, w: 420, h: 260, r: 16, surface: 'float', preset: 'card', label: '命令面板 420×260 · r16' },
  { kind: 'control', x: 620, y: 132, w: 168, h: 44, r: 8, surface: 'control', preset: 'control', label: '控件 168×44 · r8' },
  { kind: 'pill', x: 620, y: 202, w: 132, h: 40, r: 999, surface: 'control', preset: 'pill', label: '胶囊键 132×40 · r999' },
]

/** 第三方 README 里的「黄金分割」预设。原版行照抄，不改数值。 */
const PRESETS = {
  pill: { bezelWidth: 10, glassThickness: 38, refractionScale: 0.618, blur: 0.2 },
  control: { bezelWidth: 16, glassThickness: 62, refractionScale: 0.618, blur: 0.35 },
  card: { bezelWidth: 26, glassThickness: 100, refractionScale: 0.618, blur: 0.5 },
}

const errors = []
window.addEventListener('error', event => errors.push(String(event.message)))
window.addEventListener('unhandledrejection', event => errors.push(String(event.reason?.message ?? event.reason)))

const pattern = document.getElementById('pattern')
const facts = document.getElementById('probe-facts')

const geometry = shape => ({
  left: `${shape.x}px`, top: `${shape.y}px`, width: `${shape.w}px`, height: `${shape.h}px`, '--r': `${shape.r}px`,
})

/** 自定义属性不能走 Object.assign(style, …)，必须 setProperty。 */
const applyGeometry = (node, shape) => {
  for (const [key, value] of Object.entries(geometry(shape))) {
    if (key.startsWith('--')) node.style.setProperty(key, value)
    else node.style[key] = value
  }
}

const buildNative = engine => {
  const row = document.querySelector(`.stage-row[data-engine="${engine}"]`)
  for (const shape of SHAPES) {
    const node = document.createElement('div')
    node.className = 'shape'
    node.dataset.kind = shape.kind
    node.setAttribute('data-glass-surface', shape.surface)
    applyGeometry(node, shape)
    const label = document.createElement('span')
    label.className = 'label'
    label.textContent = shape.label
    node.append(label)
    row.append(node)
  }
  return row
}

const mountThirdParty = async (engine, { tint, backdropBlur, saturate } = {}) => {
  const { LiquidGlass } = await import(THIRD_PARTY)
  const row = document.querySelector(`.stage-row[data-engine="${engine}"]`)
  const host = document.createElement('div')
  host.style.cssText = 'position:absolute;inset:0'
  row.append(host)
  const overrides = {
    ...(tint === undefined ? {} : { tint }),
    ...(backdropBlur === undefined ? {} : { backdropBlur }),
    ...(saturate === undefined ? {} : { saturate }),
  }
  // 一个 React root 装四个组件：每个组件都用 useId()，分 root 挂载会各自从 r0 重新
  // 编号，filter id 撞车（重复 id 会让 url(#id) 指到别人的贴图）。
  createRoot(host).render(createElement(React.Fragment, null, ...SHAPES.map(shape => createElement(LiquidGlass, {
    key: shape.kind,
    className: 'lg-cell',
    radius: shape.r,
    ...PRESETS[shape.preset],
    ...overrides,
    'data-kind': shape.kind,
    style: {
      position: 'absolute', left: `${shape.x}px`, top: `${shape.y}px`,
      width: `${shape.w}px`, height: `${shape.h}px`,
    },
  }, createElement('span', { className: 'label' }, shape.label)))))
  return row
}

/**
 * 消融实验：用第三方自己的贴图生成器 + 它自己的滤镜链，只把链首的 feGaussianBlur
 * 拿掉，其余一模一样（同尺寸、同位移、同镜面、不着色）。回答的是「它的光学差在
 * 哪一步」，而不是「它的光学好不好」——前者才决定能不能直接套用。
 *
 * 两个面**不着色**（tint 透明）：只有这样，面的像素变化才只能来自滤镜本身；加了
 * 白 tint，材质强度就会被 tint 主导，量到的是「有没有变白」而不是「有没有折射」。
 */
const buildAblation = async () => {
  const { generateLiquidGlassMaps } = await import('/test-tmp/liquid-glass-probe/package/dist/lib/displacementMap.js')
  const row = document.querySelector('.stage-row[data-engine="ablation"]')
  const width = 220
  const height = 260
  const radius = 16
  const maps = generateLiquidGlassMaps({
    width, height, radius, bezelWidth: 26, glassThickness: 100,
    refractiveIndex: 1.5, specularAngleDeg: 60, profile: 'convex_squircle',
  })
  const SVG_NS = 'http://www.w3.org/2000/svg'
  const root = document.createElementNS(SVG_NS, 'svg')
  root.setAttribute('aria-hidden', 'true')
  root.setAttribute('width', '0')
  root.setAttribute('height', '0')
  root.style.cssText = 'position:absolute;pointer-events:none'
  const definition = document.createElementNS(SVG_NS, 'defs')
  root.append(definition)
  document.body.append(root)

  const build = (id, { keepBlur }) => {
    const filter = document.createElementNS(SVG_NS, 'filter')
    filter.setAttribute('id', id)
    filter.setAttribute('x', '0')
    filter.setAttribute('y', '0')
    filter.setAttribute('width', '100%')
    filter.setAttribute('height', '100%')
    filter.setAttribute('color-interpolation-filters', 'sRGB')
    const add = (tag, attributes) => {
      const node = document.createElementNS(SVG_NS, tag)
      for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value))
      filter.append(node)
      return node
    }
    if (keepBlur) add('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: 0.5, result: 'blurred' })
    add('feImage', { href: maps.displacementUrl, x: 0, y: 0, width, height, preserveAspectRatio: 'none', result: 'map' })
    add('feDisplacementMap', {
      in: keepBlur ? 'blurred' : 'SourceGraphic', in2: 'map', scale: 52,
      xChannelSelector: 'R', yChannelSelector: 'G', result: 'displaced',
    })
    add('feColorMatrix', { in: 'displaced', type: 'saturate', values: '1.3', result: 'saturated' })
    add('feImage', { href: maps.specularUrl, x: 0, y: 0, width, height, preserveAspectRatio: 'none', result: 'specular' })
    add('feBlend', { in: 'specular', in2: 'saturated', mode: 'screen' })
    definition.append(filter)
    return [...filter.children].map(node => node.tagName.toLowerCase())
  }

  const variants = [
    { kind: 'orig', id: 'ablation-original', keepBlur: true, label: '原链（链首 feGaussianBlur）' },
    { kind: 'fixed', id: 'ablation-noblur', keepBlur: false, label: '删掉链首 feGaussianBlur' },
  ]
  const chains = {}
  variants.forEach((variant, index) => {
    chains[variant.kind] = build(variant.id, { keepBlur: variant.keepBlur })
    const node = document.createElement('div')
    node.className = 'shape'
    node.dataset.kind = variant.kind
    applyGeometry(node, { kind: variant.kind, x: 130 + index * 260, y: 122, w: width, h: height, r: radius })
    node.style.border = '1px solid rgb(255 255 255 / .35)'
    node.style.backdropFilter = `url(#${variant.id})`
    node.style.webkitBackdropFilter = `url(#${variant.id})`
    const label = document.createElement('span')
    label.className = 'label'
    label.textContent = variant.label
    node.append(label)
    row.append(node)
  })
  return { built: true, chains, mapBytes: [maps.displacementUrl.length, maps.specularUrl.length] }
}

const init = async () => {
  buildNative('alaya-css')
  const refractionRow = buildNative('alaya-refraction')
  // B 行：实验档接管背景采样。只作用于 B 行——真实集成里 root 是应用根，这里用行根。
  const refraction = enableRefraction(refractionRow, { band: 14, scale: 30, maxFilters: 8 })
  await mountThirdParty('xiaojiaenen-default')
  await mountThirdParty('xiaojiaenen-aligned', { tint: 'rgba(255, 255, 255, 0.70)', backdropBlur: 20, saturate: 1.75 })
  // 等第三方的 ResizeObserver（100ms 防抖 + 一帧）把贴图算完
  await new Promise(done => setTimeout(done, 900))
  // 先记录第三方自己的产物，再做消融（消融会往同一份 defs 里追加克隆）
  const thirdParty = [...document.querySelectorAll('.stage-row[data-engine^="xiaojiaenen"] .liquid-glass')]
  const thirdPartyFilters = [...document.querySelectorAll('.liquid-glass svg defs filter')].map(node => node.id)
  const thirdPartyMaps = document.querySelectorAll('.liquid-glass svg feImage').length

  const gl = (() => {
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
    if (!context) return null
    const info = context.getExtension('WEBGL_debug_renderer_info')
    return info ? String(context.getParameter(info.UNMASKED_RENDERER_WEBGL)) : String(context.getParameter(context.RENDERER))
  })()
  const state = {
    tier: document.documentElement.dataset.glassTier ?? null,
    refraction: {
      supported: refraction.supported, filters: refraction.filters, surfaces: refraction.surfaces,
      htmlFlag: document.documentElement.dataset.glassRefraction ?? null,
    },
    thirdParty: {
      mounted: thirdParty.length,
      glass: thirdParty.filter(node => node.classList.contains('is-glass')).length,
      fallback: thirdParty.filter(node => node.classList.contains('is-fallback')).length,
      filters: thirdPartyFilters,
      maps: thirdPartyMaps,
    },
    renderer: gl,
    supportsUrl: CSS.supports('backdrop-filter', 'url(#probe)'),
    userAgent: navigator.userAgent,
    // 结构性缺口：Alaya 的 chrome 面（.side/.bar/.drawer）把玻璃画在 ::after 上，
    // 元素本身的 backdrop-filter 被显式置 none。任何「只在元素上写 backdrop-filter」
    // 的第三方引擎都接管不了这类面——这不是参数问题，是接管点问题。
    chromeSlot: (() => {
      const probe = document.createElement('div')
      probe.className = 'bar'
      probe.setAttribute('data-glass-surface', 'chrome')
      probe.style.cssText = 'position:fixed;left:-2000px;top:0;width:300px;height:60px'
      document.body.append(probe)
      const element = getComputedStyle(probe)
      const pseudo = getComputedStyle(probe, '::after')
      const result = {
        elementBackdropFilter: element.backdropFilter,
        elementBackgroundImage: element.backgroundImage === 'none' ? 'none' : 'gradient',
        afterBackdropFilter: pseudo.backdropFilter,
        afterContent: pseudo.content,
        afterInset: pseudo.inset,
        hasGlassGutter: getComputedStyle(document.documentElement).getPropertyValue('--glass-gutter').trim(),
      }
      probe.remove()
      return result
    })(),
    errors,
  }
  facts.textContent = JSON.stringify(state)
  window.LG = {
    ready: true,
    facts: state,
    layout,
    setEngineVisible,
    setBare,
    setMeasure,
    setScroll,
    frameGaps,
    mapTimings,
    errors,
  }
}

/** 每个面的几何、实际生效的 backdrop-filter、以及第三方组件挂没挂上。 */
const layout = () => [...document.querySelectorAll('.stage-row')].flatMap(row => {
  const engine = row.dataset.engine
  return [...row.querySelectorAll('.shape, .lg-cell')].map(cell => {
    // 第三方的组件根节点同时带 .lg-cell；Alaya 的面就是节点本身。
    const inner = cell.classList.contains('liquid-glass') ? cell : cell.querySelector('.liquid-glass')
    const rect = cell.getBoundingClientRect()
    const target = inner ?? cell
    const style = getComputedStyle(target)
    return {
      engine,
      kind: cell.dataset.kind,
      x: rect.x, y: rect.y, width: rect.width, height: rect.height,
      radius: Number.parseFloat(getComputedStyle(cell).borderTopLeftRadius) || 0,
      materialRadius: Number.parseFloat(style.borderTopLeftRadius) || 0,
      mounted: Boolean(inner) || cell.classList.contains('liquid-glass'),
      backdropFilter: style.backdropFilter,
      backgroundColor: style.backgroundColor,
      backgroundImage: style.backgroundImage.slice(0, 70),
      border: `${style.borderTopWidth} ${style.borderTopStyle} ${style.borderTopColor}`,
      classes: target.className,
      surface: target.getAttribute?.('data-glass-surface') ?? null,
      refractionAttr: target.getAttribute?.('data-glass-refraction') ?? null,
      refractionVar: target.style.getPropertyValue('--glass-refraction-filter') || null,
    }
  })
})

/** 只显示一个引擎（display:none，性能量测用；几何不变）；'*' 表示全部显示。 */
const setEngineVisible = (engine, visible = true) => {
  for (const row of document.querySelectorAll('.stage-row')) {
    row.hidden = visible ? (engine !== '*' && row.dataset.engine !== engine) : true
  }
  return true
}

/**
 * 「无玻璃」基准：只把面**藏起来不画**（visibility），保留布局。
 * 用 display:none 会改文档高度，截图对不齐；visibility 只影响绘制。
 */
const setBare = bare => {
  document.documentElement.dataset.bare = bare ? '1' : '0'
  return bare
}

/** 量测档：藏文字 + 掐投影（见 probe.css）。观感截图保持默认档。 */
const setMeasure = measure => {
  document.documentElement.dataset.measure = measure ? '1' : '0'
  return measure
}

/** 背景位移：模拟「内容从玻璃底下滚过」。 */
const setScroll = px => {
  pattern.style.transform = `translate3d(0, ${-px}px, 0)`
  return px
}

/** 采样 rAF 间隔：背景动画期间的帧率下限（相对比较用）。 */
const frameGaps = async (frames = 140) => {
  pattern.classList.add('is-animating')
  await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))
  const gaps = []
  let last = performance.now()
  await new Promise(done => {
    const tick = now => {
      gaps.push(now - last)
      last = now
      if (gaps.length < frames) requestAnimationFrame(tick)
      else done()
    }
    requestAnimationFrame(tick)
  })
  pattern.classList.remove('is-animating')
  const sorted = [...gaps].sort((a, b) => a - b)
  const pick = q => Number(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))].toFixed(2))
  const dropped = gaps.filter(gap => gap > 20).length
  return {
    frames: gaps.length,
    median: pick(0.5), p95: pick(0.95), max: Number(sorted[sorted.length - 1].toFixed(2)),
    dropped, droppedRatio: Number((dropped / gaps.length).toFixed(3)),
  }
}

/** 位移贴图的生成本钱：第三方的两张贴图 vs Alaya 的一张。 */
const mapTimings = async () => {
  const { generateLiquidGlassMaps } = await import('/test-tmp/liquid-glass-probe/package/dist/lib/displacementMap.js')
  const { createRimMap, rimMapDataUrl } = await import('../../../desktop/renderer/glass-refraction.js')
  const cases = SHAPES.map(shape => ({
    kind: shape.kind, width: shape.w, height: shape.h, radius: shape.r === 999 ? shape.h / 2 : shape.r,
    bezelWidth: PRESETS[shape.preset].bezelWidth, glassThickness: PRESETS[shape.preset].glassThickness,
  }))
  const results = []
  for (const item of cases) {
    const t0 = performance.now()
    const third = generateLiquidGlassMaps({
      width: item.width, height: item.height, radius: item.radius,
      bezelWidth: item.bezelWidth, glassThickness: item.glassThickness,
      refractiveIndex: 1.5, specularAngleDeg: 60, profile: 'convex_squircle',
    })
    const thirdMs = performance.now() - t0
    const t1 = performance.now()
    const map = createRimMap({ width: item.width, height: item.height, radius: item.radius, band: 14 })
    const loopMs = performance.now() - t1
    const t2 = performance.now()
    const url = rimMapDataUrl({ width: item.width, height: item.height, radius: item.radius, band: 14 })
    const encodeMs = performance.now() - t2
    results.push({
      kind: item.kind, width: item.width, height: item.height, radius: item.radius,
      thirdPartyMs: Number(thirdMs.toFixed(2)),
      thirdPartyBytes: third.displacementUrl.length + third.specularUrl.length,
      thirdPartyMaps: 2,
      alayaLoopMs: Number(loopMs.toFixed(2)),
      alayaEncodeMs: Number(encodeMs.toFixed(2)),
      alayaBytes: url.length,
      alayaPixels: map.width * map.height,
    })
  }
  return results
}

init().catch(error => {
  errors.push(String(error?.stack ?? error))
  facts.textContent = `初始化失败：${error?.message ?? error}`
  window.LG = { ready: false, errors }
})
