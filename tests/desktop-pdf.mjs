/**
 * 错题 PDF 导出的真实界面冒烟测试（Electron 主进程里跑，操作真实渲染器）。
 *
 * 真的点「导出错题 PDF…」、真的把题目勾进版面、真的拖动题目块、真的切字段与栏数，
 * 再让主进程用 printToPDF 落一份 PDF 到临时目录，回读字节确认是 PDF、页数与大小
 * 合理。仍然不碰本机资料库：数据库与 profile 都是 test-tmp 下的临时目录。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dialog } from 'electron'

// 1×1 的黑色 PNG：只用来验证「原图会进 PDF」，不关心画面内容。
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

export async function run(window, bridge) {
  assert.match(bridge.databasePath, /pdf-test[^\\/]*\.sqlite$/)
  const js = async source => {
    try { return await window.webContents.executeJavaScript(source) } catch (error) { throw new Error(`注入脚本失败：${error?.message ?? error}\n${source}`) }
  }
  const pause = ms => new Promise(resolvePause => setTimeout(resolvePause, ms))
  const until = async (expression, label = expression, tries = 500) => {
    for (let index = 0; index < tries; index++) {
      if (await js(expression)) return
      await pause(30)
    }
    throw new Error(`UI 超时：${label}；status=${await js("document.querySelector('#mb-status')?.textContent")}`)
  }
  const idle = () => until("!document.querySelector('.mb-shell')?.hasAttribute('aria-busy')", '笔记本空闲')
  const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const api = (action, body = {}) => js(`window.vault.notebook(${JSON.stringify(action)},${JSON.stringify(body)})`)
  const shotIndex = process.argv.indexOf('--shot')
  const shotDirectory = shotIndex > 0 && process.argv[shotIndex + 1] ? dirname(process.argv[shotIndex + 1]) : null
  const shot = async name => {
    if (!shotDirectory) return
    await pause(150)
    writeFileSync(join(shotDirectory, `${name}.png`), (await window.webContents.capturePage()).toPNG())
  }
  const openPdfView = async () => {
    await js("document.getElementById('mb-more').open = true")
    await until("Boolean(document.getElementById('mb-export-pdf'))", '导出 PDF 菜单项存在')
    await click('#mb-export-pdf')
    await until("document.getElementById('mb-pdf') && document.getElementById('mb-pdf').hidden === false", 'PDF 排版视图打开')
    await idle()
  }

  await until("document.querySelectorAll('#views button').length===4", '外壳就绪')
  await until("document.querySelector('#alaya-startup')===null", '启动动画结束')
  await until("document.body.dataset.mode==='mistakebook'", '进入笔记本')
  await idle()

  // —— 造三道题：带公式的错题、带原图的错题、一条普通笔记 ——
  const first = await api('save', {
    type: 'mistake', title: '第12题｜二次函数最值',
    stem: '已知 $f(x)=x^{2}-4x+3$，求 $f(x)$ 的最小值。',
    studentWork: '配方得 $(x-2)^{2}+1$，就停了。',
    referenceAnswer: '$f(x)=(x-2)^{2}-1$，最小值是 $-1$。',
    cause: '确定：配方后没有回到原式核对常数项。',
    tags: ['函数', '高一'],
  })
  assert.equal(first.ok, true, `创建错题失败：${first.error}`)
  const second = await api('save', {
    type: 'mistake', title: '第15题｜受力分析',
    stem: '斜面上的物块受到哪些力？画出受力示意图。',
    referenceAnswer: '重力、支持力、摩擦力，沿斜面方向合力为零。',
    images: [{ name: 'q15.png', mimeType: 'image/png', data: PNG }],
  })
  assert.equal(second.ok, true, `创建带原图的错题失败：${second.error}`)
  const third = await api('save', { type: 'note', title: '复盘：先写单位', stem: '每道计算题写完检查单位。' })
  assert.equal(third.ok, true, `创建笔记失败：${third.error}`)

  // —— 入口：打开排版视图 ——
  await openPdfView()
  const chrome = await js(`(()=>{
    const view = document.getElementById('mb-pdf')
    return {
      display: getComputedStyle(view).display,
      bar: getComputedStyle(document.querySelector('.mb-bar')).display,
      body: getComputedStyle(document.querySelector('.mb-body')).display,
      side: getComputedStyle(document.querySelector('.mb-pdf-side')).display,
      pool: document.querySelectorAll('[data-pool-add]').length,
      pages: document.querySelectorAll('.mb-pdf-page').length,
      pageWidth: document.querySelector('.mb-pdf-page')?.style.width,
    }
  })()`)
  assert.equal(chrome.display, 'flex', 'PDF 视图应铺满工作区')
  assert.equal(chrome.bar, 'none', '排版时应隐藏笔记工具栏')
  assert.equal(chrome.body, 'none', '排版时应隐藏笔记列表与编辑器')
  assert.equal(chrome.side, 'flex', '题池面板可见（说明 pdf-export.css 已加载）')
  assert.ok(chrome.pool >= 3, `题池应有 3 道笔记，实际 ${chrome.pool}`)
  assert.equal(chrome.pages, 1, '空白版面先给一页')
  assert.equal(chrome.pageWidth, '210mm', '默认 A4 竖版')
  assert.equal(await js("document.getElementById('mb-pdf-export').disabled"), true, '没有题目时导出按钮不可用')

  // —— 勾两道题进版面 ——
  await js(`document.querySelector('[data-pool-add="${first.result.id}"]').click()`)
  await until("document.querySelectorAll('[data-pdf-block]').length===1", '第一道题进版面')
  await idle()
  await js(`document.querySelector('[data-pool-add="${second.result.id}"]').click()`)
  await until("document.querySelectorAll('[data-pdf-block]').length===2", '第二道题进版面')
  await idle()
  await shot('pdf-layout-1')
  const placed = await js(`(()=>{
    const blocks = [...document.querySelectorAll('[data-pdf-block]')]
    return {
      count: blocks.length,
      lefts: blocks.map(node => node.style.left),
      tops: blocks.map(node => node.style.top),
      widths: blocks.map(node => node.style.width),
      images: document.querySelectorAll('.mb-pdf-block img').length,
      numbers: [...document.querySelectorAll('.mb-pdf-block-num')].map(node => node.textContent),
      hint: document.getElementById('mb-pdf-hint').textContent,
    }
  })()`)
  assert.equal(placed.count, 2)
  assert.ok(placed.lefts.every(value => value.endsWith('mm')), '题目块用毫米定位')
  assert.equal(placed.images, 1, '带原图的错题应显示原图')
  assert.deepEqual(placed.numbers, ['1', '2'], '题号按阅读顺序')
  assert.match(placed.hint, /共 2 道题/)

  // —— 字段开关：参考答案默认关闭，打开后立刻出现在版面与导出里 ——
  assert.equal(await js("Boolean(document.querySelector('.mb-pdf-block .blk-referenceAnswer'))"), false, '默认不显示参考答案')
  await js(`(()=>{const input=document.getElementById('mb-pdf-field-referenceAnswer');input.checked=true;input.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  await until("Boolean(document.querySelector('.mb-pdf-block .blk-referenceAnswer'))", '参考答案出现在版面')
  await idle()
  assert.match(await js("document.querySelector('.mb-pdf-block').innerText"), /最小值是/)

  // —— 栏数改成 1：结构性设置应重排，题目块占满内容宽（186mm） ——
  await js(`(()=>{const select=document.getElementById('mb-pdf-columns');select.value='1';select.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  await until("document.querySelector('[data-pdf-block]').style.width==='186mm'", '单栏重排后占满内容宽')
  await idle()
  // 自动重排的第二帧（按实测高度重排）要落完再拖，否则拖到的位置会被它覆盖。
  await pause(400)

  // —— 自由拖动：位移写回毫米坐标，并进入手工版面 ——
  const before = await js("(()=>{const n=document.querySelector('[data-pdf-block]');return {left:n.style.left,top:n.style.top}})()")
  const dragResult = await js(`(()=>{
    const node = document.querySelector('[data-pdf-block]')
    const box = node.getBoundingClientRect()
    const start = { x: box.left + 24, y: box.top + 12 }
    node.dispatchEvent(new PointerEvent('pointerdown', { bubbles:true, cancelable:true, button:0, pointerId:7, clientX:start.x, clientY:start.y }))
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles:true, pointerId:7, clientX:start.x + 46, clientY:start.y + 30 }))
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles:true, pointerId:7 }))
    return true
  })()`)
  assert.equal(dragResult, true)
  await pause(200)
  const after = await js("(()=>{const n=document.querySelector('[data-pdf-block]');return {left:n.style.left,top:n.style.top}})()")
  assert.notEqual(after.top, before.top, `拖动后纵坐标应变化：${before.top} → ${after.top}`)
  assert.match(after.top, /^-?\d+(\.\d+)?mm$/)
  await shot('pdf-layout-2')

  // —— 导出：让主进程真的 printToPDF 并落盘 ——
  const pdfPath = join(dirname(bridge.databasePath), 'export-test.pdf')
  const originalSave = dialog.showSaveDialog
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: pdfPath })
  try {
    await click('#mb-pdf-export')
    for (let index = 0; index < 300 && !existsSync(pdfPath); index++) await pause(100)
    await idle()
    assert.ok(existsSync(pdfPath), `PDF 应已落盘；status=${await js("document.getElementById('mb-status').textContent")}`)
    const bytes = readFileSync(pdfPath)
    assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-', '文件头必须是 PDF')
    assert.ok(bytes.length > 4000, `PDF 太小：${bytes.length} 字节`)
    assert.match(bytes.subarray(-2048).toString('latin1'), /%%EOF/, 'PDF 必须以 %%EOF 结束')
    const pages = (bytes.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length
    assert.ok(pages >= 1, `PDF 至少一页，实际识别到 ${pages} 页`)
    assert.match(await js("document.getElementById('mb-status').textContent"), /已导出 PDF/)
  } finally {
    dialog.showSaveDialog = originalSave
    rmSync(pdfPath, { force: true })
  }

  // —— 关掉再开：版式与题目沿用上次（写进笔记本偏好） ——
  await click('#mb-pdf-close')
  await until("document.getElementById('mb-pdf').hidden === true", 'PDF 视图关闭')
  const prefs = await api('list', { view: 'all' })
  assert.equal(prefs.ok, true)
  assert.ok(prefs.result.prefs?.pdf, '偏好里应保存 pdf 版面')
  assert.equal(prefs.result.prefs.pdf.blocks.length, 2, `应记住两道题的版面，实际 ${JSON.stringify(prefs.result.prefs.pdf?.blocks?.length)}`)
  await openPdfView()
  await until("document.querySelectorAll('[data-pdf-block]').length===2", '重新打开沿用上次版面')
  const restored = await js("(()=>{const n=document.querySelector('[data-pdf-block]');return {left:n.style.left,top:n.style.top}})()")
  assert.equal(restored.top, after.top, '重新打开后题目块位置应保持')
  assert.equal(await js("document.getElementById('mb-pdf-export').disabled"), false, '有题目时可以导出')
  await shot('pdf-layout-3')

  // —— op 层防御：空内容不给开保存框 ——
  const empty = await api('export.pdf', { html: '' })
  assert.equal(empty.ok, false)
  assert.match(empty.error, /排版内容为空/)

  // 收尾：关掉视图，避免影响同进程里的其它检查。
  await click('#mb-pdf-close')
  await until("document.getElementById('mb-pdf').hidden === true", 'PDF 视图最终关闭')
  console.log('desktop pdf: ok')
}
