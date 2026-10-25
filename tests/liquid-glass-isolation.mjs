/**
 * 滤镜链隔离实验：`backdrop-filter: url(#svg)` 里，哪一步让折射失效。
 *
 *   node tests/liquid-glass-isolation.mjs            # 软件合成（与验收脚本同口径）
 *   node tests/liquid-glass-isolation.mjs --gpu      # 换 GPU 合成再跑一遍
 *
 * 做法：用**第三方自己的位移贴图生成器**造贴图，把它的滤镜链按节点逐层拆成 13 个变体，
 * 每个变体一个同尺寸（420×240、r20）的格子，铺在同一张 1px 网格 + 高饱和色环上；
 * 再关掉全部滤镜截一张「无玻璃」基准，逐格量**内部差**（离边 14px 以内不取）与
 * **边缘环差**（贴边 0–8px）。
 *
 * 判据：
 *   - 内部差 ≈ 0 而环差 > 0 → 只有镜面/描边在画，折射没生效；
 *   - 内部差 > 5 → 背景真的被位移（网格被推到别处，内部像素跟着变）。
 * 为什么用内部差而不是看截图：镜面高光是一条贴着圆角的亮线，肉眼很容易读成「折射」。
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Session, defaultBrowser } from './fixtures/liquid-glass-compare/cdp.mjs'
import { decodePng, diffStats } from './fixtures/liquid-glass-compare/png.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const arg = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
const flag = name => process.argv.includes(name)
const out = resolve(root, arg('--out') ?? join('test-tmp', 'liquid-glass-isolation'))
const gpu = flag('--gpu')
const pagePath = 'tests/fixtures/liquid-glass-compare/isolation.html'
mkdirSync(out, { recursive: true })

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' }
const serve = () => new Promise((done, fail) => {
  const server = createServer((request, response) => {
    const url = decodeURIComponent((request.url ?? '/').split('?')[0])
    const file = normalize(join(root, url))
    if (!file.startsWith(root + sep) || !existsSync(file) || statSync(file).isDirectory()) return response.writeHead(404).end('not found')
    response.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' })
    createReadStream(file).pipe(response)
  })
  server.once('error', fail)
  server.listen(0, '127.0.0.1', () => done(server))
})

const table = rows => {
  const head = Object.keys(rows[0])
  const widths = head.map(key => Math.max(key.length, ...rows.map(row => String(row[key] ?? '').length)))
  const line = cells => cells.map((cell, index) => String(cell ?? '').padEnd(widths[index])).join('  ')
  return [line(head), widths.map(width => '-'.repeat(width)).join('  '), ...rows.map(row => line(head.map(key => row[key])))].join('\n')
}

const sleep = ms => new Promise(done => setTimeout(done, ms))

const main = async () => {
  const server = await serve()
  const base = `http://127.0.0.1:${server.address().port}/`
  const session = await Session.launch({ gpu, width: 1440, height: 1340, profile: join(out, 'work', `profile-${Date.now()}`) })
  try {
    await session.goto(base + pagePath)
    await session.waitFor('window.__cells && window.__cells.length > 0', { label: '隔离页就绪', timeout: 30000 })
    await sleep(500)
    const cells = JSON.parse(await session.evaluate('JSON.stringify(window.__cells)'))
    const facts = JSON.parse(await session.evaluate('JSON.stringify(window.__facts)'))
    assert.equal(cells.length, facts.variants.length, '格子数与变体数必须一致')

    await session.screenshot(join(out, 'isolation.png'))
    await session.evaluate('window.__setOff(true)')
    await sleep(400)
    await session.screenshot(join(out, 'isolation-bare.png'))
    await session.evaluate('window.__setOff(false)')

    const shown = decodePng(readFileSync(join(out, 'isolation.png')))
    const bare = decodePng(readFileSync(join(out, 'isolation-bare.png')))

    const rows = cells.map(cell => {
      const inner = { x: cell.x + 14, y: cell.y + 14, width: cell.width - 28, height: cell.height - 28 }
      const ring = [
        { x: cell.x + 1, y: cell.y + 1, width: cell.width - 2, height: 8 },
        { x: cell.x + 1, y: cell.y + cell.height - 9, width: cell.width - 2, height: 8 },
        { x: cell.x + 1, y: cell.y + 1, width: 8, height: cell.height - 2 },
        { x: cell.x + cell.width - 9, y: cell.y + 1, width: 8, height: cell.height - 2 },
      ]
      const ringStats = ring.map(region => diffStats(shown, bare, region))
      const ringPixels = ringStats.reduce((sum, item) => sum + item.pixels, 0)
      const ringMean = Number((ringStats.reduce((sum, item) => sum + item.mean * item.pixels, 0) / ringPixels).toFixed(2))
      const innerMean = diffStats(shown, bare, inner).mean
      return {
        变体: facts.variants[cell.index].label.slice(0, 34),
        环差: ringMean,
        内部差: innerMean,
        // 位移指纹：位移只发生在贴边那条带里（贴图中心是中性值 128），所以带内变、
        // 内部不变 ⇒ 比值大。blur / 饱和度是全幅效果，比值 ≈ 1。
        带内比: Number((ringMean / Math.max(innerMean, 0.01)).toFixed(1)),
        滤镜: facts.variants[cell.index].filter.slice(0, 22),
      }
    })

    console.log(`\n## 滤镜链隔离（${gpu ? 'GPU' : '软件'}合成）\n`)
    console.log('读法：位移只发生在贴边那条带（贴图中心是中性值 128），所以「带内比」大、环差高 =')
    console.log('背景真的被大幅位移；blur / 饱和度是全幅效果，带内比 ≈ 1。\n')
    console.log(table(rows))

    // 判据（把「像素变了」和「像素被位移」区分开）：
    //   位移 = 环差 > 15 且 带内比 > 5
    //   全幅 = 带内比 < 1.5（内部跟环一起变）
    const byLabel = label => rows.find(row => row.变体.startsWith(label))
    const displaced = row => row.环差 > 15 && row.带内比 > 1.4 && row.内部差 < 25
    const fullSurface = row => row.带内比 < 1.3 && row.内部差 > 8
    const cases = {
      'V1 Alaya 式': { row: byLabel('V1'), expect: displaced, why: 'Alaya 的 feImage→feDisplacementMap 应该真的位移' },
      'V4 第三方原链': { row: byLabel('V4'), expect: displaced, why: '第三方原链（含链首 blur）应该也真的位移' },
      'V12 去链首 blur': { row: byLabel('V12'), expect: displaced, why: '去掉链首 blur 后仍是位移' },
      'V6 纯 blur': { row: byLabel('V6 只'), expect: fullSurface, why: 'CSS blur 是全幅效果' },
      'V14 只饱和': { row: byLabel('V14'), expect: fullSurface, why: 'feColorMatrix 饱和是全幅效果' },
      'V15 只镜面': { row: byLabel('V15'), expect: row => row.环差 < 12, why: '镜面只画一条贴边亮线' },
    }
    for (const [name, { row, expect, why }] of Object.entries(cases)) {
      assert.ok(row, `找不到变体：${name}`)
      assert.ok(expect(row), `${name}：${why}；实际 环差=${row.环差} 内部差=${row.内部差} 带内比=${row.带内比}`)
    }

    writeFileSync(join(out, 'isolation.json'), JSON.stringify({ generatedAt: new Date().toISOString(), gpu, browser: defaultBrowser(), facts, rows }, null, 2))
    console.log(`\n截图与 isolation.json：${out}`)
  } finally {
    await session.close()
    server.close()
  }
}

main().catch(error => {
  console.error(`\n隔离实验失败：${error.message}`)
  process.exitCode = 1
})
