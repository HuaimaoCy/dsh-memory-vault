/**
 * 桌面 UI 的浏览器预览：没有 Electron 也能真实渲染渲染层并截图。
 *
 *   node tests/preview-app.mjs --shot test-tmp/preview/db.png [--width 1440 --height 940]
 *   node tests/preview-app.mjs --serve           # 起服务并打印地址，手动在浏览器里看
 *
 * 做法：静态服务 desktop/renderer，把一个假 window.vault（tests/preview-bridge.js）
 * 注入到 index.html 的 app.js 之前，再用 headless Chromium（CDP）等到界面就绪后截图。
 * 这不能替代 Electron 里的真机走查（窗口材质、字体渲染、GPU 合成都不在这里），
 * 但足够判定布局、材质、动效的视觉结果，并作为截图回归的基线。
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ChromiumSession } from './preview-cdp.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const renderer = join(root, 'desktop', 'renderer')
const arg = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
const options = {
  width: Number(arg('--width') ?? 1440),
  height: Number(arg('--height') ?? 940),
  theme: arg('--theme') ?? 'light',
  mode: arg('--mode') ?? 'memory',
  reducedMotion: process.argv.includes('--reduced-motion'),
  dark: process.argv.includes('--dark'),
  wait: Number(arg('--wait-ms') ?? 700),
  eval: arg('--eval'),
}

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json' }

export const createPreviewServer = (overrides = {}) => createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1')
  // 查询参数优先：一个已经在跑的服务就能切模式/主题，人工检查不用反复重启。
  //   /?mode=mistakebook   进笔记本
  //   /?mode=memory&theme=dark
  const mode = url.searchParams.get('mode') ?? overrides.mode ?? options.mode
  const theme = url.searchParams.get('theme') ?? overrides.theme ?? options.theme
  const target = url.pathname === '/' ? '/index.html' : url.pathname
  if (target === '/__preview-bridge.js') {
    response.writeHead(200, { 'content-type': types['.js'] })
    response.end(readFileSync(join(root, 'tests', 'preview-bridge.js')))
    return
  }
  // 渲染层用 `../addons/...` 引笔记本扩展模块：在 Electron 里那是仓库根目录，
  // 预览服务要按同样的形状再挂一个 /addons 前缀。
  const roots = target.startsWith('/addons/') ? join(root, 'addons') : renderer
  const local = target.startsWith('/addons/') ? target.slice('/addons'.length) : target
  const file = resolve(roots, `.${local}`)
  if (!file.startsWith(roots + sep) || !existsSync(file) || !statSync(file).isFile()) { response.writeHead(404); response.end('not found'); return }
  let body = readFileSync(file)
  if (target === '/index.html') {
    // 预览桥必须在 app.js 之前执行；CSP 的 script-src 'self' 允许同源脚本，
    // 所以这里加的是外链而不是内联脚本。
    body = Buffer.from(String(body)
      .replace('<script type="module" src="app.js"></script>', '<script src="/__preview-bridge.js"></script>\n  <script type="module" src="app.js"></script>')
      .replace('<body data-mode="memory">', `<body data-mode="${mode}" data-preview="${theme}">`))
  }
  response.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' })
  response.end(body)
})

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const server = createPreviewServer()
  // 人工检查时端口要稳定（不然每次启动都换地址、书签和标签页全失效）：
  // 默认 5180，被占用再退回随机端口。
  const servePort = process.argv.includes('--serve') ? Number(arg('--port') ?? 5180) : 0
  try {
    await new Promise((done, fail) => {
      server.once('error', fail)
      server.listen(servePort, '127.0.0.1', done)
    })
  } catch {
    await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done) })
  }
  const base = `http://127.0.0.1:${server.address().port}/`
  try {
    if (process.argv.includes('--serve')) {
      console.log(`Alaya 预览：${base}`)
      console.log(`材质实验台：${base}glass-lab.html`)
      console.log(`笔记本界面：${base}?mode=mistakebook`)
      console.log('按 Ctrl+C 退出')
      await new Promise(() => {})
    }
    const session = await ChromiumSession.launch({ width: options.width, height: options.height, profile: join(root, 'test-tmp', 'work', `preview-${process.pid}`) })
    try {
      if (options.reducedMotion) await session.setMedia({ reducedMotion: true })
      if (options.dark) await session.setMedia({ dark: true })
      await session.goto(base)
      // 就绪判据：启动遮罩已移除、侧栏视图已渲染（失败时 waitFor 会把页内报错带出来）。
      await session.waitFor(`!document.getElementById('alaya-startup') && document.querySelectorAll('#views button').length >= 4`, { label: '界面就绪', timeout: 30000 })
      await new Promise(done => setTimeout(done, options.wait))
      if (options.eval) console.log(JSON.stringify(await session.evaluate(options.eval), null, 2))
      const shot = arg('--shot')
      if (shot) {
        const target = resolve(root, shot)
        mkdirSync(dirname(target), { recursive: true })
        await session.screenshot(target)
        console.log(`截图已写入 ${target}（${options.width}×${options.height}${options.dark ? '，dark' : ''}${options.reducedMotion ? '，reduced-motion' : ''}）`)
      }
    } finally { await session.close() }
  } finally { server.close() }
}
