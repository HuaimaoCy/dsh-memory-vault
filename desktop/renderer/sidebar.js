// 侧边栏模块：区块注册表 + 顺序/显隐配置 + 区块内条目编辑 + 拖拽排序界面。
// 区块由调用方注册为 { id, label, element(), items?() }；带 items 的区块
//（我的学习 / 笔记类型 / 学科）还支持条目级排序与显隐——同一套注册表，
// 配置界面自动出现「编辑内容」。模块不含任何具体区块的知识。
import { readPrefs, writePrefs, clearPrefs } from './layout.js'

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

const asIdList = value => Array.isArray(value) ? value.map(String) : []

export function createSidebarController({ storageKey, sections, mount, onApply }) {
  let config = readPrefs(storageKey, {})
  const known = id => sections.some(section => section.id === id)
  const apply = () => { controller.refresh(); onApply?.() }
  const sectionOrder = () => [...new Set([...asIdList(config.order), ...sections.map(section => section.id)])].filter(known)
  const hiddenSet = () => new Set(asIdList(config.hidden).filter(known))
  const controller = {
    // 重新装配：按配置顺序把未隐藏的区块放进容器；区块内容仍由调用方渲染。
    refresh() {
      const hidden = hiddenSet()
      const byId = new Map()
      for (const section of sections) {
        const element = section.element()
        element.dataset.sideSection = section.id
        byId.set(section.id, element)
      }
      mount.replaceChildren(...sectionOrder().filter(id => !hidden.has(id)).map(id => byId.get(id)))
    },
    config() { return { order: sectionOrder(), hidden: [...hiddenSet()], items: config.items ?? {} } },
    // 条目级装配：按该区块的条目配置过滤 + 排序，items 为 [{id, label, element}]。
    arrange(sectionId, items) {
      const itemConfig = config.items?.[sectionId] ?? {}
      const hidden = new Set(asIdList(itemConfig.hidden))
      const ordered = [...new Set([...asIdList(itemConfig.order), ...items.map(item => item.id)])].filter(id => items.some(item => item.id === id))
      const byId = new Map(items.map(item => [item.id, item]))
      return ordered.filter(id => !hidden.has(id)).map(id => byId.get(id))
    },
    setConfig(next) {
      const orderNext = [...new Set([...asIdList(next?.order), ...sections.map(section => section.id)])].filter(known)
      const hiddenNext = [...new Set(asIdList(next?.hidden).filter(known))]
      // 至少保留一个可见区块，避免把自己锁在空白侧边栏外。
      while (hiddenNext.length >= sections.length) hiddenNext.pop()
      config = { ...config, order: orderNext, hidden: hiddenNext }
      writePrefs(storageKey, config); apply()
    },
    setItems(sectionId, next) {
      if (!known(sectionId)) return
      const items = { ...(config.items ?? {}) }
      items[sectionId] = { order: asIdList(next?.order), hidden: asIdList(next?.hidden) }
      config = { ...config, items }
      writePrefs(storageKey, config); apply()
    },
    reset() { clearPrefs(storageKey); config = {}; apply() },
  }
  return controller
}

const reorderList = (list, sourceId, targetId) => {
  const from = list.indexOf(sourceId), to = list.indexOf(targetId)
  if (from < 0 || to < 0 || from === to) return null
  const next = [...list]
  next.splice(to, 0, next.splice(from, 1)[0])
  return next
}

// renderSidebarConfig({ sections, current, onChange, onItemsChange })
// 区块行可拖拽排序 / 显隐；带 items 的区块可展开条目列表做同样的排序与
// 显隐。所有改动即时回调，持久化归控制器。
export function renderSidebarConfig({ sections, current, onChange, onItemsChange }) {
  const sectionOrder = [...new Set([...asIdList(current?.order), ...sections.map(section => section.id)])]
    .filter(id => sections.some(section => section.id === id))
  const sectionHidden = new Set(asIdList(current?.hidden))
  const expanded = new Set()
  // 条目工作副本：{ [sectionId]: { order, hidden } }，从 current.items 初始化。
  const itemState = {}
  for (const section of sections) {
    const saved = current?.items?.[section.id] ?? {}
    const ids = (section.items?.() ?? []).map(item => item.id)
    itemState[section.id] = { order: [...new Set([...asIdList(saved.order), ...ids])], hidden: new Set(asIdList(saved.hidden)) }
  }
  const context = { drag: '' }
  // 拖拽行：共享 context 记录源行，drop 时把 (source, target) 交给 onReorder。
  const dragRow = ({ id, label, attributes = {}, children = [], onReorder }) => {
    const row = h('div', { class: 'mb-side-config-row', role: 'listitem', draggable: 'true', ...attributes },
      h('span', { class: 'mb-side-config-grip', 'aria-hidden': 'true', title: '拖动调整顺序' }, '⠿'),
      h('span', { class: 'mb-side-config-name', text: label }),
      ...children)
    row.addEventListener('dragstart', () => { context.drag = id; row.classList.add('dragging') })
    row.addEventListener('dragend', () => { context.drag = ''; row.classList.remove('dragging') })
    row.addEventListener('dragover', event => { event.preventDefault(); if (context.drag && context.drag !== id) row.classList.add('drop-above') })
    row.addEventListener('dragleave', () => row.classList.remove('drop-above'))
    row.addEventListener('drop', event => {
      event.preventDefault(); row.classList.remove('drop-above')
      if (!context.drag || context.drag === id) return
      const source = context.drag
      context.drag = ''
      onReorder?.(source, id)
    })
    return row
  }
  const applySection = () => onChange({ order: [...sectionOrder], hidden: [...sectionHidden] })
  const applyItems = id => onItemsChange?.(id, { order: [...itemState[id].order], hidden: [...itemState[id].hidden] })
  const paint = () => {
    const nodes = []
    for (const id of sectionOrder) {
      const section = sections.find(item => item.id === id)
      nodes.push(dragRow({
        id, label: section.label, attributes: { 'data-side-config': id },
        children: [
          section.items ? h('button', { type: 'button', class: 'btn ghost', id: `mb-side-config-edit-${id}`, 'aria-expanded': String(expanded.has(id)), onClick: () => { expanded.has(id) ? expanded.delete(id) : expanded.add(id); paint() } }, expanded.has(id) ? '收起内容' : '编辑内容') : null,
          h('label', { class: 'row cap' }, h('input', { type: 'checkbox', checked: !sectionHidden.has(id), 'data-side-visible': id, onChange: event => { event.target.checked ? sectionHidden.delete(id) : sectionHidden.add(id); applySection() } }), '显示'),
        ],
        onReorder: (source, target) => {
          const next = reorderList(sectionOrder, source, target)
          if (!next) return
          sectionOrder.length = 0; sectionOrder.push(...next)
          applySection(); paint()
        },
      }))
      if (section.items && expanded.has(id)) {
        const items = section.items() ?? []
        const state = itemState[id]
        const visible = [...new Set([...state.order, ...items.map(item => item.id)])].filter(itemId => items.some(item => item.id === itemId))
        nodes.push(h('div', { class: 'mb-side-items', role: 'list' }, visible.flatMap(itemId => {
          const item = items.find(entry => entry.id === itemId)
          if (!item) return []
          return [dragRow({
            id: itemId, label: item.label, attributes: { 'data-side-item': itemId },
            children: [h('label', { class: 'row cap' }, h('input', { type: 'checkbox', checked: !state.hidden.has(itemId), 'data-side-item-visible': itemId, onChange: event => { event.target.checked ? state.hidden.delete(itemId) : state.hidden.add(itemId); applyItems(id) } }), '显示')],
            onReorder: (source, target) => {
              const next = reorderList(state.order, source, target)
              if (!next) return
              state.order.length = 0; state.order.push(...next)
              applyItems(id); paint()
            },
          })]
        })))
      }
    }
    list.replaceChildren(...nodes)
  }
  const list = h('div', { class: 'mb-side-config', id: 'mb-side-config', role: 'list' })
  paint()
  return h('div', { class: 'mb-side-config-wrap' },
    h('p', { class: 'cap', text: '拖动调整区块顺序，取消勾选隐藏区块；「编辑内容」可继续排序、隐藏区块里的每一项。设置即时生效并保存在本机。' }),
    list)
}
