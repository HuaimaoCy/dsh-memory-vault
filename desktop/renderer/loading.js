// Waiting is a readable status, with no animated splash or artificial delay.
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
