// 通用布局模块：可拖动分隔条（滑块）与界面偏好持久化。
// 只负责指针位移与回调——宽度怎么算、应用到哪个元素、复位到什么值，
// 全部由调用方决定；本模块不包含任何具体面板的知识。
export const readPrefs = (key, fallback = {}) => {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? '{}')
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? { ...fallback, ...saved } : { ...fallback }
  } catch { return { ...fallback } }
}
export const writePrefs = (key, prefs) => { try { localStorage.setItem(key, JSON.stringify(prefs)) } catch { /* 存储不可用时静默降级为本次会话生效 */ } }
export const clearPrefs = key => { try { localStorage.removeItem(key) } catch { /* 同上 */ } }

// attachSplitter(element, { onStart, onResize({dx,dy}), onReset })
// pointerdown 捕获指针并回调 onStart（记录起始宽度等），pointermove 派发
// 相对起点的累计位移，up / cancel / 失焦结束，双击回调 onReset。拖动期间
// body 挂 data-mb-dragging，由 CSS 禁止选中文本并统一光标。
export function attachSplitter(element, { onStart, onResize, onReset } = {}) {
  let origin = null
  element.addEventListener('pointerdown', event => {
    if (event.button > 0 || origin) return
    origin = { x: event.clientX, y: event.clientY }
    try { element.setPointerCapture(event.pointerId) } catch { /* 合成事件没有活动指针 */ }
    document.body.dataset.mbDragging = 'splitter'
    event.preventDefault()
    onStart?.()
  })
  element.addEventListener('pointermove', event => {
    if (!origin) return
    onResize?.({ dx: event.clientX - origin.x, dy: event.clientY - origin.y })
  })
  const finish = () => { if (!origin) return; origin = null; delete document.body.dataset.mbDragging }
  element.addEventListener('pointerup', finish)
  element.addEventListener('pointercancel', finish)
  element.addEventListener('lostpointercapture', finish)
  element.addEventListener('dblclick', () => { finish(); onReset?.() })
}
