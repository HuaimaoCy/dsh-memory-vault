/**
 * 表面：从 SDF 的距离构造虚拟高度场，再由高度场的梯度求单位法线。
 *
 * 高度剖面只有两种：
 *   smooth —— h·(3t² − 2t³)，中心平坦、边缘连续过渡（默认，观感最接近磨砂玻璃）；
 *   arc    —— h·√(1 − (1 − t)²)，四分之一圆弧倒角，边缘更陡，折射更强。
 *
 * 这里没有三维网格：每个二维像素只有一个假设的高度值，法线就是它的坡度。
 */
import { sdfGradient, signedDistance } from './geometry.js'

export const PROFILES = {
  smooth: { height: t => t * t * (3 - 2 * t), slope: t => 6 * t * (1 - t) },
  arc: { height: t => Math.sqrt(Math.max(0, 1 - (1 - t) * (1 - t))), slope: t => (1 - t) / Math.max(Math.sqrt(Math.max(0, 1 - (1 - t) * (1 - t))), 1e-3) },
  linear: { height: t => t, slope: () => 1 },
}

export function profileOf(name) {
  return PROFILES[name] || PROFILES.smooth
}

/** t = clamp(s / bezel)：s 是「到边缘的内侧距离」，bezel 是把边缘压平的宽度。 */
export function bezelRatio({ distance, bezelWidth }) {
  const bezel = Math.max(Number(bezelWidth) || 0, 0.001)
  return Math.min(Math.max(-distance / bezel, 0), 1)
}

/** 高度场 H(x, y)。中心（t=1）最高，边缘（t=0）为 0。 */
export function heightAt({ x, y, width, height, radius = 0, bezelWidth = 16, thickness = 1, profile = 'smooth' }) {
  const distance = signedDistance({ x, y, width, height, radius })
  const t = bezelRatio({ distance, bezelWidth })
  return Math.max(0, Number(thickness) || 0) * profileOf(profile).height(t)
}

/**
 * 表面法线：N = normalize(−∂H/∂x, −∂H/∂y, 1)。
 * 因为 H 只通过 t = −d/bezel 依赖位置，链式法则可以写成
 *   ∂H/∂x = thickness · profile'(t) · (−1/bezel) · ∂d/∂x
 * 于是 −∂H/∂x = thickness · profile'(t) / bezel · ∂d/∂x，
 * 其中 ∂d/∂x 是 SDF 的解析梯度（指向外）。
 */
export function normalAt({ x, y, width, height, radius = 0, bezelWidth = 16, thickness = 1, profile = 'smooth' }) {
  const distance = signedDistance({ x, y, width, height, radius })
  const t = bezelRatio({ distance, bezelWidth })
  const slope = profileOf(profile).slope(t)
  const gradient = sdfGradient({ x, y, width, height, radius })
  const k = slope * (Math.max(0, Number(thickness) || 0) / Math.max(Number(bezelWidth) || 0, 0.001))
  const nx = gradient.x * k
  const ny = gradient.y * k
  const length = Math.hypot(nx, ny, 1)
  return { x: nx / length, y: ny / length, z: 1 / length, distance, height: heightAt({ x, y, width, height, radius, bezelWidth, thickness, profile }) }
}

/** 采样一张法线图：R/G 存 −1..1 归一化后的 nx/ny，B 存 nz，A 存高度。调试与测试用。 */
export function buildNormalField({ width, height, radius = 0, bezelWidth = 16, thickness = 1, profile = 'smooth' }) {
  const w = Math.max(Math.round(width) || 1, 1)
  const h = Math.max(Math.round(height) || 1, 1)
  const data = new Float32Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const normal = normalAt({ x: x + 0.5, y: y + 0.5, width: w, height: h, radius, bezelWidth, thickness, profile })
      const index = (y * w + x) * 4
      data[index] = normal.x
      data[index + 1] = normal.y
      data[index + 2] = normal.z
      data[index + 3] = normal.height
    }
  }
  return { width: w, height: h, data }
}
