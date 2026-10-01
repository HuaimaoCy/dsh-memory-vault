import { icon } from './icons.js'

const h = (tag, props = {}, ...children) => {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = value
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value)
    else if (['value', 'checked', 'disabled'].includes(key)) node[key] = value
    else node.setAttribute(key, String(value))
  }
  for (const item of children.flat(Infinity)) if (item !== null && item !== undefined && item !== false) node.append(item instanceof Node ? item : String(item))
  return node
}
const field = (name, input) => h('label', { class: 'col' }, h('span', { class: 'label', text: name }), input)
const append = (node, ...children) => node.append(...children.filter(child => child !== null && child !== undefined && child !== false))
const labelStates = { new: '待复习', reviewing: '复习中', mastered: '已掌握' }
const date = value => value ? new Date(value).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }) : '尚未安排'
const dataURL = image => `data:${image.mimeType};base64,${image.data}`
async function call(action, body) {
  const reply = await window.vault.mistakebook(action, body)
  if (!reply.ok) throw new Error(reply.error || '操作失败')
  return reply.result
}
async function confirm(message) { return (await window.vault.confirm(message)).result === true }
async function filePayload(file, allowPDF = false) {
  const max = allowPDF && file.type === 'application/pdf' ? 50 : 10
  if (file.size > max * 1024 * 1024) throw new Error(`文件不能超过 ${max} MB`)
  if (!(allowPDF ? ['image/png', 'image/jpeg', 'application/pdf'] : ['image/png', 'image/jpeg', 'image/webp', 'image/gif']).includes(file.type)) throw new Error(allowPDF ? '请选择 PNG、JPEG 或 PDF' : '请选择 PNG、JPEG、WebP 或 GIF')
  const result = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = () => reject(new Error('无法读取文件')); reader.readAsDataURL(file) })
  const image = { name: file.name, mimeType: file.type, data: result, size: file.size }
  if (file.type.startsWith('image/')) {
    const decoded = new Image(); decoded.src = dataURL(image); await decoded.decode()
    if (decoded.naturalWidth > 16384 || decoded.naturalHeight > 16384 || decoded.naturalWidth * decoded.naturalHeight > 40000000) throw new Error('图片尺寸过大')
  }
  return image
}

export function mountMistakebook({ beforeEnter }) {
  const memory = document.querySelector('.app-shell')
  const shell = h('div', { class: 'mb-shell', hidden: true, 'aria-label': '错题本' })
  const state = { data: null, view: 'all', subjectID: '', nodeID: '', query: '', order: 'priority', draft: null, dirty: false, busy: false, review: false, showAnswer: false }
  let messageTimer
  const notify = (message, error = false) => {
    const output = document.getElementById('mb-status'); output.textContent = message; output.className = `mb-status visible${error ? ' error' : ''}`
    clearTimeout(messageTimer); if (!error) messageTimer = setTimeout(() => output.classList.remove('visible'), 3500)
    const inDialog = document.querySelector('.mb-dialog[open] .mb-dialog-status')
    if (inDialog) inDialog.textContent = message
  }
  const guard = async action => {
    if (state.busy) return
    state.busy = true; shell.inert = true; shell.setAttribute('aria-busy', 'true')
    try { await action() } catch (error) { notify(error.message || String(error), true) }
    finally { state.busy = false; shell.inert = false; shell.removeAttribute('aria-busy') }
  }
  const button = (label, action, primary = false, props = {}) => h('button', { type: 'button', class: primary ? 'btn primary' : 'btn', onClick: () => void guard(action), ...props }, label)
  const discard = async () => !state.dirty || await confirm('当前题目有未保存的修改，放弃这些修改？')
  const dirty = () => { state.dirty = true; const hint = document.getElementById('mb-save-state'); if (hint) { hint.textContent = '有未保存的修改'; hint.classList.add('dirty') } }
  const names = () => new Map((state.data?.taxonomy.nodes ?? []).map(node => [node.id, node.name]))
  const changeView = async (view, subjectID = '', nodeID = '') => {
    if (!await discard()) return
    Object.assign(state, { view, subjectID, nodeID, draft: null, dirty: false, review: false }); await load()
  }
  const load = async () => {
    state.data = await call('list', { view: state.view, subjectID: state.subjectID, nodeID: state.nodeID, query: state.query, order: state.order })
    renderSide(); renderList(); renderDetail()
  }
  const switchButton = button('', async () => {
    if (document.querySelector('dialog[open]') || !await discard()) return
    state.draft = null; state.dirty = false; shell.hidden = true; memory.hidden = false; document.body.dataset.mode = 'memory'
    document.getElementById('mode-switch').focus()
  }, false, { class: 'mode-switch', id: 'mb-mode-switch', title: '切换到记忆库', 'aria-label': '切换到记忆库', 'aria-pressed': 'true' })
  switchButton.append(icon('vault'))
  const search = h('input', { type: 'search', class: 'search', id: 'mb-query', placeholder: '搜索题目、错因与笔记', 'aria-label': '搜索错题' })
  let searchTimer
  search.addEventListener('input', () => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => void guard(async () => {
      if (!await discard()) { search.value = state.query; return }
      state.query = search.value.trim(); state.draft = null; state.dirty = false; await load()
    }), 220)
  })
  const sideViews = h('nav', { id: 'mb-views', 'aria-label': '错题视图' }), subjects = h('nav', { id: 'mb-subjects', 'aria-label': '学科' })
  const list = h('div', { id: 'mb-list', class: 'mb-list' }), detail = h('section', { id: 'mb-detail', class: 'mb-detail', hidden: true, 'aria-label': '题目编辑器' })
  const heading = h('h1', { id: 'mb-title', text: '全部错题' }), subtitle = h('p', { id: 'mb-subtitle', text: '把每一次出错，变成下一次会做。' })
  const jsonPicker = h('input', { type: 'file', accept: '.json,application/json', hidden: true, id: 'mb-json-picker', onChange: event => void guard(async () => {
    const file = event.target.files[0]; event.target.value = ''; if (!file) return
    if (!await discard()) return
    if (file.size > 100 * 1024 * 1024) throw new Error('JSON 超过 100 MB，请分批导入')
    let value; try { value = JSON.parse(await file.text()) } catch { throw new Error('无法解析 JSON 文件') }
    const records = Array.isArray(value) ? value : Array.isArray(value.records) ? value.records : value.records && typeof value.records === 'object' ? Object.values(value.records) : null
    if (!records || records.length > 3000) throw new Error('请选择旧版 Web/iOS 导出的错题 JSON，一次最多 3000 道题')
    if (!await confirm(`将从「${file.name}」导入 ${records.length} 道题，重复题干会跳过。继续？`)) return
    const result = await call('import', value); state.draft = null; state.dirty = false; await load(); notify(`导入 ${result.created} 道题，跳过 ${result.skipped} 道重复题${result.unmapped ? `；${result.unmapped} 道旧知识点需重新分类` : ''}${result.missingImages ? `；${result.missingImages} 道需补充旧版原图` : ''}`)
  }) })
  const order = h('select', { id: 'mb-sort', class: 'select', 'aria-label': '错题排序', onChange: event => void guard(async () => { state.order = event.target.value; await load() }) }, h('option', { value: 'priority', text: '复习优先级' }), h('option', { value: 'updated', text: '最近更新' }))
  shell.append(h('aside', { class: 'mb-side' },
    h('div', { class: 'brand' }, h('div', { class: 'mb-book-mark' }, icon('book')), h('div', {}, h('div', { class: 'brand-name', text: '错题本' }), h('div', { class: 'brand-caption', text: 'MISTAKE NOTEBOOK' }))),
    h('div', { class: 'mb-side-scroll' }, h('div', { class: 'side-head', text: '我的练习' }), sideViews, h('div', { class: 'side-head mb-subject-heading', text: '按学科整理' }), subjects),
    h('div', { class: 'mb-side-bottom' }, h('div', { class: 'mb-local' }, h('span', { class: 'library-dot' }), h('span', { text: '独立保存在本机' })),
      button([icon('settings'), '错题本设置'], openSettings, false, { class: 'nav', id: 'mb-settings' }))),
    h('div', { class: 'mb-workspace' }, h('header', { class: 'mb-bar' }, h('div', { class: 'breadcrumb' }, icon('book'), h('span', { text: '学习空间' })),
      h('div', { class: 'toolbar-actions' }, h('label', { class: 'search-wrap' }, icon('search'), search), button('录入 / OCR', openImport, false, { id: 'mb-import' }), button([icon('plus'), '新建题目'], newQuestion, true, { id: 'mb-new' }), switchButton)),
      h('div', { class: 'mb-body' }, h('main', { class: 'mb-main' }, h('div', { class: 'mb-page-heading' }, h('div', {}, h('div', { class: 'eyebrow', text: 'LEARN FROM EVERY MISTAKE' }), heading, subtitle), h('div', { class: 'mb-total', id: 'mb-total' })),
        h('div', { class: 'mb-summary', id: 'mb-summary' }), h('div', { class: 'mb-board' }, order, h('span', { class: 'spacer' }), button('导入旧版', () => jsonPicker.click(), false, { class: 'btn ghost', id: 'mb-legacy-import' }), button('导出', async () => { if (await call('export')) notify('错题本已导出，包含题目图片') }, false, { class: 'btn ghost' })), list), detail),
      h('footer', { class: 'mb-foot' }, h('span', { text: '错题本外挂 · 独立分支' }), h('span', { class: 'spacer' }), h('span', { text: '点击右上角图标切换模式' }))), jsonPicker, h('div', { id: 'mb-status', class: 'mb-status', role: 'status', 'aria-live': 'polite' }))
  document.body.append(shell)
  document.getElementById('mode-switch').addEventListener('click', () => void guard(async () => {
    if (!await beforeEnter()) return
    await load(); document.getElementById('status').classList.remove('show'); memory.hidden = true; shell.hidden = false; document.body.dataset.mode = 'mistakebook'; search.focus()
  }))
  function renderSide() {
    const stats = state.data.stats
    sideViews.replaceChildren(...[['all', '全部错题', 'library', stats.all], ['due', '待复习', 'task', stats.due], ['mastered', '已掌握', 'check', stats.mastered], ['archived', '归档', 'folder', stats.archived], ['trash', '回收站', 'hidden', stats.trash]].map(([view, label, symbol, count]) => button([icon(symbol), h('span', { class: 'nav-label', text: label }), h('span', { class: 'count', text: count })], () => changeView(view), false, { class: `nav${state.view === view && !state.subjectID ? ' on' : ''}`, 'data-mb-view': view, 'aria-current': state.view === view && !state.subjectID ? 'page' : 'false' })))
    subjects.replaceChildren(...state.data.taxonomy.nodes.filter(node => !node.parentID).map(node => button([h('span', { class: 'mb-subject-dot', text: node.name.slice(0,1) }), h('span', { class: 'nav-label', text: node.name }), h('span', { class: 'count', text: stats.subjects[node.id] ?? 0 })], () => changeView('all', node.id), false, { class: `nav${state.subjectID === node.id ? ' on' : ''}`, 'data-mb-subject': node.id })))
    if (state.subjectID) {
      const nodes = state.data.taxonomy.nodes.filter(node => node.subjectID === state.subjectID && node.parentID === state.subjectID)
      subjects.append(h('div', { class: 'mb-topics' }, nodes.map(node => button(node.name, () => changeView('all', state.subjectID, node.id), false, { class: `nav${state.nodeID === node.id ? ' on' : ''}` }))))
    }
  }
  function renderList() {
    const dictionary = names(), stats = state.data.stats, rows = state.data.records
    heading.textContent = dictionary.get(state.nodeID) || dictionary.get(state.subjectID) || ({ all: '全部错题', due: '今天，复习一点', mastered: '已经掌握', archived: '归档题目', trash: '回收站' })[state.view]
    subtitle.textContent = state.view === 'due' ? '先看题目，独立作答，再展开答案核对。' : state.view === 'trash' ? '删除的题目可以恢复，永久删除后将无法找回。' : '把每一次出错，变成下一次会做。'
    document.getElementById('mb-total').replaceChildren(h('strong', { text: rows.length }), h('span', { text: '道题目' }))
    document.getElementById('mb-summary').replaceChildren(...[['待复习', stats.due, '今天迈出一小步', 'due'], ['已掌握', stats.mastered, '让进步留得住', 'mastered'], ['题目总数', stats.all, '逐题整理，慢慢积累', 'all']].map(([title, count, caption, view]) => button([h('span', { class: 'mb-summary-label', text: title }), h('strong', { text: count }), h('span', { class: 'cap', text: caption })], () => changeView(view), false, { class: 'mb-summary-card' })))
    list.replaceChildren()
    if (!rows.length) list.append(h('div', { class: 'mb-empty' }, h('div', { class: 'mb-empty-symbol' }, icon('book')), h('h2', { text: state.query ? '没有找到相关题目' : state.view === 'due' ? '今天的复习已完成' : '收好第一道错题' }), h('p', { text: '录入题干、保留作答，或从图片与旧版资料开始。' }), button('录入题目', openImport, true)))
    for (const row of rows) {
      const score = row.value.overallScore
      list.append(button([
        h('div', { class: 'mb-card-head' }, h('span', { class: 'mb-subject-label', text: dictionary.get(row.subjectID) || '待分类' }), h('span', { class: 'spacer' }), h('span', { class: `mb-state ${row.reviewState}`, text: labelStates[row.reviewState] })),
        h('h2', { text: row.stem.split('\n')[0].slice(0,90) || '图片题目' }), h('p', { class: 'mb-card-stem', text: row.stem.replace(/\s+/g,' ').slice(0,180) || '打开题目查看原图，补充题干和作答。' }),
        h('div', { class: 'mb-card-tags' }, row.nodeID ? h('span', { text: dictionary.get(row.nodeID) }) : null, row.imageCount ? h('span', { text: `${row.imageCount} 张原图` }) : null, row.errorType ? h('span', { text: row.errorType }) : null),
        h('div', { class: 'mb-card-foot' }, h('span', { class: `mb-score ${row.value.level}`, text: `复习优先 ${score}` }), h('span', { text: `更新于 ${date(row.updatedAt)}` })),
      ], () => select(row.id), false, { class: `mb-card${state.draft?.id === row.id ? ' selected' : ''}`, 'data-question-id': row.id, 'aria-pressed': String(state.draft?.id === row.id) }))
    }
  }
  async function select(id) {
    if (!await discard()) return
    state.draft = await call('read', { id }); state.dirty = false; state.review = state.view === 'due'; state.showAnswer = false
    renderList(); renderDetail()
  }
  async function newQuestion() {
    if (!await discard()) return
    state.draft = { stem: '', studentWork: '', referenceAnswer: '', notes: '', cause: '', errorType: '', nodeID: '', subjectID: state.subjectID, target: 'gaokao', images: [], reviewState: 'new', repeatCount: 0, mastery: 0 }
    state.dirty = false; state.review = false; renderList(); renderDetail(); document.querySelector('[data-mb-field=stem]').focus()
  }
  async function save() {
    const draft = state.draft; if (!draft) return
    if (!draft.stem.trim() && !draft.images.length) throw new Error('请填写题干或添加题目图片')
    state.draft = await call('save', { ...draft, images: draft.images.map(image => image.id ? { id: image.id } : image) }); state.dirty = false; await load(); notify('题目已保存')
  }
  async function perform(action) {
    if (!await discard()) return
    const id = state.draft.id
    if (action === 'purge' && !await confirm('永久删除这道题和原图？此操作无法恢复。')) return
    if (action === 'delete' && !await confirm('将这道题移入回收站？之后可以恢复。')) return
    const result = await call('action', { id, action })
    state.dirty = false
    state.draft = ['pass','fail'].includes(action) ? result : null
    if (state.draft) { state.review = true; state.showAnswer = false }
    await load(); notify(({ pass: '复习已记录，下次按计划再来', fail: '已记录薄弱点，明天再练一次', delete: '已移入回收站', restore: '题目已恢复', archive: '已归档', unarchive: '已取消归档', purge: '题目已永久删除' })[action])
  }
  function renderDetail() {
    const draft = state.draft; detail.hidden = !draft; shell.classList.toggle('with-question', Boolean(draft))
    if (!draft) { detail.replaceChildren(); return }
    const control = (name, rows = 3) => h('textarea', { class: 'area', rows, value: draft[name] || '', 'data-mb-field': name, onInput: event => { draft[name] = event.target.value; dirty() } })
    const dictionary = names(), nodes = state.data.taxonomy.nodes
    const subject = h('select', { class: 'select', 'data-mb-field': 'subjectID', onChange: event => { draft.subjectID = event.target.value; draft.nodeID = ''; dirty(); renderDetail() } }, h('option', { value: '', text: '待分类' }), nodes.filter(node => !node.parentID).map(node => h('option', { value: node.id, text: node.name, selected: node.id === draft.subjectID ? 'selected' : undefined })))
    const nodeSelect = h('select', { class: 'select', 'data-mb-field': 'nodeID', onChange: event => { draft.nodeID = event.target.value; draft.classificationSuggested = false; dirty() } }, h('option', { value: '', text: '选择知识点' }), nodes.filter(node => node.parentID && node.subjectID === draft.subjectID).map(node => h('option', { value: node.id, text: `${node.id.split('/').length > 2 ? '　' : ''}${node.name}`, selected: node.id === draft.nodeID ? 'selected' : undefined })))
    const errors = ['未记录', '审题疏漏', '概念不清', '推理错误', '计算错误', '表达不完整', '知识遗忘', '其他']
    if (draft.errorType && !errors.includes(draft.errorType)) errors.push(draft.errorType)
    const errorType = h('select', { class: 'select', 'data-mb-field': 'errorType', onChange: event => { draft.errorType = event.target.value; dirty() } }, errors.map(label => h('option', { value: label === '未记录' ? '' : label, text: label, selected: (label === '未记录' ? '' : label) === draft.errorType ? 'selected' : undefined })))
    const target = h('select', { class: 'select', 'data-mb-field': 'target', onChange: event => { draft.target = event.target.value; dirty() } }, [['gaokao','高考'],['huige','合格考']].map(([value, text]) => h('option', { value, text, selected: value === draft.target ? 'selected' : undefined })))
    const close = button('', async () => { if (await discard()) { state.draft = null; state.dirty = false; renderList(); renderDetail() } }, false, { class: 'icon-button', 'aria-label': '关闭题目' }); close.append(icon('close'))
    const head = h('div', { class: 'mb-detail-head' }, h('div', {}, h('span', { class: 'eyebrow', text: state.review ? 'REVIEW' : 'QUESTION' }), h('h2', { text: draft.id ? state.review ? '独立作答，再核对' : '题目详情' : '记录一道错题' })), close)
    const actions = h('div', { class: 'row' }, h('span', { id: 'mb-save-state', class: state.dirty ? 'cap dirty' : 'cap', text: state.dirty ? '有未保存的修改' : draft.id ? '已保存' : '尚未保存' }), h('span', { class: 'spacer' }), button('保存题目', save, true, { id: 'mb-save' }))
    const form = h('form', { class: 'mb-editor-form', onSubmit: event => { event.preventDefault(); void guard(save) } })
    if (state.review) {
      form.append(h('div', { class: 'mb-review-stem', text: draft.stem || '请查看题目原图' }))
      if (state.showAnswer) form.append(h('div', { class: 'mb-answer' }, h('span', { class: 'label', text: '参考答案' }), h('p', { text: draft.referenceAnswer || '尚未填写参考答案' }), h('span', { class: 'label', text: '过往作答' }), h('p', { text: draft.studentWork || '尚未填写作答' }), h('span', { class: 'label', text: '错因与复盘' }), h('p', { text: draft.cause || draft.notes || '尚未填写复盘' })))
      form.append(h('div', { class: 'row mb-review-actions' }, button(state.showAnswer ? '收起答案' : '展开答案核对', () => { state.showAnswer = !state.showAnswer; renderDetail() }, false, { id: 'mb-reveal' }), button('编辑题目', () => { state.review = false; renderDetail() }, false)))
      if (state.showAnswer) form.append(h('div', { class: 'row' }, button('还不会', () => perform('fail'), false, { id: 'mb-review-fail' }), button('做对了', () => perform('pass'), true, { id: 'mb-review-pass' })))
    } else {
      append(form, field('题干', control('stem', 5)), h('div', { class: 'mb-fields-row' }, field('学科', subject), field('知识点', nodeSelect)),
        draft.classificationSuggested ? h('p', { class: 'cap', text: '知识点由关键词建议，请确认后保存。' }) : null,
        draft.legacyNodeID ? h('p', { class: 'cap', text: `旧知识点「${draft.legacyNodeID}」需重新选择，原标识已保留。` }) : null,
        field('我的作答', control('studentWork')), field('参考答案', control('referenceAnswer')), h('div', { class: 'mb-fields-row' }, field('错因类型', errorType), field('考试目标', target)), field('错因与复盘', control('cause')), field('笔记', control('notes', 2)), actions)
    }
    form.append(imagePanel(draft))
    form.addEventListener('paste', event => {
      if (state.review || !event.clipboardData?.files.length || event.target.closest('.mb-images')) return
      event.preventDefault()
      form.querySelector('.mb-images').dispatchEvent(new ClipboardEvent('paste', { clipboardData: event.clipboardData, bubbles: false, cancelable: true }))
    })
    if (draft.id) {
      const value = draft.value
      form.append(h('div', { class: 'mb-priority' }, h('div', { class: 'row' }, h('strong', { text: `复习优先 ${value.overallScore}` }), h('span', { class: 'spacer' }), h('span', { text: labelStates[draft.reviewState] })),
        h('p', { class: 'cap', text: `再次出错 ${draft.repeatCount} 次 · 下次复习 ${date(draft.nextReviewAt)}` }), h('details', {}, h('summary', { text: '查看评分依据' }), h('p', { class: 'cap', text: value.reason }), h('p', { class: 'cap', text: '沿用旧版课标规则，含估算与默认值，作为复习排序参考。' }))))
      const tools = h('div', { class: 'row mb-detail-actions' })
      if (draft.isSoftDeleted) tools.append(button('恢复', () => perform('restore')), button('永久删除', () => perform('purge'), false, { class: 'btn danger' }))
      else {
        tools.append(button(state.review ? '退出复习' : '开始复习', async () => { if (await discard()) { state.draft = await call('read',{id:draft.id}); state.dirty=false; state.review=!state.review; state.showAnswer=false; renderDetail() } }, false, { id: 'mb-start-review' }),
          button(draft.isArchived ? '取消归档' : '归档', () => perform(draft.isArchived ? 'unarchive' : 'archive')), button('移到回收站', () => perform('delete'), false, { class: 'btn ghost danger', id: 'mb-delete' }))
        if (!draft.isArchived) tools.append(button('辅助分析错因', async () => {
          if (state.dirty) throw new Error('请先保存题目再分析')
          const settings = await call('settings')
          if (settings.modelConfigured && !await confirm('将向已配置的 AI 服务发送题干、作答、参考答案与笔记，生成错因建议。继续？')) return
          notify('正在分析错因…'); state.draft = await call('analyze', { id: draft.id }); await load(); notify('错因建议已保存，请核对')
        }, false, { id: 'mb-analyze' }))
      }
      form.append(tools)
    }
    detail.replaceChildren(head, form)
  }
  function imagePanel(draft) {
    const panel = h('div', { class: 'mb-images', id: 'mb-images' })
    const importFiles = async files => {
      const incoming = Array.from(files)
      if (draft.images.length + incoming.length > 16) throw new Error('每道题最多 16 张原图')
      const newImages = await Promise.all(incoming.map(file => filePayload(file)))
      if (state.draft !== draft) return
      if ([...draft.images, ...newImages].reduce((sum, image) => sum + image.size, 0) > 20 * 1024 * 1024) throw new Error('每道题的原图总计不能超过 20 MB')
      draft.images.push(...newImages); dirty(); renderDetail()
    }
    const picker = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', multiple: true, hidden: true, id: 'mb-image-picker', onChange: event => { const files = Array.from(event.target.files); event.target.value = ''; void guard(() => importFiles(files)) } })
    append(panel, h('div', { class: 'row' }, h('span', { class: 'label', text: `题目原图 · ${draft.images.length}` }), h('span', { class: 'spacer' }), !state.review ? button('添加图片', () => picker.click(), false, { class: 'btn ghost' }) : null), picker,
      h('div', { class: 'mb-image-grid' }, draft.images.map((image, index) => h('div', { class: 'mb-image-item' }, button(h('img', { src: dataURL(image), alt: image.name }), () => previewImage(image), false, { class: 'mb-image-thumb', 'aria-label': `预览 ${image.name}` }), h('div', { class: 'mb-image-caption' }, h('span', { text: image.name }), !state.review ? button('移除', () => { draft.images.splice(index,1); dirty(); renderDetail() }, false, { class: 'btn ghost' }) : null)))),
      !state.review ? h('p', { class: 'cap', text: '可粘贴截图或拖入图片；原图随题目保存。' }) : null)
    panel.addEventListener('dragover', event => { event.preventDefault() })
    panel.addEventListener('drop', event => { if (state.review) return; event.preventDefault(); void guard(() => importFiles(event.dataTransfer.files)) })
    panel.addEventListener('paste', event => { if (state.review || !event.clipboardData.files.length) return; event.preventDefault(); void guard(() => importFiles(event.clipboardData.files)) })
    return panel
  }
  function dialog(title, content, wide = false) {
    const node = h('dialog', { class: `mb-dialog${wide ? ' wide' : ''}` })
    const close = button('关闭', () => { node.close(); node.remove() }, false, { class: 'btn ghost', 'aria-label': '关闭对话框' })
    node.append(h('div', { class: 'mb-dialog-head' }, h('h2', { text: title }), h('span', { class: 'spacer' }), close), content, h('div', { class: 'mb-dialog-status cap', role: 'status' }))
    node.addEventListener('close', () => node.remove()); document.body.append(node); node.showModal(); return node
  }
  function previewImage(image) {
    dialog(image.name, h('div', { class: 'mb-image-preview' }, h('img', { src: dataURL(image), alt: image.name })), true)
  }
  async function openSettings() {
    const config = await call('settings'), info = (await window.vault.info()).result
    const endpoint = h('input', { class: 'input', value: config.endpoint, id: 'mb-ocr-url' }), key = h('input', { type: 'password', class: 'input', autocomplete: 'new-password', placeholder: config.hasKey ? '已安全保存；留空保留' : '填写 GLM-OCR API Key', id: 'mb-ocr-key' }), clear = h('input', { type: 'checkbox' })
    const modelURL = h('input', { class: 'input', value: info.model?.baseUrl || '', placeholder: 'https://api.example.com/v1', id: 'mb-model-url' }), model = h('input', { class: 'input', value: info.model?.model || '', placeholder: '模型名称', id: 'mb-model-name' }), modelKey = h('input', { type: 'password', class: 'input', autocomplete: 'new-password', placeholder: info.hasKey ? '已安全保存；留空保留' : '模型 API Key' }), clearModel = h('input', { type: 'checkbox' })
    const node = dialog('错题本设置', h('div', { class: 'mb-settings-form' },
      h('h3', { text: '图片与 PDF 识别' }), h('p', { class: 'cap', text: '使用 GLM-OCR 版面解析接口。点击识别才会发送所选文件；识别结果可校对后导入。' }), field('OCR 接口地址', endpoint), field('OCR 密钥', key), h('label', { class: 'row cap' }, clear, '清除已保存的 OCR 密钥'),
      h('h3', { text: '错因辅助分析' }), h('p', { class: 'cap', text: '不配置模型时使用本地规则。模型配置与外挂内的记忆模式共用，支持兼容 OpenAI 的服务。' }), field('模型服务地址', modelURL), field('模型名称', model), field('模型密钥', modelKey), h('label', { class: 'row cap' }, clearModel, '清除已保存的模型密钥'),
      button('保存设置', async () => {
        const reply = await window.vault.settings({ baseUrl: modelURL.value, model: model.value, apiKey: modelKey.value, clearKey: clearModel.checked }); if (!reply.ok) throw new Error(reply.error)
        await call('configure', { endpoint: endpoint.value, apiKey: key.value, clearKey: clear.checked }); key.value = ''; modelKey.value = ''; node.close(); notify('设置已安全保存')
      }, true, { id: 'mb-config-save' }), h('h3', { text: '本地数据' }), h('p', { class: 'mb-data-path', text: config.path }), button('备份错题本', async () => { if (await call('backup')) notify('错题本已备份，包含原图') }), h('p', { class: 'cap', text: '错题本使用独立数据库，不进入 Codex / DSH 的记忆上下文。' })))
  }
  async function openImport() {
    if (!await discard()) return
    const draft = { file: null, questions: [], running: false, modified: false }
    const text = h('textarea', { class: 'area mb-ocr-text', id: 'mb-import-text', placeholder: '粘贴题目文字，或选择图片 / PDF 后识别。\n\n1. 第一题\n2. 第二题', onInput: () => { draft.modified = true; draft.questions = []; results.replaceChildren() } })
    const results = h('div', { class: 'mb-segment-results', id: 'mb-segments' }), preview = h('div', { class: 'mb-source-preview', id: 'mb-ocr-preview' }, icon('book'), h('p', { text: '保留原题，校对文字' }))
    const filename = h('p', { class: 'cap', text: 'PNG / JPEG ≤ 10 MB，PDF ≤ 50 MB' }), keep = h('input', { type: 'checkbox', checked: true, id: 'mb-keep-source' })
    const subject = h('select', { class: 'select', id: 'mb-import-subject' }, h('option', { value: '', text: '自动建议学科与知识点' }), state.data.taxonomy.nodes.filter(node => !node.parentID).map(node => h('option', { value: node.id, text: node.name, selected: node.id === state.subjectID ? 'selected' : undefined })))
    const receive = async file => {
      if (!file) return
      if (draft.running) throw new Error('请先取消当前识别')
      draft.file = await filePayload(file, true); filename.textContent = file.name; draft.modified = true
      preview.replaceChildren(file.type === 'application/pdf' ? h('div', { class: 'mb-pdf-source' }, icon('book'), h('strong', { text: file.name }), h('p', { text: 'PDF 将识别为文字，导入前请核对题号与公式。' })) : h('img', { src: dataURL(draft.file), alt: file.name }))
    }
    const picker = h('input', { type: 'file', accept: 'image/png,image/jpeg,application/pdf', id: 'mb-ocr-file', hidden: true, onChange: event => { const file = event.target.files[0]; event.target.value = ''; void guard(() => receive(file)) } })
    const cancel = h('button', { type: 'button', class: 'btn ghost', text: '取消识别', hidden: true, id: 'mb-ocr-cancel', onClick: () => void call('cancelOCR') })
    const recognizeButton = button('识别文字', async () => {
      if (!draft.file) throw new Error('请先选择图片或 PDF')
      if (text.value.trim() && !await confirm('识别结果将替换当前文字，继续？')) return
      draft.running = true; text.disabled = true; recognizeButton.disabled = true; cancel.hidden = false; notify('正在识别文字…')
      try {
        const result = await call('ocr', draft.file)
        if (!node.isConnected) return
        text.value = result.text; draft.modified = true; draft.questions = []; results.replaceChildren(); notify('识别完成，请校对题干与公式再拆题')
      } catch (error) { if (node.isConnected) throw new Error(/abort|cancel/i.test(error.message) ? '识别已取消，可以重试' : error.message) }
      finally { draft.running = false; text.disabled = false; recognizeButton.disabled = false; cancel.hidden = true }
    }, true, { id: 'mb-ocr-start' })
    const split = button('预览拆题', async () => {
      const reply = await call('segment', { text: text.value }); draft.questions = reply.questions.map(stem => ({ stem, selected: true })); results.replaceChildren()
      draft.questions.forEach((question, index) => results.append(h('label', { class: 'mb-segment' }, h('div', { class: 'row' }, h('input', { type: 'checkbox', checked: true, onChange: event => { question.selected = event.target.checked } }), h('strong', { text: `第 ${index+1} 题` })), h('textarea', { class: 'area', rows: 3, value: question.stem, onInput: event => { question.stem = event.target.value } }))))
      notify(`已拆出 ${draft.questions.length} 道题，请核对后导入`)
    }, false, { id: 'mb-split' })
    const importButton = button('导入选中题目', async () => {
      const selected = draft.questions.filter(question => question.selected)
      if (!selected.length) throw new Error('请先预览拆题，并选择需要导入的题目')
      if (selected.some(question => !question.stem.trim())) throw new Error('选中的题干不能为空')
      const images = keep.checked && draft.file?.mimeType.startsWith('image/') ? [draft.file] : []
      const reply = await call('import', { records: selected.map(question => ({ stem: question.stem, ...(subject.value ? { subjectID: subject.value, nodeID: '' } : {}), images })) })
      draft.modified = false; state.draft = null; state.dirty = false; state.view = 'all'; state.subjectID = ''; state.nodeID = ''; state.query = ''; search.value = ''; await load(); node.close(); notify(`已导入 ${reply.created} 道题，跳过 ${reply.skipped} 道重复题`)
    }, true, { id: 'mb-import-confirm' })
    const node = dialog('录入题目', h('div', { class: 'mb-import-layout' }, h('div', { class: 'mb-import-source' }, picker, preview, button('选择图片 / PDF', () => picker.click()), filename, h('div', { class: 'row' }, recognizeButton, cancel), h('label', { class: 'row cap' }, keep, '随每道题保存整张原图（PDF 仅导入文字）'), field('导入学科', subject)), h('div', { class: 'mb-import-content' }, h('span', { class: 'label', text: '题目文字 · 可以手动校对' }), text, h('div', { class: 'row' }, split, h('span', { class: 'spacer' }), importButton), results)), true)
    const closeButton = node.querySelector('[aria-label="关闭对话框"]')
    const close = async () => {
      if (draft.running) await call('cancelOCR')
      if (draft.modified && !await confirm('当前录入内容尚未导入，放弃并关闭？')) return
      node.close()
    }
    closeButton.replaceWith(h('button', { type: 'button', class: 'btn ghost', text: '关闭', 'aria-label': '关闭录入', onClick: () => void close() }))
    node.addEventListener('cancel', event => { event.preventDefault(); void close() })
    preview.addEventListener('dragover', event => event.preventDefault())
    preview.addEventListener('drop', event => { event.preventDefault(); void guard(() => receive(event.dataTransfer.files[0])) })
    preview.tabIndex = 0
    preview.addEventListener('paste', event => { if (event.clipboardData.files.length) { event.preventDefault(); void guard(() => receive(event.clipboardData.files[0])) } })
    text.focus()
  }
  document.addEventListener('keydown', event => {
    if (document.body.dataset.mode !== 'mistakebook' || document.querySelector('dialog[open]')) return
    if (event.ctrlKey || event.metaKey) {
      if (event.key.toLowerCase() === 'f') { event.preventDefault(); search.focus(); search.select() }
      if (event.key.toLowerCase() === 'n') { event.preventDefault(); void guard(newQuestion) }
      if (event.key.toLowerCase() === 's' && state.draft && !state.review) { event.preventDefault(); void guard(save) }
    }
  })
}
