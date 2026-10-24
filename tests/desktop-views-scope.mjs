/**
 * 真实窗口验证「筛选只作用于已加载的一页」这条边界：
 * 库里 206 条，首屏只拉 200 条，筛选条件只匹配第 206 条。
 * 期望：提示条出现并说明匹配 0 条；目标不在首屏；点「加载更多」后目标出现、提示消失。
 * 同时也验证没有筛选时不出现这条提示（避免把「还能加载更多」说成筛选限制）。
 */
import assert from 'node:assert/strict'

export async function run(window, bridge) {
  assert.match(bridge.databasePath, /views-scope-test[^\\/]*\.sqlite$/i, '必须跑在 views-scope-test 临时库上')

  const js = source => window.webContents.executeJavaScript(source)
  const sleep = ms => new Promise(done => setTimeout(done, ms))
  const until = async (expression, label = expression) => {
    for (let attempt = 0; attempt < 800; attempt++) { if (await js(expression)) return; await sleep(25) }
    throw new Error(`界面超时：${label}`)
  }
  const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const token = `scope-${Date.now()}`
  const targetTitle = `${token}-needle`

  const reload = async () => {
    const loaded = new Promise(done => window.webContents.once('did-finish-load', done))
    window.webContents.reload()
    await loaded
  }
  const toMemoryMode = async () => {
    for (let attempt = 0; attempt < 80; attempt++) {
      if (await js(`document.body.dataset.mode !== 'mistakebook'`)) return
      await js(`(() => { const back = document.getElementById('mb-mode-switch'); (back ?? document.getElementById('mode-switch')).click(); return true })()`)
      await sleep(250)
    }
    throw new Error('无法回到数据库界面')
  }
  const setViewFilters = async tags => {
    await js(`(() => {
      const key = 'alaya.db.views'
      const raw = JSON.parse(localStorage.getItem(key))
      const view = raw.views.find(row => row.id === raw.activeId) ?? raw.views[0]
      view.filters = { kinds: [], tags: ${JSON.stringify(tags)}, onlyBase: false, onlyWithImages: false }
      localStorage.setItem(key, JSON.stringify(raw))
      localStorage.setItem('alaya.mode', 'memory')
      return true
    })()`)
    await reload()
    await until(`!document.getElementById('alaya-startup')`, '重载后启动完成')
    await toMemoryMode()
    await until(`document.querySelectorAll('#list .tile, #list .empty, #list .filter-empty, .view-board, .view-table-wrap').length > 0`, '列表渲染完成')
  }

  // 0) 等启动，切到数据库界面。
  await until(`!document.getElementById('alaya-startup')`, '启动完成')
  await sleep(300)
  await toMemoryMode()

  // 1) 造 206 条：205 条 bulk（高优先级）+ 1 条 needle（最低优先级，必然排在最后）。
  const seeded = await js(`(async () => {
    const write = async body => {
      const reply = await window.vault.invoke('entry.write', body)
      if (reply?.ok !== true) throw new Error(reply?.error ?? 'entry.write 失败')
      return reply.result.entry
    }
    for (let index = 0; index < 205; index++) {
      await write({ group: '知识库', title: '${token}-bulk-' + index, content: '批量条目 ' + index, kind: 'note', tags: ['bulk'], priority: 80 })
    }
    const needle = await write({ group: '知识库', title: ${JSON.stringify(targetTitle)}, content: '只有这条会被筛选命中', kind: 'note', tags: ['needle'], priority: 1 })
    return { needleId: needle.id, needleTitle: needle.title }
  })()`)
  assert.ok(seeded.needleId, '目标条目应写入成功')

  // 2) 打开「只看 needle」的筛选，重新载入：首屏 200 条里不应有目标。
  await setViewFilters(['needle'])
  const loadedCount = await js(`document.querySelectorAll('#list [data-id]').length`)
  assert.equal(loadedCount, 0, '首屏 200 条里不应出现目标条目')
  assert.equal(await js(`document.querySelector('#filter-scope') !== null`), true, '有筛选且还有未加载结果时必须给出边界提示')
  const notice = await js(`document.querySelector('#filter-scope').textContent`)
  assert.match(notice, /已加载的 200 条/, `提示必须写明已加载条数：${notice}`)
  assert.match(notice, /匹配 0 条/, `提示必须写明本次匹配条数：${notice}`)
  const emptyTitle = await js(`document.querySelector('.filter-empty h2')?.textContent ?? ''`)
  assert.equal(emptyTitle, '已加载的结果里没有匹配', '空态要说明是「已加载的结果」里没有，而不是整库没有')

  // 3) 加载更多 → 目标出现，提示消失。
  await click('#filter-scope-more')
  await until(`document.querySelector('#list [data-id="${seeded.needleId}"]') !== null`, '加载更多后应出现目标条目')
  await until(`document.querySelector('#filter-scope') === null`, '全部加载完后边界提示应消失')
  assert.equal(await js(`document.querySelectorAll('#list [data-id]').length`), 1, '筛选后只剩这一条')

  // 4) 没有筛选时不应出现边界提示（那是「还能加载更多」，不是筛选限制）。
  await setViewFilters([])
  assert.equal(await js(`document.querySelector('#filter-scope') === null`), true, '没有筛选时不应出现边界提示')
  assert.ok(await js(`document.querySelectorAll('#list [data-id]').length`) >= 200, '无筛选时应回到正常分页列表')

  console.log('Desktop views scope: 206 rows, filter matching only the unloaded tail, boundary notice, load-more recovery and no notice without filters passed')
}
