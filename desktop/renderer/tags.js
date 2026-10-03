// 自定义标签模块：标签编辑器（词条内）与标签云（侧边栏）。
// 组件不持有任何业务状态——标签数组由调用方传入，变更通过 onChange
// 回调交还调用方写入草稿；非法输入通过 onInvalid 提示而不抛异常。
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

export const normalizeTag = value => String(value ?? '').trim().replace(/[,，、]+$/, '').slice(0, 30)

// renderTagEditor({ tags, onChange(nextTags), onInvalid(message) })
export function renderTagEditor({ tags = [], onChange, onInvalid } = {}) {
  const input = h('input', { class: 'input', id: 'mb-tag-input', placeholder: '输入标签，Enter 或逗号添加', 'aria-label': '添加标签', autocomplete: 'off' })
  const chipRow = h('div', { class: 'mb-tags' })
  const paint = () => chipRow.replaceChildren(...tags.map(tag => h('span', { class: 'mb-tag-chip edit', 'data-tag': tag }, tag,
    h('button', { type: 'button', class: 'mb-tag-remove', 'aria-label': `移除标签 ${tag}`, title: `移除标签 ${tag}`, onClick: () => onChange?.(tags.filter(item => item !== tag)) }, '×'))))
  const add = () => {
    const tag = normalizeTag(input.value)
    if (!tag) return
    if (tags.includes(tag)) { onInvalid?.('这个标签已经添加过了'); return }
    if (tags.length >= 30) { onInvalid?.('每篇笔记最多 30 个标签'); return }
    input.value = ''
    onChange?.([...tags, tag])
  }
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ',' || event.key === '，' || event.key === '、') { event.preventDefault(); add() }
  })
  paint()
  return h('div', { class: 'mb-tag-editor', id: 'mb-tag-editor' },
    h('span', { class: 'label', text: `标签 · ${tags.length}` }),
    chipRow,
    h('div', { class: 'row' }, input, h('button', { type: 'button', class: 'btn ghost', id: 'mb-tag-add', onClick: add }, '添加')))
}

// renderTagCloud({ counts, active, onSelect(tag) }) —— 点击已选中的标签再次回调同名表示取消。
export function renderTagCloud({ counts = {}, active = '', onSelect } = {}) {
  const entries = Object.entries(counts).filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  if (!entries.length) return h('p', { class: 'cap', text: '在笔记编辑器里添加标签，这里会汇总成标签云。' })
  return h('div', { class: 'mb-tag-cloud', id: 'mb-tag-cloud' }, entries.slice(0, 30).map(([tag, count]) =>
    h('button', { type: 'button', class: `mb-tag-chip${active === tag ? ' on' : ''}`, 'data-tag-filter': tag, 'aria-pressed': String(active === tag), title: active === tag ? '点击取消标签筛选' : '点击按标签筛选', onClick: () => onSelect?.(tag) }, `${tag} ${count}`)))
}
