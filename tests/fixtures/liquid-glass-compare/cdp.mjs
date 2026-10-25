/**
 * 对照实验专用的 headless Chromium 驱动。
 *
 * 为什么不复用 tests/preview-cdp.mjs：那个是为「预览截图 + 规则断言」写死的（固定
 * `--disable-gpu`、固定视口、只能整页截图）。对照实验需要三件它没有的事：
 *   1) 可选 GPU：软件合成（SwiftShader）与真实 GPU 下 `backdrop-filter: url()` 的
 *      表现可能不同，性能数字也只有在真 GPU 下才有意义；
 *   2) 按裁剪框截图（4 倍放大看圆角与接缝）；
 *   3) 载入后再改设备参数（整页高度要到页面就绪才知道）。
 * 复制而不是改写，避免动别人负责的验收脚本。
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { dirname, resolve } from 'node:path'

const sleep = ms => new Promise(done => setTimeout(done, ms))

export const defaultBrowser = () => [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(candidate => existsSync(candidate))

const freePort = () => new Promise((done, fail) => {
  const probe = createNetServer()
  probe.once('error', fail)
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address()
    probe.close(() => done(port))
  })
})

export class Session {
  /**
   * @param {object} options
   * @param {boolean} options.gpu  是否允许 GPU 合成（默认软件合成，与验收脚本一致）
   */
  static async launch({ width = 1440, height = 900, gpu = false, profile, browser = process.env.ALAYA_TEST_BROWSER ?? defaultBrowser() } = {}) {
    assert.ok(browser && existsSync(browser), '需要一个 Chromium 浏览器：设置 ALAYA_TEST_BROWSER')
    assert.ok(profile, '需要一个临时 user-data-dir')
    mkdirSync(profile, { recursive: true })
    const port = await freePort()
    const args = ['--headless=new', '--no-first-run', '--no-default-browser-check',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--hide-scrollbars',
      '--force-device-scale-factor=1', '--force-color-profile=srgb', `--window-size=${width},${height}`,
      `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank']
    if (!gpu) args.unshift('--disable-gpu')
    const child = spawn(browser, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', data => { stderr += data })
    let endpoint
    for (let attempt = 0; attempt < 120 && !endpoint; attempt++) {
      await sleep(120)
      try {
        const reply = await fetch(`http://127.0.0.1:${port}/json/version`)
        if (reply.ok) endpoint = (await reply.json()).webSocketDebuggerUrl
      } catch { /* 还没起来 */ }
    }
    if (!endpoint) { child.kill(); throw new Error(`Chromium 没有可用调试端口：${stderr.slice(-400)}`) }
    const session = new Session({ child, endpoint, gpu })
    await session.connect({ width, height })
    return session
  }

  constructor({ child, endpoint, gpu }) {
    this.child = child
    this.endpoint = endpoint
    this.gpu = gpu
    this.nextId = 0
    this.pending = new Map()
    this.exceptions = []
    this.console = []
  }

  async connect({ width, height }) {
    const socket = new WebSocket(this.endpoint)
    this.socket = socket
    await new Promise((done, fail) => {
      socket.addEventListener('open', done, { once: true })
      socket.addEventListener('error', () => fail(new Error('CDP 连接失败')), { once: true })
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
    const { targetInfos } = await this.send('Target.getTargets')
    const page = targetInfos.find(target => target.type === 'page' && target.url === 'about:blank') ?? targetInfos.find(target => target.type === 'page')
    assert.ok(page, '找不到可用的页面 target')
    const { sessionId } = await this.send('Target.attachToTarget', { targetId: page.targetId, flatten: true })
    this.sessionId = sessionId
    await this.send('Page.enable')
    await this.send('Runtime.enable')
    await this.setDeviceMetrics({ width, height, deviceScaleFactor: 1 })
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
      }, 60000)
    })
  }

  async evaluate(expression, { awaitPromise = true } = {}) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true })
    if (result.exceptionDetails) throw new Error(`${result.exceptionDetails.text}: ${result.exceptionDetails.exception?.description ?? ''}`)
    return result.result.value
  }

  async setDeviceMetrics({ width, height, deviceScaleFactor = 1 }) {
    this.viewport = { width, height, deviceScaleFactor }
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile: false })
    return this
  }

  async goto(url) {
    await this.send('Page.navigate', { url })
    await this.waitFor(`document.readyState === 'complete'`)
    return this
  }

  async waitFor(expression, { timeout = 25000, label = expression } = {}) {
    const deadline = Date.now() + timeout
    let last = ''
    while (Date.now() < deadline) {
      try {
        if (await this.evaluate(`Boolean(${expression})`)) return this
      } catch (error) { last = error.message }
      await sleep(100)
    }
    throw new Error(`等待超时：${label}${last ? `（${last}）` : ''}`)
  }

  /** 整页或指定裁剪框的截图；clip 用 CSS 像素（可带 scale 做无损放大）。 */
  async screenshot(target, clip) {
    const shot = await this.send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: Boolean(clip && clip.scale > 1),
      ...(clip ? { clip: { scale: 1, ...clip } } : {}),
    })
    const file = resolve(target)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, Buffer.from(shot.data, 'base64'))
    return file
  }

  async close() {
    try { this.socket?.close() } catch { /* 已断开 */ }
    this.child.kill()
    await sleep(150)
  }
}
