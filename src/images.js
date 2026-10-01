import { createHash } from 'node:crypto'

export const IMAGE_MAX_BYTES = 10 * 1024 * 1024
export const IMAGE_MAX_COUNT = 16
export const IMAGE_TOTAL_BYTES = 20 * 1024 * 1024
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
export function normalizeImage(input) {
  if (!input || typeof input !== 'object' || typeof input.data !== 'string' || input.data.length > Math.ceil(IMAGE_MAX_BYTES / 3) * 4) throw new Error('每张图片不能超过 10 MB')
  const bytes = Buffer.from(input.data, 'base64')
  if (bytes.toString('base64') !== input.data) throw new Error('图片数据不是有效的 Base64')
  if (bytes.length < 12 || bytes.length > IMAGE_MAX_BYTES) throw new Error('图片为空或超过 10 MB')
  let mimeType, width, height
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.length >= 45 && bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.toString('ascii', bytes.length - 8, bytes.length - 4) === 'IEND') {
    mimeType = 'image/png'; width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20)
  } else if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6)) && bytes[bytes.length - 1] === 59) {
    mimeType = 'image/gif'; width = bytes.readUInt16LE(6); height = bytes.readUInt16LE(8)
  } else if (bytes[0] === 255 && bytes[1] === 216 && bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217) {
    mimeType = 'image/jpeg'
    let offset = 2
    while (offset + 8 < bytes.length) {
      if (bytes[offset++] !== 255) break
      while (bytes[offset] === 255) offset++
      const marker = bytes[offset++]
      if (marker === 218 || marker === 217) break
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue
      if (offset + 2 > bytes.length) break
      const length = bytes.readUInt16BE(offset)
      if (length < 2 || offset + length > bytes.length) break
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) { height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); break }
      offset += length
    }
  } else if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length) {
    mimeType = 'image/webp'
    const chunk = bytes.toString('ascii', 12, 16)
    if (chunk === 'VP8X' && bytes.length >= 30) { width = 1 + bytes.readUIntLE(24, 3); height = 1 + bytes.readUIntLE(27, 3) }
    else if (chunk === 'VP8L' && bytes.length >= 25 && bytes[20] === 47) { const bits = bytes.readUInt32LE(21); width = (bits & 16383) + 1; height = ((bits >>> 14) & 16383) + 1 }
    else if (chunk === 'VP8 ' && bytes.length >= 30 && bytes.subarray(23, 26).equals(Buffer.from([157, 1, 42]))) { width = bytes.readUInt16LE(26) & 16383; height = bytes.readUInt16LE(28) & 16383 }
  }
  if (!mimeType || !width || !height || width > 16384 || height > 16384 || width * height > 40000000) throw new Error('图片格式或尺寸无效；支持 PNG、JPEG、WebP、GIF，最多 4000 万像素')
  if (input.mimeType && input.mimeType !== mimeType) throw new Error('图片类型与实际内容不匹配')
  const name = String(input.name ?? '图片').split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f]/g, '').slice(0, 180) || '图片'
  return { name, mimeType, width, height, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), bytes }
}
