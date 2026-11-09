import {
  CANVAS_QUESTION_FIELDS, CANVAS_QUESTION_SECTIONS,
  canvasQuestionContent, canvasQuestionImageURI, normalizeCanvasQuestion,
} from '../../addons/mistakebook/canvas-question.mjs'

export function createCanvasQuestion({ h, icon, dialog, renderRich, readQuestion, openOriginal, update, notify, isCurrent }) {
  const cache = new Map()
  const waiting = new Map()
  const views = new Map()
  const previousScroll = new Map()
  const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      const load = waiting.get(entry.target)
      observer.unobserve(entry.target)
      waiting.delete(entry.target)
      load?.()
    }
  }, { rootMargin: '160px' }) : null

  function read(card) {
    if (!card.noteId) return Promise.resolve(null)
    const id = card.noteId
    const previous = cache.get(id)
    cache.delete(id)
    const request = previous ?? Promise.resolve().then(() => readQuestion(id)).catch(() => {
      if (cache.get(id) === request) cache.delete(id)
      return null
    })
    cache.set(id, request)
    if (cache.size > 6) cache.delete(cache.keys().next().value)
    return request
  }

  function render(card) {
    const viewport = h('div', {
      class: 'mb-canvas-question-viewport', tabindex: '0', role: 'region', 'aria-label': '题目内容',
    }, h('p', { class: 'mb-canvas-question-hint', text: '正在读取题目…' }))
    const question = normalizeCanvasQuestion(card.question)
    const key = JSON.stringify(question)
    const previous = previousScroll.get(card.id)
    previousScroll.delete(card.id)
    const offset = previous?.key === key ? previous : question
    const view = { viewport, key, offset, ready: false }
    views.set(card.id, view)
    const load = async () => {
      const record = await read(card)
      if (!viewport.isConnected || !isCurrent(card)) return
      const content = canvasQuestionContent(card, record)
      const title = h('h3', { class: 'mb-canvas-question-title', text: content.title })
      viewport.setAttribute('aria-label', content.title)
      viewport.replaceChildren(h('div', { class: 'mb-canvas-question-content' }, title,
        content.sections.map(section => h('section', { class: 'mb-canvas-question-section' },
          h('h4', { class: 'mb-canvas-question-label', text: section.label }),
          section.id === 'images' ? section.images.map(image => h('figure', { class: 'mb-canvas-question-figure' },
            h('img', {
              src: canvasQuestionImageURI(image), alt: image.name || '题图',
              width: image.width, height: image.height, loading: 'lazy', decoding: 'async', draggable: 'false',
            }),
            image.name ? h('figcaption', { text: image.name }) : null,
          )) : renderRich(section.text))),
        record ? null : h('p', { class: 'mb-canvas-question-hint', text: '原题暂不可用，正在显示画布保留的内容。' }),
      ))
      viewport.scrollTop = offset.scrollTop
      viewport.scrollLeft = offset.scrollLeft
      view.ready = true
    }
    if (observer) {
      waiting.set(viewport, load)
      observer.observe(viewport)
    } else void load()
    return viewport
  }

  function beginRender() {
    observer?.disconnect()
    waiting.clear()
    previousScroll.clear()
    for (const [id, { viewport, key, offset, ready }] of views) {
      const { scrollTop, scrollLeft } = ready ? viewport : offset
      previousScroll.set(id, { key, scrollTop, scrollLeft })
    }
    views.clear()
  }

  function clearCache() {
    beginRender()
    previousScroll.clear()
    cache.clear()
  }

  async function save(card, question, message) {
    if (!isCurrent(card)) return false
    try {
      if (await update(card.id, normalizeCanvasQuestion(question)) === false) return false
      notify(message)
      return true
    } catch (error) {
      notify(error?.message || '无法保存画布中的题目', true)
      return false
    }
  }

  function sectionPicker(card) {
    const question = normalizeCanvasQuestion(card.question)
    const checks = CANVAS_QUESTION_SECTIONS.map(({ id, label }) => ({
      id, label, input: h('input', { type: 'checkbox', checked: question.sections?.includes(id) ?? true }),
    }))
    const apply = h('button', { class: 'btn primary', type: 'button', text: '应用', onClick: async () => {
      const sections = checks.filter(({ input }) => input.checked).map(({ id }) => id)
      const selected = normalizeCanvasQuestion({ ...question, sections })
      if (JSON.stringify(selected.sections) !== JSON.stringify(question.sections)) {
        selected.scrollTop = 0
        selected.scrollLeft = 0
      }
      if (await save(card, selected, '已更新题目显示范围')) modal.close()
    } })
    const reset = h('button', { class: 'btn ghost', type: 'button', text: '回到题目开头', onClick: async () => {
      const view = views.get(card.id)
      if (view?.ready) view.viewport.scrollTo(0, 0)
      if (await save(card, { ...question, scrollTop: 0, scrollLeft: 0 }, '已回到题目开头')) modal.close()
    } })
    const modal = dialog('题目显示范围', h('div', { class: 'mb-canvas-question-form' },
      h('p', { class: 'cap', text: '勾选要显示的内容。滚动卡片后可记住显示起点，拖动卡片右下角可改变显示区域的大小。' }),
      h('div', { class: 'mb-canvas-question-sections' }, checks.map(({ label, input }) =>
        h('label', { class: 'mb-canvas-question-option' }, input, label))),
      h('div', { class: 'mb-canvas-question-form-actions' }, reset, apply),
    ))
  }

  async function rememberViewport(card) {
    const view = views.get(card.id)
    if (!view?.ready) {
      notify('题目加载后可以记住显示起点')
      return
    }
    const { scrollTop, scrollLeft } = view.viewport
    await save(card, { ...normalizeCanvasQuestion(card.question), scrollTop, scrollLeft }, '已记住题目显示起点')
  }

  async function edit(card) {
    if (!isCurrent(card)) return
    const form = h('div', { class: 'mb-canvas-question-form' }, h('p', { class: 'cap', text: '正在读取题目…' }))
    const modal = dialog('仅在画布编辑题目', form, true)
    const record = await read(card)
    if (!modal.open || !isCurrent(card)) return
    const question = normalizeCanvasQuestion(card.question)
    const source = record ?? { title: card.noteTitle, stem: card.text }
    const editors = CANVAS_QUESTION_FIELDS.map(({ id, label, limit }) => {
      const props = {
        class: 'input', maxlength: limit, value: question.fields[id] ?? source[id] ?? '',
      }
      const input = id === 'title' || id === 'errorType'
        ? h('input', { ...props, type: 'text' })
        : h('textarea', { ...props, rows: id === 'stem' ? 5 : 3 })
      return { id, input, row: h('label', { class: 'mb-canvas-question-field' }, h('span', { text: label }), input) }
    })
    const reset = h('button', { type: 'button', class: 'btn ghost', text: '恢复原题文字', disabled: !Object.keys(question.fields).length, onClick: async () => {
      if (await save(card, { ...question, fields: {} }, '已恢复画布中的原题文字')) modal.close()
    } })
    const apply = h('button', { type: 'button', class: 'btn primary', text: '应用到画布', onClick: async () => {
      const fields = {}
      for (const { id, input } of editors) {
        if (input.value !== String(source[id] ?? '').replace(/\r\n?/g, '\n')) fields[id] = input.value
      }
      if (await save(card, { ...question, fields }, '已应用到画布')) modal.close()
    } })
    const original = openOriginal && card.noteId ? h('button', {
      type: 'button', class: 'btn ghost mb-canvas-question-open', text: '打开原题', onClick: () => {
        modal.close()
        if (isCurrent(card)) void openOriginal(card)
      },
    }) : null
    form.replaceChildren(h('p', { class: 'cap', text: '改动只应用于这张画布卡片。题干、答案和过程支持 Markdown。' }),
      h('div', { class: 'mb-canvas-question-fields' }, editors.map(({ row }) => row)),
      h('div', { class: 'mb-canvas-question-form-actions' }, original, reset, apply))
  }

  function actions(card) {
    const button = (glyph, label, run, action) => h('button', {
      type: 'button', class: 'mb-canvas-question-action', 'data-question-action': action,
      'aria-label': label, title: label,
      onClick: event => { event.stopPropagation(); void run(card) },
    }, icon(glyph))
    return [
      button('eye', '显示范围', sectionPicker, 'sections'),
      button('maximize', '记住显示起点', rememberViewport, 'viewport'),
      button('pen', '仅在画布编辑', edit, 'edit'),
    ]
  }

  return { render, actions, edit, beginRender, clearCache }
}
