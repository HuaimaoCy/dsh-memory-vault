/**
 * 画布撤销粒度：一次连续的输入必须只算一条历史。
 *
 * 复现路径（修复前真的会丢）：输入 A → 点工具栏加一张第二张文本卡片（render 重建卡片，
 * textarea 被移除且不一定触发 blur）→ 回到文本卡片输入 B → 撤销一次。
 * 旧实现里第二段输入会复用第一段的快照，撤销一次把 A 和 B 一起回退。
 */
import assert from 'node:assert/strict'
import { dialog } from 'electron'

export async function run(window, bridge) {
  assert.match(bridge.databasePath, /canvas-undo-test[^\\/]*\.sqlite$/i, '必须跑在 canvas-undo-test 临时库上')

  const js = source => window.webContents.executeJavaScript(source)
  const sleep = ms => new Promise(done => setTimeout(done, ms))
  const until = async (expression, label = expression) => {
    for (let attempt = 0; attempt < 600; attempt++) { if (await js(expression)) return; await sleep(25) }
    throw new Error(`界面超时：${label}`)
  }
  const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const textValue = () => js(`document.querySelector('.mb-canvas-card.text .mb-canvas-text')?.value ?? null`)
  const cardCount = () => js(`document.querySelectorAll('.mb-canvas-card').length`)
  const boardId = () => js("document.querySelector('#mb-canvas-picker').value")
  const switchBoard = id => js(`(() => {
    const picker = document.querySelector('#mb-canvas-picker')
    picker.value = ${JSON.stringify(id)}
    picker.dispatchEvent(new Event('change', { bubbles:true }))
  })()`)
  const shortcut = redo => {
    const modifiers = [process.platform === 'darwin' ? 'meta' : 'control']
    if (redo) modifiers.push('shift')
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers })
  }

  await until(`!document.getElementById('alaya-startup')`, '启动完成')
  await sleep(300)
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await js(`document.body.dataset.mode === 'mistakebook'`)) break
    await js(`(() => { document.getElementById('mode-switch').click(); return true })()`)
    await sleep(250)
  }
  await until(`document.getElementById('mb-canvas-button') !== null`, '笔记本工具栏就绪')
  await click('#mb-canvas-button')
  await until(`document.getElementById('mb-canvas-surface') !== null`, '画布打开')
  await until(`document.querySelector('#mb-canvas-picker')?.options.length >= 1`, '画布文档就绪')

  // 1) 第一段输入：A
  await click('#mb-canvas-text')
  await js(`(() => {
    const surface = document.getElementById('mb-canvas-surface')
    const rect = surface.getBoundingClientRect()
    surface.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles:true, cancelable:true, button:0, buttons:1, clientX:rect.left + 200, clientY:rect.top + 200,
    }))
  })()`)
  await until(`document.querySelector('.mb-canvas-card.text .mb-canvas-text') !== null`, '文本卡片出现')
  await js(`(() => {
    const node = document.querySelector('.mb-canvas-card.text .mb-canvas-text')
    node.focus(); node.value = 'A'; node.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await until(`document.querySelector('.mb-canvas-card.text .mb-canvas-text').value === 'A'`, '第一段输入落库到草稿')

  // 2) 结构性改动：加一张第二张文本卡片 → render 重建卡片，textarea 被移除（不一定有 blur）
  await click('#mb-canvas-text')
  await js(`(() => {
    const surface = document.getElementById('mb-canvas-surface')
    const rect = surface.getBoundingClientRect()
    surface.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles:true, cancelable:true, button:0, buttons:1, clientX:rect.left + 200, clientY:rect.top + 200,
    }))
  })()`)
  await until(`document.querySelectorAll('.mb-canvas-card').length === 2`, '第二张文本卡片加入并重建卡片')
  assert.equal(await textValue(), 'A', '重建卡片后已输入的文本必须还在')

  // 3) 第二段输入：AB（重新聚焦同一张卡片）
  await js(`(() => {
    const node = document.querySelector('.mb-canvas-card.text .mb-canvas-text')
    node.focus(); node.value = 'AB'; node.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await until(`document.querySelector('.mb-canvas-card.text .mb-canvas-text').value === 'AB'`, '第二段输入')
  // 4) 即使文字框仍持有焦点，撤销一次也只回退第二段输入。
  shortcut(false)
  await until(`document.querySelector('.mb-canvas-card.text .mb-canvas-text')?.value === 'A'`, '撤销一次应只回退第二段输入')
  assert.equal(await textValue(), 'A', '一次撤销只能回退最近一段输入')
  assert.equal(await cardCount(), 2, '撤销第二段输入不应动到第二张文本卡片')
  assert.equal(await js("document.activeElement.classList.contains('mb-canvas-text')"), true, '撤销后可继续输入')

  // 5) 每再撤销一次回退一个动作：加第二张文本卡片 → 第一段输入 → 加文本卡片。
  await click('#mb-canvas-undo')
  await until(`document.querySelectorAll('.mb-canvas-card').length === 1`, '第二次撤销回退加第二张文本卡片')
  assert.equal(await textValue(), 'A', '回退加第二张文本卡片不该动到已输入的文本')
  await click('#mb-canvas-undo')
  await until(`document.querySelector('.mb-canvas-card.text .mb-canvas-text')?.value === ''`, '第三次撤销回退第一段输入')
  await click('#mb-canvas-undo')
  await until(`document.querySelectorAll('.mb-canvas-card').length === 0`, '第四次撤销回到空画布')

  // 6) 重做按同样的步数回来。
  await click('#mb-canvas-redo')
  await until(`document.querySelectorAll('.mb-canvas-card').length === 1`, '重做第一步恢复文本卡片')
  await click('#mb-canvas-redo')
  await until(`document.querySelector('.mb-canvas-card.text .mb-canvas-text')?.value === 'A'`, '重做第二步恢复第一段输入')
  await click('#mb-canvas-redo')
  await until(`document.querySelectorAll('.mb-canvas-card').length === 2`, '重做第三步恢复第二张文本卡片')
  await click('#mb-canvas-redo')
  await until(`document.querySelector('.mb-canvas-card.text .mb-canvas-text')?.value === 'AB'`, '重做第四步恢复第二段输入')

  const first = await boardId()
  await click('#mb-canvas-new')
  await js(`(() => {
    document.querySelector('#mb-canvas-title-input').value = '撤销测试画布'
    document.querySelector('#mb-canvas-title-save').click()
  })()`)
  await until("document.querySelector('#mb-canvas-picker').options.length === 2", '新建第二张画布')
  const second = await boardId()
  await click('#mb-canvas-text')
  await js(`(() => {
    const surface = document.querySelector('#mb-canvas-surface')
    const { left, top } = surface.getBoundingClientRect()
    surface.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles:true, cancelable:true, button:0, buttons:1, clientX:left + 250, clientY:top + 210,
    }))
    const field = document.querySelector('.mb-canvas-text')
    field.value = '第二张画布的文字'
    field.dispatchEvent(new Event('input', { bubbles:true }))
  })()`)
  await switchBoard(first)
  shortcut(false)
  await until(`document.querySelector('#mb-canvas-picker').value === ${JSON.stringify(second)}`, '跨画布撤销定位到原操作')
  assert.equal(await textValue(), '')
  await switchBoard(first)
  shortcut(true)
  await until(`document.querySelector('#mb-canvas-picker').value === ${JSON.stringify(second)}`, '跨画布重做定位到原操作')
  assert.equal(await textValue(), '第二张画布的文字')

  const originalConfirm = dialog.showMessageBox
  let confirmations = 0
  dialog.showMessageBox = async () => { confirmations++; return { response: 0 } }
  try {
    await js("(() => { const close = document.querySelector('.mb-canvas-card-close'); close.focus(); close.click() })()")
    assert.equal(await cardCount(), 0, '直接删除卡片')
    shortcut(false)
    await until("document.querySelectorAll('.mb-canvas-card').length === 1", '焦点回到窗口时也能撤销删除')
    assert.equal(await textValue(), '第二张画布的文字')

    await click('#mb-canvas-delete')
    assert.equal(await boardId(), first)
    shortcut(false)
    await until(`document.querySelector('#mb-canvas-picker').value === ${JSON.stringify(second)}`, '撤销删除整张画布')
    assert.equal(await textValue(), '第二张画布的文字')
    shortcut(true)
    await until(`document.querySelector('#mb-canvas-picker').value === ${JSON.stringify(first)}`, '重做删除整张画布')
    await click('#mb-canvas-delete')
    assert.notEqual(await boardId(), first, '删掉最后一张画布时自动创建空白画布')
    assert.equal(await cardCount(), 0)
    shortcut(false)
    await until(`document.querySelector('#mb-canvas-picker').value === ${JSON.stringify(first)}`, '撤销删除最后一张画布')
    assert.equal(await textValue(), 'AB')
    assert.equal(await cardCount(), 2)
    assert.equal(confirmations, 0, '删除不调用系统确认框')
  } finally { dialog.showMessageBox = originalConfirm }

  console.log('Desktop canvas undo: focused text, cross-board history and silent reversible deletion passed')
}
