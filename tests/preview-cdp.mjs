/**
 * headless Chromium 的 CDP 驱动（预览与视觉回归用，不打包）。
 *
 * 为什么不用 --screenshot：new headless 会在 load 事件后立刻截图，抓不到启动动画
 * 结束、异步 load() 完成之后的状态。这里用 CDP 等到页面真的就绪再截。
 *
 * 用法（作为库）：见 tests/preview-app.mjs；作为脚本：
 *   node tests/preview-cdp.mjs --url <url> --out a.png [--width 1440 --height 940]
 *     [--reduced-motion] [--wait-ms 200] [--eval "expression"]
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'

const defaultBrowser = () => [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(candidate => existsSync(candidate))

const sleep = ms => new Promise(done => setTimeout(done, ms))

/** 让操作系统给一个空闲端口：写死/随机的端口撞车时 Chrome 会直接起不来调试服务。 */
const freePort = () => new Promise((done, fail) => {
  const probe = createServer()
  probe.once('error', fail)
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address()
    probe.close(() => done(port))
  })
})

export class ChromiumSession {
  static async launch({ width = 1440, height = 940, port, profile, browser = process.env.ALAYA_TEST_BROWSER ?? defaultBrowser() } = {}) {
    assert.ok(browser && existsSync(browser), '需要一个 Chromium 浏览器：设置 ALAYA_TEST_BROWSER')
    const debuggingPort = port ?? await freePort()
    assert.ok(profile, '预览需要一个临时 user-data-dir')
    mkdirSync(profile, { recursive: true })
    const child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--hide-scrollbars',
      '--force-device-scale-factor=1', '--force-color-profile=srgb', `--window-size=${width},${height}`,
      `--remote-debugging-port=${debuggingPort}`, `--user-data-dir=${profile}`, 'about:blank'],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', data => { stderr += data })
    let endpoint
    for (let attempt = 0; attempt < 100 && !endpoint; attempt++) {
      await sleep(120)
      try {
        const reply = await fetch(`http://127.0.0.1:${debuggingPort}/json/version`)
        if (reply.ok) endpoint = (await reply.json()).webSocketDebuggerUrl
      } catch { /* 还没起来 */ }
    }
    if (!endpoint) { child.kill(); throw new Error(`Chromium 没有可用调试端口：${stderr.slice(-500)}`) }
    const session = new ChromiumSession({ child, endpoint, width, height })
    await session.connect()
    return session
  }

  constructor({ child, endpoint, width, height }) {
    this.child = child
    this.endpoint = endpoint
    this.width = width
    this.height = height
    this.nextId = 0
    this.pending = new Map()
    this.closed = false
    this.exceptions = []
    this.console = []
  }

  async connect() {
    const socket = new WebSocket(this.endpoint)
    this.socket = socket
    await new Promise((done, fail) => {
      socket.addEventListener('open', done, { once: true })
      socket.addEventListener('error', () => fail(new Error('CDP WebSocket 连接失败')), { once: true })
    })
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data))
      if (message.id === undefined) {
        if (message.method === 'Runtime.exceptionThrown') {
          const details = message.params?.exceptionDetails
          this.exceptions.push(details?.exception?.description ?? details?.text ?? 'unknown')
        } else if (message.method === 'Runtime.consoleAPICalled') {
          this.console.push(`${message.params?.type}: ${(message.params?.args ?? []).map(item => item.value ?? item.description ?? '').join(' ')}`)
        }
        return
      }
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      message.error ? entry.fail(new Error(message.error.message)) : entry.done(message.result)
    })
    socket.addEventListener('close', () => { this.closed = true })
    const { targetInfos } = await this.send('Target.getTargets')
    const page = targetInfos.find(target => target.type === 'page' && target.url === 'about:blank') ?? targetInfos.find(target => target.type === 'page')
    assert.ok(page, '找不到可用的页面 target')
    const { sessionId } = await this.send('Target.attachToTarget', { targetId: page.targetId, flatten: true })
    this.sessionId = sessionId
    await this.send('Page.enable')
    await this.send('Runtime.enable')
    await this.send('Emulation.setDeviceMetricsOverride', { width: this.width, height: this.height, deviceScaleFactor: 1, mobile: false })
    return this
  }

  send(method, params = {}) {
    const id = ++this.nextId
    const payload = { id, method, params }
    if (this.sessionId) payload.sessionId = this.sessionId
    return new Promise((done, fail) => {
      this.pending.set(id, { done, fail })
      this.socket.send(JSON.stringify(payload))
      setTimeout(() => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        fail(new Error(`CDP 调用超时：${method}`))
      }, 30000)
    })
  }

  async evaluate(expression, { awaitPromise = true } = {}) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true })
    if (result.exceptionDetails) throw new Error(`${result.exceptionDetails.text}: ${result.exceptionDetails.exception?.description ?? ''}`)
    return result.result.value
  }

  async goto(url) {
    await this.send('Page.navigate', { url })
    await this.waitFor(`document.readyState === 'complete'`)
    return this
  }

  async setMedia({ reducedMotion = null, contrast = null, dark = false } = {}) {
    const features = []
    if (reducedMotion) features.push({ name: 'prefers-reduced-motion', value: reducedMotion ? 'reduce' : 'no-preference' })
    if (contrast) features.push({ name: 'prefers-contrast', value: contrast })
    await this.send('Emulation.setEmulatedMedia', {
      features,
      ...(dark ? { media: 'screen' } : {}),
    })
    if (dark) await this.evaluate(`document.documentElement.style.colorScheme = 'dark'`)
    return this
  }

  /** 轮询一个表达式直到为真；超时抛错并带上渲染层的报错。 */
  async waitFor(expression, { timeout = 20000, label = expression } = {}) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      try { if (await this.evaluate(`Boolean(${expression})`)) return this } catch { /* 页面还没就绪 */ }
      await sleep(100)
    }
    const errors = await this.evaluate(`document.body?.dataset?.previewErrors ?? ''`).catch(() => '')
    throw new Error(`等待超时：${label}${errors ? `（页面报错：${errors}）` : ''}`)
  }

  async screenshot(target) {
    const shot = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    const file = resolve(target)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, Buffer.from(shot.data, 'base64'))
    return file
  }

  async close() {
    try { this.socket?.close() } catch { /* 已断开 */ }
    this.child.kill()
    await sleep(120)
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
if (isMain) {
  const arg = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
  const url = arg('--url')
  assert.ok(url, '用法：node tests/preview-cdp.mjs --url <url> --out <png>')
  const session = await ChromiumSession.launch({
    width: Number(arg('--width') ?? 1440), height: Number(arg('--height') ?? 940),
    profile: join(process.cwd(), 'test-tmp', 'work', `cdp-${process.pid}`),
  })
  try {
    if (process.argv.includes('--reduced-motion')) await session.setMedia({ reducedMotion: true })
    await session.goto(url)
    await sleep(Number(arg('--wait-ms') ?? 600))
    const expression = arg('--eval')
    if (expression) console.log(JSON.stringify(await session.evaluate(expression), null, 2))
    const out = arg('--out')
    if (out) console.log('screenshot:', await session.screenshot(out))
  } finally {
    await session.close()
  }
}
