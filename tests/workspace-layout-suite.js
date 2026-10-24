// 浏览器内验证 workspace-layout：真实样式表 + 真实模块，不需要 Electron。
// 数据库外壳与笔记本外壳同时存在，用来确认两套偏好不串域。
import {
  mountWorkspaceLayout, createStorageStore, createNotebookLayoutAdapter,
  normalizeLayout, layoutPreset, applyLayout,
  DB_LAYOUT_DEFAULTS, NOTEBOOK_LAYOUT_DEFAULTS, LAYOUT_LIMITS,
} from '/workspace-layout.js'

const pass = new URLSearchParams(location.search).get('pass') ?? 'default'
const output = document.querySelector('#result')
const assert = (condition, message) => { if (!condition) throw new Error(`${pass}: ${message}`) }
const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))
// headless --dump-dom 配 virtual-time 时 rAF 不一定被驱动，用 setTimeout 等一帧更稳。
const frame = () => tick(24)
const shell = document.querySelector('#db-shell')
const side = shell.querySelector('.side')
const workspace = shell.querySelector('.workspace')
const main = shell.querySelector('.main')
const drawer = shell.querySelector('#drawer')
// 分隔条与布局菜单由 mountWorkspaceLayout 创建，挂载后再取。
let sideSplitter, detailSplitter, menu, panel
const box = node => node.getBoundingClientRect()
const style = (node, property) => getComputedStyle(node)[property]
const near = (actual, expected, tolerance = 1.5) => Math.abs(actual - expected) <= tolerance
// CSS 用 min(<偏好>, 34vw/46vw) 兜住窄窗，断言同时覆盖偏好值与渲染值。
const renderedSide = value => Math.min(value, innerWidth * 0.34)
const renderedDetail = value => Math.min(value, innerWidth * 0.46)
const clampSide = value => Math.min(LAYOUT_LIMITS.sideW.max, Math.max(LAYOUT_LIMITS.sideW.min, Math.round(value / 2) * 2))
const clampDetail = value => Math.min(LAYOUT_LIMITS.detailW.max, Math.max(LAYOUT_LIMITS.detailW.min, Math.round(value / 2) * 2))
// 两个「位置」控件靠 aria-label 区分：侧栏位置 / 详情面板位置。
const segment = (label, value) => panel.querySelector(`.ws-seg[aria-label="${label}"] .ws-segment[data-value="${value}"]`)
const drag = (node, from, to) => {
  node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, button: 0, clientX: from, clientY: 240 }))
  node.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: to, clientY: 240 }))
  node.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientX: to, clientY: 240 }))
}
const press = (node, key, extra = {}) => node.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, ...extra }))
// 拖动结束后的写入是防抖的，等它落盘再断言。
const settled = async () => { await tick(260); await frame() }
const stored = () => JSON.parse(localStorage.getItem('alaya.db.layout'))

try {
  // ---------- 纯函数 ----------
  assert(normalizeLayout({ sideW: 9999 }, DB_LAYOUT_DEFAULTS).sideW === LAYOUT_LIMITS.sideW.max, 'clamp above max')
  assert(normalizeLayout({ sideW: 10 }, DB_LAYOUT_DEFAULTS).sideW === LAYOUT_LIMITS.sideW.min, 'clamp below min')
  assert(normalizeLayout({ sideW: 'wide' }, DB_LAYOUT_DEFAULTS).sideW === DB_LAYOUT_DEFAULTS.sideW, 'reject non numeric width')
  assert(normalizeLayout({ density: 'dense' }, DB_LAYOUT_DEFAULTS).density === 'comfortable', 'reject unknown density')
  assert(normalizeLayout({ sideCollapsed: 'yes' }, DB_LAYOUT_DEFAULTS).sideCollapsed === false, 'reject non boolean flag')
  assert(normalizeLayout(null).sideW === DB_LAYOUT_DEFAULTS.sideW, 'null input falls back')
  assert(layoutPreset('wide', DB_LAYOUT_DEFAULTS).pageWidth === 'wide', 'wide preset')
  assert(layoutPreset('compact', DB_LAYOUT_DEFAULTS).density === 'compact', 'compact preset')
  assert(layoutPreset('focus', DB_LAYOUT_DEFAULTS).focus === true, 'focus preset')
  assert(layoutPreset('compact', NOTEBOOK_LAYOUT_DEFAULTS).sideW === 180, 'preset is relative to each domain default')

  // ---------- 挂载：默认值 ----------
  const layout = mountWorkspaceLayout({
    shell,
    host: document.querySelector('#layout-host'),
    store: createStorageStore(),
    expandHost: shell.querySelector('.bar .breadcrumb'),
    focusExitHost: shell.querySelector('.bar .toolbar-actions'),
    escapeGuard: () => true,
    onStatus: () => {},
  })
  sideSplitter = shell.querySelector('#side-splitter')
  detailSplitter = shell.querySelector('#detail-splitter')
  menu = shell.querySelector('#layout-menu')
  panel = menu?.querySelector('.ws-panel')
  assert(menu && panel, 'layout menu created')
  assert(sideSplitter && detailSplitter, 'splitters created')
  assert(near(box(side).width, renderedSide(222)), `default side renders 222 (or 34vw in a tight window), got ${box(side).width}`)
  assert(style(detailSplitter, 'display') === 'none', 'detail splitter hidden while the editor is closed')
  assert(sideSplitter.getAttribute('role') === 'separator' && sideSplitter.getAttribute('aria-valuenow') === '222', 'splitter exposes ARIA value')
  assert(sideSplitter.tabIndex === 0, 'splitter is keyboard reachable')
  assert(layout.prefs().sideW === 222 && layout.prefs().detailSide === 'right', 'defaults exposed by the API')
  if (pass === 'tight') {
    assert(box(side).width < 222, 'a tight window shrinks the sidebar below its preference')
    assert(document.documentElement.scrollWidth <= innerWidth + 1, 'no horizontal overflow at 620px')
  }

  // ---------- 拖拽 ----------
  drag(sideSplitter, 500, 560)
  await frame()
  assert(layout.prefs().sideW === 282, `drag widens the side to 282, got ${layout.prefs().sideW}`)
  assert(near(box(side).width, renderedSide(282)), 'rendered width follows the preference')
  assert(sideSplitter.getAttribute('aria-valuenow') === '282', 'ARIA value tracks the drag')
  await settled()
  assert(stored().sideW === 282, 'drag persists to storage')
  drag(sideSplitter, 500, 900)
  await settled()
  assert(layout.prefs().sideW === LAYOUT_LIMITS.sideW.max, 'drag clamps at max')
  drag(sideSplitter, 900, -400)
  await settled()
  assert(layout.prefs().sideW === LAYOUT_LIMITS.sideW.min, 'drag clamps at min')
  assert(document.documentElement.scrollWidth <= innerWidth + 1, 'no horizontal overflow after dragging')

  // ---------- 键盘 ----------
  sideSplitter.focus()
  press(sideSplitter, 'ArrowRight')
  assert(layout.prefs().sideW === LAYOUT_LIMITS.sideW.min + 12, 'ArrowRight widens by 12')
  press(sideSplitter, 'ArrowLeft')
  assert(layout.prefs().sideW === LAYOUT_LIMITS.sideW.min, 'ArrowLeft narrows by 12')
  press(sideSplitter, 'End')
  assert(layout.prefs().sideW === LAYOUT_LIMITS.sideW.max, 'End jumps to max')
  press(sideSplitter, 'Enter')
  assert(layout.prefs().sideW === 222 && near(box(side).width, renderedSide(222)), 'Enter restores the default width')
  press(sideSplitter, 'Home')
  assert(layout.prefs().sideW === LAYOUT_LIMITS.sideW.min, 'Home jumps to min')
  press(sideSplitter, 'Enter')
  assert(document.activeElement === sideSplitter, 'focus stays on the separator')

  // ---------- 侧栏换边 ----------
  menu.open = true
  await frame()
  assert(panel.getClientRects().length > 0, 'panel visible when open')
  assert(box(panel).right <= innerWidth + 1 && box(panel).left >= -1, 'panel stays inside a narrow window')
  segment('侧栏位置', 'right').click()
  assert(shell.dataset.sideSide === 'right', 'side side recorded')
  assert(box(side).left > box(workspace).left, 'side moves to the right of the workspace')
  const sideBefore = layout.prefs().sideW
  drag(sideSplitter, 400, 360)
  await settled()
  assert(layout.prefs().sideW === clampSide(sideBefore + 40), 'drag direction inverts on the right side')
  segment('侧栏位置', 'left').click()
  assert(near(box(side).left, 0), 'side returns to the left edge')

  // ---------- 详情面板 ----------
  drawer.classList.remove('hidden')
  await frame()
  assert(style(detailSplitter, 'display') !== 'none', 'detail splitter appears with the editor')
  assert(box(detailSplitter).left > box(main).left, 'detail splitter sits at the editor edge')
  segment('详情面板位置', 'left').click()
  assert(box(drawer).left < box(main).left, 'editor moves left of the content')
  assert(shell.dataset.detailSide === 'left', 'detail side recorded')
  const detailBefore = layout.prefs().detailW
  drag(detailSplitter, 400, 470)
  await settled()
  assert(layout.prefs().detailW === clampDetail(detailBefore + 70), 'detail drag widens from the left')
  assert(near(box(drawer).width, renderedDetail(layout.prefs().detailW)), 'rendered editor width follows the preference')
  assert(document.documentElement.scrollWidth <= innerWidth + 1, 'no overflow with the editor on the left')
  segment('详情面板位置', 'right').click()
  assert(shell.dataset.detailSide === 'right', 'detail side back to right')
  drawer.classList.add('hidden')
  await frame()
  assert(style(detailSplitter, 'display') === 'none', 'detail splitter hides again with the editor')

  // ---------- 页面宽度与密度 ----------
  const paddingFor = value => { segment('页面宽度', value).click(); return parseFloat(style(main, 'paddingLeft')) }
  const comfortablePadding = paddingFor('comfortable')
  const widePadding = paddingFor('wide')
  const fullPadding = paddingFor('full')
  assert(fullPadding === 31, 'full width keeps the base padding')
  assert(comfortablePadding >= widePadding && widePadding >= fullPadding, 'page width narrows the reading column as it gets more comfortable')
  assert(shell.dataset.pageWidth === 'full', 'page width recorded')
  segment('页面宽度', 'comfortable').click()
  const tile = shell.querySelector('.tile')
  const grid = shell.querySelector('.grid')
  const comfortableTile = box(tile).width
  segment('卡片密度', 'compact').click()
  await frame()
  assert(shell.dataset.density === 'compact', 'density recorded')
  // 单列时卡宽等于容器宽，密度体现在行高、间距与卡片内边距上；多列时列数也会变。
  const columns = style(grid, 'gridTemplateColumns').split(' ').length
  if (columns > 1) assert(box(tile).width < comfortableTile, `compact density tightens the card grid (${box(tile).width} vs ${comfortableTile})`)
  assert(parseFloat(style(grid, 'columnGap')) === 10, 'compact density tightens the grid gap')
  assert(parseFloat(style(tile, 'minHeight')) === 178, 'compact density lowers the card height')
  assert(parseFloat(style(tile, 'paddingTop')) < 18, 'compact density reduces tile padding')
  segment('卡片密度', 'comfortable').click()
  assert(box(tile).width === comfortableTile, 'comfortable density restores the card width')
  assert(parseFloat(style(tile, 'minHeight')) > 178, `comfortable density restores the card height (${style(tile, 'minHeight')}, ${shell.dataset.density})`)

  // ---------- 折叠与专注 ----------
  panel.querySelector('#layout-side-collapsed').click()
  await frame()
  assert(style(side, 'display') === 'none', 'collapsed side is hidden')
  const expand = shell.querySelector('.ws-expand')
  assert(style(expand, 'display') !== 'none', 'expand affordance appears')
  assert(near(box(workspace).left, 0), 'content reclaims the sidebar space')
  expand.click()
  await frame()
  assert(style(side, 'display') === 'flex', 'expand restores the sidebar')

  panel.querySelector('#layout-focus').click()
  await frame()
  assert(shell.dataset.focus === 'on', 'focus recorded')
  assert(style(side, 'display') === 'none' && style(drawer, 'display') === 'none', 'focus hides both panels')
  assert(shell.querySelector('.ws-focus-exit').getClientRects().length > 0, 'focus exit affordance is visible')
  press(document, 'Escape')
  await frame()
  assert(shell.dataset.focus === 'off', 'Escape leaves focus mode')
  assert(style(side, 'display') === 'flex', 'the sidebar comes back after focus mode')

  // ---------- 面板交互 ----------
  // 拖分隔条、点面板外都会关闭这个 popover，所以每段交互前重新打开。
  menu.open = false
  await frame()
  menu.open = true
  await frame()
  press(document, 'Escape')
  assert(!menu.open, 'Escape closes the layout panel')
  assert(document.activeElement.id === 'layout-toggle', 'focus returns to the layout trigger')
  menu.open = true
  await frame()
  document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 2, clientY: 2 }))
  assert(!menu.open, 'clicking outside closes the panel')

  // ---------- 预设与恢复默认 ----------
  menu.open = true
  await frame()
  panel.querySelector('.ws-preset[data-value="wide"]').click()
  await settled()
  assert(shell.dataset.pageWidth === 'wide' && shell.dataset.density === 'comfortable', 'wide preset applies page width')
  assert(stored().pageWidth === 'wide', 'preset persists')
  panel.querySelector('.ws-preset[data-value="focus"]').click()
  await frame()
  assert(shell.dataset.focus === 'on', 'focus preset enables focus mode')
  panel.querySelector('.ws-preset[data-value="default"]').click()
  await settled()
  assert(shell.dataset.focus === 'off' && layout.prefs().sideW === 222, 'default preset restores the baseline')

  const slider = panel.querySelector('#layout-side-width')
  slider.value = '300'
  slider.dispatchEvent(new Event('input', { bubbles: true }))
  slider.dispatchEvent(new Event('change', { bubbles: true }))
  await settled()
  assert(stored().sideW === 300, 'slider writes the width')
  assert(layout.prefs().sideW === 300 && near(box(side).width, renderedSide(300)), 'slider applies the width immediately')
  panel.querySelector('#layout-reset').click()
  await settled()
  assert(layout.prefs().sideW === 222 && stored().sideW === 222, 'reset restores and rewrites the default width')
  assert(panel.querySelector('#layout-side-width').value === '222', 'reset syncs the slider back')

  // ---------- 可访问性 ----------
  const focusable = [...panel.querySelectorAll('button, input')]
  assert(focusable.length >= 10, 'panel exposes every control')
  assert(focusable.every(node => node.tabIndex >= 0 && !node.disabled), 'every control is focusable and enabled')
  assert([...panel.querySelectorAll('.ws-segment')].every(node => ['true', 'false'].includes(node.getAttribute('aria-pressed'))), 'segments expose aria-pressed')
  assert([...panel.querySelectorAll('input')].every(node => node.id && panel.querySelector(`label[for="${node.id}"]`)), 'every input has a label')
  assert(!panel.querySelector('script'), 'panel never renders HTML from data')

  // ---------- 减少动态效果 ----------
  if (pass === 'reduced') {
    assert(matchMedia('(prefers-reduced-motion: reduce)').matches, 'reduced motion media query active')
    assert(style(panel.querySelector('.ws-segment'), 'transitionDuration') === '0s', 'segment transitions removed')
    assert(style(panel.querySelector('.ws-preset'), 'transitionDuration') === '0s', 'preset transitions removed')
  }

  // ---------- 笔记本适配器：不串域 ----------
  const mbShell = document.querySelector('#mb-shell')
  const mbWrites = []
  const mbPrefs = { order: 'priority', sideW: 220, detailW: 440, detailSide: 'right' }
  const adapter = createNotebookLayoutAdapter({
    shell: mbShell,
    read: () => mbPrefs,
    write: next => { mbWrites.push({ ...next }); Object.assign(mbPrefs, next) },
    menuHost: document.querySelector('#mb-layout-host'),
    focusExitHost: document.querySelector('#mb-toolbar'),
    escapeGuard: () => true,
  })
  assert(mbShell.style.getPropertyValue('--mb-side-w').trim() === '220px', 'notebook side width var applied')
  assert(mbShell.style.getPropertyValue('--mb-detail-w').trim() === '440px', 'notebook detail width var applied')
  assert(document.querySelector('#mb-layout-menu') && !menu.contains(document.querySelector('#mb-layout-menu')), 'notebook menu is a separate instance')
  const databaseKey = localStorage.getItem('alaya.db.layout')
  adapter.set({ detailSide: 'left' })
  assert(mbShell.classList.contains('detail-left'), 'notebook detail side uses its existing class')
  assert(mbWrites.at(-1).detailSide === 'left' && mbWrites.at(-1).order === 'priority', 'notebook write keeps foreign prefs')
  assert(localStorage.getItem('alaya.db.layout') === databaseKey, 'notebook prefs never touch the database key')
  adapter.set({ sideCollapsed: true })
  assert(mbShell.dataset.mbSide === 'collapsed', 'notebook collapse recorded')
  assert(style(document.querySelector('#mb-side'), 'display') === 'none', 'notebook side hidden by the shared stylesheet')
  adapter.set({ sideCollapsed: false, focus: true })
  assert(mbShell.dataset.mbFocus === 'on', 'notebook focus recorded')
  assert(style(document.querySelector('#mb-detail'), 'display') === 'none', 'notebook detail hidden in focus mode')
  assert(document.querySelector('#mb-toolbar .ws-focus-exit').getClientRects().length > 0, 'notebook focus exit affordance visible')
  adapter.set({ focus: false, pageWidth: 'wide', density: 'compact' })
  assert(mbShell.dataset.mbPage === 'wide' && mbShell.dataset.mbDensity === 'compact', 'notebook page width and density recorded')
  const mbMain = document.querySelector('#mb-main')
  const widePaddingPx = parseFloat(style(mbMain, 'paddingLeft'))
  adapter.set({ pageWidth: 'full' })
  const fullPaddingPx = parseFloat(style(mbMain, 'paddingLeft'))
  assert(widePaddingPx >= fullPaddingPx, 'notebook page width changes the reading column')
  adapter.reset()
  assert(mbShell.style.getPropertyValue('--mb-side-w').trim() === '220px' && mbShell.dataset.mbFocus === 'off', 'notebook reset restores defaults')
  adapter.destroy()
  assert(mbWrites.length >= 4 && mbWrites.every(entry => 'order' in entry), 'every notebook write keeps the caller payload')

  // ---------- 重新挂载：偏好从存储恢复 ----------
  const kept = stored()
  const fresh = document.createElement('div')
  fresh.className = 'app-shell'
  fresh.innerHTML = '<aside class="side"></aside><div class="workspace"><div class="body"><main class="main"></main></div></div>'
  document.body.append(fresh)
  const remount = mountWorkspaceLayout({ shell: fresh, store: createStorageStore() })
  assert(fresh.style.getPropertyValue('--alaya-side-w').trim() === `${kept.sideW}px`, 'remount reads the stored width')
  assert(fresh.dataset.pageWidth === kept.pageWidth, 'remount reads the stored page width')
  remount.destroy()
  fresh.remove()

  applyLayout(shell, normalizeLayout(DB_LAYOUT_DEFAULTS))
  output.textContent = `PASS: ${pass} ${innerWidth}x${innerHeight} · 拖拽/键盘/换边/详情/页面宽度/密度/折叠与专注/Esc/预设/恢复默认/ARIA/存储隔离/笔记本适配器`
} catch (error) {
  output.textContent = `FAIL: ${error.stack ?? error}`
}
