import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'

/** Visual fixtures stay in an explicitly named test database. Never seed a user's library. */
export async function run(window, bridge) {
  assert.match(bridge.databasePath, /design-test[^\\/]*\.sqlite$/)
  const js = code => window.webContents.executeJavaScript(code)
  const until = expression => js(`new Promise((resolve, reject) => { let n = 0; const timer = setInterval(() => { if (${expression}) { clearInterval(timer); resolve(true) } else if (++n > 160) { clearInterval(timer); reject(new Error(document.querySelector('#status').textContent)) } }, 25) })`)
  const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const fill = (selector, value) => js(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); node.value = ${JSON.stringify(value)}; node.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  const argument = process.argv.indexOf('--shot')
  const folder = argument < 0 ? null : dirname(resolve(process.argv[argument + 1]))
  const paint = async () => {
    // Hidden offscreen windows need a fresh compositor frame before a screenshot.
    const painted = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { window.webContents.removeListener('paint', onPaint); reject(new Error('No offscreen paint frame')) }, 5000)
      const onPaint = () => { clearTimeout(timer); resolve() }
      window.webContents.once('paint', onPaint)
    })
    window.webContents.invalidate(); await painted
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  const shot = async name => { await paint(); if (folder) writeFileSync(join(folder, `design-${name}.png`), (await window.webContents.capturePage()).toPNG()) }
  const geometry = async () => {
    const result = await js(`(() => { const body = document.body; const main = document.querySelector('.main'); const drawer = document.querySelector('#drawer'); const save = document.querySelector('#save-entry'); const visible = node => node && node.getBoundingClientRect().width > 0; return { overflow: body.scrollWidth > innerWidth, mainOverflow: main.scrollWidth > main.clientWidth + 1, saveVisible: !visible(drawer) || save.getBoundingClientRect().bottom <= innerHeight, cards: [...document.querySelectorAll('.tile')].every(node => node.scrollWidth <= node.clientWidth + 1) } })()`)
    assert.equal(result.overflow, false); assert.equal(result.mainOverflow, false); assert.equal(result.saveVisible, true); assert.equal(result.cards, true)
  }
  await until("document.querySelectorAll('#views button').length === 4")
    await until("document.querySelector('#alaya-startup')===null")
  await until("document.body.dataset.mode==='mistakebook'")
  await click('#mb-mode-switch'); await until("document.body.dataset.mode==='memory'")
  await shot('empty')
  await click('.empty .btn')
  await until("document.querySelector('#drawer [data-field=title]')")
  await fill('[data-field="title"]', '快捷键保存')
  await fill('[data-field="content"]', '通过键盘保存，关闭详情后保留在数据库中。')
  await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }))")
  await until("document.querySelector('#status').textContent === '记忆已创建'")
  const temporary = bridge.vault.store.listEntries({ limit: 20 }).find(row => row.title === '快捷键保存')
  assert.ok(temporary)
  await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
  await until("document.querySelector('#drawer').classList.contains('hidden')")
  await bridge.invoke('entry.delete', { id: temporary.id })
  await bridge.invoke('group.create', { name: '项目约定', parent: '知识库', scope: 'knowledge' })
  await bridge.invoke('group.create', { name: '写作笔记', scope: 'knowledge' })
  const samples = [
    ['按任务选择合适的模型', '日常工作使用熟悉的模型。面对不同任务，按需切换到更适合的服务，让记录下来的记忆继续发挥作用。', 'preference', ['工作方式', '模型配置'], true],
    ['一个数据库，连接所有助手', '桌面软件、Codex 与 DSH 共用同一份记忆。已经确认的结论保存一次，在下次工作时继续使用。', 'decision', ['工作方式', '接口'], false],
    ['先验证，再发布', '发布前检查核心功能、独立安装包与数据库备份。让每一次更新都可以验证，也方便回到之前的状态。', 'task', ['工作方式', '发布'], false],
    ['把结论写成可复用的知识', '用具体的标题记录解决办法，补充适用场景与限制。临时进度放在对话记忆，长期结论整理进知识库。', 'note', ['工作方式', '整理'], false],
    ['界面保持简单与清晰', '给主要内容留出空间，让操作出现在需要它的地方。文字优先，色彩克制，重要的状态一眼就能看清。', 'preference', ['工作方式', '设计'], false],
    ['保留上下文，也保留边界', '一条记忆只讲清楚一件事。记录依据、背景和已确认的约定，让助手理解结论来自哪里。', 'fact', ['工作方式', '知识'], false],
  ]
  for (const [title, content, kind, tags, base] of samples) await bridge.invoke('entry.write', { group: '项目约定', title, content, kind, tags, base, priority: kind === 'decision' ? 90 : kind === 'task' ? 80 : 70 })
  await click('#refresh')
  await until("document.querySelectorAll('.tile').length === 6")
  await js("[...document.querySelectorAll('#views button')].find(node => node.textContent.startsWith('知识库')).click()")
  await until("document.querySelector('#view-title').textContent === '知识库'")
  await js("document.activeElement.blur(); document.querySelector('#status').classList.remove('show')")
  await geometry()
  window.setSize(1440, 940)
  await geometry(); await shot('board')
  window.setSize(1280, 850)
  await click('#view-list')
  assert.equal(await js("document.querySelector('#list').classList.contains('rows')"), true)
  await geometry(); await shot('list')
  await click('#view-grid')
  await js("[...document.querySelectorAll('.tile')].find(node => node.textContent.includes('一个数据库')).click()")
  await until("document.querySelector('#drawer [data-field=title]')?.value === '一个数据库，连接所有助手'")
  await geometry(); await shot('detail')
  await click('#settings'); await click('#tab-model')
  assert.equal(await js("document.querySelector('#settings-model').classList.contains('hidden')"), false)
  await js("document.activeElement.blur()")
  await shot('settings')
  await click('#tab-connectors')
  assert.equal(await js("document.querySelector('#settings-connectors').classList.contains('hidden')"), false)
  assert.match(await js("document.querySelector('[aria-label=\"Codex 接口配置\"]').value"), /mcp/)
  await js("document.querySelector('dialog').close()")
  window.setSize(940, 600)
  await paint(); await geometry(); await shot('compact')
  window.setSize(1280, 850)
  await js("document.querySelector('#drawer [aria-label=\"关闭记忆详情\"]').click()")
  await until("document.querySelector('#drawer').classList.contains('hidden')")
  await paint(); await geometry()
  console.log('Desktop design: empty state, keyboard save, card/list views, settings tabs, connectors and 940px layout passed')
}
