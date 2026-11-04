/**
 * 轻量 TeX 渲染器：把常见书写子集转成 DOM，供查看页、AI 消息与 PDF 导出使用。
 *
 * 为什么不用 KaTeX/MathJax：本应用 CSP 是 `default-src 'none'`，且离线环境装包不可靠。
 * 这里覆盖教学里最常出现的写法，未知命令按原名显示（不吞内容、不抛错）。
 *
 * 支持：\frac、\sqrt、x^{...}/x_{...}、希腊字母、常用运算符与关系符、
 * \text{}/\mathrm{}/函数名、\, \; \quad 间距、\left( \right)、
 * 以及 cases / aligned / array / matrix 等环境（& 分列、\\ 换行、自动配括号）。
 */

const SYMBOLS = {
  pm: '±', mp: '∓', times: '×', div: '÷', cdot: '·', ast: '∗', star: '⋆',
  le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', approx: '≈', equiv: '≡', sim: '∼', propto: '∝',
  cong: '≅', asymp: '≍', ll: '≪', gg: '≫', leqslant: '⩽', geqslant: '⩾',
  infty: '∞', in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇',
  cup: '∪', cap: '∩', emptyset: '∅', varnothing: '∅', setminus: '∖',
  sum: '∑', prod: '∏', int: '∫', iint: '∬', oint: '∮', partial: '∂', nabla: '∇', forall: '∀', exists: '∃',
  to: '→', rightarrow: '→', leftarrow: '←', leftrightarrow: '↔', Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔', mapsto: '↦',
  cdots: '⋯', ldots: '…', dots: '…', therefore: '∴', because: '∵', angle: '∠', triangle: '△', perp: '⊥', parallel: '∥',
  degree: '°', circ: '∘', prime: '′', hbar: 'ℏ', ell: 'ℓ', Re: 'ℜ', Im: 'ℑ', wp: '℘', aleph: 'ℵ',
  square: '□', blacksquare: '■', checkmark: '✓', neg: '¬', land: '∧', lor: '∨', wedge: '∧', vee: '∨',
  oplus: '⊕', otimes: '⊗', odot: '⊙', dagger: '†', ddagger: '‡', S: '§', paragraph: '¶',
}

const GREEK = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ',
  iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ',
  upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
}

const SPACES = { ',': '\u2009', ';': '\u2005', ':': '\u2004', '!': '', ' ': ' ', quad: '\u2003', qquad: '\u2003\u2003' }
const IGNORED = new Set(['displaystyle', 'textstyle', 'scriptstyle', 'scriptscriptstyle', 'limits', 'nolimits',
  'big', 'Big', 'bigg', 'Bigg', 'bigl', 'bigr', 'Bigl', 'Bigr', 'middle', 'hline', 'hdashline', 'cline'])
const UPRIGHT = new Set(['text', 'textrm', 'textnormal', 'mbox', 'mathrm', 'operatorname', 'operatorname*', 'operatornamewithlimits'])
const FUNCTIONS = new Set(['sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh',
  'log', 'ln', 'lg', 'exp', 'lim', 'sup', 'inf', 'max', 'min', 'det', 'gcd', 'lcm', 'deg', 'dim', 'ker', 'hom', 'arg', 'Pr'])
const BLACKBOARD = { R: 'ℝ', N: 'ℕ', Z: 'ℤ', Q: 'ℚ', C: 'ℂ', P: 'ℙ', H: 'ℍ' }
const ACCENTS = { hat: '\u0302', widehat: '\u0302', bar: '\u0304', vec: '\u20d7', tilde: '\u0303', widetilde: '\u0303', dot: '\u0307', ddot: '\u0308', acute: '\u0301', grave: '\u0300', check: '\u030c', breve: '\u0306' }

const ENVIRONMENT_DELIMITERS = {
  cases: { open: 'brace' }, dcases: { open: 'brace' }, rcases: { open: 'brace' },
  matrix: {}, smallmatrix: {}, array: {}, aligned: {}, align: {}, gather: {}, gathered: {}, split: {}, eqnarray: {},
  pmatrix: { open: 'paren', close: 'paren' }, bmatrix: { open: 'bracket', close: 'bracket' },
  Bmatrix: { open: 'brace', close: 'brace' }, vmatrix: { open: 'bar', close: 'bar' },
  Vmatrix: { open: 'doublebar', close: 'doublebar' },
}

const create = (tag, className, text) => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/**
 * 可伸缩定界符：用 CSS 边框画弧，天然随内容高度拉伸，不需要测量或写死尺寸。
 * 开放/闭合只差边框所在的一侧，因此同一元素加不同类名即可。
 */
function delimiterSpan(kind, { flip = false } = {}) {
  const span = create('span', `mb-tex-delim mb-tex-delim-${kind} ${flip ? 'mb-tex-delim-close' : 'mb-tex-delim-open'}`)
  span.setAttribute('aria-hidden', 'true')
  return span
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
    return { body: source.slice(start, Math.max(start, at - 1)), next: at }
  }
  if (source[at] === '\\') {
    let end = at + 1
    while (end < source.length && /[A-Za-z]/.test(source[end])) end++
    if (end === at + 1 && end < source.length) end++
    return { body: source.slice(at, end), next: end }
  }
  return { body: source.slice(at, at + 1), next: at + 1 }
}

/** 把 \text{} 里的转义还原成普通字符。 */
function plainText(body) {
  return String(body ?? '')
    .replace(/\\([{}%&_$#])/g, '$1')
    .replace(/\\textbackslash\b/g, '\\')
    .replace(/\\,/g, '\u2009').replace(/\\;/g, '\u2005')
    .replace(/~/g, '\u00a0')
}

/** 找到与 \begin{name} 匹配的 \end{name}，返回环境体与结束后的位置。 */
function matchEnvironment(source, startIndex, name) {
  let depth = 1
  let at = startIndex
  while (at < source.length) {
    const backslash = source.indexOf('\\', at)
    if (backslash < 0) break
    const match = /^\\(begin|end)\s*\{([^{}]*)\}/.exec(source.slice(backslash))
    if (!match) { at = backslash + 2; continue }
    if (match[1] === 'begin') depth++
    else {
      depth--
      if (depth === 0) return { body: source.slice(startIndex, backslash), next: backslash + match[0].length }
    }
    at = backslash + match[0].length
  }
  return { body: source.slice(startIndex), next: source.length }
}

/** 环境体内按 &（分列）与 \\（换行）切分，忽略花括号与嵌套环境里的分隔符。 */
function splitEnvironment(body) {
  const rows = []
  let cells = []
  let buffer = ''
  let depth = 0
  let at = 0
  const flushRow = () => { cells.push(buffer); buffer = ''; rows.push(cells); cells = [] }
  while (at < body.length) {
    const char = body[at]
    if (char === '\\') {
      if (body[at + 1] === '\\' && depth === 0) {
        flushRow()
        at += 2
        const spacing = /^\s*\[[^\]]*\]/.exec(body.slice(at))
        if (spacing) at += spacing[0].length
        continue
      }
      if (/^\\begin\b/.test(body.slice(at))) {
        const braced = /^\s*\{([^{}]*)\}/.exec(body.slice(at + 6))
        if (braced) {
          const inner = matchEnvironment(body, at + 6 + braced[0].length, braced[1])
          buffer += body.slice(at, inner.next)
          at = inner.next
          continue
        }
      }
      buffer += body.slice(at, at + 2)
      at += 2
      continue
    }
    if (char === '{') depth++
    else if (char === '}') depth = Math.max(0, depth - 1)
    else if (char === '&' && depth === 0) { cells.push(buffer); buffer = ''; at++; continue }
    buffer += char
    at++
  }
  cells.push(buffer)
  if (cells.length > 1 || String(cells[0] ?? '').trim()) rows.push(cells)
  return rows.length ? rows : [['']]
}

/** 读 \left / \right 后的定界符。 */
function readDelimiter(source, index) {
  let at = index
  while (at < source.length && /\s/.test(source[at])) at++
  const char = source[at]
  if (char === '\\') {
    const symbol = /^\\([{}|])/.exec(source.slice(at))
    if (symbol) return { kind: symbol[1] === '|' ? 'bar' : 'brace', next: at + 2 }
    const word = /^\\([A-Za-z]+)/.exec(source.slice(at))
    if (word) {
      const map = { langle: 'angle', rangle: 'angle', vert: 'bar', Vert: 'doublebar', lbrace: 'brace', rbrace: 'brace', lbrack: 'bracket', rbrack: 'bracket' }
      return { kind: map[word[1]] ?? null, next: at + word[0].length }
    }
    return { kind: null, next: at + 2 }
  }
  if (char === '(' || char === ')') return { kind: 'paren', next: at + 1 }
  if (char === '[' || char === ']') return { kind: 'bracket', next: at + 1 }
  if (char === '|') return { kind: 'bar', next: at + 1 }
  if (char === '{' || char === '}') return { kind: 'brace', next: at + 1 }
  return { kind: null, next: at + 1 }
}

/** 环境 → 网格结构；cases 自带左花括号，matrix 系列自动配括号。 */
function buildEnvironment(name, body, display) {
  const rows = splitEnvironment(body)
  const columns = Math.max(1, ...rows.map(row => row.length))
  const wrapper = create('span', 'mb-tex-env')
  const delimiters = ENVIRONMENT_DELIMITERS[name] ?? {}
  if (delimiters.open) wrapper.append(delimiterSpan(delimiters.open))
  const grid = create('span', 'mb-tex-env-body')
  grid.classList.add(`mb-tex-env-${name.replace(/[^A-Za-z]/g, '') || 'plain'}`)
  if (/matrix$/.test(name)) grid.classList.add('mb-tex-matrix')
  if (/^(aligned|align|gathered|gather|split|eqnarray)$/.test(name)) grid.classList.add('mb-tex-aligned')
  if (/cases$/.test(name)) grid.classList.add('mb-tex-cases')
  grid.style.gridTemplateColumns = `repeat(${columns}, auto)`
  if (display) wrapper.classList.add('mb-tex-env-display')
  rows.forEach(rowCells => {
    const row = create('span', 'mb-tex-env-row')
    for (let column = 0; column < columns; column++) {
      const cell = create('span', 'mb-tex-env-cell')
      parseInto(cell, rowCells[column] ?? '', display)
      row.append(cell)
    }
    grid.append(row)
  })
  wrapper.append(grid)
  if (delimiters.close) wrapper.append(delimiterSpan(delimiters.close, { flip: true }))
  return wrapper
}

function parseInto(target, source, display = false) {
  let index = 0
  let current = target
  const delimiterStack = []
  let buffer = ''
  const flush = () => {
    if (buffer) { current.append(document.createTextNode(buffer)); buffer = '' }
  }
  while (index < source.length) {
    const char = source[index]
    if (char === '\\') {
      let end = index + 1
      while (end < source.length && /[A-Za-z]/.test(source[end])) end++
      if (end === index + 1) { // 控制符号：\, \; \{ \} \\ 等
        flush()
        const symbol = source[index + 1] ?? ''
        index += 2
        if (symbol === ',' || symbol === ';' || symbol === ':') { current.append(document.createTextNode(SPACES[symbol] ?? ' ')); continue }
        if (symbol === '!') continue
        if ('{}%&_$#'.includes(symbol)) { current.append(document.createTextNode(symbol)); continue }
        if (symbol === '\\') { current.append(create('br')); continue }
        if (symbol === ' ') { current.append(document.createTextNode(' ')); continue }
        current.append(document.createTextNode(symbol))
        continue
      }
      let name = source.slice(index + 1, end)
      index = end
      if (source[index] === '*') { name += '*'; index++ }

      if (name === 'begin') {
        flush()
        const argument = readArgument(source, index)
        index = argument.next
        const environment = argument.body.trim()
        const matched = matchEnvironment(source, index, environment)
        index = matched.next
        let environmentBody = matched.body
        if ((environment === 'array' || environment === 'tabular') && /^\s*\{/.test(environmentBody)) {
          environmentBody = environmentBody.slice(readArgument(environmentBody, 0).next)
        }
        current.append(buildEnvironment(environment, environmentBody, display))
        continue
      }
      if (name === 'end') {
        flush()
        const argument = readArgument(source, index)
        index = argument.next
        continue
      }
      if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
        flush()
        const numerator = readArgument(source, index)
        const denominator = readArgument(source, numerator.next)
        index = denominator.next
        const fraction = create('span', 'mb-tex-frac')
        const top = create('span', 'mb-tex-num')
        const bottom = create('span', 'mb-tex-den')
        parseInto(top, numerator.body)
        parseInto(bottom, denominator.body)
        fraction.append(top, bottom)
        current.append(fraction)
        continue
      }
      if (name === 'binom' || name === 'dbinom' || name === 'tbinom') {
        flush()
        const top = readArgument(source, index)
        const bottom = readArgument(source, top.next)
        index = bottom.next
        const wrapper = create('span', 'mb-tex-delim-group')
        wrapper.append(delimiterSpan('paren'))
        const stack = create('span', 'mb-tex-frac mb-tex-stack')
        const upper = create('span', 'mb-tex-num mb-tex-stack-top')
        const lower = create('span', 'mb-tex-den mb-tex-stack-bottom')
        parseInto(upper, top.body)
        parseInto(lower, bottom.body)
        stack.append(upper, lower)
        wrapper.append(stack, delimiterSpan('paren', { flip: true }))
        current.append(wrapper)
        continue
      }
      if (name === 'sqrt') {
        flush()
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
        const body = create('span', 'mb-tex-sqrt-body')
        parseInto(body, argument.body)
        root.append(body)
        current.append(root)
        continue
      }
      if (name === 'overline' || name === 'underline' || name === 'boxed') {
        flush()
        const argument = readArgument(source, index)
        index = argument.next
        const wrapper = create('span', name === 'boxed' ? 'mb-tex-boxed' : name === 'overline' ? 'mb-tex-overline' : 'mb-tex-underline')
        parseInto(wrapper, argument.body)
        current.append(wrapper)
        continue
      }
      if (Object.hasOwn(ACCENTS, name)) {
        flush()
        const argument = readArgument(source, index)
        index = argument.next
        const accent = create('span', 'mb-tex-accent')
        parseInto(accent, argument.body)
        accent.append(document.createTextNode(ACCENTS[name]))
        current.append(accent)
        continue
      }
      if (name === 'left' || name === 'right') {
        flush()
        const delimiter = readDelimiter(source, index)
        index = delimiter.next
        if (name === 'left') {
          const group = create('span', 'mb-tex-delim-group')
          const body = create('span', 'mb-tex-delim-body')
          if (delimiter.kind) group.append(delimiterSpan(delimiter.kind))
          group.append(body)
          current.append(group)
          delimiterStack.push({ group, body, parent: current })
          current = body
        } else {
          const frame = delimiterStack.pop()
          if (frame) {
            if (delimiter.kind) frame.group.append(delimiterSpan(delimiter.kind, { flip: true }))
            current = frame.parent
          }
        }
        continue
      }
      if (UPRIGHT.has(name)) {
        flush()
        const argument = readArgument(source, index)
        index = argument.next
        current.append(create('span', 'mb-tex-text', plainText(argument.body)))
        continue
      }
      if (name === 'mathbb') {
        flush()
        const argument = readArgument(source, index)
        index = argument.next
        const letters = String(argument.body).split('').map(letter => BLACKBOARD[letter] ?? letter).join('')
        current.append(create('span', 'mb-tex-text mb-tex-blackboard', letters))
        continue
      }
      if (name === 'mathbf') {
        flush()
        const argument = readArgument(source, index)
        index = argument.next
        current.append(create('span', 'mb-tex-text mb-tex-bold', plainText(argument.body)))
        continue
      }
      if (name === 'boldsymbol' || name === 'bm') {
        flush()
        const argument = readArgument(source, index)
        index = argument.next
        const span = create('span', 'mb-tex-bold')
        parseInto(span, argument.body)
        current.append(span)
        continue
      }
      if (name === 'mathcal' || name === 'mathscr') {
        flush()
        const argument = readArgument(source, index)
        index = argument.next
        current.append(create('span', 'mb-tex-calligraphic', plainText(argument.body)))
        continue
      }
      if (FUNCTIONS.has(name)) {
        flush()
        current.append(create('span', 'mb-tex-text', name))
        current.append(document.createTextNode('\u2009'))
        continue
      }
      if (IGNORED.has(name)) continue
      if (SPACES[name] !== undefined) { flush(); current.append(document.createTextNode(SPACES[name])); continue }
      flush()
      if (GREEK[name]) { current.append(document.createTextNode(GREEK[name])); continue }
      if (SYMBOLS[name]) { current.append(document.createTextNode(SYMBOLS[name])); continue }
      // 未知命令：保留名字，不吞掉后续内容
      current.append(document.createTextNode(name))
      continue
    }
    if (char === '^' || char === '_') {
      flush()
      const argument = readArgument(source, index + 1)
      index = argument.next
      const script = create(char === '^' ? 'sup' : 'sub', char === '^' ? 'mb-tex-sup' : 'mb-tex-sub')
      parseInto(script, argument.body)
      current.append(script)
      continue
    }
    if (char === '{' || char === '}') { index++; continue }
    if (char === '~') { flush(); current.append(document.createTextNode('\u00a0')); index++; continue }
    buffer += char
    index++
  }
  flush()
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
  parseInto(root, String(source ?? ''), display)
  return root
}
