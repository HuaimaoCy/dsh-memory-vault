/** An editor-only brush tip. A tool change updates the same dot at the last position. */
export function createDrawingCursor(host) {
  const dot = host.ownerDocument.createElement('span')
  dot.className = 'mb-drawing-cursor'
  dot.setAttribute('aria-hidden', 'true')
  dot.hidden = true
  host.append(dot)

  let active = false
  let point = null
  let pending = null
  let frame = 0
  function paintPosition() {
    frame = 0
    const next = pending
    pending = null
    if (!next) return
    const { left, top, width, height } = host.getBoundingClientRect()
    const x = next.x - left, y = next.y - top
    if (x < 0 || x >= width || y < 0 || y >= height) return
    point = { x, y }
    dot.style.transform = `translate3d(${x}px,${y}px,0) translate(-50%,-50%)`
    if (active && dot.hidden) dot.hidden = false
  }
  return {
    move(event) {
      pending = { x: event.clientX, y: event.clientY }
      if (!frame) frame = requestAnimationFrame(paintPosition)
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
    position() {
      if (frame) { cancelAnimationFrame(frame); paintPosition() }
      return point
    },
    reset() {
      cancelAnimationFrame(frame)
      frame = 0
      pending = null
      point = null
      dot.hidden = true
    },
  }
}
