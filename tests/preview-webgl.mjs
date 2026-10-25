/**
 * WebGL2 后端验收：可控背景下的真实折射（单 pass、共享 program、dirtyOnly 走 scissor）。
 *
 *   node tests/preview-webgl.mjs
 *
 * 判据：
 *   1. WebGL2 上下文能建立、着色器能编译（无页面异常）；
 *   2. ior=1.0（不折射，对照组）与 ior=1.5 在形状内部像素明显不同；
 *   3. 形状之外的像素几乎不变（折射只发生在玻璃内）；
 *   4. 静止时不重复 render（由调用方 invalidate 驱动）。
 *
 * 量的是 canvas 自己的像素（`toDataURL`），不是整页截图：headless 合成器对
 * 「页面没变、只有 canvas 重画」的帧可能复用上一张 surface，截图会读不到更新，
 * 而 canvas 像素是后端输出的直接证据。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ChromiumSession } from './preview-cdp.mjs'
import { createPreviewServer } from './preview-app.mjs'
import { decodePng } from './png.mjs'

const root = resolve(import.meta.dirname, '..')
const out = join(root, 'test-tmp', 'preview', 'webgl')
mkdirSync(out, { recursive: true })
const sleep = ms => new Promise(done => setTimeout(done, ms))

const meanDiff = (a, b, region) => {
  let sum = 0, n = 0, max = 0
  for (let y = region.y; y < region.y + region.height; y++) {
    for (let x = region.x; x < region.x + region.width; x++) {
      if (x < 0 || y < 0 || x >= a.width || y >= a.height) continue
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(a.data[(y * a.width + x) * 4 + c] - b.data[(y * b.width + x) * 4 + c])
        sum += d; n++
        if (d > max) max = d
      }
    }
  }
  return { mean: sum / Math.max(n, 1), max }
}

const server = createPreviewServer({ mode: 'memory' })
await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done) })
const base = `http://127.0.0.1:${server.address().port}/`
const session = await ChromiumSession.launch({ width: 1440, height: 940, profile: join(root, 'test-tmp', 'work', `webgl-${process.pid}`) })

let failed = 0
const check = (label, condition, detail) => {
  if (condition) { console.log(`ok   ${label}${detail ? `（${detail}）` : ''}`); return }
  failed++
  console.log(`FAIL ${label}${detail ? `（${detail}）` : ''}`)
}

const SHAPES = `[...document.querySelectorAll('.bar .toolbar-actions, .side, .search-wrap')].map(node => {
  const r = node.getBoundingClientRect()
  return { x: r.left, y: r.top, width: r.width, height: r.height, radius: Number.parseFloat(getComputedStyle(node).borderTopLeftRadius) || 0 }
})`

try {
  await session.goto(base)
  await session.waitFor(`!document.getElementById('alaya-startup') && document.querySelector('.app-shell')`, { timeout: 30000 })
  const support = JSON.parse(await session.evaluate(`JSON.stringify((() => {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2')
    const ext = gl ? gl.getExtension('WEBGL_debug_renderer_info') : null
    return { webgl2: Boolean(gl), renderer: gl ? (ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) : null }
  })())`))
  console.log(`     WebGL2: ${support.webgl2} · ${support.renderer || 'n/a'}`)
  if (!support.webgl2) {
    console.log('skipped: 本机 headless Chromium 没有可用的 WebGL2；后端代码保留，需在真机 Electron 里跑这一项')
  } else {
    const mounted = JSON.parse(await session.evaluate(`(async () => {
      const module = await import('/optical/backends/webgl.js')
      window.__shapes = () => ${SHAPES}
      window.__webgl = module.mountWebglBackdrop({ shapes: window.__shapes })
      await new Promise(done => setTimeout(done, 200))
      window.__webgl.backend.setShapes(window.__shapes())
      return JSON.stringify({ supported: window.__webgl.supported, metrics: window.__webgl.supported ? window.__webgl.backend.metrics() : null })
    })()`))
    check('WebGL 后端可以初始化', mounted.supported, mounted.metrics ? JSON.stringify(mounted.metrics) : '')

    const rect = JSON.parse(await session.evaluate(`JSON.stringify((() => { const r = document.querySelector('.bar .toolbar-actions').getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) } })())`))
    const capture = async ior => {
      const dataUrl = await session.evaluate(`(() => { window.__webgl.backend.render({ ior: ${ior}, pattern: true }); return document.querySelector('canvas.alaya-optical-webgl').toDataURL('image/png') })()`)
      const buffer = Buffer.from(String(dataUrl).split(',')[1], 'base64')
      return { image: decodePng(buffer), buffer }
    }
    // 用高对比网格做对照组：平滑渐变背景下折射本来就看不见（取到的颜色几乎一样），
    // 要证明 GPU 端确实在推像素，必须换成高频背景——这正是验收标准里那条「网格」。
    const flat = await capture(1.0)
    const bent = await capture(1.5)
    writeFileSync(join(out, 'ior-1.0.png'), flat.buffer)
    writeFileSync(join(out, 'ior-1.5.png'), bent.buffer)

    const inside = { x: rect.x + 8, y: rect.y + 8, width: rect.width - 16, height: rect.height - 16 }
    const outside = { x: 600, y: 700, width: 300, height: 120 }
    const insideDiff = meanDiff(flat.image, bent.image, inside)
    const outsideDiff = meanDiff(flat.image, bent.image, outside)
    check('形状内部产生可见折射', insideDiff.mean > 1, `平均差 ${insideDiff.mean.toFixed(2)}，最大 ${insideDiff.max}`)
    check('形状外部几乎不变（没有整屏重绘）', outsideDiff.max < 8, `平均差 ${outsideDiff.mean.toFixed(3)}，最大 ${outsideDiff.max}`)

    const before = JSON.parse(await session.evaluate('JSON.stringify(window.__webgl.backend.metrics())'))
    await sleep(800)
    const after = JSON.parse(await session.evaluate('JSON.stringify(window.__webgl.backend.metrics())'))
    check('静止时不重复 render', after.renders === before.renders, `${before.renders} → ${after.renders}（${after.lastRenderMs}ms/帧）`)

    const errors = await session.evaluate('JSON.stringify(window.__previewErrors || [])')
    check('没有页面异常', errors === '[]', errors)
    await session.evaluate('window.__webgl.dispose()')
  }
  console.log(`\n${failed === 0 ? 'WebGL 后端验收通过' : `${failed} 项失败`}`)
} finally {
  await session.close()
  server.close()
}
process.exitCode = failed === 0 ? 0 : 1
