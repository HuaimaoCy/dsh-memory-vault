import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ChromiumSession } from './preview-cdp.mjs'
import { createPreviewServer } from './preview-app.mjs'

const root = resolve(import.meta.dirname, '..')
const out = join(root, 'test-tmp/preview/plain-surfaces')
mkdirSync(out, { recursive: true })
const server = createPreviewServer()
await new Promise(done => server.listen(0, '127.0.0.1', done))
const s = await ChromiumSession.launch({ width: 1440, height: 940, profile: join(root, 'test-tmp/work', `plain-surfaces-${process.pid}`) })
const base = `http://127.0.0.1:${server.address().port}`
const js = source => s.evaluate(source)
const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`)
const results = []
const inspect = async selector => {
  const report = await js(`(() => {
    const root = document.querySelector(${JSON.stringify(selector)});
    const nodes = [root, ...root.querySelectorAll('*')];
    const badFilters = [];
    for (const node of nodes) for (const pseudo of [null, '::before', '::after']) {
      const style = getComputedStyle(node, pseudo);
      if (style.backdropFilter !== 'none' || style.filter !== 'none') badFilters.push(node.className?.baseVal ?? node.className);
    }
    return { background: getComputedStyle(root).backgroundColor, badFilters,
      glassTags: root.querySelectorAll('[data-glass-surface],[data-glass-refraction="on"]').length + Number(root.hasAttribute('data-glass-surface')),
      registered: nodes.filter(node => window.alayaGlass.engine()?.registered(node)).length,
      lenses: [...root.querySelectorAll('.liquid-selection')].filter(node => getComputedStyle(node).display !== 'none').length };
  })()`)
  assert.equal(report.background, 'rgb(255, 255, 255)', selector)
  assert.deepEqual(report.badFilters, [], `${selector} filters`)
  assert.equal(report.glassTags, 0, `${selector} glass tags`)
  assert.equal(report.registered, 0, `${selector} optical registration`)
  assert.equal(report.lenses, 0, `${selector} visible liquid lenses`)
  results.push({ selector, ...report })
}
try {
  await s.goto(`${base}/?tier=full`)
  await s.waitFor(`!document.querySelector('#alaya-startup') && window.alayaGlass?.engine()`)
  assert.equal(await js(`window.alayaGlass.engine().registered(document.querySelector('.side'))`), true)
  assert.equal(await js(`window.alayaGlass.engine().registered(document.querySelector('.bar .toolbar-actions'))`), true)
  await click('#curation-menu summary')
  await inspect('.curation-popover')
  await click('#workspace-settings')
  await s.waitFor(`document.querySelector('#modal[open] [data-sidebar-transparency]')`)
  await inspect('#modal')
  await click('#tab-layout')
  await inspect('#settings-layout .ws-panel')
  await s.screenshot(join(out, 'database-settings.png'))
  // Reparent a live glass control into an existing dialog: the material engine
  // must release registration and tags, even without rebuilding the dialog.
  await js(`document.querySelector('#modal .modal-body').append(document.querySelector('#new'))`)
  await s.waitFor(`!document.querySelector('#modal #new').hasAttribute('data-glass-surface')`)
  await inspect('#modal')
  await click('#modal [aria-label="关闭"]')
  await click('#mode-switch')
  await s.waitFor(`document.querySelector('#mb-new')`)
  await click('#mb-new')
  await inspect('.mb-create-options')
  await s.screenshot(join(out, 'notebook-new-menu.png'))
  await click('#mb-new')
  const dictionary = await js(`(() => { const svg = document.querySelector('#mb-lookup svg'), r = svg.getBoundingClientRect(), b = svg.getBBox(); return { path: svg.querySelector('path').getAttribute('d'), width:r.width,height:r.height,cx:b.x+b.width/2,cy:b.y+b.height/2 }; })()`)
  assert.equal(dictionary.path, 'M17 4H7v16h10M7 12h8')
  assert.equal(dictionary.width, 20); assert.equal(dictionary.height, 20)
  assert.equal(dictionary.cx, 12); assert.equal(dictionary.cy, 12)
  results.push({ dictionary })
  await click('#mb-lookup')
  await inspect('.mb-dialog[open]')
  await s.screenshot(join(out, 'dictionary.png'))
  await click('.mb-dialog[open] [aria-label="关闭对话框"]')
  await click('#mb-workspace-settings')
  await s.waitFor(`document.querySelector('.mb-dialog[open] [data-sidebar-transparency]')`)
  await click('.mb-dialog [data-tab="layout"]')
  await inspect('.mb-dialog[open]')
  await s.screenshot(join(out, 'notebook-settings.png'))
  for (const tier of ['balanced', 'flat', 'full']) {
    await js(`window.alayaGlass.setTier('${tier}')`)
    await inspect('.mb-dialog[open]')
  }
  // Standalone notebook uses its own HTML entry and must load the same policy.
  await s.send('Page.addScriptToEvaluateOnNewDocument', { source: readFileSync(join(root, 'tests/preview-bridge.js'), 'utf8') })
  await s.goto(`${base}/notebook.html`)
  await s.waitFor(`document.querySelector('#mb-new') && window.alayaGlass`)
  await click('#mb-new')
  await inspect('.mb-create-options')
  await click('#mb-new')
  await click('#mb-workspace-settings')
  await s.waitFor(`document.querySelector('.mb-dialog[open] [data-sidebar-transparency]')`)
  await inspect('.mb-dialog[open]')
  assert.deepEqual(s.exceptions, [])
  writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2))
  console.log('Plain secondary surfaces: database, unified notebook, standalone notebook, nested controls, native picker policy, dynamic reparenting, three material tiers and centred E icon passed')
} catch (error) {
  await s.screenshot(join(out, 'failure.png'))
  throw error
} finally { await s.close(); server.close() }
