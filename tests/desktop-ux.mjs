import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { app, dialog } from 'electron'

/** Runs only against an isolated profile and test database in a real Electron window. */
export async function run(window, bridge) {
  assert.match(bridge.databasePath, /mistakebook-memory-test[^\\/]*\.sqlite$/)
  const profileArg = process.argv.indexOf('--user-data')
  assert.ok(profileArg >= 0, 'The UX suite requires an explicit isolated --user-data path')
  const profile = resolve(process.argv[profileArg + 1])
  assert.match(profile.replace(/\\/g, '/'), /\/work\//i)
  assert.equal(resolve(app.getPath('userData')).toLowerCase(), profile.toLowerCase())

  const js = source => window.webContents.executeJavaScript(source)
  const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const fill = (selector, value, event = 'input') => js(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    node.value = ${JSON.stringify(value)};
    node.dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true }));
  })()`)
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
  const until = async expression => {
    for (let attempt = 0; attempt < 280; attempt++) {
      if (await js(expression)) return
      await pause(25)
    }
    const status = await js("[document.querySelector('#mb-status')?.textContent,document.querySelector('#status')?.textContent].filter(Boolean).join(' | ')")
    throw new Error(`UX timeout: ${expression}; ${status}`)
  }
  const idle = () => until("!document.querySelector('.mb-shell').hasAttribute('aria-busy')")
  const notebook = async (action, body = {}) => {
    const reply = await js(`window.vault.mistakebook(${JSON.stringify(action)}, ${JSON.stringify(body)})`)
    assert.equal(reply.ok, true, reply.error)
    return reply.result
  }
  const memory = async (operation, body = {}) => {
    const reply = await js(`window.vault.invoke(${JSON.stringify(operation)}, ${JSON.stringify(body)})`)
    assert.equal(reply.ok, true, reply.error)
    return reply.result
  }
  const memoryChoice = async label => {
    await until("document.querySelector('#unsaved-changes[open]') !== null")
    await js(`(() => {
      const button = [...document.querySelectorAll('#unsaved-changes button')].find(node => node.textContent.trim() === ${JSON.stringify(label)});
      if (!button) throw new Error('Missing unsaved-change choice: ' + ${JSON.stringify(label)});
      button.click();
    })()`)
    await until("document.querySelector('#unsaved-changes[open]') === null")
    // close() 只同步去掉 open 属性；查询框/编辑器的恢复在 close 事件的 onClose 里，
    // 该回调末尾才 dialog.remove()。等节点消失，避免在恢复之前就断言。
    await until("document.querySelector('#unsaved-changes') === null")
  }
  const searchMemory = async (query, count = 1) => {
    await fill('#query', query)
    await until(`document.querySelectorAll('#list [data-id]').length === ${count} && document.querySelector('#list').textContent.includes(${JSON.stringify(query)})`)
  }
  const confirmOriginal = dialog.showMessageBox
  dialog.showMessageBox = async () => ({ response: 1 })
  const token = `ux-${Date.now()}`
  const notebookIds = [], memoryIds = []
  try {
    await until("document.querySelectorAll('#views button').length === 4")
    await until("document.querySelector('#alaya-startup') === null")
    await until("document.body.dataset.mode === 'mistakebook'")
    await idle()

    // A hand-drawn page remains a draft through editor reconstruction and saves directly (note type, 0.7.13 merge).
    await click('#mb-new'); await idle()
    await click('[data-create-type="note"]'); await idle()
    await click('[data-hw-width="8"]'); await idle()
    assert.equal(await js("document.querySelector('[data-hw-width=\"8\"]').getAttribute('aria-pressed')"), 'true')
    assert.equal(await js("document.querySelectorAll('.mb-hw-width[aria-pressed=\"true\"]').length"), 1)
    assert.equal(await js("document.querySelector('#mb-status').classList.contains('error')"), false)
    await js(`(() => {
      const canvas = document.querySelector('#mb-handwrite-canvas'), rect = canvas.getBoundingClientRect();
      const send = (name, x, y) => canvas.dispatchEvent(new PointerEvent(name, {
        pointerId: 1, clientX: rect.left + rect.width * x, clientY: rect.top + rect.height * y, bubbles: true,
      }));
      send('pointerdown', .12, .25);
      for (let i = 1; i <= 24; i++) send('pointermove', .12 + i * .012, .25 + Math.sin(i / 4) * .045);
      send('pointerup', .41, .25);
    })()`)
    assert.match(await js("document.querySelector('#mb-save-state').textContent"), /未保存/)
    // 手写页存的是 PNG（不是笔画数据），而改分类/换排序会重建画布并用取整坐标重放笔画，
    // 抗锯齿因此可能在一两个像素上不同——实测 1400×900 的画布差 1 个像素、峰值 26。
    // 所以「是否保留笔画」用视觉等价判断，并留一条反向守卫证明容差不是永远通过。
    const inkAndDiff = (leftUrl, rightUrl) => js(`(async () => {
      const load = src => new Promise((done, fail) => { const image = new Image(); image.onload = () => done(image); image.onerror = fail; image.src = src })
      const paint = image => { const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height; canvas.getContext('2d').drawImage(image, 0, 0); return canvas }
      const [left, right] = await Promise.all([load(${JSON.stringify(leftUrl)}), load(${JSON.stringify(rightUrl)})])
      const a = paint(left), b = paint(right)
      if (a.width !== b.width || a.height !== b.height) return { sameSize: false, left: [a.width, a.height], right: [b.width, b.height] }
      const x = a.getContext('2d').getImageData(0, 0, a.width, a.height).data
      const y = b.getContext('2d').getImageData(0, 0, b.width, b.height).data
      let count = 0, peak = 0, ink = 0
      for (let index = 0; index < x.length; index += 4) {
        if (x[index + 3] > 0) ink++
        let delta = 0
        for (let channel = 0; channel < 4; channel++) delta = Math.max(delta, Math.abs(x[index + channel] - y[index + channel]))
        if (delta > 0) { count++; peak = Math.max(peak, delta) }
      }
      return { sameSize: true, size: [a.width, a.height], count, peak, ink, total: a.width * a.height }
    })()`)
    const canvasUrl = () => js("document.querySelector('#mb-handwrite-canvas').toDataURL('image/png')")
    const expectSameDrawing = async (label, reference) => {
      const current = await canvasUrl()
      const stats = await inkAndDiff(reference, current)
      assert.equal(stats.sameSize, true, `${label}：画布尺寸不得变化（${JSON.stringify(stats)}）`)
      assert.ok(stats.ink > 1000, `${label}：画布上必须仍有笔画（墨迹像素 ${stats.ink}）`)
      assert.ok(stats.count / stats.total <= 1e-5 && stats.peak <= 32,
        `${label}：手写笔画被改变（差异像素 ${stats.count}/${stats.total}，峰值 ${stats.peak}）`)
      return current
    }
    const drawing = await canvasUrl()
    const canvasSize = await js("(() => { const canvas = document.querySelector('#mb-handwrite-canvas'); return [canvas.width, canvas.height] })()")
    await fill('[data-mb-field="title"]', `${token}-handwriting`)
    await fill('[data-mb-field="subjectID"]', 'physics', 'change')
    await expectSameDrawing('Changing classification must preserve hand-drawn strokes', drawing)
    await fill('#mb-sort', 'updated', 'change'); await idle()
    await expectSameDrawing('Sorting must preserve hand-drawn strokes', drawing)
    // 反向守卫：把同一张图平移 2 像素必须被判为不同，证明上面的容差不会放过真实改动。
    const shifted = await js(`(async () => {
      const image = new Image(); image.src = ${JSON.stringify(drawing)}
      await image.decode()
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height
      canvas.getContext('2d').drawImage(image, 2, 0)
      return canvas.toDataURL('image/png')
    })()`)
    const shiftedStats = await inkAndDiff(drawing, shifted)
    assert.ok(shiftedStats.count / shiftedStats.total > 1e-5 || shiftedStats.peak > 32,
      `视觉等价的容差不能放过真实改动（平移 2 像素只差 ${shiftedStats.count} 像素）`)
    assert.deepEqual((await inkAndDiff(drawing, await canvasUrl())).size, canvasSize)
    const canvasAtSave = await expectSameDrawing('保存前', drawing)
    await click('#mb-save'); await idle()
    const handwriting = (await notebook('list', { type: 'note' })).records.find(row => row.title === `${token}-handwriting`)
    assert.ok(handwriting, 'Directly saving a hand-drawn note must create a record')
    notebookIds.push(handwriting.id)
    const written = await notebook('read', { id: handwriting.id })
    assert.equal(written.images.length, 1, 'Direct save must include the uncommitted handwriting page once')
    assert.equal(written.images[0].data, canvasAtSave.split(',')[1], '保存的必须是用户看到的那一页（且它与原始笔画视觉等价）')
    assert.match(await js("document.querySelector('#mb-save-state').textContent"), /已保存/)

    // Search cannot leave invisible notes selected for a destructive batch action.
    const noteA = await notebook('save', { type: 'note', title: `${token}-note-A`, stem: `${token}-note-A content` })
    const noteB = await notebook('save', { type: 'note', title: `${token}-note-B`, stem: `${token}-note-B content` })
    notebookIds.push(noteA.id, noteB.id)
    await click('[data-mb-view="all"]'); await idle()
    await click('#mb-pick'); await idle()
    await click(`[data-question-id="${noteA.id}"]`); await idle()
    assert.match(await js("document.querySelector('#mb-pick-bar strong').textContent"), /1/)
    await fill('#mb-query', `${token}-note-B`)
    await until(`document.querySelectorAll('#mb-list [data-question-id]').length === 1 && document.querySelector('#mb-list [data-question-id]').dataset.questionId === ${JSON.stringify(noteB.id)}`)
    await idle()
    assert.equal(await js("document.querySelector('#mb-pick-bar strong').textContent"), '已选 0 篇')
    assert.equal(await js("document.querySelector('#mb-batch-delete').disabled"), true)
    await click(`[data-question-id="${noteB.id}"]`); await idle()
    await click('#mb-batch-delete'); await idle()
    assert.equal((await notebook('read', { id: noteA.id })).isSoftDeleted, false, 'A hidden previous selection must remain intact')
    assert.equal((await notebook('read', { id: noteB.id })).isSoftDeleted, true)

    // Memory search has an explicit decision point when the open editor contains a draft.
    await click('#mb-mode-switch')
    await until("document.body.dataset.mode === 'memory'")
    const memoryA = (await memory('entry.write', { group: '知识库', title: `${token}-memory-A`, content: 'Saved memory A content' })).entry
    const memoryB = (await memory('entry.write', { group: '知识库', title: `${token}-memory-B`, content: 'Saved memory B content' })).entry
    memoryIds.push(memoryA.id, memoryB.id)
    await searchMemory(`${token}-memory-A`)
    await click(`[data-id="${memoryA.id}"]`)
    await until("document.querySelector('[data-field=\"content\"]') !== null")
    await until("document.querySelector('#editor-images .image-attachments') !== null")
    await fill('[data-field="content"]', 'Unsaved memory A content')
    await until("document.querySelector('#save-entry').disabled === false")
    await fill('#query', `${token}-memory-B`)
    await pause(300)
    assert.equal(await js("document.querySelector('#unsaved-changes[open]') === null"), true, 'Typing a query must not interrupt editing with a dialog')
    await js("document.querySelector('#query').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))")
    await memoryChoice('继续编辑')
    assert.equal(await js("document.querySelector('#query').value"), `${token}-memory-A`)
    assert.equal(await js("document.querySelector('[data-field=\"content\"]').value"), 'Unsaved memory A content')
    assert.equal(await js(`document.querySelector('#list [data-id]').dataset.id === ${JSON.stringify(memoryA.id)}`), true)

    // Abandoning a draft on refresh shows data from storage, never labels the abandoned text saved.
    await click('#refresh')
    await memoryChoice('放弃修改')
    await until("document.querySelector('#drawer').classList.contains('hidden')")
    await until("document.querySelector('#status').textContent === '已刷新'")
    assert.equal(bridge.vault.store.requireEntry(memoryA.id).content, 'Saved memory A content')
    await click(`[data-id="${memoryA.id}"]`)
    await until("document.querySelector('[data-field=\"content\"]')?.value === 'Saved memory A content'")
    await until("document.querySelector('#editor-images .image-attachments') !== null")
    assert.match(await js("document.querySelector('#editor-save-state').textContent"), /已保存/)

    // Saving before navigation must persist the current draft before changing the result set.
    await fill('[data-field="content"]', 'Saved before navigating to memory B')
    await until("document.querySelector('#save-entry').disabled === false")
    await fill('#query', `${token}-memory-B`)
    await js("document.querySelector('#query').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))")
    await memoryChoice('保存并继续')
    await until(`document.querySelector('#list [data-id]')?.dataset.id === ${JSON.stringify(memoryB.id)}`)
    assert.equal(bridge.vault.store.requireEntry(memoryA.id).content, 'Saved before navigating to memory B')
    console.log('Desktop UX: handwriting width/preserved drafts/direct save, visible-only batch selection, explicit search/cancel, abandoned-draft refresh, save-before-navigation passed')
  } finally {
    dialog.showMessageBox = confirmOriginal
    // Only records created by this suite are removed; the real profile is rejected at entry.
    for (const id of notebookIds) {
      await notebook('action', { id, action: 'delete' }).catch(() => {})
      await notebook('action', { id, action: 'purge' }).catch(() => {})
    }
    for (const id of memoryIds) await bridge.invoke('entry.delete', { id }).catch(() => {})
  }
}
