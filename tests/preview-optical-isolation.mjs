/** 在相同材质下只改变一个光学阶段，避免把 blur/tint 差当作折射证据。 */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { ChromiumSession } from './preview-cdp.mjs'
import { createPreviewServer } from './preview-app.mjs'
import { decodePng } from './fixtures/liquid-glass-compare/png.mjs'
import { signedDistance } from '../desktop/renderer/optical/geometry.js'

const root = resolve(import.meta.dirname, '..')
const arg = key => { const i = process.argv.indexOf(key); return i < 0 ? null : process.argv[i + 1] }
const label = arg('--label') || 'current'
const out = resolve(arg('--out') || join(root, 'test-tmp/preview/isolation', label))
mkdirSync(out, { recursive: true })
const sleep = ms => new Promise(done => setTimeout(done, ms))
let cropBoxes = []
const server = createPreviewServer({ mode: 'memory' })
await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done) })
const session = await ChromiumSession.launch({ width: 1440, height: 940, profile: join(root, 'test-tmp/work', `isolation-${label}-${process.pid}`) })
const shot = async name => {
  await sleep(180)
  const data = await session.send('Page.captureScreenshot', { format: 'png' })
  const bytes = Buffer.from(data.data, 'base64')
  writeFileSync(join(out, `${name}.png`), bytes)
  if(['02-grid-product','04-refraction-only','05-no-optics','06-refraction-and-reflection'].includes(name))for(const box of cropBoxes){
    const suffix=box.selector==='.side'?'side':box.selector.includes('toolbar')?'toolbar':'search'
    const crop=await session.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false,clip:{x:box.x-2,y:box.y-2,width:Math.min(box.width+4,240),height:Math.min(box.height+4,112),scale:2}})
    writeFileSync(join(out,`${name}-${suffix}.png`),Buffer.from(crop.data,'base64'))
  }
  return decodePng(bytes)
}
const stage = (selector, attribute, off) => session.evaluate(`(() => {
  for (const node of document.querySelectorAll(${JSON.stringify(selector)})) {
    const name = ${JSON.stringify(attribute)}
    if (!node.hasAttribute('data-isolation-original')) node.setAttribute('data-isolation-original', node.getAttribute(name))
    node.setAttribute(name, ${off === null ? "node.getAttribute('data-isolation-original')" : JSON.stringify(String(off))})
  }
})()`)
const difference = (a, b, box) => {
  const sums = { edge: 0, center: 0, outside: 0 }
  const counts = { edge: 0, center: 0, outside: 0 }
  for (let y = 0; y < box.height; y++) for (let x = 0; x < box.width; x++) {
    const d = signedDistance({ ...box, x: x + .5, y: y + .5 })
    const region = d > 0 ? 'outside' : d > -Math.min(12, box.height / 4) ? 'edge' : 'center'
    const i = ((y + box.y) * a.width + x + box.x) * 4
    const delta = (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2])) / 3
    sums[region] += delta
    counts[region]++
  }
  return Object.fromEntries(Object.keys(sums).map(key => [key, +(sums[key] / Math.max(1, counts[key])).toFixed(3)]))
}
try {
  await session.goto(`http://127.0.0.1:${server.address().port}/?tier=full`)
  await session.waitFor(`!document.getElementById('alaya-startup') && document.querySelector('.bar .toolbar-actions[data-glass-refraction="on"]')`)
  await sleep(400)
  await session.evaluate(`document.querySelector('#status').classList.remove('show')`)
  await shot('01-formal')
  await session.evaluate(`(() => {
    const probe = document.createElement('div')
    probe.id = 'optical-isolation-background'
    probe.style.cssText = 'position:fixed;inset:0;z-index:-1;pointer-events:none;background:repeating-linear-gradient(90deg,#0e243b 0 2px,transparent 2px 17px),repeating-linear-gradient(0deg,#0e243b 0 2px,transparent 2px 17px),#edf2f7'
    for (let row=0;row<15;row++) {
      const text = document.createElement('div')
      text.textContent = 'ALAYA   Aa 123   光学采样   0123456789   '.repeat(6)
      text.style.cssText = 'height:64px;padding:8px 0;font:600 18px/1.4 sans-serif;color:#192f49'
      probe.append(text)
    }
    document.querySelector('.app-shell').append(probe)
  })()`)
  const facts = await session.evaluate(`['.side', '.bar .toolbar-actions', '.bar .search-wrap'].map(selector => {
    const node=document.querySelector(selector), pseudo='::before'
    const s=getComputedStyle(node,pseudo), r=node.getBoundingClientRect(), inset=pseudo?parseFloat(s.left)||0:0
    return {selector, x:Math.round(r.left+inset), y:Math.round(r.top+inset), width:Math.round(r.width-2*inset), height:Math.round(r.height-2*inset), radius:parseFloat(s.borderTopLeftRadius)||0, backdrop:s.backdropFilter, centerBlur:getComputedStyle(node,'::after').backdropFilter, filter:node.style.getPropertyValue('--glass-refraction-filter')}
  })`)
  cropBoxes=facts
  const product = await shot('02-grid-product')
  await stage('.alaya-optical-filters feDisplacementMap', 'scale', 0)
  const productOff = await shot('03-grid-product-no-displacement')
  await stage('.alaya-optical-filters feDisplacementMap', 'scale', null)
  await session.evaluate(`(() => {
    const css=document.createElement('style');css.id='optical-isolation-style'
    css.textContent='[data-glass-refraction="on"]{box-shadow:none!important;border-color:transparent!important}[data-glass-refraction="on"]::before{background-image:var(--glass-reflection-map)!important;box-shadow:none!important;border-color:transparent!important}[data-glass-refraction="on"]::after{background:transparent!important;box-shadow:none!important;border-color:transparent!important}html[data-isolation-reflection="off"] [data-glass-refraction="on"]{--glass-reflection-map:linear-gradient(transparent,transparent)!important}html[data-isolation-frost="off"] [data-glass-refraction="on"]{--glass-frost-blur:0px!important}'
    document.head.append(css)
    css.append(document.createTextNode('.sidebar-coating{background:transparent!important;border-color:transparent!important;box-shadow:none!important}.sidebar-rim{display:none!important}'))
    document.documentElement.dataset.isolationReflection='off'
    document.documentElement.dataset.isolationFrost='off'
  })()`)
  await stage('.alaya-optical-filters feGaussianBlur', 'stdDeviation', 0)
  await stage('.alaya-optical-filters [data-optical-stage="reflection-alpha"]', 'slope', 0)
  const raw = await shot('04-refraction-only')
  await stage('.alaya-optical-filters feDisplacementMap', 'scale', 0)
  const rawOff = await shot('05-no-optics')
  await stage('.alaya-optical-filters feDisplacementMap', 'scale', null)
  await stage('.alaya-optical-filters [data-optical-stage="reflection-alpha"]', 'slope', null)
  await session.evaluate(`delete document.documentElement.dataset.isolationReflection`)
  const reflected = await shot('06-refraction-and-reflection')
  await stage('.alaya-optical-filters feGaussianBlur', 'stdDeviation', null)
  await session.evaluate(`delete document.documentElement.dataset.isolationFrost`)
  await shot('07-refraction-reflection-blur')
  await session.evaluate(`document.getElementById('optical-isolation-style').remove()`)
  await shot('08-all-layers-restored')
  const comparisons = facts.map(box => ({ selector:box.selector, registered:Boolean(box.filter), production:difference(product,productOff,box), refractionOnly:difference(raw,rawOff,box), reflectionOnly:difference(reflected,raw,box) }))
  const result = { label, facts, comparisons, filters:await session.evaluate(`Array.from(document.querySelectorAll('.alaya-optical-filters feDisplacementMap'),node=>Number(node.getAttribute('scale')))`), metrics:await session.evaluate('alayaGlass.opticalMetrics()') }
  writeFileSync(join(out,'results.json'),JSON.stringify(result,null,2))
  console.log(JSON.stringify(result,null,2))
  if (process.argv.includes('--assert')) {
    for (const result of comparisons) {
      assert.ok(result.registered, result.selector+' 必须接入光学材质')
      assert.ok(result.refractionOnly.edge > 1, result.selector+' 必须有独立折射位移')
      assert.ok(result.production.edge > .7, result.selector+' 恢复合成后必须保留可见位移')
      assert.ok(result.refractionOnly.center < result.refractionOnly.edge*.15, result.selector+' 中心必须保持平坦，不能用全局平移充当折射')
      assert.ok(result.reflectionOnly.edge > .1, result.selector+' 必须实际合成倒角反射')
      assert.ok(result.refractionOnly.outside < .15, result.selector+' 折射不能泄漏到圆角外')
    }
  }
} finally { await session.close(); server.close() }
