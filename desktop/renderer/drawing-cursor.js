/** An editor-only brush tip. A tool change updates the same dot at the last position. */
export function createDrawingCursor(host) {
  const dot = host.ownerDocument.createElement('span')
  dot.className = 'mb-drawing-cursor'
  dot.setAttribute('aria-hidden', 'true')
  dot.hidden = true
  host.append(dot)

  let active = false
  let point = null
  return {
    move(event) {
      const { left, top, width, height } = host.getBoundingClientRect()
      const x = event.clientX - left, y = event.clientY - top
      if (x < 0 || x >= width || y < 0 || y >= height) return
      point = { x, y }
      dot.style.transform = `translate3d(${x}px,${y}px,0) translate(-50%,-50%)`
      if (active && dot.hidden) dot.hidden = false
    },
    setStyle(style) {
      active = Boolean(style)
      if (style) {
        // Keep the indicator visible with hairlines and compact at extreme zoom.
        dot.style.width = `${Math.min(32, 2 + style.diameter)}px`
        dot.style.backgroundColor = style.color
      }
      const hidden = !active || !point
      if (dot.hidden !== hidden) dot.hidden = hidden
    },
    position: () => point,
    reset() {
      point = null
      dot.hidden = true
    },
  }
}
