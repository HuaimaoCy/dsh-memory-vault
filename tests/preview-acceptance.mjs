/**
 * 0.7.23 材质验收：把我能在无 Electron 环境里判定的项目，做成可重跑的脚本。
 *
 *   node tests/preview-acceptance.mjs            # 出图 + 断言，写 test-tmp/preview/acceptance/
 *
 * 覆盖：四种背景 × 三档、显示缩放 125/150/200%、系统无障碍偏好、命中区域、
 * 内容与边框的距离、滚动与浮层的帧间隔。
 * **不覆盖**（必须在真机 Electron 里做，脚本不假装能做）：真实窗口合成、
 * 高 DPI 下的合成精度、窗口最大化/还原、多显示器移动、GPU 显存占用。
 */
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ChromiumSession } from './preview-cdp.mjs'
import { createPreviewServer } from './preview-app.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const arg = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
const out = resolve(root, arg('--out') ?? join('test-tmp', 'preview', 'acceptance'))
mkdirSync(out, { recursive: true })
const sleep = ms => new Promise(done => setTimeout(done, ms))
const report = []

// 背景：白 / 浅灰 / 暗色 / 高饱和。玻璃在不同底色下的表现差异，主要取决于这四种。
const backdrops = {
  white: 'background:#ffffff',
  gray: 'background:#e9ecf1',
  dark: 'background:#14181f',
  vivid: `background:
    radial-gradient(58% 46% at 12% 18%, #ffb01a, transparent 70%),
    radial-gradient(52% 58% at 84% 72%, #0a84ff, transparent 70%),
    radial-gradient(42% 40% at 58% 6%, #ff2d55, transparent 70%),
    radial-gradient(46% 46% at 30% 88%, #34c759, transparent 70%),
    linear-gradient(150deg, #ffe9c9, #bfd4ef)`,
}

/** 把页面底色透明化，并在窗口最底层铺一张背景：这样才能看到 chrome 背后有什么。
 *  z-index 必须是 -1：0 会盖住所有**未定位**的 chrome（侧栏是 static），
 *  只有 .bar 这种被我抬过 z-index 的表面才显得正常，测出来的数据是假的。 */
const paintBackdrop = (session, css) => session.evaluate(`(() => {
  document.documentElement.style.background = 'transparent'
  document.body.style.background = 'transparent'
  let layer = document.getElementById('accept-backdrop')
  if (!layer) {
    layer = document.createElement('div')
    layer.id = 'accept-backdrop'
    document.body.prepend(layer)
  }
  layer.style.cssText = 'position:fixed;inset:0;z-index:-1;pointer-events:none;' + ${JSON.stringify(css)}
  return true
})()`)

const withApp = async (run, { width = 1440, height = 940, dpr = 1, media = null } = {}) => {
  const server = createPreviewServer({ mode: 'memory' })
  await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done) })
  const base = `http://127.0.0.1:${server.address().port}/`
  const session = await ChromiumSession.launch({
    width, height, profile: join(root, 'test-tmp', 'work', `accept-${process.pid}-${Math.round(Math.random() * 1e6)}`),
  })
  try {
    if (media) await session.setMedia(media)
    if (dpr !== 1) await session.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile: false })
    await session.goto(base)
    await session.waitFor(`!document.getElementById('alaya-startup') && document.querySelectorAll('#views button').length >= 4`, { label: '界面就绪', timeout: 30000 })
    await sleep(400)
    return await run(session)
  } finally {
    await session.close()
    server.close()
  }
}

const record = (name, file, note) => {
  report.push({ name, file, note })
  console.log(`ok   ${name}${file ? ` → ${file}` : ''}${note ? `（${note}）` : ''}`)
}

// ---------- A. 四种背景 × 三档 ----------
for (const [label, css] of Object.entries(backdrops)) {
  await withApp(async session => {
    await paintBackdrop(session, css)
    for (const tier of ['full', 'balanced', 'flat']) {
      await session.evaluate(`window.alayaGlass.setTier('${tier}')`)
      await sleep(220)
      // 侧栏与顶栏的对比度：文字颜色固定，玻璃着色随背景变化——这里量的是最坏情况下的可见性
      const facts = JSON.parse(await session.evaluate(`JSON.stringify({
        applied: document.documentElement.dataset.glassTier,
        chromeBlur: getComputedStyle(document.querySelector('.bar'), '::after').backdropFilter,
        navColor: getComputedStyle(document.querySelector('#views button')).color,
      })`))
      assert.equal(facts.applied, tier === 'flat' || !facts.applied ? tier : tier, `档位没生效：${tier}`)
      if (tier === 'flat') assert.equal(facts.chromeBlur, 'none', 'flat 必须是实心回退')
      else assert.match(facts.chromeBlur, /blur\(/, `${tier} 应该有 backdrop-filter`)
      record(`bg-${label}-${tier}`, await session.screenshot(join(out, `bg-${label}-${tier}.png`)), `blur=${facts.chromeBlur.slice(0, 24)}`)
    }
    await session.evaluate(`window.alayaGlass.setTier('balanced')`)
  })
}

// ---------- B. 显示缩放 125 / 150 / 200% ----------
for (const [dpr, size] of [[1.25, [1250, 820]], [1.5, [1200, 800]], [2, [1100, 760]]]) {
  await withApp(async session => {
    const facts = JSON.parse(await session.evaluate(`JSON.stringify((() => {
      const bar = document.querySelector('.bar').getBoundingClientRect()
      const side = document.querySelector('.side').getBoundingClientRect()
      const tile = document.querySelector('.tile')?.getBoundingClientRect()
      return {
        devicePixelRatio, overflowX: document.documentElement.scrollWidth > innerWidth + 1,
        barHeight: Math.round(bar.height), sideWidth: Math.round(side.width),
        tileRounded: tile ? Math.round(tile.width) : null,
        blur: getComputedStyle(document.querySelector('.bar'), '::after').backdropFilter,
        mainTop: Math.round(document.querySelector('.page-heading').getBoundingClientRect().top),
      }
    })())`))
    assert.equal(facts.overflowX, false, `${dpr * 100}% 下不应出现横向溢出`)
    assert.match(facts.blur, /blur\(/, `${dpr * 100}% 下材质仍在`)
    assert.equal(facts.barHeight, 73, `${dpr * 100}% 下顶栏高度应保持 73 CSS px，实际 ${facts.barHeight}`)
    assert.equal(facts.mainTop, 95, `${dpr * 100}% 下首屏位置应保持 95px，实际 ${facts.mainTop}`)
    record(`scale-${Math.round(dpr * 100)}`, await session.screenshot(join(out, `scale-${Math.round(dpr * 100)}.png`)), `dpr=${facts.devicePixelRatio} bar=${facts.barHeight} heading=${facts.mainTop}`)
  }, { width: size[0], height: size[1], dpr })
}

// ---------- C. 系统无障碍偏好：必须压过显式选择 ----------
// 减少动态效果不改材质档位（它管的是位移与动画，不是透明度）：显式选的 full 应当
// 保留，但指针光源必须关掉、动画必须退化成瞬时。
const prefs = [
  ['contrast-more', { features: [{ name: 'prefers-contrast', value: 'more' }] }, 'flat'],
  ['forced-colors', { features: [{ name: 'forced-colors', value: 'active' }] }, 'flat'],
  ['reduced-transparency', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] }, 'flat'],
  ['reduced-motion', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, 'full'],
]
for (const [label, media, expected] of prefs) {
  await withApp(async session => {
    // 先让用户显式选 full，再看系统偏好能不能把它压下来
    await session.evaluate(`window.alayaGlass.setTier('full')`)
    await sleep(120)
    await session.send('Emulation.setEmulatedMedia', media)
    // 模拟「用户去系统设置改完再切回应用」：引擎在窗口获得焦点时重新判定
    await session.evaluate(`window.alayaGlass.recheck(); window.dispatchEvent(new Event('focus'))`)
    await sleep(320)
    const facts = JSON.parse(await session.evaluate(`JSON.stringify({
      applied: document.documentElement.dataset.glassTier,
      caps: window.alayaGlass.capabilities(),
      chromeBlur: getComputedStyle(document.querySelector('.bar'), '::after').backdropFilter,
      pointerLight: document.querySelector('.side').style.getPropertyValue('--glass-glare-o'),
    })`))
    assert.equal(facts.applied, expected, `${label}：期望 ${expected}，实际 ${facts.applied}`)
    if (expected === 'flat') assert.equal(facts.chromeBlur, 'none', `${label} 下应无 backdrop-filter`)
    if (label === 'reduced-motion') {
      assert.equal(facts.caps.pointerLight, false, '减少动态效果下不应开启指针光源')
      assert.equal(facts.caps.finePointer, true, '设备本身仍是细指针（只是被偏好关掉了光源）')
    }
    record(`pref-${label}`, await session.screenshot(join(out, `pref-${label}.png`)), `tier=${facts.applied}`)
  })
}

// ---------- D. 命中区域与「内容与边框保持距离」 ----------
await withApp(async session => {
  const facts = JSON.parse(await session.evaluate(`JSON.stringify((() => {
    const covered = []
    for (const node of document.querySelectorAll('.side .nav, .bar .btn, .bar .icon-button, .search-wrap input')) {
      // 收起的 <details>（布局菜单）里的按钮不参与命中测试：它本来就不该可点
      if (node.closest('details:not([open])')) continue
      const style = getComputedStyle(node)
      if (style.visibility === 'hidden' || style.display === 'none') continue
      const rect = node.getBoundingClientRect()
      if (!rect.width || !rect.height) continue
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      if (!hit || !(node === hit || node.contains(hit) || hit.contains(node))) covered.push((node.id || node.className) + ' ← ' + (hit?.className ?? 'null'))
    }
    // 内容与边框的距离：玻璃面上的内容不该贴边（装饰性绝对定位元素除外）
    const tight = []
    for (const surface of document.querySelectorAll('[data-glass-surface]')) {
      const box = surface.getBoundingClientRect()
      if (box.width < 8 || box.height < 8) continue
      const kind = surface.getAttribute('data-glass-surface')
      const minGap = kind === 'control' ? 2 : 4
      for (const child of surface.children) {
        const style = getComputedStyle(child)
        if (style.position === 'absolute' || style.position === 'fixed' || style.display === 'none') continue
        const rect = child.getBoundingClientRect()
        if (!rect.width || !rect.height) continue
        const gap = Math.min(rect.left - box.left, rect.top - box.top, box.right - rect.right, box.bottom - rect.bottom)
        if (gap < minGap - 0.5) tight.push(kind + ':' + (surface.className || surface.id) + ' → ' + (child.className || child.tagName) + ' gap=' + gap.toFixed(1))
      }
    }
    return { covered, tight, radius: getComputedStyle(document.querySelector('.curation-popover') ?? document.body).borderTopLeftRadius }
  })())`))
  assert.deepEqual(facts.covered, [], `这些控件被挡住：${facts.covered.join('; ')}`)
  assert.deepEqual(facts.tight, [], `这些内容贴到边框上：${facts.tight.join('; ')}`)
  record('hit-and-inset', await session.screenshot(join(out, 'hit-and-inset.png')), `卡片圆角=${facts.radius}（内容层不受 90° 规则影响）`)
})

// ---------- E. 帧间隔：静止 / 连续滚动 / 浮层动画 ----------
await withApp(async session => {
  // 采样窗口必须盖住被观察的动作本身：先开采样，再启动动作，等满 duration 才收。
  const measure = (start, duration = 900) => session.evaluate(`(async () => {
    const gaps = [];
    let last = 0;
    let running = true;
    const frame = now => { if (last) gaps.push(now - last); last = now; if (running) requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
    ${start};
    await new Promise(done => setTimeout(done, ${duration}));
    running = false;
    await new Promise(done => setTimeout(done, 40));
    const sorted = [...gaps].sort((a, b) => a - b);
    const at = q => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
    return JSON.stringify({ frames: sorted.length, p50: +at(.5).toFixed(1), p95: +at(.95).toFixed(1), max: +(sorted.at(-1) ?? 0).toFixed(1) });
  })()`)
  const idle = JSON.parse(await measure('void 0'))
  const scrolling = JSON.parse(await measure(`(() => {
    const main = document.querySelector('.main')
    const tick = () => { if (!running) return; main.scrollTop += 14; requestAnimationFrame(tick) }
    tick()
  })()`))
  const popover = JSON.parse(await measure(`(() => {
    document.querySelector('#layout-menu').open = true
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))
  })()`))
  // 采样必须真的收到帧，否则「0ms」只是没测到东西
  assert.ok(idle.frames > 20, `静止采样只收到 ${idle.frames} 帧，测量无效`)
  assert.ok(scrolling.frames > 20, `滚动采样只收到 ${scrolling.frames} 帧，测量无效`)
  assert.ok(scrolling.p95 < 60, `滚动时 p95 帧间隔应低于 60ms（≈16fps 下限），实际 ${scrolling.p95}ms`)
  record('frame-timing', null, `静止 p50=${idle.p50}/p95=${idle.p95}ms（${idle.frames} 帧）· 滚动 p50=${scrolling.p50}/p95=${scrolling.p95}ms（${scrolling.frames} 帧）· 浮层 p50=${popover.p50}ms（软件合成，只作下限参考）`)
})

console.log(`\n${report.length} 项验收记录，截图目录 ${out}`)
console.log('未覆盖（必须真机）：真实窗口合成与 Mica、高 DPI 合成精度、最大化/还原、多显示器移动、GPU 显存占用。')
