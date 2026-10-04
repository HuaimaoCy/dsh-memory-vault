import { ownTags, section, subsection } from './grouping.js'
import { icon, installIcons } from './icons.js'
import { mountMistakebook } from './mistakebook.js'
import { createLoadingStatus, runAlayaStartup } from './loading.js'

const el = id => document.getElementById(id)
const state = { data: null, info: null, view: { kind: 'all' }, query: '', selected: null, draft: null, dirty: false, busy: false, open: new Set(), collapsed: new Set(), nextOffset: null, cure: null, layout: localStorage.getItem('memory-vault.layout') === 'rows' ? 'rows' : 'grid', settingsTab: 'general' }
const kinds = { note: '笔记', fact: '事实', decision: '决策', preference: '偏好', summary: '总结', task: '任务' }
installIcons()

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
  state.view = view; state.selected = null; state.draft = null; state.dirty = false
  await load()
}
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
  list.classList.toggle('rows', state.layout === 'rows')
  const order = el('sort').value
  const sorted = [...state.data.entries].sort((a, b) => order === 'title' ? (a.title || a.content).localeCompare(b.title || b.content, 'zh-CN') : order === 'updated' ? new Date(b.updatedAt) - new Date(a.updatedAt) : Number(b.base) - Number(a.base) || b.priority - a.priority || new Date(b.updatedAt) - new Date(a.updatedAt))
  const sections = section(sorted, rootOf)
  list.replaceChildren()
  if (!sections.length) {
    const searching = Boolean(state.query)
    list.append(h('div', { class: 'empty' }, h('div', { class: 'empty-art' }, icon(searching ? 'search' : 'vault')),
      h('h2', { text: searching ? '没有找到相关记忆' : '从一条记忆开始' }),
      h('p', { text: searching ? '试试更简短的关键词，或回到全部记忆浏览。' : '记下值得保留的知识、想法和约定，随时回到这里。' }),
      button(searching ? '清除搜索' : '新建记忆', async () => {
        if (searching) await clearSearch(); else await newMemory()
      }, true)))
  }
  for (const part of sections) {
    if (!state.collapsed.has(part.key) && (part.key !== '__hidden__' || state.view.kind === 'hidden')) state.open.add(part.key)
    const open = state.open.has(part.key)
    const head = h('button', { class: 'sec-head', 'aria-expanded': String(open), onClick: () => {
      if (open) { state.open.delete(part.key); state.collapsed.add(part.key) }
      else { state.open.add(part.key); state.collapsed.delete(part.key) }
      renderList()
    } }, h('span', { class: 'section-icon' }, icon(part.key === '__hidden__' ? 'hidden' : 'folder')), h('span', { text: part.label }), h('span', { class: 'count', text: `${part.entries.length}` }), icon(open ? 'chevron-down' : 'chevron-right'))
    const body = h('div', { class: open ? 'sec-body' : 'sec-body hidden' })
    const subsections = subsection(part.entries)
    for (const sub of subsections) {
      const cards = sub.entries.map(entry => h('button', {
      class: `tile${entry.hidden ? ' hidden-tile' : ''}${entry.id === state.selected?.id ? ' selected' : ''}`, 'data-id': entry.id, 'aria-pressed': String(entry.id === state.selected?.id), onClick: () => void guard(async () => { if (await discard()) selectEntry(entry) }),
    }, h('div', { class: 'tile-top' }, h('span', { class: `kind-icon ${entry.kind}` }, icon(entry.kind)), h('span', { class: 'kind-label', text: kinds[entry.kind] ?? '笔记' }), entry.base ? h('span', { class: 'base-mark', text: '底层约定' }) : null),
    h('div', { class: 'tile-title', text: entry.title || entry.content.slice(0, 40) }), h('div', { class: 'tile-body', text: entry.content.replace(/^\s{0,3}#{1,6}\s+/gm, '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\s+/g, ' ').slice(0, 170) }), h('div', { class: 'tags' },
      entry.groupName !== rootOf(entry) ? tag(entry.groupName) : null,
      entry.hidden ? tag('已隐藏') : null, entry.imageCount ? tag(`${entry.imageCount} 张图片`) : null, ownTags(entry).slice(0, 3).map(tag)),
      h('div', { class: 'tile-footer' }, h('span', { text: entry.source === 'panel' ? '手动记录' : entry.tags.includes('AI 生成') ? 'AI 生成' : entry.source || '记忆' }), h('span', { class: 'date', text: new Date(entry.updatedAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }) }))))
      body.append(h('div', { class: 'sub' }, sub.label === '未打标签' && subsections.length === 1 ? null : h('div', { class: 'sub-head' }, sub.label === '未打标签' ? '其他记忆' : sub.label, h('span', { class: 'cap', text: sub.entries.length })), h('div', { class: 'grid' }, cards)))
    }
    list.append(h('section', { class: 'sec' }, head, body))
  }
  if (state.nextOffset !== null) list.append(button('加载更多', () => load(true), false, { id: 'load-more' }))
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
  drawer.classList.toggle('hidden', !state.selected)
  document.querySelector('.body').classList.toggle('with-inspector', Boolean(state.selected))
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
function viewLabel() {
  return state.view.kind === 'group' ? state.data?.groups.find(group => group.id === state.view.id)?.name ?? '记忆组' : state.view.kind === 'scope' ? (state.view.id === 'knowledge' ? '知识库' : '对话记忆') : state.view.kind === 'hidden' ? '隐藏记忆' : '全部记忆'
}
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
  el('view-title').textContent = searching ? '搜索结果' : label
  el('breadcrumb').textContent = label
  el('view-description').textContent = searching ? `找到 ${state.nextOffset === null ? '' : '至少 '}${state.data.entries.length} 条相关记忆。` : state.view.kind === 'hidden' ? '暂时收起的记忆，随时可以恢复。' : state.view.id === 'conversation' ? '留住对话里的线索、进展与上下文。' : state.view.id === 'knowledge' ? '值得复用的知识，下一次也用得上。' : state.view.kind === 'group' ? '围绕一个主题，整理值得保留的内容。' : '让知识、灵感与约定各归其位。'
  renderSearchContext()
  el('view-count').textContent = `${state.nextOffset === null ? '' : '≥'}${state.data.entries.length}`
  el('foot-left').textContent = `${state.data.groups.length} 个记忆组 · ${state.data.stats.totals.entries} 条可见记忆 · ${state.data.stats.hidden} 条隐藏`
  el('foot-right').title = state.info.databasePath
  el('curate').disabled = el('curate-review').disabled = !state.info.model.baseUrl
  el('curate').title = el('curate-review').title = state.info.model.baseUrl ? '会调用设置中的 AI 服务' : '先在设置中配置 AI 服务'
  el('curation-hint').textContent = state.info.model.baseUrl ? '先预览建议，再决定是否整理保存。整理范围覆盖整个数据库。' : '连接 AI 服务后，即可预览整理建议。'
  el('curation-setup').classList.toggle('hidden', Boolean(state.info.model.baseUrl))
  for (const [id, layout] of [['view-grid', 'grid'], ['view-list', 'rows']]) { el(id).classList.toggle('active', state.layout === layout); el(id).setAttribute('aria-pressed', String(state.layout === layout)) }
}
function modal(title, ...children) {
  el('modal')?.remove()
  el('curation-menu').open = false
  const dialog = h('dialog', { id: 'modal', class: 'modal', 'aria-labelledby': 'modal-title', onClose: () => { dialog.remove(); scheduleSearch() } }, h('div', { class: 'modal-header' }, h('h2', { id: 'modal-title', text: title }), h('span', { class: 'spacer' }), iconButton('close', '关闭', async () => dialog.close())), h('div', { class: 'modal-status', role: 'status' }), h('div', { class: 'modal-body' }, children))
  document.body.append(dialog); dialog.showModal()
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
    ['general', '通用', 'database',
      h('section', { class: 'col' }, h('h3', { text: '当前数据库' }), h('p', { class: 'cap', text: '记忆保存在本机。打开其他数据库，或为当前内容留一份备份。' }),
        h('code', { class: 'path-box', text: info.databasePath }),
        h('div', { class: 'row' }, button('打开其他数据库', async () => {
          if (!await discard()) return
          const result = await desktop('open')
          if (result) { state.selected = null; state.dirty = false; state.view = { kind: 'all' }; await load(); settings(); say('数据库已切换', 'ok') }
        }), button('备份数据库', async () => { const result = await desktop('backup'); if (result) say(`备份已保存：${result.path}`, 'ok') }))),
      h('section', {}, h('div', { class: 'settings-info' }, icon('vault'), h('div', {}, h('strong', { text: `Alaya ${info.version}` }), h('p', { text: '独立桌面数据库 · 支持 Codex 与 DSH 接口' }))))],
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
async function newMemory() {
  if (!await discard()) return
  const scope = state.view.kind === 'scope' ? state.view.id : 'knowledge'
  const group = state.data.groups.find(group => group.id === state.view.id) ?? state.data.groups.find(group => group.scope === scope) ?? state.data.groups[0]
  selectEntry({ id: '', title: '', content: '', tags: [], kind: 'note', scope: group.scope, priority: 0, base: false, hidden: false, groupId: group.id })
  document.querySelector('#drawer [data-field="title"]').focus()
}
el('new').addEventListener('click', () => void guard(newMemory))
for (const [id, layout] of [['view-grid', 'grid'], ['view-list', 'rows']]) el(id).addEventListener('click', () => {
  state.layout = layout; localStorage.setItem('memory-vault.layout', layout)
  renderList()
  for (const [buttonId, value] of [['view-grid', 'grid'], ['view-list', 'rows']]) { el(buttonId).classList.toggle('active', value === layout); el(buttonId).setAttribute('aria-pressed', String(value === layout)) }
})
el('sort').title = '对已加载的记忆排序；加载更多后一起排序'
el('sort').addEventListener('change', renderList)
el('manage-groups').addEventListener('click', () => void guard(async () => { if (await discard()) groupManager() }))
el('settings').addEventListener('click', () => void guard(async () => { if (await discard()) settings() }))
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
document.addEventListener('keydown', event => {
  if (document.body.dataset.mode === 'mistakebook') return
  if (document.querySelector('dialog[open]') || !state.data) return
  if (event.ctrlKey || event.metaKey) {
    if (event.key.toLowerCase() === 'f') { event.preventDefault(); el('query').focus(); el('query').select() }
    if (event.key.toLowerCase() === 'n') { event.preventDefault(); void guard(newMemory) }
    if (event.key.toLowerCase() === 's' && state.selected) { event.preventDefault(); document.querySelector('.editor-form').requestSubmit() }
  }
  if (event.key === 'Escape') {
    if (el('curation-menu').open) { el('curation-menu').open = false; return }
    if (state.selected) void guard(async () => { if (await discard()) { state.selected = null; state.dirty = false; renderList(); renderDrawer() } })
  }
})
document.addEventListener('click', event => { if (!el('curation-menu').contains(event.target)) el('curation-menu').open = false })
window.addEventListener('focus', () => { if (document.body.dataset.mode !== 'mistakebook' && !state.dirty && state.data && !document.querySelector('dialog[open]')) void guard(() => load()) })
mountMistakebook({ beforeEnter: async () => {
  if (state.busy || document.querySelector('dialog[open]') || !await discard()) return false
  state.dirty = false; state.selected = null; state.draft = null; render(); return true
} })
void guard(async () => {
  await runAlayaStartup(load)
}).then(() => {
  // Open where the user left off; the notebook is this app's primary face.
  if ((localStorage.getItem('alaya.mode') ?? 'notebook') === 'notebook') document.getElementById('mode-switch').click()
  else say('Alaya 已打开')
})
