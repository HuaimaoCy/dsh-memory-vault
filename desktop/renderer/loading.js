// Waiting is a readable status, with no animated splash or artificial delay.
// 应用启动动画（#alaya-startup 由 index.html 静态提供，动画结束后由本函数
// 移除；超时兜底 2.4s，保证任何环境下都不残留）。
export function dismissStartup() {
  const overlay = document.getElementById('alaya-startup')
  if (!overlay) return
  overlay.addEventListener('animationend', event => { if (event.target === overlay) overlay.remove() })
  setTimeout(() => overlay.remove(), 2400)
}
export function createLoadingStatus({ label = '正在处理…', compact = false, hidden = false } = {}) {
  const element = document.createElement('section')
  element.className = `loading-status${compact ? ' compact' : ''}`
  element.hidden = hidden
  element.setAttribute('role', 'status')
  element.setAttribute('aria-live', 'polite')
  element.setAttribute('aria-busy', String(!hidden))
  const dot = document.createElement('span')
  dot.className = 'loading-dot'; dot.setAttribute('aria-hidden', 'true')
  const text = document.createElement('p'); text.className = 'loading-label'
  element.append(dot, text)
  const setLabel = value => { text.textContent = value }
  setLabel(label)
  return {
    element, setLabel,
    show(value = label) { setLabel(value); element.hidden = false; element.setAttribute('aria-busy', 'true') },
    hide() { element.hidden = true; element.setAttribute('aria-busy', 'false') },
    destroy() { element.remove() },
  }
}
