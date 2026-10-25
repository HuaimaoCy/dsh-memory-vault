/**
 * 后端 B：WebGL2（自有背景纹理 / 可控背景）。
 *
 * 边界说清楚：WebGL **不能读取任意 DOM 背后的像素**。所以这个后端只负责
 * 「背景是可控的场景」——Alaya 这里就是那层程序化的环境色。它用单 pass 画整屏，
 * 一笔 draw call 里跑完所有玻璃形状（对应 GlassEffectContainer 的「合并渲染」思路），
 * 而不是一个控件一个 canvas / 一个 shader。
 *
 * 与 CPU 数学共享同一套约定：SDF、smoothstep 高度场、Snell、Fresnel。
 * 着色器源码以字符串形式内联（渲染层没有打包步骤，不能 import .glsl）；
 * `shader.frag.glsl` 是同一份代码的可读来源，改一处要同步另一处。
 *
 * 性能策略：
 *   - 只在 dirty 时 render，没有常驻 rAF；
 *   - 用 scissor 限定到形状包围盒的并集（局部重绘）；
 *   - 单 canvas、单 program、单 VAO，所有形状共享。
 */

const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`

export const FRAG = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform int uCount;
uniform vec4 uShapes[8];
uniform float uRadii[8];
uniform float uBezel;
uniform float uThickness;
uniform float uIOR;
uniform float uPattern;
out vec4 fragColor;

float sdRoundRect(vec2 p, vec2 halfSize, float radius) {
  float r = min(radius, min(halfSize.x, halfSize.y));
  vec2 q = abs(p) - (halfSize - vec2(r));
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

vec3 ambient(vec2 uv) {
  vec3 a = vec3(0.906, 0.945, 0.929);
  vec3 b = vec3(0.961, 0.965, 0.953);
  vec3 c = vec3(0.929, 0.945, 0.980);
  float t = clamp((uv.x + uv.y) * 0.5, 0.0, 1.0);
  vec3 base = mix(mix(a, b, smoothstep(0.0, 0.52, t)), c, smoothstep(0.52, 1.0, t));
  float warm = smoothstep(0.62, 0.0, length(uv - vec2(0.06, 0.04)));
  float cool = smoothstep(0.62, 0.0, length(uv - vec2(0.96, 0.96)));
  return base + vec3(1.0, 0.965, 0.925) * warm * 0.10 + vec3(0.910, 0.941, 1.0) * cool * 0.08;
}

// 验收用高对比网格：平滑渐变背景上折射几乎看不出（位移 2px 取到的颜色几乎一样），
// 这是光学事实，不是 bug；要验证 GPU 端的 Snell 是否真的在推像素，必须给高频背景。
vec3 gridColor(vec2 fragPx) {
  vec2 cell = mod(fragPx, 11.0);
  float line = step(cell.x, 2.0) + step(cell.y, 2.0);
  return mix(vec3(0.98), vec3(0.04), clamp(line, 0.0, 1.0));
}

float heightAt(float d) {
  float t = clamp(-d / max(uBezel, 0.001), 0.0, 1.0);
  return uThickness * smoothstep(0.0, 1.0, t);
}

void main() {
  vec2 fragPx = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 uv = fragPx / uRes;
  vec3 color = uPattern > 0.5 ? gridColor(fragPx) : ambient(uv);
  for (int i = 0; i < 8; i++) {
    if (i >= uCount) break;
    vec4 shape = uShapes[i];
    float radius = uRadii[i];
    vec2 center = shape.xy + shape.zw * 0.5;
    vec2 halfSize = shape.zw * 0.5;
    float d = sdRoundRect(fragPx - center, halfSize, radius);
    if (d > 0.0) continue;
    float e = 1.0;
    float hC = heightAt(d);
    float hX = heightAt(sdRoundRect(fragPx + vec2(e, 0.0) - center, halfSize, radius));
    float hY = heightAt(sdRoundRect(fragPx + vec2(0.0, e) - center, halfSize, radius));
    vec3 N = normalize(vec3(-(hX - hC) / e, -(hY - hC) / e, 1.0));
    vec3 T = refract(vec3(0.0, 0.0, -1.0), N, 1.0 / max(uIOR, 1.0001));
    vec2 delta = T.xy * hC / max(-T.z, 0.01);
    vec3 refracted = uPattern > 0.5 ? gridColor(fragPx + delta) : ambient(clamp((fragPx + delta) / uRes, 0.0, 1.0));
    float t = clamp(-d / max(uBezel, 0.001), 0.0, 1.0);
    float slope = 6.0 * t * (1.0 - t);
    float fresnel = 0.04 + 0.96 * pow(1.0 - clamp(slope, 0.0, 1.0), 5.0);
    color = mix(color, refracted, 0.86);
    color = mix(color, vec3(1.0), fresnel * 0.45);
    color = mix(color, vec3(1.0), smoothstep(0.02, 0.0, abs(d) / 3.0) * 0.55);
  }
  fragColor = vec4(color, 1.0);
}`

export function createWebglBackend({ canvas, document: doc = globalThis.document } = {}) {
  if (!canvas || typeof WebGL2RenderingContext === 'undefined') return { supported: false }
  // preserveDrawingBuffer: dirtyOnly 的局部重绘要保住区域外的上一帧
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true })
  if (!gl) return { supported: false }

  const compile = (type, source) => {
    const shader = gl.createShader(type)
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(shader)}`)
    return shader
  }
  let program
  try {
    program = gl.createProgram()
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT))
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG))
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`link: ${gl.getProgramInfoLog(program)}`)
  } catch (error) {
    return { supported: false, error: String(error?.message || error) }
  }
  gl.useProgram(program)
  const buffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  const location = gl.getAttribLocation(program, 'aPos')
  gl.enableVertexAttribArray(location)
  gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0)

  const uniforms = {
    res: gl.getUniformLocation(program, 'uRes'),
    count: gl.getUniformLocation(program, 'uCount'),
    shapes: gl.getUniformLocation(program, 'uShapes'),
    radii: gl.getUniformLocation(program, 'uRadii'),
    bezel: gl.getUniformLocation(program, 'uBezel'),
    thickness: gl.getUniformLocation(program, 'uThickness'),
    ior: gl.getUniformLocation(program, 'uIOR'),
    pattern: gl.getUniformLocation(program, 'uPattern'),
  }
  const state = { shapes: [], renders: 0, lastRenderMs: 0, dpr: 1, width: 0, height: 0 }

  const resize = () => {
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2)
    const width = Math.max(1, Math.round(canvas.clientWidth * dpr))
    const height = Math.max(1, Math.round(canvas.clientHeight * dpr))
    if (width === state.width && height === state.height) return
    state.width = width
    state.height = height
    state.dpr = dpr
    canvas.width = width
    canvas.height = height
    gl.viewport(0, 0, width, height)
  }

  const draw = ({ bezel = 16, thickness = 8, ior = 1.5, pattern = false }) => {
    const count = state.shapes.length
    const flat = new Float32Array(32)
    const radii = new Float32Array(8)
    state.shapes.forEach((shape, index) => {
      flat.set([shape.x, shape.y, shape.width, shape.height], index * 4)
      radii[index] = shape.radius || 0
    })
    gl.uniform2f(uniforms.res, canvas.clientWidth, canvas.clientHeight)
    gl.uniform1i(uniforms.count, count)
    gl.uniform4fv(uniforms.shapes, flat)
    gl.uniform1fv(uniforms.radii, radii)
    gl.uniform1f(uniforms.bezel, bezel)
    gl.uniform1f(uniforms.thickness, thickness)
    gl.uniform1f(uniforms.ior, ior)
    gl.uniform1f(uniforms.pattern, pattern ? 1 : 0)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  return {
    supported: true,
    /** shapes: [{ x, y, width, height, radius }]，CSS px */
    setShapes(shapes) { state.shapes = shapes.slice(0, 8) },
    /**
     * 画一帧。两种模式：
     *   dirtyOnly=false（默认）整屏一次 pass：环境背景与折射在同一个 shader 里，
     *     没有两个 pass 的状态切换，实测比「先铺底再局部画」更省；
     *   dirtyOnly=true 用 scissor 限制到形状包围盒的并集（含 bezel 外扩），
     *     依赖 preserveDrawingBuffer 保住区域外的上一帧，适合悬浮高光这类小改动。
     */
    render({ bezel = 16, thickness = 8, ior = 1.5, dirtyOnly = false, pattern = false } = {}) {
      const started = globalThis.performance ? performance.now() : Date.now()
      resize()
      const count = state.shapes.length
      gl.disable(gl.SCISSOR_TEST)
      if (!dirtyOnly) {
        // 整屏 pass：先清屏再画（清屏与绘制都用同一个 canvas 尺寸，避免边界处黑边）
        gl.clearColor(0, 0, 0, 1)
        gl.clear(gl.COLOR_BUFFER_BIT)
        draw({ bezel, thickness, ior, pattern })
      } else if (count > 0) {
        const pad = bezel + 4
        const minX = Math.max(0, Math.min(...state.shapes.map(s => s.x - pad)))
        const minY = Math.max(0, Math.min(...state.shapes.map(s => s.y - pad)))
        const maxX = Math.min(canvas.clientWidth, Math.max(...state.shapes.map(s => s.x + s.width + pad)))
        const maxY = Math.min(canvas.clientHeight, Math.max(...state.shapes.map(s => s.y + s.height + pad)))
        const dpr = state.dpr
        gl.enable(gl.SCISSOR_TEST)
        gl.scissor(
          Math.round(minX * dpr),
          Math.round((canvas.clientHeight - maxY) * dpr),
          Math.max(1, Math.round((maxX - minX) * dpr)),
          Math.max(1, Math.round((maxY - minY) * dpr))
        )
        draw({ bezel, thickness, ior, pattern })
      }
      state.renders++
      state.lastRenderMs = (globalThis.performance ? performance.now() : Date.now()) - started
      return state.lastRenderMs
    },
    metrics() { return { supported: true, renders: state.renders, lastRenderMs: Number(state.lastRenderMs.toFixed(3)), shapes: state.shapes.length, resolution: [state.width, state.height] } },
    dispose() { gl.deleteBuffer(buffer); gl.deleteProgram(program); gl.getExtension('WEBGL_lose_context')?.loseContext() }
  }
}

/** 把后端画到一层固定 canvas 上；用于「背景是可控场景」的实验档与性能台。 */
export function mountWebglBackdrop({ document: doc = globalThis.document, shapes = () => [] } = {}) {
  const canvas = doc.createElement('canvas')
  canvas.className = 'alaya-optical-webgl'
  canvas.setAttribute('aria-hidden', 'true')
  canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:-1;pointer-events:none;'
  doc.querySelector('.app-shell')?.prepend(canvas)
  const backend = createWebglBackend({ canvas, document: doc })
  if (!backend.supported) { canvas.remove(); return { supported: false } }
  doc.documentElement.dataset.opticalBackend = 'webgl'
  const frame = () => {
    backend.setShapes(shapes())
    backend.render()
  }
  frame()
  let scheduled = null
  return {
    supported: true,
    backend,
    invalidate() {
      if (scheduled !== null) return
      scheduled = (globalThis.requestAnimationFrame || (fn => setTimeout(fn, 16)))(() => { scheduled = null; frame() })
    },
    dispose() {
      if (scheduled !== null) (globalThis.cancelAnimationFrame || clearTimeout)(scheduled)
      backend.dispose()
      canvas.remove()
      delete doc.documentElement.dataset.opticalBackend
    }
  }
}
