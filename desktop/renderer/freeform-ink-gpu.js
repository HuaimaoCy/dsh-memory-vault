import { INK_LIMITS, outlineRadius } from '../../addons/mistakebook/canvas-ink.mjs'
import { A4_SIZE } from '../../addons/mistakebook/canvas.mjs'

const vertexSource = `#version 300 es
layout(location=0) in vec4 endpoints;
layout(location=1) in vec2 widths;
uniform vec2 viewport;
out vec2 position;
flat out vec4 segment;
flat out vec2 radii;
void main() {
  vec2 delta = endpoints.zw - endpoints.xy;
  float span = length(delta);
  vec2 tangent = span > 0.0 ? delta / span : vec2(1.0, 0.0);
  vec2 normal = vec2(-tangent.y, tangent.x);
  float padding = max(widths.x, widths.y) + 1.0;
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  position = mix(endpoints.xy - tangent * padding, endpoints.zw + tangent * padding, corner.x)
    + normal * mix(-padding, padding, corner.y);
  gl_Position = vec4(position / viewport * vec2(2.0, -2.0) + vec2(-1.0, 1.0), 0.0, 1.0);
  segment = endpoints;
  radii = widths;
}`

const fragmentSource = `#version 300 es
precision highp float;
uniform vec3 color;
in vec2 position;
flat in vec4 segment;
flat in vec2 radii;
out vec4 pixel;
void main() {
  vec2 delta = segment.zw - segment.xy;
  float t = clamp(dot(position - segment.xy, delta) / max(dot(delta, delta), 0.0001), 0.0, 1.0);
  float distanceToEdge = length(position - (segment.xy + t * delta)) - mix(radii.x, radii.y, t);
  float coverage = 1.0 - smoothstep(-0.5, 0.5, distanceToEdge);
  pixel = vec4(color * coverage, coverage);
}`

const floatsPerSegment = 6
const bytesPerSegment = floatsPerSegment * Float32Array.BYTES_PER_ELEMENT
const maxPixels = 8_388_608

function compile(gl, type, source) {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('WebGL shader allocation failed')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader
  gl.deleteShader(shader)
  throw new Error('WebGL ink shader compilation failed')
}

function makeRenderer(canvas) {
  const gl = canvas.getContext('webgl2', {
    alpha: true, antialias: false, depth: false, stencil: false, premultipliedAlpha: true,
    failIfMajorPerformanceCaveat: true, powerPreference: 'high-performance',
  })
  if (!gl) return null
  const program = gl.createProgram()
  if (!program) return null
  try {
    for (const [type, source] of [[gl.VERTEX_SHADER, vertexSource], [gl.FRAGMENT_SHADER, fragmentSource]]) {
      const shader = compile(gl, type, source)
      gl.attachShader(program, shader)
      gl.deleteShader(shader)
    }
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('WebGL ink program linking failed')
    gl.useProgram(program)
    const buffer = gl.createBuffer()
    if (!buffer) throw new Error('WebGL ink buffer allocation failed')
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    const data = new Float32Array(INK_LIMITS.points * floatsPerSegment)
    gl.bufferData(gl.ARRAY_BUFFER, data.byteLength, gl.DYNAMIC_DRAW)
    for (const [index, count, offset] of [[0, 4, 0], [1, 2, 4 * Float32Array.BYTES_PER_ELEMENT]]) {
      gl.enableVertexAttribArray(index)
      gl.vertexAttribPointer(index, count, gl.FLOAT, false, bytesPerSegment, offset)
      gl.vertexAttribDivisor(index, 1)
    }
    // Segments of a stroke share a color. Take maximum coverage so their joins stay seamless.
    gl.enable(gl.BLEND)
    gl.blendEquation(gl.MAX)
    gl.clearColor(0, 0, 0, 0)
    return { gl, data, viewport: gl.getUniformLocation(program, 'viewport'), color: gl.getUniformLocation(program, 'color'),
      viewportLimit: gl.getParameter(gl.MAX_VIEWPORT_DIMS) }
  } catch {
    gl.deleteProgram(program)
    return null
  }
}

function paperClips(paper, view, frame) {
  if (!paper?.enabled) return null
  const { width, height, sx, sy } = frame
  const clips = []
  for (const sheet of paper.sheets) {
    const left = view.x + sheet.x * view.scale
    const top = view.y + sheet.y * view.scale
    const x = Math.max(0, Math.floor(left * sx))
    const y = Math.max(0, Math.floor(top * sy))
    const right = Math.min(width, Math.ceil((left + A4_SIZE.w * view.scale) * sx))
    const bottom = Math.min(height, Math.ceil((top + A4_SIZE.h * view.scale) * sy))
    if (right > x && bottom > y) clips.push([x, height - bottom, right - x, bottom - y])
  }
  return clips
}

/** Hardware preview only. Committed ink still uses the shared vector path. */
export function createGpuInkPreview(surface) {
  const canvas = surface.ownerDocument.createElement('canvas')
  const window = surface.ownerDocument.defaultView
  canvas.className = 'mb-canvas-ink-gpu'
  canvas.hidden = true
  canvas.setAttribute('aria-hidden', 'true')
  surface.append(canvas)
  let renderer = null
  let prepared = false
  let lost = false
  let frame = null

  function prepare() {
    if (prepared || lost) return
    prepared = true
    const initialize = () => {
      if (lost) return
      if (surface.classList.contains('ink-stroking')) {
        // Shader setup can block briefly even in an idle callback. Defer it past an active stroke.
        window.setTimeout(() => window.requestIdleCallback(initialize, { timeout: 1500 }), 250)
        return
      }
      try { renderer = makeRenderer(canvas) } catch { renderer = null }
    }
    window.requestIdleCallback(initialize, { timeout: 1500 })
  }

  function clear() {
    frame = null
    canvas.hidden = true
    delete canvas.dataset.inkPreview
  }

  canvas.addEventListener('webglcontextlost', event => {
    event.preventDefault()
    renderer = null
    lost = true
    clear()
  })
  canvas.addEventListener('webglcontextrestored', () => {
    lost = prepared = false
    prepare()
  })

  function begin(rect, view, paper) {
    if (!renderer || renderer.gl.isContextLost() || !rect.width || !rect.height) return false
    const [maxWidth, maxHeight] = renderer.viewportLimit
    const ratio = Math.min(window.devicePixelRatio || 1, maxWidth / rect.width, maxHeight / rect.height,
      Math.sqrt(maxPixels / (rect.width * rect.height)))
    const width = Math.max(1, Math.floor(rect.width * ratio)), height = Math.max(1, Math.floor(rect.height * ratio))
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height
    frame = { width, height, sx: width / rect.width, sy: height / rect.height, view, count: 0 }
    frame.clips = paperClips(paper, view, frame)
    return true
  }

  function paint(stroke) {
    if (!frame || !renderer || renderer.gl.isContextLost()) return false
    const { gl, data } = renderer
    const { width, height, sx, sy, view, clips, count } = frame
    const points = stroke.points
    if (!points.length || points.length > INK_LIMITS.points) return false
    if (count === points.length) return true
    if (!count) {
      const rgb = Number.parseInt(stroke.color.slice(1), 16)
      gl.uniform3f(renderer.color, (rgb >> 16) / 255, ((rgb >> 8) & 255) / 255, (rgb & 255) / 255)
      canvas.style.opacity = stroke.tool === 'marker' ? '.35' : '1'
    }
    // Stabilization may settle the previous point, and pressure smoothing uses adjacent samples.
    const first = Math.max(0, count - 3)
    const radiusScale = view.scale * Math.min(sx, sy)
    for (let index = first; index < points.length; index += 1) {
      const previous = Math.max(0, index - 1)
      const [px, py] = points[previous], [x, y] = points[index]
      const offset = index * floatsPerSegment
      data[offset] = (view.x + px * view.scale) * sx
      data[offset + 1] = (view.y + py * view.scale) * sy
      data[offset + 2] = (view.x + x * view.scale) * sx
      data[offset + 3] = (view.y + y * view.scale) * sy
      data[offset + 4] = outlineRadius(stroke, previous) * radiusScale
      data[offset + 5] = outlineRadius(stroke, index) * radiusScale
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, first * bytesPerSegment,
      data.subarray(first * floatsPerSegment, points.length * floatsPerSegment))
    gl.viewport(0, 0, width, height)
    gl.uniform2f(renderer.viewport, width, height)
    gl.disable(gl.SCISSOR_TEST)
    gl.clear(gl.COLOR_BUFFER_BIT)
    if (clips) {
      gl.enable(gl.SCISSOR_TEST)
      for (const clip of clips) {
        gl.scissor(...clip)
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, points.length)
      }
    } else {
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, points.length)
    }
    frame.count = points.length
    if (canvas.hidden) {
      canvas.hidden = false
      canvas.dataset.inkPreview = 'webgl2'
    }
    return true
  }

  return { prepare, begin, paint, clear }
}
