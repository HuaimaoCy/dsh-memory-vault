/**
 * 光学：Snell 折射、Fresnel 反射、位移场生成。
 *
 * 这条链是 Liquid Glass 的分水岭：
 *   SDF → 高度场 → 法线 → Snell → 纹理采样 → Fresnel + 合成
 * 少任何一步都退化成「磨砂白玻璃」。
 */
import { normalAt } from './surface.js'
import { signedDistance } from './geometry.js'

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
}) {
  const w = Math.max(Math.round(width) || 1, 1)
  const h = Math.max(Math.round(height) || 1, 1)
  const shifts = new Float32Array(w * h * 2)
  let maxAbs = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const distance = signedDistance({x:x+.5,y:y+.5,width:w,height:h,radius})
      if(distance>=0 || (distance<=-bezelWidth && !lensStrength))continue
      const normal = normalAt({ x: x + 0.5, y: y + 0.5, width: w, height: h, radius, bezelWidth, thickness, profile })
      const shift = displacement({ height: normal.height, normal, ior, scale: displacementScale })
      if(lensStrength){const weight=Math.min(1,-distance/2);shift.x-=(x+.5-w/2)*lensStrength*weight;shift.y-=(y+.5-h/2)*lensStrength*weight}
      const index = (y * w + x) * 2
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
