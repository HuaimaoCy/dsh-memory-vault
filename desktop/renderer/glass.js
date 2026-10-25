/**
 * 材质引擎：把「哪些面是玻璃」这件事从 CSS 里拆出来，交给这一层统一标记与驱动。
 *
 * 设计取舍
 * 1) 不新增 HTML 结构。渲染层已经有 .side/.bar/drawer/dialog 这些节点，引擎按
 *    选择器给它们打 `data-glass-surface`，CSS 只消费属性。动态浮层（命令面板、
 *    捕获面板、对话框、浮层菜单）由 MutationObserver 自动纳入，避免每个调用点都
 *    记得加类名。
 * 2) 玻璃是「界面层」：只有 chrome/panel/float/hud/control 五类面会被标记，
 *    内容卡片、正文、表格永远不是玻璃。
 * 3) 指针光源、按压、分级都写 CSS 变量或 data 属性，动画本身留在 CSS 里；
 *    只有进入/离开高光这种需要从「当前值」起步的收尾用 motion.js 的弹簧。
 * 4) 分级优先顺序：系统可访问性 > 设备能力 > 用户显式选择 > 默认档位。
 *    flat 档只是把 tier 写出去，CSS 自己撤掉 backdrop-filter。
 */

import { springValue } from './motion.js'

/** 分级：full 有边缘色散，balanced 是默认，flat 是不透明回退。 */
export const GLASS_TIERS = Object.freeze(['full', 'balanced', 'flat'])

/**
 * 表面表：顺序即优先级。一个节点同时命中多条时，先出现的赢（例如 .btn 在
 * .bar 里，控件优先于容器，但容器会作为「大面」单独参与指针光源）。
 */
export const GLASS_SURFACES = Object.freeze([
  { kind: 'control', label: '控件', selectors: ['.nav', '.btn', '.icon-button', '.segment', '.search-wrap', '.brand-mark', '.ws-segment', '.ws-preset', '.qc-mode'] },
  { kind: 'hud', label: '状态提示', selectors: ['#status', '.loading-status'] },
  { kind: 'float', label: '浮层', selectors: ['.command-palette', '.quick-capture', '.qc-panel', '.curation-popover', '.ws-panel', '.alaya-preview', '.mb-dialog', 'dialog'] },
  { kind: 'panel', label: '侧板', selectors: ['.drawer', '.mb-detail', '.mb-ai-side'] },
  { kind: 'chrome', label: '框架', selectors: ['.side', '.bar', '.mb-side', '.mb-bar', '.bar .toolbar-actions', '.mb-bar .toolbar-actions'] },
])

/** 大面积：指针停在控件上时，容器仍然要跟着亮，否则侧栏的光源会「卡住」。 */
const LARGE_KINDS = new Set(['chrome', 'panel', 'float'])

const SURFACE_ATTRIBUTE = 'data-glass-surface'
const PRESS_ATTRIBUTE = 'data-glass-pressed'

const supports = (property, value) => {
  if (typeof CSS === 'undefined' || typeof CSS.supports !== 'function') return false
  try { return CSS.supports(property, value) } catch { return false }
}
const media = query => typeof matchMedia === 'function' && matchMedia(query).matches

/**
 * 能力探测。在没有 window/document 的环境（Node 测试、构建期）返回「全部不支持」，
 * 让调用方自然退化到 flat，而不是抛错。
 */
export function glassCapabilities() {
  const empty = {
    backdropFilter: false, backdropFilterUrl: false, reducedMotion: true, reducedTransparency: false,
    forcedColors: false, contrastMore: false, hardwareConcurrency: 0, finePointer: false, pointerLight: false,
  }
  if (typeof window === 'undefined' || typeof document === 'undefined') return empty
  const reducedMotion = media('(prefers-reduced-motion: reduce)')
  const finePointer = media('(hover: hover) and (pointer: fine)')
  return {
    backdropFilter: supports('backdrop-filter', 'blur(1px)') || supports('-webkit-backdrop-filter', 'blur(1px)'),
    backdropFilterUrl: supports('backdrop-filter', 'url(#alaya-glass-probe)'),
    reducedMotion,
    reducedTransparency: media('(prefers-reduced-transparency: reduce)'),
    forcedColors: media('(forced-colors: active)'),
    contrastMore: media('(prefers-contrast: more)'),
    hardwareConcurrency: typeof navigator === 'undefined' ? 0 : Number(navigator.hardwareConcurrency ?? 0),
    finePointer,
    // 两个条件都满足才会装配指针光源：触屏没有指针，减少动态效果时不追指针。
    pointerLight: finePointer && !reducedMotion,
  }
}

/**
 * 分级判定（纯函数，测试直接覆盖）。
 *
 * 顺序是**无障碍优先**：系统级的可访问性偏好永远压过用户的显式选择。
 * 理由是这几种偏好不是审美偏好——用户打开高对比或关闭透明度，通常是因为
 * 看不清。曾经选过 full 的用户，不该因为一次旧选择就让系统设置失效。
 *
 * 1. forced-colors（强制色）→ flat
 * 2. prefers-contrast: more（提高对比度）→ flat
 * 3. prefers-reduced-transparency: reduce（减少透明度）→ flat
 * 4. 能力探测：没有 backdrop-filter、或只有 1–2 核 → flat
 * 5. 用户显式选择（full 不支持 SVG 背景滤镜时退到 balanced）
 * 6. 其余 → balanced。full 永远不自动选中：边缘色散只在 lab 里验证过。
 */
export function resolveTier({ requested, capabilities } = {}) {
  const caps = capabilities ?? glassCapabilities()
  if (caps.forcedColors) return 'flat'
  if (caps.contrastMore) return 'flat'
  if (caps.reducedTransparency) return 'flat'
  if (caps.backdropFilter === false) return 'flat'
  if (Number(caps.hardwareConcurrency) > 0 && Number(caps.hardwareConcurrency) <= 2) return 'flat'
  if (requested === 'full' && caps.backdropFilterUrl === false) return 'balanced'
  if (requested && GLASS_TIERS.includes(requested)) return requested
  return 'balanced'
}

/** 指针在面内的归一化坐标、离面中心的极角（CSS 用来转 conic 高光）。 */
export function glareFor({ width, height, x, y }) {
  const w = Math.max(Number(width) || 0, 1)
  const h = Math.max(Number(height) || 0, 1)
  const gx = Math.min(Math.max((Number(x) || 0) / w, 0), 1)
  const gy = Math.min(Math.max((Number(y) || 0) / h, 0), 1)
  // 0deg 指向正上方，顺时针增大；CSS conic-gradient 的 0deg 也是正上方。
  const angle = (Math.atan2(gx - 0.5, 0.5 - gy) * 180) / Math.PI
  return { gx, gy, angle }
}

const readStored = key => {
  try { return localStorage.getItem(key) } catch { return null }
}
const writeStored = (key, value) => {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch { /* 存储被禁用时只影响记忆，不影响本次会话 */ }
}

let instance = null

/** 幂等挂载：重复调用返回同一个实例，避免重复监听。 */
export function mountGlass({ root, tier, storageKey = 'alaya.glass' } = {}) {
  if (instance) return instance
  const target = root ?? (typeof document === 'undefined' ? null : document)
  if (!target || typeof document === 'undefined') {
    // Node（测试、构建期）没有 DOM：返回一个不抛错的空实例，分级恒为 flat。
    return {
      tier: () => 'flat', capabilities: () => glassCapabilities(),
      setTier: value => resolveTier({ requested: value, capabilities: glassCapabilities() }),
      refresh: () => {}, destroy: () => {}, surfaces: () => [],
    }
  }
  instance = createInstance({ root: target, tier, storageKey })
  return instance
}

export function setGlassTier(tier) {
  return instance ? instance.setTier(tier) : 'flat'
}

function createInstance({ root, tier: initialTier, storageKey }) {
  const capabilities = glassCapabilities()
  const doc = root.ownerDocument ?? document
  const host = doc.documentElement
  const known = new Set()
  const sizes = new WeakMap()
  const glares = new WeakMap()
  const pressed = new Set()
  let pointerSurface = null
  let frame = 0
  let pending = null
  let currentTier = 'balanced'
  let destroyed = false

  const capabilitiesNow = () => {
    // 系统偏好可以在运行中改变（对比度、减少动态效果），每次判定都重新读。
    const live = glassCapabilities()
    for (const key of Object.keys(live)) capabilities[key] = live[key]
    return capabilities
  }

  // ---- 光学引擎（full 档） ---------------------------------------------------
  // 后端与数学都在 optical/ 里；这里只负责「哪些面注册进去、什么时候启用」。
  // 工具条、搜索、浮层与侧栏共用背景取样。侧栏图形按内缩后的伪元素尺寸注册。
  let opticalEngine = null
  let opticalLoading = null
  const OPTICAL_SELECTORS = ['.bar .toolbar-actions', '.mb-bar .toolbar-actions', '.search-wrap', '.side', '.mb-side', '[data-optical-lens]', '[data-glass-surface="float"]']

  const opticalTargets = () => {
    const list = []
    for (const selector of OPTICAL_SELECTORS) {
      for (const node of host.querySelectorAll(selector)) {
        if(node.closest('[data-settings-layout]') && !node.hasAttribute('data-optical-lens'))continue
        if (node.getAttribute(SURFACE_ATTRIBUTE) === 'float' && !node.isConnected) continue
        list.push(node)
      }
    }
    return list
  }

  const registerOpticalTargets = () => {
    if (!opticalEngine) return
    for (const node of opticalTargets()) {
      if (opticalEngine.registered?.(node)) continue
      const rect = node.getBoundingClientRect()
      const panel = node.matches('.side, .mb-side')
      const lens = node.hasAttribute('data-optical-lens')
      const material = getComputedStyle(node, panel ? '::after' : null)
      const radius = Number.parseFloat(material.borderTopLeftRadius) || 0
      const inset = panel ? Number.parseFloat(material.left) || 0 : 0
      opticalEngine.register(node, { radius, autoRadius:true, pseudo:panel?'::after':null, inset, bezelWidth:lens?3:panel?12:Math.min(12,Math.max(7,rect.height*.23)), thickness:lens?2:panel?7:5.5, displacementScale:lens?1.3:2.6, ior:1.46, profile:'arc', lensStrength:lens ? .025 : 0, blur:lens?0:panel?10:node.matches('[data-glass-surface="float"]')?8:3.5 })
    }
  }

  const mountOptical = async () => {
    if (opticalEngine || opticalLoading) return opticalLoading
    opticalLoading = import('./optical/glass-engine.js').then(module => {
      // import 期间用户可能已经切到实心或开启了系统高对比。
      if (destroyed || currentTier !== 'full') return null
      opticalEngine = module.createGlassEngine({ document: doc, quality: 'full' })
      registerOpticalTargets()
      doc.documentElement.dataset.glassRefraction = 'on'
      return opticalEngine
    }).catch(() => null).finally(() => { opticalLoading = null })
    return opticalLoading
  }

  const unmountOptical = () => {
    opticalEngine?.dispose()
    opticalEngine = null
    delete doc.documentElement.dataset.glassRefraction
  }
  const onLensPress=event=>{
    if(opticalEngine?.registered(event.target))opticalEngine.update(event.target,{lensStrength:event.detail.pressed?.12:.025})
  }

  const applyTier = (value, { persist = true } = {}) => {
    const resolved = resolveTier({ requested: value, capabilities: capabilitiesNow() })
    currentTier = resolved
    host.dataset.glassTier = resolved
    if (resolved === 'flat' || !capabilities.pointerLight) {
      if (frame) cancelAnimationFrame(frame)
      frame = 0
      pending = null
      for (const node of known) {
        const light = glares.get(node)
        light?.cancel?.()
        if (light) light.opacity = 0
        for (const name of ['--glass-glare-x', '--glass-glare-y', '--glass-glare-o', '--glass-rim-angle']) node.style.removeProperty(name)
      }
      releaseAll()
    }
    // 只有用户显式选择才写偏好；挂载时的默认档不落盘，否则以后改默认值就再也
    // 影响不到这些用户（他们的 localStorage 里已经钉死了一个旧默认）。
    if (persist) writeStored(storageKey, value ?? null)
    // full 档就是折射档：按需加载光学引擎，离开时释放（贴图、滤镜、DOM 全撤）。
    // 动态 import 而不是静态引入：balanced/flat 的用户不该为这套东西付费。
    if (typeof window !== 'undefined') {
      if (resolved === 'full') void mountOptical()
      else unmountOptical()
    }
    host.dispatchEvent(new CustomEvent('glass:tier', { bubbles: true, detail: { tier: resolved, capabilities: { ...capabilitiesNow() } } }))
    return resolved
  }

  const tag = node => {
    if (!(node instanceof Element)) return
    if (node.hasAttribute(SURFACE_ATTRIBUTE)) { known.add(node); return }
    for (const surface of GLASS_SURFACES) {
      if (surface.selectors.some(selector => node.matches?.(selector))) {
        node.setAttribute(SURFACE_ATTRIBUTE, surface.kind)
        node.style.setProperty('--glass-press', '0')
        known.add(node)
        if(node.matches('.side,.mb-side') && !node.querySelector(':scope > .sidebar-coating')){
          const coating=doc.createElement('div');coating.className='sidebar-coating';coating.setAttribute('aria-hidden','true');node.prepend(coating)
          const rim=doc.createElement('div');rim.className='sidebar-rim';rim.setAttribute('aria-hidden','true');node.append(rim)
        }
        return
      }
    }
  }

  const tagTree = node => {
    tag(node)
    for (const child of node.querySelectorAll?.('*') ?? []) tag(child)
  }

  const refresh = () => {
    tagTree(root === doc ? doc.body ?? host : root)
    for (const node of known) if (!node.isConnected) known.delete(node)
  }

  // ---- 指针光源 -------------------------------------------------------------
  const setGlare = (node, opacity, targetOpacity) => {
    const state = glares.get(node) ?? { opacity: 0, cancel: null }
    glares.set(node, state)
    state.cancel?.()
    if (Math.abs(state.opacity - targetOpacity) < 0.005) {
      state.opacity = targetOpacity
      node.style.setProperty('--glass-glare-o', targetOpacity.toFixed(3))
      return
    }
    state.cancel = springValue({
      from: state.opacity, to: targetOpacity, response: 0.34, damping: 1,
      onFrame: value => {
        state.opacity = value
        node.style.setProperty('--glass-glare-o', value.toFixed(3))
      },
    })
  }

  const surfacesUnder = target => {
    const node = target instanceof Element ? target : null
    if (!node) return []
    const list = []
    const inner = node.closest(`[${SURFACE_ATTRIBUTE}]`)
    if (inner) list.push(inner)
    const outer = inner?.parentElement?.closest(`[${SURFACE_ATTRIBUTE}="chrome"],[${SURFACE_ATTRIBUTE}="panel"],[${SURFACE_ATTRIBUTE}="float"]`)
    if (outer && LARGE_KINDS.has(outer.getAttribute(SURFACE_ATTRIBUTE)) && outer !== inner) list.push(outer)
    return list
  }

  const moveGlare = event => {
    if (destroyed || currentTier === 'flat' || !capabilities.pointerLight) return
    pending = event
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      const current = pending
      pending = null
      if (!current) return
      const next = surfacesUnder(current.target)
      const rects = next.map(node => [node, node.getBoundingClientRect()])
      for (const node of next) {
        const rect = rects.find(([candidate]) => candidate === node)[1]
        const { gx, gy, angle } = glareFor({ width: rect.width, height: rect.height, x: current.clientX - rect.left, y: current.clientY - rect.top })
        node.style.setProperty('--glass-glare-x', gx.toFixed(4))
        node.style.setProperty('--glass-glare-y', gy.toFixed(4))
        node.style.setProperty('--glass-rim-angle', `${angle.toFixed(1)}deg`)
        if (glares.get(node)?.opacity !== 1) setGlare(node, 0, 1)
      }
      // 指针已经离开的面，高光弹簧收回；不要瞬间归零，否则光源会「跳」。
      for (const node of known) {
        if (next.includes(node)) continue
        if ((glares.get(node)?.opacity ?? 0) > 0.002) setGlare(node, 0, 0)
      }
      pointerSurface = next[0] ?? null
    })
  }

  const leaveWindow = () => {
    for (const node of known) if ((glares.get(node)?.opacity ?? 0) > 0.002) setGlare(node, 0, 0)
    pointerSurface = null
  }

  // ---- 按压 -----------------------------------------------------------------
  const press = node => {
    if (!node || pressed.has(node)) return
    pressed.add(node)
    node.setAttribute(PRESS_ATTRIBUTE, '')
    node.style.setProperty('--glass-press', '1')
  }
  const release = node => {
    if (!node || !pressed.has(node)) return
    pressed.delete(node)
    node.removeAttribute(PRESS_ATTRIBUTE)
    node.style.setProperty('--glass-press', '0')
  }
  const releaseAll = () => { for (const node of [...pressed]) release(node) }

  const onPointerDown = event => {
    if (currentTier === 'flat' || !capabilities.pointerLight) return
    const node = event.target instanceof Element ? event.target.closest(`[${SURFACE_ATTRIBUTE}]`) : null
    if (node) press(node)
  }
  const onPointerUp = () => releaseAll()

  // ---- 尺寸 -----------------------------------------------------------------
  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(entries => {
    for (const entry of entries) {
      const box = entry.contentRect
      sizes.set(entry.target, { width: box.width, height: box.height })
      entry.target.style.setProperty('--glass-w', `${Math.round(box.width)}px`)
      entry.target.style.setProperty('--glass-h', `${Math.round(box.height)}px`)
    }
  }) : null

  const observeSizes = () => {
    if (!resizeObserver) return
    for (const node of known) resizeObserver.observe(node)
  }

  // ---- 动态浮层 -------------------------------------------------------------
  const mutationObserver = typeof MutationObserver === 'function' ? new MutationObserver(records => {
    let added = false
    for (const record of records) {
      for (const node of record.removedNodes) {
        if (node.nodeType !== 1 || node.isConnected) continue
        for (const target of [node, ...node.querySelectorAll(`[${SURFACE_ATTRIBUTE}]`)]) {
          if (opticalEngine?.registered(target)) opticalEngine.unregister(target)
          known.delete(target)
          resizeObserver?.unobserve(target)
        }
      }
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue
        tagTree(node)
        added = true
      }
    }
    if (added) { observeSizes(); registerOpticalTargets() }
  }) : null

  const mediaWatcher = {
    contrast: typeof matchMedia === 'function' ? matchMedia('(prefers-contrast: more)') : null,
    forced: typeof matchMedia === 'function' ? matchMedia('(forced-colors: active)') : null,
    motion: typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null,
    transparency: typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-transparency: reduce)') : null,
  }
  const onMediaChange = () => applyTier(readStored(storageKey) ?? initialTier, { persist: false })
  // 系统偏好变化时 Chromium 会派发 matchMedia 的 change；但有些环境（远程桌面、
  // 部分主题切换器、以及 CDP 的媒体模拟）只改媒体状态不派发事件。窗口重新获得
  // 焦点时再判定一次，代价可以忽略，也能覆盖「用户去系统设置改完回来」这条最常见的路径。
  const onRecheck = () => { if (!destroyed) applyTier(readStored(storageKey) ?? initialTier, { persist: false }) }

  // ---- 生命周期 -------------------------------------------------------------
  refresh()
  doc.addEventListener('glass:lens-press',onLensPress)
  const stored = readStored(storageKey)
  currentTier = applyTier(stored ?? initialTier ?? (document.documentElement.dataset.glassTier || null), { persist: false })
  observeSizes()
  mutationObserver?.observe(doc.body ?? host, { childList: true, subtree: true })
  for (const query of Object.values(mediaWatcher)) query?.addEventListener?.('change', onMediaChange)
  window.addEventListener('focus', onRecheck)
  document.addEventListener('visibilitychange', onRecheck)
  // 始终装配一次，处理函数根据实时能力退出，系统偏好在运行中切换也能生效。
  window.addEventListener('pointermove', moveGlare, { passive: true })
  window.addEventListener('pointerdown', onPointerDown, { passive: true })
  window.addEventListener('pointerup', onPointerUp, { passive: true })
  window.addEventListener('pointercancel', onPointerUp, { passive: true })
  window.addEventListener('blur', leaveWindow)
  document.addEventListener('pointerleave', leaveWindow)

  const api = {
    tier: () => currentTier,
    capabilities: () => ({ ...capabilitiesNow() }),
    setTier: value => applyTier(value),
    // 系统偏好可能在不派发媒体事件的情况下变化（远程桌面、部分主题切换器）。
    // 外部工具与测试可以主动要求重新判定一次。
    recheck: onRecheck,
    refresh: () => { refresh(); observeSizes() },
    /** 光学引擎（仅 full 档存在）：外部 perf 脚本用它读指标。 */
    engine: () => opticalEngine,
    opticalMetrics: () => (opticalEngine ? opticalEngine.metrics() : null),
    surfaces: () => [...known].map(node => ({
      node, kind: node.getAttribute(SURFACE_ATTRIBUTE), size: sizes.get(node) ?? null, glare: glares.get(node)?.opacity ?? 0,
    })),
    destroy: () => {
      destroyed = true
      doc.removeEventListener('glass:lens-press',onLensPress)
      unmountOptical()
      if (frame) cancelAnimationFrame(frame)
      window.removeEventListener('pointermove', moveGlare)
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
      window.removeEventListener('blur', leaveWindow)
      window.removeEventListener('focus', onRecheck)
      document.removeEventListener('visibilitychange', onRecheck)
      document.removeEventListener('pointerleave', leaveWindow)
      mutationObserver?.disconnect()
      resizeObserver?.disconnect()
      for (const query of Object.values(mediaWatcher)) query?.removeEventListener?.('change', onMediaChange)
      for (const node of [...known]) {
        for (const property of ['--glass-glare-x', '--glass-glare-y', '--glass-glare-o', '--glass-rim-angle', '--glass-press', '--glass-w', '--glass-h']) node.style.removeProperty(property)
        node.removeAttribute(SURFACE_ATTRIBUTE)
        node.removeAttribute(PRESS_ATTRIBUTE)
      }
      for (const state of [...pressed]) release(state)
      known.clear()
      instance = null
    },
  }
  if (typeof window !== 'undefined') window.alayaGlass = api
  return api
}
