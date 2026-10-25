/**
 * Alaya 自研材质 vs 开源 @xiaojiaenen/liquid-glass：同一环境下的直接对照实验。
 *
 *   node tests/liquid-glass-compare.mjs                  # 软件合成（与验收脚本同口径）
 *   node tests/liquid-glass-compare.mjs --gpu            # 真 GPU 合成（性能数字只认这个）
 *   node tests/liquid-glass-compare.mjs --out 目录       # 改输出目录
 *   node tests/liquid-glass-compare.mjs --skip-deps      # 依赖已就位，不联网
 *
 * 为什么要这个脚本（而不是再看一眼 README）：技术路线相同不代表实现质量相同。
 * 两条链都用 `backdrop-filter: url(#svg)`，差别只在位移贴图、滤镜组合与回退策略，
 * 所以唯一有说服力的做法是：同一张底层背景、同一套几何、同一个 Chromium，把四个引
 * 擎各渲染一遍，然后对**合成后的像素**下判断——不是对 DOM 里的属性值下判断。
 *
 * 量测口径（全部按像素）：
 *   glassEnergy     面内与「无玻璃」基准的平均差：材质改动了多少背景
 *   edgeCenterRatio 边缘带差 / 中心差：是否真的在**边缘**折射（模糊引擎≈1）
 *   seam            沿边内 2–20px 的二阶差分：位移贴图拉伸/分桶留下的接缝
 *   cornerBleed     圆角弧线**之外**与基准的差：圆角裁剪有没有失效
 *   outsideLeak     面外侧 6px 环与基准的差：位移有没有越出面
 *   scrollDelta     背景上移 60px 后的面内变化：是否每帧重新采样（不是贴死一张图）
 *   frames          背景动画期的 rAF 间隔（相对比较；软件合成是下限）
 *   mapMs           每个尺寸的贴图生成本钱（第三方两张，Alaya 一张）
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Session, defaultBrowser } from './fixtures/liquid-glass-compare/cdp.mjs'
import { decodePng, diffStats, lumaAt, seamScore } from './fixtures/liquid-glass-compare/png.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const arg = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
const flag = name => process.argv.includes(name)
const out = resolve(root, arg('--out') ?? join('test-tmp', 'liquid-glass-compare'))
const gpu = flag('--gpu')
const probeDir = join(root, 'test-tmp', 'liquid-glass-probe')
const thirdParty = { name: '@xiaojiaenen/liquid-glass', version: '0.1.5' }
const pagePath = 'tests/fixtures/liquid-glass-compare/index.html'
mkdirSync(out, { recursive: true })
mkdirSync(join(out, 'crops'), { recursive: true })

const sleep = ms => new Promise(done => setTimeout(done, ms))
const step = message => console.log(`• ${message}`)

// ---------------------------------------------------------------------------
// 0. 依赖：第三方包与 React 18（UMD）。缺失才联网，已就位就不动。
// ---------------------------------------------------------------------------
const ensureDeps = async () => {
  const tarball = join(probeDir, `liquid-glass-${thirdParty.version}.tgz`)
  const pkg = join(probeDir, 'package', 'package.json')
  if (!existsSync(pkg)) {
    mkdirSync(probeDir, { recursive: true })
    if (!existsSync(tarball)) {
      step(`下载 ${thirdParty.name}@${thirdParty.version}`)
      // npm 的 tarball 名去掉作用域：@scope/name@ver → name-ver.tgz
      const unscoped = thirdParty.name.split('/').pop()
      const file = `${unscoped}-${thirdParty.version}.tgz`
      const reply = await fetch(`https://registry.npmjs.org/${thirdParty.name.replace('/', '%2F')}/-/${file}`)
      if (!reply.ok) throw new Error(`下载失败：${reply.status}（${file}）`)
      writeFileSync(tarball, Buffer.from(await reply.arrayBuffer()))
    }
    execFileSync('tar', ['-xzf', tarball], { cwd: probeDir, stdio: 'inherit' })
  }
  const reactUmd = join(probeDir, 'deps', 'node_modules', 'react', 'umd', 'react.production.min.js')
  if (!existsSync(reactUmd)) {
    step('安装 React 18（UMD，供原版组件加载）')
    const deps = join(probeDir, 'deps')
    mkdirSync(deps, { recursive: true })
    writeFileSync(join(deps, 'package.json'), JSON.stringify({ name: 'liquid-glass-probe-deps', private: true }, null, 2))
    execFileSync('npm.cmd', ['install', '--silent', '--no-audit', '--no-fund', 'react@18.3.1', 'react-dom@18.3.1'], { cwd: deps, stdio: 'inherit' })
  }
  assert.ok(existsSync(join(probeDir, 'package', 'dist', 'lib', 'LiquidGlass.js')), '第三方包里没有 dist/lib/LiquidGlass.js')
  return {
    version: JSON.parse(readFileSync(pkg, 'utf8')).version,
    stylesheet: existsSync(join(probeDir, 'package', 'dist', 'style.css')) ? 'dist/style.css' : null,
    exportsStyles: JSON.parse(readFileSync(pkg, 'utf8')).exports?.['./styles'] ?? null,
  }
}

// ---------------------------------------------------------------------------
// 1. 静态服务器：根目录是整个 add-on，页面里的相对路径与绝对路径都能直达。
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.tgz': 'application/octet-stream',
}

const serve = () => new Promise((done, fail) => {
  const server = createServer((request, response) => {
    const url = decodeURIComponent((request.url ?? '/').split('?')[0])
    const file = normalize(join(root, url))
    if (!file.startsWith(root + sep) || !existsSync(file) || statSync(file).isDirectory()) {
      response.writeHead(404).end('not found')
      return
    }
    response.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' })
    createReadStream(file).pipe(response)
  })
  server.once('error', fail)
  server.listen(0, '127.0.0.1', () => done(server))
})

const hashOf = path => createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 12)

// ---------------------------------------------------------------------------
// 2. 像素量测
// ---------------------------------------------------------------------------
const ENGINES = ['alaya-css', 'alaya-refraction', 'xiaojiaenen-default', 'xiaojiaenen-aligned']

const shrink = (rect, by) => ({ x: rect.x + by, y: rect.y + by, width: rect.width - by * 2, height: rect.height - by * 2 })

/**
 * 圆角弧线之外的像素：位移若把背景推到圆角外，这里会与「无玻璃」基准出现差异。
 *
 * 只在**圆角所在象限**里找（x ≤ cx 且 y ≤ cy）。这一条容易写错：把整个 2r 见方的
 * 方块都算进去，弧的另一侧其实是形状内部，量出来会是「内部差」而不是「外泄」。
 */
const cornerBleed = (shown, bare, rect, radius) => {
  const r = Math.min(radius, rect.width / 2, rect.height / 2)
  if (r < 2) return null
  // 每个角的「外侧象限」方向不同：左上取 x<cx,y<cy，右上取 x>cx,y<cy，依此类推。
  // 四个角都用 x<cx,y<cy 会量到另外三个角的**形状内部**去了。
  const corners = [
    { cx: rect.x + r, cy: rect.y + r, sx: -1, sy: -1 },
    { cx: rect.x + rect.width - r, cy: rect.y + r, sx: 1, sy: -1 },
    { cx: rect.x + r, cy: rect.y + rect.height - r, sx: -1, sy: 1 },
    { cx: rect.x + rect.width - r, cy: rect.y + rect.height - r, sx: 1, sy: 1 },
  ]
  let sum = 0
  let max = 0
  let count = 0
  let changed = 0
  const pad = 4
  for (const { cx, cy, sx, sy } of corners) {
    const x0 = Math.round(sx < 0 ? cx - r - pad : cx)
    const x1 = Math.round(sx < 0 ? cx : cx + r + pad)
    const y0 = Math.round(sy < 0 ? cy - r - pad : cy)
    const y1 = Math.round(sy < 0 ? cy : cy + r + pad)
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r + 1.2) continue
        if (x < 0 || y < 0 || x >= shown.width || y >= shown.height) continue
        const i = (y * shown.width + x) * 4
        const d = (Math.abs(shown.data[i] - bare.data[i]) + Math.abs(shown.data[i + 1] - bare.data[i + 1]) + Math.abs(shown.data[i + 2] - bare.data[i + 2])) / 3
        sum += d
        if (d > max) max = d
        if (d > 2) changed++
        count++
      }
    }
  }
  return count ? {
    pixels: count,
    mean: Number((sum / count).toFixed(3)),
    max: Number(max.toFixed(2)),
    changedRatio: Number((changed / count).toFixed(4)),
  } : null
}

/** 面外侧 6px 的环：位移越界、投影外溢都会在这里显形。 */
const outsideRing = (shown, bare, rect) => {
  const pad = 6
  const regions = [
    { x: rect.x - pad, y: rect.y - pad, width: rect.width + pad * 2, height: pad },
    { x: rect.x - pad, y: rect.y + rect.height, width: rect.width + pad * 2, height: pad },
    { x: rect.x - pad, y: rect.y, width: pad, height: rect.height },
    { x: rect.x + rect.width, y: rect.y, width: pad, height: rect.height },
  ]
  const parts = regions.map(region => diffStats(shown, bare, region))
  return {
    mean: Number((parts.reduce((sum, part) => sum + part.mean * part.pixels, 0) / Math.max(1, parts.reduce((sum, part) => sum + part.pixels, 0))).toFixed(3)),
    max: Math.max(...parts.map(part => part.max)),
  }
}

/**
 * 边缘响应的横向一致性：沿边取一堆剖面（离边 start..start+depth 的亮度），
 * 与中位剖面比较的 RMS。位移贴图被拉伸/分桶/圆角对不上时，边缘响应会随位置变，
 * 这个数上去；而描边、文字这类位置无关的东西会被中位剖面吃掉，不计入。
 */
const edgeInstability = (image, rect, { edge = 'top', start = 3, depth = 22, inset = 12 } = {}) => {
  const horizontal = edge === 'top' || edge === 'bottom'
  const along = horizontal ? rect.width : rect.height
  const safeInset = Math.min(inset, Math.max(2, Math.floor((along - 40) / 2)))
  const profiles = []
  for (let t = safeInset; t < along - safeInset; t++) {
    const profile = []
    for (let d = 0; d <= depth; d++) {
      let x
      let y
      if (edge === 'top') { x = rect.x + t; y = rect.y + start + d }
      else if (edge === 'bottom') { x = rect.x + t; y = rect.y + rect.height - start - d }
      else if (edge === 'left') { x = rect.x + start + d; y = rect.y + t }
      else { x = rect.x + rect.width - start - d; y = rect.y + t }
      if (x < 0 || y < 0 || x >= image.width || y >= image.height) { profile.length = 0; break }
      profile.push(lumaAt(image, x, y))
    }
    if (profile.length) profiles.push(profile)
  }
  if (profiles.length < 8) return 0
  const median = profiles[0].map((_, index) => {
    const values = profiles.map(profile => profile[index]).sort((a, b) => a - b)
    return values[values.length >> 1]
  })
  let sum = 0
  for (const profile of profiles) {
    for (let index = 0; index < profile.length; index++) sum += (profile[index] - median[index]) ** 2
  }
  return Number(Math.sqrt(sum / (profiles.length * median.length)).toFixed(2))
}

const measure = ({ shown, bare, scrolled, shapes }) => shapes.map(shape => {
  const radius = shape.materialRadius ?? shape.radius
  const inner = shrink(shape, 4)
  const bandTop = { x: shape.x + 10, y: shape.y + 2, width: shape.width - 20, height: 22 }
  const bandBottom = { x: shape.x + 10, y: shape.y + shape.height - 24, width: shape.width - 20, height: 22 }
  const center = { x: shape.x + shape.width * 0.25, y: shape.y + shape.height * 0.35, width: shape.width * 0.5, height: shape.height * 0.3 }
  const edges = ['top', 'bottom', 'left', 'right'].map(edge => seamScore(shown, shape, { edge, start: 2, depth: 18, inset: Math.min(10, radius + 2) }))
  const seamMax = Math.max(...edges.map(edge => edge.p90 ?? 0))
  const edgeEnergy = (diffStats(shown, bare, bandTop).mean + diffStats(shown, bare, bandBottom).mean) / 2
  const centerEnergy = diffStats(shown, bare, center).mean
  const instability = Math.max(
    edgeInstability(shown, shape, { edge: 'top', inset: Math.round(radius) + 8 }),
    edgeInstability(shown, shape, { edge: 'bottom', inset: Math.round(radius) + 8 }),
  )
  return {
    engine: shape.engine,
    kind: shape.kind,
    radius,
    size: `${Math.round(shape.width)}×${Math.round(shape.height)}`,
    backdropFilter: shape.backdropFilter,
    mounted: shape.mounted,
    glassEnergy: diffStats(shown, bare, inner).mean,
    edgeEnergy: Number(edgeEnergy.toFixed(3)),
    centerEnergy: Number(centerEnergy.toFixed(3)),
    edgeCenterRatio: Number((edgeEnergy / Math.max(centerEnergy, 0.01)).toFixed(2)),
    seam: { p90: Number(seamMax.toFixed(2)), max: Number(Math.max(...edges.map(edge => edge.max ?? 0)).toFixed(2)) },
    seamInstability: instability,
    corner: cornerBleed(shown, bare, shape, radius),
    outside: outsideRing(shown, bare, shape),
    scrollDelta: diffStats(shown, scrolled, inner).mean,
  }
})

// ---------------------------------------------------------------------------
// 3. 主流程
// ---------------------------------------------------------------------------
const table = rows => {
  const head = Object.keys(rows[0])
  const widths = head.map(key => Math.max(key.length, ...rows.map(row => String(row[key] ?? '').length)))
  const line = cells => cells.map((cell, index) => String(cell ?? '').padEnd(widths[index])).join('  ')
  return [line(head), widths.map(width => '-'.repeat(width)).join('  '), ...rows.map(row => line(head.map(key => row[key])))].join('\n')
}

const main = async () => {
  const pkgFacts = flag('--skip-deps') && existsSync(join(probeDir, 'package', 'package.json'))
    ? { version: JSON.parse(readFileSync(join(probeDir, 'package', 'package.json'), 'utf8')).version, stylesheet: 'dist/style.css', exportsStyles: './dist/index.css' }
    : await ensureDeps()
  step(`第三方包 ${thirdParty.name}@${pkgFacts.version}（license MIT，peer react 18）`)

  const server = await serve()
  const base = `http://127.0.0.1:${server.address().port}/`
  const session = await Session.launch({ width: 1440, height: 1000, gpu, profile: join(out, 'work', `profile-${Date.now()}`) })
  const report = { generatedAt: new Date().toISOString(), gpu, browser: defaultBrowser(), page: base + pagePath, package: pkgFacts, sources: {}, facts: null, layout: [], metrics: [], perf: {}, mapTimings: [], notes: [] }

  try {
    await session.goto(base + pagePath)
    await session.waitFor('window.LG && window.LG.ready === true', { label: '对照页就绪', timeout: 40000 })
    report.facts = JSON.parse(await session.evaluate('JSON.stringify(window.LG.facts)'))
    assert.equal(report.facts.thirdParty.mounted, 8, `第三方组件应挂 8 个（4 面 × 2 行），实际 ${report.facts.thirdParty.mounted}`)
    assert.equal(report.facts.thirdParty.glass, 8, '第三方组件应全部走 is-glass（而不是降级到 is-fallback）')
    assert.equal(new Set(report.facts.thirdParty.filters).size, 8, '八个组件的滤镜 id 必须互不相同（useId 不能撞车）')
    assert.ok(report.facts.refraction.supported, 'Chromium 应支持 backdrop-filter: url()')
    assert.ok(report.facts.refraction.filters > 0, 'Alaya 实验档应生成过滤器')
    assert.equal(report.facts.errors.length, 0, `页面报错：${report.facts.errors.join(' | ')}`)

    const height = Math.min(Math.max(1200, Number(await session.evaluate('document.documentElement.scrollHeight'))), 4000)
    await session.setDeviceMetrics({ width: 1440, height, deviceScaleFactor: 1 })
    await sleep(400)
    report.layout = JSON.parse(await session.evaluate('JSON.stringify(window.LG.layout())'))
    for (const engine of ENGINES) {
      const cells = report.layout.filter(cell => cell.engine === engine)
      assert.equal(cells.length, 4, `${engine} 应有 4 个面，实际 ${cells.length}`)
      assert.ok(cells.every(cell => cell.backdropFilter && cell.backdropFilter !== 'none'), `${engine} 有面没有生效 backdrop-filter`)
    }

    report.sources = {
      glassCss: hashOf(join(root, 'desktop', 'renderer', 'glass.css')),
      glassRefractionJs: hashOf(join(root, 'desktop', 'renderer', 'glass-refraction.js')),
      probePage: hashOf(join(root, pagePath)),
    }

    step('截图：全引擎 / 量测档 / 无玻璃基准 / 背景滚动')
    await session.screenshot(join(out, 'compare.png'))
    await session.evaluate('window.LG.setMeasure(true)')
    await sleep(400)
    await session.screenshot(join(out, 'compare-clean.png'))
    await session.evaluate('window.LG.setBare(true)')
    await sleep(400)
    await session.screenshot(join(out, 'bare.png'))
    await session.evaluate('window.LG.setBare(false)')
    await sleep(300)
    await session.evaluate('window.LG.setScroll(60)')
    await sleep(400)
    await session.screenshot(join(out, 'compare-scroll.png'))
    await session.evaluate('window.LG.setScroll(0)')
    await sleep(250)
    await session.evaluate('window.LG.setMeasure(false)')
    await sleep(250)

    step('放大裁剪：圆角与接缝的证据')
    const corner = (shape, side) => {
      const pad = 5
      const width = Math.min(56, shape.width)
      const x = side === 'left' ? shape.x - pad : shape.x + shape.width - width + pad
      return { x, y: shape.y - pad, width, height: Math.min(56, shape.height) + pad * 2, scale: 8 }
    }
    for (const engine of ENGINES) {
      const shapes = report.layout.filter(cell => cell.engine === engine)
      const float = shapes.find(cell => cell.kind === 'float')
      const pill = shapes.find(cell => cell.kind === 'pill')
      const bar = shapes.find(cell => cell.kind === 'bar')
      await session.screenshot(join(out, 'crops', `float-${engine}.png`), { x: float.x - 8, y: float.y - 8, width: float.width + 16, height: float.height + 16, scale: 3 })
      await session.screenshot(join(out, 'crops', `corner-${engine}.png`), corner(float, 'left'))
      await session.screenshot(join(out, 'crops', `pill-${engine}.png`), { x: pill.x - 8, y: pill.y - 8, width: pill.width + 16, height: pill.height + 16, scale: 6 })
      await session.screenshot(join(out, 'crops', `seam-${engine}.png`), { x: bar.x + 200, y: bar.y - 6, width: 220, height: bar.height + 12, scale: 6 })
    }

    step('性能：背景动画期的 rAF 间隔（每个引擎单独在场，每个采样 3 次取中位）')
    for (const engine of ['none', ...ENGINES]) {
      await session.evaluate(engine === 'none' ? 'window.LG.setEngineVisible(null, false)' : `window.LG.setEngineVisible(${JSON.stringify(engine)}, true)`)
      await sleep(350)
      const samples = []
      for (let round = 0; round < 3; round++) {
        samples.push(JSON.parse(await session.evaluate(`(async () => JSON.stringify(await window.LG.frameGaps(120)))()`)))
        await sleep(150)
      }
      const middle = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
      report.perf[engine] = {
        samples: samples.map(sample => `${sample.median}/${sample.p95}ms 掉${(sample.droppedRatio * 100).toFixed(0)}%`).join(' · '),
        median: middle(samples.map(sample => sample.median)),
        p95: middle(samples.map(sample => sample.p95)),
        droppedRatio: middle(samples.map(sample => sample.droppedRatio)),
      }
    }
    await session.evaluate('window.LG.setEngineVisible("*", true)')
    step('贴图生成本钱')
    report.mapTimings = JSON.parse(await session.evaluate(`(async () => JSON.stringify(await window.LG.mapTimings()))()`))

    const shownClean = decodePng(readFileSync(join(out, 'compare-clean.png')))
    const bare = decodePng(readFileSync(join(out, 'bare.png')))
    const scrolled = decodePng(readFileSync(join(out, 'compare-scroll.png')))
    report.metrics = measure({ shown: shownClean, bare, scrolled, shapes: report.layout })

    writeFileSync(join(out, 'metrics.json'), JSON.stringify(report, null, 2))

    const cells = report.metrics.map(item => ({
      引擎: item.engine, 面: `${item.kind} ${item.size}`,
      '材质强度': item.glassEnergy,
      '边缘/中心': item.edgeCenterRatio,
      '圆角外泄': item.corner ? `${item.corner.mean}/${item.corner.max}` : '—',
      '面外': `${item.outside.mean}/${item.outside.max}`,
      '边缘不稳': item.seamInstability,
      '接缝p90': item.seam.p90,
      '滚动差': item.scrollDelta,
    }))
    console.log(`\n## 像素量测（${gpu ? 'GPU' : '软件合成'}；外泄/面外/接缝越小越干净，材质强度与边缘/中心越大说明真的在折射）\n`)
    console.log(table(cells))

    const ablation = report.metrics.filter(item => item.engine === 'ablation')
    console.log('\n## 消融（不在本页；见 tests/liquid-glass-isolation.mjs）\n')
    assert.equal(ablation.length, 0, '消融已移到 isolation 页，本页不应再有 ablation 行')

    const perf = Object.entries(report.perf).map(([engine, value]) => ({
      引擎: engine, 'p50 中位': value.median, 'p95 中位': value.p95, '掉帧% 中位': (value.droppedRatio * 100).toFixed(1), 三次采样: value.samples,
    }))
    console.log('\n## 帧间隔（ms，背景动画中；每个引擎 3 次 × 120 帧取中位）\n')
    console.log(table(perf))

    const maps = report.mapTimings.map(item => ({
      面: item.kind, 尺寸: `${item.width}×${item.height}`,
      '第三方ms': item.thirdPartyMs, '第三方字节': item.thirdPartyBytes,
      'Alaya循环ms': item.alayaLoopMs, 'Alaya编码ms': item.alayaEncodeMs, 'Alaya字节': item.alayaBytes,
    }))
    console.log('\n## 位移贴图成本\n')
    console.log(table(maps))
    console.log(`\n截图与 metrics.json：${out}`)
  } finally {
    await session.close()
    server.close()
  }
}

main().catch(error => {
  console.error(`\n对照实验失败：${error.message}`)
  process.exitCode = 1
})
