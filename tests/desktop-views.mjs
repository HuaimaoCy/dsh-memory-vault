/**
 * 可保存视图的真实界面测试（Electron 主进程里跑，操作真实渲染器）。
 *
 * 不是静态 mock：真的写库、真的点侧栏与工具栏、真的在视图设置弹层里改筛选，
 * 再回读 DOM、localStorage 与 SQLite，确认「新建视图 → 切看板 → 列数/分组正确 →
 * 筛选生效 → 切表格 → 重载后视图仍在 → 删除视图 → 恢复默认」整条链路成立。
 *
 * 另外三条硬约束在这里当断言用：
 *   · 视图偏好只落 localStorage（alaya.db.views），不碰数据库 meta 表；
 *   · 渲染层不出现 innerHTML、也没有任何网络请求；
 *   · views.css 里有 prefers-reduced-motion 兜底。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { dialog } from 'electron'

const here = dirname(fileURLToPath(import.meta.url))

/** 读渲染层源码做静态契约检查：这些是「不许回退」的底线。 */
function auditRenderer() {
  const renderer = join(here, '..', 'desktop', 'renderer')
  const app = readFileSync(join(renderer, 'app.js'), 'utf8')
  const views = readFileSync(join(renderer, 'views.js'), 'utf8')
  const css = readFileSync(join(renderer, 'views.css'), 'utf8')
  const html = readFileSync(join(renderer, 'index.html'), 'utf8')
  for (const [name, source] of [['app.js', app], ['views.js', views]]) {
    assert.equal(/\.innerHTML\s*=/.test(source), false, `${name} 不许用 innerHTML 拼文本`)
    assert.equal(/\b(fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/.test(source), false, `${name} 不许发网络请求`)
  }
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/, 'views.css 必须尊重减少动态效果')
  assert.match(html, /href="views\.css"/, 'index.html 必须引入 views.css')
  assert.match(html, /id="saved-views"/, '侧栏必须有「视图」区块')
  assert.match(html, /id="view-table"/, '工具栏必须有表格形状')
  assert.match(html, /id="view-board"/, '工具栏必须有看板形状')
  // 「资料库」那 4 个入口的 DOM 契约被其它套件依赖，不能被视图区块挤掉。
  assert.match(html, /<nav id="views" class="views" aria-label="记忆视图"><\/nav>/, '#views 必须保持空容器，由 app.js 填 4 条')
  for (const id of ['view-grid', 'view-list']) assert.match(html, new RegExp(`id="${id}"`), `${id} 不能改名（既有套件按 id 点击）`)
}

export async function run(window, bridge) {
  assert.match(bridge.databasePath, /views-test[^\\/]*\.sqlite$/, '这个套件只允许跑在临时库里')
  const profileArg = process.argv.indexOf('--user-data')
  assert.ok(profileArg >= 0, '必须显式给隔离的 --user-data 目录')
  const profile = resolve(process.argv[profileArg + 1])
  assert.match(profile.replace(/\\/g, '/'), /\/work\//i, 'profile 必须落在 test-tmp/work 下')

  const js = async source => {
    try { return await window.webContents.executeJavaScript(source) } catch (error) { throw new Error(`注入脚本失败：${error?.message ?? error}\n${source}`) }
  }
  const pause = ms => new Promise(resolvePause => setTimeout(resolvePause, ms))
  const until = async (expression, label = expression) => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (await js(expression)) return
      await pause(25)
    }
    throw new Error(`界面超时：${label}；status=${await js("document.querySelector('#status')?.textContent")}`)
  }
  const click = selector => js(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) throw new Error('找不到元素：' + ${JSON.stringify(selector)}); node.click(); return true })()`)
  const text = selector => js(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`)
  const count = selector => js(`document.querySelectorAll(${JSON.stringify(selector)}).length`)
  const stored = () => js("JSON.parse(localStorage.getItem('alaya.db.views') || 'null')")
  const idle = () => until("!document.querySelector('#alaya-startup') && document.querySelectorAll('#views button').length===4", '外壳就绪')
  const memoryMode = async () => {
    if (await js("document.body.dataset.mode === 'memory'")) return
    await click('#mb-mode-switch')
    await until("document.body.dataset.mode === 'memory'", '回到记忆模式')
  }
  const setControl = (selector, value, eventName = 'change') => js(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) throw new Error('找不到控件：' + ${JSON.stringify(selector)}); node.value = ${JSON.stringify(value)}; node.dispatchEvent(new Event(${JSON.stringify(eventName)}, { bubbles: true })); return true })()`)
  const toggleKind = kind => js(`(() => { const box = document.querySelector('[data-kind="' + ${JSON.stringify(kind)} + '"]'); if (!box) throw new Error('找不到类型筛选'); box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
  const closeDialog = async () => { await js("document.querySelector('#modal')?.close()"); await until("document.querySelector('#modal') === null", '关闭弹层') }
  // --shots <目录>：把关键画面截成 png 供人工验收；默认不产文件，断言也不依赖它。
  // offscreen 窗口必须先 invalidate() 再等一次 paint，否则 capturePage 拿到的是旧帧。
  const shotIndex = process.argv.indexOf('--shots')
  const shotDirectory = shotIndex > 0 && process.argv[shotIndex + 1] ? resolve(process.argv[shotIndex + 1]) : null
  const shot = async name => {
    if (!shotDirectory) return
    mkdirSync(shotDirectory, { recursive: true })
    // offscreen 窗口：先 invalidate 等一次 paint，再连拍两帧（第一帧丢弃）——
    // 单次 capturePage 有时拿到的还是上一帧，会截到改动前的界面。
    const painted = new Promise((resolvePaint, rejectPaint) => {
      const timer = setTimeout(() => rejectPaint(new Error('截图前没有 paint 帧')), 5000)
      window.webContents.once('paint', () => { clearTimeout(timer); resolvePaint() })
    })
    window.webContents.invalidate()
    await painted
    await pause(200)
    await window.webContents.capturePage()
    await pause(140)
    writeFileSync(join(shotDirectory, `${name}.png`), (await window.webContents.capturePage()).toPNG())
  }

  auditRenderer()

  // 破坏性确认一律选「确认」；跑完恢复原生实现，避免影响同进程里的其它检查。
  const originalConfirm = dialog.showMessageBox
  dialog.showMessageBox = async () => ({ response: 1 })
  const token = `views-${Date.now()}`
  let group
  try {
    await idle()
    await memoryMode()

    // ---------- 夹具：四个不同类型/标签的记忆落在同一个记忆组里 ----------
    group = (await bridge.invoke('group.create', { name: token, scope: 'knowledge' })).group
    const fixtures = [
      { title: `${token} 甲 笔记`, content: '视图测试用的笔记正文。', kind: 'note', tags: ['设计'] },
      { title: `${token} 乙 事实`, content: '视图测试用的接口约定。', kind: 'fact', tags: ['接口'] },
      { title: `${token} 丙 决策`, content: '视图测试用的决策记录。', kind: 'decision', tags: ['设计'] },
      { title: `${token} 丁 任务`, content: '视图测试用的待办任务。', kind: 'task', tags: [] },
    ]
    for (const fixture of fixtures) await bridge.invoke('entry.write', { group: group.name, ...fixture, priority: 60 })
    await click('#refresh')
    await until(`document.querySelectorAll('#list [data-id]').length >= 4`, '记忆加载完成')

    // 走进这个记忆组（侧栏记忆组树），此时是「临时视图」：还没有存进视图列表。
    await js(`(() => { const node = [...document.querySelectorAll('#tree button')].find(button => button.textContent.includes(${JSON.stringify(token)})); if (!node) throw new Error('记忆组未出现在侧栏'); node.click(); return true })()`)
    await until(`document.querySelector('#view-title').textContent === ${JSON.stringify(group.name)}`, '进入记忆组')
    assert.equal(await js("document.querySelectorAll('#saved-views .saved-view').length"), 4, '默认就有四个内置视图')
    assert.equal(await js("Boolean(document.querySelector('#saved-views .saved-view.on'))"), false, '临时视图不对应任何已保存视图')
    await shot('01-记忆组-卡片')

    // ---------- 新建视图 ----------
    await click('#new-view')
    await until("document.querySelector('#modal')?.open === true", '视图设置弹层')
    await until("document.querySelector('#view-name') !== null", '名称输入框存在')
    await setControl('#view-shape', 'board')
    await setControl('#view-group-by', 'kind')
    await setControl('#view-sort', 'title')
    await js(`(() => { const node = document.querySelector('#view-name'); node.value = ${JSON.stringify(`${token} 看板`)}; node.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
    await closeDialog()
    await until(`document.querySelectorAll('#saved-views .saved-view').length === 5`, '新视图出现在侧栏')
    assert.equal(await text('#view-title'), `${token} 看板`, '标题跟着视图名走')
    assert.equal(await js("document.querySelector('#saved-views .saved-view.on')?.textContent.includes('看板')"), true, '当前视图高亮')

    // ---------- 看板：列数与分组正确 ----------
    await until("document.querySelector('#list').dataset.shape === 'board'", '切到看板')
    assert.equal(await count('#list .board-col'), 4, '四种类型 = 四列')
    assert.deepEqual(
      await js("[...document.querySelectorAll('#list .board-col-head .board-col-label')].map(node => node.textContent)"),
      ['笔记', '事实', '决策', '任务'], '列顺序按类型固定，不随数据顺序漂移')
    assert.equal(await count('#list .board-card'), 4, '四张卡片')
    assert.equal(await js("[...document.querySelectorAll('#list .board-card')].every(node => Boolean(node.dataset.id))"), true, '卡片带 data-id')
    await js("document.querySelector('#status').classList.remove('show')")
    await shot('02-看板-按类型分列')
    // 列可横向滚动的容器存在（CSS 层面按 flex 排布），卡片点击进入编辑抽屉。
    await click('#list .board-card')
    await until("document.querySelector('#drawer').classList.contains('hidden') === false", '看板卡片可点开编辑')
    await js("document.querySelector('#drawer [aria-label=\"关闭记忆详情\"]').click()")
    await until("document.querySelector('#drawer').classList.contains('hidden')", '关闭抽屉')

    // ---------- 筛选真的生效 ----------
    await click('#view-settings')
    await until("document.querySelector('#modal')?.open === true", '再次打开视图设置')
    await toggleKind('fact')
    await until("document.querySelectorAll('#list .board-col').length === 1", '筛选后只剩一列')
    assert.equal(await text('#list .board-col-label'), '事实', '只留下被筛选的类型')
    assert.equal(await count('#list .board-card'), 1, '只剩一条卡片')
    assert.equal(await js("document.querySelector('#filter-count').textContent"), '1', '工具栏显示生效中的筛选条数')
    await shot('03-视图设置-筛选生效')
    // 再叠一条「只看有图片」：这批夹具没有图片，于是筛选把结果清空了。
    await js("(() => { const box = document.querySelector('#view-only-images'); box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true })); return true })()")
    await until("document.querySelector('#list .filter-empty') !== null", '筛选空态出现')
    assert.match(await text('#list .filter-empty h2'), /当前筛选没有结果/, '空态必须说明是筛选造成的')
    assert.match(await text('#list .filter-empty p'), /筛选条件把所有记忆都排除了/, '空态要说清楚原因')
    assert.equal(await js("Boolean(document.querySelector('#list .filter-empty button'))"), true, '空态给一键清除')
    await closeDialog()
    await shot('04-筛选空态')
    await click('#list .filter-empty button')
    await until("document.querySelectorAll('#list .board-card').length === 4", '一键清除筛选后恢复')

    // ---------- 切表格：紧凑多列 ----------
    await click('#view-table')
    await until("document.querySelector('#list .view-table') !== null", '切到表格')
    assert.equal(await js("document.querySelector('#list').dataset.shape"), 'table')
    assert.deepEqual(
      await js("[...document.querySelectorAll('#list .view-table thead th')].map(node => node.textContent)"),
      ['标题', '归属', '类型', '记忆组', '优先级', '更新时间'], '表格六列必须齐全')
    assert.equal(await count('#list .view-table tbody tr[data-id]'), 4, '表格四行')
    assert.ok((await count('#list .view-table tbody tr.view-table-group')) >= 4, '表格按类型分组，组标题行存在')
    await shot('05-表格-六列')
    // 键盘可达：行可聚焦，Enter 打开编辑抽屉。
    await js("document.querySelector('#list .view-table tbody tr[data-id]').focus()")
    assert.equal(await js("document.activeElement.matches('#list .view-table tbody tr[data-id]')"), true, '表格行可键盘聚焦')
    await js("document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))")
    await until("document.querySelector('#drawer').classList.contains('hidden') === false", 'Enter 打开编辑')
    await js("document.querySelector('#drawer [aria-label=\"关闭记忆详情\"]').click()")
    await until("document.querySelector('#drawer').classList.contains('hidden')", '关闭抽屉')

    // ---------- 偏好只落 localStorage，形状与分组都记进视图 ----------
    const saved = await stored()
    assert.equal(saved.schema, 1, '存储带 schema')
    assert.equal(saved.views.length, 5, '五个视图（4 内置 + 1 新建）')
    const mine = saved.views.find(view => view.name === `${token} 看板`)
    assert.ok(mine, '新视图写进了 alaya.db.views')
    assert.deepEqual(Object.keys(mine), ['id', 'name', 'source', 'shape', 'sort', 'groupBy', 'filters'], '视图字段就是模型契约')
    assert.equal(mine.shape, 'table', '最后一次切的形状被记住')
    assert.equal(mine.groupBy, 'kind')
    assert.equal(mine.sort, 'title')
    assert.deepEqual(mine.filters, { kinds: [], tags: [], onlyBase: false, onlyWithImages: false }, '清除筛选后条件归零')
    assert.equal(saved.activeId, mine.id, '当前视图被记住')
    // 数据库 meta 表里不能出现视图偏好（UI 偏好污染记忆域是硬错误）。
    const raw = new DatabaseSync(bridge.databasePath, { readOnly: true })
    try {
      const rows = raw.prepare('SELECT key, value FROM meta').all()
      const dump = JSON.stringify(rows)
      assert.equal(dump.includes('alaya.db.views'), false, '视图键名不许写进 meta 表')
      assert.equal(dump.includes(token), false, '视图名不许写进 meta 表')
      assert.equal(dump.includes('groupBy'), false, '视图配置不许写进 meta 表')
    } finally { raw.close() }

    // ---------- 重载窗口：视图还在，形状还在 ----------
    window.webContents.reload()
    await idle()
    await memoryMode()
    await until(`document.querySelectorAll('#saved-views .saved-view').length === 5`, '重载后视图仍在')
    assert.equal(await js("document.querySelector('#saved-views .saved-view.on')?.textContent.includes('看板')"), true, '重载后仍停在同一个视图')
    assert.equal(await js("document.querySelector('#list').dataset.shape"), 'table', '重载后形状还是表格')
    assert.equal(await text('#view-title'), `${token} 看板`, '重载后视图名还在')
    assert.equal(await js("document.querySelector('#sort').value"), 'title', '重载后排序档位还在')
    assert.equal(await count('#list .view-table tbody tr[data-id]'), 4, '重载后表格内容还在')

    // ---------- 删除视图 ----------
    await click('#view-settings')
    await until("document.querySelector('#modal')?.open === true", '打开视图设置')
    await js("[...document.querySelectorAll('#modal button')].find(node => node.textContent.trim() === '删除视图').click()")
    await until("document.querySelector('#modal') === null", '删除后弹层关闭')
    await until(`document.querySelectorAll('#saved-views .saved-view').length === 4`, '视图从侧栏移除')
    const afterDelete = await stored()
    assert.equal(afterDelete.views.some(view => view.name === `${token} 看板`), false, '删除后存储里也没有了')
    assert.equal(await js("document.querySelectorAll('#list [data-id]').length"), 4, '删除视图不影响记忆本身')

    // ---------- 恢复默认 ----------
    await click('#view-settings')
    await until("document.querySelector('#modal')?.open === true", '打开视图设置')
    await js("[...document.querySelectorAll('#modal button')].find(node => node.textContent.trim() === '恢复默认视图').click()")
    await until("document.querySelector('#modal') === null", '恢复默认后弹层关闭')
    const restored = await stored()
    assert.deepEqual(restored.views.map(view => view.id), ['default-all', 'default-knowledge', 'default-conversation', 'default-hidden'], '恢复默认后回到四个内置视图')
    assert.deepEqual(restored.views.map(view => view.name), ['全部记忆', '知识库', '对话记忆', '隐藏'])
    assert.equal(await count('#saved-views .saved-view'), 4, '侧栏同步')
    assert.equal(await js("document.querySelectorAll('#saved-views .saved-view-dot').length"), 4, '内置视图带标识')

    // ---------- 迁移：0.7.15 的 memory-vault.layout ----------
    await js("localStorage.setItem('memory-vault.layout', 'rows'); localStorage.removeItem('alaya.db.views')")
    window.webContents.reload()
    await idle()
    await memoryMode()
    await until("document.querySelector('#list').classList.contains('rows') === true", '旧 rows 档位迁进新系统')
    const migrated = await stored()
    assert.deepEqual(migrated.views.map(view => view.shape), ['rows', 'rows', 'rows', 'rows'], '旧档位整体搬进四个内置视图')
    assert.equal(migrated.views.length, 4)
    // 迁移后旧键被清掉，用户下次改形状不会被旧值盖回去。
    assert.equal(await js("localStorage.getItem('memory-vault.layout')"), null, '迁移完成后清掉旧键')
    await click('#view-grid')
    await until("document.querySelector('#list').dataset.shape === 'grid'", '切回卡片')
    const afterGrid = await stored()
    assert.equal(afterGrid.views[0].shape, 'grid', '切形状会写回存储')
    window.webContents.reload()
    await idle()
    await memoryMode()
    await until("document.querySelector('#list').dataset.shape === 'grid'", '改过的形状不会被旧键盖回去')

    // ---------- 可访问性：控件的 ARIA 契约 ----------
    assert.equal(await js("[...document.querySelectorAll('.segmented .segment')].every(node => node.tagName === 'BUTTON' && node.hasAttribute('aria-pressed') && node.getAttribute('aria-label'))"), true, '四个形状按钮都是带 aria 的 button')
    assert.equal(await count('.segmented .segment'), 4, '四个形状按钮')
    assert.equal(await js("[...document.querySelectorAll('#saved-views .saved-view')].every(node => node.tagName === 'BUTTON' && node.hasAttribute('aria-current'))"), true, '视图列表项可键盘操作且有 aria-current')
    assert.equal(await js("document.querySelector('#new-view').getAttribute('aria-label')"), '新建视图')
    assert.equal(await js("document.querySelector('#view-settings').getAttribute('aria-haspopup')"), 'dialog')
    assert.equal(await js("[...document.styleSheets].some(sheet => (sheet.href || '').endsWith('views.css'))"), true, 'views.css 真的加载了')
    await shot('06-最终-卡片与视图区块')

    console.log('Desktop views: 新建视图 → 看板列数与分组 → 筛选生效与空态清除 → 表格六列与键盘 → localStorage 持久化与重载 → 删除 → 恢复默认 → 旧档位迁移 → ARIA/静态契约 全部通过')
  } finally {
    dialog.showMessageBox = originalConfirm
    await js("document.querySelectorAll('dialog[open]').forEach(node => node.close())").catch(() => {})
    if (group) await bridge.invoke('group.delete', { id: group.id }).catch(() => {})
  }
}
