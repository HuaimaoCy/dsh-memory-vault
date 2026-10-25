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

const mountThirdParty = async (engine, { tint, backdropBlur, saturate }) => {
  const { LiquidGlass } = await import(THIRD_PARTY)
  const row = document.querySelector(`.stage-row[data-engine="${engine}"]`)
  for (const shape of SHAPES) {
    const cell = document.createElement('div')
    cell.className = 'lg-cell'
    cell.dataset.kind = shape.kind
    applyGeometry(cell, shape)
    row.append(cell)
    const props = {
      radius: shape.r,
      ...PRESETS[shape.preset],
      // 只在「对齐」行覆盖这三项，原版行保持组件默认
      ...(tint === undefined ? {} : { tint }),
      ...(backdropBlur === undefined ? {} : { backdropBlur }),
      ...(saturate === undefined ? {} : { saturate }),
      'data-kind': shape.kind,
      style: { position: 'absolute', left: 0, top: 0, width: '100%', height: '100%' },
    }
    createRoot(cell).render(createElement(LiquidGlass, props,
      createElement('span', { className: 'label' }, shape.label)))
  }
  return row
}

const init = async () => {
  buildNative('alaya-css')
  const refractionRow = buildNative('alaya-refraction')
  // B 行：实验档接管背景采样。只作用于 B 行——真实集成里 root 是应用根，这里用行根。
  const refraction = enableRefraction(refractionRow, { band: 14, scale: 30, maxFilters: 8 })
  await mountThirdParty('xiaojiaenen-default', {})
  await mountThirdParty('xiaojiaenen-aligned', { tint: 'rgba(255, 255, 255, 0.70)', backdropBlur: 20, saturate: 1.75 })
  // 等第三方的 ResizeObserver（100ms 防抖 + 一帧）把贴图算完
  await new Promise(done => setTimeout(done, 700))

  const thirdParty = [...document.querySelectorAll('.stage-row[data-engine^="xiaojiaenen"] .liquid-glass')]
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
      filters: document.querySelectorAll('svg[aria-hidden="true"] defs filter').length,
      maps: document.querySelectorAll('svg[aria-hidden="true"] feImage').length,
    },
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
    const inner = cell.classList.contains('lg-cell') ? cell.querySelector('.liquid-glass') : cell
    const rect = cell.getBoundingClientRect()
    const target = inner ?? cell
    const style = getComputedStyle(target)
    return {
      engine,
      kind: cell.dataset.kind,
      x: rect.x, y: rect.y, width: rect.width, height: rect.height,
      radius: Number.parseFloat(getComputedStyle(cell).borderTopLeftRadius) || 0,
      materialRadius: Number.parseFloat(style.borderTopLeftRadius) || 0,
      mounted: Boolean(inner),
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
