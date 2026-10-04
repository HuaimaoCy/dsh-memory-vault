import { icon } from './icons.js'
import { createLoadingStatus } from './loading.js'
import { NOTE_TYPES, STRUCTURED_FIELDS, normalizeFields } from '../../addons/mistakebook/fields.mjs'
import { SIMULATIONS } from '../../addons/mistakebook/simulations.mjs'
import { extractWords, normalizeWord } from '../../addons/mistakebook/words.mjs'
import { renderRelationTree, vocabularyGraph } from './relations.js'
import { attachSplitter } from './layout.js'
import { renderTagEditor, renderTagCloud } from './tags.js'
import { createSidebarController, renderSidebarConfig, migrateLegacySidebar } from './sidebar.js'
import { renderRich } from './markdown.js'

const h = (tag, props = {}, ...children) => {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = value
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value)
    else if (['value', 'checked', 'disabled'].includes(key)) node[key] = value
    else node.setAttribute(key, String(value))
  }
  for (const item of children.flat(Infinity)) if (item !== null && item !== undefined && item !== false) node.append(item instanceof Node ? item : String(item))
  return node
}
const field = (name, input) => h('label', { class: 'col' }, h('span', { class: 'label', text: name }), input)
const append = (node, ...children) => node.append(...children.filter(child => child !== null && child !== undefined && child !== false))
const labelStates = { new: '待复习', reviewing: '复习中', mastered: '已掌握' }
const date = value => value ? new Date(value).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }) : '尚未安排'
const dataURL = image => `data:${image.mimeType};base64,${image.data}`
async function call(action, body) {
  // 统一 op 通道：vault.notebook；后端未就绪时回退旧通道（兼容期）。
  const channel = typeof window.vault?.notebook === 'function' ? window.vault.notebook : window.vault.mistakebook
  const reply = await channel(action, body)
  if (!reply.ok) throw new Error(reply.error || '操作失败')
  return reply.result
}
// Store-side dedupe (import) looks at every record including archived and
// trashed ones, so the preview must consider all three views.
const existingVocabularyWords = async () => {
  const words = new Set()
  for (const view of ['all', 'archived', 'trash']) for (const row of (await call('list', { view, type: 'vocabulary' })).records) if (row.vocabulary?.word) words.add(normalizeWord(row.vocabulary.word))
  return words
}
async function confirm(message) { return (await window.vault.confirm(message)).result === true }
async function filePayload(file, allowPDF = false) {
  const max = allowPDF && file.type === 'application/pdf' ? 50 : 10
  if (file.size > max * 1024 * 1024) throw new Error(`文件不能超过 ${max} MB`)
  if (!(allowPDF ? ['image/png', 'image/jpeg', 'application/pdf'] : ['image/png', 'image/jpeg', 'image/webp', 'image/gif']).includes(file.type)) throw new Error(allowPDF ? '请选择 PNG、JPEG 或 PDF' : '请选择 PNG、JPEG、WebP 或 GIF')
  const result = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = () => reject(new Error('无法读取文件')); reader.readAsDataURL(file) })
  const image = { name: file.name, mimeType: file.type, data: result, size: file.size }
  if (file.type.startsWith('image/')) {
    const decoded = new Image(); decoded.src = dataURL(image); await decoded.decode()
    if (decoded.naturalWidth > 16384 || decoded.naturalHeight > 16384 || decoded.naturalWidth * decoded.naturalHeight > 40000000) throw new Error('图片尺寸过大')
  }
  return image
}
const firstMeaningfulLine = text => text.split(/\r?\n/).map(line => line.replace(/^\s*(?:#{1,6}\s*)?(?:[-*+]\s+|>\s*|\d{1,3}[.、)]\s*)?/, '').replace(/[*`]/g, '').trim()).find(Boolean)?.slice(0, 60) ?? ''

export function mountMistakebook({ beforeEnter }) {
  const memory = document.querySelector('.app-shell')
  const shell = h('div', { class: 'mb-shell', hidden: true, 'aria-label': '笔记本' })
  const state = { data: null, view: 'all', type: '', subjectID: '', nodeID: '', query: '', tag: '', order: 'priority', draft: null, dirty: false, busy: false, review: false, showAnswer: false, picking: false, selection: new Set() }
  const handwritingDrafts = new WeakMap()
  let messageTimer
  const notify = (message, error = false) => {
    const output = document.getElementById('mb-status'); output.textContent = message; output.className = `mb-status visible${error ? ' error' : ''}`
    clearTimeout(messageTimer); if (!error) messageTimer = setTimeout(() => output.classList.remove('visible'), 3500)
    const inDialog = document.querySelector('.mb-dialog[open] .mb-dialog-status')
    if (inDialog) inDialog.textContent = message
  }
  const guard = async action => {
    if (state.busy) return
    state.busy = true; shell.inert = true; shell.setAttribute('aria-busy', 'true')
    try { await action() } catch (error) { notify(error.message || String(error), true) }
    finally { state.busy = false; shell.inert = false; shell.removeAttribute('aria-busy') }
  }
  const button = (label, action, primary = false, props = {}) => h('button', { type: 'button', class: primary ? 'btn primary' : 'btn', onClick: event => void guard(() => action(event)), ...props }, label)
  const discard = async () => !state.dirty || await confirm('当前笔记有未保存的修改，放弃这些修改？')
  const dirty = () => { state.dirty = true; const hint = document.getElementById('mb-save-state'); if (hint) { hint.textContent = '有未保存的修改'; hint.classList.add('dirty') }; const saveButton = document.getElementById('mb-save'); if (saveButton) saveButton.disabled = false }
  const names = () => new Map((state.data?.taxonomy.nodes ?? []).map(node => [node.id, node.name]))
  const changeView = async (view, subjectID = '', nodeID = '', type = '') => {
    if (!await discard()) return
    Object.assign(state, { view, subjectID, nodeID, type, tag: '', draft: null, dirty: false, review: false, picking: false }); state.selection.clear(); await load()
  }
  const load = async () => {
    state.data = await call('list', { view: state.view, type: state.type, subjectID: state.subjectID, nodeID: state.nodeID, query: state.query, tag: state.tag, order: state.order })
    const incoming = state.data.prefs
    prefsCache = incoming && typeof incoming === 'object' && !Array.isArray(incoming) ? { ...incoming } : {}
    if (['priority', 'updated', 'manual'].includes(prefsCache.order) && state.order !== prefsCache.order) {
      state.order = prefsCache.order
      const sort = document.getElementById('mb-sort'); if (sort) sort.value = state.order
    }
    if (state.data.sidebar === null) {
      const migrated = migrateLegacySidebar()
      if (migrated) { await call('sidebar.save', { config: migrated }); state.data.sidebar = migrated }
    }
    sidebar.sync()
    renderSide(); renderList(); renderDetail()
  }
  // 图标即切换：品牌图标本身是模式切换按钮（与数据库侧一致）。
  const switchButton = button([icon('vault')], async () => {
    if (document.querySelector('dialog[open]') || !await discard()) return
    localStorage.setItem('alaya.mode', 'memory')
    state.draft = null; state.dirty = false; shell.hidden = true; memory.hidden = false; document.body.dataset.mode = 'memory'
    document.getElementById('mode-switch').focus()
  }, false, { class: 'mb-book-mark', id: 'mb-mode-switch', title: '切换到数据库', 'aria-label': '切换到数据库', 'aria-pressed': 'true' })
  const search = h('input', { type: 'search', class: 'search', id: 'mb-query', placeholder: '搜索笔记、模型与单词', 'aria-label': '搜索笔记' })
  let searchTimer
  search.addEventListener('input', () => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => void guard(async () => {
      if (!await discard()) { search.value = state.query; return }
      state.query = search.value.trim(); state.draft = null; state.dirty = false; state.selection.clear(); await load()
    }), 220)
  })
  const sideViews = h('nav', { id: 'mb-views', 'aria-label': '笔记视图' }), categories = h('nav', { id: 'mb-types', 'aria-label': '笔记类型' }), subjects = h('nav', { id: 'mb-subjects', 'aria-label': '学科' })
  const list = h('div', { id: 'mb-list', class: 'mb-list' }), detail = h('section', { id: 'mb-detail', class: 'mb-detail', hidden: true, 'aria-label': '题目编辑器' })
  // —— 自由布局：侧边栏/详情宽度用 CSS 变量承载，拖动分隔条即改写并持久化 ——
  // 布局与排序偏好存笔记本数据库（随 list 返回 prefs，写入走 prefs.save），
  // 渲染层不再使用 localStorage。prefsCache 是内存镜像，写入异步落库。
  const LAYOUT_DEFAULTS = { sideW: 220, detailW: 440, detailSide: 'right' }
  let prefsCache = {}
  const layoutPrefs = () => ({ ...LAYOUT_DEFAULTS, ...prefsCache })
  const applyLayout = (prefs = layoutPrefs()) => {
    shell.style.setProperty('--mb-side-w', `${prefs.sideW}px`)
    shell.style.setProperty('--mb-detail-w', `${prefs.detailW}px`)
    shell.classList.toggle('detail-left', prefs.detailSide === 'left')
  }
  const savePrefs = next => { prefsCache = next; void guard(() => call('prefs.save', next)); applyLayout(next) }
  const saveLayout = prefs => savePrefs(prefs)
  const setPanelWidth = (name, width, min, max) => {
    const prefs = layoutPrefs()
    prefs[name] = Math.round(Math.min(max, Math.max(min, width)))
    saveLayout(prefs)
  }
  const sideSplitter = h('div', { class: 'mb-splitter', id: 'mb-side-split', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': '拖动调整侧边栏宽度，双击恢复默认', title: '拖动调整宽度 · 双击复位' })
  const detailSplitter = h('div', { class: 'mb-splitter', id: 'mb-detail-split', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': '拖动调整详情面板宽度，双击恢复默认', title: '拖动调整宽度 · 双击复位', hidden: true })
  let sideOrigin = 0, detailOrigin = 0
  attachSplitter(sideSplitter, { onStart: () => { sideOrigin = layoutPrefs().sideW }, onResize: ({ dx }) => setPanelWidth('sideW', sideOrigin + dx, 170, 320), onReset: () => setPanelWidth('sideW', 220, 170, 320) })
  attachSplitter(detailSplitter, {
    onStart: () => { detailOrigin = layoutPrefs().detailW },
    onResize: ({ dx }) => setPanelWidth('detailW', detailOrigin + dx * (layoutPrefs().detailSide === 'left' ? 1 : -1), 320, 760),
    onReset: () => setPanelWidth('detailW', 440, 320, 760),
  })
  // —— 自定义侧边栏：区块注册表驱动，顺序与显隐持久化在本机 ——
  const tagNav = h('div', { class: 'mb-side-tags' })
  const sideScroll = h('div', { class: 'mb-side-scroll', id: 'mb-side-scroll' })
  // 条目注册表：itemId（view:all / type:physics / subject:english）→ 可点击
  // 元素；侧边栏控制器与配置对话框共用这一份目录。
  const viewItems = () => [['all', '全部笔记', 'library'], ['due', '待复习', 'task'], ['mastered', '已掌握', 'check'], ['archived', '归档', 'folder'], ['trash', '回收站', 'hidden']].map(([view, label, symbol]) => ({ id: `view:${view}`, label, view, element: button([icon(symbol), h('span', { class: 'nav-label', text: label }), h('span', { class: 'count', text: state.data?.stats[view] ?? 0 })], () => changeView(view), false, { class: `nav${state.view === view && !state.subjectID && !state.type ? ' on' : ''}`, 'data-mb-view': view, 'aria-current': state.view === view && !state.subjectID && !state.type ? 'page' : 'false' }) }))
  const typeItems = () => Object.entries(NOTE_TYPES).map(([type, meta]) => ({ id: `type:${type}`, label: meta.label, type, element: button([icon(meta.icon), h('span', { class: 'nav-label', text: meta.label }), h('span', { class: 'count', text: state.data?.stats.types[type] ?? 0 })], () => changeView('all', '', '', type), false, { class: `nav${state.type === type ? ' on' : ''}`, 'data-mb-type': type }) }))
  const subjectItems = () => (state.data?.taxonomy.nodes ?? []).filter(node => !node.parentID).map(node => ({ id: `subject:${node.id}`, label: node.name, subject: node.id, element: button([h('span', { class: 'mb-subject-dot', text: node.name.slice(0, 1) }), h('span', { class: 'nav-label', text: node.name }), h('span', { class: 'count', text: state.data?.stats.subjects[node.id] ?? 0 })], () => changeView('all', node.id), false, { class: `nav${state.subjectID === node.id ? ' on' : ''}`, 'data-mb-subject': node.id }) }))
  const allSideItems = () => [...viewItems(), ...typeItems(), ...subjectItems()]
  const itemFor = id => allSideItems().find(item => item.id === id) ?? null
  // 侧边栏配置存数据库（随 list 返回），写入走 sidebar.save；旧 localStorage
  // 配置只在首次读取时迁移一次。与数据库侧边栏同为数据驱动。
  const sidebar = createSidebarController({
    read: () => state.data?.sidebar ?? null,
    write: next => void guard(async () => { await call('sidebar.save', { config: next }) }),
    knownItems: () => allSideItems().map(item => item.id),
    onApply: () => renderSide(),
  })
  function openSidebarConfig() {
    // 改动即时写回数据库；关闭对话框即完成。
    dialog('自定义侧边栏', h('div', { class: 'mb-side-config-page' },
      renderSidebarConfig({ config: sidebar.config(), knownItems: allSideItems, onChange: next => sidebar.setConfig(next) }),
      h('div', { class: 'row mb-side-config-foot' }, h('span', { class: 'spacer' }),
        button('恢复默认侧边栏', () => { sidebar.setConfig({ sections: [], hidden: [] }); notify('侧边栏已恢复默认') }, false, { class: 'btn ghost', id: 'mb-side-config-reset' }))))
  }
  const heading = h('h1', { id: 'mb-title', text: '全部笔记' }), subtitle = h('p', { id: 'mb-subtitle', text: '记录问题，建立模型，积累自己的解题方法。' })
  const jsonPicker = h('input', { type: 'file', accept: '.json,application/json', hidden: true, id: 'mb-json-picker', onChange: event => void guard(async () => {
    const file = event.target.files[0]; event.target.value = ''; if (!file) return
    if (!await discard()) return
    if (file.size > 100 * 1024 * 1024) throw new Error('JSON 超过 100 MB，请分批导入')
    let value; try { value = JSON.parse(await file.text()) } catch { throw new Error('无法解析 JSON 文件') }
    const records = Array.isArray(value) ? value : Array.isArray(value.records) ? value.records : value.records && typeof value.records === 'object' ? Object.values(value.records) : null
    if (!records || records.length > 3000) throw new Error('请选择旧版 Web/iOS 导出的错题 JSON，一次最多 3000 道题')
    if (!await confirm(`将从「${file.name}」导入 ${records.length} 道题，重复题干会跳过。继续？`)) return
    const result = await call('import', value); state.draft = null; state.dirty = false; await load(); notify(`导入 ${result.created} 道题，跳过 ${result.skipped} 道重复题${result.unmapped ? `；${result.unmapped} 道旧知识点需重新分类` : ''}${result.missingImages ? `；${result.missingImages} 道需补充旧版原图` : ''}`)
  }) })
  const order = h('select', { id: 'mb-sort', class: 'select', 'aria-label': '笔记排序', onChange: event => void guard(async () => { state.order = event.target.value; savePrefs({ ...prefsCache, order: state.order }); await load() }) }, h('option', { value: 'priority', text: '复习优先级' }), h('option', { value: 'updated', text: '最近更新' }), h('option', { value: 'manual', text: '自由排列' }))
  order.value = state.order
  const clearSearch = async () => { if (!await discard()) return; clearTimeout(searchTimer); state.query = ''; state.tag = ''; search.value = ''; state.draft = null; state.dirty = false; state.selection.clear(); await load(); search.focus() }
  const searchFilter = h('div', { class: 'mb-search-filter', id: 'mb-search-filter', hidden: true }, h('span', { id: 'mb-search-filter-label' }), button('清除搜索', clearSearch, false, { class: 'btn ghost', id: 'mb-clear-search' }))
  const moreMenu = h('details', { class: 'mb-more', id: 'mb-more' },
    h('summary', { class: 'btn soft', 'aria-label': '导入与导出' }, '导入 / 导出'),
    h('div', { class: 'mb-more-menu' },
      button('导出笔记本 JSON', async () => { moreMenu.removeAttribute('open'); if (await call('export')) notify('笔记本已导出，包含图片') }, false, { id: 'mb-export' }),
      button('导入旧版错题 JSON', () => { moreMenu.removeAttribute('open'); jsonPicker.click() }, false, { id: 'mb-legacy-import' })))
  document.addEventListener('click', event => { if (moreMenu.open && !moreMenu.contains(event.target)) moreMenu.removeAttribute('open') })
  const pickButton = button('多选', async () => { if (!state.picking && !await discard()) return; state.picking = !state.picking; state.selection.clear(); if (state.picking) { state.draft = null; state.dirty = false; renderDetail() }; renderList() }, false, { class: 'btn ghost', id: 'mb-pick', 'aria-pressed': 'false' })
  const togglePick = id => { state.selection.has(id) ? state.selection.delete(id) : state.selection.add(id); renderList() }
  // 笔记块自由拖动：把卡片拖到另一张卡上即按新位置重排；非「自由排列」
  // 模式下拖动会自动切换过去（排序偏好一并记住）。多选勾选时禁用拖动。
  let dragNoteID = ''
  const makeDraggable = (card, row) => {
    card.setAttribute('draggable', 'true')
    card.addEventListener('dragstart', event => {
      if (state.picking) { event.preventDefault(); return }
      dragNoteID = row.id
      card.classList.add('dragging')
      try { event.dataTransfer?.setData('text/plain', row.id) } catch { /* 合成事件没有 dataTransfer */ }
    })
    card.addEventListener('dragend', () => { dragNoteID = ''; card.classList.remove('dragging') })
    card.addEventListener('dragover', event => { if (!dragNoteID || dragNoteID === row.id) return; event.preventDefault(); card.classList.add('drop-above') })
    card.addEventListener('dragleave', () => card.classList.remove('drop-above'))
    card.addEventListener('drop', event => {
      event.preventDefault(); card.classList.remove('drop-above')
      if (!dragNoteID || dragNoteID === row.id) return
      const ids = state.data.records.map(record => record.id)
      const from = ids.indexOf(dragNoteID), to = ids.indexOf(row.id)
      if (from < 0 || to < 0) return
      ids.splice(to, 0, ids.splice(from, 1)[0])
      dragNoteID = ''
      const switching = state.order !== 'manual'
      void guard(async () => {
        if (switching) {
          state.order = 'manual'; savePrefs({ ...prefsCache, order: 'manual' })
          const sort = document.getElementById('mb-sort'); if (sort) sort.value = 'manual'
        }
        await call('reorder', { ids })
        await load()
        notify(switching ? '已切换为「自由排列」，按拖动位置排序' : '已按拖动位置重新排列')
      })
    })
  }
  // —— AI 侧边栏：右缘滑出；问答记录持久化在笔记本数据库，可整理成笔记 ——
  const aiChat = { messages: [], running: false, loaded: false }
  const aiSide = h('aside', { class: 'mb-ai-side', id: 'mb-ai-side', hidden: true, 'aria-label': 'AI 助手' })
  const paintAI = () => {
    const list = aiSide.querySelector('#mb-ai-messages')
    if (!list) return
    if (!aiChat.messages.length) { list.replaceChildren(h('p', { class: 'cap', text: '还没有查询记录。问一个问题，记录会保存在本机数据库里，可随时整理成笔记。' })); return }
    list.replaceChildren(...aiChat.messages.map(message => message.role === 'assistant'
      ? h('div', { class: 'mb-ai-msg assistant' }, renderRich(message.content),
          h('div', { class: 'mb-ai-msg-actions' }, h('button', { type: 'button', class: 'btn ghost mb-ai-to-note', 'data-ai-to-note': message.questionId ?? '', title: '把这一轮问答整理成一篇笔记', onClick: event => { event.stopPropagation(); void toNote(message) } }, '存为笔记')))
      : h('div', { class: `mb-ai-msg ${message.role}`, text: message.content })))
    list.scrollTop = list.scrollHeight
  }
  const loadAIHistory = async () => {
    const result = await call('ai.history', { limit: 60 })
    aiChat.messages = result.messages
    aiChat.loaded = true
    paintAI()
  }
  const toNote = async message => {
    if (!message.questionId) throw new Error('这条记录缺少关联问题，无法整理')
    const note = await call('ai.toNote', { questionId: message.questionId })
    await load()
    notify(`已整理成笔记：${note.title}`)
    return note
  }
  const clearAIHistory = async () => {
    if (!await confirm('清空全部 AI 查询记录？整理好的笔记不受影响。')) return
    const result = await call('ai.clear')
    aiChat.messages = []
    paintAI()
    notify(`已清空 ${result.removed} 条 AI 记录`)
  }
  const sendAI = async () => {
    if (aiChat.running) return
    const input = aiSide.querySelector('#mb-ai-input')
    const content = input.value.trim()
    if (!content) return
    input.value = ''
    aiChat.messages.push({ role: 'user', content })
    aiChat.running = true
    aiSide.querySelector('#mb-ai-send').disabled = true
    paintAI()
    try {
      const result = await call('chat', { content })
      aiChat.messages.push({ role: 'assistant', content: result.text, questionId: result.questionId })
    } catch (error) {
      notify(error.message || String(error), true)
    } finally {
      aiChat.running = false
      const send = aiSide.querySelector('#mb-ai-send'); if (send) send.disabled = false
      paintAI()
      aiSide.querySelector('#mb-ai-input')?.focus()
    }
  }
  function buildAISide() {
    aiSide.append(
      h('div', { class: 'mb-ai-head' }, h('strong', { text: 'AI 学习助手' }), h('span', { class: 'cap', text: '记录保存在本机数据库' }), h('span', { class: 'spacer' }),
        h('button', { type: 'button', class: 'btn ghost', id: 'mb-ai-clear', text: '清空记录', title: '清空全部 AI 查询记录', onClick: () => void guard(clearAIHistory) }),
        h('button', { type: 'button', class: 'icon-button', 'aria-label': '收起 AI 助手', title: '收起', onClick: () => { aiSide.hidden = true } }, icon('close'))),
      h('div', { class: 'mb-ai-messages', id: 'mb-ai-messages' }),
      h('form', { class: 'mb-ai-form', onSubmit: event => { event.preventDefault(); void sendAI() } },
        h('textarea', { class: 'area', id: 'mb-ai-input', rows: 3, placeholder: '问问题、要思路、核对要点…（Enter 发送，Shift+Enter 换行）', onKeydown: event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendAI() } } }),
        h('button', { type: 'button', class: 'btn primary', id: 'mb-ai-send', text: '发送', onClick: () => void sendAI() })))
    paintAI()
  }
  const toggleAISide = () => {
    if (aiSide.hidden) {
      if (!aiSide.childElementCount) buildAISide()
      aiSide.hidden = false
      aiSide.querySelector('#mb-ai-input')?.focus()
      if (!aiChat.loaded) void guard(loadAIHistory)
    } else aiSide.hidden = true
  }
  shell.append(h('aside', { class: 'mb-side' },
    h('div', { class: 'brand' }, switchButton, h('div', {}, h('div', { class: 'brand-name', text: '笔记本' }), h('div', { class: 'brand-caption', text: 'ALAYA NOTEBOOK' }))),
    sideScroll,
    h('div', { class: 'mb-side-bottom' }, h('div', { class: 'mb-local' }, h('span', { class: 'library-dot' }), h('span', { text: '独立保存在本机' })),
      button([icon('grid'), '自定义侧边栏'], () => openSidebarConfig(), false, { class: 'nav', id: 'mb-sidebar-config', title: '调整侧边栏区块的顺序与显隐' }),
      button([icon('settings'), '笔记本设置'], openSettings, false, { class: 'nav', id: 'mb-settings' }))),
    sideSplitter,
    h('div', { class: 'mb-workspace' }, h('header', { class: 'mb-bar' }, h('div', { class: 'breadcrumb' }, icon('book'), h('span', { text: '笔记本' })),
      h('div', { class: 'toolbar-actions' }, h('label', { class: 'search-wrap' }, icon('search'), search), button('录入', () => openImport(), false, { id: 'mb-import', title: '识别或粘贴，导入错题、笔记与词汇' }), button([icon('plus'), '新建笔记'], openCreate, true, { id: 'mb-new' }))),
      h('div', { class: 'mb-body' }, h('main', { class: 'mb-main' }, h('div', { class: 'mb-page-heading' }, h('div', {}, heading, subtitle), h('div', { class: 'mb-total', id: 'mb-total' })),
        h('div', { class: 'mb-board' }, order, h('span', { class: 'spacer' }), button('AI 助手', toggleAISide, false, { class: 'btn soft', id: 'mb-ai-toggle', title: '打开 AI 学习助手侧边栏' }), button('查词典', openLookup, false, { class: 'btn soft', id: 'mb-lookup', title: '查一个单词，自动存入单词库；重复查询累计背诵次数' }), button('单词检测', openQuiz, false, { class: 'btn soft', id: 'mb-quiz' }), pickButton, moreMenu), searchFilter, list), detailSplitter, detail),
      h('footer', { class: 'mb-foot' }, h('span', { text: '笔记本 · 本地保存' }), h('span', { class: 'spacer' }))), jsonPicker, h('div', { id: 'mb-status', class: 'mb-status', role: 'status', 'aria-live': 'polite' }))
  document.body.append(shell)
  document.body.append(aiSide)
  applyLayout()
  document.getElementById('mode-switch').addEventListener('click', () => void guard(async () => {
    if (!await beforeEnter()) return
    await load(); localStorage.setItem('alaya.mode', 'notebook'); document.getElementById('status').classList.remove('show'); memory.hidden = true; shell.hidden = false; document.body.dataset.mode = 'mistakebook'; search.focus()
  }))
  const wireClassify = (element, payload) => {
    if (!element || !payload || !(payload.subjectID || payload.tag)) return
    element.addEventListener('dragover', event => { if (!dragNoteID) return; event.preventDefault(); element.classList.add('drop-target') })
    element.addEventListener('dragleave', () => element.classList.remove('drop-target'))
    element.addEventListener('drop', event => {
      event.preventDefault(); element.classList.remove('drop-target')
      if (!dragNoteID) return
      const id = dragNoteID
      dragNoteID = ''
      void guard(async () => {
        await call('assign', { id, target: payload })
        await load()
        notify(payload.subjectID ? `已把笔记移入「${names().get(payload.subjectID) ?? payload.subjectID}」` : `已添加标签「${payload.tag}」`)
      })
    })
  }
  function renderSide() {
    const stats = state.data.stats
    const config = sidebar.config()
    const hidden = new Set(config.hidden)
    const navFor = { views: sideViews, types: categories, subjects: subjects }
    const sections = []
    for (const section of config.sections) {
      if (hidden.has(section.id)) continue
      if (section.tags) {
        sections.push(h('details', { class: 'mb-side-group', id: 'mb-tags-wrap', 'data-side-section': 'tags' }, h('summary', { text: section.label }), tagNav))
        continue
      }
      const builtinNav = navFor[section.id]
      const nav = builtinNav ?? h('nav', { class: 'mb-side-custom', 'aria-label': section.label })
      const placed = section.items.filter(id => !hidden.has(id)).map(itemFor).filter(Boolean)
      nav.replaceChildren(...placed.map(item => item.element))
      for (const item of placed) if (item.subject) wireClassify(item.element, { subjectID: item.subject })
      if (builtinNav) {
        if (section.id === 'views') sections.push(h('div', { class: 'mb-side-section', 'data-side-section': 'views' }, h('div', { class: 'side-head', text: section.label }), nav))
        else if (section.id === 'types') sections.push(h('details', { class: 'mb-side-group', id: 'mb-types-wrap', 'data-side-section': 'types', open: true }, h('summary', { text: section.label }), nav))
        else {
          if (state.subjectID && placed.some(item => item.subject === state.subjectID)) {
            const nodes = state.data.taxonomy.nodes.filter(node => node.subjectID === state.subjectID && node.parentID === state.subjectID)
            nav.append(h('div', { class: 'mb-topics' }, nodes.map(node => button(node.name, () => changeView('all', state.subjectID, node.id), false, { class: `nav${state.nodeID === node.id ? ' on' : ''}` }))))
          }
          const wrap = h('details', { class: 'mb-side-group', id: 'mb-subjects-wrap', 'data-side-section': 'subjects' }, h('summary', { text: section.label }), nav)
          if (state.subjectID && placed.some(item => item.subject === state.subjectID)) wrap.open = true
          sections.push(wrap)
        }
      } else {
        if (!placed.length) nav.append(h('p', { class: 'cap mb-side-empty', text: '在「自定义侧边栏」里把条目拖进这个区块。' }))
        sections.push(h('details', { class: 'mb-side-group', 'data-side-section': section.id, open: true }, h('summary', { text: section.label }), nav))
      }
    }
    sideScroll.replaceChildren(...sections)
    tagNav.replaceChildren(renderTagCloud({ counts: stats.tags ?? {}, active: state.tag, onSelect: tag => void guard(async () => {
      if (!await discard()) return
      state.tag = state.tag === tag ? '' : tag
      state.draft = null; state.dirty = false; state.selection.clear(); await load()
    }) }))
    for (const chip of tagNav.querySelectorAll('[data-tag-filter]')) wireClassify(chip, { tag: chip.dataset.tagFilter })
  }
  async function performBatch(action) {
    const ids = [...state.selection]
    if (!ids.length) throw new Error('请先选择笔记')
    if (action === 'purge' && !await confirm(`永久删除 ${ids.length} 篇笔记及原图？此操作无法恢复。`)) return
    if (action === 'delete' && !await confirm(`将 ${ids.length} 篇笔记移入回收站？之后可以恢复。`)) return
    for (const id of ids) await call('action', { id, action })
    if (state.draft && ids.includes(state.draft.id)) { state.draft = null; state.dirty = false }
    state.selection.clear(); await load()
    notify(({ delete: `已将 ${ids.length} 篇移入回收站`, restore: `已恢复 ${ids.length} 篇`, purge: `已永久删除 ${ids.length} 篇` })[action])
  }
  function renderList() {
    const dictionary = names(), rows = state.data.records
    const visibleIDs = new Set(rows.map(row => row.id))
    for (const id of state.selection) if (!visibleIDs.has(id)) state.selection.delete(id)
    heading.textContent = NOTE_TYPES[state.type]?.label || dictionary.get(state.nodeID) || dictionary.get(state.subjectID) || ({ all: '全部笔记', due: '今天，复习一点', mastered: '已经掌握', archived: '归档笔记', trash: '回收站' })[state.view]
    subtitle.textContent = NOTE_TYPES[state.type]?.caption || (state.view === 'due' ? '先独立回忆，再展开答案与笔记核对。' : '记录问题，建立模型，积累自己的解题方法。')
    searchFilter.hidden = !(state.query || state.tag)
    document.getElementById('mb-search-filter-label').textContent = (state.query || state.tag) ? `${[state.query ? `搜索「${state.query}」` : '', state.tag ? `标签「${state.tag}」` : ''].filter(Boolean).join(' · ')} · ${rows.length} 个结果` : ''
    document.getElementById('mb-total').replaceChildren(h('strong', { text: rows.length }), h('span', { text: '篇笔记' }))
    list.replaceChildren()
    list.classList.toggle('words', state.type === 'vocabulary')
    pickButton.textContent = state.picking ? '完成' : '多选'
    pickButton.classList.toggle('on', state.picking)
    pickButton.setAttribute('aria-pressed', String(state.picking))
    pickButton.disabled = !rows.length && !state.picking
    moreMenu.hidden = state.picking
    if (!rows.length) {
      const emptyTitle = state.query ? '没有找到相关笔记' : ({ due: '今天的复习已完成', mastered: '还没有已掌握的笔记', archived: '没有归档笔记', trash: '回收站是空的' })[state.view] || `从一篇${NOTE_TYPES[state.type]?.label || '笔记'}开始`
      const emptyText = state.query ? '试试更短的关键词，或清除搜索查看当前分类。' : ({ due: '稍后再来，也可以查看全部笔记继续学习。', mastered: '复习时先独立回忆，核对后标记掌握情况。', archived: '归档后的笔记会保存在这里。', trash: '移入回收站的笔记可以在这里恢复。' })[state.view] || NOTE_TYPES[state.type]?.caption || '记录问题、整理方法，或积累一个新单词。'
      list.append(h('div', { class: 'mb-empty' }, h('div', { class: 'mb-empty-symbol' }, icon(NOTE_TYPES[state.type]?.icon || (state.view === 'trash' ? 'hidden' : 'book'))), h('h2', { text: emptyTitle }), h('p', { text: emptyText }), state.query ? button('清除搜索', clearSearch, true) : state.view !== 'all' ? button('查看全部笔记', () => changeView('all'), true) : button('新建笔记', openCreate, true)))
      return
    }
    if (state.picking) {
      const allSelected = rows.length > 0 && rows.every(row => state.selection.has(row.id))
      list.append(h('div', { class: 'mb-pick-bar', id: 'mb-pick-bar' },
        h('strong', { text: `已选 ${state.selection.size} 篇` }),
        button(allSelected ? '全不选' : '全选', () => { if (allSelected) state.selection.clear(); else for (const row of rows) state.selection.add(row.id); renderList() }, false, { class: 'btn ghost', id: 'mb-pick-all' }),
        h('span', { class: 'spacer' }),
        state.view === 'trash' ? button('恢复所选', () => performBatch('restore'), false, { id: 'mb-batch-restore', disabled: !state.selection.size }) : null,
        state.view === 'trash' ? button('彻底删除', () => performBatch('purge'), false, { class: 'btn ghost danger', id: 'mb-batch-purge', disabled: !state.selection.size }) : button('移入回收站', () => performBatch('delete'), false, { class: 'btn ghost danger', id: 'mb-batch-delete', disabled: !state.selection.size })))
    }
    for (const row of rows) {
      const picked = state.selection.has(row.id)
      const cardClass = `mb-card${!state.picking && state.draft?.id === row.id ? ' selected' : ''}${picked ? ' picked' : ''}`
      const click = () => state.picking ? togglePick(row.id) : select(row.id)
      const props = { class: cardClass, 'data-question-id': row.id, 'aria-pressed': String(state.picking ? picked : state.draft?.id === row.id) }
      const check = state.picking ? h('span', { class: `mb-check${picked ? ' on' : ''}`, 'aria-hidden': 'true' }, picked ? '✓' : '') : null
      if (row.type === 'vocabulary') {
        const card = button([check,
          h('div', { class: 'mb-word-head' }, h('span', { class: 'mb-word-term', text: row.vocabulary.word || '未命名词条' }), row.vocabulary.phonetic ? h('span', { class: 'mb-word-phonetic', text: row.vocabulary.phonetic }) : null, row.reciteCount ? h('span', { class: 'mb-word-recite', text: `背${row.reciteCount}`, title: `词典查询背诵 ${row.reciteCount} 次` }) : null, h('span', { class: 'spacer' }), h('span', { class: `mb-state ${row.reviewState}`, text: labelStates[row.reviewState] })),
          h('p', { class: 'mb-word-sense', text: [row.vocabulary.partOfSpeech, row.vocabulary.meaning].filter(Boolean).join(' ') || '打开补充释义与例句' })], click, false, { ...props, class: `${cardClass} mb-word-card` })
        makeDraggable(card, row); list.append(card)
      } else {
        const score = row.value.overallScore
        const card = button([check,
          h('div', { class: 'mb-card-head' }, h('span', { class: `mb-type-label ${row.type}`, text: NOTE_TYPES[row.type]?.label || '错题' }), h('span', { class: 'spacer' }), h('span', { class: `mb-state ${row.reviewState}`, text: labelStates[row.reviewState] })),
          h('h2', { text: row.title || row.vocabulary?.word || row.stem.split('\n')[0].slice(0,90) || (row.imageCount ? '手写页' : '图片笔记') }),
          h('p', { class: 'mb-card-stem', text: (row.type==='note' ? (row.imageCount ? (row.stem ? `${row.imageCount} 页手写 · ${row.stem.replace(/\s+/g,' ').slice(0,60)}` : `${row.imageCount} 页手写`) : row.stem||row.physics?.object||row.method?.prerequisites||'打开笔记补充内容。') : row.type==='vocabulary'?row.vocabulary.meaning:row.stem||row.physics?.object||row.method?.prerequisites||'打开笔记补充内容。').replace(/\s+/g,' ').slice(0,180) }),
          h('div', { class: 'mb-card-tags' }, row.subjectID ? h('span',{text:dictionary.get(row.subjectID)}) : null, row.nodeID ? h('span', { text: dictionary.get(row.nodeID) }) : null, row.tags.slice(0, 3).map(tag => h('span', { class: 'mb-card-tag', text: `# ${tag}` })), row.imageCount ? h('span', { text: `${row.imageCount} 页手写` }) : null, row.errorType ? h('span', { text: row.errorType }) : null),
          h('div', { class: 'mb-card-foot' }, h('span', { class: `mb-score ${row.value.level}`, text: `复习优先 ${score}` }), h('span', { text: `更新于 ${date(row.updatedAt)}` })),
        ], click, false, props)
        makeDraggable(card, row); list.append(card)
      }
    }
  }
  async function select(id) {
    if (!await discard()) return
    state.draft = await call('read', { id }); state.dirty = false; state.review = state.view === 'due'; state.showAnswer = false
    renderList(); renderDetail()
  }
  async function openCreate() {
    if (!await discard()) return
    const node=dialog('新建笔记',h('div',{class:'mb-create-types'},Object.entries(NOTE_TYPES).map(([type,meta])=>button([icon(meta.icon),h('strong',{text:meta.label}),h('span',{class:'cap',text:meta.caption})],async()=>{node.close();await newQuestion(type)},false,{class:'mb-create-type','data-create-type':type}))))
  }
  async function newQuestion(type = state.type || 'note') {
    if (!await discard()) return
    state.draft = { type, title:'', physics:normalizeFields('physics'),method:normalizeFields('method'),vocabulary:normalizeFields('vocabulary'),simulationId:'',stem: '', studentWork: '', referenceAnswer: '', notes: '', cause: '', errorType: '', nodeID: '', subjectID: type==='physics'?'physics':type==='vocabulary'?'english':state.subjectID, target: 'gaokao', images: [], tags: [], reviewState: 'new', repeatCount: 0, mastery: 0 }
    state.dirty = false; state.review = false; renderList(); renderDetail(); setTimeout(()=>document.querySelector(`[data-mb-field="${type==='vocabulary'?'vocabulary.word':'title'}"]`)?.focus(),0)
  }
  async function save() {
    const draft = state.draft; if (!draft) return
    addHandwritingPage(draft)
    const scrollTop = detail.querySelector('.mb-editor-form')?.scrollTop || 0
    const activeField = document.activeElement?.dataset.mbField
    const saveButton = document.getElementById('mb-save'), hint = document.getElementById('mb-save-state')
    if (saveButton) { saveButton.textContent = '正在保存…'; saveButton.disabled = true }
    if (hint) hint.textContent = '正在保存…'
    try {
      state.draft = await call('save', { ...draft, images: draft.images.map(image => image.id ? { id: image.id } : image) }); state.dirty = false; await load()
      const editor = detail.querySelector('.mb-editor-form'); if (editor) editor.scrollTop = scrollTop
      if (activeField) detail.querySelector(`[data-mb-field="${activeField}"]`)?.focus({ preventScroll: true })
      notify('笔记已保存')
    } finally {
      if (saveButton?.isConnected) { saveButton.textContent = '保存笔记'; saveButton.disabled = !state.dirty && Boolean(draft.id) }
      if (hint?.isConnected) hint.textContent = state.dirty ? '有未保存的修改' : draft.id ? '已保存' : '尚未保存'
    }
  }
  async function perform(action) {
    if (!await discard()) return
    const id = state.draft.id
    if (action === 'purge' && !await confirm('永久删除这道题和原图？此操作无法恢复。')) return
    if (action === 'delete' && !await confirm('将这道题移入回收站？之后可以恢复。')) return
    const result = await call('action', { id, action })
    state.dirty = false
    state.draft = ['pass','fail'].includes(action) ? result : null
    if (state.draft) { state.review = true; state.showAnswer = false }
    await load(); notify(({ pass: '复习已记录，下次按计划再来', fail: '已记录薄弱点，明天再练一次', delete: '已移入回收站', restore: '题目已恢复', archive: '已归档', unarchive: '已取消归档', purge: '题目已永久删除' })[action])
  }
  function renderDetail() {
    const draft = state.draft; detail.hidden = !draft; detailSplitter.hidden = !draft; shell.classList.toggle('with-question', Boolean(draft))
    if (!draft) { detail.replaceChildren(); return }
    const control = (name, rows = 3) => {
      const path=name.split('.'), get=()=>path.reduce((value,key)=>value?.[key],draft)
      return h(rows===1?'input':'textarea', { class: rows===1?'input':'area', rows:rows===1?undefined:rows, value:get()||'', 'data-mb-field':name, onInput:event=>{const parent=path.length===1?draft:draft[path[0]];parent[path.at(-1)]=event.target.value;dirty()} })
    }
    const dictionary = names(), nodes = state.data.taxonomy.nodes
    const subject = h('select', { class: 'select', 'data-mb-field': 'subjectID', onChange: event => { draft.subjectID = event.target.value; draft.nodeID = ''; dirty(); renderDetail() } }, h('option', { value: '', text: '待分类' }), nodes.filter(node => !node.parentID).map(node => h('option', { value: node.id, text: node.name, selected: node.id === draft.subjectID ? 'selected' : undefined })))
    const nodeSelect = h('select', { class: 'select', 'data-mb-field': 'nodeID', onChange: event => { draft.nodeID = event.target.value; draft.classificationSuggested = false; dirty() } }, h('option', { value: '', text: '选择知识点' }), nodes.filter(node => node.parentID && node.subjectID === draft.subjectID).map(node => h('option', { value: node.id, text: `${node.id.split('/').length > 2 ? '　' : ''}${node.name}`, selected: node.id === draft.nodeID ? 'selected' : undefined })))
    const errors = ['未记录', '审题疏漏', '概念不清', '推理错误', '计算错误', '表达不完整', '知识遗忘', '其他']
    if (draft.errorType && !errors.includes(draft.errorType)) errors.push(draft.errorType)
    const errorType = h('select', { class: 'select', 'data-mb-field': 'errorType', onChange: event => { draft.errorType = event.target.value; dirty() } }, errors.map(label => h('option', { value: label === '未记录' ? '' : label, text: label, selected: (label === '未记录' ? '' : label) === draft.errorType ? 'selected' : undefined })))
    const target = h('select', { class: 'select', 'data-mb-field': 'target', onChange: event => { draft.target = event.target.value; dirty() } }, [['gaokao','高考'],['huige','合格考']].map(([value, text]) => h('option', { value, text, selected: value === draft.target ? 'selected' : undefined })))
    const close = button('', async () => { if (await discard()) { state.draft = null; state.dirty = false; renderList(); renderDetail() } }, false, { class: 'icon-button', 'aria-label': '关闭题目' }); close.append(icon('close'))
    const fullscreen = button('', () => { shell.classList.toggle('detail-full'); renderDetail() }, false, { class: 'icon-button', id: 'mb-fullscreen', title: '全屏编辑（Esc 退出）', 'aria-label': '全屏编辑', 'aria-pressed': String(shell.classList.contains('detail-full')) }); fullscreen.append(icon('grid'))
    const head = h('div', { class: 'mb-detail-head' }, h('div', {}, h('span', { class: 'eyebrow', text: state.review ? '复习' : NOTE_TYPES[draft.type].label }), h('h2', { text: draft.id ? state.review ? '独立回忆，再核对' : draft.title || draft.vocabulary?.word || '笔记详情' : `新建${NOTE_TYPES[draft.type].label}` })), fullscreen, close)
    const actions = h('div', { class: 'row mb-save-actions' }, h('span', { id: 'mb-save-state', class: state.dirty ? 'cap dirty' : 'cap', role: 'status', 'aria-live': 'polite', text: state.dirty ? '有未保存的修改' : draft.id ? '已保存' : '尚未保存' }), h('span', { class: 'spacer' }), button('保存笔记', save, true, { id: 'mb-save', disabled: !state.dirty && Boolean(draft.id), title: '保存笔记 · Ctrl / ⌘ S' }),button(draft.type==='physics'?'AI 构建与推导':draft.type==='vocabulary'?'AI 补全词条':'AI 自动解答', solveAI,false,{id:'mb-ai-solve'}))
    const form = h('form', { class: 'mb-editor-form', onSubmit: event => { event.preventDefault(); void guard(save) } })
    if (state.review) {
      form.append(h('h3',{class:'mb-review-title',text:draft.title||draft.vocabulary?.word||NOTE_TYPES[draft.type].label}),h('div', { class: 'mb-review-stem', text: draft.type==='vocabulary'?draft.vocabulary.word:draft.stem || draft.physics?.object || '请查看笔记原图' }))
      if (state.showAnswer) form.append(draft.type === 'vocabulary' ? dictionaryCard(draft.vocabulary) : h('div', { class: 'mb-answer' }, h('span', { class: 'label', text: '参考答案与讲解' }), h('p', { text: draft.referenceAnswer || draft.aiResult?.text || draft.notes || '尚未填写' }), h('span', { class: 'label', text: '过往作答与复盘' }), h('p', { text: [draft.studentWork,draft.cause].filter(Boolean).join('\n') }), (STRUCTURED_FIELDS[draft.type]??[]).filter(([key])=>draft[draft.type][key]).map(([key,label])=>h('div',{},h('span',{class:'label',text:label}),h('p',{text:draft[draft.type][key]})))))
      form.append(h('div', { class: 'row mb-review-actions' }, button(state.showAnswer ? '收起答案' : '展开答案核对', () => { state.showAnswer = !state.showAnswer; renderDetail() }, false, { id: 'mb-reveal' }), button('编辑题目', () => { state.review = false; renderDetail() }, false)))
      if (state.showAnswer) form.append(h('div', { class: 'row' }, button('还不会', () => perform('fail'), false, { id: 'mb-review-fail' }), button('做对了', () => perform('pass'), true, { id: 'mb-review-pass' })))
    } else {
      append(form,field('标题',control('title',1)), field(draft.type==='mistake'?'题干':draft.type==='physics'?'问题情境与建模目标':draft.type==='method'?'方法概述与问题背景':draft.type==='vocabulary'?'语境与补充（可选）':'笔记内容与问题', control('stem', draft.type==='vocabulary'?2:5)), h('div', { class: 'mb-fields-row' }, field('学科', subject), field('知识点', nodeSelect)),
        h('div', { class: 'mb-tags-panel' }, renderTagEditor({ tags: draft.tags ?? [], onChange: next => { draft.tags = next; dirty(); renderDetail() }, onInvalid: message => notify(message, true) })),
        draft.type === 'note' ? handwritingPanel(draft) : null,
        draft.classificationSuggested ? h('p', { class: 'cap', text: '知识点由关键词建议，请确认后保存。' }) : null,
        draft.legacyNodeID ? h('p', { class: 'cap', text: `旧知识点「${draft.legacyNodeID}」需重新选择，原标识已保留。` }) : null,
        draft.type==='mistake'?field('我的作答', control('studentWork')):null, draft.type==='mistake'?field('参考答案', control('referenceAnswer')):null, draft.type==='mistake'?h('div', { class: 'mb-fields-row' }, field('错因类型', errorType), field('考试目标', target)):null, draft.type==='mistake'?field('错因与复盘', control('cause')):null)
      if (draft.type === 'vocabulary') form.append(h('div', { class: 'mb-headword' },
        field('单词或短语', control('vocabulary.word', 1)), field('音标', control('vocabulary.phonetic', 1)), field('词性', control('vocabulary.partOfSpeech', 1)),
        field('中文释义', control('vocabulary.meaning', 2))))
      if (STRUCTURED_FIELDS[draft.type]) {
        const headwordKeys = draft.type === 'vocabulary' ? ['word', 'phonetic', 'partOfSpeech', 'meaning'] : []
        const fields = STRUCTURED_FIELDS[draft.type].filter(([key]) => !headwordKeys.includes(key))
        const renderField = ([key, label]) => field(label, control(`${draft.type}.${key}`, draft.type === 'vocabulary' && ['synonyms', 'antonyms'].includes(key) ? 1 : draft.type === 'vocabulary' && ['derivation', 'steps', 'examples'].includes(key) ? 5 : 3))
        const filled = [], empty = []
        for (const entry of fields) (String(draft[draft.type]?.[entry[0]] ?? '').trim() ? filled : empty).push(entry)
        if (!draft.id || !empty.length) form.append(h('div', { class: 'mb-structured-fields' }, [...filled, ...empty].map(renderField)))
        else {
          if (filled.length) form.append(h('div', { class: 'mb-structured-fields' }, filled.map(renderField)))
          form.append(h('details', { class: 'mb-structured-fields mb-structured-extra' }, h('summary', {}, `展开另外 ${empty.length} 个未填写字段`), empty.map(renderField)))
        }
      }
      if(draft.type==='physics') {
        const select=h('select',{class:'select',id:'mb-simulation-id',onChange:event=>{draft.simulationId=event.target.value;dirty()}},h('option',{value:'',text:'选择对应的物理仿真'}),SIMULATIONS.map(item=>h('option',{value:item.id,text:item.name,selected:draft.simulationId===item.id?'selected':undefined})))
        form.append(h('div',{class:'mb-simulation-panel'},field('交互仿真 · PhET',select),h('p',{class:'cap',text:'在独立窗口调整参数、观察模型，将结论记入笔记。需要联网。'}),button('打开物理仿真',async()=>{if(!draft.simulationId)throw new Error('请先选择物理仿真');notify('正在打开物理仿真…');await call('simulation.open',{id:draft.simulationId});notify('仿真已打开，可调整参数观察')},false,{id:'mb-simulation-open'})))
      }
      form.append(field('补充笔记',control('notes',2)))
    }
    form.append(imagePanel(draft))
    form.addEventListener('paste', event => {
      if (state.review || !event.clipboardData?.files.length || event.target.closest('.mb-images')) return
      event.preventDefault()
      form.querySelector('.mb-images').dispatchEvent(new ClipboardEvent('paste', { clipboardData: event.clipboardData, bubbles: false, cancelable: true }))
    })
    if (draft.id) {
      if(draft.aiResult) form.append(h('div',{class:'mb-ai-result',id:'mb-ai-result'},h('div',{class:'row'},h('strong',{text:'AI 学习草稿'}),h('span',{class:'spacer'}),h('span',{class:'cap',text:draft.aiStale?'资料已修改，建议重新生成':date(draft.aiResult.generatedAt)})),h('div',{class:'mb-ai-text'},renderRich(draft.aiResult.text)),h('p',{class:'cap',text:'解答与模型仍需核对。补充空白字段会保留已有的人工内容。'}),button('补充到空白字段',async()=>{if(state.dirty)throw new Error('请先保存修改');state.draft=await call('ai.accept',{id:draft.id});state.dirty=false;await load();notify('AI 草稿已补充，人工内容保留')},false,{id:'mb-ai-accept',disabled:draft.aiStale})))
      const value = draft.value
      form.append(h('div', { class: 'mb-priority' }, h('div', { class: 'row' }, h('strong', { text: `复习优先 ${value.overallScore}` }), h('span', { class: 'spacer' }), h('span', { text: labelStates[draft.reviewState] })),
        h('p', { class: 'cap', text: `再次出错 ${draft.repeatCount} 次${draft.reciteCount ? ` · 背诵 ${draft.reciteCount} 次` : ''} · 下次复习 ${date(draft.nextReviewAt)}` }), h('details', {}, h('summary', { text: '查看评分依据' }), h('p', { class: 'cap', text: value.reason }), h('p', { class: 'cap', text: '按到期紧迫、掌握薄弱、重复出错与久未复习加权；课标权重仅作微调。' }))))
      const tools = h('div', { class: 'row mb-detail-actions' })
      if (draft.isSoftDeleted) tools.append(button('恢复', () => perform('restore')), button('永久删除', () => perform('purge'), false, { class: 'btn danger' }))
      else {
        for (const tool of [button(state.review ? '退出复习' : '开始复习', async () => { if (await discard()) { state.draft = await call('read',{id:draft.id}); state.dirty=false; state.review=!state.review; state.showAnswer=false; renderDetail() } }, false, { id: 'mb-start-review' }),
          draft.type === 'vocabulary' ? button('关联树', () => { if (state.dirty) throw new Error('请先保存修改，再查看关联树'); void openRelationTree(draft) }, false, { id: 'mb-relations', title: '按近义词、反义词与词形变化展开这棵词库关系树' }) : null,
          button(draft.isArchived ? '取消归档' : '归档', () => perform(draft.isArchived ? 'unarchive' : 'archive')), button('移到回收站', () => perform('delete'), false, { class: 'btn ghost danger', id: 'mb-delete' })]) if (tool) tools.append(tool)
        if (!draft.isArchived && draft.type==='mistake') tools.append(button('辅助分析错因', async () => {
          if (state.dirty) throw new Error('请先保存题目再分析')
          const settings = await call('settings')
          if (settings.modelConfigured && !await confirm('将向已配置的 AI 服务发送题干、作答、参考答案与笔记，生成错因建议。继续？')) return
          notify('正在分析错因…'); state.draft = await call('analyze', { id: draft.id }); await load(); notify('错因建议已保存，请核对')
        }, false, { id: 'mb-analyze' }))
      }
      form.append(tools)
    }
    detail.replaceChildren(head, form, ...(!state.review ? [actions] : []))
  }
  async function solveAI() {
    if(!state.draft) return
    if(state.dirty||!state.draft.id) await save()
    const loading=createLoadingStatus({label:'AI 正在整理这篇笔记'})
    const node=dialog('Alaya · AI 学习助手',h('div',{class:'mb-ai-progress'},loading.element))
    const cancel=h('button',{type:'button',class:'btn ghost',text:'取消生成',id:'mb-ai-cancel',onClick:()=>void call('cancelAI')})
    node.querySelector('[aria-label="关闭对话框"]').replaceWith(cancel)
    node.addEventListener('cancel',event=>{event.preventDefault();void call('cancelAI')})
    try {state.draft=await call('solve',{id:state.draft.id});state.dirty=false;await load();notify('AI 学习草稿已生成，可核对并补充字段')}
    catch(error){throw new Error(/abort|cancel/i.test(error.message)?'AI 生成已取消，笔记内容保留':error.message)}
    finally{node.close()}
  }
  function wordPhotoPane() {
    const files = [], controller = { busy: () => running || extracting, cancel: () => void call(extracting ? 'cancelAI' : 'cancelOCR'), hasWork: () => files.some(item => item.status === 'done') }
    let rows = [], edits = new Map(), existing = new Set(), running = false, extracting = false
    const loading=createLoadingStatus({compact:true,hidden:true,label:'正在识别积累本'})
    const queue = h('div', { class: 'mb-capture-queue', id: 'mb-word-queue' })
    const progress = h('p', { class: 'cap', id: 'mb-word-progress', text: '一次可加入多页积累本照片（PNG / JPEG）或 PDF 扫描件，逐张自动识别后提取英语词条。' })
    const preview = h('div', { class: 'mb-word-preview', id: 'mb-word-preview', hidden: true })
    const summary = h('p', { class: 'cap', id: 'mb-word-summary', hidden: true })
    const stateText = item => ({ pending: '待识别', running: '识别中…', done: '已识别', failed: '失败' })[item.status] + (item.status === 'failed' && item.error ? `：${item.error}` : '')
    const renderQueue = () => queue.replaceChildren(...files.map(item => h('div', { class: `mb-capture-item ${item.status}`, 'data-capture-item': item.name },
      item.file.mimeType === 'application/pdf' ? h('span', { class: 'mb-capture-pdf' }, icon('book')) : h('img', { src: dataURL(item.file), alt: item.name }),
      h('span', { class: 'name', text: item.name }),
      h('span', { class: `mb-capture-state ${item.status}`, text: stateText(item), title: stateText(item) }),
      button('移除', () => { files.splice(files.indexOf(item), 1); renderQueue(); if (files.some(entry => entry.status === 'done')) void guard(rebuild) }, false, { class: 'btn ghost' }))))
    const addFiles = async picked => {
      const incoming = Array.from(picked ?? [])
      if (!incoming.length) return
      if (files.length + incoming.length > 12) throw new Error('一次最多加入 12 个文件，请分批识别')
      for (const file of incoming) files.push({ file: await filePayload(file, true), name: file.name, status: 'pending', error: '', text: '' })
      renderQueue()
    }
    const importButton = button('导入选中词条', async () => {
      const selected = rows.filter(row => row.selected && !row.duplicate && row.word.trim())
      if (!selected.length) throw new Error('请先识别并选择要导入的词条')
      const result = await call('import', { records: selected.map(row => ({ type: 'vocabulary', title: row.word.trim(), vocabulary: { word: row.word.trim(), phonetic: row.phonetic, meaning: row.meaning, examples: row.examples } })) })
      state.draft = null; state.dirty = false; state.type = 'vocabulary'; state.view = 'all'; state.subjectID = ''; state.nodeID = ''
      await load(); pane.closest('dialog')?.close(); notify(`积累 ${result.created} 个词条，跳过 ${result.skipped} 个重复词`)
    }, true, { id: 'mb-word-import-photo-save', disabled: true })
    const extractCancel = h('button', { type: 'button', class: 'btn ghost', text: '取消整理', hidden: true, id: 'mb-word-extract-cancel', onClick: () => void call('cancelAI') })
    const extractButton = button('AI 识别整理', async () => {
      const text = files.filter(item => item.status === 'done').map(item => item.text).join('\n')
      if (!text.trim()) throw new Error('请先完成拍照识别，再用 AI 整理')
      if (!await confirm('AI 识别整理会把整页识别原文交给已配置的模型重新提取，更适合表格、勾选或潦草的手写页；本地提取的行可以手动改。继续？')) return
      extracting = true; extractButton.disabled = true; extractCancel.hidden = false; notify('AI 正在从识别原文提取词条…')
      loading.show('AI 正在重新提取词条','保留原词形，完成后请核对释义。')
      try {
        const entries = await call('words.extract', { text })
        existing = await existingVocabularyWords()
        applyEntries(entries, false)
        notify(`AI 提取到 ${entries.length} 个词条，请核对后导入`)
      } catch (error) { throw new Error(/abort|cancel/i.test(error.message) ? 'AI 识别已取消，本地提取结果保留' : error.message) }
      finally { extracting = false; extractButton.disabled = false; extractCancel.hidden = true; loading.hide() }
    }, false, { id: 'mb-word-extract', hidden: true })
    void call('settings').then(config => { extractButton.hidden = !config.modelConfigured }).catch(() => {})
    const renderPreview = () => {
      const duplicates = rows.filter(row => row.duplicate).length
      preview.hidden = summary.hidden = !rows.length
      summary.textContent = rows.length ? `共 ${rows.length} 个词条${duplicates ? `，其中 ${duplicates} 个已存在（灰色不可选）` : ''}；可以修改或删除后再导入。` : ''
      importButton.disabled = !rows.some(row => row.selected && !row.duplicate && row.word.trim())
      preview.replaceChildren(h('div', { class: 'mb-word-row mb-word-head' },
        h('input', { type: 'checkbox', checked: rows.some(row => !row.duplicate) && rows.filter(row => !row.duplicate).every(row => row.selected), onChange: event => { for (const row of rows) if (!row.duplicate) row.selected = event.target.checked; renderPreview() } }),
        h('span', { text: '单词' }), h('span', { text: '音标' }), h('span', { text: '中文释义' }), h('span', { text: '例句' }), h('span')),
        ...rows.map(row => {
          const input = (key, placeholder) => h('input', { class: 'input', value: row[key] ?? '', placeholder, onInput: event => { row[key] = event.target.value; importButton.disabled = !rows.some(item => item.selected && !item.duplicate && item.word.trim()) } })
          return h('div', { class: `mb-word-row${row.duplicate ? ' duplicate' : ''}`, 'data-word-row': normalizeWord(row.word) },
            h('input', { type: 'checkbox', checked: row.selected && !row.duplicate, disabled: row.duplicate ? true : undefined, title: row.duplicate ? '词库中已存在，导入时会跳过' : '', onChange: event => { row.selected = event.target.checked; renderPreview() } }),
            input('word', '单词或短语'), input('phonetic', '音标'), input('meaning', '中文释义'), input('examples', '例句'),
            button('删除', () => { rows.splice(rows.indexOf(row), 1); renderPreview() }, false, { class: 'btn ghost danger', 'aria-label': `删除 ${row.word}` }))
        }))
    }
    const applyEntries = (entries, keepEdits = true) => {
      const previous = new Map(rows.map(row => [row.sourceWord || normalizeWord(row.word), row]))
      if (keepEdits) edits = new Map([...edits, ...previous])
      rows = entries.map(entry => {
        const sourceWord = normalizeWord(entry.word)
        const prior = keepEdits ? edits.get(sourceWord) : previous.get(sourceWord)
        const merged = prior ? keepEdits ? { ...entry, ...prior } : { ...entry, selected: prior.selected } : { ...entry, selected: true }
        return { ...merged, sourceWord, duplicate: existing.has(normalizeWord(merged.word)) }
      })
      renderPreview()
    }
    const rebuild = async () => {
      existing = await existingVocabularyWords()
      const text = files.filter(item => item.status === 'done').map(item => item.text).join('\n')
      applyEntries(text.trim() ? extractWords(text) : [])
    }
    const cancelButton = h('button', { type: 'button', class: 'btn ghost', text: '取消识别', hidden: true, id: 'mb-word-ocr-cancel', onClick: () => void call('cancelOCR') })
    const recognizeButton = button('识别单词', async () => {
      const pending = files.filter(item => item.status === 'pending' || item.status === 'failed')
      if (!pending.length) throw new Error('请先选择要识别的照片或 PDF')
      running = true; recognizeButton.disabled = true; cancelButton.hidden = false
      loading.show()
      let cancelled = false
      try {
        for (const item of pending) {
          if (cancelled) break
          item.status = 'running'; renderQueue()
          loading.setLabel(`正在识别 ${pending.indexOf(item)+1}/${pending.length} 页`)
          try { const result = await call('ocr', item.file); item.text = result.text; item.status = 'done'; item.error = '' }
          catch (error) { if (/abort|cancel/i.test(error.message)) { item.status = 'pending'; cancelled = true } else { item.status = 'failed'; item.error = error.message } }
          progress.textContent = cancelled ? '识别已取消，可继续识别剩余页面' : `正在识别 ${files.filter(entry => entry.status === 'done').length}/${files.length} 张…`
          renderQueue()
        }
        if (!cancelled) {
          await rebuild()
          const failed = files.filter(item => item.status === 'failed').length
          notify(failed ? `识别完成，${failed} 个文件失败，已从成功页面提取词条` : `识别完成，共提取 ${rows.length} 个词条，请核对`)
        }
      } finally { running = false; recognizeButton.disabled = false; cancelButton.hidden = true; loading.hide() }
    }, true, { id: 'mb-word-ocr-start' })
    const picker = h('input', { type: 'file', accept: 'image/png,image/jpeg,application/pdf', multiple: true, hidden: true, id: 'mb-word-file', onChange: event => { const picked = Array.from(event.target.files); event.target.value = ''; void guard(() => addFiles(picked)) } })
    const choose = button('选择照片 / PDF', () => picker.click(), false, { class: 'btn ghost' })
    const pane = h('div', { class: 'mb-capture', id: 'mb-word-photo-pane' }, picker, h('div', { class: 'row' }, choose, h('span', { class: 'spacer' }), recognizeButton, cancelButton), loading.element, queue, progress, summary, preview, h('div', { class: 'row mb-capture-actions' }, extractButton, extractCancel, h('span', { class: 'spacer' }), importButton))
    pane.addEventListener('dragover', event => event.preventDefault())
    pane.addEventListener('drop', event => { event.preventDefault(); void guard(() => addFiles(event.dataTransfer.files)) })
    pane.addEventListener('paste', event => { if (event.clipboardData?.files.length) { event.preventDefault(); void guard(() => addFiles(event.clipboardData.files)) } })
    pane.controller = controller
    return pane
  }
  async function openRelationTree(draft) {
    const rootKey = normalizeWord(draft.vocabulary.word)
    const expanded = new Set([rootKey])
    const node = dialog('词语关联树', h('div', { class: 'mb-tree-wrap', id: 'mb-relation-tree' }), true)
    const fetchRecords = async () => {
      const rows = []
      for (const view of ['all', 'archived', 'trash']) rows.push(...(await call('list', { view, type: 'vocabulary' })).records)
      return rows
    }
    let running = false
    const draw = async action => {
      if (running) return
      running = true
      try { await action() } catch (error) { notify(error.message || String(error), true) } finally { running = false }
    }
    const paint = records => node.querySelector('#mb-relation-tree').replaceChildren(renderRelationTree(vocabularyGraph(records, rootKey, expanded), {
      expanded,
      onToggle: key => void draw(async () => {
        if (key !== rootKey) expanded.has(key) ? expanded.delete(key) : expanded.add(key)
        paint(await fetchRecords())
      }),
      onOpen: id => void draw(async () => {
        node.close()
        Object.assign(state, { type: 'vocabulary', view: 'all', subjectID: '', nodeID: '', query: '' }); search.value = ''
        await load(); await select(id)
      }),
      onLookup: word => void draw(async () => {
        const outcome = await call('lookup', { word })
        expanded.add(normalizeWord(word))
        notify(outcome.created ? `已存入单词库：${word}，关联树已生长` : `「${word}」已在词库，背诵次数 +1`)
        paint(await fetchRecords())
      }),
    }))
    void draw(async () => paint(await fetchRecords()))
  }
  async function openLookup() {
    if (!await discard()) return
    const input = h('input', { class: 'input', id: 'mb-lookup-word', autocomplete: 'off', spellcheck: 'false', placeholder: '输入英语单词或短语，如 conserve、give up', 'aria-label': '要查询的单词或短语' })
    const resultArea = h('div', { class: 'mb-lookup-result', id: 'mb-lookup-result' })
    const cancel = h('button', { type: 'button', class: 'btn ghost', text: '取消查询', hidden: true, id: 'mb-lookup-cancel', onClick: () => void call('cancelAI') })
    const run = async () => {
      const word = input.value.trim()
      if (!word) throw new Error('请输入要查询的英语单词或短语')
      lookupButton.disabled = true; cancel.hidden = false; resultArea.replaceChildren()
      notify(`正在查询「${word}」…`)
      try {
        const outcome = await call('lookup', { word })
        await load()
        resultArea.replaceChildren(dictionaryCard(outcome.record.vocabulary),
          h('div', { class: 'row mb-lookup-actions' },
            h('span', { class: 'cap', id: 'mb-lookup-note', text: outcome.created ? '已自动存入英语词汇，第 1 次背诵。' : `词库已有该词，第 ${outcome.record.reciteCount} 次背诵已记录。` }),
            h('span', { class: 'spacer' }),
            button('打开词条', async () => { node.close(); Object.assign(state, { type: 'vocabulary', view: 'all', subjectID: '', nodeID: '', query: '' }); search.value = ''; await load(); await select(outcome.record.id) }, false, { id: 'mb-lookup-open' }),
            button('再查一个', () => { input.value = ''; resultArea.replaceChildren(); input.focus() }, false, { class: 'btn ghost', id: 'mb-lookup-again' })))
        notify(outcome.created ? `已存入单词库：${word}` : `「${word}」已在词库，背诵次数 +1`)
      } finally { lookupButton.disabled = false; cancel.hidden = true }
    }
    const lookupButton = button('查询', run, true, { id: 'mb-lookup-start' })
    const node = dialog('查词典', h('div', { class: 'mb-lookup', id: 'mb-lookup-pane' },
      h('form', { class: 'row mb-lookup-form', onSubmit: event => { event.preventDefault(); void guard(run) } }, input, lookupButton, cancel),
      h('p', { class: 'cap', text: '查询会调用已配置的模型生成词典词条，并自动存入英语词汇；重复查询不新建词条，只累计背诵次数。' }),
      resultArea))
    node.addEventListener('cancel', () => void call('cancelAI'))
    input.focus()
  }
  async function openQuiz() {
    const loading=createLoadingStatus({compact:true,hidden:true,label:'AI 正在生成检测题'})
    if(!await discard())return
    state.draft=null;state.dirty=false;await load()
    const mode=h('select',{class:'select',id:'mb-quiz-mode'},h('option',{value:'spelling',text:'看中文，写英语 · 本地检测'}),h('option',{value:'cloze',text:'AI 例句填空 · 需要模型'})),count=h('input',{class:'input',type:'number',min:1,max:20,value:10,id:'mb-quiz-count'}),body=h('div',{class:'mb-quiz-body'})
    const node=dialog('英语词汇检测',body,true)
    const cancel=h('button',{type:'button',class:'btn ghost',text:'取消生成',id:'mb-quiz-cancel',hidden:true,onClick:()=>void call('cancelAI')})
    body.append(h('div',{class:'mb-quiz-intro'},h('p',{class:'cap',text:'从已积累、未归档且有释义的词条中随机抽取。拼写检测不需要联网；AI 例句可以检验词义与语境。'}),h('div',{class:'mb-fields-row'},field('检测方式',mode),field('词条数量',count)),h('div',{class:'row'},button('开始检测',async()=>{
      const startMode=mode.value;cancel.hidden=startMode!=='cloze'
      if(startMode==='cloze')loading.show()
      let quiz
      try{quiz=await call('quiz.start',{mode:startMode,count:Number(count.value)})}finally{cancel.hidden=true;loading.hide()}
      const answers=new Map(),questions=quiz.questions.map((question,index)=>h('label',{class:'mb-quiz-question'},h('strong',{text:`${index+1}. ${question.prompt}`}),h('span',{class:'cap',text:question.hint}),h('input',{class:'input',autocomplete:'off',spellcheck:'false','data-quiz-id':question.id,onInput:event=>answers.set(question.id,event.target.value)})))
      body.replaceChildren(h('p',{class:'cap',text:`共 ${quiz.questions.length} 个词条，请填写原词形。提交后显示答案，并记录复习。`}),...questions,button('提交检测',async()=>{
        const result=await call('quiz.submit',{id:quiz.id,answers:[...answers].map(([id,answer])=>({id,answer}))});await load()
        body.replaceChildren(h('div',{class:'mb-quiz-score',id:'mb-quiz-score'},h('strong',{text:`${result.score}%`}),h('span',{text:`答对 ${result.results.filter(row=>row.correct).length} / ${result.results.length}`})),h('div',{class:'mb-quiz-results'},result.results.map(row=>h('div',{class:`mb-quiz-result${row.correct?' correct':' incorrect'}`},h('strong',{text:row.expected}),h('span',{text:row.correct?'正确':`你的答案：${row.answer||'未填写'}`}),h('span',{class:'cap',text:row.recorded?'已记入复习记录':'词条已修改，本次只显示成绩'})))),button('再检测一组',async()=>{node.close();await openQuiz()},true,{id:'mb-quiz-again'}))
      },true,{id:'mb-quiz-submit'}));node.querySelector('input')?.focus()
    },true,{id:'mb-quiz-start'}),cancel)),loading.element)
    node.addEventListener('cancel',()=>void call('cancelAI'))
  }
  function dictionaryCard(vocab) {
    const section = (label, text) => text?.trim() ? h('div', { class: 'mb-dict-row' }, h('span', { class: 'mb-dict-label', text: label }), h('div', { class: 'mb-dict-body', text })) : null
    return h('div', { class: 'mb-dict', id: 'mb-dict' },
      h('div', { class: 'mb-dict-head' },
        h('span', { class: 'mb-dict-term', text: vocab.word || '未命名词条' }),
        vocab.phonetic ? h('span', { class: 'mb-dict-phonetic', text: vocab.phonetic }) : null,
        vocab.partOfSpeech ? h('span', { class: 'mb-dict-pos', text: vocab.partOfSpeech }) : null),
      h('p', { class: 'mb-dict-sense', text: vocab.meaning || '尚未填写释义' }),
      vocab.examples?.trim() ? h('div', { class: 'mb-dict-examples' }, vocab.examples.split(/\n+/).filter(Boolean).map((line, index) => h('p', { text: `${index + 1}. ${line}` }))) : null,
      section('近义词', vocab.synonyms), section('反义词', vocab.antonyms), section('常用搭配', vocab.collocations), section('词形变化', vocab.forms), section('用法与辨析', vocab.usage))
  }
  function addHandwritingPage(draft) {
    const page = handwritingDrafts.get(draft)
    if (!page?.strokes.length) return false
    const data = page.canvas.toDataURL('image/png').split(',')[1]
    if (draft.images.length + 1 > 16) throw new Error('每篇笔记最多 16 张图片')
    if (draft.images.reduce((sum, image) => sum + (image.size || 0), 0) + data.length * 3 / 4 > 20 * 1024 * 1024) throw new Error('图片总量不能超过 20 MB')
    const stamp = new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    draft.images.push({ name: `手写 ${stamp}.png`, mimeType: 'image/png', data, size: Math.floor(data.length * 3 / 4) })
    page.strokes.length = 0
    dirty()
    return true
  }
  function handwritingPanel(draft) {
    const W = 1400, H = 900
    const panel = h('div', { class: 'mb-handwrite', id: 'mb-handwrite' })
    const canvas = h('canvas', { class: 'mb-handwrite-canvas', id: 'mb-handwrite-canvas', width: W, height: H, 'aria-label': '手写区域，按住拖动书写' })
    const ctx = canvas.getContext('2d')
    const paintBackground = () => { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H) }
    paintBackground(); ctx.lineCap = 'round'; ctx.lineJoin = 'round'
    let page = handwritingDrafts.get(draft)
    if (!page) { page = { strokes: [], tool: { color: '#2b3138', width: 4, eraser: false } }; handwritingDrafts.set(draft, page) }
    page.canvas = canvas
    const strokes = page.strokes, tool = page.tool
    let drawing = null, pointerID = null
    const drawStroke = stroke => {
      if (!stroke.points.length) return
      ctx.globalCompositeOperation = 'source-over'
      ctx.strokeStyle = stroke.eraser ? '#ffffff' : stroke.color; ctx.lineWidth = stroke.eraser ? stroke.width * 4 : stroke.width
      ctx.beginPath()
      ctx.moveTo(stroke.points[0].x, stroke.points[0].y)
      for (const point of stroke.points.slice(1)) ctx.lineTo(point.x, point.y)
      if (stroke.points.length === 1) ctx.lineTo(stroke.points[0].x + .1, stroke.points[0].y)
      ctx.stroke()
      ctx.globalCompositeOperation = 'source-over'
    }
    const redraw = () => { paintBackground(); for (const stroke of strokes) drawStroke(stroke); if (drawing) drawStroke(drawing) }
    const point = event => { const rect = canvas.getBoundingClientRect(); return { x: (event.clientX - rect.left) * W / rect.width, y: (event.clientY - rect.top) * H / rect.height } }
    canvas.addEventListener('pointerdown', event => { if (drawing || event.button > 0) return; event.preventDefault(); pointerID = event.pointerId; try { canvas.setPointerCapture(event.pointerId) } catch { /* synthetic events in tests carry no active pointer */ } drawing = { color: tool.color, width: tool.width, eraser: tool.eraser, points: [point(event)] }; drawStroke(drawing) })
    canvas.addEventListener('pointermove', event => { if (!drawing || event.pointerId !== pointerID) return; event.preventDefault(); drawing.points.push(point(event)); redraw() })
    const finish = event => { if (!drawing || event.pointerId !== pointerID) return; strokes.push(drawing); drawing = null; pointerID = null; redraw(); dirty(); updatePageControls() }
    canvas.addEventListener('pointerup', finish)
    canvas.addEventListener('pointercancel', finish)
    const markTool = (nodes, active) => { for (const node of nodes) { const on = node === active; node.classList.toggle('on', on); node.setAttribute('aria-pressed', String(on)) } }
    const colors = ['#2b3138', '#1f5fa8', '#b23b32']
    const refreshColors = () => { colorButtons.forEach((node, index) => { const on = !tool.eraser && colors[index] === tool.color; node.classList.toggle('on', on); node.setAttribute('aria-pressed', String(on)) }) }
    const colorButtons = colors.map(color => h('button', { type: 'button', class: `mb-hw-color${!tool.eraser && tool.color === color ? ' on' : ''}`, style: `background:${color}`, title: `笔色 ${color}`, 'aria-label': `笔色 ${color}`, 'aria-pressed': String(!tool.eraser && tool.color === color), onClick: event => { tool.eraser = false; tool.color = color; markTool(colorButtons, event.currentTarget); eraserButton.classList.remove('on'); eraserButton.setAttribute('aria-pressed', 'false') } }))
    const widthButtons = [2.5, 4, 8].map(width => button(String(width), event => { tool.width = width; tool.eraser = false; markTool(widthButtons, event.currentTarget); eraserButton.classList.remove('on'); eraserButton.setAttribute('aria-pressed', 'false'); refreshColors() }, false, { class: `btn ghost mb-hw-width${tool.width === width ? ' on' : ''}`, 'data-hw-width': String(width), 'aria-pressed': String(tool.width === width) }))
    const eraserButton = button('橡皮', () => { tool.eraser = !tool.eraser; eraserButton.classList.toggle('on', tool.eraser); eraserButton.setAttribute('aria-pressed', String(tool.eraser)); refreshColors() }, false, { class: `btn ghost${tool.eraser ? ' on' : ''}`, id: 'mb-hw-eraser', 'aria-pressed': String(tool.eraser) })
    const savePage = button('加入当前页', () => {
      if (!addHandwritingPage(draft)) return
      redraw(); renderDetail(); notify(`已加入手写页，共 ${draft.images.length} 页；保存笔记后入库`)
    }, true, { id: 'mb-hw-save' })
    const undo = button('撤销', () => { strokes.pop(); redraw(); dirty(); updatePageControls() }, false, { class: 'btn ghost', id: 'mb-hw-undo' })
    const clear = button('清空', async () => { if (!strokes.length || !await confirm('清空当前手写页？已经加入的图片会保留。')) return; strokes.length = 0; redraw(); dirty(); updatePageControls() }, false, { class: 'btn ghost', id: 'mb-hw-clear' })
    const updatePageControls = () => { undo.disabled = clear.disabled = savePage.disabled = !strokes.length }
    append(panel, h('div', { class: 'mb-handwrite-tools' },
      ...colorButtons, ...widthButtons, eraserButton,
      undo, clear,
      h('span', { class: 'spacer' }), savePage),
      canvas,
      h('p', { class: 'cap', text: '保存笔记会一并保存当前手写页。需要多页时，点击「加入当前页」继续书写。' }))
    redraw(); updatePageControls()
    return panel
  }
  function imagePanel(draft) {
    const panel = h('div', { class: 'mb-images', id: 'mb-images' })
    const importFiles = async files => {
      const incoming = Array.from(files)
      if (draft.images.length + incoming.length > 16) throw new Error('每道题最多 16 张原图')
      const newImages = await Promise.all(incoming.map(file => filePayload(file)))
      if (state.draft !== draft) return
      if ([...draft.images, ...newImages].reduce((sum, image) => sum + image.size, 0) > 20 * 1024 * 1024) throw new Error('每道题的原图总计不能超过 20 MB')
      draft.images.push(...newImages); dirty(); renderDetail()
    }
    const picker = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', multiple: true, hidden: true, id: 'mb-image-picker', onChange: event => { const files = Array.from(event.target.files); event.target.value = ''; void guard(() => importFiles(files)) } })
    append(panel, h('div', { class: 'row' }, h('span', { class: 'label', text: `题目原图 · ${draft.images.length}` }), h('span', { class: 'spacer' }), !state.review ? button('添加图片', () => picker.click(), false, { class: 'btn ghost' }) : null), picker,
      h('div', { class: 'mb-image-grid' }, draft.images.map((image, index) => h('div', { class: 'mb-image-item' }, button(h('img', { src: dataURL(image), alt: image.name }), () => previewImage(image), false, { class: 'mb-image-thumb', 'aria-label': `预览 ${image.name}` }), h('div', { class: 'mb-image-caption' }, h('span', { text: image.name }), !state.review ? button('移除', () => { draft.images.splice(index,1); dirty(); renderDetail() }, false, { class: 'btn ghost' }) : null)))),
      !state.review ? h('p', { class: 'cap', text: '可粘贴截图或拖入图片；原图随题目保存。' }) : null)
    panel.addEventListener('dragover', event => { event.preventDefault() })
    panel.addEventListener('drop', event => { if (state.review) return; event.preventDefault(); void guard(() => importFiles(event.dataTransfer.files)) })
    panel.addEventListener('paste', event => { if (state.review || !event.clipboardData.files.length) return; event.preventDefault(); void guard(() => importFiles(event.clipboardData.files)) })
    return panel
  }
  function dialog(title, content, wide = false) {
    const node = h('dialog', { class: `mb-dialog${wide ? ' wide' : ''}` })
    const close = button('关闭', () => { node.close(); node.remove() }, false, { class: 'btn ghost', 'aria-label': '关闭对话框' })
    node.append(h('div', { class: 'mb-dialog-head' }, h('h2', { text: title }), h('span', { class: 'spacer' }), close), content, h('div', { class: 'mb-dialog-status cap', role: 'status' }))
    node.addEventListener('close', () => node.remove()); document.body.append(node); node.showModal(); return node
  }
  function previewImage(image) {
    dialog(image.name, h('div', { class: 'mb-image-preview' }, h('img', { src: dataURL(image), alt: image.name })), true)
  }
  async function openSettings() {
    const config = await call('settings'), info = (await window.vault.info()).result
    const endpoint = h('input', { class: 'input', value: config.endpoint, id: 'mb-ocr-url' }), key = h('input', { type: 'password', class: 'input', autocomplete: 'new-password', placeholder: config.hasKey ? '已安全保存；留空保留' : '填写 GLM-OCR API Key', id: 'mb-ocr-key' }), clear = h('input', { type: 'checkbox' })
    const modelURL = h('input', { class: 'input', value: info.model?.baseUrl || '', placeholder: 'https://api.example.com/v1', id: 'mb-model-url' }), model = h('input', { class: 'input', value: info.model?.model || '', placeholder: '模型名称', id: 'mb-model-name' }), modelKey = h('input', { type: 'password', class: 'input', autocomplete: 'new-password', placeholder: info.hasKey ? '已安全保存；留空保留' : '模型 API Key' }), clearModel = h('input', { type: 'checkbox' })
    const node = dialog('笔记本设置', h('div', { class: 'mb-settings-form' },
      h('h3', { text: '图片与 PDF 识别' }), h('p', { class: 'cap', text: '使用 GLM-OCR 版面解析接口。点击识别才会发送所选文件；识别结果可校对后导入。' }), field('OCR 接口地址', endpoint), field('OCR 密钥', key), h('label', { class: 'row cap' }, clear, '清除已保存的 OCR 密钥'),
      h('h3', { text: 'AI 解答、模型推导与英语检测' }), h('p', { class: 'cap', text: '支持兼容 OpenAI 的服务。仅在点击 AI 功能后发送所选笔记；有图片时需要支持图片输入的模型。模型配置与本程序的记忆模式共用。' }), field('模型服务地址', modelURL), field('模型名称', model), field('模型密钥', modelKey), h('label', { class: 'row cap' }, clearModel, '清除已保存的模型密钥'),
      button('保存设置', async () => {
        const reply = await window.vault.settings({ baseUrl: modelURL.value, model: model.value, apiKey: modelKey.value, clearKey: clearModel.checked }); if (!reply.ok) throw new Error(reply.error)
        await call('configure', { endpoint: endpoint.value, apiKey: key.value, clearKey: clear.checked }); key.value = ''; modelKey.value = ''; node.close(); notify('设置已安全保存')
      }, true, { id: 'mb-config-save' }), h('h3', { text: '本地数据' }), h('p', { class: 'mb-data-path', text: config.path }), button('备份笔记本', async () => { if (await call('backup')) notify('笔记本已备份，包含原图') }), h('p', { class: 'cap', text: '笔记本使用独立数据库，不进入 Codex / DSH 的记忆上下文。' }),
      h('h3', { text: '界面布局' }), h('p', { class: 'cap', text: '侧边栏与详情面板之间有可拖动的分隔条：按住拖动自由调整宽度，双击恢复默认。' }),
      field('详情面板位置', h('select', { class: 'select', id: 'mb-detail-side', onChange: event => void guard(() => { const prefs = layoutPrefs(); prefs.detailSide = event.target.value; saveLayout(prefs); notify('布局已更新') }) }, [['right', '右侧（默认）'], ['left', '左侧']].map(([value, text]) => h('option', { value, text, selected: layoutPrefs().detailSide === value ? 'selected' : undefined })))),
      button('恢复默认布局', () => { savePrefs({ ...prefsCache, ...LAYOUT_DEFAULTS }); notify('布局已恢复默认') }, false, { class: 'btn ghost', id: 'mb-layout-reset' })))
  }
  async function openImport(initial = 'mistake') {
    if (!await discard()) return
    const draft = { file: null, questions: [], running: false, modified: false }
    const notes = { files: [], running: false, imported: false, type: 'note' }
    const loading=createLoadingStatus({compact:true,hidden:true,label:'正在识别文字'})
    const text = h('textarea', { class: 'area mb-ocr-text', id: 'mb-import-text', placeholder: '粘贴题目或笔记文字，或选择图片 / PDF 后识别。\n\n1. 第一题\n2. 第二题', onInput: () => { draft.modified = true; draft.questions = []; results.replaceChildren() } })
    const results = h('div', { class: 'mb-segment-results', id: 'mb-segments' }), preview = h('div', { class: 'mb-source-preview', id: 'mb-ocr-preview' }, icon('book'), h('p', { text: '保留原题，校对文字' }))
    const filename = h('p', { class: 'cap', text: 'PNG / JPEG ≤ 10 MB，PDF ≤ 50 MB' }), keep = h('input', { type: 'checkbox', checked: true, id: 'mb-keep-source' })
    const subject = h('select', { class: 'select', id: 'mb-import-subject' }, h('option', { value: '', text: '自动建议学科与知识点' }), state.data.taxonomy.nodes.filter(node => !node.parentID).map(node => h('option', { value: node.id, text: node.name, selected: node.id === state.subjectID ? 'selected' : undefined })))
    const receive = async file => {
      if (!file) return
      if (draft.running) throw new Error('请先取消当前识别')
      draft.file = await filePayload(file, true); filename.textContent = file.name; draft.modified = true
      preview.replaceChildren(file.type === 'application/pdf' ? h('div', { class: 'mb-pdf-source' }, icon('book'), h('strong', { text: file.name }), h('p', { text: 'PDF 将识别为文字，导入前请核对题号与公式。' })) : h('img', { src: dataURL(draft.file), alt: file.name }))
    }
    const picker = h('input', { type: 'file', accept: 'image/png,image/jpeg,application/pdf', id: 'mb-ocr-file', hidden: true, onChange: event => { const file = event.target.files[0]; event.target.value = ''; void guard(() => receive(file)) } })
    const cancel = h('button', { type: 'button', class: 'btn ghost', text: '取消识别', hidden: true, id: 'mb-ocr-cancel', onClick: () => void call('cancelOCR') })
    const recognizeButton = button('识别文字', async () => {
      if (!draft.file) throw new Error('请先选择图片或 PDF')
      if (text.value.trim() && !await confirm('识别结果将替换当前文字，继续？')) return
      draft.running = true; text.disabled = true; recognizeButton.disabled = true; cancel.hidden = false; notify('正在识别文字…')
      loading.show()
      try {
        const result = await call('ocr', draft.file)
        if (!node.isConnected) return
        text.value = result.text; draft.modified = true; draft.questions = []; results.replaceChildren(); notify('识别完成，请校对题干与公式再拆题')
      } catch (error) { if (node.isConnected) throw new Error(/abort|cancel/i.test(error.message) ? '识别已取消，可以重试' : error.message) }
      finally { draft.running = false; text.disabled = false; recognizeButton.disabled = false; cancel.hidden = true; loading.hide() }
    }, true, { id: 'mb-ocr-start' })
    const split = button('预览拆题', async () => {
      const reply = await call('segment', { text: text.value }); draft.questions = reply.questions.map(stem => ({ stem, selected: true })); results.replaceChildren()
      draft.questions.forEach((question, index) => results.append(h('label', { class: 'mb-segment' }, h('div', { class: 'row' }, h('input', { type: 'checkbox', checked: true, onChange: event => { question.selected = event.target.checked } }), h('strong', { text: `第 ${index+1} 题` })), h('textarea', { class: 'area', rows: 3, value: question.stem, onInput: event => { question.stem = event.target.value } }))))
      notify(`已拆出 ${draft.questions.length} 道题，请核对后导入`)
    }, false, { id: 'mb-split' })
    const importButton = button('导入选中题目', async () => {
      const selected = draft.questions.filter(question => question.selected)
      if (!selected.length) throw new Error('请先预览拆题，并选择需要导入的题目')
      if (selected.some(question => !question.stem.trim())) throw new Error('选中的题干不能为空')
      const images = keep.checked && draft.file?.mimeType.startsWith('image/') ? [draft.file] : []
      const reply = await call('import', { records: selected.map(question => ({ stem: question.stem, ...(subject.value ? { subjectID: subject.value, nodeID: '' } : {}), images })) })
      draft.modified = false; state.draft = null; state.dirty = false; state.view = 'all'; state.subjectID = ''; state.nodeID = ''; state.query = ''; search.value = ''; await load(); node.close(); notify(`已导入 ${reply.created} 道题，跳过 ${reply.skipped} 道重复题`)
    }, true, { id: 'mb-import-confirm' })
    const mistakeSource = h('div', { class: 'mb-import-tools' }, picker, preview, button('选择图片 / PDF', () => picker.click()), filename, h('div', { class: 'row' }, recognizeButton, cancel), h('label', { class: 'row cap' }, keep, '随每道题保存整张原图（PDF 仅导入文字）'), field('导入学科', subject))
    const mistakeContent = h('div', { class: 'mb-import-content-inner' }, h('span', { class: 'label', text: '题目文字 · 可以手动校对' }), text, h('div', { class: 'row' }, split, h('span', { class: 'spacer' }), importButton), results)
    const noteStateText = item => ({ pending: '待识别', running: '识别中…', done: '已识别', failed: '失败' })[item.status] + (item.status === 'failed' && item.error ? `：${item.error}` : '')
    const noteQueue = h('div', { class: 'mb-capture-queue', id: 'mb-note-queue' })
    const noteProgress = h('p', { class: 'cap', id: 'mb-note-progress', text: '每一张图片识别为一篇独立笔记并保留原图；PDF 只导入识别文字。' })
    const noteSubject = h('select', { class: 'select', id: 'mb-note-subject' }, h('option', { value: '', text: '自动建议学科与知识点' }), state.data.taxonomy.nodes.filter(node => !node.parentID).map(node => h('option', { value: node.id, text: node.name, selected: node.id === state.subjectID ? 'selected' : undefined })))
    const renderNoteQueue = () => noteQueue.replaceChildren(...notes.files.map(item => h('div', { class: `mb-capture-item ${item.status}`, 'data-capture-item': item.name },
      item.file.mimeType === 'application/pdf' ? h('span', { class: 'mb-capture-pdf' }, icon('book')) : h('img', { src: dataURL(item.file), alt: item.name }),
      h('span', { class: 'name', text: item.name }),
      h('span', { class: `mb-capture-state ${item.status}`, text: noteStateText(item), title: noteStateText(item) }),
      button('移除', () => { notes.files.splice(notes.files.indexOf(item), 1); renderNoteQueue(); renderNotePreview() }, false, { class: 'btn ghost' }))))
    const notePreview = h('div', { class: 'mb-note-preview', id: 'mb-note-preview' })
    const noteImport = button('导入选中笔记', async () => {
      const selected = notes.files.filter(item => item.selected && item.status === 'done')
      if (!selected.length) throw new Error('请先识别并选择要导入的页面')
      const records = selected.map(item => ({ type: notes.type, title: item.title.trim(), stem: item.text, ...(noteSubject.value ? { subjectID: noteSubject.value, nodeID: '' } : {}), images: item.file.mimeType.startsWith('image/') ? [item.file] : [] }))
      if (records.some(record => !record.title.trim() && !record.stem.trim())) throw new Error('选中的笔记不能标题与内容都为空')
      const reply = await call('import', { records })
      notes.imported = true; state.draft = null; state.dirty = false; state.view = 'all'; state.type = notes.type; state.subjectID = ''; state.nodeID = ''; state.query = ''; search.value = ''; await load(); node.close(); notify(`已导入 ${reply.created} 篇${NOTE_TYPES[notes.type].label}，跳过 ${reply.skipped} 篇重复`)
    }, true, { id: 'mb-note-import-confirm', disabled: true })
    const renderNotePreview = () => {
      const done = notes.files.filter(item => item.status === 'done')
      noteImport.disabled = !done.some(item => item.selected)
      notePreview.replaceChildren(...done.map(item => h('div', { class: 'mb-note-item', 'data-note-item': item.name },
        h('div', { class: 'row mb-note-item-head' }, h('input', { type: 'checkbox', checked: item.selected, onChange: event => { item.selected = event.target.checked; noteImport.disabled = !notes.files.filter(entry => entry.status === 'done').some(entry => entry.selected) } }),
          h('input', { class: 'input', value: item.title ?? '', placeholder: '标题（默认取识别首行，可修改）', onInput: event => { item.title = event.target.value } }),          h('span', { class: 'cap', text: item.file.mimeType === 'application/pdf' ? 'PDF · 仅文字' : '含原图' })),
        h('textarea', { class: 'area', rows: 5, value: item.text, onInput: event => { item.text = event.target.value } }))))
    }
    const noteCancel = h('button', { type: 'button', class: 'btn ghost', text: '取消识别', hidden: true, id: 'mb-note-ocr-cancel', onClick: () => void call('cancelOCR') })
    const noteRecognize = button('识别全部', async () => {
      const pending = notes.files.filter(item => item.status === 'pending' || item.status === 'failed')
      if (!pending.length) throw new Error('请先选择要识别的照片或 PDF')
      notes.running = true; noteRecognize.disabled = true; noteCancel.hidden = false
      loading.show()
      let cancelled = false
      try {
        for (const item of pending) {
          if (cancelled) break
          item.status = 'running'; renderNoteQueue()
          loading.setLabel(`正在识别 ${pending.indexOf(item)+1}/${pending.length} 页`)
          try { const result = await call('ocr', item.file); item.text = result.text; item.title ??= firstMeaningfulLine(result.text); item.status = 'done'; item.error = '' }
          catch (error) { if (/abort|cancel/i.test(error.message)) { item.status = 'pending'; cancelled = true } else { item.status = 'failed'; item.error = error.message } }
          noteProgress.textContent = cancelled ? '识别已取消，可继续识别剩余页面' : `正在识别 ${notes.files.filter(entry => entry.status === 'done').length}/${notes.files.length} 张…`
          renderNoteQueue(); renderNotePreview()
        }
        if (!cancelled) {
          renderNotePreview()
          const failed = notes.files.filter(item => item.status === 'failed').length
          notify(failed ? `识别完成，${failed} 个文件失败，其余页面已生成笔记草稿` : `识别完成，共 ${notes.files.filter(item => item.status === 'done').length} 篇草稿，请核对后导入`)
        }
      } finally { notes.running = false; noteRecognize.disabled = false; noteCancel.hidden = true; loading.hide() }
    }, true, { id: 'mb-note-ocr-start' })
    const notePicker = h('input', { type: 'file', accept: 'image/png,image/jpeg,application/pdf', multiple: true, hidden: true, id: 'mb-note-file', onChange: event => { const picked = Array.from(event.target.files); event.target.value = ''; void guard(() => addNoteFiles(picked)) } })
    const addNoteFiles = async picked => {
      const incoming = Array.from(picked ?? [])
      if (!incoming.length) return
      if (notes.files.length + incoming.length > 12) throw new Error('一次最多加入 12 个文件，请分批识别')
      for (const file of incoming) notes.files.push({ file: await filePayload(file, true), name: file.name, status: 'pending', error: '', text: '', title: null, selected: true })
      renderNoteQueue()
    }
    const noteSource = h('div', { class: 'mb-import-tools' }, notePicker, button('选择照片 / PDF', () => notePicker.click()), noteQueue, h('div', { class: 'row' }, noteRecognize, noteCancel), noteProgress, field('导入学科', noteSubject))
    const noteContent = h('div', { class: 'mb-import-content-inner' }, h('span', { class: 'label', text: '识别结果 · 每张一篇，可校对后导入' }), notePreview, h('div', { class: 'row' }, h('span', { class: 'spacer' }), noteImport))
    noteSource.addEventListener('dragover', event => event.preventDefault())
    noteSource.addEventListener('drop', event => { event.preventDefault(); if (!notes.running) void guard(() => addNoteFiles(event.dataTransfer.files)) })
    const noteTypeSeg = h('div', { class: 'mb-seg', role: 'group', 'aria-label': '保存为笔记类型' }, ['note', 'physics', 'method'].map(key => button(NOTE_TYPES[key].label, () => {
      notes.type = key
      for (const item of noteTypeSeg.querySelectorAll('.mb-seg-item')) { item.classList.toggle('on', item.dataset.noteType === key); item.setAttribute('aria-pressed', String(item.dataset.noteType === key)) }
      noteProgress.textContent = `每一张图片识别为一篇${NOTE_TYPES[notes.type].label}并保留原图；PDF 只导入识别文字。`
    }, false, { class: `mb-seg-item${notes.type === key ? ' on' : ''}`, 'data-note-type': key, 'aria-pressed': String(notes.type === key) })))
    noteSource.prepend(field('保存为类型', noteTypeSeg))
    const photoPane = wordPhotoPane()
    const manualText = h('textarea', { class: 'area', id: 'mb-word-import-text', rows: 6, placeholder: '一行一个词条：单词 | 中文释义 | 例句\n\nabandon | 放弃 | Never abandon hope.\nconserve | 保存；保护 | We should conserve energy.' })
    const manualPane = h('div', { class: 'mb-capture' }, h('p', { class: 'cap', text: '与拍照识别使用同一解析：支持「单词 中文释义」「1. 单词 释义」「√2. 单词 释义」「belt n.带」以及「单词 | 释义 | 例句」（竖线或制表符）。同一个词会跳过。' }), manualText, h('div', { class: 'row' }, h('span', { class: 'spacer' }), button('导入词汇', async () => {
      const entries = extractWords(manualText.value)
      if (!entries.length) throw new Error('未识别到词条，请核对格式：单词在前，中文释义在后')
      const result = await call('import', { records: entries.map(row => ({ type: 'vocabulary', title: row.word, vocabulary: { word: row.word, phonetic: row.phonetic, meaning: row.meaning, examples: row.examples } })) })
      state.draft = null; state.dirty = false; state.type = 'vocabulary'; state.view = 'all'; state.subjectID = ''; state.nodeID = ''; await load(); node.close(); notify(`积累 ${result.created} 个词条，跳过 ${result.skipped} 个重复词`)
    }, true, { id: 'mb-word-import-save' })))
    const mistakePane = h('div', { class: 'mb-import-layout' }, h('div', { class: 'mb-import-source' }, mistakeSource), h('div', { class: 'mb-import-content' }, mistakeContent))
    const notePane = h('div', { class: 'mb-import-layout' }, h('div', { class: 'mb-import-source' }, noteSource), h('div', { class: 'mb-import-content' }, noteContent))
    const vocabPane = h('div', { class: 'mb-import-vocab' },
      h('div', { class: 'mb-import-section' }, h('h3', { text: '拍照 / 扫描积累本' }), photoPane),
      h('div', { class: 'mb-import-section' }, h('h3', { text: '手动粘贴词条' }), manualPane))
    const panes = { mistake: mistakePane, note: notePane, vocabulary: vocabPane }
    const tabs = h('div', { class: 'mb-tabs mb-import-tabs', role: 'tablist', 'aria-label': '录入类型' }, ...[['mistake', '错题 · 拆题'], ['note', '整页笔记'], ['vocabulary', '英语词汇']].map(([key, label]) => button(label, () => showTab(key), false, { class: 'mb-tab', role: 'tab', 'data-import-tab': key })))
    const showTab = key => { for (const [name, pane] of Object.entries(panes)) pane.hidden = name !== key; for (const tab of tabs.querySelectorAll('.mb-tab')) { tab.classList.toggle('on', tab.dataset.importTab === key); tab.setAttribute('aria-selected', String(tab.dataset.importTab === key)) } }
    showTab(initial)
    const node = dialog('录入笔记', h('div', { class: 'mb-import-dialog' }, tabs, loading.element, mistakePane, notePane, vocabPane), true)
    const closeButton = node.querySelector('[aria-label="关闭对话框"]')
    const close = async () => {
      if (draft.running || notes.running) await call('cancelOCR')
      if (photoPane.controller.busy()) { photoPane.controller.cancel(); return }
      const pendingWork = draft.modified || (!notes.imported && notes.files.some(item => item.status === 'done')) || photoPane.controller.hasWork()
      if (pendingWork && !await confirm('当前录入内容尚未导入，放弃并关闭？')) return
      node.close()
    }
    closeButton.replaceWith(h('button', { type: 'button', class: 'btn ghost', text: '关闭', 'aria-label': '关闭录入', onClick: () => void close() }))
    node.addEventListener('cancel', event => { event.preventDefault(); void close() })
    preview.addEventListener('dragover', event => event.preventDefault())
    preview.addEventListener('drop', event => { event.preventDefault(); void guard(() => receive(event.dataTransfer.files[0])) })
    preview.tabIndex = 0
    preview.addEventListener('paste', event => { if (event.clipboardData.files.length) { event.preventDefault(); void guard(() => receive(event.clipboardData.files[0])) } })
    if (initial === 'mistake') text.focus()
  }
  document.addEventListener('keydown', event => {
    if (document.body.dataset.mode !== 'mistakebook' || document.querySelector('dialog[open]')) return
    if (event.key === 'Escape' && state.picking) { state.picking = false; state.selection.clear(); renderList(); return }
    if (event.key === 'Escape' && shell.classList.contains('detail-full')) { shell.classList.remove('detail-full'); renderDetail(); return }
    if (event.ctrlKey || event.metaKey) {
      if (event.key.toLowerCase() === 'f') { event.preventDefault(); search.focus(); search.select() }
      if (event.key.toLowerCase() === 'n') { event.preventDefault(); void guard(openCreate) }
      if (event.key.toLowerCase() === 's' && state.draft && !state.review) { event.preventDefault(); void guard(save) }
    }
  })
}
