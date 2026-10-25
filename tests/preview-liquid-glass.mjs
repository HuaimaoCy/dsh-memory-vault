/** 真实渲染层验收：默认折射、可见设置入口、生命周期、尺寸变化与系统回退。 */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ChromiumSession } from './preview-cdp.mjs'
import { createPreviewServer } from './preview-app.mjs'

const root = resolve(import.meta.dirname, '..')
const outIndex = process.argv.indexOf('--out')
const out = resolve(outIndex >= 0 ? process.argv[outIndex + 1] : join(root, 'test-tmp/preview/liquid-glass'))
mkdirSync(out, { recursive: true })
const sleep = ms => new Promise(done => setTimeout(done, ms))
const results = []
const check = (name, facts) => { results.push({ name, ...facts }); console.log(`ok   ${name}: ${JSON.stringify(facts)}`) }
const server = createPreviewServer()
await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done) })
const base = `http://127.0.0.1:${server.address().port}/`

try {
  for (const mode of ['memory', 'mistakebook']) {
    const session = await ChromiumSession.launch({ width: 1200, height: 840, profile: join(root, 'test-tmp/work', `liquid-${mode}-${process.pid}`) })
    const prefix = mode === 'memory' ? '.bar' : '.mb-bar'
    const trigger = mode === 'memory' ? '#workspace-settings' : '#mb-workspace-settings'
    const dialog = mode === 'memory' ? '#modal' : '.mb-dialog'
    const read = source => session.evaluate(source)
    const ready = async () => {
      await session.waitFor(`!document.getElementById('alaya-startup') && document.body.dataset.mode === '${mode}' && document.querySelector('${trigger}')`, { timeout: 30000 })
      await session.waitFor(`document.querySelector('${prefix} .toolbar-actions[data-glass-refraction="on"]')`)
      await sleep(250)
    }
    const choose = async tier => {
      await read(`document.querySelector('${trigger}').focus();document.querySelector('${trigger}').click()`)
      await session.waitFor(`document.querySelector('${dialog}[open] input[name^="glass-material"]')`)
      await read(`document.querySelector('${dialog} input[value="${tier}"]').click()`)
      assert.equal(await read('alayaGlass.tier()'), tier)
    }
    const close = async () => {
      await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await session.waitFor(`!document.querySelector('${dialog}[open]')`)
      await session.waitFor(`document.activeElement.matches('${trigger}')`, { label: '关闭后归还焦点', timeout: 2000 })
    }
    try {
      await session.goto(`${base}?mode=${mode}`)
      await ready()
      assert.equal(await read('alayaGlass.tier()'), 'full')
      assert.equal(await read(`localStorage.getItem('alaya.glass')`), null, '默认档位不应写成用户偏好')
      await read(`window.dispatchEvent(new Event('focus'))`)
      assert.equal(await read('alayaGlass.tier()'), 'full', '重新聚焦不能丢掉默认材质')
      const filter = await read(`getComputedStyle(document.querySelector('${prefix} .toolbar-actions'),'::before').backdropFilter`)
      assert.match(filter, /url\(/, '两个模式的胶囊都应真正消费折射滤镜')
      assert.equal(await read(`getComputedStyle(document.querySelector('${prefix}')).boxShadow`), 'none', '框架不能有方形投影')
      assert.equal(await read('document.documentElement.scrollWidth > innerWidth'), false)
      await session.screenshot(join(out, `${mode}-liquid.png`))
      check(`${mode}.default`, { filter })

      await choose('balanced')
      assert.equal(await read('alayaGlass.opticalMetrics()'), null)
      await session.screenshot(join(out, `${mode}-appearance.png`))
      await close()
      await choose('flat')
      const flat = await read(`(() => {
        const selectors = ['${prefix} .toolbar-actions', '${prefix} .search-wrap', '${dialog}']
        return selectors.map(selector => { const s = getComputedStyle(document.querySelector(selector)); return { selector, blur: s.backdropFilter, background: s.backgroundColor } })
      })()`)
      flat.forEach(item => assert.equal(item.blur, 'none', `实心模式仍在采样：${item.selector}`))
      flat.forEach(item => assert.equal(item.background, 'rgb(252, 253, 255)', `实心模式底色必须不透明：${item.selector}`))
      assert.equal(await read(`document.querySelectorAll('[data-glass-refraction="on"]').length`), 0, '卸载后不能留下过期滤镜标记')
      await session.screenshot(join(out, `${mode}-solid.png`))
      await close()
      await read(`location.reload()`)
      await session.waitFor(`!document.getElementById('alaya-startup') && window.alayaGlass && document.body.dataset.mode === '${mode}'`)
      assert.equal(await read('alayaGlass.tier()'), 'flat', '刷新后应记住手选偏好')
      check(`${mode}.settings`, { flat, persisted: true, escapeFocus: true })

      // 冷模块的动态 import 与用户快速切回实心之间的竞态。
      await read(`alayaGlass.setTier('full'); alayaGlass.setTier('flat')`)
      await sleep(400)
      assert.equal(await read('alayaGlass.opticalMetrics()'), null)
      assert.equal(await read(`document.documentElement.hasAttribute('data-glass-refraction')`), false)
      assert.equal(await read(`document.querySelectorAll('.alaya-optical-filters').length`), 0)
      check(`${mode}.rapid-switch`, { engine: null })

      await choose('full')
      await close()
      await ready()
      const search = `${prefix} .search-wrap`
      const before = await read(`document.querySelector('${search}').style.getPropertyValue('--glass-refraction-filter')`)
      await read(`document.querySelector('${search} input').focus()`)
      await sleep(300)
      const after = await read(`document.querySelector('${search}').style.getPropertyValue('--glass-refraction-filter')`)
      assert.notEqual(after, before, '搜索框展开后必须重建精确尺寸滤镜')
      await read(`document.querySelector('${search} input').blur()`)
      await sleep(300)
      const idle = await read('alayaGlass.opticalMetrics().renders')
      await sleep(600)
      assert.equal(await read('alayaGlass.opticalMetrics().renders'), idle, '静止时不应持续渲染')
      check(`${mode}.resize-and-idle`, { resized: true, renders: idle })

      const surfaces = await read('alayaGlass.opticalMetrics().surfaces')
      await read(`(() => {
        const probe = document.createElement('div')
        probe.id = 'liquid-cache-probe'
        probe.dataset.glassSurface = 'float'
        probe.style.cssText = 'position:fixed;left:400px;top:100px;width:110px;height:40px;border-radius:20px'
        document.body.append(probe)
      })()`)
      await session.waitFor(`document.querySelector('#liquid-cache-probe').hasAttribute('data-glass-refraction')`)
      for (let width = 111; width < 133; width++) {
        const previous = await read(`document.querySelector('#liquid-cache-probe').style.getPropertyValue('--glass-refraction-filter')`)
        await read(`document.querySelector('#liquid-cache-probe').style.width = '${width}px'`)
        await session.waitFor(`document.querySelector('#liquid-cache-probe').style.getPropertyValue('--glass-refraction-filter') !== ${JSON.stringify(previous)}`)
      }
      const cache = await read('alayaGlass.opticalMetrics()')
      assert.ok(cache.maps <= 16 && cache.filters <= 16 && cache.evictions > 0, '尺寸缓存必须有界，不能复用错误几何的滤镜')
      await read(`document.querySelector('#liquid-cache-probe').remove()`)
      await session.waitFor(`alayaGlass.opticalMetrics().surfaces === ${surfaces}`)
      check(`${mode}.cache`, { maps: cache.maps, filters: cache.filters, evictions: cache.evictions, removedSurfaceReleased: true })

      await session.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
      await read('alayaGlass.recheck()')
      await read(`document.querySelector('${prefix}').dispatchEvent(new PointerEvent('pointermove', { bubbles:true, pointerType:'mouse', clientX:400, clientY:30 }))`)
      await sleep(150)
      assert.equal(await read(`document.querySelector('${prefix}').style.getPropertyValue('--glass-glare-o')`), '', '运行中关闭动态效果也必须停止追光')
      await session.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-contrast', value: 'more' }] })
      await read('alayaGlass.recheck()')
      assert.equal(await read('alayaGlass.tier()'), 'flat')
      assert.equal(await read(`getComputedStyle(document.querySelector('${prefix} .toolbar-actions')).backdropFilter`), 'none')
      await session.send('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] })
      await read('alayaGlass.recheck()')
      assert.equal(await read('alayaGlass.tier()'), 'flat')
      assert.equal(await read(`getComputedStyle(document.querySelector('${prefix} .toolbar-actions')).backgroundImage`), 'none')
      await session.screenshot(join(out, `${mode}-high-contrast.png`))
      await session.send('Emulation.setEmulatedMedia', { features: [] })
      await read('alayaGlass.recheck()')
      await ready()
      assert.equal(await read('alayaGlass.tier()'), 'full', '恢复系统设置后应恢复用户偏好')
      assert.deepEqual(session.exceptions, [], '页面不能有未处理错误')
      check(`${mode}.accessibility`, { reducedMotion: true, contrast: true, forcedColors: true, restored: 'full' })
    } finally { await session.close() }
  }
} finally { server.close() }
writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2))
console.log(`\n${results.length} 项液态玻璃验收通过，截图：${out}`)
