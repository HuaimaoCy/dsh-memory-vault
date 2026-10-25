/**
 * Alaya Optical Engine：把「光学计算」和「渲染后端」分开的那一层。
 *
 *   geometry → surface → optics     纯数学（无 DOM，Node 可测）
 *        ↓
 *   backends/svg.js                 实时 DOM 背景（backdrop-filter）
 *   backends/webgl.js               自有纹理（WebGL2，可控背景）
 *        ↓
 *   glass-engine.js                 注册、缓存、脏区调度、质量分级、指标
 *
 * 三条性能原则（对应优化方案）：
 *   1. 共享缓存：同一几何 + 光学参数只算一次贴图、只建一个滤镜；
 *   2. 事件驱动：只有 invalidate() 才排一帧，静止时不跑任何循环；
 *   3. 局部更新：只重算「几何变了」的面，高光/角度这类参数不碰贴图。
 */
import { createSvgBackend } from './backends/svg.js'

const DEFAULTS = {
  shape: 'roundedRect',
  radius: 0,
  bezelWidth: 16,
  thickness: 8,
  ior: 1.5,
  displacementScale: 30,
  profile: 'smooth',
}

/** 几何不变时，这些参数变了也只更新属性，不重建贴图。 */
const GEOMETRY_KEYS = ['shape', 'radius', 'bezelWidth', 'thickness', 'ior', 'displacementScale', 'profile', 'blur', 'lensStrength']

export function createGlassEngine({
  document: doc = globalThis.document,
  backend = 'auto',
  quality = 'full',
  /** 帧时间预算（ms）：auto 质量档用它判断是否降级，默认 1.5ms 的玻璃增量 */
  frameBudget = 1.5,
  /** 连续多少个采样超预算才降级 / 多少个采样余裕才升级（滞回，避免画质抖动） */
  downgradeAfter = 6,
  upgradeAfter = 90,
  /** 每帧最多处理几个面（一张贴图的 PNG 编码是几十毫秒级，铺满一屏会卡一下） */
  maxPerFrame = 2,
} = {}) {
  const registrations = new Map()
  const svg = backend === 'webgl' ? { supported: false } : createSvgBackend({ document: doc })
  const state = {
    quality,
    autoQuality: quality === 'auto',
    renders: 0,
    invalidations: 0,
    lastRenderMs: 0,
    samples: [],
    slowStreak: 0,
    fastStreak: 0,
    qualityChanges: [],
    destroyed: false,
  }
  let frame = null
  let listenerCleanup = []
  // 浮层是动态出现/隐藏的：用 IntersectionObserver 在「真的可见」的那一刻标脏，
  // 而不给隐藏面板白算贴图（命令面板 500×600 的贴图编码是几十毫秒）。
  const visibility = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver(entries => {
      let touched = false
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const record = registrations.get(entry.target)
        if (!record) continue
        if (!record.dirty) { record.dirty = true; touched = true }
      }
      if (touched) invalidate()
    }, { rootMargin: '40px' })
    : null

  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

  const geometryKey = params => GEOMETRY_KEYS.map(key => String(params[key])).join('|')

  const measure = (node, options = {}) => {
    const rect = node.getBoundingClientRect()
    // FLIP 只改变显示 transform，不能把缩放中的尺寸烘进静态位移贴图。
    return { width: Math.max(1, Math.round((node.offsetWidth || rect.width) - 2*(options.inset||0))), height: Math.max(1, Math.round((node.offsetHeight || rect.height) - 2*(options.inset||0))) }
  }

  const applyOne = (node, entry) => {
    if (!svg.supported || state.quality === 'flat') return false
    const size = measure(node, entry.options)
    entry.size = size
    const params = { ...entry.options, ...size }
    if (entry.options.autoRadius) params.radius = Number.parseFloat(getComputedStyle(node, entry.options.pseudo).borderTopLeftRadius) || 0
    // 空尺寸（隐藏面板）不生成贴图：滤镜 id 会被复用，但贴图是白算的
    if (params.width < 8 || params.height < 8) { svg.release(node);return false }
    const result = svg.apply(node, params)
    if (!result) return false
    entry.applied = { key: geometryKey(entry.options), filterScale: result.filterScale }
    return true
  }

  /**
   * 渲染一帧。两处克制：
   *   - 每帧最多处理 2 个面：一张贴图的 PNG 编码是几十毫秒级，一次铺 6 个面
   *     就是一次可见的卡顿（首次切到 full 档最容易看到）。剩下的留到下一帧；
   *   - 只处理 dirty 的面：几何没变就不重新量、不重新生成。
   */
  const render = () => {
    const started = now()
    let count = 0
    let rest = 0
    for (const [node, entry] of registrations) {
      if (!node.isConnected) { unregister(node); continue }
      if (!entry.dirty) continue
      if (count >= maxPerFrame) { rest++; continue }
      if (applyOne(node, entry)) count++
      entry.dirty = false
    }
    state.renders++
    state.lastRenderMs = now() - started
    state.lastApplied = count
    if (rest > 0) {
      // 还有没处理完的面：下一帧继续（不阻塞当前帧）
      frame = (globalThis.requestAnimationFrame || (fn => setTimeout(fn, 16)))(() => { frame = null; render() })
    }
    // auto 质量：用「每帧做的活」近似玻璃增量；真实帧时间由 perf 脚本量
    if (state.autoQuality) {
      const cost = state.lastRenderMs
      if (cost > frameBudget) {
        state.slowStreak++
        state.fastStreak = 0
        if (state.slowStreak >= downgradeAfter) downgrade('帧时间超预算')
      } else {
        state.fastStreak++
        state.slowStreak = 0
        if (state.fastStreak >= upgradeAfter) upgrade()
      }
    }
  }

  const downgrade = reason => {
    const order = ['full', 'balanced', 'flat']
    const index = order.indexOf(state.quality)
    if (index < 0 || index >= order.length - 1) return
    state.quality = order[index + 1]
    state.qualityChanges.push({ to: state.quality, reason, at: now() })
    for (const [node] of registrations) { if (node.isConnected) svg.release(node) }
    invalidate()
  }

  const upgrade = () => {
    const order = ['full', 'balanced', 'flat']
    const index = order.indexOf(state.quality)
    if (index <= 0) return
    state.quality = order[index - 1]
    state.qualityChanges.push({ to: state.quality, reason: '稳定期回升', at: now() })
    for (const [node, entry] of registrations) { entry.dirty = true }
    invalidate()
  }

  /** 排一帧（合并同一帧内多次调用）；页面隐藏时直接不排。 */
  const invalidate = () => {
    if (state.destroyed) return
    state.invalidations++
    if (typeof doc !== 'undefined' && doc.visibilityState === 'hidden') return
    if (frame !== null) return
    frame = (globalThis.requestAnimationFrame || (fn => setTimeout(fn, 16)))(() => {
      frame = null
      render()
    })
  }

  // 搜索框展开、布局面板调整等变化不会触发 window.resize。
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(entries => {
    for (const { target } of entries) {
      const entry = registrations.get(target)
      if (!entry) continue
      const size = measure(target, entry.options)
      if (entry.size?.width === size.width && entry.size?.height === size.height) continue
      entry.dirty = true
      invalidate()
    }
  }) : null

  const register = (node, options = {}) => {
    const entry = { options: { ...DEFAULTS, ...options }, dirty: true }
    registrations.set(node, entry)
    visibility?.observe(node)
    resize?.observe(node)
    invalidate()
    return () => unregister(node)
  }

  const unregister = node => {
    registrations.delete(node)
    visibility?.unobserve(node)
    resize?.unobserve(node)
    svg.release(node)
  }

  const update = (node, options = {}) => {
    const entry = registrations.get(node)
    if (!entry) return false
    const next = { ...entry.options, ...options }
    const geometryChanged = GEOMETRY_KEYS.some(key => String(next[key]) !== String(entry.options[key]))
    entry.options = next
    if (geometryChanged) entry.dirty = true
    invalidate()
    return geometryChanged
  }

  /** 窗口尺寸变化：所有面重新量尺寸（滚动不影响玻璃，不监听 scroll）。 */
  const invalidateAll = () => {
    for (const entry of registrations.values()) entry.dirty = true
    invalidate()
  }

  const listen = (target, type, handler, options) => {
    if (!target?.addEventListener) return
    target.addEventListener(type, handler, options)
    listenerCleanup.push(() => target.removeEventListener(type, handler, options))
  }

  if (typeof window !== 'undefined') {
    listen(window, 'resize', invalidateAll, { passive: true })
    listen(window, 'visibilitychange', () => { if (doc.visibilityState === 'visible') invalidateAll() })
  }

  return {
    register,
    update,
    unregister,
    invalidate,
    invalidateAll,
    setQuality(next) {
      state.quality = next
      state.autoQuality = next === 'auto'
      state.slowStreak = 0
      state.fastStreak = 0
      for (const [node] of registrations) { if (node.isConnected) svg.release(node) }
      for (const entry of registrations.values()) entry.dirty = true
      invalidate()
    },
    get quality() { return state.quality },
    registered: node => registrations.has(node),
    metrics() {
      return {
        backend: svg.supported ? 'svg' : 'unavailable',
        quality: state.quality,
        surfaces: registrations.size,
        renders: state.renders,
        invalidations: state.invalidations,
        lastRenderMs: Number(state.lastRenderMs.toFixed(3)),
        lastApplied: state.lastApplied || 0,
        qualityChanges: state.qualityChanges.slice(-4),
        ...svg.metrics(),
      }
    },
    dispose() {
      state.destroyed = true
      if (frame !== null) { (globalThis.cancelAnimationFrame || clearTimeout)(frame); frame = null }
      visibility?.disconnect()
      resize?.disconnect()
      for (const cleanup of listenerCleanup) cleanup()
      listenerCleanup = []
      for (const node of registrations.keys()) svg.release(node)
      svg.dispose()
      registrations.clear()
    }
  }
}
