// 可复用工作区布局模块：面板宽度/位置、折叠、专注、页面宽度、密度与预设。
// 数据库与笔记本共用同一套实现，但各存各的偏好：
//   · 数据库：createStorageStore()（渲染层 localStorage，键 alaya.db.layout），
//     不写入数据库文件，也不进入备份/导出的数据域。
//   · 笔记本：createNotebookLayoutAdapter() 由调用方注入 read/write，
//     现有实现写入笔记本库的 prefs（notebook.prefs.save）。
// 模块本身不保存任何东西，也不假设面板内部结构——只写 CSS 变量、
// data-* 属性与少量自定义类名，由 workspace-layout.css 解释。
import { attachSplitter } from './layout.js'

export const LAYOUT_SCHEMA = 1

export const LAYOUT_LIMITS = Object.freeze({
  sideW: Object.freeze({ min: 170, max: 340, step: 2, fallback: 222 }),
  detailW: Object.freeze({ min: 300, max: 620, step: 2, fallback: 410 }),
})

export const DB_LAYOUT_DEFAULTS = Object.freeze({
  schema: LAYOUT_SCHEMA,
  sideW: 222,
  detailW: 410,
  sideSide: 'left',
  detailSide: 'right',
  sideCollapsed: false,
  focus: false,
  pageWidth: 'comfortable',
  density: 'comfortable',
})

export const NOTEBOOK_LAYOUT_DEFAULTS = Object.freeze({ ...DB_LAYOUT_DEFAULTS, sideW: 220, detailW: 440 })

// 笔记本侧不默认开放 sideSide：侧栏换边要求调用方把分隔条也放在能换位的位置，
// 否则视觉上会出现两段间距错位。需要时显式传 features 打开。
export const LAYOUT_FEATURES = Object.freeze(['presets', 'sideW', 'sideSide', 'sideCollapsed', 'detailW', 'detailSide', 'pageWidth', 'density', 'focus'])
export const NOTEBOOK_FEATURES = Object.freeze(['presets', 'sideW', 'sideCollapsed', 'detailW', 'detailSide', 'pageWidth', 'density', 'focus'])

const PAGE_WIDTHS = Object.freeze({ comfortable: '适中', wide: '宽', full: '满' })
const DENSITIES = Object.freeze({ comfortable: '舒适', compact: '紧凑' })
const PRESETS = Object.freeze([['default', '默认'], ['compact', '紧凑'], ['wide', '宽屏'], ['focus', '专注']])

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = value
    else if (key === 'value') node.value = value
    else if (key === 'checked') node.checked = Boolean(value)
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value)
    else node.setAttribute(key, String(value))
  }
  for (const child of children.flat(Infinity)) if (child !== null && child !== undefined && child !== false) node.append(child instanceof Node ? child : String(child))
  return node
}

export function clampWidth(value, limits = LAYOUT_LIMITS.sideW) {
  const { min = 0, max = 4000, step = 1, fallback } = limits ?? {}
  let number = Number(value)
  // 非数字（旧配置、手改过的 JSON、null / '' 这类「空值」）回到该面板的默认宽度，
  // 而不是悄悄变成最窄——Number(null) === 0、Number('') === 0 是经典陷阱。
  if (value === null || value === undefined || value === '' || !Number.isFinite(number)) {
    number = Number.isFinite(Number(fallback)) ? Number(fallback) : min
  }
  const stepped = step > 1 ? Math.round(number / step) * step : Math.round(number)
  return Math.min(max, Math.max(min, stepped))
}

// 把任意来源（localStorage JSON、数据库 prefs、手改过的对象）收敛成合法布局偏好。
export function normalizeLayout(input, defaults = DB_LAYOUT_DEFAULTS) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const base = { ...defaults }
  const pick = (key, allowed) => (allowed.includes(source[key]) ? source[key] : base[key])
  const flag = key => (typeof source[key] === 'boolean' ? source[key] : base[key] === true)
  const width = key => {
    const value = source[key]
    const numeric = value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
    return clampWidth(numeric ? Number(value) : base[key], LAYOUT_LIMITS[key])
  }
  return {
    schema: LAYOUT_SCHEMA,
    sideW: width('sideW'),
    detailW: width('detailW'),
    sideSide: pick('sideSide', ['left', 'right']),
    detailSide: pick('detailSide', ['left', 'right']),
    sideCollapsed: flag('sideCollapsed'),
    focus: flag('focus'),
    pageWidth: pick('pageWidth', Object.keys(PAGE_WIDTHS)),
    density: pick('density', Object.keys(DENSITIES)),
  }
}

// 预设以 defaults 为基准做相对调整，数据库（222/410）与笔记本（220/440）各自成立。
export function layoutPreset(name, defaults = DB_LAYOUT_DEFAULTS) {
  const base = normalizeLayout(defaults, defaults)
  if (name === 'compact') return { ...base, sideW: clampWidth(base.sideW - 40, LAYOUT_LIMITS.sideW), detailW: clampWidth(base.detailW - 60, LAYOUT_LIMITS.detailW), density: 'compact', pageWidth: 'comfortable', sideCollapsed: false, focus: false }
  if (name === 'wide') return { ...base, sideW: clampWidth(base.sideW + 26, LAYOUT_LIMITS.sideW), detailW: clampWidth(base.detailW + 60, LAYOUT_LIMITS.detailW), pageWidth: 'wide', density: 'comfortable', sideCollapsed: false, focus: false }
  if (name === 'focus') return { ...base, focus: true, sideCollapsed: false }
  return { ...base, focus: false }
}

// 数据库侧的偏好后端：只写渲染层 localStorage，不碰数据库文件与备份域。
export function createStorageStore({ area = globalThis.localStorage, key = 'alaya.db.layout' } = {}) {
  return {
    load: () => { try { return JSON.parse(area?.getItem(key) ?? 'null') ?? {} } catch { return {} } },
    save: prefs => { try { area?.setItem(key, JSON.stringify(prefs)) } catch { /* 存储不可用时本次会话内生效 */ } },
    reset: () => { try { area?.removeItem(key) } catch { /* 同上 */ } },
  }
}

// 纯函数：把布局偏好投影到元素上。笔记本适配器与数据库挂载共用。
export function applyLayout(shell, prefs, { sideVar = '--alaya-side-w', detailVar = '--alaya-detail-w', notebook = false } = {}) {
  if (!shell) return prefs
  shell.style.setProperty(sideVar, `${prefs.sideW}px`)
  shell.style.setProperty(detailVar, `${prefs.detailW}px`)
  if (notebook) {
    shell.classList.toggle('detail-left', prefs.detailSide === 'left')
    shell.dataset.mbSide = prefs.sideCollapsed ? 'collapsed' : 'expanded'
    shell.dataset.mbSideSide = prefs.sideSide
    shell.dataset.mbFocus = prefs.focus ? 'on' : 'off'
    shell.dataset.mbPage = prefs.pageWidth
    shell.dataset.mbDensity = prefs.density
  } else {
    shell.dataset.side = prefs.sideCollapsed ? 'collapsed' : 'expanded'
    shell.dataset.sideSide = prefs.sideSide
    shell.dataset.detailSide = prefs.detailSide
    shell.dataset.focus = prefs.focus ? 'on' : 'off'
    shell.dataset.pageWidth = prefs.pageWidth
    shell.dataset.density = prefs.density
  }
  return prefs
}

function segmented(label, options, onPick, ariaLabel = label) {
  const buttons = options.map(([value, text]) => h('button', { type: 'button', class: 'ws-segment', 'data-value': value, 'aria-pressed': 'false', text, onClick: () => onPick(value) }))
  return {
    row: h('div', { class: 'ws-field' }, h('span', { class: 'ws-label', text: label }), h('div', { class: 'ws-seg', role: 'group', 'aria-label': ariaLabel }, buttons)),
    sync: active => buttons.forEach(node => { const on = node.dataset.value === active; node.classList.toggle('active', on); node.setAttribute('aria-pressed', String(on)) }),
  }
}

function rangeField(label, id, limits, onInput, onCommit, ariaLabel = label) {
  const slider = h('input', { type: 'range', class: 'ws-range', id, min: limits.min, max: limits.max, step: limits.step, 'aria-label': ariaLabel })
  const output = h('output', { class: 'ws-value', for: id })
  slider.addEventListener('input', () => { output.textContent = `${slider.value}px`; onInput(Number(slider.value)) })
  slider.addEventListener('change', () => onCommit?.())
  return {
    row: h('div', { class: 'ws-field' }, h('label', { class: 'ws-label', for: id, text: label }), slider, output),
    sync: value => { slider.value = String(value); output.textContent = `${value}px` },
  }
}

function switchField(text, id, onChange) {
  const input = h('input', { type: 'checkbox', id })
  input.addEventListener('change', () => onChange(input.checked))
  return {
    row: h('label', { class: 'ws-switch', for: id }, input, h('span', { text })),
    sync: value => { input.checked = Boolean(value) },
  }
}

// 菜单本体：只依赖注入的 set/prefs/defaults，数据库与笔记本共享同一份交互。
function createMenu({ idPrefix, features, icon, set, onReset, onPreset, flush }) {
  const enabled = new Set(features)
  const controls = []
  const panel = h('div', { class: 'ws-panel', role: 'group', 'aria-label': '工作区布局' })
  const summary = h('summary', { class: 'btn soft ws-layout-trigger', id: `${idPrefix}-toggle`, title: '布局：面板宽度与位置、页面宽度、密度' },
    icon ? icon('layers') : null, h('span', { text: '布局' }))

  if (enabled.has('presets')) {
    panel.append(h('div', { class: 'ws-field ws-presets' }, h('span', { class: 'ws-label', text: '预设' }),
      PRESETS.map(([value, text]) => h('button', { type: 'button', class: 'ws-preset', 'data-value': value, text, onClick: () => { onPreset(value); flush?.() } }))))
  }

  panel.append(h('div', { class: 'ws-section' }, h('span', { class: 'ws-section-title', text: '侧栏' })))
  if (enabled.has('sideSide')) {
    const control = segmented('位置', [['left', '左'], ['right', '右']], value => set({ sideSide: value }), '侧栏位置')
    controls.push({ sync: prefs => control.sync(prefs.sideSide) }); panel.append(control.row)
  }
  if (enabled.has('sideW')) {
    const control = rangeField('宽度', `${idPrefix}-side-width`, LAYOUT_LIMITS.sideW, value => set({ sideW: value }, { defer: true }), flush, '侧栏宽度')
    controls.push({ sync: prefs => control.sync(prefs.sideW) }); panel.append(control.row)
  }
  if (enabled.has('sideCollapsed')) {
    const control = switchField('折叠侧栏', `${idPrefix}-side-collapsed`, value => set({ sideCollapsed: value }))
    controls.push({ sync: prefs => control.sync(prefs.sideCollapsed) }); panel.append(control.row)
  }

  if (enabled.has('detailSide') || enabled.has('detailW')) panel.append(h('div', { class: 'ws-section' }, h('span', { class: 'ws-section-title', text: '详情面板' })))
  if (enabled.has('detailSide')) {
    const control = segmented('位置', [['left', '左'], ['right', '右']], value => set({ detailSide: value }), '详情面板位置')
    controls.push({ sync: prefs => control.sync(prefs.detailSide) }); panel.append(control.row)
  }
  if (enabled.has('detailW')) {
    const control = rangeField('宽度', `${idPrefix}-detail-width`, LAYOUT_LIMITS.detailW, value => set({ detailW: value }, { defer: true }), flush, '详情面板宽度')
    controls.push({ sync: prefs => control.sync(prefs.detailW) }); panel.append(control.row)
    panel.append(h('p', { class: 'ws-cap', text: '打开详情时生效。' }))
  }

  if (enabled.has('pageWidth')) {
    const control = segmented('页面', Object.entries(PAGE_WIDTHS), value => set({ pageWidth: value }), '页面宽度')
    controls.push({ sync: prefs => control.sync(prefs.pageWidth) }); panel.append(control.row)
  }
  if (enabled.has('density')) {
    const control = segmented('密度', Object.entries(DENSITIES), value => set({ density: value }), '卡片密度')
    controls.push({ sync: prefs => control.sync(prefs.density) }); panel.append(control.row)
  }
  if (enabled.has('focus')) {
    const control = switchField('专注（隐藏两侧面板，Esc 退出）', `${idPrefix}-focus`, value => set({ focus: value }))
    controls.push({ sync: prefs => control.sync(prefs.focus) }); panel.append(control.row)
  }

  if (enabled.has('sideW') || enabled.has('detailW')) panel.append(h('p', { class: 'ws-cap', text: '拖动面板之间的分隔条也能调宽度，双击恢复默认。' }))
  panel.append(h('div', { class: 'ws-foot' },
    h('button', { type: 'button', class: 'btn ghost ws-reset', id: `${idPrefix}-reset`, text: '恢复默认布局', onClick: () => { onReset(); flush?.() } })))

  const menu = h('details', { class: 'ws-layout', id: `${idPrefix}-menu` }, summary, panel)
  const sync = prefs => controls.forEach(control => control.sync(prefs))
  return { menu, sync, summary }
}

function splitterElement(kind, label, limits) {
  return h('div', {
    class: `ws-splitter ws-splitter-${kind}`, id: `${kind}-splitter`, role: 'separator', 'aria-orientation': 'vertical',
    'aria-label': `${label}分隔条：拖动或方向键调整，双击或 Enter 恢复默认`,
    'aria-valuemin': String(limits.min), 'aria-valuemax': String(limits.max), tabindex: '0',
  })
}

function installSplitter(node, { limits, getValue, getDefault, direction, onResize, onEnd }) {
  let origin = 0
  attachSplitter(node, {
    onStart: () => { origin = getValue(); node.dataset.dragging = 'true' },
    onResize: ({ dx }) => onResize(origin + direction() * dx),
    onReset: () => { onResize(getDefault()); onEnd?.() },
  })
  const finish = () => { delete node.dataset.dragging; onEnd?.() }
  node.addEventListener('pointerup', finish)
  node.addEventListener('pointercancel', finish)
  node.addEventListener('lostpointercapture', finish)
  node.addEventListener('keydown', event => {
    const value = getValue()
    const sign = direction()
    const step = event.shiftKey ? 40 : 12
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') { onResize(value + sign * step); event.preventDefault() }
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') { onResize(value - sign * step); event.preventDefault() }
    else if (event.key === 'Home') { onResize(limits.min); event.preventDefault() }
    else if (event.key === 'End') { onResize(limits.max); event.preventDefault() }
    else if (event.key === 'Enter') { onResize(getDefault()); event.preventDefault() }
  })
}

function affordances({ icon, expandHost, focusExitHost, onExpand, onExitFocus }) {
  const nodes = []
  if (expandHost) {
    const expand = h('button', { type: 'button', class: 'icon-button ws-expand', title: '展开侧栏', 'aria-label': '展开侧栏', onClick: () => onExpand() })
    if (icon) expand.append(icon('chevron-right')); else expand.textContent = '»'
    expandHost.prepend(expand); nodes.push(expand)
  }
  if (focusExitHost) {
    const exit = h('button', { type: 'button', class: 'btn soft ws-focus-exit', text: '退出专注', title: '退出专注模式（Esc）', onClick: () => onExitFocus() })
    focusExitHost.prepend(exit); nodes.push(exit)
  }
  return nodes
}

// 数据库侧挂载：创建分隔条与「布局」菜单，接上 localStorage 偏好。
export function mountWorkspaceLayout({
  shell, host, store = createStorageStore(), defaults = DB_LAYOUT_DEFAULTS,
  features = LAYOUT_FEATURES, icon, onStatus, expandHost, focusExitHost, escapeGuard, idPrefix = 'layout',
} = {}) {
  if (!shell) throw new Error('mountWorkspaceLayout 需要工作区根元素')
  let prefs = normalizeLayout(store?.load?.(), defaults)
  let saveTimer, menu
  const save = () => { try { store?.save?.(prefs) } catch { /* 存储不可用 */ } }
  const scheduleSave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(save, 140) }
  const flush = () => { clearTimeout(saveTimer); save() }
  const getPrefs = () => prefs

  const sideSplitter = features.includes('sideW') ? splitterElement('side', '侧栏宽度', LAYOUT_LIMITS.sideW) : null
  const detailSplitter = features.includes('detailW') ? splitterElement('detail', '详情面板宽度', LAYOUT_LIMITS.detailW) : null

  const syncSplitters = () => {
    for (const [node, value, limits] of [[sideSplitter, prefs.sideW, LAYOUT_LIMITS.sideW], [detailSplitter, prefs.detailW, LAYOUT_LIMITS.detailW]]) {
      if (!node) continue
      node.setAttribute('aria-valuenow', String(value))
      node.setAttribute('aria-valuetext', `${value} 像素`)
      node.setAttribute('aria-valuemin', String(limits.min))
      node.setAttribute('aria-valuemax', String(limits.max))
    }
  }
  const render = () => { applyLayout(shell, prefs); syncSplitters(); menu?.sync(prefs) }
  function set(patch, { defer = false } = {}) {
    prefs = normalizeLayout({ ...prefs, ...patch }, defaults)
    render()
    // 进入专注模式时菜单本身会被隐藏；顺手关掉，避免第一次 Esc 只关菜单、
    // 用户还得再按一次才能退出专注。菜单状态留给下一次打开。
    if (prefs.focus && menu?.menu.open) menu.menu.open = false
    if (defer) scheduleSave(); else save()
    return { ...prefs }
  }

  menu = createMenu({
    idPrefix, features, icon, flush,
    set: (patch, options) => set(patch, options),
    onReset: () => reset(),
    onPreset: name => { set(layoutPreset(name, defaults)); onStatus?.(`已应用「${PRESETS.find(([value]) => value === name)?.[1] ?? name}」布局`) },
  })
  if (host) host.append(menu.menu)

  const workspace = shell.querySelector('.workspace')
  if (sideSplitter && workspace) {
    shell.insertBefore(sideSplitter, workspace)
    installSplitter(sideSplitter, {
      limits: LAYOUT_LIMITS.sideW,
      getValue: () => prefs.sideW,
      getDefault: () => defaults.sideW,
      direction: () => (prefs.sideSide === 'left' ? 1 : -1),
      onResize: value => set({ sideW: value }, { defer: true }),
      onEnd: flush,
    })
  }
  const body = shell.querySelector('.body')
  if (detailSplitter && body) {
    body.insertBefore(detailSplitter, body.querySelector('#drawer, .drawer') ?? null)
    installSplitter(detailSplitter, {
      limits: LAYOUT_LIMITS.detailW,
      getValue: () => prefs.detailW,
      getDefault: () => defaults.detailW,
      direction: () => (prefs.detailSide === 'right' ? -1 : 1),
      onResize: value => set({ detailW: value }, { defer: true }),
      onEnd: flush,
    })
  }

  const [expand, focusExit] = affordances({
    icon, expandHost, focusExitHost,
    onExpand: () => { set({ sideCollapsed: false, focus: false }); flush() },
    onExitFocus: () => { set({ focus: false }); flush() },
  })

  const onKey = event => {
    if (shell.hidden || event.key !== 'Escape' || event.defaultPrevented) return
    // 对话框优先：Esc 先交给 dialog[open]，不能被布局菜单吞掉。
    if (document.querySelector('dialog[open]')) return
    if (menu.menu.open) { menu.menu.open = false; menu.summary.focus(); event.preventDefault(); event.stopPropagation(); return }
    if (!prefs.focus) return
    if (escapeGuard && !escapeGuard()) return
    set({ focus: false }); flush()
    event.preventDefault(); event.stopPropagation()
  }
  const onDown = event => { if (!menu.menu.closest('[data-settings-layout]') && menu.menu.open && !menu.menu.contains(event.target)) menu.menu.open = false }
  document.addEventListener('keydown', onKey, true)
  document.addEventListener('pointerdown', onDown, true)
  window.addEventListener('pagehide', flush)

  function reset() {
    store?.reset?.()
    prefs = normalizeLayout(defaults, defaults)
    render(); save()
    onStatus?.('已恢复默认布局')
    return { ...prefs }
  }

  render()

  return {
    prefs: getPrefs,
    set,
    reset,
    flush,
    sync: next => { prefs = normalizeLayout(next ?? prefs, defaults); render() },
    menu: menu.menu,
    destroy: () => {
      flush()
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('pagehide', flush)
      sideSplitter?.remove(); detailSplitter?.remove(); menu.menu.remove(); expand?.remove(); focusExit?.remove()
    },
  }
}

// 笔记本适配器：只做「prefs ↔ 笔记本 DOM/存储」的翻译，不接管任何笔记本业务。
// read() 返回调用方当前的 prefs（含 order 等非布局字段），write(next) 收到的是
// {...read(), ...布局字段}，因此不会覆盖调用方的其他偏好。
export function createNotebookLayoutAdapter({
  shell, defaults = NOTEBOOK_LAYOUT_DEFAULTS, features = NOTEBOOK_FEATURES, icon, onStatus,
  read, write, menuHost, expandHost, focusExitHost, escapeGuard, idPrefix = 'mb-layout',
} = {}) {
  if (!shell) throw new Error('createNotebookLayoutAdapter 需要笔记本根元素')
  const merged = { ...NOTEBOOK_LAYOUT_DEFAULTS, ...defaults }
  const readPrefs = () => (typeof read === 'function' ? read() ?? {} : {})
  let prefs = normalizeLayout(readPrefs(), merged)
  let menu, writeTimer
  const flush = () => {
    clearTimeout(writeTimer)
    if (typeof write !== 'function') return
    write({ ...readPrefs(), ...prefs })
  }
  const scheduleWrite = () => { clearTimeout(writeTimer); writeTimer = setTimeout(flush, 160) }
  const splitters = [['sideW', shell.querySelector('#mb-side-split')], ['detailW', shell.querySelector('#mb-detail-split')]]
  const render = () => {
    applyLayout(shell, prefs, { sideVar: '--mb-side-w', detailVar: '--mb-detail-w', notebook: true })
    menu?.sync(prefs)
    for (const [key, node] of splitters) node?.setAttribute('aria-valuenow', String(prefs[key]))
  }
  const set = (patch, { defer = false } = {}) => {
    prefs = normalizeLayout({ ...prefs, ...patch }, merged)
    render()
    // 同数据库侧：进入专注时菜单会被隐藏，先关掉它，Esc 才能一次退出专注。
    if (prefs.focus && menu?.menu.open) menu.menu.open = false
    if (defer) scheduleWrite(); else flush()
    return { ...readPrefs(), ...prefs }
  }

  for (const [key, node] of splitters) {
    if (!node) continue
    const limits = LAYOUT_LIMITS[key]
    node.tabIndex = 0
    node.setAttribute('aria-valuemin', String(limits.min))
    node.setAttribute('aria-valuemax', String(limits.max))
    installSplitter(node, {
      limits, getValue: () => prefs[key], getDefault: () => merged[key],
      direction: () => key === 'sideW' || prefs.detailSide === 'left' ? 1 : -1,
      onResize: value => set({ [key]: value }, { defer: true }), onEnd: flush,
    })
  }

  if (menuHost) {
    menu = createMenu({
      idPrefix, features, icon, flush,
      set: (patch, options) => set(patch, options),
      onReset: () => reset(),
      onPreset: name => { set(layoutPreset(name, merged)); onStatus?.(`已应用「${PRESETS.find(([value]) => value === name)?.[1] ?? name}」布局`) },
    })
    menuHost.append(menu.menu)
  }

  const [expand, focusExit] = affordances({
    icon, expandHost, focusExitHost,
    onExpand: () => { set({ sideCollapsed: false, focus: false }); flush() },
    onExitFocus: () => { set({ focus: false }); flush() },
  })

  const onKey = event => {
    if (shell.hidden || event.key !== 'Escape' || event.defaultPrevented) return
    // 对话框优先：Esc 先交给 dialog[open]，布局菜单不能抢这次按键。
    if (document.querySelector('dialog[open]')) return
    if (menu?.menu.open) { menu.menu.open = false; menu.summary.focus(); event.preventDefault(); event.stopPropagation(); return }
    if (!prefs.focus) return
    if (escapeGuard && !escapeGuard()) return
    set({ focus: false }); flush()
    event.preventDefault(); event.stopPropagation()
  }
  document.addEventListener('keydown', onKey, true)
  const onDown = event => { if (!menu?.menu.closest('[data-settings-layout]') && menu?.menu.open && !menu.menu.contains(event.target)) menu.menu.open = false }
  document.addEventListener('pointerdown', onDown, true)
  window.addEventListener('pagehide', flush)

  function reset() {
    prefs = normalizeLayout(merged, merged)
    render(); flush()
    onStatus?.('已恢复默认布局')
    return { ...readPrefs(), ...prefs }
  }

  render()

  return {
    prefs: () => ({ ...readPrefs(), ...prefs }),
    apply: next => { prefs = normalizeLayout({ ...prefs, ...next }, merged); render(); return { ...readPrefs(), ...prefs } },
    set,
    reset,
    flush,
    menu: menu?.menu ?? null,
    destroy: () => {
      flush()
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('pagehide', flush)
      menu?.menu.remove(); expand?.remove(); focusExit?.remove()
    },
  }
}
