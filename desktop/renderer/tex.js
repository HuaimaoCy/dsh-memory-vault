/**
 * 轻量 TeX 渲染器：把常见书写子集转成 DOM，供查看页与 AI 消息使用。
 *
 * 为什么不用 KaTeX/MathJax：本应用 CSP 是 `default-src 'none'`，且离线环境装包不可靠。
 * 这里覆盖教学里最常出现的写法，未知命令按原名显示（不吞内容、不抛错）。
 *
 * 支持：\frac、\sqrt、x^{...}/x_{...}、希腊字母、常用运算符与关系符、
 * \text{}/\mathrm{}、\, \; \quad 间距、\left( \right)。
 */

const SYMBOLS = {
  pm: '±', mp: '∓', times: '×', div: '÷', cdot: '·', ast: '∗', star: '⋆',
  le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', approx: '≈', equiv: '≡', sim: '∼', propto: '∝',
  infty: '∞', in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆', cup: '∪', cap: '∩', emptyset: '∅',
  sum: '∑', prod: '∏', int: '∫', oint: '∮', partial: '∂', nabla: '∇', forall: '∀', exists: '∃',
  to: '→', rightarrow: '→', leftarrow: '←', leftrightarrow: '↔', Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔', mapsto: '↦',
  cdots: '⋯', ldots: '…', dots: '…', therefore: '∴', because: '∵', angle: '∠', triangle: '△', perp: '⊥', parallel: '∥',
  degree: '°', circ: '∘', prime: '′', hbar: 'ℏ', ell: 'ℓ', Re: 'ℜ', Im: 'ℑ',
}

const GREEK = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ',
  iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ',
  upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
}

const SPACES = { ',': '\u2009', ';': '\u2005', ':': '\u2004', ' ': ' ', quad: '\u2003', qquad: '\u2003\u2003', '!': '' }
const UPRIGHT = new Set(['text', 'mathrm', 'textrm', 'operatorname', 'operatorname*'])
const IGNORED = new Set(['left', 'right', 'big', 'Big', 'bigg', 'Bigg', 'displaystyle', 'textstyle'])

const create = (tag, className, text) => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** 读一个参数：{...} 或单个 token（字符 / \command）。 */
function readArgument(source, index) {
  let at = index
  while (at < source.length && /\s/.test(source[at])) at++
  if (source[at] === '{') {
    let depth = 1
    const start = at + 1
    at++
    while (at < source.length && depth > 0) {
      if (source[at] === '\\') { at += 2; continue }
      if (source[at] === '{') depth++
      else if (source[at] === '}') depth--
      at++
    }
    return { body: source.slice(start, at - 1), next: at }
  }
  if (source[at] === '\\') {
    let end = at + 1
    while (end < source.length && /[A-Za-z]/.test(source[end])) end++
    if (end === at + 1 && end < source.length) end++
    return { body: source.slice(at, end), next: end }
  }
  return { body: source.slice(at, at + 1), next: at + 1 }
}

function parseInto(target, source) {
  let index = 0
  const flushText = text => { if (text) target.append(document.createTextNode(text)) }
  let buffer = ''
  while (index < source.length) {
    const char = source[index]
    if (char === '\\') {
      let end = index + 1
      while (end < source.length && /[A-Za-z]/.test(source[end])) end++
      const name = source.slice(index + 1, end)
      if (end === index + 1) { // 控制符号：\, \; \{ \}
        flushText(buffer); buffer = ''
        const symbol = source[index + 1] ?? ''
        index += 2
        if (symbol === ',') { flushText('\u2009'); continue }
        if (symbol === ';') { flushText('\u2005'); continue }
        if (symbol === '{' || symbol === '}' || symbol === '%' || symbol === '&' || symbol === '#' || symbol === '_') { flushText(symbol); continue }
        if (symbol === '\\') { target.append(create('br')); continue }
        flushText(symbol)
        continue
      }
      index = end
      if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
        flushText(buffer); buffer = ''
        const numerator = readArgument(source, index)
        const denominator = readArgument(source, numerator.next)
        index = denominator.next
        const fraction = create('span', 'mb-tex-frac')
        const top = create('span', 'mb-tex-num'); parseInto(top, numerator.body)
        const bottom = create('span', 'mb-tex-den'); parseInto(bottom, denominator.body)
        fraction.append(top, bottom)
        target.append(fraction)
        continue
      }
      if (name === 'sqrt') {
        flushText(buffer); buffer = ''
        // 可选根指数：\sqrt[3]{x}
        let exponent = ''
        let at = index
        while (at < source.length && /\s/.test(source[at])) at++
        if (source[at] === '[') {
          const close = source.indexOf(']', at)
          if (close > 0) { exponent = source.slice(at + 1, close); at = close + 1 }
        }
        const argument = readArgument(source, at)
        index = argument.next
        const root = create('span', 'mb-tex-sqrt')
        if (exponent) { const sup = create('sup', 'mb-tex-root-index'); sup.textContent = exponent; root.append(sup) }
        root.append(create('span', 'mb-tex-sqrt-sign', '√'))
        const body = create('span', 'mb-tex-sqrt-body'); parseInto(body, argument.body)
        root.append(body)
        target.append(root)
        continue
      }
      if (name === 'text' || name === 'mathrm' || name === 'textrm' || name === 'operatorname' || name === 'mathbf') {
        flushText(buffer); buffer = ''
        const argument = readArgument(source, index)
        index = argument.next
        const upright = create('span', name === 'mathbf' ? 'mb-tex-bold' : 'mb-tex-text')
        upright.textContent = argument.body
        target.append(upright)
        continue
      }
      if (IGNORED.has(name)) { continue }
      if (SPACES[name] !== undefined) { flushText(buffer); buffer = ''; flushText(SPACES[name]); continue }
      flushText(buffer); buffer = ''
      if (GREEK[name]) { flushText(GREEK[name]); continue }
      if (SYMBOLS[name]) {
        // \sum_{i=1}^{n} 之类：符号后跟上下标交给通用逻辑处理
        flushText(SYMBOLS[name])
        continue
      }
      // 未知命令：保留名字，不吞掉后续内容
      flushText(name)
      continue
    }
    if (char === '^' || char === '_') {
      flushText(buffer); buffer = ''
      const argument = readArgument(source, index + 1)
      index = argument.next
      const script = create(char === '^' ? 'sup' : 'sub', char === '^' ? 'mb-tex-sup' : 'mb-tex-sub')
      parseInto(script, argument.body)
      target.append(script)
      continue
    }
    if (char === '{' || char === '}') { index++; continue }
    if (char === '~') { flushText(buffer); buffer = ''; flushText('\u00a0'); index++; continue }
    buffer += char
    index++
  }
  flushText(buffer)
}

/**
 * 渲染一段 TeX。
 * @param {string} source - 不含定界符的公式正文。
 * @param {{display?: boolean}} [options] - display 为块级（居中、可滚动）。
 * @returns {HTMLElement}
 */
export function renderTex(source, { display = false } = {}) {
  const root = create('span', display ? 'mb-tex mb-tex-display' : 'mb-tex')
  root.setAttribute('role', 'math')
  root.setAttribute('aria-label', String(source ?? ''))
  parseInto(root, String(source ?? ''))
  return root
}
