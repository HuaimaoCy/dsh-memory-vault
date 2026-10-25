import { ownTags, section, subsection } from './grouping.js'
import { icon, installIcons } from './icons.js'
import { mountCommandPalette } from './command-palette.js'
import { NOTEBOOK_TARGETS, mountQuickCapture } from './quick-capture.js'
import { createStorageStore, mountWorkspaceLayout } from './workspace-layout.js'
import { createLoadingStatus, runAlayaStartup } from './loading.js'
import { mountGlass } from './glass.js'
import { mountGlassAppearance, embedLayout } from './glass-appearance.js'
import { mountLiquidMotion } from './liquid-motion.js'
import { enterDialog, enterPanel } from './motion.js'
import {
  GROUPING_LABELS, KIND_LABELS, SHAPE_LABELS, SORT_LABELS, UNGROUPED, normalizeFilters, normalizeSource, sourceEquals,
  activeFilterCount, clearLegacyLayout, createView, defaultViews, describeFilters, describeView,
  filterEntries, filterScopeNotice, groupEntries, isDefaultView, normalizeView, readViewStore, sortEntries, titleOf, writeViewStore,
} from './views.js'

const el = id => document.getElementById(id)
const productVariant=document.documentElement.dataset.product??'unified'
// 可保存视图：定义只写渲染层 localStorage（alaya.db.views），绝不进数据库 meta 表——
// UI 偏好一旦进库就会随备份/导出一起搬，等于污染记忆域。0.7.15 的
// memory-vault.layout（grid|rows）在这里一次性迁进四个内置视图，用户偏好不丢。
const storedViews = readViewStore()
// 首次迁移：立刻把内置视图落进新键、并删掉 0.7.15 的旧键。否则旧键会一直存在，
// 用户以后改过形状又会在下次启动被旧值盖回去。
if (storedViews.migrated) {
  writeViewStore({ views: storedViews.views, activeId: storedViews.activeId })
  clearLegacyLayout()
}
const initialView = storedViews.views.find(view => view.id === storedViews.activeId) ?? storedViews.views[0]
const state = { data: null, info: null, view: { ...initialView.source }, query: '', selected: null, draft: null, dirty: false, busy: false, open: new Set(), collapsed: new Set(), nextOffset: null, cure: null, views: storedViews.views, viewId: storedViews.activeId, current: initialView, shown: 0, settingsTab: 'general' }
const kinds = KIND_LABELS
// 统一捕获面板在挂载区赋值；load() 完成后把最新记忆组推给它（见 syncCaptureTargets）。
let capture = null
installIcons()
// 材质层：引擎只负责标记表面、分级、指针光源与按压状态，观感全在 glass.css。
// 幂等，重复调用返回同一实例；Node/无 DOM 环境下自动退化成 flat，不阻断启动。
const glass = mountGlass({ tier: 'full' })
mountLiquidMotion()
const appearance = mountGlassAppearance({ glass })

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = value
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value)
    else if (['value', 'checked', 'disabled'].includes(key)) node[key] = value
    else node.setAttribute(key, String(value))
  }
  for (const child of children.flat(Infinity)) if (child !== null && child !== undefined && child !== false) node.append(child instanceof Node ? child : String(child))
  return node
}
const button = (text, action, primary = false, props = {}) => h('button', { type: 'button', class: primary ? 'btn primary' : 'btn', text, onClick: () => void guard(action), ...props })
const tag = text => h('span', { class: 'tag', text })
const groupLabel = group => [...(group.path ?? []), group.name].join(' / ')
const field = (label, control, className = '') => h('label', { class: `col ${className}` }, h('span', { class: 'label', text: label }), control)
const groupSelect = (selected, top = false) => h('select', { class: 'select' }, top ? h('option', { value: '', text: '顶层' }) : null, (state.data?.groups ?? []).map(group => h('option', { value: group.id, selected: group.id === selected ? 'selected' : undefined, text: groupLabel(group) })))
const iconButton = (name, label, action) => {
  const node = button('', action, false, { class: 'icon-button', title: label, 'aria-label': label })
  node.append(icon(name)); return node
}
function markDirty() {
  state.dirty = true
  const hint = el('editor-save-state')
  if (hint) { hint.textContent = '有未保存的修改'; hint.classList.add('dirty') }
  const save = el('save-entry')
  if (save) save.disabled = state.draft?.images === null
  renderSearchContext()
}
let statusTimer

async function unwrap(promise) {
  const reply = await promise
  if (reply?.ok !== true) throw new Error(reply?.error ?? '操作失败')
  return reply.result
}
const call = (op, body = {}) => unwrap(window.vault.invoke(op, body))
const desktop = (name, ...args) => unwrap(window.vault[name](...args))
function say(message, tone = 'info') {
  el('status').textContent = message
  el('status').className = `status ${tone} show`
  clearTimeout(statusTimer)
  if (tone !== 'err') statusTimer = setTimeout(() => el('status').classList.remove('show'), 3200)
  const modalStatus = document.querySelector('dialog[open] .modal-status')
  if (modalStatus) { modalStatus.textContent = message; modalStatus.className = `modal-status ${tone}` }
}
async function guard(action) {
  if (state.busy) return
  state.busy = true
  try { await action() } catch (error) { say(error.message ?? String(error), 'err') }
  finally { state.busy = false; scheduleSearch() }
}
async function discard() {
  if (!state.dirty) return true
  return new Promise(resolve => {
    let accepted = false, saving = false
    const dialog = h('dialog', { id: 'unsaved-changes', class: 'unsaved-modal', 'aria-labelledby': 'unsaved-title', onCancel: event => { if (saving) event.preventDefault() }, onClose: () => { dialog.remove(); el('query').value = state.query; renderSearchContext(); resolve(accepted) } },
      h('h2', { id: 'unsaved-title', text: '保存当前记忆？' }), h('p', { text: '你的修改还未保存。可以保存后继续，也可以返回编辑。' }),
      h('p', { class: 'modal-status', role: 'status', 'aria-live': 'polite' }),
      h('div', { class: 'unsaved-actions' },
        h('button', { type: 'button', class: 'btn ghost danger', text: '放弃修改', onClick: () => {
          if (state.selected?.id) selectEntry(state.selected)
          else { state.selected = null; state.draft = null; state.dirty = false; renderList(); renderDrawer() }
          accepted = true; dialog.close()
        } }),
        h('span', { class: 'spacer' }),
        h('button', { type: 'button', class: 'btn', text: '继续编辑', autofocus: 'autofocus', onClick: () => dialog.close() }),
        h('button', { type: 'button', class: 'btn primary', text: '保存并继续', onClick: async () => {
          saving = true
          dialog.querySelectorAll('button').forEach(node => { node.disabled = true })
          try { await saveMemory(); accepted = true; dialog.close() }
          catch (error) { saving = false; say(error.message ?? String(error), 'err'); dialog.querySelectorAll('button').forEach(node => { node.disabled = false }) }
        } })))
    document.body.append(dialog); dialog.showModal()
  })
}
async function navigate(view) {
  if (!await discard()) return
  clearTimeout(timer); el('query').value = state.query
  state.selected = null; state.draft = null; state.dirty = false
  await changeSource(view)
}
// —— 视图状态：state.current 是唯一真相，state.view 只是它的 source 镜像 ——
const SOURCE_FOR_DEFAULT = { all: 'default-all', hidden: 'default-hidden', 'scope:knowledge': 'default-knowledge', 'scope:conversation': 'default-conversation' }
function sourceKey(source) {
  const normalized = normalizeSource(source)
  return normalized.kind === 'scope' ? `scope:${normalized.id}` : normalized.kind
}
function defaultViewIdFor(source) { return SOURCE_FOR_DEFAULT[sourceKey(source)] ?? null }
// activeId 只指向真正存进 state.views 的视图；临时视图（记忆组浏览）不写偏好。
function applyView(view, id = null) {
  state.current = normalizeView(view)
  state.viewId = state.views.some(item => item.id === id) ? id : null
  state.view = { ...state.current.source }
}
function persistView() {
  if (!state.viewId) return
  const index = state.views.findIndex(item => item.id === state.viewId)
  if (index < 0) return
  state.views[index] = normalizeView({ ...state.current, id: state.viewId })
  writeViewStore({ views: state.views, activeId: state.viewId })
}
// 资料库那 4 个入口永远回到内置视图，不会悄悄套上用户某天给同名来源加的筛选。
function focusSource(source) {
  const id = defaultViewIdFor(source)
  const saved = id ? state.views.find(item => item.id === id) : null
  if (saved) { applyView(saved, saved.id); return }
  applyView({ ...state.current, id: 'adhoc', name: labelOf(source), source, filters: normalizeFilters({}), sort: 'priority', groupBy: 'root' }, null)
}
async function changeSource(source) {
  focusSource(source)
  state.selected = null; state.draft = null; state.dirty = false
  await load()
}
async function activateView(id) {
  const view = state.views.find(item => item.id === id)
  if (!view) return
  if (!await discard()) return
  applyView(view, view.id)
  state.selected = null; state.draft = null; state.dirty = false
  await load()
}
// 形状/排序/分组/筛选的改动立刻写回存储：视图是活的配置，不是一次性对话框。
function updateView(patch, { quiet = false } = {}) {
  state.current = normalizeView({ ...state.current, ...patch })
  persistView()
  render()
  if (!quiet) say(`视图已更新：${describeView(state.current)}`, 'ok')
  return state.current
}
function clearViewFilters() { updateView({ filters: normalizeFilters({}) }) }
async function load(append = false) {
  const offset = append ? state.nextOffset : 0
  if (append && offset === null) return
  const data = await call('state')
  const result = await call('entries', {
    query: state.query, limit: 200, offset,
    includeHidden: true, onlyHidden: state.view.kind === 'hidden',
    ...(state.view.kind === 'scope' ? { scope: state.view.id } : {}),
    ...(state.view.kind === 'group' ? { group: state.view.id, includeChildren: true } : {}),
  })
  state.data = { ...data, entries: append ? [...state.data.entries, ...result.entries] : result.entries }
  state.nextOffset = result.nextOffset
  state.info = await desktop('info')
  receiveUpdate(state.info.updates)
  syncCaptureTargets()
  render()
}
async function saveMemory() {
  const entry = state.selected, draft = state.draft
  if (!entry || !draft) return
  const isNew = !entry.id
  if (!Array.isArray(draft.images)) throw new Error('请等待图片加载完成后保存')
  if (!draft.content.trim() && !draft.images.length) { document.querySelector('#drawer [data-field="content"]')?.focus(); throw new Error('请填写正文或添加图片') }
  const fields = { title: draft.title, content: draft.content, kind: draft.kind, tags: draft.tagsText.split(/[,，\n]/).map(text => text.trim()).filter(Boolean), priority: Number(draft.priority), base: draft.base === true, scope: draft.scope, groupId: draft.groupId }
  fields.images = draft.images.map(image => image.id ? { id: image.id } : { name: image.name, data: image.data, mimeType: image.mimeType })
  const save = el('save-entry')
  if (save) { save.disabled = true; save.textContent = '正在保存…' }
  try {
    const result = await call(isNew ? 'entry.write' : 'entry.update', { ...fields, ...(isNew ? {} : { id: entry.id }) })
    selectEntry(result.entry); await load(); say(isNew ? '记忆已创建' : '修改已保存', 'ok')
  } finally {
    const current = el('save-entry')
    if (current) { current.disabled = state.draft?.images === null || Boolean(state.selected?.id && !state.dirty); current.textContent = state.selected?.id ? '保存修改' : '创建记忆' }
  }
}
function rootOf(entry) {
  const group = state.data.groups.find(item => item.id === entry.groupId)
  return group?.path?.[0] ?? group?.name ?? entry.groupName ?? '未分组'
}
function renderSide() {
  const stats = state.data.stats
  const groupsById = new Map(state.data.groups.map(group => [group.id, group]))
  const groupCounts = new Map(state.data.groups.map(group => [group.id, group.entryCount]))
  for (const group of state.data.groups) {
    let parent = groupsById.get(group.parentId)
    while (parent) { groupCounts.set(parent.id, groupCounts.get(parent.id) + group.entryCount); parent = groupsById.get(parent.parentId) }
  }
  const view = (kind, label, count, id) => button('', () => navigate({ kind, id }), false, {
    class: state.view.kind === kind && state.view.id === id ? 'nav on' : 'nav',
  })
  const rows = [
    ['all', '全部记忆', stats.totals.entries + stats.hidden],
    ['scope', '知识库', stats.entries.knowledge, 'knowledge'],
    ['scope', '对话记忆', stats.entries.conversation, 'conversation'],
    ['hidden', '隐藏', stats.hidden],
  ]
  el('views').replaceChildren(...rows.map(([kind, label, count, id]) => {
    const node = view(kind, label, count, id)
    node.setAttribute('aria-current', state.view.kind === kind && state.view.id === id ? 'page' : 'false')
    node.append(icon(kind === 'scope' ? (id === 'knowledge' ? 'book' : 'conversation') : kind === 'hidden' ? 'hidden' : 'library'), h('span', { class: 'nav-label', text: label }), h('span', { class: 'count', text: count }))
    return node
  }))
  el('tree').replaceChildren(...[...state.data.groups].sort((a, b) => groupLabel(a).localeCompare(groupLabel(b))).map(group => h('button', {
    class: state.view.kind === 'group' && state.view.id === group.id ? 'nav on' : 'nav', 'data-depth': group.depth,
    title: groupLabel(group), 'aria-current': state.view.kind === 'group' && state.view.id === group.id ? 'page' : 'false',
    onClick: () => void guard(() => navigate({ kind: 'group', id: group.id })),
  }, icon('folder'), h('span', { class: 'nav-label', text: group.name, title: groupLabel(group) }), h('span', { class: 'count', text: groupCounts.get(group.id) }))))
}
function renderList() {
  const list = el('list')
  const view = state.current
  list.classList.toggle('rows', view.shape === 'rows')
  list.dataset.shape = view.shape
  // 筛选与排序都在渲染层对已加载的结果生效（一次 200 条），不额外发请求。
  const loaded = state.data.entries
  const filtered = filterEntries(loaded, view.filters)
  const sorted = sortEntries(filtered, view.sort)
  state.shown = sorted.length
  list.replaceChildren()
  // 筛选只作用于已加载的一页：把这条边界写出来，避免「看板上没有 = 库里不存在」。
  const scopeNotice = filterScopeNotice({ loaded: loaded.length, shown: sorted.length, hasMore: state.nextOffset !== null, filterCount: activeFilterCount(view.filters) })
  if (scopeNotice) list.append(h('div', { class: 'filter-scope', id: 'filter-scope', role: 'status' },
    icon('search'), h('span', { text: scopeNotice }), button('加载更多', () => load(true), false, { class: 'btn soft', id: 'filter-scope-more' })))
  if (!sorted.length) {
    emptyState(list, { searching: Boolean(state.query), filtered: loaded.length > 0, partial: Boolean(scopeNotice), loaded: loaded.length })
  } else if (view.shape === 'board') {
    renderBoard(list, sorted)
  } else if (view.shape === 'table') {
    renderTable(list, sorted)
  } else {
    renderSections(list, sorted)
  }
  if (state.nextOffset !== null) list.append(button('加载更多', () => load(true), false, { id: 'load-more' }))
}
// 一张记忆卡：卡片与列表共用同一份结构（列表只是把同一张卡横过来排）。
function cardNode(entry) {
  return h('button', {
    class: `tile${entry.hidden ? ' hidden-tile' : ''}${entry.id === state.selected?.id ? ' selected' : ''}`, 'data-id': entry.id, 'aria-pressed': String(entry.id === state.selected?.id), onClick: () => void guard(async () => { if (await discard()) selectEntry(entry) }),
  }, h('div', { class: 'tile-top' }, h('span', { class: `kind-icon ${entry.kind}` }, icon(entry.kind)), h('span', { class: 'kind-label', text: kinds[entry.kind] ?? '笔记' }), entry.base ? h('span', { class: 'base-mark', text: '底层约定' }) : null),
  h('div', { class: 'tile-title', text: entry.title || entry.content.slice(0, 40) }), h('div', { class: 'tile-body', text: entry.content.replace(/^\s{0,3}#{1,6}\s+/gm, '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\s+/g, ' ').slice(0, 170) }), h('div', { class: 'tags' },
    entry.groupName !== rootOf(entry) ? tag(entry.groupName) : null,
    entry.hidden ? tag('已隐藏') : null, entry.imageCount ? tag(`${entry.imageCount} 张图片`) : null, ownTags(entry).slice(0, 3).map(tag)),
  h('div', { class: 'tile-footer' }, h('span', { text: entry.source === 'panel' ? '手动记录' : entry.tags.includes('AI 生成') ? 'AI 生成' : entry.source || '记忆' }), h('span', { class: 'date', text: new Date(entry.updatedAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }) })))
}
// 空态分三种：搜索没命中、筛选没命中（要给一键清除）、库里本来就空。
function emptyState(list, { searching, filtered, partial = false, loaded = 0 }) {
  if (filtered) {
    list.append(h('div', { class: 'filter-empty' }, h('div', { class: 'empty-art' }, icon('search')),
      h('h2', { text: partial ? '已加载的结果里没有匹配' : '当前筛选没有结果' }),
      h('p', { text: partial ? `筛选只作用于已加载的 ${loaded} 条；更大范围里可能还有匹配的结果。` : `「${state.current.name}」的筛选条件把所有记忆都排除了：${describeFilters(state.current.filters).join('；')}。` }),
      h('div', { class: 'row' },
        partial ? button('加载更多', () => load(true), true, { id: 'filter-empty-more' }) : button('清除筛选', async () => clearViewFilters(), true),
        button('视图设置', async () => viewSettings()))))
    return
  }
  list.append(h('div', { class: 'empty' }, h('div', { class: 'empty-art' }, icon(searching ? 'search' : 'vault')),
    h('h2', { text: searching ? '没有找到相关记忆' : '从一条记忆开始' }),
    h('p', { text: searching ? '试试更简短的关键词，或回到全部记忆浏览。' : '记下值得保留的知识、想法和约定，随时回到这里。' }),
    button(searching ? '清除搜索' : '新建记忆', async () => {
      if (searching) await clearSearch(); else await newMemory()
    }, true)))
}
function renderSections(list, sorted) {
  // 默认分组沿用 0.7.15 的两级结构（根记忆组 + 标签子段），其他分组按视图设置走。
  const parts = state.current.groupBy === 'root' ? section(sorted, rootOf) : groupEntries(sorted, state.current.groupBy, { rootOf })
  for (const part of parts) {
    if (!state.collapsed.has(part.key) && (part.key !== '__hidden__' || state.view.kind === 'hidden')) state.open.add(part.key)
    const open = state.open.has(part.key)
    const head = h('button', { class: 'sec-head', 'aria-expanded': String(open), onClick: () => {
      if (open) { state.open.delete(part.key); state.collapsed.add(part.key) }
      else { state.open.add(part.key); state.collapsed.delete(part.key) }
      renderList()
    } }, h('span', { class: 'section-icon' }, icon(part.key === '__hidden__' ? 'hidden' : 'folder')), h('span', { text: part.label }), h('span', { class: 'count', text: `${part.entries.length}` }), icon(open ? 'chevron-down' : 'chevron-right'))
    const body = h('div', { class: open ? 'sec-body' : 'sec-body hidden' })
    const subsections = state.current.groupBy === 'root' ? subsection(part.entries) : [{ key: part.key, label: null, entries: part.entries }]
    for (const sub of subsections) {
      body.append(h('div', { class: 'sub' }, sub.label === null || (sub.label === '未打标签' && subsections.length === 1) ? null : h('div', { class: 'sub-head' }, sub.label === '未打标签' ? '其他记忆' : sub.label, h('span', { class: 'cap', text: sub.entries.length })), h('div', { class: 'grid' }, sub.entries.map(cardNode))))
    }
    list.append(h('section', { class: 'sec' }, head, body))
  }
}
function boardCard(entry) {
  return h('button', {
    class: `board-card${entry.hidden ? ' hidden-card' : ''}${entry.id === state.selected?.id ? ' selected' : ''}`, 'data-id': entry.id,
    'aria-pressed': String(entry.id === state.selected?.id), onClick: () => void guard(async () => { if (await discard()) selectEntry(entry) }),
  }, h('div', { class: 'board-card-top' }, icon(entry.kind), h('span', { text: kinds[entry.kind] ?? '笔记' }), entry.base ? h('span', { class: 'base-mark', text: '底层约定' }) : null),
  h('div', { class: 'board-card-title', text: titleOf(entry) }),
  h('div', { class: 'board-card-body', text: entry.content.replace(/^\s{0,3}#{1,6}\s+/gm, '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\s+/g, ' ').slice(0, 130) }),
  h('div', { class: 'board-card-foot' }, h('span', { text: entry.imageCount ? `${entry.imageCount} 张图片` : entry.scope === 'knowledge' ? '知识库' : '对话记忆' }),
    h('span', { class: 'date', text: new Date(entry.updatedAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }) })))
}
function renderBoard(list, sorted) {
  const grouping = state.current.groupBy
  const columns = groupEntries(sorted, grouping, { rootOf })
  list.append(h('div', { class: 'view-board', role: 'group', 'aria-label': `看板 · 按${GROUPING_LABELS[grouping]}分列`, 'data-columns': columns.length },
    columns.map(column => h('section', { class: 'board-col', 'data-column': column.key, 'aria-label': `${column.label}，${column.entries.length} 条记忆` },
      h('header', { class: 'board-col-head' }, icon(grouping === 'kind' ? column.entries[0].kind : 'folder'),
        h('span', { class: 'board-col-label', text: column.label }), h('span', { class: 'board-col-count', text: column.entries.length })),
      h('div', { class: 'board-col-body' }, column.entries.map(boardCard))))))
}
const TABLE_COLUMNS = ['标题', '归属', '类型', '记忆组', '优先级', '更新时间']
function tableRow(entry) {
  const activate = () => void guard(async () => { if (await discard()) selectEntry(entry) })
  const row = h('tr', {
    'data-id': entry.id, tabindex: '0', 'aria-label': `${titleOf(entry)}，${kinds[entry.kind] ?? '笔记'}，优先级 ${entry.priority ?? 0}`,
    class: entry.id === state.selected?.id ? 'selected' : '',
    onClick: activate,
    onKeydown: event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate() } },
  })
  row.append(
    h('td', {}, h('div', { class: 'cell-title' }, icon(entry.kind), h('span', { text: titleOf(entry), title: titleOf(entry) }))),
    h('td', { class: 'cell-muted', text: entry.scope === 'knowledge' ? '知识库' : '对话记忆' }),
    h('td', { class: 'cell-muted', text: kinds[entry.kind] ?? '笔记' }),
    h('td', { class: 'cell-muted', text: entry.groupName || UNGROUPED }),
    h('td', {}, h('span', { class: 'cell-num', text: String(entry.priority ?? 0) }), entry.base ? h('span', { class: 'cell-badge base', text: '底层' }) : null, entry.hidden ? h('span', { class: 'cell-badge hidden', text: '已隐藏' }) : null),
    h('td', { class: 'cell-date cell-muted', text: new Date(entry.updatedAt).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }))
  return row
}
// 表格保持「一张紧凑的表」：分组用行内标题行表达，不切成多张表。
function renderTable(list, sorted) {
  const groups = groupEntries(sorted, state.current.groupBy, { rootOf })
  const table = h('table', { class: 'view-table', 'aria-label': `记忆表格 · 按${GROUPING_LABELS[state.current.groupBy]}分组` },
    h('caption', { text: `${state.current.name} · ${sorted.length} 条记忆` }),
    h('thead', {}, h('tr', {}, TABLE_COLUMNS.map(label => h('th', { scope: 'col', text: label })))),
    h('tbody', {}, groups.flatMap(group => [
      h('tr', { class: 'view-table-group', 'data-group': group.key }, h('th', { scope: 'colgroup', colspan: String(TABLE_COLUMNS.length) }, h('span', { text: group.label }), h('span', { class: 'cap', text: ` · ${group.entries.length}` }))),
      ...group.entries.map(tableRow),
    ].flat())))
  list.append(h('div', { class: 'view-table-wrap' }, table))
}
function selectEntry(entry) {
  state.selected = entry
  state.draft = { ...entry, tagsText: ownTags(entry).join(', '), images: entry.id ? null : [] }
  state.dirty = false
  renderList(); renderDrawer()
  if (entry.id) void loadDraftImages(state.draft)
}
function renderDrawer() {
  const drawer = el('drawer')
  const opening = drawer.classList.contains('hidden') && Boolean(state.selected)
  drawer.classList.toggle('hidden', !state.selected)
  document.querySelector('.body').classList.toggle('with-inspector', Boolean(state.selected))
  // 抽屉是贴右边缘的全高内容层：只淡入，不做位移（位移会让右缘探出窗口）。
  if (opening) enterPanel(drawer, { distance: 0, response: 0.3 })
  if (!state.selected) return
  const entry = state.selected, draft = state.draft, isNew = !entry.id
  const control = (name, tagName = 'input', props = {}) => h(tagName, {
    class: tagName === 'textarea' ? 'area' : 'input', value: draft[name] ?? '', 'data-field': name,
    onInput: event => { draft[name] = event.target.type === 'checkbox' ? event.target.checked : event.target.value; markDirty() }, ...props,
  })
  const group = groupSelect(draft.groupId)
  group.dataset.field = 'groupId'
  group.addEventListener('change', () => { draft.groupId = group.value; markDirty() })
  const scope = h('select', { class: 'select', 'data-field': 'scope', onChange: event => { draft.scope = event.target.value; markDirty() } },
    ['knowledge', 'conversation'].map(value => h('option', { value, selected: value === draft.scope ? 'selected' : undefined, text: value === 'knowledge' ? '知识库' : '对话记忆' })))
  const kind = h('select', { class: 'select', 'data-field': 'kind', onChange: event => { draft.kind = event.target.value; markDirty() } },
    [['note', '笔记'], ['fact', '事实'], ['decision', '决策'], ['preference', '偏好'], ['summary', '总结'], ['task', '任务']].map(([value, text]) => h('option', { value, text, selected: value === draft.kind ? 'selected' : undefined })))
  const form = h('form', { class: 'editor-form', onSubmit: event => { event.preventDefault(); void guard(saveMemory) },
    onPaste: event => {
      const files = [...(event.clipboardData?.files ?? [])].filter(file => file.type.startsWith('image/'))
      if (files.length) { event.preventDefault(); void guard(() => addDraftImages(files)) }
    },
  },
    h('div', { class: 'editor-scroll' },
      h('div', { class: 'editor-paper' },
        h('label', { class: 'col' }, h('span', { class: 'sr-only', text: '标题' }), control('title', 'input', { class: 'input editor-title', placeholder: '给记忆起个名字' })),
        field('正文 · 支持 Markdown 与公式源码', control('content', 'textarea', { class: 'area editor-content', placeholder: '写下值得留下来的内容，或添加图片…' })),
        h('section', { id: 'editor-images', class: 'editor-images', 'aria-label': '记忆图片' })),
      h('h3', { class: 'properties-head', text: '整理信息' }),
      h('div', { class: 'properties' }, field('归属', scope), field('类型', kind), field('记忆组', group, 'full-width'),
        field('标签', control('tagsText', 'input', { placeholder: '用逗号分隔多个标签' }), 'full-width')),
      h('details', { class: 'advanced-properties' }, h('summary', { text: '提供给 AI 的优先级与约定' }), h('p', { class: 'cap', text: '优先级决定提供给模型的顺序；底层约定使用独立的记忆预算。' }),
        h('div', { class: 'properties' }, field('优先级 · 0–100', control('priority', 'input', { type: 'number', min: 0, max: 100, step: 1 })),
          h('label', { class: 'switch-row' }, h('span', { text: '底层约定' }), control('base', 'input', { type: 'checkbox', checked: draft.base === true })))),
      isNew ? null : h('details', { class: 'record-info' }, h('summary', { text: '记录信息' }), h('div', { class: 'meta', text: `来源：${entry.source} · ID：${entry.id}\n更新：${new Date(entry.updatedAt).toLocaleString('zh-CN')}` }))),
    h('div', { class: 'editor-actions' }, h('div', { id: 'editor-save-state', class: `editor-save-state${state.dirty ? ' dirty' : ''}`, role: 'status', 'aria-live': 'polite', text: state.dirty ? '有未保存的修改' : isNew ? '保存到当前数据库' : '已保存到本地数据库' }), h('div', { class: 'row' },
      isNew ? null : button(entry.hidden ? '恢复显示' : '隐藏', async () => {
        if (!await discard()) return
        await call('entry.hide', { ids: [entry.id], hidden: !entry.hidden })
        const changed = state.data.entries.find(row => row.id === entry.id) ?? entry
        selectEntry({ ...changed, hidden: !entry.hidden }); await load(); say('可见性已更新', 'ok')
      }, false, { class: 'btn ghost' }),
      isNew ? null : button('删除', async () => {
        if (!await desktop('confirm', `永久删除「${entry.title || '这条记忆'}」？`)) return
        await call('entry.delete', { id: entry.id }); state.selected = null; state.dirty = false; await load(); say('记忆已删除', 'ok')
      }, false, { class: 'btn ghost danger' }),
      h('button', { type: 'submit', id: 'save-entry', class: 'btn primary', disabled: draft.images === null || (!isNew && !state.dirty), title: '保存 · Ctrl+S', text: isNew ? '创建记忆' : '保存修改' }))),
  )
  drawer.replaceChildren(h('div', { class: 'drawer-head' }, icon(isNew ? 'plus' : 'note'), h('h2', { text: isNew ? '新建记忆' : '记忆详情' }), h('span', { class: 'spacer' }), iconButton('close', '关闭记忆详情', async () => {
    if (await discard()) { state.selected = null; state.dirty = false; renderList(); renderDrawer() }
  })), form)
  renderImagePanel()
}
async function loadDraftImages(draft) {
  try {
    const listed = await call('image.list', { entryId: draft.id })
    const images = await Promise.all(listed.images.map(async image => (await call('image.read', { id: image.id })).image))
    if (state.draft !== draft) return
    draft.images = images; renderImagePanel()
  } catch (error) {
    if (state.draft === draft) { say(`图片加载失败：${error.message}`, 'err'); renderImagePanel(true) }
  }
}
async function addDraftImages(files) {
  const draft = state.draft
  if (!draft || draft.images === null) throw new Error('请等待已有图片加载完成')
  if (draft.images.length + files.length > 16) throw new Error('每条记忆最多 16 张图片')
  const added = []
  for (const file of files) {
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) throw new Error('支持 PNG、JPEG、WebP 和 GIF 图片')
    if (file.size > 10 * 1048576) throw new Error('每张图片不能超过 10 MB')
    const url = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('无法读取图片')); reader.readAsDataURL(file) })
    const image = new Image(); image.src = url
    await image.decode().catch(() => { throw new Error('图片损坏，无法打开') })
    if (image.naturalWidth > 16384 || image.naturalHeight > 16384 || image.naturalWidth * image.naturalHeight > 40000000) throw new Error('图片超过尺寸上限')
    added.push({ name: file.name || '粘贴的图片.png', mimeType: file.type, size: file.size, data: url.slice(url.indexOf(',') + 1), width: image.naturalWidth, height: image.naturalHeight })
  }
  if ([...draft.images, ...added].reduce((sum, image) => sum + image.size, 0) > 20 * 1048576) throw new Error('每条记忆的图片总大小不能超过 20 MB')
  if (state.draft !== draft) return
  draft.images.push(...added); markDirty(); renderImagePanel()
}
function imagePreview(image) {
  const dialog = h('dialog', { class: 'image-viewer', 'aria-label': image.name, onClick: event => { if (event.target === dialog) dialog.close() }, onClose: () => dialog.remove() },
    h('div', { class: 'image-viewer-head' }, h('span', { text: image.name }), h('span', { class: 'spacer' }), iconButton('close', '关闭图片预览', () => dialog.close())),
    h('img', { src: `data:${image.mimeType};base64,${image.data}`, alt: image.name }), h('p', { class: 'cap', text: `${image.width} × ${image.height} · ${(image.size / 1024).toFixed(0)} KB` }))
  document.body.append(dialog); dialog.showModal()
}
function renderImagePanel(failed = false) {
  const panel = el('editor-images'), draft = state.draft
  if (!panel || !draft) return
  const picker = h('input', { type: 'file', class: 'sr-only', id: 'image-picker', multiple: 'multiple', accept: 'image/png,image/jpeg,image/webp,image/gif', onChange: event => { const files = [...event.target.files]; event.target.value = ''; void guard(() => addDraftImages(files)) } })
  const waiting = draft.images === null
  panel.replaceChildren(...[h('div', { class: 'row image-panel-head' }, h('span', { class: 'label', text: `图片${waiting ? '' : ` · ${draft.images.length}`}` }), h('span', { class: 'spacer' }), button('添加图片', () => picker.click(), false, { id: 'add-image', class: 'btn soft', disabled: waiting })), picker,
    waiting ? h('p', { class: 'cap', text: failed ? '图片加载失败，重试后再编辑。' : '正在加载图片…' }) : h('div', { class: 'image-attachments' }, draft.images.map((image, index) => h('div', { class: 'image-attachment' },
      h('button', { type: 'button', class: 'image-thumbnail', title: `查看 ${image.name}`, onClick: () => imagePreview(image) }, h('img', { src: `data:${image.mimeType};base64,${image.data}`, alt: image.name, loading: 'lazy' })),
      h('div', { class: 'image-attachment-caption' }, h('span', { text: image.name, title: image.name }), button('移除', () => { draft.images.splice(index, 1); markDirty(); renderImagePanel() }, false, { class: 'btn ghost danger', 'aria-label': `移除图片 ${image.name}` }))))),
    failed ? button('重新加载图片', () => loadDraftImages(draft)) : null,
    h('p', { class: 'image-drop-hint', text: '拖入图片或粘贴截图 · 保存记忆后保留', onDragover: event => event.preventDefault(), onDrop: event => { event.preventDefault(); void guard(() => addDraftImages([...event.dataTransfer.files])) } })].filter(node => node !== null && node !== false))
  const save = el('save-entry'); if (save) save.disabled = waiting || Boolean(state.selected?.id && !state.dirty)
}
// 数据来源的人话名字。视图名与来源名分开：视图可以改名，来源不会。
function labelOf(source) {
  const normalized = normalizeSource(source)
  if (normalized.kind === 'group') return state.data?.groups.find(group => group.id === normalized.id)?.name ?? '记忆组'
  if (normalized.kind === 'scope') return normalized.id === 'knowledge' ? '知识库' : '对话记忆'
  if (normalized.kind === 'hidden') return '隐藏记忆'
  return '全部记忆'
}
function viewLabel() { return labelOf(state.view) }
function renderSearchContext() {
  const pending = el('query').value.trim() !== state.query
  el('search-context').classList.toggle('hidden', !state.query && !pending)
  el('search-hint').textContent = pending && state.dirty ? '当前记忆尚未保存，按 Enter 确认后搜索。' : pending ? '准备搜索…' : state.query ? `在「${viewLabel()}」中搜索「${state.query}」` : ''
  el('clear-search').textContent = pending && !state.query ? '取消搜索' : '清除搜索'
}
function render() {
  renderSide(); renderList(); renderDrawer()
  const label = viewLabel()
  const searching = Boolean(state.query)
  el('view-title').textContent = searching ? '搜索结果' : state.current.name
  el('breadcrumb').textContent = label
  renderSearchContext()
  el('view-count').textContent = `${state.nextOffset === null ? '' : '≥'}${state.shown}`
  el('curate').disabled = el('curate-review').disabled = !state.info.model.baseUrl
  el('curate').title = el('curate-review').title = state.info.model.baseUrl ? '会调用设置中的 AI 服务' : '先在设置中配置 AI 服务'
  el('curation-hint').textContent = state.info.model.baseUrl ? '先预览建议，再决定是否整理保存。整理范围覆盖整个数据库。' : '连接 AI 服务后，即可预览整理建议。'
  el('curation-setup').classList.toggle('hidden', Boolean(state.info.model.baseUrl))
  syncViewControls()
}
const SHAPE_ICONS = { grid: 'grid', rows: 'list', table: 'summary', board: 'layers' }
const SHAPE_BUTTONS = [['view-grid', 'grid'], ['view-list', 'rows'], ['view-table', 'table'], ['view-board', 'board']]
// 侧栏「视图」区块：列出保存的视图，当前那个高亮；内置视图带一个小圆点。
function renderSavedViews() {
  const nav = el('saved-views')
  if (!nav) return
  if (!state.views.length) { nav.replaceChildren(h('p', { class: 'saved-views-empty', text: '还没有视图。点上面的 ＋ 复制当前视图并存下来。' })); return }
  nav.replaceChildren(...state.views.map(view => {
    const active = view.id === state.viewId
    return h('button', {
      type: 'button', class: active ? 'saved-view on' : 'saved-view', 'data-view-id': view.id, 'data-shape': view.shape,
      'aria-current': active ? 'page' : 'false', title: `${view.name} · ${describeView(view)}`,
      onClick: () => void guard(() => activateView(view.id)),
    }, icon(SHAPE_ICONS[view.shape] ?? 'grid'), h('span', { class: 'saved-view-name', text: view.name }), isDefaultView(view.id) ? h('span', { class: 'saved-view-dot', title: '内置视图' }) : null)
  }))
}
// 工具栏的四个形状按钮、排序下拉与筛选徽标都从 state.current 反读，只有一处真相。
function syncViewControls() {
  const shape = state.current.shape
  for (const [id, value] of SHAPE_BUTTONS) {
    const node = el(id)
    if (!node) continue
    node.classList.toggle('active', shape === value)
    node.setAttribute('aria-pressed', String(shape === value))
  }
  if (el('sort')) el('sort').value = state.current.sort
  const count = activeFilterCount(state.current.filters)
  const badge = el('filter-count')
  if (badge) { badge.textContent = String(count); badge.classList.toggle('hidden', count === 0) }
  if (el('view-settings')) {
    el('view-settings').title = `${state.current.name} · ${describeView(state.current)}`
    el('view-settings').setAttribute('aria-label', `视图设置（${describeView(state.current)}）`)
  }
  renderSavedViews()
}
function modal(title, ...children) {
  el('modal')?.remove()
  el('curation-menu').open = false
  const dialog = h('dialog', { id: 'modal', class: 'modal', 'aria-labelledby': 'modal-title', onClose: () => { dialog.remove(); scheduleSearch() } }, h('div', { class: 'modal-header' }, h('h2', { id: 'modal-title', text: title }), h('span', { class: 'spacer' }), iconButton('close', '关闭', async () => dialog.close())), h('div', { class: 'modal-status', role: 'status' }), h('div', { class: 'modal-body' }, children))
  document.body.append(dialog); dialog.showModal(); enterDialog(dialog)
  return dialog
}
function groupManager() {
  const newName = h('input', { class: 'input', placeholder: '例如：项目约定', id: 'new-group-name', required: 'required' })
  const parent = groupSelect('', true)
  const createScope = h('select', { class: 'select' }, h('option', { value: 'knowledge', text: '知识库' }), h('option', { value: 'conversation', text: '对话记忆' }))
  modal('管理记忆组',
    h('p', { class: 'cap', text: '按主题整理记忆。记忆组支持三层结构，也可以随时移动与重命名。' }),
    h('form', { class: 'group-create', onSubmit: event => { event.preventDefault(); void guard(async () => {
      await call('group.create', { name: newName.value, parent: parent.value, scope: createScope.value }); await load(); groupManager(); say('记忆组已创建', 'ok')
    }) } }, h('div', { class: 'group-create-grid' }, field('新记忆组', newName), field('上级记忆组', parent), field('归属', createScope), h('button', { type: 'submit', id: 'create-group', class: 'btn primary', text: '创建组' }))),
    h('div', { class: 'group-rows' }, state.data.groups.map(group => {
      const name = h('input', { class: 'input', value: group.name })
      const move = groupSelect(group.parentId ?? '', true)
      const priority = h('input', { class: 'input', type: 'number', min: 0, max: 100, value: group.priority })
      const scope = h('select', { class: 'select' }, ['knowledge', 'conversation'].map(value => h('option', { value, selected: group.scope === value ? 'selected' : undefined, text: value === 'knowledge' ? '知识库' : '对话记忆' })))
      const auto = h('input', { type: 'checkbox', checked: group.autoSummary })
      return h('div', { class: 'group-row' }, h('div', { class: 'group-row-title' }, icon('folder'), h('span', { text: groupLabel(group) })),
        h('div', { class: 'group-fields' }, field('名称', name), field('上级记忆组', move), field('归属', scope), field('优先级 · 0–100', priority)),
        h('div', { class: 'group-actions' }, h('label', { class: 'switch-row' }, auto, 'DSH 自动总结'), h('span', { class: 'spacer' }),
          button('删除', async () => {
            if (!await desktop('confirm', `删除记忆组「${group.name}」？条目会移回默认组。`)) return
            await call('group.delete', { id: group.id }); state.view = { kind: 'all' }; await load(); groupManager(); say('记忆组已删除', 'ok')
          }, false, { class: 'btn ghost danger' }),
          button('保存', async () => {
            await call('group.update', { id: group.id, name: name.value, parent: move.value, scope: scope.value, priority: Number(priority.value), autoSummary: auto.checked }); await load(); groupManager(); say('分组已保存', 'ok')
          })))
    })))
}
function settings() {
  const info = state.info
  const url = h('input', { class: 'input', value: info.model.baseUrl ?? '', placeholder: 'https://api.deepseek.com/v1', id: 'model-url' })
  const model = h('input', { class: 'input', value: info.model.model ?? '', placeholder: '模型名称', id: 'model-name' })
  const key = h('input', { class: 'input', type: 'password', autocomplete: 'off', placeholder: info.hasKey ? '已保存密钥，留空则保留' : 'API 密钥（本机服务可留空）', id: 'model-key' })
  const clearKey = h('input', { type: 'checkbox' })
  const limits = state.data.limits
  const limitControls = ['maxEntries', 'maxChars', 'baseMaxEntries', 'baseMaxChars'].map((name, i) => field(['知识条数', '知识字符预算', '底层约定条数', '底层约定字符预算'][i], h('input', { class: 'input', type: 'number', min: 1, value: limits[name], 'data-limit': name })))
  const panels = [
    ['appearance', '外观', 'sparkles', appearance.createPanel()],
    ['layout', '布局', 'grid', embedLayout(layout.menu)],
    ['general', '通用', 'database',
      h('section', { class: 'col' }, h('h3', { text: '当前数据库' }), h('p', { class: 'cap', text: '记忆保存在本机。打开其他数据库，或为当前内容留一份备份。' }),
        h('code', { class: 'path-box', text: info.databasePath }),
        h('div', { class: 'row' }, button('打开其他数据库', async () => {
          if (!await discard()) return
          const result = await desktop('open')
          if (result) { state.selected = null; state.dirty = false; state.view = { kind: 'all' }; await load(); settings(); say('数据库已切换', 'ok') }
        }), button('备份数据库', async () => { const result = await desktop('backup'); if (result) say(`备份已保存：${result.path}`, 'ok') }))),
      h('section', {}, h('div', { class: 'settings-info' }, icon('vault'), h('div', {}, h('strong', { text: `Alaya ${info.displayVersion??info.version}` }), h('p', { text: info.releaseName??'独立桌面数据库 · 支持 Codex 与 DSH 接口' }))))],
    ['model', 'AI 服务', 'sparkles',
      h('section', { class: 'col' }, h('h3', { text: '连接 AI 服务' }), h('p', { class: 'cap', text: '可选。用于预览和整理记忆。候选内容会发送到你配置的服务；密钥在本机加密保存。' }),
        field('服务地址（含 /v1 等前缀，不含 /chat/completions）', url), field('模型名称', model), field('API 密钥', key), h('label', { class: 'row cap' }, clearKey, '删除已保存密钥'),
        button('保存 AI 服务', async () => {
          state.info = await desktop('settings', { baseUrl: url.value, model: model.value, apiKey: key.value, clearKey: clearKey.checked }); key.value = ''; render(); settings(); say('AI 服务设置已保存', 'ok')
        }, true))],
    ['limits', '记忆预算', 'book',
      h('section', {}, h('h3', { text: '知识预算' }), h('p', { class: 'cap', text: '控制提供给模型的知识数量与长度。底层约定使用独立预算。' }), h('div', { class: 'limits-grid' }, limitControls), button('保存知识预算', async () => {
        const fields = Object.fromEntries([...document.querySelectorAll('[data-limit]')].map(node => [node.dataset.limit, Number(node.value)]))
        await call('settings.set', fields); await load(); say('知识预算已保存', 'ok')
      }, true))],
    ['connectors', 'Codex 与 DSH', 'code',
      h('section', { class: 'col' }, h('h3', { text: '连接你的助手' }), h('p', { class: 'cap', text: '将配置合并到各自的配置文件，两个接口即可共用当前数据库。切换库后请同步更新路径。' }),
        h('div', { class: 'connector-label' }, icon('code'), 'Codex · config.toml'), h('textarea', { class: 'area config', readonly: 'readonly', value: info.connectors.codex, 'aria-label': 'Codex 接口配置' })),
      h('section', { class: 'col' }, h('div', { class: 'connector-label' }, icon('conversation'), 'DSH · cordis.patch.yml'), h('span', { class: 'cap', text: '保留原插件安装，更新配置后重启 DSH。' }),
        h('textarea', { class: 'area config', readonly: 'readonly', value: info.connectors.dsh, 'aria-label': 'DSH 接口配置' }))],
    ['updates', '软件更新', 'refresh', updatePanel()],
  ]
  const activate = id => {
    state.settingsTab = id
    document.querySelectorAll('.settings-tab').forEach(node => { const active = node.dataset.tab === id; node.classList.toggle('active', active); node.setAttribute('aria-selected', String(active)); node.tabIndex = active ? 0 : -1 })
    document.querySelectorAll('.settings-panel').forEach(node => node.classList.toggle('hidden', node.id !== `settings-${id}`))
  }
  const tabs = h('nav', { class: 'settings-tabs', role: 'tablist', 'aria-label': '设置分类', 'aria-orientation': 'vertical' }, panels.map(([id, label, name]) => h('button', {
    type: 'button', id: `tab-${id}`, class: `settings-tab${state.settingsTab === id ? ' active' : ''}`, role: 'tab', 'data-tab': id, 'aria-controls': `settings-${id}`, 'aria-selected': String(state.settingsTab === id), tabindex: state.settingsTab === id ? 0 : -1,
    onClick: () => activate(id), onKeydown: event => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const index = panels.findIndex(row => row[0] === id)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? panels.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + panels.length) % panels.length
      activate(panels[next][0]); el(`tab-${panels[next][0]}`).focus()
    },
  }, icon(name), label)))
  modal('设置与连接', h('div', { class: 'settings-layout' }, tabs, h('div', {}, panels.map(([id, _label, _name, ...children]) => h('div', { class: `settings-panel${state.settingsTab === id ? '' : ' hidden'}`, id: `settings-${id}`, role: 'tabpanel', 'aria-labelledby': `tab-${id}` }, children)))))
  renderUpdateStatus()
}
let updateSnapshot
const updateLabels = { idle: '随时检查软件更新', checking: '正在检查更新…', available: '有新版本可用', up_to_date: '你已使用最新版本', unpublished: '发布源尚未提供更新清单', error: '暂时无法检查更新' }
const updateAction = async (action, body) => { const snapshot = await desktop('updates', action, body); receiveUpdate(snapshot); return snapshot }
// Update actions have their own state; long downloads never lock memory editing.
const updateButton = (label, action, primary = false, props = {}) => h('button', { type: 'button', class: primary ? 'btn primary' : 'btn', text: label, onClick: () => { void Promise.resolve().then(action).catch(error => say(error.message, 'err')) }, ...props })
function receiveUpdate(snapshot) {
  if (!snapshot) return
  updateSnapshot = snapshot
  let banner = el('update-banner')
  if (!banner) {
    banner = h('div', { id: 'update-banner', class: 'update-banner hidden', role: 'status' })
    document.querySelector('.workspace').insertBefore(banner, document.querySelector('.body'))
  }
  const visible = snapshot.status === 'available' && snapshot.settings?.notify !== false && snapshot.settings?.dismissedVersion !== snapshot.release?.version
  banner.classList.toggle('hidden', !visible)
  if (visible) banner.replaceChildren(icon('refresh'), h('span', { text: `Alaya ${snapshot.release.version} 已发布` }), h('span', { class: 'spacer' }), updateButton('查看更新', () => { state.settingsTab = 'updates'; settings() }, false, { class: 'btn soft' }), updateButton('稍后', () => updateAction('dismiss'), false, { class: 'btn ghost' }))
  renderUpdateStatus()
}
function updatePanel() {
  const snapshot = updateSnapshot ?? state.info.updates
  const source = h('input', { class: 'input', id: 'update-source', value: snapshot.feedUrl, type: 'url', spellcheck: 'false' })
  const auto = h('input', { type: 'checkbox', checked: snapshot.settings.autoCheck, id: 'update-auto' })
  const notify = h('input', { type: 'checkbox', checked: snapshot.settings.notify, id: 'update-notify' })
  return h('div', { class: 'col' },
    h('section', { class: 'update-overview' }, h('div', { class: 'settings-info' }, icon('vault'), h('div', {}, h('h3', { text: 'Alaya' }), h('p', { text: `当前版本 ${state.info.version}` }))),
      h('strong', { id: 'update-status', role: 'status', 'aria-live': 'polite' }), h('p', { class: 'cap', id: 'update-last-checked' }), h('p', { class: 'update-error hidden', id: 'update-error' }),
      h('div', { class: 'update-progress hidden', id: 'update-progress' }, h('progress', { id: 'update-progress-bar', max: 100, value: 0, 'aria-label': '安装包下载进度' }), h('span', { id: 'update-progress-label', class: 'cap' })),
      h('div', { class: 'row', id: 'update-actions' })),
    h('section', { id: 'update-release', class: 'hidden' }, h('h3', { id: 'update-release-title' }), h('p', { class: 'update-notes', id: 'update-notes' })),
    h('section', { class: 'col' }, h('h3', { text: '更新偏好' }),
      h('label', { class: 'switch-row' }, auto, '自动检查更新'), h('p', { class: 'cap', text: '启动后检查，并在软件运行期间每 6 小时检查一次。' }),
      h('label', { class: 'switch-row' }, notify, '发现新版本时提醒我'),
      h('details', { class: 'update-source-settings' }, h('summary', { text: '发布源 · GitHub Releases' }), field('更新清单地址', source), h('p', { class: 'cap', text: '从发布页读取版本与安装包信息。' })),
      updateButton('保存更新设置', async () => { await updateAction('configure', { feedUrl: source.value, autoCheck: auto.checked, notify: notify.checked }); say('更新设置已保存', 'ok') })))
}
function renderUpdateStatus() {
  if (!el('update-status') || !updateSnapshot) return
  const snapshot = updateSnapshot, transfer = snapshot.download
  el('update-status').textContent = transfer.status === 'ready' ? '更新已下载，可以安装' : transfer.status === 'downloading' ? '正在下载安装包…' : updateLabels[snapshot.status] ?? '检查软件更新'
  el('update-last-checked').textContent = snapshot.lastChecked ? `上次检查 ${new Date(snapshot.lastChecked).toLocaleString('zh-CN')}` : '尚未检查'
  const error = transfer.error ?? snapshot.error
  el('update-error').textContent = error ?? ''; el('update-error').classList.toggle('hidden', !error)
  const progress = transfer.status === 'downloading'
  el('update-progress').classList.toggle('hidden', !progress)
  el('update-progress-bar').value = transfer.total ? Math.round(transfer.received / transfer.total * 100) : 0
  el('update-progress-label').textContent = `${(transfer.received / 1048576).toFixed(1)} / ${(transfer.total / 1048576).toFixed(1)} MB`
  el('update-release').classList.toggle('hidden', !snapshot.release)
  el('update-release-title').textContent = snapshot.release ? `版本 ${snapshot.release.version}` : ''
  el('update-notes').textContent = snapshot.release?.notes ?? ''
  const actions = [updateButton('检查更新', () => updateAction('check'), false, { id: 'update-check', disabled: snapshot.status === 'checking' || progress })]
  if (snapshot.status === 'available') {
    if (progress) actions.push(updateButton('取消下载', () => updateAction('cancel'), false, { id: 'update-cancel' }))
    else if (transfer.status === 'ready') actions.push(updateButton('安装更新并退出', async () => { if (await discard()) await desktop('updates', 'install') }, true, { id: 'update-install' }))
    else actions.push(updateButton(transfer.status === 'cancelled' ? '重新下载' : '下载更新', () => updateAction('download'), true, { id: 'update-download' }))
  }
  el('update-actions').replaceChildren(...actions)
}
window.vault.onUpdates(receiveUpdate)
function showCure() {
  const result = state.cure
  const rows = result.applied?.length ? result.applied : result.verdicts ?? []
  modal(result.mode === 'applied' ? 'AI 整理结果' : 'AI 整理预览', h('span', { class: 'cap', text: result.mode === 'review' ? '此预览未修改数据库。' : '已应用整理结果。' }), rows.map(row => h('div', { class: 'group-row' }, h('div', { class: 'row' }, tag(row.verdict === 'reusable' ? '可复用' : '单次性'), tag(row.group ?? row.groupName ?? ''), h('span', { text: row.reason ?? '' })))),
    (result.tagMap ?? []).map(row => h('div', { class: 'cap', text: `${row.from} → ${row.to || '删除标签'}：${row.reason ?? ''}` })))
}
for (const [id, apply] of [['curate', true], ['curate-review', false]]) el(id).addEventListener('click', () => void guard(async () => {
  if (!await discard()) return
  say(apply ? '正在整理…' : '正在生成预览…')
  const loading=createLoadingStatus({compact:true,label:apply?'AI 正在整理记忆':'AI 正在生成预览'});el('curation-hint').after(loading.element)
  try {state.cure = await call('curate', { origin: el('curate-scope').value, apply, limit: 20 }); await load(); showCure(); say('完成', 'ok')}
  finally {loading.destroy()}
}))
// —— 视图管理：新建/另存为/删除/恢复默认，以及「视图设置」弹层 ——
async function saveViewAs() {
  const created = createView(state.current, { views: state.views })
  state.views = [...state.views, created]
  applyView(created, created.id)
  writeViewStore({ views: state.views, activeId: created.id })
  renderSavedViews()
  renderList()
  say(`已保存视图「${created.name}」`, 'ok')
  return created
}
async function deleteView() {
  if (!state.viewId) { say('当前视图还没有保存，没有可删除的视图', 'err'); return }
  const name = state.current.name
  if (!await desktop('confirm', `删除视图「${name}」？记忆本身不会被删除。`)) return
  const source = { ...state.current.source }
  state.views = state.views.filter(view => view.id !== state.viewId)
  if (!state.views.length) state.views = defaultViews()
  const fallback = state.views.find(view => sourceEquals(view.source, source)) ?? state.views[0]
  applyView(fallback, fallback.id)
  writeViewStore({ views: state.views, activeId: fallback.id })
  state.selected = null; state.draft = null; state.dirty = false
  await load()
  say(`视图「${name}」已删除`, 'ok')
}
// 恢复默认：四个内置视图回到出厂配置，用户自建的视图保留。
async function restoreDefaultViews() {
  const defaults = defaultViews()
  const kept = state.views.filter(view => !isDefaultView(view.id))
  state.views = [...defaults, ...kept]
  const active = state.views.find(view => isDefaultView(view.id) && sourceEquals(view.source, state.current.source)) ?? state.views[0]
  applyView(active, active.id)
  writeViewStore({ views: state.views, activeId: active.id })
  clearLegacyLayout()
  state.selected = null; state.draft = null; state.dirty = false
  await load()
  say('已恢复默认视图', 'ok')
}
function sourceValueOf(source) {
  const normalized = normalizeSource(source)
  return normalized.kind === 'all' || normalized.kind === 'hidden' ? normalized.kind : `${normalized.kind}:${normalized.id}`
}
function parseSourceValue(value) {
  const parts = String(value ?? '').split(':')
  return normalizeSource({ kind: parts[0], id: parts.slice(1).join(':') })
}
function viewSettings() {
  if (document.querySelector('dialog[open]')) return
  const view = state.current
  let dialog = null
  const options = (entries, active) => entries.map(([value, label]) => h('option', { value, text: label, selected: value === active ? 'selected' : undefined }))
  const sourceControl = h('select', { class: 'select', id: 'view-source', 'aria-label': '数据来源' }, options([
    ['all', '全部记忆'], ['scope:knowledge', '知识库'], ['scope:conversation', '对话记忆'], ['hidden', '隐藏记忆'],
    ...state.data.groups.map(group => [`group:${group.id}`, `记忆组 · ${groupLabel(group)}`]),
  ], sourceValueOf(view.source)))
  const nameInput = h('input', { class: 'input', id: 'view-name', value: view.name, maxlength: '60', 'aria-label': '视图名称', autocomplete: 'off' })
  const shapeControl = h('select', { class: 'select', id: 'view-shape', 'aria-label': '版式' }, options(Object.entries(SHAPE_LABELS), view.shape))
  const sortControl = h('select', { class: 'select', id: 'view-sort', 'aria-label': '排序' }, options(Object.entries(SORT_LABELS), view.sort))
  const groupControl = h('select', { class: 'select', id: 'view-group-by', 'aria-label': '分组' }, options(Object.entries(GROUPING_LABELS), view.groupBy))
  const tagInput = h('input', { class: 'input', id: 'view-tags', value: view.filters.tags.join(', '), placeholder: '用逗号分隔；留空表示不按标签筛选', 'aria-label': '按标签筛选' })
  const baseBox = h('input', { type: 'checkbox', id: 'view-only-base', checked: view.filters.onlyBase ? 'checked' : undefined })
  const imageBox = h('input', { type: 'checkbox', id: 'view-only-images', checked: view.filters.onlyWithImages ? 'checked' : undefined })
  const summary = h('p', { class: 'view-filter-summary', role: 'status', 'aria-live': 'polite' })
  const kindBoxes = Object.entries(KIND_LABELS).map(([kind, label]) => {
    const box = h('input', { type: 'checkbox', 'data-kind': kind, checked: view.filters.kinds.includes(kind) ? 'checked' : undefined })
    return h('label', { class: 'view-kind' }, box, label)
  })
  const paint = () => {
    const current = state.current
    const rules = describeFilters(current.filters)
    summary.textContent = rules.length ? `生效中的筛选：${rules.join('；')}（当前视图共 ${state.shown} 条可见）` : '当前没有筛选。保存后这个视图会记住筛选、排序与分组。'
    kindBoxes.forEach(node => node.classList.toggle('on', node.querySelector('input').checked))
    if (el('filter-count')) { const count = activeFilterCount(current.filters); el('filter-count').textContent = String(count); el('filter-count').classList.toggle('hidden', count === 0) }
  }
  const applyFilters = patch => {
    const kinds = [...dialog.querySelectorAll('[data-kind]')].filter(node => node.checked).map(node => node.dataset.kind)
    const tags = tagInput.value.split(/[,，、]/).map(text => text.trim()).filter(Boolean)
    updateView({ filters: normalizeFilters({ ...state.current.filters, ...patch, kinds, tags, onlyBase: baseBox.checked, onlyWithImages: imageBox.checked }) }, { quiet: true })
    paint()
  }
  nameInput.addEventListener('input', () => {
    const name = nameInput.value.trim()
    if (name === '') return
    state.current = normalizeView({ ...state.current, name })
    persistView()
    if (!state.query) el('view-title').textContent = name
    syncViewControls()
  })
  nameInput.addEventListener('change', () => {
    if (nameInput.value.trim() !== '') return
    nameInput.value = state.current.name
    say('视图名称不能为空', 'err')
  })
  sourceControl.addEventListener('change', () => void guard(() => changeSource(parseSourceValue(sourceControl.value))))
  shapeControl.addEventListener('change', () => { updateView({ shape: shapeControl.value }, { quiet: true }); paint() })
  sortControl.addEventListener('change', () => { updateView({ sort: sortControl.value }, { quiet: true }); paint() })
  groupControl.addEventListener('change', () => { updateView({ groupBy: groupControl.value }, { quiet: true }); paint() })
  tagInput.addEventListener('change', () => applyFilters({}))
  baseBox.addEventListener('change', () => applyFilters({}))
  imageBox.addEventListener('change', () => applyFilters({}))
  for (const node of kindBoxes) node.querySelector('input').addEventListener('change', () => applyFilters({}))
  dialog = modal('视图设置',
    h('div', { class: 'view-settings-grid' },
      field('名称', nameInput),
      field('数据来源', sourceControl),
      field('版式', shapeControl),
      field('排序', sortControl),
      field('分组', groupControl),
      h('div', { class: 'col' }, h('span', { class: 'label', text: '标签' }), tagInput)),
    h('div', { class: 'col' }, h('span', { class: 'label', text: '按类型筛选' }), h('div', { class: 'view-kinds' }, kindBoxes)),
    h('div', { class: 'row' },
      h('label', { class: 'switch-row' }, baseBox, '只看底层约定'),
      h('label', { class: 'switch-row' }, imageBox, '只看有图片'),
      h('span', { class: 'spacer' }),
      button('清除全部筛选', async () => { for (const node of kindBoxes) node.querySelector('input').checked = false; tagInput.value = ''; baseBox.checked = false; imageBox.checked = false; clearViewFilters(); paint() }, false, { class: 'btn ghost' })),
    summary,
    h('div', { class: 'view-settings-foot' },
      button('保存并关闭', async () => dialog.close(), true),
      button('另存为', async () => { await saveViewAs(); dialog.close() }),
      button('删除视图', async () => { await deleteView(); dialog.close() }, false, { class: 'btn ghost danger', disabled: !state.viewId ? true : undefined }),
      h('span', { class: 'spacer' }),
      button('恢复默认视图', async () => { await restoreDefaultViews(); dialog.close() }, false, { class: 'btn ghost' })),
    h('p', { class: 'cap', text: state.viewId ? '改动会立刻保存到这个视图。' : '这是临时视图（没有存过）。点「另存为」把它存下来，才会记住筛选与版式。' }))
  paint()
  return dialog
}
async function newMemory() {
  if (!await discard()) return
  const scope = state.view.kind === 'scope' ? state.view.id : 'knowledge'
  const group = state.data.groups.find(group => group.id === state.view.id) ?? state.data.groups.find(group => group.scope === scope) ?? state.data.groups[0]
  selectEntry({ id: '', title: '', content: '', tags: [], kind: 'note', scope: group.scope, priority: 0, base: false, hidden: false, groupId: group.id })
  document.querySelector('#drawer [data-field="title"]').focus()
}
el('new').addEventListener('click', () => void guard(newMemory))
// 形状切换：改的是当前视图（保存过的视图立刻写回，临时视图只影响本次会话）。
for (const [id, shape] of SHAPE_BUTTONS) el(id).addEventListener('click', () => {
  if (state.current.shape === shape) return
  updateView({ shape })
})
el('sort').title = '对已加载的记忆排序；加载更多后一起排序'
el('sort').addEventListener('change', () => { if (el('sort').value !== state.current.sort) updateView({ sort: el('sort').value }) })
el('view-settings').addEventListener('click', () => viewSettings())
el('new-view')?.addEventListener('click', () => void guard(async () => { await saveViewAs(); viewSettings() }))
el('manage-groups').addEventListener('click', () => void guard(async () => { if (await discard()) groupManager() }))
el('settings').addEventListener('click', () => void guard(async () => settings()))
el('workspace-settings').addEventListener('click', () => { state.settingsTab='appearance';void guard(async()=>settings()) })
// 右上角圆形头像（若该版本没有这一颗按钮，就跳过，不阻断启动）。
el('avatar')?.addEventListener('click', () => void guard(async () => { if (await discard()) settings() }))
el('curation-setup').addEventListener('click', () => void guard(async () => { if (await discard()) { state.settingsTab = 'model'; settings() } }))
el('refresh').addEventListener('click', () => void guard(async () => { if (await discard()) { state.selected = null; state.draft = null; state.dirty = false; await load(); say('已刷新', 'ok') } }))
let timer, composing = false
function scheduleSearch() {
  clearTimeout(timer)
  if (composing || state.dirty || state.busy || !state.data || document.body.dataset.mode === 'mistakebook' || document.querySelector('dialog[open]') || el('query').value.trim() === state.query) return
  timer = setTimeout(() => void guard(applySearch), 220)
}
async function applySearch() {
  const query = el('query').value.trim()
  if (query === state.query) { renderSearchContext(); return }
  if (!await discard()) { el('query').value = state.query; renderSearchContext(); return }
  el('query').value = query
  state.query = query; state.selected = null; state.draft = null; state.dirty = false
  await load()
}
async function clearSearch() {
  clearTimeout(timer)
  if (!state.query) { el('query').value = ''; renderSearchContext(); return }
  el('query').value = ''; await applySearch()
}
el('clear-search').addEventListener('click', () => void guard(clearSearch))
el('query').addEventListener('input', () => { renderSearchContext(); scheduleSearch() })
el('query').addEventListener('compositionstart', () => { composing = true; clearTimeout(timer) })
el('query').addEventListener('compositionend', () => { composing = false; scheduleSearch() })
el('query').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); clearTimeout(timer); void guard(applySearch) }
  if (event.key === 'Escape' && el('query').value.trim() !== state.query) { event.preventDefault(); event.stopPropagation(); el('query').value = state.query; renderSearchContext() }
})
// 工作区布局：显式「布局」入口 + 可拖动分隔条 + 面板/页面/密度偏好。
// 偏好只落在渲染层 localStorage（alaya.db.layout），不写入数据库文件，
// 与笔记本写在 notebook prefs 里的布局偏好互不影响。
const layout = mountWorkspaceLayout({
  shell: document.querySelector('.app-shell'),
  host: document.createElement('div'),
  store: createStorageStore(),
  icon,
  onStatus: (message, tone) => say(message, tone),
  expandHost: document.querySelector('.bar .breadcrumb'),
  focusExitHost: document.querySelector('.bar .toolbar-actions'),
  escapeGuard: () => !state.selected && !state.dirty,
})
const palette = mountCommandPalette({
  h, el, icon, guard,
  ready: () => Boolean(state.data),
  commands: () => [
    { label: '新建记忆', hint: '动作', run: () => newMemory() },
    { label: '搜索记忆', hint: '动作', run: () => { el('query').focus(); el('query').select() } },
    { label: '全部记忆', hint: '视图', run: () => navigate({ kind: 'all' }) },
    { label: '知识库', hint: '视图', run: () => navigate({ kind: 'scope', id: 'knowledge' }) },
    { label: '对话记忆', hint: '视图', run: () => navigate({ kind: 'scope', id: 'conversation' }) },
    { label: '隐藏记忆', hint: '视图', run: () => navigate({ kind: 'hidden' }) },
    ...(state.data?.groups ?? []).map(group => ({ label: groupLabel(group), hint: '记忆组', run: () => navigate({ kind: 'group', id: group.id }) })),
    { label: '布局：打开布局菜单', hint: '布局', run: () => { el('layout-menu').open = true; el('layout-toggle').focus() } },
    { label: '布局：折叠或展开侧栏', hint: '布局', run: () => layout.set({ sideCollapsed: !layout.prefs().sideCollapsed }) },
    { label: '布局：切换专注模式', hint: '布局', run: () => layout.set({ focus: !layout.prefs().focus }) },
    { label: '布局：恢复默认', hint: '布局', run: () => layout.reset() },
    { label: '设置与连接', hint: '动作', run: async () => { if (await discard()) settings() } },
    // 视图相关命令追加在最后：命令面板的前几项顺序是既有测试的契约。
    { label: '视图：视图设置', hint: '视图', run: async () => viewSettings() },
    { label: '视图：新建视图', hint: '视图', run: async () => { const created = await saveViewAs(); if (created) viewSettings() } },
    { label: '视图：恢复默认视图', hint: '视图', run: async () => restoreDefaultViews() },
    // 捕获入口同样追加在末尾：前几项的顺序是命令面板测试的契约。
    { label: '快速捕获', hint: '动作', run: () => openCapture() },
  ],
})
// 统一捕获：一处输入，按目标写进记忆域或笔记本域。两域各走自己的写通道
// （entry.write / notebook.save），不共享表、不互相读取；面板偏好只落
// localStorage['alaya.db.capture']，绝不进数据库 meta 表。
// 按需挂载：用户第一次打开时才创建面板，启动期不付这份成本，也让面板保持唯一实例。
let captureTargets = { groups: [], noteTypes: NOTEBOOK_TARGETS }
function ensureCapture() {
  if (!capture) {
    capture = mountQuickCapture({
      h, icon, call,
      modes:productVariant==='database'?['knowledge','conversation']:undefined,
      notebook: (op, body) => desktop('notebook', op, body),
      say,
      // 记忆域写入后列表要跟着更新；笔记本域由笔记本界面自己刷新。捕获面板是模态的，
      // 这里仍然直接刷新底下的列表——render() 只重建列表/抽屉，不会丢掉面板里的输入。
      onStatus: status => {
        if (status?.tone === 'ok' && status.mode !== 'notebook' && state.data) load().catch(error => say(error.message ?? String(error), 'err'))
      },
    })
  }
  capture.setTargets(captureTargets)
  return capture
}
syncCaptureTargets()
function syncCaptureTargets() {
  captureTargets = { groups: state.data?.groups ?? [], noteTypes: NOTEBOOK_TARGETS }
  if (capture) capture.setTargets(captureTargets)
}
async function openCapture(target) {
  if (!await discard()) return
  await ensureCapture().open(target)
}
el('capture').addEventListener('click', () => void guard(() => openCapture()))
el('command-palette').addEventListener('click', () => void guard(palette.open))
const paletteShortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ K' : 'Ctrl K'
el('command-palette').querySelector('kbd').textContent = paletteShortcut
el('command-palette').setAttribute('aria-label', `命令面板，快捷键 ${paletteShortcut}`)
document.addEventListener('keydown', event => {
  // A dialog may have closed in its own key handler already. Respect its
  // consumed Escape rather than also closing the editor underneath it.
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return
  if (document.body.dataset.mode === 'mistakebook') return
  if (document.querySelector('dialog[open]') || !state.data) return
  if (event.ctrlKey || event.metaKey) {
    if (event.key.toLowerCase() === 'f') { event.preventDefault(); el('query').focus(); el('query').select() }
    if (event.key.toLowerCase() === 'k' && !event.altKey && !event.shiftKey && !event.repeat) { event.preventDefault(); void guard(palette.open) }
    if (event.key.toLowerCase() === 'n' && event.shiftKey) { event.preventDefault(); void guard(() => openCapture()) }
    else if (event.key.toLowerCase() === 'n') { event.preventDefault(); void guard(newMemory) }
    if (event.key.toLowerCase() === 's' && state.selected) { event.preventDefault(); document.querySelector('.editor-form').requestSubmit() }
  }
  if (event.key === 'Escape') {
    if (el('curation-menu').open) { el('curation-menu').open = false; return }
    if (state.selected) void guard(async () => { if (await discard()) { state.selected = null; state.dirty = false; renderList(); renderDrawer() } })
  }
})
document.addEventListener('click', event => { if (!el('curation-menu').contains(event.target)) el('curation-menu').open = false })
window.addEventListener('focus', () => { if (document.body.dataset.mode !== 'mistakebook' && !state.dirty && state.data && !document.querySelector('dialog[open]')) void guard(() => load()) })
async function bootstrap(){
if(productVariant!=='database'){
const {mountMistakebook}=await import('./mistakebook.js')
mountMistakebook({ appearance, beforeEnter: async () => {
  if (state.busy || document.querySelector('dialog[open]') || !await discard()) return false
  state.dirty = false; state.selected = null; state.draft = null; render(); return true
} })
}
void guard(async () => {
  await runAlayaStartup(load)
}).then(() => {
  // Open where the user left off; the notebook is this app's primary face.
  if(productVariant!=='database'&&(localStorage.getItem('alaya.mode')??'notebook')==='notebook')document.getElementById('mode-switch').click()
  else say('Alaya 已打开')
})
}
void bootstrap()
