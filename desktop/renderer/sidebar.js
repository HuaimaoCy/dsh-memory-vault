// 侧边栏模块：区块注册表 + 顺序/显隐配置 + 拖拽排序的设置界面。
// 区块（我的学习 / 笔记类型 / 学科 / 标签 / …）由调用方注册为
// { id, label, element() }，模块只负责装配顺序、显隐与持久化；
// 要加新区块，只需在调用方多注册一项，配置对话框自动出现对应行。
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

export function createSidebarController({ storageKey, sections, mount }) {
  let config = readPrefs(storageKey, {})
  const known = id => sections.some(section => section.id === id)
  const order = () => {
    const ordered = [...new Set([...(Array.isArray(config.order) ? config.order : []), ...sections.map(section => section.id)])].filter(known)
    return ordered
  }
  const hiddenSet = () => new Set((Array.isArray(config.hidden) ? config.hidden : []).filter(known))
  const persist = () => writePrefs(storageKey, config)
  const controller = {
    // 重新装配：按配置顺序把未隐藏的区块放进容器。区块元素由注册的
    // element() 提供，内容填充仍归调用方的渲染函数管。
    refresh() {
      const hidden = hiddenSet()
      const byId = new Map()
      for (const section of sections) {
        const element = section.element()
        element.dataset.sideSection = section.id
        byId.set(section.id, element)
      }
      mount.replaceChildren(...order().filter(id => !hidden.has(id)).map(id => byId.get(id)))
    },
    config: () => ({ order: order(), hidden: [...hiddenSet()] }),
    setConfig(next) {
      const orderNext = [...new Set([...(next?.order ?? []), ...sections.map(section => section.id)])].filter(known)
      const hiddenNext = [...new Set((next?.hidden ?? []).filter(known))]
      // 至少保留一个可见区块，避免把自己锁在空白侧边栏外。
      while (hiddenNext.length >= sections.length) hiddenNext.pop()
      config = { order: orderNext, hidden: hiddenNext }
      persist(); controller.refresh()
    },
    reset() { clearPrefs(storageKey); config = {}; controller.refresh() },
  }
  return controller
}

// renderSidebarConfig({ sections, current, onChange }) —— 配置界面本体：
// 每个区块一行（拖柄 + 名称 + 显示开关），HTML5 拖拽排序，改动即时回调。
export function renderSidebarConfig({ sections, current, onChange }) {
  let order = [...new Set([...(current?.order ?? []), ...sections.map(section => section.id)])]
    .filter(id => sections.some(section => section.id === id))
  const hidden = new Set((current?.hidden ?? []).filter(id => sections.some(section => section.id === id)))
  let dragIndex = -1
  const apply = () => onChange({ order: [...order], hidden: [...hidden] })
  const list = h('div', { class: 'mb-side-config', id: 'mb-side-config', role: 'list' })
  const paint = () => list.replaceChildren(...order.map((id, index) => {
    const section = sections.find(item => item.id === id)
    const row = h('div', { class: 'mb-side-config-row', role: 'listitem', draggable: 'true', 'data-side-config': id },
      h('span', { class: 'mb-side-config-grip', 'aria-hidden': 'true', title: '拖动调整顺序' }, '⠿'),
      h('span', { class: 'mb-side-config-name', text: section.label }),
      h('label', { class: 'row cap' },
        h('input', { type: 'checkbox', checked: !hidden.has(id), 'data-side-visible': id, onChange: event => { event.target.checked ? hidden.delete(id) : hidden.add(id); apply() } }),
        '显示'))
    row.addEventListener('dragstart', () => { dragIndex = index; row.classList.add('dragging') })
    row.addEventListener('dragend', () => { dragIndex = -1; row.classList.remove('dragging') })
    row.addEventListener('dragover', event => { event.preventDefault(); if (dragIndex >= 0 && dragIndex !== index) row.classList.add('drop-above') })
    row.addEventListener('dragleave', () => row.classList.remove('drop-above'))
    row.addEventListener('drop', event => {
      event.preventDefault(); row.classList.remove('drop-above')
      if (dragIndex < 0 || dragIndex === index) return
      const [moved] = order.splice(dragIndex, 1)
      order.splice(index, 0, moved)
      dragIndex = -1
      apply(); paint()
    })
    return row
  }))
  paint()
  return h('div', { class: 'mb-side-config-wrap' },
    h('p', { class: 'cap', text: '拖动调整区块顺序，取消勾选可隐藏暂时不用的区块；至少保留一个。设置即时生效并保存在本机。' }),
    list)
}
