// 侧边栏模块（0.7.7 统一架构）：配置完全数据化，存笔记本数据库
// （mistakebook.sqlite 的 addon_meta），与数据库侧边栏同为数据驱动。
// 配置模型：{ sections: [{id, label, custom?, tags?, items:[itemId]}], hidden:[id] }
// itemId 形如 view:all / type:physics / subject:english；每个条目只属于一个
// 区块（拖拽跨区块移动即改变它的归属）；hidden 同时收纳区块 id 与条目 id。

const h = (tag, props = {}, ...children) => {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = value
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value)
    else node.setAttribute(key, String(value))
  }
  for (const item of children.flat(Infinity)) if (item !== null && item !== undefined && item !== false) node.append(item instanceof Node ? item : String(item))
  return node
}

export const BUILTIN_SECTIONS = ['views', 'types', 'subjects', 'tags']
const DEFAULT_LABELS = { views: '我的学习', types: '笔记类型', subjects: '按学科整理', tags: '标签' }
const homeOf = id => id.startsWith('view:') ? 'views' : id.startsWith('type:') ? 'types' : id.startsWith('subject:') ? 'subjects' : ''

// 把任意输入整成合法配置：内置区块缺失即补；未知条目丢弃；没进任何区块的
// 已知条目回到默认归属区块；标签区块 items 恒空（内容由标签云动态填充）。
export function normalizeSidebarConfig(raw, knownIds = []) {
  const known = new Set(knownIds)
  const sections = [], seen = new Set(), placed = new Set()
  for (const entry of Array.isArray(raw?.sections) ? raw.sections : []) {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !entry.id) continue
    const id = entry.id.slice(0, 60)
    const builtIn = BUILTIN_SECTIONS.includes(id)
    if (sections.some(section => section.id === id)) continue
    const label = String(entry.label ?? '').trim().slice(0, 30) || DEFAULT_LABELS[id] || '区块'
    const items = builtIn && id === 'tags' ? [] : [...new Set((Array.isArray(entry.items) ? entry.items : []).map(String))].filter(item => known.has(item) && !placed.has(item))
    for (const item of items) placed.add(item)
    sections.push(builtIn ? { id, label, ...(id === 'tags' ? { tags: true } : {}), items: id === 'tags' ? [] : items } : { id, label, custom: true, items })
  }
  for (const id of BUILTIN_SECTIONS) if (!sections.some(section => section.id === id)) sections.push(id === 'tags' ? { id, label: DEFAULT_LABELS[id], tags: true, items: [] } : { id, label: DEFAULT_LABELS[id], items: [] })
  for (const id of known) if (!placed.has(id)) {
    const home = sections.find(section => section.id === homeOf(id))
    if (home) home.items.push(id)
  }
  const hidden = [...new Set((Array.isArray(raw?.hidden) ? raw.hidden : []).map(String))]
    .filter(id => known.has(id) || sections.some(section => section.id === id))
  return { sections, hidden }
}

// 控制器：read() 取数据库里的原始配置（随 list 返回），write(next) 异步持久
// 化，knownItems() 给出当前合法条目 id；onApply 在每次改动后重渲染侧边栏。
export function createSidebarController({ read, write, knownItems, onApply }) {
  let cache = normalizeSidebarConfig(read(), knownItems())
  const controller = {
    sync() { cache = normalizeSidebarConfig(read(), knownItems()); return cache },
    config() { return cache },
    setConfig(next) {
      cache = normalizeSidebarConfig(next, knownItems())
      void write(cache)
      onApply?.()
    },
  }
  return controller
}

const reorder = (list, source, target) => {
  const from = list.indexOf(source), to = list.indexOf(target)
  if (from < 0 || to < 0 || from === to) return null
  const next = [...list]
  next.splice(to, 0, next.splice(from, 1)[0])
  return next
}

// 配置对话框：区块可重命名 / 新增 / 排序 / 隐藏；「编辑内容」展开条目，
// 条目可勾选隐藏，也可拖到别的区块（改变条目归属）；改完即时回调 onChange。
export function renderSidebarConfig({ config, knownItems, onChange }) {
  const sections = config.sections.map(section => ({ ...section, items: [...section.items] }))
  const hidden = new Set(config.hidden)
  const expanded = new Set(), renaming = new Set()
  const context = { section: '', item: '' }
  const catalog = knownItems()
  const known = catalog.map(item => item.id)
  const itemLabel = id => {
    const [kind, ref] = id.split(':')
    return kind === 'view' ? ({ all: '全部笔记', due: '待复习', mastered: '已掌握', archived: '归档', trash: '回收站' })[ref] ?? ref
      : kind === 'type' ? ({ mistake: '错题', physics: '物理模型', method: '解题方法', vocabulary: '英语词汇', handwriting: '手写笔记', note: '普通笔记' })[ref] ?? ref
      : (catalog.find(item => item.id === id)?.label ?? ref)
  }
  const apply = () => onChange({ sections: sections.map(section => ({ ...section, items: [...section.items] })), hidden: [...hidden] })
  const itemRows = section => {
    if (!section.items.length) return [h('p', { class: 'cap mb-side-empty', 'data-side-items': section.id, text: '暂无条目——从其他区块拖一项进来，或用上方「编辑内容」整理。' })]
    return section.items.flatMap(itemId => {
      if (!known.includes(itemId)) return []
      return [h('div', { class: 'mb-side-config-row', role: 'listitem', draggable: 'true', 'data-side-item': itemId },
        h('span', { class: 'mb-side-config-grip', 'aria-hidden': 'true', title: '拖动排序；拖到其他区块可改变归属' }, '⠿'),
        h('span', { class: 'mb-side-config-name', text: itemLabel(itemId) }),
        h('label', { class: 'row cap' }, h('input', { type: 'checkbox', checked: !hidden.has(itemId), 'data-side-item-visible': itemId, onChange: event => { event.target.checked ? hidden.delete(itemId) : hidden.add(itemId); apply() } }), '显示'),
      )]
    })
  }
  const sectionDrop = (row, section) => {
    row.addEventListener('dragover', event => {
      if (context.section && context.section !== section.id) { event.preventDefault(); row.classList.add('drop-above'); return }
      if (context.item && !section.items.includes(context.item)) { event.preventDefault(); row.classList.add('drop-above') }
    })
    row.addEventListener('dragleave', () => row.classList.remove('drop-above'))
    row.addEventListener('drop', event => {
      event.preventDefault(); row.classList.remove('drop-above')
      if (context.section && context.section !== section.id) {
        const from = sections.findIndex(item => item.id === context.section), to = sections.findIndex(item => item.id === section.id)
        context.section = ''
        if (from < 0 || to < 0) return
        sections.splice(to, 0, sections.splice(from, 1)[0])
        apply(); paint(); return
      }
      if (context.item && !section.items.includes(context.item)) {
        const item = context.item
        context.item = ''
        for (const other of sections) other.items = other.items.filter(id => id !== item)
        section.items.push(item)
        apply(); paint()
      }
    })
  }
  const wireItemDrag = (row, itemId, section) => {
    row.addEventListener('dragstart', () => { context.item = itemId; context.section = ''; row.classList.add('dragging') })
    row.addEventListener('dragend', () => { context.item = ''; row.classList.remove('dragging') })
    row.addEventListener('dragover', event => {
      if (!context.item || context.item === itemId) return
      event.preventDefault(); row.classList.add('drop-above')
    })
    row.addEventListener('dragleave', () => row.classList.remove('drop-above'))
    row.addEventListener('drop', event => {
      event.preventDefault(); row.classList.remove('drop-above')
      const source = context.item
      context.item = ''
      if (!source || source === itemId) return
      for (const other of sections) other.items = other.items.filter(id => id !== source)
      section.items.splice(section.items.indexOf(itemId) + 1, 0, source)
      apply(); paint()
    })
  }
  const paint = () => {
    const nodes = []
    for (const section of sections) {
      const renameBox = renaming.has(section.id)
      const row = h('div', { class: 'mb-side-config-row', role: 'listitem', draggable: String(!renameBox), 'data-side-config': section.id },
        h('span', { class: 'mb-side-config-grip', 'aria-hidden': 'true', title: '拖动调整区块顺序' }, '⠿'),
        renameBox
          ? h('div', { class: 'row mb-side-rename' },
              h('input', { class: 'input', id: 'mb-side-rename-input', value: section.label, 'aria-label': '区块名称', onKeydown: event => { if (event.key === 'Enter') { section.label = event.target.value.trim().slice(0, 30) || section.label; renaming.delete(section.id); apply(); paint() } } }),
              h('button', { type: 'button', class: 'btn ghost', id: 'mb-side-rename-save', text: '保存', onClick: () => { const input = row.querySelector('#mb-side-rename-input'); section.label = (input?.value ?? '').trim().slice(0, 30) || section.label; renaming.delete(section.id); apply(); paint() } }))
          : h('span', { class: 'mb-side-config-name', text: section.label }),
        !renameBox ? h('button', { type: 'button', class: 'btn ghost', id: `mb-side-config-rename-${section.id}`, text: '重命名', onClick: () => { renaming.add(section.id); paint() } }) : null,
        !section.tags ? h('button', { type: 'button', class: 'btn ghost', id: `mb-side-config-edit-${section.id}`, 'aria-expanded': String(expanded.has(section.id)), text: expanded.has(section.id) ? '收起内容' : '编辑内容', onClick: () => { expanded.has(section.id) ? expanded.delete(section.id) : expanded.add(section.id); paint() } }) : null,
        h('label', { class: 'row cap' }, h('input', { type: 'checkbox', checked: !hidden.has(section.id), 'data-side-visible': section.id, onChange: event => { event.target.checked ? hidden.delete(section.id) : hidden.add(section.id); apply() } }), '显示'))
      row.addEventListener('dragstart', () => { if (renameBox) return; context.section = section.id; context.item = ''; row.classList.add('dragging') })
      row.addEventListener('dragend', () => { context.section = ''; row.classList.remove('dragging') })
      sectionDrop(row, section)
      nodes.push(row)
      if (!section.tags && expanded.has(section.id)) {
        const list = h('div', { class: 'mb-side-items', role: 'list', 'data-side-items': section.id })
        const rows = itemRows(section)
        for (const itemRow of rows) if (itemRow.classList?.contains('mb-side-config-row')) wireItemDrag(itemRow, itemRow.dataset.sideItem, section)
        list.append(...rows)
        nodes.push(list)
      }
    }
    body.replaceChildren(...nodes)
  }
  const body = h('div', { class: 'mb-side-config', id: 'mb-side-config', role: 'list' })
  paint()
  return h('div', { class: 'mb-side-config-wrap' },
    h('p', { class: 'cap', text: '区块可重命名、新增、排序、隐藏；「编辑内容」可整理条目，把条目拖到别的区块即改变归属。配置保存在笔记本数据库里。' }),
    body,
    h('div', { class: 'row mb-side-add' },
      h('input', { class: 'input', id: 'mb-side-new-section', placeholder: '新区块名称，如「常用」', 'aria-label': '新区块名称', onKeydown: event => { if (event.key === 'Enter') addSection() } }),
      h('button', { type: 'button', class: 'btn ghost', id: 'mb-side-add-section', text: '添加区块', onClick: addSection })))
  function addSection() {
    const input = document.getElementById('mb-side-new-section')
    const label = (input?.value ?? '').trim().slice(0, 30)
    if (!label) return
    let id = `custom-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`
    while (sections.some(section => section.id === id)) id += 'x'
    sections.push({ id, label, custom: true, items: [] })
    expanded.add(id)
    input.value = ''
    apply(); paint()
  }
}

// 旧版（localStorage）一次性迁移：把 0.7.5/0.7.6 的区块/条目配置换算成
// 统一模型。迁移后清掉旧键，之后数据库是唯一事实源。
// 这是渲染层唯一允许读 localStorage 的地方（仅为旧配置迁移，读一次即清）。
export function migrateLegacySidebar() {
  let legacy = null
  try { legacy = JSON.parse(localStorage.getItem('alaya.sidebar') ?? 'null') } catch { legacy = null }
  if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy) || !Array.isArray(legacy.order)) return null
  const prefix = { views: 'view', types: 'type', subjects: 'subject' }
  const sections = [], hidden = []
  for (const id of legacy.order) {
    if (!BUILTIN_SECTIONS.includes(id)) continue
    const items = legacy.items?.[id] ?? {}
    const ids = (Array.isArray(items.order) ? items.order : []).map(item => `${prefix[id] ?? ''}${prefix[id] ? ':' : ''}${item}`)
      .filter(item => !prefix[id] || item !== ':')
    for (const item of Array.isArray(items.hidden) ? items.hidden : []) hidden.push(`${prefix[id] ?? ''}${prefix[id] ? ':' : ''}${item}`)
    sections.push(id === 'tags' ? { id, label: '标签', tags: true, items: [] } : { id, items: ids })
  }
  try { localStorage.removeItem('alaya.sidebar') } catch { /* 存储不可用时忽略 */ }
  return { sections, hidden }
}
