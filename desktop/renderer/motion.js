/**
 * 极小的弹簧动画工具。
 *
 * 只做一件事：把一个数值从当前值弹到目标值，帧率由 rAF 驱动，只写
 * transform/opacity（合成器友好）。参数沿用 Apple 的 damping / response：
 * - damping 1.0 = 临界阻尼，不过冲；0.8 左右 = 轻微回弹，只在手势带速度时用。
 * - response 是「多快到达」，不是时长；弹簧没有固定时长。
 *
 * 两个约束：
 * 1) 永远从「当前屏幕上的值」起步，所以中断/反向不会跳变；
 * 2) 系统开了「减少动态效果」时退化成一次短淡入，不再位移。
 */

const prefersReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** 数值弹簧；返回一个可以提前结束的函数。 */
export function springValue({ from = 0, to = 1, velocity = 0, damping = 1, response = 0.35, onFrame, onDone }) {
  if (typeof onFrame !== 'function') throw new TypeError('springValue 需要 onFrame')
  if (prefersReducedMotion()) {
    onFrame(to)
    if (typeof onDone === 'function') onDone()
    return () => {}
  }
  // response → 自然角频率；damping → 阻尼比。这两个就是 Apple 的两个参数。
  const omega = (2 * Math.PI) / Math.max(response, 0.05)
  const zeta = Math.max(damping, 0.05)
  let x = from
  let v = velocity
  let frame = 0
  let last = 0
  const step = (now) => {
    if (!last) last = now
    // 单帧最多推进 32ms（后台标签页回来时不要一步跳完）
    const elapsed = Math.min(now - last, 32)
    last = now
    // 固定 1ms 子步，保证不同帧率下手感一致
    const slices = Math.max(1, Math.round(elapsed))
    const dt = elapsed / 1000 / slices
    for (let index = 0; index < slices; index++) {
      const acceleration = -omega * omega * (x - to) - 2 * zeta * omega * v
      v += acceleration * dt
      x += v * dt
    }
    if (Math.abs(x - to) < 0.0008 && Math.abs(v) < 0.02) {
      onFrame(to)
      if (typeof onDone === 'function') onDone()
      return
    }
    onFrame(x)
    frame = requestAnimationFrame(step)
  }
  frame = requestAnimationFrame(step)
  return () => cancelAnimationFrame(frame)
}

/**
 * 大表面入场：面板从 6px 外弹回原位，透明度同时跟上。
 * 出场不做弹簧（面板一旦隐藏就没有可抓的對象），只保留即时消失。
 * 0.7.23 起把 distance 从 12 收到 6：面板动 12px 在 1 秒内回弹，
 * 视觉上就是「抖一下」，而层级关系靠材质与投影已经说清楚了。
 */
export function enterPanel(element, { distance = 6, axis = 'x', damping = 1, response = 0.28 } = {}) {
  if (!element) return
  if (prefersReducedMotion()) return
  element.dataset.motionState = 'entering'
  element.style.willChange = 'opacity'
  springValue({
    from: 0,
    to: 1,
    damping,
    response,
    onFrame: value => {
      element.style.opacity = String(Math.min(1, 0.35 + value * 0.65))
      // distance 为 0 时只做淡入：贴边的全高面板一旦位移就会探出窗口。
      if (distance !== 0) element.style.transform = axis === 'y' ? `translate3d(0, ${(1 - value) * distance}px, 0)` : `translate3d(${(1 - value) * distance}px, 0, 0)`
    },
    onDone: () => {
      element.style.removeProperty('transform')
      element.style.removeProperty('opacity')
      element.style.removeProperty('will-change')
      element.dataset.motionState = 'idle'
    },
  })
}

/** 对话框入场：几乎不缩放地淡入（0.995 只够让边界「出现」而不是「弹出来」）。 */
export function enterDialog(dialog, { scale = 0.995, response = 0.26 } = {}) {
  if (!dialog) return
  if (prefersReducedMotion()) return
  dialog.style.willChange = 'transform, opacity'
  springValue({
    from: 0,
    to: 1,
    response,
    onFrame: value => {
      dialog.style.transform = `scale(${scale + (1 - scale) * value})`
      dialog.style.opacity = String(Math.min(1, 0.55 + value * 0.45))
    },
    onDone: () => {
      dialog.style.removeProperty('transform')
      dialog.style.removeProperty('opacity')
      dialog.style.removeProperty('will-change')
    },
  })
}

/** 轻提示：从下方 6px 弹进来。 */
export function enterToast(element) {
  if (!element) return
  if (prefersReducedMotion()) return
  springValue({
    from: 0,
    to: 1,
    response: 0.3,
    onFrame: value => {
      element.style.transform = `translate(-50%, ${(1 - value) * 6}px)`
    },
    onDone: () => element.style.removeProperty('transform'),
  })
}
