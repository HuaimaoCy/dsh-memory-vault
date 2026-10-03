// 通用可视化关系树：类型注册表 + 纯图构建 + DOM 渲染。
// 核心不依赖词汇语义——调用方把任意记录映射成 {key, word, record, edges}
// 即可复用整棵树；注册新关系类型只需往 RELATION_TYPES 加一项。
import { normalizeWord, relationsOf } from '../../addons/mistakebook/words.mjs'

export const RELATION_TYPES = [
  { type: 'synonym', label: '近义词', short: '近义' },
  { type: 'antonym', label: '反义词', short: '反义' },
  { type: 'form', label: '词形变化', short: '变形' },
]
const TYPE_RANK = new Map(RELATION_TYPES.map((item, index) => [item.type, index]))
const typeMeta = type => RELATION_TYPES.find(item => item.type === type) ?? { type, label: type, short: type }

// nodes: [{key, word, record, edges: [{type, key, word}]}]；同名 key 先到先得，
// 调用方按优先级排序（词库：正常 → 归档 → 回收站）。expanded 是允许展开的
// key 集合；只有词库内（有 record）的节点可以继续展开下一层。环与重复边由
// 集合天然去重，节点总量超过 maxNodes 时截断并标记 truncated。
export function buildGraph(nodes, rootKey, expanded, { maxNodes = 60 } = {}) {
  const open = expanded instanceof Set ? expanded : new Set(expanded ?? [])
  const byKey = new Map()
  for (const node of nodes ?? []) if (node?.key && !byKey.has(node.key)) byKey.set(node.key, node)
  const root = byKey.get(rootKey)
  if (!root) return { root: null, nodes: new Map(), edges: [], children: new Map(), truncated: false }
  open.add(rootKey)
  const info = new Map([[rootKey, { depth: 0, word: root.word, record: root.record ?? null }]])
  const edges = new Map(), children = new Map(), queue = [root]
  let truncated = false
  while (queue.length) {
    const current = queue.shift()
    if (!open.has(current.key)) continue
    const grouped = new Map()
    for (const edge of current.edges ?? []) {
      if (!edge?.key || edge.key === current.key) continue
      if (!grouped.has(edge.type)) grouped.set(edge.type, new Map())
      grouped.get(edge.type).set(edge.key, edge)
    }
    const listed = []
    for (const [type, map] of [...grouped.entries()].sort((a, b) => (TYPE_RANK.get(a[0]) ?? 99) - (TYPE_RANK.get(b[0]) ?? 99))) {
      for (const edge of map.values()) {
        edges.set(`${current.key}\u0000${edge.key}\u0000${type}`, { from: current.key, to: edge.key, type })
        listed.push({ type, key: edge.key, word: edge.word })
      }
    }
    children.set(current.key, listed)
    for (const item of listed) {
      if (info.has(item.key)) continue
      if (info.size >= maxNodes) { truncated = true; continue }
      const target = byKey.get(item.key)
      info.set(item.key, { depth: info.get(current.key).depth + 1, word: target?.word ?? item.word, record: target?.record ?? null })
      if (target) queue.push(target)
    }
  }
  return { root, nodes: info, edges: [...edges.values()], children, truncated }
}

// 词汇适配器：把词库记录映射成通用节点，近义/反义/词形三类边来自词条字段。
export function vocabularyGraph(records, rootWord, expanded, options) {
  const nodes = []
  for (const record of records ?? []) {
    const word = record?.vocabulary?.word
    if (!word?.trim()) continue
    nodes.push({ key: normalizeWord(word), word: word.trim(), record,
      edges: relationsOf(record.vocabulary).map(rel => ({ type: rel.type, key: normalizeWord(rel.word), word: rel.word })) })
  }
  return buildGraph(nodes, normalizeWord(rootWord), expanded, options)
}

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

// graph 由 buildGraph/vocabularyGraph 产出；回调：onToggle(key) 展开/收起、
// onOpen(recordId) 跳转词条、onLookup(word) 对词库外的词直接查词典。
export function renderRelationTree(graph, { expanded = new Set(), onToggle, onOpen, onLookup } = {}) {
  const container = h('div', { class: 'mb-tree' })
  if (!graph?.root) { container.append(h('p', { class: 'cap', text: '词库中没有这个词条，先保存或查词典后再看关联树。' })); return container }
  const rendered = new Set()
  const renderRow = (key, word, record, depth) => {
    rendered.add(key)
    const row = h('div', { class: `mb-tree-node${depth === 0 ? ' root' : ''}${record ? '' : ' ghost'}`, 'data-tree-key': key })
    if (record && depth > 0) row.append(h('button', { type: 'button', class: `btn ghost mb-tree-toggle${expanded.has(key) ? ' on' : ''}`, 'aria-expanded': String(expanded.has(key)), 'aria-label': `${expanded.has(key) ? '收起' : '展开'} ${word} 的关联`, title: `${expanded.has(key) ? '收起' : '展开'}这个词的关联`, onClick: () => onToggle?.(key) }, expanded.has(key) ? '▾' : '▸'))
    row.append(h('span', { class: 'mb-tree-word', text: word }))
    if (record) {
      const snippet = [record.vocabulary?.partOfSpeech, record.vocabulary?.meaning].filter(Boolean).join(' ').replace(/\s+/g, ' ').slice(0, 26)
      if (snippet) row.append(h('span', { class: 'mb-tree-meta', text: snippet }))
      if (record.reciteCount) row.append(h('span', { class: 'mb-word-recite', text: `背${record.reciteCount}`, title: `词典查询背诵 ${record.reciteCount} 次` }))
      if (depth > 0) row.append(h('button', { type: 'button', class: 'btn ghost mb-tree-open', title: '打开这个词条', onClick: () => onOpen?.(record.id) }, '打开'))
    } else {
      row.append(h('span', { class: 'mb-tree-tag', text: '词库外' }))
      row.append(h('button', { type: 'button', class: 'btn ghost mb-tree-lookup', 'data-rel-lookup': word, title: '查词典并自动存入单词库', onClick: () => onLookup?.(word) }, '查'))
    }
    return row
  }
  const renderChildren = (key, depth) => {
    const groups = graph.children.get(key)
    if (!groups?.length) return null
    const byType = new Map()
    for (const item of groups) { if (!byType.has(item.type)) byType.set(item.type, []); byType.get(item.type).push(item) }
    return h('div', { class: 'mb-tree-children' }, [...byType.entries()].map(([type, items]) => h('div', { class: 'mb-rel-group' },
      h('span', { class: `mb-rel-kind ${typeMeta(type).type}`, text: `${typeMeta(type).label} ${items.length}` }),
      h('div', { class: 'mb-rel-list' }, items.map(item => {
        if (rendered.has(item.key)) return h('div', { class: 'mb-tree-node ref' }, h('span', { class: 'mb-tree-word', text: item.word }), h('span', { class: 'mb-tree-meta', text: '已在树中' }))
        const entry = graph.nodes.get(item.key)
        return renderNode(item.key, entry?.word ?? item.word, entry?.record ?? null, depth + 1)
      })))))
  }
  const renderNode = (key, word, record, depth) => {
    const block = h('div', { class: 'mb-tree-block' }, renderRow(key, word, record, depth))
    if (record && expanded.has(key)) {
      const children = renderChildren(key, depth)
      if (children) block.append(children)
      else if (depth > 0) block.append(h('p', { class: 'cap mb-tree-none', text: '（无更多关联）' }))
    }
    return block
  }
  const rootNode = graph.nodes.get(graph.root.key)
  container.append(renderNode(graph.root.key, rootNode?.word ?? graph.root.word, rootNode?.record ?? null, 0))
  if (!graph.children.get(graph.root.key)?.length) container.append(h('p', { class: 'cap', text: '这个词条还没有关联词语：在编辑器或词典查询里补充近义词、反义词与词形变化，树会自动生长。' }))
  if (graph.truncated) container.append(h('p', { class: 'cap', text: '关联较多，仅显示前 60 个节点；收起部分分支可以看到其余关联。' }))
  return container
}
