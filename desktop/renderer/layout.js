// 通用布局模块：可拖动分隔条（滑块）与界面偏好持久化。
// 只负责指针位移与回调——宽度怎么算、应用到哪个元素、复位到什么值，
// 全部由调用方决定；本模块不包含任何具体面板的知识。
// 偏好持久化不再绑定 localStorage：createPrefStore 让调用方注入读写后端
// （0.7.9 起笔记本偏好存笔记本数据库，渲染层 localStorage 清零）。
export function createPrefStore({ read, write, clear }) {
  return {
    readPrefs: (key, fallback = {}) => {
      try {
        const saved = JSON.parse(read(key) ?? '{}')
        return saved && typeof saved === 'object' && !Array.isArray(saved) ? { ...fallback, ...saved } : { ...fallback }
      } catch { return { ...fallback } }
    },
    writePrefs: (key, prefs) => { try { write(key, JSON.stringify(prefs)) } catch { /* 存储不可用时静默降级为本次会话生效 */ } },
    clearPrefs: key => { try { clear(key) } catch { /* 同上 */ } },
  }
}

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
