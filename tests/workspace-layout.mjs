import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { app } from 'electron'

/** 在真实 Electron 渲染进程里验证数据库布局：显式入口、拖拽、换边、折叠/专注、预设/恢复、重载持久化、窄窗不溢出。 */
export async function run(window, bridge) {
  assert.match(bridge.databasePath, /workspace-layout-test[^\\/]*\.sqlite$/, 'The layout suite requires a test database')
  const profileArg = process.argv.indexOf('--user-data')
  assert.ok(profileArg >= 0, 'The layout suite requires an explicit isolated --user-data path')
  const profile = resolve(process.argv[profileArg + 1])
  assert.match(profile.replace(/\\/g, '/'), /\/work\//i)
  assert.equal(resolve(app.getPath('userData')).toLowerCase(), profile.toLowerCase())

  const js = source => window.webContents.executeJavaScript(source)
  const pause = ms => new Promise(resolvePause => setTimeout(resolvePause, ms))
  const until = async expression => {
    for (let attempt = 0; attempt < 320; attempt++) {
      if (await js(expression)) return
      await pause(25)
    }
    const status = await js("[document.querySelector('#status')?.textContent, document.querySelector('#mb-status')?.textContent].filter(Boolean).join(' | ')")
    throw new Error(`Layout timeout: ${expression}; ${status}`)
  }
  const closeSettings=()=>js(`document.querySelector('#modal[open]')?.close()`)
  const click = async selector => {
    if(selector.startsWith('#layout-'))await openPanel()
    else await closeSettings()
    return js(`document.querySelector(${JSON.stringify(selector)}).click()`)
  }
  const exists = selector => js(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)
  const rect = selector => js(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return null; const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width, height: r.height, top: r.top, bottom: r.bottom, display: getComputedStyle(node).display } })()`)
  const stored = () => js("JSON.parse(localStorage.getItem('alaya.db.layout'))")
  const styleOf = (selector, property) => js(`getComputedStyle(document.querySelector(${JSON.stringify(selector)}))[${JSON.stringify(property)}]`)
  const openPanel = async () => {
    if(!await js(`Boolean(document.querySelector('#modal[open] #layout-menu'))`)){
      await js(`document.querySelector('#workspace-settings').click()`)
      await until(`Boolean(document.querySelector('#tab-layout'))`)
    }
    await js(`document.querySelector('#tab-layout').click()`)
    await pause(40)
  }
  const segment = (label, value) => `#layout-menu .ws-seg[aria-label="${label}"] .ws-segment[data-value="${value}"]`
  const settle = async () => { await pause(260) }
  const resize = async (width, height) => {
    window.setContentSize(width, height)
    await until(`innerWidth===${width} && innerHeight===${height}`)
    await pause(120)
  }
  const idle = () => until("!document.querySelector('#alaya-startup') && document.querySelectorAll('#views button').length===4")
  const memoryMode = async () => {
    if (await js("document.body.dataset.mode === 'memory'")) return
    await click('#mb-mode-switch')
    await until("document.body.dataset.mode === 'memory'")
  }

  let entryId
  try {
    await idle()
    await memoryMode()
    // 笔记本偏好是独立数据域：数据库布局怎么改都不应该写到它上面。
    const notebookBefore = await js("window.vault.invoke('notebook.settings', {}).then(reply => reply.ok ? JSON.stringify(reply.result) : null)")
    entryId = (await bridge.invoke('entry.write', { group: '知识库', title: `workspace-layout-${Date.now()}`, content: '布局集成测试用的临时记忆。' })).entry.id
    await click('#refresh')
    await until(`document.querySelectorAll('#list [data-id]').length >= 1`)

    // ---------- 显式入口与默认值 ----------
    await openPanel()
    assert.equal(await exists('#settings-layout #layout-menu'), true, 'layout belongs in the Settings panel')
    assert.equal(await exists('#side-splitter'), true, 'the sidebar splitter must exist')
    assert.equal(await exists('#detail-splitter'), true, 'the detail splitter must exist')
    assert.equal((await rect('.side')).width, 222, 'default sidebar width')
    assert.equal((await rect('#detail-splitter')).display, 'none', 'the detail splitter stays hidden without an editor')
    assert.equal(await js("document.querySelector('#layout-menu .ws-layout-trigger').textContent.includes('布局')"), true, 'the trigger is labelled')
    assert.equal(await js("document.querySelector('#layout-menu').querySelectorAll('.ws-panel button, .ws-panel input').length >= 10"), true, 'every control is present')

    // ---------- 预设、换边、拖拽 ----------
    await openPanel()
    await click('#layout-menu .ws-preset[data-value="wide"]')
    await settle()
    assert.equal(await js("document.querySelector('.app-shell').dataset.pageWidth"), 'wide', 'the wide preset sets the page width')
    await click(segment('侧栏位置', 'right'))
    assert.equal(await js("document.querySelector('.app-shell').dataset.sideSide"), 'right', 'the sidebar can move right')
    assert.ok((await rect('.side')).left > (await rect('.workspace')).left, 'the sidebar renders on the right')
    const widthBeforeDrag = (await stored()).sideW
    await js(`(() => {
      const node = document.querySelector('#side-splitter'), box = node.getBoundingClientRect();
      node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, button: 0, clientX: box.left + 3, clientY: 200 }));
      node.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: box.left - 37, clientY: 200 }));
      node.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientX: box.left - 37, clientY: 200 }));
    })()`)
    await settle()
    assert.equal((await stored()).sideW, widthBeforeDrag + 40, `dragging the right-hand splitter widens the sidebar (${JSON.stringify(await stored())})`)
    await click(segment('侧栏位置', 'left'))
    assert.ok((await rect('.side')).left === 0, 'the sidebar returns to the left edge')

    // ---------- 详情面板 ----------
    await click('#list [data-id]')
    await until("!document.querySelector('#drawer').classList.contains('hidden')")
    assert.notEqual((await rect('#detail-splitter')).display, 'none', 'the detail splitter appears with the editor')
    await click(segment('详情面板位置', 'left'))
    assert.ok((await rect('#drawer')).left < (await rect('.main')).left, 'the editor can sit left of the content')
    await click(segment('详情面板位置', 'right'))
    assert.equal(await js("document.querySelector('.app-shell').dataset.detailSide"), 'right', 'the editor returns to the right')
    await js("document.querySelector('#drawer .drawer-head .icon-button')?.click()").catch(() => {})
    await pause(80)

    // ---------- 页面宽度与密度 ----------
    await click(segment('页面宽度', 'full'))
    assert.equal(parseFloat(await styleOf('.main', 'paddingLeft')), 31, 'full page width uses the base padding')
    await click(segment('页面宽度', 'comfortable'))
    // 舒适列已扩为 1200px；在有足够内容宽度的窗口验证居中上限。
    await resize(1680,940)
    assert.ok(parseFloat(await styleOf('.main', 'paddingLeft')) > 31, 'comfortable page width centres a narrower column')
    await resize(1440,940)
    await click(segment('卡片密度', 'compact'))
    assert.equal(await js("document.querySelector('.app-shell').dataset.density"), 'compact', 'compact density is recorded')
    assert.equal(parseFloat(await styleOf('.grid', 'columnGap')), 10, 'compact density tightens the grid')
    await click(segment('卡片密度', 'comfortable'))

    // ---------- 折叠与专注 ----------
    await click('#layout-side-collapsed')
    assert.equal((await rect('.side')).display, 'none', 'collapsing hides the sidebar')
    assert.notEqual((await rect('.ws-expand')).display, 'none', 'an expand affordance appears')
    await click('.ws-expand')
    assert.equal((await rect('.side')).display, 'flex', 'expanding restores the sidebar')
    await click('#layout-focus')
    await closeSettings()
    assert.equal(await js("document.querySelector('.app-shell').dataset.focus"), 'on', 'focus mode is recorded')
    assert.equal((await rect('.side')).display, 'none', 'focus mode hides the sidebar')
    assert.notEqual((await rect('.ws-focus-exit')).display, 'none', 'focus mode offers an exit affordance')
    await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))")
    await pause(60)
    assert.equal(await js("document.querySelector('.app-shell').dataset.focus"), 'off', 'Escape leaves focus mode')
    assert.equal((await rect('.side')).display, 'flex', 'the sidebar returns after focus mode')

    // ---------- 恢复默认 ----------
    await click('#layout-reset')
    await settle()
    assert.equal((await stored()).sideW, 222, 'reset restores the default width')
    assert.equal((await stored()).pageWidth, 'comfortable', 'reset restores the default page width')
    assert.equal((await rect('.side')).width, 222, 'reset re-renders the default width')

    // ---------- 窄窗 ----------
    await resize(1040, 650)
    assert.equal(await js('document.documentElement.scrollWidth <= innerWidth + 1'), true, 'no horizontal overflow at 1040×650')
    await openPanel()
    const panel = await rect('#layout-menu .ws-panel')
    assert.ok(panel.left >= -1 && panel.right <= 1040 + 1, `the layout panel stays inside 1040×650 (${panel.left}..${panel.right})`)
    const controlsInside = await js(`(() => {
      const panel = document.querySelector('#layout-menu .ws-panel');
      const panelRect = document.querySelector('#modal').getBoundingClientRect();
      if (panelRect.left < -1 || panelRect.right > innerWidth + 1 || panelRect.top < -1 || panelRect.bottom > innerHeight + 1) return 'panel outside the window: ' + JSON.stringify(panelRect);
      // 面板自身可滚动：每个控件滚进可视区后都必须完整可见、尺寸可点。
      for (const node of panel.querySelectorAll('button, input')) {
        const target = node.tagName === 'INPUT' ? (node.closest('label') ?? node) : node;
        target.scrollIntoView({ block: 'nearest' });
        const r = target.getBoundingClientRect();
        const minimum = node.tagName === 'BUTTON' ? 20 : 12;
        if (r.width < minimum || r.height < minimum) return 'control too small: ' + (node.id || node.textContent) + ' ' + Math.round(r.width) + '×' + Math.round(r.height);
        if (r.top < -1 || r.bottom > innerHeight + 1 || r.left < -1 || r.right > innerWidth + 1) return 'control unreachable: ' + (node.id || node.textContent) + ' ' + Math.round(r.top) + '..' + Math.round(r.bottom);
      }
      return 'ok';
    })()`)
    assert.equal(controlsInside, 'ok', `every layout control is reachable at 1040×650 (${controlsInside})`)
    await resize(1440, 940)
    await closeSettings()

    // ---------- 键盘 ----------
    await js("document.querySelector('#side-splitter').focus()")
    await js("document.querySelector('#side-splitter').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }))")
    await settle()
    assert.equal((await stored()).sideW, 340, 'End widens the sidebar to the maximum')
    await js("document.querySelector('#side-splitter').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))")
    await settle()
    assert.equal((await stored()).sideW, 222, 'Enter restores the default width from the keyboard')

    // ---------- 重载后仍然生效 ----------
    await openPanel()
    await js("document.querySelector('#layout-side-width').value = '300'; document.querySelector('#layout-side-width').dispatchEvent(new Event('input')); document.querySelector('#layout-side-width').dispatchEvent(new Event('change'))")
    await click(segment('页面宽度', 'wide'))
    await settle()
    assert.equal((await stored()).sideW, 300, 'the slider writes the width')
    window.webContents.reload()
    await idle()
    await memoryMode()
    assert.equal((await stored()).sideW, 300, 'the stored width survives a reload')
    assert.equal(await js("document.querySelector('.app-shell').style.getPropertyValue('--alaya-side-w')"), '300px', 'the reloaded renderer applies the stored width')
    assert.equal(await js("document.querySelector('.app-shell').dataset.pageWidth"), 'wide', 'the stored page width survives a reload')

    // ---------- 不串域 ----------
    assert.equal(await js("Boolean(localStorage.getItem('alaya.db.layout'))"), true, 'database layout prefs live under their own renderer key')
    const notebookAfter = await js("window.vault.invoke('notebook.settings', {}).then(reply => reply.ok ? JSON.stringify(reply.result) : null)")
    if (notebookBefore !== null && notebookAfter !== null) assert.equal(notebookAfter, notebookBefore, 'database layout changes never touch notebook preferences')
    // 数据库属性只写在 .app-shell 上，笔记本外壳（.mb-shell）不应收到任何一条。
    assert.equal(await js("(() => { const shell = document.querySelector('.mb-shell'); if (!shell) return 'missing'; return !shell.hasAttribute('data-density') && !shell.hasAttribute('data-side') && !shell.hasAttribute('data-page-width') })()"), true, 'the notebook shell never receives database layout attributes')

    console.log('Desktop workspace layout: explicit menu, drag/keyboard widths, side and editor positions, page width, density, collapse, focus + Escape, presets, reset, reload persistence and 1040×650 fit verified; notebook preferences untouched')
  } finally {
    if (entryId) await bridge.invoke('entry.delete', { id: entryId }).catch(() => {})
  }
}
