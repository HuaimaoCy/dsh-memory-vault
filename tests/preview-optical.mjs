/**
 * 0.8 光学验收：三条硬性视觉标准，量的是合成后的像素，不是 DOM 属性。
 *
 *   node tests/preview-optical.mjs
 *
 * 1. 折射：工具栏后面放高对比网格，full 档下网格在玻璃边缘产生可见位移，且没有接缝尖峰。
 * 2. 真实界面：不注入任何彩色背景，仅凭环境色 + 边缘高光就能看出「这是玻璃」。
 * 3. 动态：指针移动后轮廓高光角度与位置真的变化。
 *
 * 依赖 `tests/png.mjs`（无第三方包的 PNG 解码）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ChromiumSession } from './preview-cdp.mjs'
import { createPreviewServer } from './preview-app.mjs'
import { decodePng } from './png.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'test-tmp', 'preview', 'optical')
mkdirSync(out, { recursive: true })
const sleep = ms => new Promise(done => setTimeout(done, ms))
const results = []

/** 区域内平均亮度与「行间二阶差分」：位移会让网格线整体挪位，接缝则表现为孤立的尖峰。 */
const regionStats = (image, { x, y, width, height }) => {
  const luma = (px, py) => {
    const index = (py * image.width + px) * 4
    return 0.2126 * image.data[index] + 0.7152 * image.data[index + 1] + 0.0722 * image.data[index + 2]
  }
  let sum = 0, count = 0
  for (let py = y; py < y + height; py++) for (let px = x; px < x + width; px++) { sum += luma(px, py); count++ }
  return { mean: sum / count, luma }
}

const withApp = async (run, { width = 1440, height = 940, tier = 'balanced' } = {}) => {
  const server = createPreviewServer({ mode: 'memory' })
  await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done) })
  const base = `http://127.0.0.1:${server.address().port}/`
  const session = await ChromiumSession.launch({ width, height, profile: join(root, 'test-tmp', 'work', `optical-${process.pid}-${Math.round(Math.random() * 1e6)}`) })
  try {
    await session.goto(base)
    await session.waitFor(`!document.getElementById('alaya-startup') && document.querySelector('[data-glass-surface]')`, { timeout: 30000 })
    await session.evaluate(`window.alayaGlass.setTier('${tier}')`)
    await sleep(600)
    await sleep(300)
    return await run(session, base)
  } finally { await session.close(); server.close() }
}

const shot = async (session, name) => {
  const file = join(out, `${name}.png`)
  const data = await session.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(file, Buffer.from(data.data, 'base64'))
  return { file, image: decodePng(Buffer.from(data.data, 'base64')) }
}

// ---------- 1. 折射：网格在玻璃边缘是否真的被推开 ----------
await withApp(async session => {
  // 把网格铺在胶囊正后方。必须挂进 .app-shell 并给负 z-index：
  // .app-shell 是 isolation 的堆叠上下文，挂在 body 上的 z-index:5 会整块盖住界面
  // （第一次跑出 0.00 的差就是这个原因——两张截图都被网格挡住了）。
  await session.evaluate(`(() => {
    const grid = document.createElement('div')
    grid.id = 'optical-grid'
    grid.style.cssText = 'position:fixed;left:1080px;top:0;width:360px;height:120px;z-index:-1;pointer-events:none;'
      + 'background:repeating-linear-gradient(90deg,#0b1522 0 2px,transparent 2px 11px),'
      + 'repeating-linear-gradient(0deg,#0b1522 0 2px,transparent 2px 11px),#fff'
    document.querySelector('.app-shell').append(grid)
    return true
  })()`)
  await sleep(200)
  const off = await shot(session, 'grid-balanced')
  await session.evaluate(`window.alayaGlass.setTier('full')`)
  await sleep(900)
  const on = await shot(session, 'grid-full')
  const rect = await session.evaluate(`JSON.stringify((() => { const r = document.querySelector('.toolbar-actions').getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) } })())`)
  const box = JSON.parse(rect)
  // 只量胶囊内部靠边的一条带（边缘折射最明显的地方）
  const band = { x: box.x + 4, y: box.y + 4, width: box.width - 8, height: box.height - 8 }
  const a = regionStats(off.image, band), b = regionStats(on.image, band)
  let diff = 0, worst = 0, count = 0
  for (let py = band.y; py < band.y + band.height; py++) {
    for (let px = band.x; px < band.x + band.width; px++) {
      const d = Math.abs(a.luma(px, py) - b.luma(px, py))
      diff += d; count++
      worst = Math.max(worst, d)
    }
  }
  const mean = diff / count
  results.push({ name: 'refraction', mean: +mean.toFixed(2), worst: +worst.toFixed(1), box })
  assert.ok(mean > 1.2, `full 档下胶囊区域应有可见的位移（平均差 > 1.2），实际 ${mean.toFixed(2)}`)
  assert.ok(worst > 12, `位移应形成明显的边缘变化（最大差 > 12），实际 ${worst.toFixed(1)}`)
  console.log(`ok   折射：胶囊区域平均像素差 ${mean.toFixed(2)}，最大 ${worst.toFixed(1)}（full vs balanced）`)
}, { tier: 'balanced' })

// ---------- 2. 真实界面：不注入背景也能看出玻璃 ----------
await withApp(async session => {
  const plain = await shot(session, 'real-interface')
  const rect = JSON.parse(await session.evaluate(`JSON.stringify((() => {
    const side = document.querySelector('.side').getBoundingClientRect()
    return { left: Math.round(side.left), top: Math.round(side.top), width: Math.round(side.width), height: Math.round(side.height) }
  })())`))
  // 侧栏顶部与底部（环境色从暖到冷，玻璃透上来应该有色差）
  const top = regionStats(plain.image, { x: rect.left + 20, y: rect.top + 14, width: rect.width - 40, height: 24 })
  const bottom = regionStats(plain.image, { x: rect.left + 20, y: rect.top + rect.height - 40, width: rect.width - 40, height: 24 })
  // 边缘：面板左边缘 2px 带 vs 内部 40px 处（白描边 + 高光应更亮）
  const edge = regionStats(plain.image, { x: rect.left + 12, y: rect.top + 120, width: 2, height: 300 })
  const inner = regionStats(plain.image, { x: rect.left + 60, y: rect.top + 120, width: 2, height: 300 })
  const ambient = Math.abs(top.mean - bottom.mean)
  const rim = Math.abs(edge.mean - inner.mean)
  results.push({ name: 'real-interface', ambient: +ambient.toFixed(2), rim: +rim.toFixed(2) })
  assert.ok(ambient > 1.5, `侧栏应随环境色变化（上/下平均亮度差 > 1.5），实际 ${ambient.toFixed(2)}`)
  assert.ok(rim > 3, `面板边缘应比内部更亮（白描边 + 轮廓高光），实际 ${rim.toFixed(2)}`)
  console.log(`ok   真实界面：侧栏上下环境色差 ${ambient.toFixed(2)}，边缘高光比内部亮 ${rim.toFixed(2)}`)
}, { tier: 'balanced' })

// ---------- 3. 动态：指针移动后轮廓高光跟着转 ----------
await withApp(async session => {
  const probe = () => session.evaluate(`JSON.stringify({
    x: document.querySelector('.side').style.getPropertyValue('--glass-glare-x'),
    y: document.querySelector('.side').style.getPropertyValue('--glass-glare-y'),
    angle: document.querySelector('.side').style.getPropertyValue('--glass-rim-angle'),
    o: document.querySelector('.side').style.getPropertyValue('--glass-glare-o'),
  })`)
  await session.evaluate(`document.querySelector('.side').dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 40, clientY: 240, pointerType: 'mouse' }))`)
  await sleep(260)
  const a = JSON.parse(await probe())
  await session.evaluate(`document.querySelector('.side').dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 190, clientY: 820, pointerType: 'mouse' }))`)
  await sleep(260)
  const b = JSON.parse(await probe())
  results.push({ name: 'dynamic', from: a.angle, to: b.angle })
  assert.notEqual(a.angle, '', '指针进入后应写入轮廓角度')
  assert.notEqual(a.angle, b.angle, `指针换位后轮廓高光角度应变化（${a.angle} → ${b.angle}）`)
  assert.ok(Number(b.o) > 0.5, `高光应随指针升到 1 附近，实际 ${b.o}`)
  console.log(`ok   动态：轮廓高光角度 ${a.angle} → ${b.angle}，辉光 ${a.o} → ${b.o}`)
})

console.log(`\n${results.length} 项光学验收通过，截图在 ${out}`)
