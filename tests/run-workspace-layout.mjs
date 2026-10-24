// 在真实 Chromium 里跑 workspace-layout 的浏览器套件：真实 styles.css / 真实模块，
// 不需要 Electron，不碰任何真实数据库。四种视口/偏好各跑一遍。
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const browser = process.env.ALAYA_TEST_BROWSER ?? [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync)
assert.ok(browser && existsSync(browser), 'Set ALAYA_TEST_BROWSER to a Chromium browser executable')

const fixture = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>workspace-layout</title>
<link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/workspace-layout.css"><link rel="stylesheet" href="/mistakebook.css">
</head><body>
<div style="height:100vh"><div class="app-shell" id="db-shell">
  <aside class="side" aria-label="数据库导航"><div class="brand"><div class="brand-name">Alaya</div></div><div class="side-scroll"><div class="side-head">资料库</div><nav class="views"><button class="nav">全部记忆</button></nav></div><div class="side-bottom"><div class="local-library">本地数据库</div></div></aside>
  <div class="workspace">
    <header class="bar"><div class="breadcrumb"><span data-icon="library"></span><span>全部记忆</span></div><div class="toolbar-actions"><label class="search-wrap"><input id="query" class="search" type="search" /></label><div id="layout-host" class="ws-layout-host"></div><button id="refresh" class="icon-button" aria-label="刷新记忆">↻</button></div></header>
    <div class="body">
      <main class="main"><div class="page-heading"><div><h1>全部记忆</h1><p>让知识、灵感与约定各归其位。</p></div></div><div class="board-toolbar"><span class="segmented"></span></div>
        <div class="list"><div class="grid"><button class="tile"><span class="tile-title">一条记忆</span><span class="tile-body">正文</span></button><button class="tile"><span class="tile-title">另一条记忆</span></button></div></div></main>
      <section id="drawer" class="drawer hidden" aria-label="记忆编辑器"><div class="drawer-head"><h2>记忆详情</h2></div><div class="editor-form"></div></section>
    </div>
    <footer class="foot"><span>3 条记忆</span></footer>
  </div>
</div></div>
<div style="height:560px"><div class="mb-shell" id="mb-shell">
  <aside class="mb-side" id="mb-side"><div class="brand">笔记本</div></aside>
  <div class="mb-splitter" id="mb-side-split"></div>
  <div class="mb-workspace"><header class="mb-bar" id="mb-toolbar"><div class="toolbar-actions" id="mb-layout-host"></div></header>
    <div class="mb-body"><main class="mb-main" id="mb-main"><div class="mb-list"><div class="card">题目</div></div></main>
      <section class="mb-detail" id="mb-detail">题目编辑器</section></div></div>
</div></div>
<pre id="result">RUNNING</pre>
<script>window.addEventListener('error', event => { const node = document.querySelector('#result'); if (node && !node.textContent.startsWith('FAIL')) node.textContent = 'ERROR: ' + (event.message || event.error?.stack || event.type) })</script>
<script type="module" src="/suite.js"></script></body></html>`

const files = new Map([
  ['/workspace-layout.js', join(root, 'desktop/renderer/workspace-layout.js')],
  ['/layout.js', join(root, 'desktop/renderer/layout.js')],
  ['/workspace-layout.css', join(root, 'desktop/renderer/workspace-layout.css')],
  ['/styles.css', join(root, 'desktop/renderer/styles.css')],
  ['/mistakebook.css', join(root, 'desktop/renderer/mistakebook.css')],
  ['/suite.js', join(root, 'tests/workspace-layout-suite.js')],
])

const passes = [
  { name: 'default', size: [1440, 940], flags: [] },
  { name: 'narrow', size: [1040, 650], flags: [] },
  { name: 'tight', size: [620, 560], flags: [] },
  { name: 'reduced', size: [1040, 650], flags: ['--force-prefers-reduced-motion'] },
]

const parent = join(root, 'test-tmp', 'work')
mkdirSync(parent, { recursive: true })
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1')
  if (url.pathname === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(fixture)
  } else if (files.has(url.pathname)) {
    response.writeHead(200, { 'content-type': url.pathname.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8' })
    response.end(readFileSync(files.get(url.pathname)))
  } else { response.writeHead(404); response.end() }
})

const run = (port, pass, profile) => new Promise((resolveRun, rejectRun) => {
  const [width, height] = pass.size
  const child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    ...pass.flags, `--window-size=${width},${height}`, `--user-data-dir=${profile}`, '--dump-dom', '--virtual-time-budget=30000',
    `http://127.0.0.1:${port}/?pass=${pass.name}`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = '', err = ''
  const timeout = setTimeout(() => { child.kill(); rejectRun(new Error(`${pass.name}: browser timed out`)) }, 60000)
  child.stdout.on('data', data => { out += data })
  child.stderr.on('data', data => { err += data })
  child.on('error', error => { clearTimeout(timeout); rejectRun(error) })
  child.on('close', code => {
    clearTimeout(timeout)
    if (code !== 0) return rejectRun(new Error(`${pass.name}: browser exited ${code}: ${err.slice(-800)}`))
    const result = out.match(/<pre id="result">([\s\S]*?)<\/pre>/)?.[1]
    if (!result) return rejectRun(new Error(`${pass.name}: no result: ${out.slice(0, 600)}`))
    if (!result.startsWith('PASS:')) return rejectRun(new Error(result.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')))
    resolveRun(result)
  })
})

const profiles = []
try {
  await new Promise((resolveListen, rejectListen) => { server.once('error', rejectListen); server.listen(0, '127.0.0.1', resolveListen) })
  const port = server.address().port
  for (const pass of passes) {
    const profile = mkdtempSync(join(parent, `workspace-layout-${pass.name}-`))
    profiles.push(profile)
    console.log(await run(port, pass, profile))
  }
  console.log('Workspace layout: drag/keyboard/positions/page width/density/collapse/focus/presets/reset/ARIA/persistence isolation verified in Chromium at 1440×940, 1040×650 and 620×560, with reduced motion')
} finally {
  await new Promise(resolveClose => server.close(resolveClose))
  for (const profile of profiles) {
    assert.equal(dirname(profile), parent, 'cleanup must stay inside the isolated test directory')
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}
