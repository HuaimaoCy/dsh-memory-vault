/**
 * 最小 PNG 读写（无第三方依赖）。
 *
 * 为什么自己写：实验要对**合成后的像素**下判断（圆角外有没有漏出背景、边缘内侧有没有
 * 接缝）。断言 DOM 里的 `backdrop-filter` 取值为真没有意义——那正是「能跑但不可靠」
 * 最容易骗过自己的地方。解码截图、按面取区域、算差值是唯一诚实的口径。
 *
 * 支持：位深 8、非隔行、颜色类型 0/2/4/6（灰度/RGB/灰度+alpha/RGBA）。
 * 不支持：16 位、隔行、调色板——CDP 与 canvas 都不会产出这几种。
 */
import { deflateSync, inflateSync } from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

const crc32 = buffer => {
  let crc = -1
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

/** 解一张 PNG，统一返回 RGBA（8 位，行优先）。 */
export const decodePng = buffer => {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('不是 PNG')
  let offset = 8
  let header = null
  const idat = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const body = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      header = {
        width: body.readUInt32BE(0), height: body.readUInt32BE(4), bitDepth: body[8],
        colorType: body[9], interlace: body[12],
      }
    } else if (type === 'IDAT') idat.push(body)
    else if (type === 'IEND') break
    offset += 12 + length
  }
  if (!header) throw new Error('PNG 缺少 IHDR')
  const { width, height, bitDepth, colorType, interlace } = header
  if (bitDepth !== 8) throw new Error(`只支持 8 位 PNG，实际 ${bitDepth}`)
  if (interlace !== 0) throw new Error('不支持隔行 PNG')
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType]
  if (!channels) throw new Error(`不支持的颜色类型 ${colorType}`)
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const pixels = new Uint8Array(stride * height)
  let previous = new Uint8Array(stride)
  let cursor = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[cursor++]
    const line = raw.subarray(cursor, cursor + stride)
    cursor += stride
    const out = new Uint8Array(stride)
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? out[x - channels] : 0
      const up = previous[x]
      const upLeft = x >= channels ? previous[x - channels] : 0
      const value = line[x]
      let result
      if (filter === 0) result = value
      else if (filter === 1) result = value + left
      else if (filter === 2) result = value + up
      else if (filter === 3) result = value + ((left + up) >> 1)
      else if (filter === 4) {
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        result = value + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)
      } else throw new Error(`未知的行滤镜 ${filter}`)
      out[x] = result & 0xff
    }
    pixels.set(out, y * stride)
    previous = out
  }
  // 归一化成 RGBA
  const rgba = new Uint8Array(width * height * 4)
  for (let i = 0, p = 0; i < width * height; i++, p += channels) {
    const o = i * 4
    if (channels === 1) { rgba[o] = rgba[o + 1] = rgba[o + 2] = pixels[p]; rgba[o + 3] = 255 }
    else if (channels === 3) { rgba[o] = pixels[p]; rgba[o + 1] = pixels[p + 1]; rgba[o + 2] = pixels[p + 2]; rgba[o + 3] = 255 }
    else if (channels === 2) { rgba[o] = rgba[o + 1] = rgba[o + 2] = pixels[p]; rgba[o + 3] = pixels[p + 1] }
    else { rgba[o] = pixels[p]; rgba[o + 1] = pixels[p + 1]; rgba[o + 2] = pixels[p + 2]; rgba[o + 3] = pixels[p + 3] }
  }
  return { width, height, data: rgba }
}

const chunk = (type, body) => {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0)
  return Buffer.concat([head, body, crc])
}

/** 编码 RGBA 图（截图与裁剪用）。 */
export const encodePng = ({ width, height, data }) => {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

export const pixelAt = (image, x, y) => {
  const i = (Math.round(y) * image.width + Math.round(x)) * 4
  return [image.data[i], image.data[i + 1], image.data[i + 2], image.data[i + 3]]
}

/** 裁一块矩形出来（越界按边缘复制，避免细算采样点）。 */
export const crop = (image, { x, y, width, height }) => {
  const out = new Uint8Array(width * height * 4)
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const sx = Math.min(image.width - 1, Math.max(0, Math.round(x + col)))
      const sy = Math.min(image.height - 1, Math.max(0, Math.round(y + row)))
      const s = (sy * image.width + sx) * 4
      const d = (row * width + col) * 4
      out[d] = image.data[s]
      out[d + 1] = image.data[s + 1]
      out[d + 2] = image.data[s + 2]
      out[d + 3] = image.data[s + 3]
    }
  }
  return { width, height, data: out }
}

/** 最近邻放大，用于「看得见的证据」而不是插值糊掉的放大图。 */
export const scaleUp = (image, factor) => {
  const width = image.width * factor
  const height = image.height * factor
  const out = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = (Math.floor(y / factor) * image.width + Math.floor(x / factor)) * 4
      const d = (y * width + x) * 4
      out[d] = image.data[s]
      out[d + 1] = image.data[s + 1]
      out[d + 2] = image.data[s + 2]
      out[d + 3] = image.data[s + 3]
    }
  }
  return { width, height, data: out }
}

/** 逐像素差的统计量（RGB 三通道平均，0–255）。 */
export const diffStats = (left, right, region) => {
  const x0 = Math.max(0, Math.round(region.x))
  const y0 = Math.max(0, Math.round(region.y))
  const x1 = Math.min(Math.min(left.width, right.width), Math.round(region.x + region.width))
  const y1 = Math.min(Math.min(left.height, right.height), Math.round(region.y + region.height))
  let sum = 0
  let max = 0
  let count = 0
  let changed = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * left.width + x) * 4
      const d = (Math.abs(left.data[i] - right.data[i]) + Math.abs(left.data[i + 1] - right.data[i + 1]) + Math.abs(left.data[i + 2] - right.data[i + 2])) / 3
      sum += d
      if (d > max) max = d
      if (d > 2) changed++
      count++
    }
  }
  return {
    pixels: count,
    mean: count ? Number((sum / count).toFixed(3)) : 0,
    max: Number(max.toFixed(2)),
    changedRatio: count ? Number((changed / count).toFixed(4)) : 0,
  }
}

/** 亮度图，接缝检测与带内对比都用它。 */
export const lumaAt = (image, x, y) => {
  const i = (y * image.width + x) * 4
  return 0.2126 * image.data[i] + 0.7152 * image.data[i + 1] + 0.0722 * image.data[i + 2]
}

/**
 * 接缝分：沿某条边内侧若干行/列，量与边平行的「二阶差分」能量。
 *
 * 位移贴图若是被拉伸/分桶产生的，在面内侧会留下一条与边平行的硬跳变；正常的光学
 * 位移是连续的。只统计边内 2px 起的区域，避开设计上本来就存在的 1px 描边。
 */
export const seamScore = (image, rect, { edge = 'top', start = 2, depth = 18, inset = 8 } = {}) => {
  const samples = []
  const horizontal = edge === 'top' || edge === 'bottom'
  const along = horizontal ? rect.width : rect.height
  const from = inset
  const to = along - inset
  if (to <= from) return 0
  for (let t = from; t < to; t++) {
    const line = []
    for (let d = 0; d <= depth + 2; d++) {
      let x
      let y
      if (edge === 'top') { x = rect.x + t; y = rect.y + start + d }
      else if (edge === 'bottom') { x = rect.x + t; y = rect.y + rect.height - start - d }
      else if (edge === 'left') { x = rect.x + start + d; y = rect.y + t }
      else { x = rect.x + rect.width - start - d; y = rect.y + t }
      if (x < 0 || y < 0 || x >= image.width || y >= image.height) { line.length = 0; break }
      line.push(lumaAt(image, x, y))
    }
    if (line.length < 4) continue
    let energy = 0
    for (let i = 1; i < line.length - 1; i++) energy = Math.max(energy, Math.abs(line[i - 1] - 2 * line[i] + line[i + 1]))
    samples.push(energy)
  }
  if (!samples.length) return 0
  samples.sort((a, b) => a - b)
  const pick = q => samples[Math.min(samples.length - 1, Math.floor(samples.length * q))]
  return { median: Number(pick(0.5).toFixed(2)), p90: Number(pick(0.9).toFixed(2)), max: Number(samples[samples.length - 1].toFixed(2)) }
}
