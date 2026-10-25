/**
 * 光学引擎性能基准：基线 vs full 档（SVG 折射后端）。
 *
 *   node tests/preview-perf.mjs
 *
 * 量的是「玻璃本身带来的增量」，不是整屏帧率绝对值：
 *   1. 静止：切到 full 并稳定后，再等 1 秒，引擎的 render 次数必须**不增长**（零持续重绘）；
 *   2. 交互：指针连续划过玻璃 → 只更新高光参数，不得重建贴图（render 次数不变）；
 *   3. 滚动：玻璃不跟随滚动重算（没有 scroll 监听），滚动帧间隔应与基线一致；
 *   4. 首帧：切到 full 的那一帧有一次性贴图生成成本，单独记录（不是每帧成本）。
 *
 * 环境是 headless 软件合成，绝对帧时间只作下限参考；同一个进程内的基线对比才有意义。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ChromiumSession } from './preview-cdp.mjs'
import { createPreviewServer } from './preview-app.mjs'

const root = resolve(import.meta.dirname, '..')
const out = join(root, 'test-tmp', 'preview', 'perf')
mkdirSync(out, { recursive: true })
const sleep = ms => new Promise(done => setTimeout(done, ms))

const server = createPreviewServer({ mode: 'memory' })
await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done) })
const base = `http://127.0.0.1:${server.address().port}/`
const session = await ChromiumSession.launch({ width: 1440, height: 940, profile: join(root, 'test-tmp', 'work', `perf-${process.pid}`) })
const evaluate = source => session.evaluate(source)

/** 采样 n 帧的间隔（ms），返回 p50/p95/max。 */
const sampleFrames = async (count = 90) => {
  await evaluate(`(() => {
    window.__frames = []
    window.__stop = false
    const tick = ts => { if (window.__stop) return; window.__frames.push(ts); requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
  })()`)
  await sleep(Math.ceil((count / 60) * 1000) + 200)
  await evaluate('window.__stop = true')
  const gaps = await evaluate(`(() => { const f = window.__frames; const out = []; for (let i = 1; i < f.length; i++) out.push(f[i] - f[i - 1]); return JSON.stringify(out) })()`)
  const values = JSON.parse(gaps).filter(value => value > 0 && value < 500).sort((a, b) => a - b)
  const at = p => values[Math.min(values.length - 1, Math.floor(values.length * p))] || 0
  return { count: values.length, p50: +at(0.5).toFixed(2), p95: +at(0.95).toFixed(2), max: +(values[values.length - 1] || 0).toFixed(2) }
}

const engineMetrics = async () => JSON.parse(await evaluate('JSON.stringify(window.alayaGlass.opticalMetrics())'))

const report = []
const record = (name, data) => { report.push({ name, ...data }); console.log(`  ${name}: ${JSON.stringify(data)}`) }

try {
  await session.goto(base)
  await session.waitFor(`!document.getElementById('alaya-startup') && document.querySelector('[data-glass-surface]')`, { timeout: 30000 })
  await sleep(600)

  // ---------- 基线（balanced，无折射后端） ----------
  await evaluate(`window.alayaGlass.setTier('balanced')`)
  await sleep(400)
  record('baseline.scroll', await sampleFrames())
  record('baseline.idle', await sampleFrames(60))

  // ---------- 切到 full：一次性成本 ----------
  const before = Date.now()
  await evaluate(`window.alayaGlass.setTier('full')`)
  await session.waitFor('window.alayaGlass.opticalMetrics() !== null', { timeout: 15000 })
  await session.waitFor('window.alayaGlass.opticalMetrics().maps > 0', { timeout: 15000 })
  await sleep(300)
  const switchMs = Date.now() - before
  const metricsAfterSwitch = await engineMetrics()
  record('switch.full', { ms: switchMs, maps: metricsAfterSwitch.maps, filters: metricsAfterSwitch.filters, firstRenderMs: metricsAfterSwitch.lastRenderMs })

  // ---------- 静止：引擎不应继续渲染 ----------
  const idleStart = await engineMetrics()
  await sleep(1200)
  const idleEnd = await engineMetrics()
  record('idle.engine', {
    rendersBefore: idleStart.renders,
    rendersAfter: idleEnd.renders,
    delta: idleEnd.renders - idleStart.renders,
    mapsBefore: idleStart.maps,
    mapsAfter: idleEnd.maps,
  })
  record('full.idle', await sampleFrames(60))

  // ---------- 指针划过：只动高光，不重建贴图 ----------
  const sweepStart = await engineMetrics()
  await evaluate(`(async () => {
    const target = document.querySelector('.bar .toolbar-actions')
    const rect = target.getBoundingClientRect()
    for (let i = 0; i < 40; i++) {
      target.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse', clientX: rect.left + (rect.width * i) / 40, clientY: rect.top + 10 }))
      await new Promise(done => requestAnimationFrame(done))
    }
  })()`)
  await sleep(200)
  const sweepEnd = await engineMetrics()
  record('pointer.sweep', { renders: sweepEnd.renders - sweepStart.renders, maps: sweepEnd.maps - sweepStart.maps, lastRenderMs: sweepEnd.lastRenderMs })

  // ---------- 滚动：玻璃不参与 ----------
  await evaluate(`document.querySelector('.main')?.scrollTo({ top: 240 })`)
  record('full.scroll', await sampleFrames())

  // ---------- 命令面板：首次打开的一次性成本 ----------
  const paletteBefore = await engineMetrics()
  // 派发到 body（冒泡到 document）；派发到 window 不会触发 document 上的监听
  await evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))`)
  await sleep(600)
  const paletteAfter = await engineMetrics()
  record('palette.open', {
    opened: await evaluate("Boolean(document.querySelector('.command-palette'))"),
    mapsBefore: paletteBefore.maps, mapsAfter: paletteAfter.maps,
    renders: paletteAfter.renders - paletteBefore.renders,
    lastRenderMs: paletteAfter.lastRenderMs,
  })

  // ---------- 自适应质量：auto 档可在超预算时降级 ----------
  await evaluate(`window.alayaGlass.engine()?.setQuality('auto')`)
  await sleep(300)
  const autoMetrics = await engineMetrics()
  record('adaptive', { quality: autoMetrics.quality, supported: autoMetrics.qualityChanges !== undefined })

  writeFileSync(join(out, 'perf.json'), JSON.stringify({ at: new Date().toISOString(), report }, null, 2))
  console.log(`\n基准已写入 ${join(out, 'perf.json')}`)
  console.log('口径：headless 软件合成，绝对值只作下限；关键判据是「静止与指针交互期间引擎渲染次数不增长」。')
} finally {
  await session.close()
  server.close()
}
