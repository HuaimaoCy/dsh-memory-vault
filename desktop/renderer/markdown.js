// 轻量 Markdown + LaTeX 渲染器（无外部依赖，CSP 安全：全部转义后生成 DOM）。
// 支持：标题/粗斜体/行内代码/代码块/有序无序列表/引用/分隔线/表格/
// $$...$$ 块级公式（居中衬线）与 $...$ 行内公式（衬线斜体近似排版）。
const h = (tag, props = {}, ...children) => {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = value
    else node.setAttribute(key, String(value))
  }
  for (const item of children.flat(Infinity)) if (item !== null && item !== undefined && item !== false) node.append(item instanceof Node ? item : String(item))
  return node
}
// 行内：$..$ 公式、`code`、**粗**、*斜*。文本已转义由外层保证：这里接收纯文本片段。
const inline = text => {
  const nodes = []
  const pattern = /(\$[^$\n]+\$)|(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)/g
  let last = 0, match
  while ((match = pattern.exec(text))) {
    if (match.index > last) nodes.push(text.slice(last, match.index))
    const token = match[0]
    if (token.startsWith('$')) nodes.push(h('span', { class: 'mb-math', text: token.slice(1, -1) }))
    else if (token.startsWith('`')) nodes.push(h('code', { class: 'mb-code-inline', text: token.slice(1, -1) }))
    else if (token.startsWith('**')) nodes.push(h('strong', { text: token.slice(2, -2) }))
    else nodes.push(h('em', { text: token.slice(1, -1) }))
    last = match.index + token.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}
const inlineRow = text => h('span', {}, inline(text))
export function renderRich(source) {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n')
  const root = h('div', { class: 'mb-md' })
  let list = null, table = null, paragraph = []
  const flushParagraph = () => { if (paragraph.length) { root.append(h('p', {}, ...paragraph.flatMap(line => [...inline(line), h('br')]))) ; paragraph = [] } }
  const flushAll = () => { flushParagraph(); if (list) { root.append(list); list = null } if (table) { root.append(table); table = null } }
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const heading = line.match(/^(#{1,4})\s+(.*)$/)
    if (heading) { flushAll(); root.append(h(`h${heading[1].length + 2}`, { class: 'mb-md-h', text: heading[2] })); continue }
    if (/^\s*```/.test(line)) {
      flushAll()
      const code = []
      index++
      while (index < lines.length && !/^\s*```/.test(lines[index])) code.push(lines[index++])
      root.append(h('pre', { class: 'mb-code-block' }, h('code', { text: code.join('\n') })))
      continue
    }
    if (/^\s*\$\$/.test(line)) {
      flushAll()
      const formula = [line.replace(/^\s*\$\$/, '')]
      if (!/\$\$\s*$/.test(line)) while (index + 1 < lines.length && !/\$\$\s*$/.test(lines[index + 1])) formula.push(lines[++index])
      formula[index] = formula[formula.length - 1].replace(/\$\$\s*$/, '')
      root.append(h('div', { class: 'mb-math-block', text: formula.join('\n').replace(/\$\$\s*$/g, '').trim() }))
      continue
    }
    if (/^\s*[-*+]\s+/.test(line)) { flushParagraph(); if (table) { root.append(table); table = null } if (!list || list.tagName !== 'UL') { if (list) root.append(list); list = h('ul', { class: 'mb-md-list' }) } list.append(h('li', {}, inline(line.replace(/^\s*[-*+]\s+/, '')))); continue }
    if (/^\s*\d+[.、)]\s+/.test(line)) { flushParagraph(); if (table) { root.append(table); table = null } if (!list || list.tagName !== 'OL') { if (list) root.append(list); list = h('ol', { class: 'mb-md-list' }) } list.append(h('li', {}, inline(line.replace(/^\s*\d+[.、)]\s+/, '')))); continue }
    if (/^\s*>/.test(line)) { flushAll(); root.append(h('blockquote', { class: 'mb-md-quote' }, inlineRow(line.replace(/^\s*>\s?/, '')))); continue }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushParagraph(); if (list) { root.append(list); list = null }
      const cells = line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim())
      if (cells.every(cell => /^:?-{2,}:?$/.test(cell))) continue // 分隔行
      if (!table) table = h('table', { class: 'mb-md-table' })
      const row = h('tr', {}, cells.map(cell => h(table.lastElementChild ? 'td' : 'th', {}, inlineRow(cell))))
      table.append(row)
      continue
    }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) { flushAll(); root.append(h('hr', { class: 'mb-md-hr' })); continue }
    if (!line.trim()) { flushAll(); continue }
    paragraph.push(line)
  }
  flushAll()
  return root
}
