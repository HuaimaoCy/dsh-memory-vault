/**
 * 画布撤销粒度：一次连续的输入必须只算一条历史。
 *
 * 复现路径（修复前真的会丢）：输入 A → 点工具栏加一张便签（render 重建卡片，
 * textarea 被移除且不一定触发 blur）→ 回到文本卡片输入 B → 撤销一次。
 * 旧实现里第二段输入会复用第一段的快照，撤销一次把 A 和 B 一起回退。
 */
import assert from 'node:assert/strict'

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
  await until(`document.querySelector('.mb-canvas-card.text .mb-canvas-text') !== null`, '文本卡片出现')
  await js(`(() => {
    const node = document.querySelector('.mb-canvas-card.text .mb-canvas-text')
    node.focus(); node.value = 'A'; node.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await until(`document.querySelector('.mb-canvas-card.text .mb-canvas-text').value === 'A'`, '第一段输入落库到草稿')

  // 2) 结构性改动：加一张便签 → render 重建卡片，textarea 被移除（不一定有 blur）
  await click('#mb-canvas-sticky')
  await until(`document.querySelectorAll('.mb-canvas-card').length === 2`, '便签加入并重建卡片')
  assert.equal(await textValue(), 'A', '重建卡片后已输入的文本必须还在')

  // 3) 第二段输入：AB（重新聚焦同一张卡片）
  await js(`(() => {
    const node = document.querySelector('.mb-canvas-card.text .mb-canvas-text')
    node.focus(); node.value = 'AB'; node.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await until(`document.querySelector('.mb-canvas-card.text .mb-canvas-text').value === 'AB'`, '第二段输入')
  await js(`document.querySelector('.mb-canvas-card.text .mb-canvas-text').blur()`)
  await sleep(120)

  // 4) 撤销一次只回退第二段输入，便签仍在。
  await click('#mb-canvas-undo')
  await until(`document.querySelector('.mb-canvas-card.text .mb-canvas-text')?.value === 'A'`, '撤销一次应只回退第二段输入')
  assert.equal(await textValue(), 'A', '一次撤销只能回退最近一段输入')
  assert.equal(await cardCount(), 2, '撤销第二段输入不应动到便签')

  // 5) 每再撤销一次回退一个动作：加便签 → 第一段输入 → 加文本卡片。
  await click('#mb-canvas-undo')
  await until(`document.querySelectorAll('.mb-canvas-card').length === 1`, '第二次撤销回退加便签')
  assert.equal(await textValue(), 'A', '回退加便签不该动到已输入的文本')
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
  await until(`document.querySelectorAll('.mb-canvas-card').length === 2`, '重做第三步恢复便签')
  await click('#mb-canvas-redo')
  await until(`document.querySelector('.mb-canvas-card.text .mb-canvas-text')?.value === 'AB'`, '重做第四步恢复第二段输入')

  console.log('Desktop canvas undo: typing settled across a structural re-render, one undo per input session, redo mirrors the steps passed')
}
