/**
 * 光学：Snell 折射、Fresnel 反射、位移场生成。
 *
 * 这条链是 Liquid Glass 的分水岭：
 *   SDF → 高度场 → 法线 → Snell → 纹理采样 → Fresnel + 合成
 * 少任何一步都退化成「磨砂白玻璃」。
 */
import { normalAt } from './surface.js'
import { gradientRadius, sdfGradient, signedDistance } from './geometry.js'

/**
 * Apple 风格边缘放大曲线（来自 B 站 iOS27 深度解析视频的建模）：
 *
 *   r(d) = S · max(1 − d/D, 0)^p
 *
 * d 是到玻璃边缘的**内侧**距离（px）。边缘处 d=0 位移最大（S），向内 D px
 * 衰减到 0，p 控制衰减形状（p=1 线性，p>1 更集中在边缘）。
 * 视频给的 iOS26 参考值：S=12.65px、D=22px、p=1.65。
 *
 * 与高度场 + Snell 的区别：那条链路在边缘处高度与法线坡度都为 0，
 * 位移峰值落在倒角中部；而 Apple 的模型是「边缘最强、向内单调衰减」。
 * 两种形状在 40px 高的胶囊上肉眼可见地不同：前者把背景压成一条中线亮带，
 * 后者让边缘一整圈都参与折射。
 */
export function edgeCurve({ distance, strength = 12.65, distanceMax = 22, power = 1.65 }) {
  const inside = Math.max(0, -Number(distance || 0))
  const span = Math.max(Number(distanceMax) || 0, 0.001)
  const t = Math.max(0, 1 - inside / span)
  return Math.max(0, Number(strength) || 0) * Math.pow(t, Math.max(Number(power) || 0, 0.05))
}

/**
 * 单界面 Snell 折射。入射光 I 从空气进入玻璃（IOR = ior），法线 N 指向玻璃外部；
 * 返回折射方向 T。全反射时返回 { tir: true }，调用方应回退为「不位移」。
 *   η = 1 / n
 *   k = 1 − η²(1 − cos²θ)
 *   T = ηI + (η·cosθ − √k)·N
 */
export function refract({ incident, normal, ior = 1.5 }) {
  const n = Math.max(Number(ior) || 1, 1.0001)
  const eta = 1 / n
  const cosI = -(incident.x * normal.x + incident.y * normal.y + incident.z * normal.z)
  const k = 1 - eta * eta * (1 - cosI * cosI)
  if (k < 0) return { x: 0, y: 0, z: -1, tir: true }
  const factor = eta * cosI - Math.sqrt(k)
  const x = eta * incident.x + factor * normal.x
  const y = eta * incident.y + factor * normal.y
  const z = eta * incident.z + factor * normal.z
  const length = Math.hypot(x, y, z) || 1
  return { x: x / length, y: y / length, z: z / length, tir: false }
}

/**
 * 光线到达背景平面的二维位移：
 *   Δxy = H / (−Tz) · (Tx, Ty)
 * H 是该点玻璃厚度，−Tz 是折射方向朝背景去的余弦。中心 H 大但法线垂直，
 * 位移为 0；边缘 H 小、法线倾斜，位移反而最大——这就是边缘透镜效应的来源。
 */
export function displacement({ height, normal, ior = 1.5, scale = 1 }) {
  const incident = { x: 0, y: 0, z: -1 }
  const refracted = refract({ incident, normal, ior })
  if (refracted.tir) return { x: 0, y: 0 }
  const travel = Math.max(-refracted.z, 1e-3)
  return {
    x: (Math.max(0, height) / travel) * refracted.x * scale,
    y: (Math.max(0, height) / travel) * refracted.y * scale,
  }
}

/** Schlick 近似：F = F0 + (1 − F0)(1 − cosθ)^5，F0 = ((n1 − n2)/(n1 + n2))²。 */
export function fresnel({ cosTheta, ior = 1.5, f0 }) {
  const n = Math.max(Number(ior) || 1, 1.0001)
  const base = Number.isFinite(f0) ? f0 : Math.pow((n - 1) / (n + 1), 2)
  const c = Math.min(Math.max(cosTheta, 0), 1)
  return base + (1 - base) * Math.pow(1 - c, 5)
}

/** 色散：三个通道用略有差异的折射率，强度必须很小，否则出现彩虹描边。 */
export function dispersionIors({ ior = 1.5, dispersion = 0 }) {
  const spread = Math.min(Math.max(Number(dispersion) || 0, 0), 0.12)
  return { r: ior * (1 - spread), g: ior, b: ior * (1 + spread) }
}

/**
 * 生成一张位移贴图，并同时给出消费它所需的滤镜幅值。
 *
 * 编码约定（与 CSS `feDisplacementMap` 对齐）：通道 128 为中性，
 *   c = 128 + (d / maxAbs) · 127
 * 滤镜幅值取 `filterScale = 2·maxAbs`，于是 `feDisplacementMap` 的位移
 * 后端先用线性通道变换将 128 精确对齐 .5，再由 S·(c−128)/254 还原位移。
 * 即「贴图里存的是归一化方向，幅值由滤镜的 scale 属性给出」——这样同一张贴图
 * 可以在不同强度档位复用，只需要改一个属性。
 *
 * 贴图按元素**精确尺寸**生成，不做分桶：位移对边缘是二阶敏感量，1% 的拉伸
 * 就足以破坏轮廓（实测：分桶版本边缘不稳 12–17，精确尺寸 1–6）。
 */
export function buildDisplacementMap({
  width,
  height,
  radius = 0,
  bezelWidth = 16,
  thickness = 1,
  ior = 1.5,
  displacementScale = 30,
  profile = 'smooth',
  lensStrength = 0,
  /** 'refract' = 高度场 + Snell（旧路径）；'curve' = 边缘放大曲线（新路径） */
  mode = 'refract',
  curveStrength = 12.65,
  curveDistance = 22,
  curvePower = 1.65,
  /** 求法线时把圆角放大多少倍；1 = 不放大（旧行为），1.5 = 参考实现的过渡带 */
  gradientScale = 1,
  /** 0..1：把边缘法向与「指向中心」的径向混合，做出透镜纵深 */
  depth = 0,
  /** 曲线模式下位移场的平滑宽度（px）。>0 时方向由高度场的中心差分求出，
   *  在角部与中轴线附近形成过渡带，消除法向「分割线」跳变。 */
  cornerSmoothing = 2.5,
}) {
  const w = Math.max(Math.round(width) || 1, 1)
  const h = Math.max(Math.round(height) || 1, 1)
  const shifts = new Float32Array(w * h * 2)
  const curve = mode === 'curve'
  const gradRadius = gradientRadius({ width: w, height: h, radius, gradientScale })
  const halfMin = Math.min(w, h) / 2
  // 薄控件上两条边缘带会在中线相遇：把跨度收到半短边，让中线处的位移正好归零，
  // 否则上下两带方向相反、在中线叠出一条折痕。（视频里 iOS27「调小过渡距离」同理）
  const span = Math.max(0.5, Math.min(Number(curveDistance) || 0, halfMin))
  const smoothing = Math.max(0, Number(cornerSmoothing) || 0)
  const strength = Math.max(0, Number(curveStrength) || 0)
  const power = Math.max(Number(curvePower) || 0, 0.05)

  // 曲线模式先把标量场算成一张表：每个像素只做一次 SDF，方向用邻域差分。
  // 这样贴图生成从「每像素 5 次 SDF」降到 1 次，面板级表面的首帧成本降一个量级。
  let field = null
  let signed = null
  if (curve) {
    field = new Float32Array(w * h)
    signed = new Float32Array(w * h)
    // 把 SDF 内联掉：贴图生成是首帧最贵的一步，函数调用 + 对象分配会把
    // 一块 330×220 的面拖到 30ms 以上。这里只保留算术。
    const cx = w / 2
    const cy = h / 2
    const rr = Math.min(Math.max(Number(radius) || 0, 0), halfMin)
    const ax = w / 2 - rr
    const ay = h / 2 - rr
    // 离四边都超过 max(r, D) 的像素不可能落在位移带里：直接跳过 SDF。
    const margin = Math.max(rr, span)
    for (let y = 0; y < h; y++) {
      const py = y + 0.5
      const interiorY = py >= margin && py <= h - margin
      for (let x = 0; x < w; x++) {
        const index = y * w + x
        const px = x + 0.5
        if (interiorY && px >= margin && px <= w - margin) { signed[index] = 1; continue }
        const qx = Math.abs(px - cx) - ax
        const qy = Math.abs(py - cy) - ay
        const mx = qx > 0 ? qx : 0
        const my = qy > 0 ? qy : 0
        const outside = Math.sqrt(mx * mx + my * my)
        const inside = Math.min(Math.max(qx, qy), 0)
        const distance = outside + inside - rr
        signed[index] = distance
        // 外侧延续为 S（不是 0），否则中心差分会跨过边界产生反向假梯度。
        const insideDistance = -distance
        field[index] = insideDistance > span
          ? 0
          : strength * Math.pow(Math.min(1, Math.max(0, 1 - insideDistance / span)), power)
      }
    }
  }
  const fieldAt = (x, y) => {
    const sx = x < 0 ? 0 : x >= w ? w - 1 : x
    const sy = y < 0 ? 0 : y >= h ? h - 1 : y
    return field[sy * w + sx]
  }
  let maxAbs = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const pixel = y * w + x
      const index = pixel * 2
      if (curve) {
        // 边界外保留一圈位移：贴图在轮廓处若从「满位移」直接跳回中性，
        // feDisplacementMap 的双线性取样会在边上产生一圈锯齿。
        const outsideBand = Math.max(2, Math.ceil(smoothing))
        if (signed[pixel] > outsideBand) continue
        const magnitude = field[pixel]
        if (magnitude <= 0) continue
        let dx = 0
        let dy = 0
        if (smoothing >= 1) {
          // 中心差分 = 把方向场按 2·smoothing 的带宽摊平；这就是「过渡带」。
          const step = Math.max(1, Math.round(smoothing))
          const gx = fieldAt(x + step, y) - fieldAt(x - step, y)
          const gy = fieldAt(x, y + step) - fieldAt(x, y - step)
          const length = Math.hypot(gx, gy)
          if (length < 1e-6) continue
          dx = -(gx / length) * magnitude
          dy = -(gy / length) * magnitude
        } else {
          const gradient = sdfGradient({ x: x + 0.5, y: y + 0.5, width: w, height: h, radius: gradRadius })
          dx = -gradient.x * magnitude
          dy = -gradient.y * magnitude
        }
        if (depth > 0) {
          const rx = x + 0.5 - w / 2
          const ry = y + 0.5 - h / 2
          const length = Math.hypot(rx, ry) || 1
          const tx = -rx / length
          const ty = -ry / length
          dx = dx * (1 - depth) + tx * magnitude * depth
          dy = dy * (1 - depth) + ty * magnitude * depth
        }
        shifts[index] = dx
        shifts[index + 1] = dy
        maxAbs = Math.max(maxAbs, Math.abs(dx), Math.abs(dy))
        continue
      }
      const distance = signedDistance({ x: x + 0.5, y: y + 0.5, width: w, height: h, radius })
      if (distance >= 0 || (distance <= -bezelWidth && !lensStrength)) continue
      const normal = normalAt({ x: x + 0.5, y: y + 0.5, width: w, height: h, radius, bezelWidth, thickness, profile })
      const shift = displacement({ height: normal.height, normal, ior, scale: displacementScale })
      if (lensStrength) {
        const weight = Math.min(1, -distance / 2)
        shift.x -= (x + 0.5 - w / 2) * lensStrength * weight
        shift.y -= (y + 0.5 - h / 2) * lensStrength * weight
      }
      shifts[index] = shift.x
      shifts[index + 1] = shift.y
      maxAbs = Math.max(maxAbs, Math.abs(shift.x), Math.abs(shift.y))
    }
  }
  const data = new Uint8ClampedArray(w * h * 4)
  const normalizer = maxAbs > 1e-6 ? 1 / maxAbs : 0
  for (let i = 0; i < w * h; i++) {
    const cx = clampByte(128 + shifts[i * 2] * normalizer * 127)
    const cy = clampByte(128 + shifts[i * 2 + 1] * normalizer * 127)
    data[i * 4] = cx
    data[i * 4 + 1] = cy
    data[i * 4 + 2] = cx
    // 位移仅使用 R/G。alpha 必须不透明，避免 PNG 预乘污染中性区。
    data[i * 4 + 3] = 255
  }
  return {
    width: w,
    height: h,
    data,
    /** 贴图里 1.0 的归一化位移对应多少 px；作为滤镜 `scale` 属性的一半传入 */
    maxDisplacement: maxAbs,
    filterScale: Math.max(0.5, maxAbs * 2),
  }
}

const clampByte = value => Math.max(0, Math.min(255, Math.round(value)))

/** 同一法线场上的 Fresnel 轮廓反射。中央不铺白，亮暗只集中在倒角。 */
export function buildReflectionMap({ width, height, radius = 0, bezelWidth = 12, thickness = 6, ior = 1.46, profile = 'arc' }) {
  const w = Math.max(1, Math.round(width)), h = Math.max(1, Math.round(height))
  const data = new Uint8ClampedArray(w * h * 4)
  const frost = new Uint8ClampedArray(w * h * 4)
  const edge = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const d = -signedDistance({x:x+.5,y:y+.5,width:w,height:h,radius})
    const i = (y*w+x)*4
    const t = Math.min(1,Math.max(0,d/bezelWidth))
    frost[i]=255;frost[i+1]=255;frost[i+2]=255;frost[i+3]=clampByte(t*t*(3-2*t)*255)
    edge[i]=255;edge[i+1]=255;edge[i+2]=255;edge[i+3]=255-frost[i+3]
    if (d < 0 || d > bezelWidth) continue
    const n = normalAt({ x:x+.5, y:y+.5, width:w, height:h, radius, bezelWidth, thickness, profile })
    const facing = n.x * -.6 + n.y * -.8
    const rim = Math.pow(Math.max(0, 1 - d / 3.5), 1.5)
    const reflection = fresnel({ cosTheta:n.z, ior })
    const light = facing > 0
    const strength = rim * (light ? .18 + .48 * facing + reflection * .8 : .09 + .25 * -facing + reflection * .24)
    const color = light ? [255,255,255] : [36,58,76]
    data[i]=color[0];data[i+1]=color[1];data[i+2]=color[2];data[i+3]=clampByte(Math.min(.9,strength)*255)
  }
  return { width:w, height:h, data, frostMask:{width:w,height:h,data:frost}, edgeMask:{width:w,height:h,data:edge} }
}

/**
 * 把位移贴图编码成 PNG data URI（SVG feImage 只认 data:，`file://` 与打包相对路径都会失败）。
 * 没有 canvas 的环境（Node 测试）返回 null，由调用方决定跳过还是用占位图。
 */
export function encodeMapDataUrl(map, { document: doc } = {}) {
  const canvasFactory = doc?.createElement ? () => doc.createElement('canvas') : () => null
  const canvas = canvasFactory()
  if (!canvas || typeof canvas.getContext !== 'function') return null
  canvas.width = map.width
  canvas.height = map.height
  const context = canvas.getContext('2d')
  if (!context?.putImageData) return null
  context.putImageData(new ImageData(new Uint8ClampedArray(map.data), map.width, map.height), 0, 0)
  return canvas.toDataURL('image/png')
}
