/**
 * 自由画布的真实界面冒烟测试（Electron 主进程里跑，操作真实渲染器）。
 *
 * 不是静态 mock：在这个窗口里真的点按钮、真的发 pointer / wheel / keyboard
 * 事件，再回读 DOM 与 SQLite，确认「拖动 1:1 跟手、指针中心缩放不漂移、
 * 选中删除与撤销重做、回到笔记、关掉再打开状态还在、存库在
 * 笔记本域而不是记忆域、保存失败可见」。
 */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { dialog, ipcMain, nativeImage } from 'electron'
import { MistakebookStore } from '../addons/mistakebook/store.mjs'
import { A4_IMAGE_SIZE, A4_SIZE } from '../addons/mistakebook/canvas.mjs'

export async function run(window, bridge) {
  assert.match(bridge.databasePath, /canvas-test[^\\/]*\.sqlite$/)
  if (process.platform !== 'darwin') assert.equal(window.isMenuBarVisible(), false)
  const js = async source => {
    try { return await window.webContents.executeJavaScript(source) } catch (error) { throw new Error(`注入脚本失败：${error?.message ?? error}\n${source}`) }
  }
  const pause = ms => new Promise(resolvePause => setTimeout(resolvePause, ms))
  const painted = () => js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
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
  const placeText = async () => {
    await click('#mb-canvas-text')
    await js(`(() => {
      const surface = document.getElementById('mb-canvas-surface')
      const rect = surface.getBoundingClientRect()
      surface.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles:true, cancelable:true, button:0, buttons:1, clientX:rect.left + rect.width * .35, clientY:rect.top + rect.height * .35,
      }))
    })()`)
  }
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
    assert.ok(await js(`(() => {
      const groups = [...document.querySelector('#mb-canvas-bar').children].map(node => node.getBoundingClientRect())
      const center = rect => rect.top + rect.height / 2
      return groups.every(rect => Math.abs(center(rect) - center(groups[0])) < 1)
    })()`), '顶部三组工具在同一条基线上')
    await until("document.querySelector('#mb-canvas-surface').getBoundingClientRect().width>300", '画布尺寸可用')

    // 首次打开自动建一张空白画布。
    await until("document.querySelectorAll('#mb-canvas-picker option').length===1", '默认画布')
    assert.equal(await js("document.querySelector('#mb-canvas-hint')?.hidden"), true, '空画布保持空白，工具集中在底部')
    await keydown('q')
    assert.equal(await js("document.querySelector('#mb-canvas-quick-palette').hidden"), false, 'Q 呼出工具盘')
    assert.equal(await js("document.querySelectorAll('#mb-canvas-quick-palette [data-quick-tool]').length"), 4, '工具盘包含框选和三种画笔工具')
    await keydown('Escape')
    assert.equal(await js("document.querySelector('#mb-canvas-quick-palette').hidden"), true, 'Esc 收起工具盘')

    // —— 文本卡片 ——
    await placeText()
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

    // —— 旧版便签仍可阅读和换色，工具栏移除新增入口 ——
    assert.equal(await js("document.getElementById('mb-canvas-sticky')"), null)
    await click('#mb-canvas-back')
    await until("document.querySelector('#mb-canvas').hidden", '关闭画布后写入旧版样本')
    const legacy = JSON.parse(canvasValue())
    legacy.version = 1
    delete legacy.canvases[0].ink
    legacy.canvases[0].cards.push({ id: 'old-sticky', kind: 'sticky', text: '旧版便签', x: 280, y: 250 })
    writeCanvasValue(JSON.stringify(legacy))
    await click('#mb-canvas-button')
    await until(`${cards}===2`, '旧版便签仍可加载')
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
    await click('.mb-canvas-ref-preview')
    await until("document.querySelector('.mb-canvas-note-preview')?.textContent.includes('标注方向与大小')", '直接在白板上预览笔记原文')
    assert.equal(await js("document.querySelector('#mb-canvas').hidden"), false)
    await closeLayout()

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

    assert.deepEqual(await js("[...document.querySelectorAll('#mb-canvas-zoom-controls button')].map(node => node.id)"),
      ['mb-canvas-zoom-out', 'mb-canvas-zoom-in'], '缩放栏只保留缩小和放大')
    // —— 拖动平移，反向拖动回到原位置 ——
    const pan = await js(`(() => {
      const surface = document.getElementById('mb-canvas-surface')
      const rect = surface.getBoundingClientRect()
      const card = document.querySelector('[data-card-id]')
      const before = card.getBoundingClientRect()
      const x = rect.right - 40, y = rect.bottom - 140
      const drag = (dx, dy) => {
        const point = (clientX, clientY) => ({ bubbles:true, cancelable:true, clientX, clientY,
          pointerId:21, pointerType:'mouse', button:1, buttons:4, isPrimary:true })
        surface.dispatchEvent(new PointerEvent('pointerdown', point(x, y)))
        surface.dispatchEvent(new PointerEvent('pointermove', point(x + dx, y + dy)))
        surface.dispatchEvent(new PointerEvent('pointerup', point(x + dx, y + dy)))
      }
      drag(-rect.width * 2, -rect.height * 2)
      const outside = card.getBoundingClientRect().right < rect.left
      drag(rect.width * 2, rect.height * 2)
      const after = card.getBoundingClientRect()
      return { outside, restored: Math.abs(after.left - before.left) < 1 && Math.abs(after.top - before.top) < 1 }
    })()`)
    assert.deepEqual(pan, { outside: true, restored: true }, '拖动平移后可回到原处')

    // —— 手写、压感、取消、擦除与撤销 ——
    await click('#mb-canvas-ink-tool')
    assert.equal(await js("document.querySelector('#mb-canvas-ink-color').value"), '#1267ed')
    assert.equal(await js("document.querySelector('#mb-canvas-ink-width').value"), '2')
    assert.equal(await js("document.querySelectorAll('#mb-canvas-ink-touch, #mb-canvas-ink-done').length"), 0, '笔具栏移除手指书写和完成按钮')
    const toolCenters = await js(`[...document.querySelectorAll('.mb-ink-instrument')].map(icon => {
      const rect = icon.getBoundingClientRect()
      const tip = getComputedStyle(icon, '::before')
      return rect.top + (rect.height - (tip.content === 'none' ? 0 : parseFloat(tip.height) || 0)) / 2
    })`)
    assert.ok(toolCenters.every(y => Math.abs(y - toolCenters[0]) < 1), '笔尖和笔杆的整体轮廓与橡皮居中对齐')

    const tier = await js("document.documentElement.dataset.glassTier")
    if (tier !== 'flat') {
      const glass = await js(`[...document.querySelectorAll('#mb-canvas [data-glass-surface="float"]')].map(node => {
        const center = getComputedStyle(node)
        return { background: center.backgroundColor, blur: center.backdropFilter, frost: getComputedStyle(node, '::after').display }
      })`)
      assert.equal(glass.length, 7)
      assert.ok(glass.every(item => item.background === 'rgba(0, 0, 0, 0)' && item.blur === 'none' && item.frost === 'none'),
        '白板浮层中央透明，无背景模糊和独立磨砂层')
      if (tier === 'full') {
        await until("document.querySelector('#mb-canvas-tools').dataset.glassRefraction === 'on'", '白板浮层已注册光学折射')
        assert.match(await js("getComputedStyle(document.querySelector('#mb-canvas-tools'), '::before').backdropFilter"), /url\(/, '边缘层保留折射')
      }
      const sample = await js(`(() => {
        const tool = document.querySelector('#mb-canvas-tools')
        const probe = document.createElement('div')
        probe.id = 'canvas-glass-probe'
        probe.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:2;background:repeating-linear-gradient(90deg,#162c44 0 2px,#fff 2px 4px)'
        document.querySelector('#mb-canvas-surface').append(probe)
        const style = document.createElement('style')
        style.id = 'canvas-glass-probe-style'
        style.textContent = '#mb-canvas-tools > * { visibility:hidden !important }'
        document.head.append(style)
        const rect = tool.getBoundingClientRect()
        return { x: Math.round(rect.left + rect.width / 2) - 12, inner: Math.round(rect.top + rect.height / 2),
          outer: Math.round(rect.bottom) + 14, w: innerWidth, h: innerHeight }
      })()`)
      try {
        let outside, inside, contrast = 0
        // Windows offscreen capture can briefly return the frame before an injected layer appeared.
        for (let attempt = 0; attempt < 6 && contrast <= 140; attempt++) {
          await painted()
          await pause(40)
          const shot = await window.webContents.capturePage()
          const size = shot.getSize(), bytes = shot.toBitmap()
          const strip = y => Array.from({ length: 24 }, (_, index) =>
            bytes[(Math.round(y * size.height / sample.h) * size.width + Math.round((sample.x + index) * size.width / sample.w)) * 4 + 2])
          outside = strip(sample.outer)
          inside = strip(sample.inner)
          contrast = Math.max(...outside) - Math.min(...outside)
        }
        assert.ok(contrast > 140, `验证背景本身有清晰条纹（对比度 ${contrast}）`)
        assert.ok(inside.every((value, index) => Math.abs(value - outside[index]) <= 2), '玻璃中央的背景条纹和外部一致')
      } finally {
        await js("document.getElementById('canvas-glass-probe').remove(); document.getElementById('canvas-glass-probe-style').remove()")
      }
    }
    await js(`(() => {
      for (const [selector, value] of [['#mb-canvas-ink-color', '#8a23ff'], ['#mb-canvas-ink-width', '7']]) {
        const input = document.querySelector(selector)
        input.value = value
        input.dispatchEvent(new Event('input', { bubbles:true }))
      }
    })()`)
    const strokeNodes = "document.querySelectorAll('.mb-canvas-ink [data-stroke-id]').length"
    const inkGesture = (points, { pointerType = 'pen', end = 'pointerup', id = 81 } = {}) => js(`(() => {
      const surface = document.getElementById('mb-canvas-surface')
      const rect = surface.getBoundingClientRect()
      const points = ${JSON.stringify(points)}
      const send = (type, [x, y, pressure]) => surface.dispatchEvent(new PointerEvent(type, {
        pointerId: ${id}, pointerType: ${JSON.stringify(pointerType)}, clientX: rect.left + x, clientY: rect.top + y, pressure,
        bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1,
      }))
      send('pointerdown', points[0])
      const downCursor = getComputedStyle(surface).cursor
      for (const point of points.slice(1)) send('pointermove', point)
      send(${JSON.stringify(end)}, points.at(-1))
      return [downCursor, getComputedStyle(surface).cursor]
    })()`)
    assert.deepEqual(await inkGesture([[150, 140, 0.2], [200, 140, 0.85], [300, 140, 0.65]]), ['none', 'none'], '落笔和抬笔都只显示笔尖圆点')
    const drawingDot = () => js(`(() => {
      const dot = document.querySelector('#mb-canvas-surface .mb-drawing-cursor')
      const style = getComputedStyle(dot)
      const rect = dot.getBoundingClientRect()
      return { hidden:dot.hidden, center:[rect.x + rect.width / 2, rect.y + rect.height / 2], size:parseFloat(style.width), color:style.backgroundColor }
    })()`)
    const liftedDot = await drawingDot()
    assert.equal(liftedDot.hidden, false, '抬笔后圆点保留')
    await js(`(() => {
      const input = document.querySelector('#mb-canvas-ink-width')
      input.value = '12'; input.dispatchEvent(new Event('input', { bubbles:true }))
      const color = document.querySelector('#mb-canvas-ink-color')
      color.value = '#ff3652'; color.dispatchEvent(new Event('input', { bubbles:true }))
    })()`)
    const changedDot = await drawingDot()
    assert.equal(changedDot.hidden, false)
    assert.ok(changedDot.size > liftedDot.size)
    assert.equal(changedDot.color, 'rgb(255, 54, 82)')
    assert.ok(changedDot.center.every((value, index) => Math.abs(value - liftedDot.center[index]) < .1), '调色和粗细时圆点中心保持原位')
    await js(`(() => {
      const input = document.querySelector('#mb-canvas-ink-width')
      input.value = '7'; input.dispatchEvent(new Event('input', { bubbles:true }))
      const color = document.querySelector('#mb-canvas-ink-color')
      color.value = '#8a23ff'; color.dispatchEvent(new Event('input', { bubbles:true }))
    })()`)
    await until(`${strokeNodes}===1`, '笔迹已显示')
    assert.match(await js("document.querySelector('.mb-canvas-ink path').getAttribute('d')"), /^M/)
    assert.ok(await js("document.querySelector('.mb-canvas-ink path').getBoundingClientRect().width > 100"), '笔迹可见并随视口缩放')
    await inkGesture([[150, 175, 0.2], [151, 175, 0.85], [151, 176, 0.65], [152, 176, 0.7], [200, 200, 0.4]], { pointerType: 'mouse' })
    await until(`${strokeNodes}===2`, '触控板对应的鼠标型笔迹已显示')
    const trackpad = await js(`(() => {
      const node = document.querySelector('.mb-canvas-ink path:last-child')
      return { d: node.getAttribute('d'), width: node.getAttribute('stroke-width') }
    })()`)
    assert.match(trackpad.d, /Q/, '细碎台阶使用曲线过渡')
    assert.equal(trackpad.width, '7', '鼠标型输入始终使用选定笔宽')
    await click('#mb-canvas-undo')
    assert.equal(await js(strokeNodes), 1)
    await inkGesture([[130, 220, 0.5], [260, 230, 0.5]], { end: 'pointercancel' })
    assert.equal(await js(strokeNodes), 1, '取消不会留下未完成的笔迹')
    await inkGesture([[130, 210, 0.5], [150, 230, 0.5]], { pointerType: 'touch', id: 82 })
    assert.equal(await js(strokeNodes), 1, '手指默认平移，不会留下笔迹')
    await inkGesture([[150, 230, 0.5], [130, 210, 0.5]], { pointerType: 'touch', id: 82 })
    await keydown('B', { shiftKey: true })
    await inkGesture([[130, 220, 0.5], [260, 230, 0.5]], { pointerType: 'touch', id: 82 })
    assert.equal(await js(strokeNodes), 2, 'Shift+B 保留手指书写入口')
    await click('#mb-canvas-undo')
    await keydown('B', { shiftKey: true })
    await click('#mb-canvas-ink-erase')
    assert.equal((await drawingDot()).color, 'rgb(105, 117, 136)', '切换橡皮时圆点变为灰色')
    await inkGesture([[215, 100, 0.5], [215, 180, 0.5]])
    assert.equal(await js(strokeNodes), 0, '橡皮可以整笔擦除')
    await click('#mb-canvas-undo')
    assert.equal(await js(strokeNodes), 1, '撤销恢复擦除的笔迹')
    await click('#mb-canvas-redo')
    assert.equal(await js(strokeNodes), 0, '重做再次擦除')
    await click('#mb-canvas-undo')
    await click('#mb-canvas-ink-marker')
    assert.equal(await js("document.querySelector('#mb-canvas-ink-color').value"), '#ffbd00')
    await inkGesture([[150, 200, 0.5], [260, 210, 0.5]], { pointerType: 'mouse' })
    assert.equal(await js(strokeNodes), 2, '荧光笔支持鼠标')
    await shot('画布-手写')

    // —— A4 模式与实际文件导出 ——
    await click('#mb-canvas-paper')
    assert.equal(await js("document.querySelector('.mb-canvas-paper-layer').hidden"), false)
    assert.match(await js("getComputedStyle(document.querySelector('.mb-canvas-sheet')).backgroundImage"), /radial-gradient/)
    const paperCenter = await js(`(() => {
      const surface = document.querySelector('.mb-canvas-surface')
      const rect = surface.getBoundingClientRect()
      surface.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -4000,
        clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }))
      return { x: rect.width / 2, y: rect.height / 2 }
    })()`)
    await until("document.querySelector('#mb-canvas-zoom').textContent === '1600%'", 'A4 模式放大到 1600%')
    await click('#mb-canvas-ink-pen')
    await js(`(() => {
      const width = document.getElementById('mb-canvas-ink-width')
      width.value = '0.25'
      width.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await inkGesture([[paperCenter.x - 50, paperCenter.y, 0.5], [paperCenter.x + 50, paperCenter.y, 0.5]], { pointerType: 'mouse' })
    const fineStroke = await js(`(() => {
      const root = document.querySelector('.mb-canvas-vectors')
      const stroke = root.querySelector('.mb-canvas-ink path:last-child')
      return { width: stroke.getAttribute('stroke-width'), scale: stroke.getScreenCTM().a,
        viewportWidth: root.clientWidth, viewBoxWidth: root.viewBox.baseVal.width }
    })()`)
    assert.equal(fineStroke.width, '0.25')
    assert.ok(Math.abs(fineStroke.scale - 16) < 0.01, 'SVG 直接以放大后的比例绘制细笔')
    assert.ok(Math.abs(fineStroke.viewBoxWidth * 16 - fineStroke.viewportWidth) < 1)
    const linePixels = await js(`(() => {
      const rect = document.querySelector('.mb-canvas-surface').getBoundingClientRect()
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, w: innerWidth, h: innerHeight }
    })()`)
    await painted()
    await pause(40)
    const frame = await window.webContents.capturePage()
    const frameSize = frame.getSize(), frameBitmap = frame.toBitmap()
    const pixel = y => (Math.round((linePixels.y + y) * frameSize.height / linePixels.h) * frameSize.width
      + Math.round(linePixels.x * frameSize.width / linePixels.w)) * 4
    const purple = offset => frameBitmap[offset] - frameBitmap[offset + 1] > 120
    assert.ok(purple(pixel(0)) && !purple(pixel(-5)) && !purple(pixel(5)), '屏幕像素中细线清晰，边缘没有扩散到线外')
    await click('#mb-canvas-undo')
    await click('#mb-canvas-paper')
    await click('#mb-canvas-paper')
    await keydown('v')
    assert.equal(await js("document.querySelector('#mb-canvas-ink-tools').hidden"), true, 'V 退出手写')
    const paperGesture = (points, id = 85) => js(`(() => {
      const paper = document.querySelector('.mb-canvas-sheet.active').getBoundingClientRect()
      const surface = document.querySelector('.mb-canvas-surface').getBoundingClientRect()
      const scale = paper.width / 794
      return ${JSON.stringify(points)}.map(([x, y]) => [paper.left - surface.left + x * scale, paper.top - surface.top + y * scale, .5])
    })()`).then(screen => inkGesture(screen, { pointerType: 'mouse', id }))
    await click('#mb-canvas-shape')
    assert.equal(await js("document.querySelector('[data-shape-tool=arrow]').getAttribute('aria-pressed')"), 'true', '点图形工具即可开始绘制')
    assert.equal(await js("getComputedStyle(document.querySelector('#mb-canvas-surface')).cursor"), 'none')
    await paperGesture([[90, 710]])
    assert.equal(await js("document.querySelectorAll('[data-shape-id]').length"), 0, '轻点不误建图形')
    assert.deepEqual(await paperGesture([[90, 710], [180, 790]]), ['none', 'none'], '连续绘制时只显示圆点')
    await paperGesture([[90, 830], [180, 910]])
    assert.equal(await js("document.querySelectorAll('[data-shape-kind=arrow]').length"), 2, '可以连续绘制')
    await click('#mb-canvas-undo')

    // A trusted pointer click catches a floating palette jumping between press and release.
    const before = await cardBox('[data-shape-tool=line]')
    const atLine = { x: Math.round(before.cx), y: Math.round(before.cy), button: 'left', clickCount: 1 }
    window.webContents.sendInputEvent({ type: 'mouseMove', ...atLine })
    await pause(25)
    window.webContents.sendInputEvent({ type: 'mouseDown', ...atLine, modifiers: ['leftButtonDown'] })
    await pause(90)
    const pressed = await cardBox('[data-shape-tool=line]')
    window.webContents.sendInputEvent({ type: 'mouseUp', ...atLine })
    assert.ok(Math.abs(pressed.cx - before.cx) < 3 && Math.abs(pressed.cy - before.cy) < 3, '按住时图形选项保持在指针下')
    await until("document.querySelector('[data-shape-tool=line]').getAttribute('aria-pressed')==='true'", '真实点击切换图形')
    const setShapeColor = value => js(`(() => {
      const input = document.querySelector('#mb-canvas-shape-color')
      input.value = ${JSON.stringify(value)}
      input.dispatchEvent(new Event('change', { bubbles:true }))
    })()`)
    await setShapeColor('#ff3652')
    assert.equal((await drawingDot()).color, 'rgb(255, 54, 82)', '新图形颜色同步到圆点')
    assert.equal(await js("document.querySelector('[data-shape-kind=arrow]').getAttribute('stroke')"), '#1267ed', '更换新图形的颜色只影响接下来的绘制')
    for (const [index, kind] of ['line', 'circle', 'square'].entries()) {
      if (kind !== 'line') await click(`[data-shape-tool="${kind}"]`)
      await paperGesture([[220 + index * 130, 710], [310 + index * 130, 790]])
      assert.equal(await js(`document.querySelector('[data-shape-kind="${kind}"]').getAttribute('stroke')`), '#ff3652')
    }
    await keydown('v')
    assert.equal(await js("document.querySelector('#mb-canvas-shape').getAttribute('aria-pressed')"), 'false')
    assert.equal((await drawingDot()).hidden, true, '退出绘图才隐藏圆点')
    await setShapeColor('#22c65d')
    assert.equal(await js("document.querySelector('[data-shape-kind=square]').getAttribute('stroke')"), '#22c65d', '可修改选中图形的颜色')
    assert.equal(await js("document.querySelector('[data-shape-kind=circle]').getAttribute('stroke')"), '#ff3652')
    await keydown('Delete')
    await until("document.querySelectorAll('[data-shape-id]').length===3", '删除选中图形')
    await click('#mb-canvas-undo')
    assert.equal(await js("document.querySelectorAll('[data-shape-id]').length"), 4, '撤销恢复图形')
    await click('#mb-canvas-undo')
    assert.equal(await js("document.querySelector('[data-shape-kind=square]').getAttribute('stroke')"), '#ff3652', '改色可撤销')
    await click('#mb-canvas-redo')
    assert.equal(await js("document.querySelector('[data-shape-kind=square]').getAttribute('stroke')"), '#22c65d', '改色可重做')
    await click('#mb-canvas-ink-tool')
    await click('#mb-canvas-ink-marker')
    const bottomStroke = await js(`(() => {
      const paper = document.querySelector('.mb-canvas-sheet').getBoundingClientRect()
      const surface = document.querySelector('.mb-canvas-surface').getBoundingClientRect()
      const scale = paper.width / 794
      return [60, 180].map(x => [paper.left - surface.left + x * scale, paper.top - surface.top + 1075 * scale, .5])
    })()`)
    await inkGesture(bottomStroke, { pointerType: 'mouse' })
    assert.equal(await js(strokeNodes), 3)
    await shot('画布-A4')
    const originalSaveDialog = dialog.showSaveDialog
    try {
      for (const format of ['pdf', 'png', 'jpg']) {
        const target = join(dirname(bridge.databasePath), `canvas-export.${format}`)
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: target })
        await click('#mb-canvas-export')
        await click(`[data-canvas-export="${format}"]`)
        await until("!document.querySelector('#mb-canvas-export').disabled", `导出 ${format}`)
        const bytes = readFileSync(target)
        if (format === 'pdf') {
          assert.equal(bytes.subarray(0, 4).toString(), '%PDF')
          assert.match(bytes.toString('latin1'), /\/MediaBox \[0 0 59[45](?:\.\d+)? 84[12](?:\.\d+)?\]/, 'A4 竖版尺寸')
        } else {
          assert.equal(bytes.subarray(0, format === 'png' ? 4 : 2).toString('hex'), format === 'png' ? '89504e47' : 'ffd8')
          const output = nativeImage.createFromPath(target)
          assert.deepEqual(output.getSize(), { width: A4_IMAGE_SIZE.w, height: A4_IMAGE_SIZE.h })
          const bitmap = output.toBitmap()
          const pixelAt = (x, y) => (Math.round(y * A4_IMAGE_SIZE.h / A4_SIZE.h) * A4_IMAGE_SIZE.w
            + Math.round(x * A4_IMAGE_SIZE.w / A4_SIZE.w)) * 4
          const sample = pixelAt(110, 1075)
          assert.ok(bitmap[sample + 2] - bitmap[sample] > 40, '导出保留纸张底部笔迹的原始位置')
          const white = pixelAt(601, 201)
          assert.ok(bitmap.subarray(white, white + 3).every(value => value >= 248), '导出不包含编辑点阵')
        }
      }
    } finally { dialog.showSaveDialog = originalSaveDialog }
    await click('#mb-canvas-undo')
    assert.equal(await js(strokeNodes), 2)
    const paperIds = () => js("Array.from(document.querySelectorAll('#mb-canvas-paper-picker option'), option => option.value)")
    const choosePaper = id => js(`(() => {
      const picker = document.querySelector('#mb-canvas-paper-picker')
      picker.value = ${JSON.stringify(id)}
      picker.dispatchEvent(new Event('change', { bubbles:true }))
    })()`)
    const activePaper = () => js("document.querySelector('.mb-canvas-sheet.active')?.dataset.sheetId")
    const [firstPaper] = await paperIds()
    await click('#mb-canvas-paper-add')
    const [, secondPaper] = await paperIds()
    assert.ok(secondPaper && secondPaper !== firstPaper, '添加独立 A4 页')
    assert.equal(await activePaper(), secondPaper, '新增纸张后定位到该页')
    assert.equal(await js("document.querySelector('#mb-canvas-paper-clip').childElementCount"), 2, '笔迹裁切包含两张纸')
    assert.match(await js("getComputedStyle(document.querySelector('#mb-canvas-world')).clipPath"), /path\(.+M.+M/, '卡片裁切包含两张纸')
    await choosePaper(firstPaper)
    assert.equal(await activePaper(), firstPaper)
    await choosePaper(secondPaper)
    await paperGesture([[60, 740], [180, 740]], 86)
    assert.equal(await js(strokeNodes), 3, '第二页可书写')
    const imageCard = '[data-kind=image]'
    const imageReady = `document.querySelector('${imageCard} img')?.naturalWidth === 180`
    const importImage = () => js(`(async () => {
      const fixture = document.createElement('canvas')
      fixture.width = 180
      fixture.height = 120
      const context = fixture.getContext('2d')
      context.fillStyle = '#12da8b'
      context.fillRect(0, 0, 180, 120)
      const blob = await new Promise(resolve => fixture.toBlob(resolve, 'image/png'))
      const input = document.querySelector('#mb-canvas-image-picker')
      const files = new DataTransfer()
      files.items.add(new File([blob], '画布导入.png', { type:'image/png' }))
      input.files = files.files
      input.dispatchEvent(new Event('change', { bubbles:true }))
    })()`)
    await importImage()
    await until(imageReady, '导入图片可见')
    await click('#mb-canvas-undo')
    assert.equal(await js(`document.querySelector('${imageCard}')`), null, '撤销移除导入图片')
    await click('#mb-canvas-redo')
    await until(imageReady, '重做恢复图片内容')
    await until("document.querySelector('#mb-canvas-save-state').textContent==='已保存'", '图片保存到笔记本')
    const savedBoard = JSON.parse(canvasValue()).canvases[0]
    const savedImage = savedBoard.cards.find(card => card.kind === 'image')
    const savedSheet = savedBoard.paper.sheets.find(sheet => sheet.id === secondPaper)
    assert.equal(savedImage.image.name, '画布导入.png')
    try {
      for (const format of ['pdf', 'png']) {
        const target = join(dirname(bridge.databasePath), `canvas-multiple.${format}`)
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: target })
        await click('#mb-canvas-export')
        await click(`[data-canvas-export="${format}"]`)
        await until("!document.querySelector('#mb-canvas-export').disabled", `多页画布导出 ${format}`)
        if (format === 'pdf') {
          assert.match(readFileSync(target).toString('latin1'), /\/Count 2\b/, 'PDF 包含两页')
        } else {
          const bitmap = nativeImage.createFromPath(target).toBitmap()
          const sample = (Math.round(740 * A4_IMAGE_SIZE.h / A4_SIZE.h) * A4_IMAGE_SIZE.w
            + Math.round(110 * A4_IMAGE_SIZE.w / A4_SIZE.w)) * 4
          assert.ok(bitmap[sample + 2] - bitmap[sample] > 40, 'PNG 导出当前选中的第二页')
          const imageX = savedImage.x - savedSheet.x + savedImage.w / 2
          const imageY = savedImage.y - savedSheet.y + savedImage.h / 2
          const imagePixel = (Math.round(imageY * A4_IMAGE_SIZE.h / A4_SIZE.h) * A4_IMAGE_SIZE.w
            + Math.round(imageX * A4_IMAGE_SIZE.w / A4_SIZE.w)) * 4
          assert.ok(bitmap[imagePixel + 1] > 190 && bitmap[imagePixel + 2] < 50, 'PNG 包含导入的图片')
        }
      }
    } finally { dialog.showSaveDialog = originalSaveDialog }
    await click('#mb-canvas-undo')
    await click('#mb-canvas-undo')
    assert.equal(await js(strokeNodes), 2)
    await click('#mb-canvas-paper-remove')
    assert.deepEqual(await paperIds(), [firstPaper], '移除当前纸张')
    await click('#mb-canvas-undo')
    assert.deepEqual(await paperIds(), [firstPaper, secondPaper], '撤销恢复纸张')
    await choosePaper(firstPaper)
    await click('#mb-canvas-paper')
    assert.equal(await js("document.querySelector('.mb-canvas-paper-layer').hidden"), true)

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
    assert.deepEqual(document_.canvases[0].paper.sheets.map(sheet => sheet.id), [firstPaper, secondPaper])
    assert.deepEqual(document_.canvases[0].ink[0].points.map(point => point[2]), [20, 85, 65], '保留真实笔压数据')
    assert.equal(document_.canvases[0].ink[0].color, '#8a23ff')
    assert.equal(document_.canvases[0].ink[0].width, 7)
    assert.equal(document_.canvases[0].ink[1].tool, 'marker')
    assert.deepEqual(document_.canvases[0].shapes.map(shape => shape.kind), ['arrow', 'line', 'circle', 'square'])
    assert.equal(leaked, 0, '画布绝不能写进记忆域的 meta 表')

    // —— 关掉再打开：位置、文字、引用都还在 ——
    const transformBefore = await js("document.querySelector('[data-kind=text]').style.transform")
    await click('#mb-canvas-button')
    await until("document.querySelector('#mb-canvas').hidden===false", '再次打开画布')
    await until(`${cards}===3`, '卡片数量保持')
    await until(`${strokeNodes}===2`, '重开白板恢复可编辑的笔迹')
    assert.equal(await js("document.querySelectorAll('[data-shape-id]').length"), 4, '重开白板恢复图形')
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
    await placeText()
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

    // —— 完整错题引用、显示范围和画布内编辑 ——
    const stem = '求 $f(x)=x^{2}$ 的最小值。\n\n' + '已知条件和推导细节。\n\n'.repeat(28) + '题干末尾应保留。'
    const questionReply = await api('save', {
      type: 'mistake', title: '完整题目引用测试', stem, studentWork: '原作答过程', referenceAnswer: '原参考答案',
      images: [{ name: '题图.png', mimeType: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' }],
    })
    assert.equal(questionReply.ok, true)
    const questionId = questionReply.result.id
    const viewport = "document.querySelector('.mb-canvas-question-viewport')"
    await click('#mb-canvas-paper')
    await choosePaper(secondPaper)
    await click('#mb-canvas-reference')
    await until(`Boolean(document.querySelector('[data-note-pick="${questionId}"]'))`, '引用已有错题')
    await click(`[data-note-pick="${questionId}"]`)
    await until(`${viewport}?.textContent.includes('题干末尾应保留。')`, '题干完整显示')
    assert.match(await js(`${viewport}.textContent`), /原作答过程.*原参考答案/s)
    assert.ok(await js(`Boolean(${viewport}.querySelector('.mb-tex'))`), '画布中排版公式')
    assert.ok(await js(`Boolean(${viewport}.querySelector('img[src^="data:image/png"]'))`), '画布中有原题图')
    assert.equal(await js(`${viewport}.dispatchEvent(new WheelEvent('wheel', { bubbles:true, cancelable:true, deltaY:160 }))`), true, '错题卡里的滚轮交给内容区')
    await js(`${viewport}.scrollTop = 160`)
    await click('[data-question-action=viewport]')
    await until(`${viewport}?.scrollTop === 160`, '题目显示起点可保存')
    await click('[data-question-action=sections]')
    await js(`(() => {
      const dialog = document.querySelector('.mb-dialog[open]')
      for (const label of dialog.querySelectorAll('.mb-canvas-question-option')) {
        label.querySelector('input').checked = ['题干', '参考答案'].includes(label.textContent.trim())
      }
      dialog.querySelector('.btn.primary').click()
    })()`)
    await until(`${viewport}?.textContent.includes('原参考答案')`, '筛选要显示的内容')
    assert.ok(!(await js(`${viewport}.textContent`)).includes('原作答过程'))
    assert.equal(await js(`${viewport}.querySelector('img') === null`), true, '筛选后隐藏题图')
    await click('[data-question-action=edit]')
    await until("Boolean(document.querySelector('.mb-canvas-question-field textarea'))", '画布内编辑对话框')
    window.webContents.setZoomFactor(1.25)
    await until('innerWidth === 832', '窄窗放大布局')
    assert.ok(await js(`(() => {
      const modal = document.querySelector('.mb-dialog[open]')
      const apply = modal.querySelector('.mb-canvas-question-form-actions .primary').getBoundingClientRect()
      return apply.bottom <= modal.getBoundingClientRect().bottom && apply.height > 0
    })()`), '长题编辑时应用按钮始终可见')
    window.webContents.setZoomFactor(1)
    await js(`(() => {
      const dialog = document.querySelector('.mb-dialog[open]')
      dialog.querySelector('.mb-canvas-question-field textarea').value = '仅画布使用的改写题干'
      dialog.querySelector('.btn.primary').click()
    })()`)
    await until(`${viewport}?.textContent.includes('仅画布使用的改写题干')`, '显示改写题干')
    await click('#mb-canvas-undo')
    await until(`${viewport}?.textContent.includes('题干末尾应保留。')`, '撤销画布内编辑')
    await click('#mb-canvas-redo')
    await until(`${viewport}?.textContent.includes('仅画布使用的改写题干')`, '重做画布内编辑')
    assert.equal((await api('read', { id: questionId })).result.stem, stem, '原错题题干保持原文')
    await shot('画布-A4-题目引用')
    await importImage()
    await until(imageReady, '第二页图片已导入')
    await click('#mb-canvas-back')
    await until("document.querySelector('#mb-canvas').hidden", '关闭包含错题的画布')
    await click('#mb-canvas-button')
    await until(`${viewport}?.textContent.includes('仅画布使用的改写题干')`, '重开画布恢复显示范围和本地文字')
    await until(imageReady, '重开画布恢复导入图片')
    assert.equal(await activePaper(), secondPaper, '重开画布恢复当前 A4 页')
    assert.ok(!(await js(`${viewport}.textContent`)).includes('原作答过程'))

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
