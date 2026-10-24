/**
 * 真实应用内的统一捕获集成测试：不自己挂模块，而是驱动 app.js 已经接好的入口，
 * 证明「按钮/快捷键 → 面板 → 记忆域写入 → 列表刷新 → 笔记本域写入」这条链在真实
 * Electron 窗口与临时 SQLite 上可用，并且两个域不互相串写。
 *
 * 这是接线后的回归护栏：模块单测证明模块本身，这个套件证明接线没接错。
 */
import assert from 'node:assert/strict'

export async function run(window, bridge) {
  assert.match(bridge.databasePath, /capture-app[^\\/]*\.sqlite$/i, '必须跑在 capture-app 临时数据库上')

  const js = async source => {
    try {
      return await window.webContents.executeJavaScript(source)
    } catch (error) {
      throw new Error(`注入脚本失败：${error?.message ?? error}\n${source}`)
    }
  }
  const sleep = ms => new Promise(done => setTimeout(done, ms))
  const until = async (expression, label = expression) => {
    for (let index = 0; index < 600; index++) {
      if (await js(expression)) return
      await sleep(30)
    }
    throw new Error(`界面超时：${label}`)
  }
  const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const setValue = (selector, text) => js(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)})
    node.value = ${JSON.stringify(text)}
    node.dispatchEvent(new Event('input', { bubbles: true }))
    return node.value
  })()`)
  const entries = query => js(`(async () => {
    const reply = await window.vault.invoke('entries', { query: ${JSON.stringify(query)}, limit: 20 })
    if (reply?.ok !== true) throw new Error(reply?.error ?? 'entries 失败')
    return reply.result.entries.map(row => ({ id: row.id, title: row.title, content: row.content, scope: row.scope }))
  })()`)
  const notes = () => js(`(async () => {
    const reply = await window.vault.notebook('list', { view: 'all', limit: 20 })
    if (reply?.ok !== true) throw new Error(reply?.error ?? 'notebook.list 失败')
    return reply.result.records.map(row => ({ id: row.id, title: row.title, stem: row.stem, type: row.type }))
  })()`)
  const DIALOG = '[data-qc="dialog"]'
  const part = name => `${DIALOG} [data-qc="${name}"]`
  const isOpen = `document.querySelector('${DIALOG}')?.open === true`
  // 启动与模式切换期间 guard 是忙的，点击会被丢弃：用「点一次、等一会儿、再试」的方式
  // 驱开面板，而不是假定点一下就开。
  const openPanel = async (trigger, label) => {
    for (let attempt = 0; attempt < 40; attempt++) {
      if (await js(isOpen)) return
      await trigger()
      for (let wait = 0; wait < 10; wait++) {
        if (await js(isOpen)) return
        await sleep(50)
      }
    }
    throw new Error(`界面超时：${label}`)
  }
  const token = `捕获联调-${Date.now()}`
  const noteToken = `捕获联调-笔记-${Date.now()}`

  // 0) 等启动序列结束（loading.js 会移除 #alaya-startup），再确定停在数据库界面。
  await until(`!document.getElementById('alaya-startup')`, '启动序列结束')
  await sleep(300)
  // 启动的收尾会按上次模式切到笔记本（默认就是笔记本）；切回用笔记本自己的品牌按钮
  // #mb-mode-switch（数据库侧那个 #mode-switch 在笔记本模式下是隐藏的）。切换可能被
  // guard 丢掉，所以重试到稳定为止。
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await js(`document.body.dataset.mode !== 'mistakebook'`)) break
    await js(`(() => { const back = document.getElementById('mb-mode-switch'); (back ?? document.getElementById('mode-switch')).click(); return 1 })()`)
    await sleep(250)
    if (attempt === 79) throw new Error('界面超时：切回数据库界面')
  }
  await until(`document.querySelectorAll('#list .tile, #list .empty').length > 0`, '列表渲染完成')
  await until(`!!document.getElementById('capture')`, '捕获入口存在')

  // 1) 初始面板关闭（元素在挂载时就存在，只有 open 才代表可见），入口是一个真实可点的按钮。
  assert.equal(await js(`document.querySelector('${DIALOG}')?.open ?? false`), false, '打开前面板不应处于打开状态')
  assert.equal(await js(`document.getElementById('capture').offsetParent !== null`), true, '捕获按钮必须可见')

  // 2) 点按钮 → 面板打开并聚焦输入框。
  await openPanel(() => click('#capture'), '点按钮打开面板')
  await until(`document.activeElement === document.querySelector('${part('input')}')`, '打开即聚焦输入框')

  // 3) 记忆域：写入后能在库里读回，且列表自己刷新出这条记忆。
  await setValue(part('input'), token)
  await click(part('save'))
  await until(`document.querySelector('${part('status')}')?.textContent?.includes('已保存')`, '记忆域保存反馈')
  const savedEntries = await entries(token)
  assert.equal(savedEntries.length, 1, '记忆域应恰好写入一条')
  assert.equal(savedEntries[0].scope, 'knowledge', '默认写入知识库')
  assert.match(savedEntries[0].content, new RegExp(token), '写入内容应包含输入正文')
  await until(`document.getElementById('list').textContent.includes(${JSON.stringify(token)})`, '列表刷新出刚捕获的记忆')

  // 4) Esc 关闭；快捷键 Ctrl+Shift+N 再打开（证明全局入口接上了）。
  await js(`document.querySelector('${DIALOG}').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`)
  await until(`document.querySelector('${DIALOG}')?.open !== true`, 'Esc 关闭面板')
  await openPanel(() => js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }))`), 'Ctrl+Shift+N 打开面板')

  // 5) 笔记本域：目标列表来自 NOTEBOOK_TARGETS（5 种），写入后不回落到记忆域。
  await click(`${part('mode')}[data-qc-mode="notebook"]`)
  await until(`document.querySelector('${part('target')}')?.options?.length >= 2`, '笔记本目标可选')
  const noteTargets = await js(`[...document.querySelector('${part('target')}').options].map(option => option.textContent.trim())`)
  assert.deepEqual(noteTargets, ['笔记', '错题', '物理模型', '解题方法', '英语词汇'], '捕获面板的笔记本目标必须与 NOTE_TYPES 一致')
  await setValue(part('input'), noteToken)
  await click(part('save'))
  await until(`document.querySelector('${part('status')}')?.textContent?.includes('已保存')`, '笔记本域保存反馈')
  const savedNotes = await notes()
  assert.equal(savedNotes.some(row => String(row.stem ?? '').includes(noteToken) && row.type === 'note'), true, '笔记本域应写入一条笔记')
  assert.equal((await entries(noteToken)).length, 0, '笔记本内容不得写进记忆域')

  // 6) 关闭，恢复干净状态。
  await click(part('close'))
  await until(`document.querySelector('${DIALOG}')?.open !== true`, '关闭面板')

  console.log('desktop-capture-app: 入口按钮/快捷键、记忆域写入与列表刷新、笔记本域目标与写入、跨域隔离 全部通过')
}
