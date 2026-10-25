/**
 * 材质层的视觉验收：把真实渲染层在几个关键状态下各截一张图，并断言规则生效。
 *
 *   node tests/preview-glass.mjs                # 写到 test-tmp/preview/glass/
 *   node tests/preview-glass.mjs --out 别的目录
 *
 * 断言的是「规则」：分级写到 html、flat 真的撤掉 backdrop-filter、指针光源写了
 * 变量、笔记本模式也拿到了表面标记。观感本身要靠人看截图——脚本只负责把它稳定
 * 地拿出来，避免每次调材质都手点一遍。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ChromiumSession } from './preview-cdp.mjs'
import { createPreviewServer } from './preview-app.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const arg = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
const out = resolve(root, arg('--out') ?? join('test-tmp', 'preview', 'glass'))
mkdirSync(out, { recursive: true })

const sleep = ms => new Promise(done => setTimeout(done, ms))
const results = []

const withPage = async ({ mode = 'memory', reducedMotion = false, dark = false }, run) => {
  const server = createPreviewServer({ mode })
  await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done) })
  const base = `http://127.0.0.1:${server.address().port}/`
  const session = await ChromiumSession.launch({
    width: 1440, height: 940,
    profile: join(root, 'test-tmp', 'work', `glass-${mode}-${process.pid}-${Math.round(Math.random() * 1e6)}`),
  })
  try {
    if (reducedMotion) await session.setMedia({ reducedMotion: true })
    if (dark) await session.setMedia({ dark: true })
    await session.goto(base)
    await session.waitFor(`!document.getElementById('alaya-startup') && document.querySelector('[data-glass-surface]')`, { label: `界面就绪 ${mode}`, timeout: 30000 })
    await session.evaluate(`window.alayaGlass.setTier('balanced')`)
    await sleep(400)
    await run(session, base)
  } finally {
    await session.close()
    server.close()
  }
}

const record = (name, file, note) => {
  results.push({ name, file, note })
  console.log(`ok   ${name} → ${file}${note ? `（${note}）` : ''}`)
}

try {
  // 1. 默认档：数据库界面
  await withPage({}, async (session) => {
    const facts = await session.evaluate(`JSON.stringify({
      tier: document.documentElement.dataset.glassTier,
      surfaces: document.querySelectorAll('[data-glass-surface]').length,
      chrome: document.querySelectorAll('[data-glass-surface="chrome"]').length,
      controls: document.querySelectorAll('[data-glass-surface="control"]').length,
      floats: document.querySelectorAll('[data-glass-surface="float"]').length,
      sideBlur: getComputedStyle(document.querySelector('.bar'), '::after').backdropFilter,
      api: typeof window.alayaGlass,
    })`)
    const state = JSON.parse(facts)
    assert.ok(state.surfaces > 20, `表面数量太少：${state.surfaces}`)
    assert.ok(state.chrome >= 2, `chrome 表面太少：${state.chrome}`)
    assert.ok(state.floats >= 1, '动态浮层应该被 MutationObserver 纳入')
    assert.equal(state.api, 'object', '要暴露 window.alayaGlass 便于排错')
    record('db-balanced', await session.screenshot(join(out, 'db-balanced.png')), `tier=${state.tier} surfaces=${state.surfaces}`)

    // 指针光源：合成一次 pointermove，看变量有没有落到面上
    const glare = await session.evaluate(`(async () => {
      const side = document.querySelector('.side')
      side.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 70, clientY: 320, pointerType: 'mouse' }))
      await new Promise(done => setTimeout(done, 500))
      return JSON.stringify({
        finePointer: window.alayaGlass.capabilities().finePointer,
        x: side.style.getPropertyValue('--glass-glare-x'),
        y: side.style.getPropertyValue('--glass-glare-y'),
        o: side.style.getPropertyValue('--glass-glare-o'),
        angle: side.style.getPropertyValue('--glass-rim-angle'),
      })
    })()`)
    const light = JSON.parse(glare)
    if (light.finePointer) {
      assert.ok(Number(light.o) > 0.5, `指针进入后高光应升到 1 附近，实际 ${light.o}`)
      assert.ok(light.x !== '' && light.y !== '' && light.angle !== '', '指针坐标与角度都要写进变量')
      record('db-pointer', await session.screenshot(join(out, 'db-pointer.png')), `glare=${light.x},${light.y} o=${light.o} rim=${light.angle}`)
    } else {
      console.log('skip db-pointer（本环境没有细指针设备）')
    }

    // 2. full 档：边缘色散打开
    const measure = () => session.evaluate(`JSON.stringify(['.side', '.bar', '.main', '.board-toolbar', '.tile', '.search-wrap'].map(selector => {
      const node = document.querySelector(selector)
      if (!node) return [selector, null]
      const rect = node.getBoundingClientRect()
      return [selector, [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)]]
    }))`)
    const balancedLayout = await measure()
    await session.evaluate(`window.alayaGlass.setTier('full')`)
    await sleep(300)
    assert.equal(await session.evaluate(`document.documentElement.dataset.glassTier`), 'full')
    assert.equal(await measure(), balancedLayout, '切到 full 不能改动任何布局尺寸（材质层只加视觉属性）')
    record('db-full', await session.screenshot(join(out, 'db-full.png')), 'full')

    // 3. flat 档：必须真的撤掉 backdrop-filter，而不是只改个属性
    await session.evaluate(`window.alayaGlass.setTier('flat')`)
    await sleep(300)
    const flatBlur = await session.evaluate(`getComputedStyle(document.querySelector('.bar'), '::after').backdropFilter`)
    assert.ok(flatBlur === 'none' || flatBlur === '', `flat 档不应再有 backdrop-filter，实际 ${flatBlur}`)
    assert.equal(await measure(), balancedLayout, '切到 flat 也不能改动布局尺寸')
    record('db-flat', await session.screenshot(join(out, 'db-flat.png')), 'flat 无 backdrop-filter')

    // 收尾：把用户偏好清掉，避免脚本在真机 profile 里留下选择（预览用的是临时 profile，这里只是礼貌）
    await session.evaluate(`localStorage.removeItem('alaya.glass')`)

    // 4. 滚动：内容从顶栏底下经过——这是「玻璃是界面层」真正的证据
    await session.evaluate(`window.alayaGlass.setTier('balanced'); document.querySelector('.main').scrollTop = 260`)
    await sleep(300)
    record('db-scrolled', await session.screenshot(join(out, 'db-scrolled.png')), '内容从顶栏下经过')

    // 5. 材质探针：临时塞一条高饱和色带顶到顶栏下面。这不是产品状态，只是用来
    //    确认 backdrop-filter 真的在采样背景（白底白卡看不出模糊，很容易自欺）。
    const probe = await session.evaluate(`(() => {
      const strip = document.createElement('div')
      strip.id = 'glass-probe-strip'
      strip.style.cssText = 'position:fixed;left:230px;top:0;width:1180px;height:96px;z-index:1;pointer-events:none;'
        + 'background:repeating-linear-gradient(90deg,#123 0 10px,#0af 10px 20px,#f60 20px 30px)'
      document.body.append(strip)
      const bar = document.querySelector('.bar')
      return JSON.stringify({ backdrop: getComputedStyle(bar).backdropFilter, tint: getComputedStyle(bar).backgroundImage.slice(0, 60) })
    })()`)
    await sleep(200)
    record('db-backdrop-probe', await session.screenshot(join(out, 'db-backdrop-probe.png')), probe)
    await session.evaluate(`document.getElementById('glass-probe-strip')?.remove()`)
  })

  // 4. 浮层：命令面板盖在内容上，是玻璃最容易被看见的地方
  await withPage({}, async (session) => {
    await session.evaluate(`window.alayaGlass.setTier('balanced')`)
    await session.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))`)
    await session.waitFor(`document.querySelector('dialog[open]')`, { label: '命令面板打开' })
    await sleep(300)
    const state = JSON.parse(await session.evaluate(`JSON.stringify({
      open: Boolean(document.querySelector('dialog[open]')),
      surface: document.querySelector('dialog[open]')?.getAttribute('data-glass-surface') ?? null,
      blur: getComputedStyle(document.querySelector('dialog[open]')).backdropFilter,
    })`))
    assert.equal(state.open, true, '命令面板应能打开')
    assert.equal(state.surface, 'float', `命令面板要被标成 float，实际 ${state.surface}`)
    record('db-palette', await session.screenshot(join(out, 'db-palette.png')), `blur=${state.blur}`)
  })

  // 5. 笔记本模式：同一套材质要覆盖第二张界面
  await withPage({ mode: 'mistakebook' }, async (session) => {
    // 笔记本是默认门面，但要等它真的切过去（切模式是异步的）
    await session.waitFor(`document.body.dataset.mode === 'mistakebook' && document.querySelectorAll('#mb-list [data-question-id]').length > 0`, { label: '笔记本界面就绪', timeout: 15000 })
    await sleep(300)
    const state = JSON.parse(await session.evaluate(`JSON.stringify({
      tier: document.documentElement.dataset.glassTier,
      surfaces: document.querySelectorAll('[data-glass-surface]').length,
      chrome: [...document.querySelectorAll('[data-glass-surface="chrome"]')].map(node => node.className),
      panels: document.querySelectorAll('[data-glass-surface="panel"]').length,
      barBlur: getComputedStyle(document.querySelector('.mb-bar'), '::after').backdropFilter,
    })`))
    assert.ok(state.surfaces > 10, `笔记本模式的表面数量太少：${state.surfaces}`)
    assert.ok(state.chrome.some(name => name.includes('mb-bar')), '笔记本顶栏也要被标记为 chrome')
    record('notebook-balanced', await session.screenshot(join(out, 'notebook-balanced.png')), `bar=${state.barBlur.slice(0, 26)} surfaces=${state.surfaces}`)
  })

  // 5. 减少动态效果：材质保留，但不应有常驻动画与指针光源
  await withPage({ reducedMotion: true }, async (session) => {
    const state = JSON.parse(await session.evaluate(`JSON.stringify({
      tier: document.documentElement.dataset.glassTier,
      caps: window.alayaGlass.capabilities(),
    })`))
    assert.equal(state.caps.reducedMotion, true)
    assert.equal(state.caps.pointerLight, false, '减少动态效果下不应开启指针光源')
    // 真的确认没装上监听：合成一次 pointermove，变量不应该被写
    const glare = await session.evaluate(`(async () => {
      const side = document.querySelector('.side')
      side.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 70, clientY: 320, pointerType: 'mouse' }))
      await new Promise(done => setTimeout(done, 300))
      return side.style.getPropertyValue('--glass-glare-o')
    })()`)
    assert.equal(glare, '', `减少动态效果下不应写高光变量，实际 ${glare}`)
    record('db-reduced-motion', await session.screenshot(join(out, 'db-reduced-motion.png')), `tier=${state.tier}`)
  })

  // 6. lab：独立参数页（材质同学产出；缺了不失败，只是提醒）
  const lab = join(root, 'desktop', 'renderer', 'glass-lab.html')
  if (existsSync(lab)) {
    const session = await ChromiumSession.launch({ width: 1440, height: 1100, profile: join(root, 'test-tmp', 'work', `lab-${process.pid}`) })
    try {
      await session.goto(`file:///${lab.replace(/\\/g, '/')}`)
      await sleep(500)
      record('glass-lab', await session.screenshot(join(out, 'glass-lab.png')), 'lab')
    } finally { await session.close() }
  } else {
    console.log('skip glass-lab（还没有 desktop/renderer/glass-lab.html）')
  }
} catch (error) {
  console.error(`\nglass preview failed: ${error.message}`)
  process.exitCode = 1
}

console.log(`\n${results.length} 张截图已写入 ${out}`)
