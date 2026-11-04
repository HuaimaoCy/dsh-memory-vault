import { renderTex } from './tex.js'
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
// 粗体/斜体内部要递归走一遍行内规则，否则 **答案：$(-\infty,6)$** 这类写法会把公式原样漏出来。
const inline = text => {
  const nodes = []
  let buffer = ''
  let index = 0
  const flush = () => { if (buffer) { nodes.push(buffer); buffer = '' } }
  while (index < text.length) {
    const char = text[index]
    if (char === '\\' && '$*`\\'.includes(text[index + 1] ?? '')) {
      buffer += text[index + 1]
      index += 2
      continue
    }
    if (char === '`') {
      const close = text.indexOf('`', index + 1)
      if (close > index + 1) {
        flush()
        nodes.push(h('code', { class: 'mb-code-inline', text: text.slice(index + 1, close) }))
        index = close + 1
        continue
      }
    }
    if (char === '$') {
      if (text[index + 1] === '$') {
        const close = text.indexOf('$$', index + 2)
        if (close > index + 2) {
          flush()
          nodes.push(renderTex(text.slice(index + 2, close), { display: true }))
          index = close + 2
          continue
        }
      }
      const close = text.indexOf('$', index + 1)
      if (close > index + 1) {
        const body = text.slice(index + 1, close)
        if (!body.includes('\n')) {
          flush()
          nodes.push(renderTex(body))
          index = close + 1
          continue
        }
      }
    }
    if (char === '*') {
      if (text[index + 1] === '*') {
        const close = text.indexOf('**', index + 2)
        if (close > index + 2) {
          flush()
          nodes.push(h('strong', {}, ...inline(text.slice(index + 2, close))))
          index = close + 2
          continue
        }
      }
      const close = text.indexOf('*', index + 1)
      if (close > index + 1) {
        flush()
        nodes.push(h('em', {}, ...inline(text.slice(index + 1, close))))
        index = close + 1
        continue
      }
    }
    buffer += char
    index++
  }
  flush()
  return nodes
}
const inlineRow = text => h('span', {}, inline(text))
export function renderRich(source) {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n')
  const root = h('div', { class: 'mb-md' })
  let list = null, table = null, paragraph = []
  const flushParagraph = () => {
    if (!paragraph.length) return
    const children = []
    paragraph.forEach((line, at) => { if (at) children.push(h('br')); children.push(...inline(line)) })
    root.append(h('p', {}, ...children))
    paragraph = []
  }
  const flushAll = () => { flushParagraph(); if (list) { root.append(list); list = null } if (table) { root.append(table); table = null } }
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const heading = line.match(/^(#{1,4})\s+(.*)$/)
    if (heading) { flushAll(); root.append(h(`h${heading[1].length + 2}`, { class: 'mb-md-h' }, ...inline(heading[2].trim()))); continue }
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
      while (!/\$\$\s*$/.test(formula[formula.length - 1]) && index + 1 < lines.length) formula.push(lines[++index])
      formula[formula.length - 1] = formula[formula.length - 1].replace(/\$\$\s*$/, '')
      root.append(h('div', { class: 'mb-math-block' }, renderTex(formula.join('\n').trim(), { display: true })))
      continue
    }
    if (/^\s*[-*+]\s+/.test(line)) { flushParagraph(); if (table) { root.append(table); table = null } if (!list || list.tagName !== 'UL') { if (list) root.append(list); list = h('ul', { class: 'mb-md-list' }) } list.append(h('li', {}, ...inline(line.replace(/^\s*[-*+]\s+/, '')))); continue }
    if (/^\s*\d+[.、)]\s+/.test(line)) { flushParagraph(); if (table) { root.append(table); table = null } if (!list || list.tagName !== 'OL') { if (list) root.append(list); list = h('ol', { class: 'mb-md-list' }) } list.append(h('li', {}, ...inline(line.replace(/^\s*\d+[.、)]\s+/, '')))); continue }
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
