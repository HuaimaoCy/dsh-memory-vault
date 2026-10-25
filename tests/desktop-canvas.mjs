/**
 * 自由画布的真实界面冒烟测试（Electron 主进程里跑，操作真实渲染器）。
 *
 * 不是静态 mock：在这个窗口里真的点按钮、真的发 pointer / wheel / keyboard
 * 事件，再回读 DOM 与 SQLite，确认「拖动 1:1 跟手、指针中心缩放不漂移、
 * 选中删除与撤销重做、回到内容、回到笔记、关掉再打开状态还在、存库在
 * 笔记本域而不是记忆域、保存失败可见」。
 */
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { dialog, ipcMain } from 'electron'
import { MistakebookStore } from '../addons/mistakebook/store.mjs'

export async function run(window, bridge) {
  assert.match(bridge.databasePath, /canvas-test[^\\/]*\.sqlite$/)
  const js = async source => {
    try { return await window.webContents.executeJavaScript(source) } catch (error) { throw new Error(`注入脚本失败：${error?.message ?? error}\n${source}`) }
  }
  const pause = ms => new Promise(resolvePause => setTimeout(resolvePause, ms))
  // 直接经同一个数据库连接读写笔记本域，用来注入坏画布/超限画布并做读库前后对比。
  const sharedDb = bridge.vault.store.db
  const canvasValue = () => sharedDb.prepare("SELECT value FROM notebook_meta WHERE key='canvas'").get()?.value ?? null
  const writeCanvasValue = value => { sharedDb.prepare("UPDATE notebook_meta SET value=? WHERE key='canvas'").run(value) }
  // 仅供「保存竞态」用的可控延迟通道：延迟 260ms 再落库。
  const canvasStore = new MistakebookStore({ database: sharedDb })
  // --shot：把界面截图落在指定目录，供人工验收；默认不产文件。
  const shotIndex = process.argv.indexOf('--shot')
  const shotDirectory = shotIndex > 0 && process.argv[shotIndex + 1] ? dirname(resolve(process.argv[shotIndex + 1])) : null
  const shot = async name => {
    if (!shotDirectory) return
    await new Promise(resolve => setTimeout(resolve, 120))
    writeFileSync(join(shotDirectory, `${name}.png`), (await window.webContents.capturePage()).toPNG())
  }
  const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const openLayout=async()=>{await click('#mb-workspace-settings');await until(`Boolean(document.querySelector('.mb-dialog[open] [data-tab="layout"]'))`);await click('.mb-dialog [data-tab="layout"]');await pause(80)}
  const closeLayout=()=>js(`document.querySelector('.mb-dialog[open]')?.close()`)
  const until = async (expression, label = expression) => {
    for (let index = 0; index < 500; index++) {
      if (await js(expression)) return
      await new Promise(resolve => setTimeout(resolve, 30))
    }
    throw new Error(`UI 超时：${label}；status=${await js("document.querySelector('#mb-status')?.textContent")}`)
  }
  const idle = () => until("!document.querySelector('.mb-shell')?.hasAttribute('aria-busy')", '笔记本空闲')
  const api = (action, body = {}) => js(`window.vault.notebook(${JSON.stringify(action)},${JSON.stringify(body)})`)
  const cards = "document.querySelectorAll('[data-card-id]').length"
  const cardBox = selector => js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});const r=n.getBoundingClientRect();return { x:r.left, y:r.top, w:r.width, h:r.height, cx:r.left+r.width/2, cy:r.top+r.height/2 }})()`)
  const keydown = (key, extra = {}) => js(`document.getElementById('mb-canvas-surface').dispatchEvent(new KeyboardEvent('keydown', { key:${JSON.stringify(key)}, bubbles:true, cancelable:true, ${Object.entries(extra).map(([name, value]) => `${name}:${JSON.stringify(value)}`).join(', ')} }))`)

  // 破坏性操作确认：本测试一律选择「确认」；跑完恢复原生确认，避免影响同进程里的其它检查。
  const originalConfirm = dialog.showMessageBox
  dialog.showMessageBox = async () => ({ response: 1 })
  try {
    await until("document.querySelectorAll('#views button').length===4", '笔记本外壳就绪')
    await until("document.querySelector('#alaya-startup')===null", '启动动画结束')
    await until("document.body.dataset.mode==='mistakebook'", '进入笔记本')
    await idle()

    // 造一条笔记，稍后作为画布上的「笔记引用卡片」。
    const created = await api('save', { type: 'note', title: '画布引用的笔记', stem: '把受力分析画成一张图，标注方向与大小。' })
    assert.equal(created.ok, true, `创建笔记失败：${created.error}`)

    // —— 入口：工具栏与侧边栏都能打开画布 ——
    assert.ok(await js("Boolean(document.querySelector('#mb-canvas-button'))"), '工具栏应有画布入口')
    assert.ok(await js("Boolean(document.querySelector('#mb-open-canvas'))"), '侧边栏应有画布入口')
    await click('#mb-canvas-button')
    await until("document.querySelector('#mb-canvas') && document.querySelector('#mb-canvas').hidden===false", '画布打开')
    await idle()

    // 样式真的加载了（@import 引入的 freeform-canvas.css），浮层遮住了笔记本主体。
    const surfaceStyle = await js("(()=>{const s=getComputedStyle(document.getElementById('mb-canvas-surface'));return { position:s.position, cursor:s.cursor, background:s.backgroundImage }})()")
    assert.equal(surfaceStyle.position, 'absolute', '画布表面应铺满工作区')
    assert.equal(surfaceStyle.cursor, 'grab', '空白处可拖动平移')
    assert.match(surfaceStyle.background, /radial-gradient/, '点阵背景来自 freeform-canvas.css')
    assert.equal(await js("getComputedStyle(document.querySelector('.mb-bar')).display"), 'none', '画布模式隐藏笔记工具栏')
    await until("document.querySelector('#mb-canvas-surface').getBoundingClientRect().width>300", '画布尺寸可用')

    // 首次打开自动建一张空白画布。
    await until("document.querySelectorAll('#mb-canvas-picker option').length===1", '默认画布')
    assert.equal(await js("document.querySelector('#mb-canvas-hint')?.hidden"), true, '空画布保持空白，工具集中在底部')

    // —— 文本卡片 ——
    await click('#mb-canvas-text')
    await until(`${cards}===1`, '新增文本卡片')
    assert.equal(await js("document.querySelector('[data-card-id]').dataset.kind"), 'text')
    const textCard = await js("document.querySelector('[data-card-id]').dataset.cardId")
    await js(`(()=>{const n=document.querySelector('[data-card-id] textarea');n.value='画布上的第一段文字';n.dispatchEvent(new Event('input',{bubbles:true}));n.blur()})()`)
    await until("document.querySelector('#mb-canvas-save-state').textContent==='已保存'", '文字已落库')
    assert.equal(await js("document.querySelector('#mb-canvas').hidden"), false)

    // —— 拖动：1:1 跟手（世界坐标，缩放 100% 时屏幕位移等于世界位移）——
    const beforeDrag = await cardBox('[data-card-id] .mb-canvas-card-head')
    await js(`(()=>{
      const head=document.querySelector('[data-card-id] .mb-canvas-card-head');
      const surface=document.getElementById('mb-canvas-surface');
      const rect=head.getBoundingClientRect();
      const opts=(x,y)=>({bubbles:true,cancelable:true,clientX:x,clientY:y,pointerId:11,pointerType:'mouse',button:0,buttons:1,isPrimary:true});
      head.dispatchEvent(new PointerEvent('pointerdown',opts(rect.left+8,rect.top+8)));
      surface.dispatchEvent(new PointerEvent('pointermove',opts(rect.left+108,rect.top+68)));
      surface.dispatchEvent(new PointerEvent('pointerup',opts(rect.left+108,rect.top+68)));
    })()`)
    const afterDrag = await cardBox('[data-card-id] .mb-canvas-card-head')
    assert.ok(Math.abs(afterDrag.x - beforeDrag.x - 100) < 3, `拖动应 1:1 跟手：x ${beforeDrag.x} → ${afterDrag.x}`)
    assert.ok(Math.abs(afterDrag.y - beforeDrag.y - 60) < 3, `拖动应 1:1 跟手：y ${beforeDrag.y} → ${afterDrag.y}`)
    await until("document.querySelector('#mb-canvas-save-state').textContent==='已保存'", '拖动结果已保存')

    // —— 指针中心缩放：卡片中心在屏幕上的位置不漂移 ——
    const beforeZoom = await cardBox(`[data-card-id="${textCard}"]`)
    await js(`(()=>{
      const s=document.getElementById('mb-canvas-surface');
      const r=s.getBoundingClientRect();
      s.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,clientX:${beforeZoom.cx},clientY:${beforeZoom.cy},deltaY:-200}));
    })()`)
    await until("document.querySelector('#mb-canvas-zoom').textContent!=='100%'", '缩放比例已更新')
    const afterZoom = await cardBox(`[data-card-id="${textCard}"]`)
    assert.ok(Math.abs(afterZoom.cx - beforeZoom.cx) < 3 && Math.abs(afterZoom.cy - beforeZoom.cy) < 3, `缩放应以指针为中心：${JSON.stringify(beforeZoom)} → ${JSON.stringify(afterZoom)}`)
    assert.ok(afterZoom.w > beforeZoom.w, '放大后卡片在屏幕上更大')
    const zoomBefore = parseInt(await js("document.querySelector('#mb-canvas-zoom').textContent"), 10)
    await click('#mb-canvas-zoom-out')
    await until(`parseInt(document.querySelector('#mb-canvas-zoom').textContent,10)<${zoomBefore}`, '缩小按钮生效')

    // —— 选择 / 删除（确认） / 撤销 / 重做 ——
    await js(`(()=>{
      const head=document.querySelector('[data-card-id] .mb-canvas-card-head');
      const surface=document.getElementById('mb-canvas-surface');
      const r=head.getBoundingClientRect();
      const opts=(x,y)=>({bubbles:true,cancelable:true,clientX:x,clientY:y,pointerId:13,pointerType:'mouse',button:0,buttons:1,isPrimary:true});
      head.dispatchEvent(new PointerEvent('pointerdown',opts(r.left+6,r.top+6)));
      surface.dispatchEvent(new PointerEvent('pointerup',opts(r.left+6,r.top+6)));
    })()`)
    await until("document.querySelector('[data-card-id]').classList.contains('selected')", '卡片已被选中')
    await keydown('Delete')
    await until(`${cards}===0`, '删除卡片')
    await keydown('z', { ctrlKey: true })
    await until(`${cards}===1`, '撤销恢复卡片')
    await keydown('z', { ctrlKey: true, shiftKey: true })
    await until(`${cards}===0`, '重做再次删除')
    await keydown('z', { ctrlKey: true })
    await until(`${cards}===1`, '再次撤销')

    // —— 便签 + 换色 ——
    await click('#mb-canvas-sticky')
    await until(`${cards}===2`, '新增便签')
    const stickyId = await js("[...document.querySelectorAll('[data-card-id]')].find(node => node.dataset.kind==='sticky').dataset.cardId")
    const toneBefore = await js(`document.querySelector('[data-card-id="${stickyId}"] .mb-canvas-tone').dataset.tone`)
    await click(`[data-card-id="${stickyId}"] .mb-canvas-tone`)
    const toneAfter = await js(`document.querySelector('[data-card-id="${stickyId}"] .mb-canvas-tone').dataset.tone`)
    assert.notEqual(toneBefore, toneAfter, '便签换色应生效')

    // —— 引用现有笔记 ——
    await click('#mb-canvas-reference')
    await until("document.querySelector('#mb-canvas-note-search')!==null", '引用笔记对话框')
    await until("document.querySelectorAll('[data-note-pick]').length>0", '笔记列表')
    await click('[data-note-pick]')
    await until(`${cards}===3`, '引用卡片已添加')
    assert.equal(await js("[...document.querySelectorAll('[data-card-id]')].filter(node => node.dataset.kind==='reference').length"), 1)
    assert.match(await js("document.querySelector('[data-kind=reference] .mb-canvas-ref-title').textContent"), /画布引用的笔记/)

    // —— 连接两张卡片，再删掉这条连线 ——
    await js(`(()=>{
      const pick=(kind, extra)=>{const head=document.querySelector('[data-card-id][data-kind='+JSON.stringify(kind)+'] .mb-canvas-card-head');const r=head.getBoundingClientRect();for(const type of ['pointerdown','pointerup'])head.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,clientX:r.left+6,clientY:r.top+6,pointerId:15,pointerType:'mouse',button:0,buttons:1,isPrimary:true,...extra}))};
      pick('text'); pick('sticky', { shiftKey:true });
    })()`)
    await until("document.querySelectorAll('[data-card-id].selected').length===2", '选中两张卡片')
    await click('#mb-canvas-link')
    await until("document.querySelectorAll('[data-edge-id]').length===1", '连线已生成')
    await shot('画布-卡片与连线')
    await click('[data-edge-id]')
    await keydown('Delete')
    await until("document.querySelectorAll('[data-edge-id]').length===0", '连线可删除')

    // —— 回到内容 / 重置视口 ——
    await click('#mb-canvas-reset')
    await until("document.querySelector('#mb-canvas-zoom').textContent==='100%'", '重置视口回到 100%')
    // —— 平移（拖动空白处）与「回到内容」——
    const outside = await js(`(()=>{
      const s=document.getElementById('mb-canvas-surface');
      const r=s.getBoundingClientRect();
      const point=(x,y)=>({bubbles:true,cancelable:true,clientX:x,clientY:y,pointerId:21,pointerType:'mouse',button:0,buttons:1,isPrimary:true});
      s.dispatchEvent(new PointerEvent('pointerdown',point(r.left+r.width-40,r.top+r.height-140)));
      s.dispatchEvent(new PointerEvent('pointermove',point(r.left+r.width-40-r.width*2,r.top+r.height-140-r.height*2)));
      s.dispatchEvent(new PointerEvent('pointerup',point(r.left+r.width-40-r.width*2,r.top+r.height-140-r.height*2)));
      const box=s.getBoundingClientRect();
      return [...document.querySelectorAll('[data-card-id]')].some(node=>{const c=node.getBoundingClientRect();return c.right<box.left||c.bottom<box.top||c.left>box.right||c.top>box.bottom});
    })()`)
    assert.equal(outside, true, '拖动空白处应平移画布，卡片会离开视野')
    await click('#mb-canvas-fit')
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(await js(`(()=>{const s=document.getElementById('mb-canvas-surface').getBoundingClientRect();return [...document.querySelectorAll('[data-card-id]')].every(node=>{const r=node.getBoundingClientRect();return r.left>=s.left-1&&r.top>=s.top-1&&r.right<=s.right+1&&r.bottom<=s.bottom+1})})()`), true, '「回到内容」后全部卡片都在视野内')

    // —— 回到笔记，画布落在笔记本域 ——
    await click('#mb-canvas-back')
    await until("document.querySelector('#mb-canvas').hidden===true", '画布已关闭')
    assert.equal(await js("getComputedStyle(document.querySelector('.mb-body')).display"), 'flex', '关闭画布后笔记主体回来')
    const reader = new DatabaseSync(bridge.databasePath, { readOnly: true })
    const stored = reader.prepare("SELECT value FROM notebook_meta WHERE key='canvas'").get()
    const leaked = reader.prepare("SELECT count(*) AS n FROM meta WHERE key='canvas'").get().n
    reader.close()
    assert.ok(stored, '画布文档应在 notebook_meta')
    const document_ = JSON.parse(stored.value)
    assert.equal(document_.canvases.length, 1)
    assert.equal(document_.canvases[0].cards.length, 3)
    assert.equal(document_.canvases[0].cards.filter(card => card.kind === 'reference').length, 1)
    assert.equal(leaked, 0, '画布绝不能写进记忆域的 meta 表')

    // —— 关掉再打开：位置、文字、引用都还在 ——
    const transformBefore = await js("document.querySelector('[data-kind=text]').style.transform")
    await click('#mb-canvas-button')
    await until("document.querySelector('#mb-canvas').hidden===false", '再次打开画布')
    await until(`${cards}===3`, '卡片数量保持')
    assert.equal(await js("document.querySelector('[data-kind=text] textarea').value"), '画布上的第一段文字', '文字已持久化')
    const transformAfter = await js("document.querySelector('[data-kind=text]').style.transform")
    const numbers = value => (value.match(/-?\d+/g) ?? []).map(Number)
    assert.deepEqual(numbers(transformAfter).slice(0, 2), numbers(transformBefore).slice(0, 2), '卡片世界坐标来自数据库而不是重新摆放')

    // —— P1-6 滚轮：文本卡片里的滚动交给 textarea，其余仍然缩放 ——
    const zoomBeforeTextWheel = parseInt(await js("document.querySelector('#mb-canvas-zoom').textContent"), 10)
    const textWheelCanceled = await js(`(() => {
      const node = document.querySelector('[data-kind=text] textarea');
      const r = node.getBoundingClientRect();
      return !node.dispatchEvent(new WheelEvent('wheel', { bubbles:true, cancelable:true, clientX:r.left+10, clientY:r.top+10, deltaY:-240 }));
    })()`)
    assert.equal(textWheelCanceled, false, '文本框内的滚轮不应被画布 preventDefault')
    await pause(120)
    assert.equal(parseInt(await js("document.querySelector('#mb-canvas-zoom').textContent"), 10), zoomBeforeTextWheel, '文本框内滚动不应改变缩放')
    const surfaceWheelCanceled = await js(`(() => {
      const node = document.getElementById('mb-canvas-surface');
      const r = node.getBoundingClientRect();
      return !node.dispatchEvent(new WheelEvent('wheel', { bubbles:true, cancelable:true, clientX:r.left+r.width/2, clientY:r.top+r.height/2, deltaY:-240 }));
    })()`)
    assert.equal(surfaceWheelCanceled, true, '画布空白处的滚轮仍然缩放（preventDefault）')
    await until(`document.querySelector('#mb-canvas-zoom').textContent!==${JSON.stringify(`${zoomBeforeTextWheel}%`)}`, '滚轮缩放生效')

    // —— P1-7 画布打开时笔记本全局快捷键必须静默 ——
    await js("document.dispatchEvent(new KeyboardEvent('keydown', { key:'n', ctrlKey:true, bubbles:true, cancelable:true }))")
    await pause(200)
    assert.equal(await js("document.querySelector('dialog[open]')===null"), true, '画布打开时 Ctrl+N 不得在隐藏的笔记区弹录入框')
    await js("document.dispatchEvent(new KeyboardEvent('keydown', { key:'f', ctrlKey:true, bubbles:true, cancelable:true }))")
    await pause(120)
    assert.equal(await js("document.activeElement?.id!=='mb-query'"), true, '画布打开时 Ctrl+F 不得把焦点移到隐藏搜索框')

    // —— P2-11 指针捕获丢失 / buttons 归零都要停止拖动 ——
    const lostStart = await cardBox('[data-kind=text]')
    await js(`(() => {
      const head = document.querySelector('[data-kind=text] .mb-canvas-card-head');
      const surface = document.getElementById('mb-canvas-surface');
      const r = head.getBoundingClientRect();
      const opts = (x, y) => ({ bubbles:true, cancelable:true, clientX:x, clientY:y, pointerId:31, pointerType:'mouse', button:0, buttons:1, isPrimary:true });
      head.dispatchEvent(new PointerEvent('pointerdown', opts(r.left+8, r.top+8)));
      surface.dispatchEvent(new PointerEvent('pointermove', opts(r.left+58, r.top+8)));
      surface.dispatchEvent(new PointerEvent('lostpointercapture', { bubbles:true, pointerId:31 }));
      surface.dispatchEvent(new PointerEvent('pointermove', opts(r.left+158, r.top+8)));
    })()`)
    const lostAfter = await cardBox('[data-kind=text]')
    assert.ok(Math.abs(lostAfter.x - lostStart.x - 50) < 3, `指针捕获丢失后应停止拖动（预期 +50，实际 ${lostAfter.x - lostStart.x}）`)
    await until("document.querySelector('#mb-canvas-save-state').textContent==='已保存'", '捕获丢失后的位置已保存')
    const buttonsStart = await cardBox('[data-kind=text]')
    await js(`(() => {
      const head = document.querySelector('[data-kind=text] .mb-canvas-card-head');
      const surface = document.getElementById('mb-canvas-surface');
      const r = head.getBoundingClientRect();
      const opts = (x, y, buttons) => ({ bubbles:true, cancelable:true, clientX:x, clientY:y, pointerId:32, pointerType:'mouse', button:0, buttons, isPrimary:true });
      head.dispatchEvent(new PointerEvent('pointerdown', opts(r.left+8, r.top+8, 1)));
      surface.dispatchEvent(new PointerEvent('pointermove', opts(r.left+38, r.top+8, 1)));
      surface.dispatchEvent(new PointerEvent('pointermove', opts(r.left+118, r.top+8, 0)));
      surface.dispatchEvent(new PointerEvent('pointermove', opts(r.left+218, r.top+8, 1)));
    })()`)
    const buttonsAfter = await cardBox('[data-kind=text]')
    assert.ok(Math.abs(buttonsAfter.x - buttonsStart.x - 30) < 3, `鼠标按钮归零时应结束拖动（预期 +30，实际 ${buttonsAfter.x - buttonsStart.x}）`)

    // —— P2-13 Shift 反选后不得顺手把卡片拖走 ——
    await js(`(() => {
      const head = document.querySelector('[data-kind=text] .mb-canvas-card-head');
      const surface = document.getElementById('mb-canvas-surface');
      const r = head.getBoundingClientRect();
      const opts = { bubbles:true, cancelable:true, clientX:r.left+8, clientY:r.top+8, pointerId:33, pointerType:'mouse', button:0, buttons:1, isPrimary:true };
      head.dispatchEvent(new PointerEvent('pointerdown', opts));
      surface.dispatchEvent(new PointerEvent('pointerup', opts));
    })()`)
    await until("document.querySelector('[data-kind=text]').classList.contains('selected')", '先选中文本卡片')
    const shiftStart = await cardBox('[data-kind=text]')
    await js(`(() => {
      const head = document.querySelector('[data-kind=text] .mb-canvas-card-head');
      const surface = document.getElementById('mb-canvas-surface');
      const r = head.getBoundingClientRect();
      const opts = (x, y) => ({ bubbles:true, cancelable:true, clientX:x, clientY:y, pointerId:34, pointerType:'mouse', button:0, buttons:1, isPrimary:true, shiftKey:true });
      head.dispatchEvent(new PointerEvent('pointerdown', opts(r.left+8, r.top+8)));
      surface.dispatchEvent(new PointerEvent('pointermove', opts(r.left+128, r.top+8)));
      surface.dispatchEvent(new PointerEvent('pointerup', opts(r.left+128, r.top+8)));
    })()`)
    await pause(120)
    const shiftAfter = await cardBox('[data-kind=text]')
    assert.ok(Math.abs(shiftAfter.x - shiftStart.x) < 1.5, 'Shift 反选不应移动卡片')
    assert.equal(await js("document.querySelector('[data-kind=text]').classList.contains('selected')"), false, 'Shift 反选应取消选中')
    await until("document.querySelector('#mb-canvas-save-state').textContent==='已保存'", '拖动相关修改已保存')

    // —— P1-8 达到画布上限时给可见提示，而不是未捕获异常 ——
    await click('#mb-canvas-back')
    await until("document.querySelector('#mb-canvas').hidden===true", '关闭画布以测试上限')
    const originalCanvasValue = canvasValue()
    assert.ok(originalCanvasValue, '已有已保存的画布文档')
    const manyCanvases = { version: 1, activeId: 'limit-0', canvases: Array.from({ length: 40 }, (_, index) => ({ id: `limit-${index}`, title: `画布 ${index + 1}`, cards: [], edges: [] })) }
    writeCanvasValue(JSON.stringify(manyCanvases))
    await click('#mb-canvas-button')
    await until("document.querySelector('#mb-canvas').hidden===false", '打开上限画布')
    await until("document.querySelectorAll('#mb-canvas-picker option').length===40", '40 个画布已加载')
    await click('#mb-canvas-new')
    await until("document.querySelector('#mb-canvas-title-input')!==null", '新建画布对话框')
    await js("(() => { const input = document.querySelector('#mb-canvas-title-input'); input.value = '第 41 张'; document.querySelector('#mb-canvas-title-save').click() })()")
    await until("document.querySelector('#mb-status').textContent.includes('最多 40 个画布')", '达到上限有可见提示')
    assert.equal(await js("document.querySelector('#mb-status').classList.contains('error')"), true, '上限提示是错误态')
    assert.equal(await js("document.querySelectorAll('#mb-canvas-picker option').length"), 40, '达到上限时画布数量不变')
    await click('#mb-canvas-back')
    await until("document.querySelector('#mb-canvas').hidden===true", '关闭上限画布')
    // 卡片上限走 addCard：300 张卡片时再添加应给提示，而不是未捕获异常。
    const denseCards = {
      version: 1, activeId: 'dense',
      canvases: [{ id: 'dense', title: '卡片上限', edges: [], cards: Array.from({ length: 300 }, (_, index) => ({ id: `card-${index}`, kind: 'text', x: (index % 20) * 340, y: Math.floor(index / 20) * 220, w: 320, h: 200, text: '' })) }],
    }
    writeCanvasValue(JSON.stringify(denseCards))
    await click('#mb-canvas-button')
    await until("document.querySelector('#mb-canvas').hidden===false", '打开 300 卡片画布')
    await until("document.querySelectorAll('[data-card-id]').length===300", '300 张卡片已渲染')
    await click('#mb-canvas-text')
    await until("document.querySelector('#mb-status').textContent.includes('最多 300 张卡片')", '卡片达到上限有可见提示')
    assert.equal(await js("document.querySelector('#mb-status').classList.contains('error')"), true, '卡片上限提示是错误态')
    assert.equal(await js("document.querySelectorAll('[data-card-id]').length"), 300, '达到上限时卡片数量不变')
    await click('#mb-canvas-back')
    await until("document.querySelector('#mb-canvas').hidden===true", '关闭卡片上限画布')
    writeCanvasValue(originalCanvasValue)

    // —— P0-2 读失败时不得用空文档覆盖原画布 ——
    const brokenValue = '{ this is not json'
    writeCanvasValue(brokenValue)
    const loadReply = await js("window.vault.canvas('load')")
    assert.equal(loadReply.ok, true, `画布读取通道应成功返回损坏标记：${JSON.stringify(loadReply)}`)
    assert.equal(loadReply.result.corrupted, true, '主进程必须把坏数据标记为 corrupted')
    assert.equal(loadReply.result.docs.canvases.length, 0, 'corrupted 时 docs 是空文档')
    assert.equal(loadReply.result.canvases.length, 0, '保留顶层文档字段以兼容旧调用方')
    await click('#mb-canvas-button')
    await until("document.querySelector('#mb-canvas').hidden===false", '坏数据时画布仍打开并显示错误态')
    await until("document.querySelector('#mb-canvas-load-error')!==null", '错误态可见')
    assert.match(await js("document.querySelector('#mb-canvas-load-error').textContent"), /读取失败/)
    assert.equal(await js("document.querySelector('#mb-canvas-retry').getBoundingClientRect().width>0"), true, '重试读取按钮可见')
    await pause(700)
    assert.equal(canvasValue(), brokenValue, '读取失败后绝不能自动建画布写库（原值仍在）')
    await click('#mb-canvas-retry')
    await pause(350)
    assert.equal(await js("document.querySelector('#mb-canvas-load-error')!==null"), true, '坏数据重试仍然失败')
    assert.equal(canvasValue(), brokenValue, '重试失败仍不写库')
    writeCanvasValue(originalCanvasValue)
    await click('#mb-canvas-retry')
    await until("document.querySelectorAll('[data-card-id]').length===3", '数据修复后读回原画布')
    assert.equal(await js("document.querySelector('#mb-canvas-load-error')===null"), true, '修复后错误态消失')
    assert.equal(await js("document.querySelector('#mb-canvas').hidden"), false, '修复后画布仍打开')

    // —— P0-3 保存竞态：保存途中到达的编辑不能被「已保存」清掉 ——
    ipcMain.removeHandler('notebook:canvas')
    ipcMain.handle('notebook:canvas', async (_event, action, body = {}) => {
      try {
        if (action === 'load') {
          const state = canvasStore.canvasState()
          return { ok: true, result: { ...state.docs, docs: state.docs, corrupted: state.corrupted } }
        }
        if (action === 'save') {
          await pause(260)
          return { ok: true, result: canvasStore.setCanvasDocs(body?.docs ?? body) }
        }
        throw new Error('未知的画布操作')
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    })
    const firstEdit = '竞态保存 A', lastEdit = '竞态保存 B（最后一批，必须落库）'
    await js(`(() => {
      const node = document.querySelector('[data-kind=text] textarea');
      node.value = ${JSON.stringify(firstEdit)};
      node.dispatchEvent(new Event('input', { bubbles:true }));
      document.querySelector('#mb-canvas-save-state').click();
    })()`)
    await pause(90)
    assert.equal(await js("document.querySelector('#mb-canvas-save-state').textContent"), '正在保存…', '第二次编辑确实发生在保存途中')
    await js(`(() => {
      const node = document.querySelector('[data-kind=text] textarea');
      node.value = ${JSON.stringify(lastEdit)};
      node.dispatchEvent(new Event('input', { bubbles:true }));
    })()`)
    await until("document.querySelector('#mb-canvas-save-state').textContent==='已保存'", '竞态后的最后一批编辑已保存')
    await pause(120)
    const racedDoc = JSON.parse(canvasValue())
    const racedText = racedDoc.canvases.flatMap(canvas => canvas.cards).find(card => card.kind === 'text')?.text
    assert.equal(racedText, lastEdit, `保存途中的编辑必须最终落库：${JSON.stringify(racedText)}`)

    // —— P0-1 / P1-5 / P1-4：1040×650 真窗口里的折叠、展开、菜单与专注 ——
    await click('#mb-canvas-back')
    await until("document.querySelector('#mb-canvas').hidden===true", '关闭画布')
    window.setContentSize(1040, 650)
    await until("innerWidth===1040 && innerHeight===650", '窗口调整为 1040×650')
    await pause(150)
    await openLayout()
    await pause(80)
    await shot('笔记本-1040-布局面板')
    const panelFit = await js(`(() => {
      const panel = document.querySelector('#mb-layout-menu .ws-panel');
      const rect = document.querySelector('.mb-dialog').getBoundingClientRect();
      if (rect.left < -1 || rect.right > innerWidth + 1 || rect.top < -1 || rect.bottom > innerHeight + 1) return { ok:false, reason:'panel outside', rect:{ left:rect.left, top:rect.top, right:rect.right, bottom:rect.bottom } };
      for (const node of panel.querySelectorAll('button, input')) {
        const target = node.tagName === 'INPUT' ? (node.closest('label') ?? node) : node;
        target.scrollIntoView({ block:'nearest' });
        const box = target.getBoundingClientRect();
        if (box.width < 20 || box.height < 12) return { ok:false, reason:'control too small', id:node.id || node.textContent };
        if (box.left < -1 || box.right > innerWidth + 1 || box.top < -1 || box.bottom > innerHeight + 1) return { ok:false, reason:'control unreachable', id:node.id || node.textContent, box:{ left:box.left, top:box.top, right:box.right, bottom:box.bottom } };
      }
      return { ok:true, left:rect.left, right:rect.right, top:rect.top, bottom:rect.bottom };
    })()`)
    assert.equal(panelFit.ok, true, `布局面板与控件必须在 1040×650 视口内：${JSON.stringify(panelFit)}`)
    assert.ok(panelFit.left >= 0, `布局面板左缘不得为负：${panelFit.left}`)
    // P1-4：有对话框时 Esc 先给对话框，布局菜单不能抢走这次按键。
    const menuSurvivesDialogEscape = await js(`(() => {
      const probe = document.createElement('dialog');
      probe.id = 'mb-escape-probe';
      document.body.append(probe);
      probe.show();
      document.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true, cancelable:true }));
      const open = document.querySelector('#mb-layout-menu').open;
      probe.remove();
      return open;
    })()`)
    assert.equal(menuSurvivesDialogEscape, true, '有对话框时 Esc 不得关闭布局菜单')

    await click('#mb-layout-side-collapsed')
    await pause(120)
    await closeLayout()
    assert.equal(await js("getComputedStyle(document.querySelector('.mb-side')).display"), 'none', '折叠后侧栏隐藏')
    const expandRect = await js(`(() => {
      const node = document.querySelector('.mb-bar .toolbar-actions .ws-expand');
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return { display:getComputedStyle(node).display, left:r.left, top:r.top, right:r.right, bottom:r.bottom, width:r.width, height:r.height };
    })()`)
    assert.ok(expandRect, '折叠后展开按钮必须在 .mb-bar .toolbar-actions（不随面包屑隐藏）')
    assert.notEqual(expandRect.display, 'none', '折叠后展开按钮可见')
    assert.ok(expandRect.left >= 0 && expandRect.right <= 1040 + 1 && expandRect.top >= 0 && expandRect.bottom <= 650 + 1, `展开按钮必须在视口内：${JSON.stringify(expandRect)}`)
    await shot('笔记本-1040-折叠后展开按钮')
    await click('.mb-bar .toolbar-actions .ws-expand')
    await pause(150)
    assert.equal(await js("getComputedStyle(document.querySelector('.mb-side')).display"), 'flex', '展开按钮能恢复侧栏')

    await openLayout()
    await click('#mb-layout-focus')
    await closeLayout()
    await pause(120)
    assert.equal(await js("document.querySelector('.mb-shell').dataset.mbFocus"), 'on', '已进入专注模式')
    assert.equal(await js("Boolean(document.querySelector('.mb-dialog[open]'))"), false, '进入专注后关闭设置')
    await js("document.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true, cancelable:true }))")
    await pause(120)
    assert.equal(await js("document.querySelector('.mb-shell').dataset.mbFocus"), 'off', '一次 Esc 退出专注')

    // 再次折叠并重载渲染器（等价于重启窗口后的首帧）：折叠状态从库里读回。
    await openLayout()
    await click('#mb-layout-side-collapsed')
    await pause(120)
    let persisted = false
    for (let attempt = 0; attempt < 120; attempt++) {
      const reply = await js("window.vault.notebook('list', {})")
      if (reply?.ok && reply.result?.prefs?.sideCollapsed === true) { persisted = true; break }
      await pause(30)
    }
    assert.equal(persisted, true, '折叠状态应在重载前写入笔记本偏好')
    window.webContents.reload()
    await pause(400)
    await until("document.body.dataset.mode==='mistakebook'", '重载后回到笔记本')
    await openLayout()
    await until("document.querySelector('.mb-shell')?.dataset.mbSide==='collapsed'", '重载后仍是折叠状态（重启不丢）')
    assert.equal(await js("getComputedStyle(document.querySelector('.mb-side')).display"), 'none', '重载后侧栏仍折叠')
    const expandAfterReload = await js(`(() => {
      const node = document.querySelector('.mb-bar .toolbar-actions .ws-expand');
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return { display:getComputedStyle(node).display, left:r.left, top:r.top, right:r.right, bottom:r.bottom };
    })()`)
    assert.ok(expandAfterReload && expandAfterReload.display !== 'none', '重载后展开按钮仍可见')
    assert.ok(expandAfterReload.left >= 0 && expandAfterReload.right <= 1040 + 1 && expandAfterReload.top >= 0 && expandAfterReload.bottom <= 650 + 1, '重载后展开按钮仍在视口内')
    await closeLayout()
    await click('.mb-bar .toolbar-actions .ws-expand')
    await pause(150)
    assert.equal(await js("getComputedStyle(document.querySelector('.mb-side')).display"), 'flex', '重载后展开按钮仍能恢复侧栏')

    await click('#mb-canvas-button')
    await until("document.querySelector('#mb-canvas').hidden===false", '重载后打开画布')
    await until(`${cards}===3`, '重载后画布仍有 3 张卡片')

    // —— 保存失败必须可见（把画布通道改成永远失败，再改一次文字）——
    ipcMain.removeHandler('notebook:canvas')
    ipcMain.handle('notebook:canvas', async () => ({ ok: false, error: '磁盘只读（测试注入）' }))
    await js(`(()=>{const n=document.querySelector('[data-kind=text] textarea');n.value='保存会失败的文字';n.dispatchEvent(new Event('input',{bubbles:true}));n.blur()})()`)
    await until("document.querySelector('#mb-canvas-save-state').textContent.includes('保存失败')", '保存失败状态可见')
    assert.equal(await js("document.querySelector('#mb-canvas-save-state').classList.contains('failed')"), true)
    await until("document.querySelector('#mb-status').classList.contains('visible')", '底部提示可见')
    assert.match(await js("document.querySelector('#mb-status').textContent"), /画布保存失败/)
    await shot('画布-保存失败可见')
  } finally {
    dialog.showMessageBox = originalConfirm
  }
}
