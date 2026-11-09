import { A4_SIZE, edgeGeometry } from './canvas.mjs'
import { inkSVGAttributes } from './canvas-ink.mjs'
import { CANVAS_QUESTION_HEADER, canvasQuestionContent, canvasQuestionImageURI } from './canvas-question.mjs'
import { shapeParts } from './canvas-shapes.mjs'
import { escapeHTML } from './print-layout.mjs'

const attrs = values => Object.entries(values).map(([key, value]) => `${key}="${value}"`).join(' ')

export function cardOnPaper(card, { x, y }) {
  return card.x < x + A4_SIZE.w && card.x + card.w > x && card.y < y + A4_SIZE.h && card.y + card.h > y
}

function printQuestion(card, record) {
  const { title, sections } = canvasQuestionContent(card, record)
  const content = sections.map(section => {
    const body = section.images
      ? section.images.map(image => {
        const src = canvasQuestionImageURI(image)
        if (!src) return ''
        const name = escapeHTML(image.name || '')
        const caption = name ? `<figcaption>${name}</figcaption>` : ''
        return `<figure class="mb-canvas-question-figure"><img alt="${name || '题图'}" src="${src}"
          width="${Number(image.width) || 0}" height="${Number(image.height) || 0}">${caption}</figure>`
      }).join('')
      : `<div class="question-text">${escapeHTML(section.text)}</div>`
    return `<section class="mb-canvas-question-section"><h4 class="mb-canvas-question-label">${escapeHTML(section.label)}</h4>${body}</section>`
  }).join('')
  const x = card.question?.scrollLeft ?? 0, y = card.question?.scrollTop ?? 0
  return `<header>错题</header><div class="mb-canvas-question-viewport" data-x="${x}" data-y="${y}">
    <div class="mb-canvas-question-content"><h3 class="mb-canvas-question-title">${escapeHTML(title)}</h3>${content}</div></div>`
}

function printCard(card, sheet, questions) {
  const style = `left:${card.x - sheet.x}px;top:${card.y - sheet.y}px;width:${card.w}px;height:${card.h}px`
  if (card.kind === 'image') {
    const src = canvasQuestionImageURI(card.image)
    return `<article class="image" style="${style}"><img src="${src}" alt="${escapeHTML(card.image.name)}"></article>`
  }
  if (card.kind === 'reference' && card.noteType === 'mistake') {
    return `<article class="reference question" style="${style}">${printQuestion(card, questions.get(card.noteId))}</article>`
  }
  const title = card.kind === 'reference' ? `<strong>${escapeHTML(card.noteTitle || '未命名笔记')}</strong>` : ''
  const tone = card.kind === 'sticky' ? ` tone-${card.tone}` : ''
  return `<article class="${card.kind}${tone}" style="${style}">${title}${escapeHTML(card.text)}</article>`
}

/** Render the sheets in document order, or one explicitly selected sheet for image export. */
export function canvasPrintHTML(canvas, { sheetId, imageSize, questions = new Map(), rich } = {}) {
  const sheets = sheetId === undefined ? canvas.paper.sheets : canvas.paper.sheets.filter(sheet => sheet.id === sheetId)
  if (!sheets.length) throw new Error('A4 纸张不存在')
  const { w, h } = A4_SIZE
  const printScaleX = 210 * 96 / 25.4 / w, printScaleY = 297 * 96 / 25.4 / h
  const pageWidth = imageSize ? `${imageSize.w}px` : '210mm'
  const pageHeight = imageSize ? `${imageSize.h}px` : '297mm'
  const scaleX = imageSize ? imageSize.w / w : printScaleX
  const scaleY = imageSize ? imageSize.h / h : printScaleY
  const edges = canvas.edges.map(edge => {
    const line = edgeGeometry(canvas, edge)
    return line ? `<line x1="${line.x1}" y1="${line.y1}" x2="${line.x2}" y2="${line.y2}"/>` : ''
  }).join('')
  const cards = [...canvas.cards].sort((a, b) => a.z - b.z)
  const ink = canvas.ink.map(stroke => `<path ${attrs(inkSVGAttributes(stroke))}/>`).join('')
  const shapes = canvas.shapes.map(shape => {
    const parts = shapeParts(shape).map(([tag, values]) => `<${tag} ${attrs(values)}/>`).join('')
    return `<g fill="none" stroke="${shape.color}" stroke-width="${shape.width}" stroke-linecap="round" stroke-linejoin="round">${parts}</g>`
  }).join('')
  const pages = sheets.map(sheet => {
    const viewBox = `${sheet.x} ${sheet.y} ${w} ${h}`
    const articles = cards.filter(card => cardOnPaper(card, sheet)).map(card => printCard(card, sheet, questions)).join('')
    return `<main class="page" data-sheet-id="${sheet.id}"><div class="sheet">
      <svg class="vector" viewBox="${viewBox}"><use href="#edges"/></svg>${articles}
      <svg class="vector" viewBox="${viewBox}"><use href="#marks"/></svg></div></main>`
  }).join('')
  // Only the packaged renderer can execute. Question text is always escaped before being parsed.
  const trustedScript = rich ? `; script-src 'nonce-${rich.nonce}' 'strict-dynamic'` : ''
  const richMarkup = rich ? `${rich.styles.map(style => `<link rel="stylesheet" href="${escapeHTML(style)}">`).join('')}
    <script type="module" nonce="${rich.nonce}">
      import { renderRich } from ${JSON.stringify(rich.markdown).replaceAll('<', '\\u003c')};
      for (const node of document.querySelectorAll('.question-text')) node.replaceChildren(renderRich(node.textContent));
      for (const viewport of document.querySelectorAll('.mb-canvas-question-viewport')) {
        const x = Math.min(Number(viewport.dataset.x), viewport.scrollWidth - viewport.clientWidth);
        const y = Math.min(Number(viewport.dataset.y), viewport.scrollHeight - viewport.clientHeight);
        viewport.firstElementChild.style.transform = 'translate(' + -x + 'px,' + -y + 'px)';
      }
    </script>` : ''
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self' 'unsafe-inline'; img-src data:${trustedScript}">
    <title>${escapeHTML(canvas.title)}</title>${richMarkup}<style>
    @page { size:A4; margin:0 }
    * { box-sizing:border-box }
    html, body { margin:0; padding:0; background:#fff }
    body { width:${pageWidth}; print-color-adjust:exact;
      font:13px/1.55 "MiSans","Microsoft YaHei UI",sans-serif; color:#252e34 }
    .page { position:relative; width:${pageWidth}; height:${pageHeight}; overflow:hidden; break-after:page }
    .page:last-child { break-after:auto }
    .sheet { position:absolute; inset:0 auto auto 0; width:${w}px; height:${h}px; overflow:hidden;
      transform:scale(${scaleX},${scaleY}); transform-origin:top left }
    .definitions { position:absolute; width:0; height:0; overflow:hidden }
    .vector { position:absolute; inset:0; width:100%; height:100% }
    article { position:absolute; overflow:hidden; white-space:pre-wrap; overflow-wrap:anywhere; padding:9px 11px }
    article.reference:not(.question) > strong { display:block; margin-bottom:5px }
    .text { padding:4px 3px; font-size:16px }
    .image { padding:0 }
    .image img { display:block; width:100%; height:100%; object-fit:contain }
    .reference { border:1px solid #e3e6dc; border-radius:12px; background:#f6f6f8 }
    .sticky { border-radius:12px; background:#fdf6e3 }
    .tone-mint { background:#e9f3ec } .tone-sky { background:#e8f0f7 } .tone-rose { background:#fbeceb }
    .question { padding:0; white-space:normal }
    .question header { height:${CANVAS_QUESTION_HEADER}px; padding:0 12px; display:flex; align-items:center;
      border-bottom:1px solid #e3e6dc; font-size:11px; font-weight:600; color:#58606b }
    .question .mb-canvas-question-viewport { position:absolute; inset:${CANVAS_QUESTION_HEADER}px 0 0; overflow:hidden }
    .question-text { white-space:pre-wrap }
    .question-text:has(.mb-md) { white-space:normal }
    </style></head><body><svg class="definitions" width="0" height="0" aria-hidden="true"><defs>
    <g id="edges" stroke="#adbcb5" stroke-width="2">${edges}</g><g id="marks">${shapes}${ink}</g>
    </defs></svg>${pages}</body></html>`
}
