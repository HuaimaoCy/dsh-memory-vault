import { icon } from './icons.js'
import { NOTE_TYPES, STRUCTURED_FIELDS, normalizeFields } from '../../addons/mistakebook/fields.mjs'
import { SIMULATIONS } from '../../addons/mistakebook/simulations.mjs'

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
  const shell = h('div', { class: 'mb-shell', hidden: true, 'aria-label': '笔记本' })
  const state = { data: null, view: 'all', type: '', subjectID: '', nodeID: '', query: '', order: 'priority', draft: null, dirty: false, busy: false, review: false, showAnswer: false }
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
  const discard = async () => !state.dirty || await confirm('当前笔记有未保存的修改，放弃这些修改？')
  const dirty = () => { state.dirty = true; const hint = document.getElementById('mb-save-state'); if (hint) { hint.textContent = '有未保存的修改'; hint.classList.add('dirty') } }
  const names = () => new Map((state.data?.taxonomy.nodes ?? []).map(node => [node.id, node.name]))
  const changeView = async (view, subjectID = '', nodeID = '', type = '') => {
    if (!await discard()) return
    Object.assign(state, { view, subjectID, nodeID, type, draft: null, dirty: false, review: false }); await load()
  }
  const load = async () => {
    state.data = await call('list', { view: state.view, type: state.type, subjectID: state.subjectID, nodeID: state.nodeID, query: state.query, order: state.order })
    renderSide(); renderList(); renderDetail()
  }
  const switchButton = button('', async () => {
    if (document.querySelector('dialog[open]') || !await discard()) return
    state.draft = null; state.dirty = false; shell.hidden = true; memory.hidden = false; document.body.dataset.mode = 'memory'
    document.getElementById('mode-switch').focus()
  }, false, { class: 'mode-switch', id: 'mb-mode-switch', title: '切换到记忆库', 'aria-label': '切换到记忆库', 'aria-pressed': 'true' })
  switchButton.append(icon('vault'))
  const search = h('input', { type: 'search', class: 'search', id: 'mb-query', placeholder: '搜索笔记、模型与单词', 'aria-label': '搜索笔记' })
  let searchTimer
  search.addEventListener('input', () => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => void guard(async () => {
      if (!await discard()) { search.value = state.query; return }
      state.query = search.value.trim(); state.draft = null; state.dirty = false; await load()
    }), 220)
  })
  const sideViews = h('nav', { id: 'mb-views', 'aria-label': '笔记视图' }), categories = h('nav', { id: 'mb-types', 'aria-label': '笔记类型' }), subjects = h('nav', { id: 'mb-subjects', 'aria-label': '学科' })
  const list = h('div', { id: 'mb-list', class: 'mb-list' }), detail = h('section', { id: 'mb-detail', class: 'mb-detail', hidden: true, 'aria-label': '题目编辑器' })
  const heading = h('h1', { id: 'mb-title', text: '全部笔记' }), subtitle = h('p', { id: 'mb-subtitle', text: '记录问题，建立模型，积累自己的解题方法。' })
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
    h('div', { class: 'brand' }, h('div', { class: 'mb-book-mark' }, icon('book')), h('div', {}, h('div', { class: 'brand-name', text: '笔记本' }), h('div', { class: 'brand-caption', text: 'STUDY NOTEBOOK' }))),
    h('div', { class: 'mb-side-scroll' }, h('div', { class: 'side-head', text: '我的学习' }), sideViews, h('div', { class: 'side-head mb-subject-heading', text: '笔记类型' }), categories, h('div', { class: 'side-head mb-subject-heading', text: '按学科整理' }), subjects),
    h('div', { class: 'mb-side-bottom' }, h('div', { class: 'mb-local' }, h('span', { class: 'library-dot' }), h('span', { text: '独立保存在本机' })),
      button([icon('settings'), '笔记本设置'], openSettings, false, { class: 'nav', id: 'mb-settings' }))),
    h('div', { class: 'mb-workspace' }, h('header', { class: 'mb-bar' }, h('div', { class: 'breadcrumb' }, icon('book'), h('span', { text: '学习空间' })),
      h('div', { class: 'toolbar-actions' }, h('label', { class: 'search-wrap' }, icon('search'), search), button('单词检测', openQuiz, false, { id: 'mb-quiz' }), button('录入 / OCR', openImport, false, { id: 'mb-import' }), button([icon('plus'), '新建笔记'], openCreate, true, { id: 'mb-new' }), switchButton)),
      h('div', { class: 'mb-body' }, h('main', { class: 'mb-main' }, h('div', { class: 'mb-page-heading' }, h('div', {}, h('div', { class: 'eyebrow', text: 'BUILD YOUR OWN UNDERSTANDING' }), heading, subtitle), h('div', { class: 'mb-total', id: 'mb-total' })),
        h('div', { class: 'mb-summary', id: 'mb-summary' }), h('div', { class: 'mb-board' }, order, h('span', { class: 'spacer' }), button('词汇批量录入', openVocabularyImport, false, { class: 'btn ghost', id: 'mb-word-import' }), button('导入 JSON', () => jsonPicker.click(), false, { class: 'btn ghost', id: 'mb-legacy-import' }), button('导出', async () => { if (await call('export')) notify('笔记本已导出，包含图片') }, false, { class: 'btn ghost' })), list), detail),
      h('footer', { class: 'mb-foot' }, h('span', { text: '笔记本 · 本地保存' }), h('span', { class: 'spacer' }), h('span', { text: '点击右上角图标切换模式' }))), jsonPicker, h('div', { id: 'mb-status', class: 'mb-status', role: 'status', 'aria-live': 'polite' }))
  document.body.append(shell)
  document.getElementById('mode-switch').addEventListener('click', () => void guard(async () => {
    if (!await beforeEnter()) return
    await load(); document.getElementById('status').classList.remove('show'); memory.hidden = true; shell.hidden = false; document.body.dataset.mode = 'mistakebook'; search.focus()
  }))
  function renderSide() {
    const stats = state.data.stats
    sideViews.replaceChildren(...[['all', '全部笔记', 'library', stats.all], ['due', '待复习', 'task', stats.due], ['mastered', '已掌握', 'check', stats.mastered], ['archived', '归档', 'folder', stats.archived], ['trash', '回收站', 'hidden', stats.trash]].map(([view, label, symbol, count]) => button([icon(symbol), h('span', { class: 'nav-label', text: label }), h('span', { class: 'count', text: count })], () => changeView(view), false, { class: `nav${state.view === view && !state.subjectID && !state.type ? ' on' : ''}`, 'data-mb-view': view, 'aria-current': state.view === view && !state.subjectID && !state.type ? 'page' : 'false' })))
    categories.replaceChildren(...Object.entries(NOTE_TYPES).map(([type,meta])=>button([icon(meta.icon),h('span',{class:'nav-label',text:meta.label}),h('span',{class:'count',text:stats.types[type]??0})],()=>changeView('all','','',type),false,{class:`nav${state.type===type?' on':''}`,'data-mb-type':type})))
    subjects.replaceChildren(...state.data.taxonomy.nodes.filter(node => !node.parentID).map(node => button([h('span', { class: 'mb-subject-dot', text: node.name.slice(0,1) }), h('span', { class: 'nav-label', text: node.name }), h('span', { class: 'count', text: stats.subjects[node.id] ?? 0 })], () => changeView('all', node.id), false, { class: `nav${state.subjectID === node.id ? ' on' : ''}`, 'data-mb-subject': node.id })))
    if (state.subjectID) {
      const nodes = state.data.taxonomy.nodes.filter(node => node.subjectID === state.subjectID && node.parentID === state.subjectID)
      subjects.append(h('div', { class: 'mb-topics' }, nodes.map(node => button(node.name, () => changeView('all', state.subjectID, node.id), false, { class: `nav${state.nodeID === node.id ? ' on' : ''}` }))))
    }
  }
  function renderList() {
    const dictionary = names(), stats = state.data.stats, rows = state.data.records
    heading.textContent = NOTE_TYPES[state.type]?.label || dictionary.get(state.nodeID) || dictionary.get(state.subjectID) || ({ all: '全部笔记', due: '今天，复习一点', mastered: '已经掌握', archived: '归档笔记', trash: '回收站' })[state.view]
    subtitle.textContent = NOTE_TYPES[state.type]?.caption || (state.view === 'due' ? '先独立回忆，再展开答案与笔记核对。' : '记录问题，建立模型，积累自己的解题方法。')
    document.getElementById('mb-total').replaceChildren(h('strong', { text: rows.length }), h('span', { text: '篇笔记' }))
    document.getElementById('mb-summary').replaceChildren(...[['待复习', stats.due, '今天迈出一小步', 'due'], ['已掌握', stats.mastered, '让进步留得住', 'mastered'], ['笔记总数', stats.all, '一点一滴，建立理解', 'all']].map(([title, count, caption, view]) => button([h('span', { class: 'mb-summary-label', text: title }), h('strong', { text: count }), h('span', { class: 'cap', text: caption })], () => changeView(view), false, { class: 'mb-summary-card' })))
    list.replaceChildren()
    if (!rows.length) list.append(h('div', { class: 'mb-empty' }, h('div', { class: 'mb-empty-symbol' }, icon(NOTE_TYPES[state.type]?.icon||'book')), h('h2', { text: state.query ? '没有找到相关笔记' : state.view === 'due' ? '今天的复习已完成' : '从一篇笔记开始' }), h('p', { text: '整理错题、建立模型，或记下一个值得积累的单词。' }), button('新建笔记', openCreate, true)))
    for (const row of rows) {
      const score = row.value.overallScore
      list.append(button([
        h('div', { class: 'mb-card-head' }, h('span', { class: `mb-type-label ${row.type}`, text: NOTE_TYPES[row.type]?.label||'错题' }), h('span', { class: 'spacer' }), h('span', { class: `mb-state ${row.reviewState}`, text: labelStates[row.reviewState] })),
        h('h2', { text: row.title || row.vocabulary?.word || row.stem.split('\n')[0].slice(0,90) || '图片笔记' }), h('p', { class: 'mb-card-stem', text: (row.type==='vocabulary'?row.vocabulary.meaning:row.stem||row.physics?.object||row.method?.prerequisites||'打开笔记补充内容。').replace(/\s+/g,' ').slice(0,180) }),
        h('div', { class: 'mb-card-tags' }, row.subjectID ? h('span',{text:dictionary.get(row.subjectID)}) : null, row.nodeID ? h('span', { text: dictionary.get(row.nodeID) }) : null, row.imageCount ? h('span', { text: `${row.imageCount} 张原图` }) : null, row.errorType ? h('span', { text: row.errorType }) : null),
        h('div', { class: 'mb-card-foot' }, h('span', { class: `mb-score ${row.value.level}`, text: `复习优先 ${score}` }), h('span', { text: `更新于 ${date(row.updatedAt)}` })),
      ], () => select(row.id), false, { class: `mb-card${state.draft?.id === row.id ? ' selected' : ''}`, 'data-question-id': row.id, 'aria-pressed': String(state.draft?.id === row.id) }))
    }
  }
  async function select(id) {
    if (!await discard()) return
    state.draft = await call('read', { id }); state.dirty = false; state.review = state.view === 'due'; state.showAnswer = false
    renderList(); renderDetail()
  }
  async function openCreate() {
    if (!await discard()) return
    const node=dialog('新建笔记',h('div',{class:'mb-create-types'},Object.entries(NOTE_TYPES).map(([type,meta])=>button([icon(meta.icon),h('strong',{text:meta.label}),h('span',{class:'cap',text:meta.caption})],async()=>{node.close();await newQuestion(type)},false,{class:'mb-create-type','data-create-type':type}))))
  }
  async function newQuestion(type = state.type || 'note') {
    if (!await discard()) return
    state.draft = { type, title:'', physics:normalizeFields('physics'),method:normalizeFields('method'),vocabulary:normalizeFields('vocabulary'),simulationId:'',stem: '', studentWork: '', referenceAnswer: '', notes: '', cause: '', errorType: '', nodeID: '', subjectID: type==='physics'?'physics':type==='vocabulary'?'english':state.subjectID, target: 'gaokao', images: [], reviewState: 'new', repeatCount: 0, mastery: 0 }
    state.dirty = false; state.review = false; renderList(); renderDetail(); setTimeout(()=>document.querySelector(`[data-mb-field="${type==='vocabulary'?'vocabulary.word':'title'}"]`)?.focus(),0)
  }
  async function save() {
    const draft = state.draft; if (!draft) return
    state.draft = await call('save', { ...draft, images: draft.images.map(image => image.id ? { id: image.id } : image) }); state.dirty = false; await load(); notify('笔记已保存')
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
    const control = (name, rows = 3) => {
      const path=name.split('.'), get=()=>path.reduce((value,key)=>value?.[key],draft)
      return h(rows===1?'input':'textarea', { class: rows===1?'input':'area', rows:rows===1?undefined:rows, value:get()||'', 'data-mb-field':name, onInput:event=>{const parent=path.length===1?draft:draft[path[0]];parent[path.at(-1)]=event.target.value;dirty()} })
    }
    const dictionary = names(), nodes = state.data.taxonomy.nodes
    const subject = h('select', { class: 'select', 'data-mb-field': 'subjectID', onChange: event => { draft.subjectID = event.target.value; draft.nodeID = ''; dirty(); renderDetail() } }, h('option', { value: '', text: '待分类' }), nodes.filter(node => !node.parentID).map(node => h('option', { value: node.id, text: node.name, selected: node.id === draft.subjectID ? 'selected' : undefined })))
    const nodeSelect = h('select', { class: 'select', 'data-mb-field': 'nodeID', onChange: event => { draft.nodeID = event.target.value; draft.classificationSuggested = false; dirty() } }, h('option', { value: '', text: '选择知识点' }), nodes.filter(node => node.parentID && node.subjectID === draft.subjectID).map(node => h('option', { value: node.id, text: `${node.id.split('/').length > 2 ? '　' : ''}${node.name}`, selected: node.id === draft.nodeID ? 'selected' : undefined })))
    const errors = ['未记录', '审题疏漏', '概念不清', '推理错误', '计算错误', '表达不完整', '知识遗忘', '其他']
    if (draft.errorType && !errors.includes(draft.errorType)) errors.push(draft.errorType)
    const errorType = h('select', { class: 'select', 'data-mb-field': 'errorType', onChange: event => { draft.errorType = event.target.value; dirty() } }, errors.map(label => h('option', { value: label === '未记录' ? '' : label, text: label, selected: (label === '未记录' ? '' : label) === draft.errorType ? 'selected' : undefined })))
    const target = h('select', { class: 'select', 'data-mb-field': 'target', onChange: event => { draft.target = event.target.value; dirty() } }, [['gaokao','高考'],['huige','合格考']].map(([value, text]) => h('option', { value, text, selected: value === draft.target ? 'selected' : undefined })))
    const close = button('', async () => { if (await discard()) { state.draft = null; state.dirty = false; renderList(); renderDetail() } }, false, { class: 'icon-button', 'aria-label': '关闭题目' }); close.append(icon('close'))
    const head = h('div', { class: 'mb-detail-head' }, h('div', {}, h('span', { class: 'eyebrow', text: state.review ? 'REVIEW' : NOTE_TYPES[draft.type].label }), h('h2', { text: draft.id ? state.review ? '独立回忆，再核对' : '笔记详情' : `新建${NOTE_TYPES[draft.type].label}` })), close)
    const actions = h('div', { class: 'row mb-save-actions' }, h('span', { id: 'mb-save-state', class: state.dirty ? 'cap dirty' : 'cap', text: state.dirty ? '有未保存的修改' : draft.id ? '已保存' : '尚未保存' }), h('span', { class: 'spacer' }), button('保存笔记', save, true, { id: 'mb-save' }),button(draft.type==='physics'?'AI 构建与推导':draft.type==='vocabulary'?'AI 补全词条':'AI 自动解答', solveAI,false,{id:'mb-ai-solve'}))
    const form = h('form', { class: 'mb-editor-form', onSubmit: event => { event.preventDefault(); void guard(save) } })
    if (state.review) {
      form.append(h('h3',{class:'mb-review-title',text:draft.title||draft.vocabulary?.word||NOTE_TYPES[draft.type].label}),h('div', { class: 'mb-review-stem', text: draft.type==='vocabulary'?draft.vocabulary.word:draft.stem || draft.physics?.object || '请查看笔记原图' }))
      if (state.showAnswer) form.append(h('div', { class: 'mb-answer' }, h('span', { class: 'label', text: '参考答案与讲解' }), h('p', { text: draft.referenceAnswer || draft.aiResult?.text || draft.notes || '尚未填写' }), h('span', { class: 'label', text: '过往作答与复盘' }), h('p', { text: [draft.studentWork,draft.cause].filter(Boolean).join('\n') }), (STRUCTURED_FIELDS[draft.type]??[]).filter(([key])=>draft[draft.type][key]).map(([key,label])=>h('div',{},h('span',{class:'label',text:label}),h('p',{text:draft[draft.type][key]})))))
      form.append(h('div', { class: 'row mb-review-actions' }, button(state.showAnswer ? '收起答案' : '展开答案核对', () => { state.showAnswer = !state.showAnswer; renderDetail() }, false, { id: 'mb-reveal' }), button('编辑题目', () => { state.review = false; renderDetail() }, false)))
      if (state.showAnswer) form.append(h('div', { class: 'row' }, button('还不会', () => perform('fail'), false, { id: 'mb-review-fail' }), button('做对了', () => perform('pass'), true, { id: 'mb-review-pass' })))
    } else {
      append(form,field('标题',control('title',1)), field(draft.type==='mistake'?'题干':draft.type==='physics'?'问题情境与建模目标':draft.type==='method'?'方法概述与问题背景':draft.type==='vocabulary'?'相关语境与补充':'笔记内容与问题', control('stem', 5)), h('div', { class: 'mb-fields-row' }, field('学科', subject), field('知识点', nodeSelect)),
        draft.classificationSuggested ? h('p', { class: 'cap', text: '知识点由关键词建议，请确认后保存。' }) : null,
        draft.legacyNodeID ? h('p', { class: 'cap', text: `旧知识点「${draft.legacyNodeID}」需重新选择，原标识已保留。` }) : null,
        draft.type==='mistake'?field('我的作答', control('studentWork')):null, draft.type==='mistake'?field('参考答案', control('referenceAnswer')):null, draft.type==='mistake'?h('div', { class: 'mb-fields-row' }, field('错因类型', errorType), field('考试目标', target)):null, draft.type==='mistake'?field('错因与复盘', control('cause')):null)
      if (STRUCTURED_FIELDS[draft.type]) form.append(h('div',{class:'mb-structured-fields'},STRUCTURED_FIELDS[draft.type].map(([key,label])=>field(label,control(`${draft.type}.${key}`,draft.type==='vocabulary'&&['word','phonetic','partOfSpeech'].includes(key)?1:['derivation','steps','examples'].includes(key)?5:3)))))
      if(draft.type==='physics') {
        const select=h('select',{class:'select',id:'mb-simulation-id',onChange:event=>{draft.simulationId=event.target.value;dirty()}},h('option',{value:'',text:'选择对应的物理仿真'}),SIMULATIONS.map(item=>h('option',{value:item.id,text:item.name,selected:draft.simulationId===item.id?'selected':undefined})))
        form.append(h('div',{class:'mb-simulation-panel'},field('交互仿真 · PhET',select),h('p',{class:'cap',text:'在独立窗口调整参数、观察模型，将结论记入笔记。需要联网。'}),button('打开物理仿真',async()=>{if(!draft.simulationId)throw new Error('请先选择物理仿真');notify('正在打开物理仿真…');await call('simulation.open',{id:draft.simulationId});notify('仿真已打开，可调整参数观察')},false,{id:'mb-simulation-open'})))
      }
      form.append(field('补充笔记',control('notes',2)),actions)
    }
    form.append(imagePanel(draft))
    form.addEventListener('paste', event => {
      if (state.review || !event.clipboardData?.files.length || event.target.closest('.mb-images')) return
      event.preventDefault()
      form.querySelector('.mb-images').dispatchEvent(new ClipboardEvent('paste', { clipboardData: event.clipboardData, bubbles: false, cancelable: true }))
    })
    if (draft.id) {
      if(draft.aiResult) form.append(h('div',{class:'mb-ai-result',id:'mb-ai-result'},h('div',{class:'row'},h('strong',{text:'AI 学习草稿'}),h('span',{class:'spacer'}),h('span',{class:'cap',text:draft.aiStale?'资料已修改，建议重新生成':date(draft.aiResult.generatedAt)})),h('div',{class:'mb-ai-text',text:draft.aiResult.text}),h('p',{class:'cap',text:'解答与模型仍需核对。补充空白字段会保留已有的人工内容。'}),button('补充到空白字段',async()=>{if(state.dirty)throw new Error('请先保存修改');state.draft=await call('ai.accept',{id:draft.id});state.dirty=false;await load();notify('AI 草稿已补充，人工内容保留')},false,{id:'mb-ai-accept',disabled:draft.aiStale})))
      const value = draft.value
      form.append(h('div', { class: 'mb-priority' }, h('div', { class: 'row' }, h('strong', { text: `复习优先 ${value.overallScore}` }), h('span', { class: 'spacer' }), h('span', { text: labelStates[draft.reviewState] })),
        h('p', { class: 'cap', text: `再次出错 ${draft.repeatCount} 次 · 下次复习 ${date(draft.nextReviewAt)}` }), h('details', {}, h('summary', { text: '查看评分依据' }), h('p', { class: 'cap', text: value.reason }), h('p', { class: 'cap', text: '沿用旧版课标规则，含估算与默认值，作为复习排序参考。' }))))
      const tools = h('div', { class: 'row mb-detail-actions' })
      if (draft.isSoftDeleted) tools.append(button('恢复', () => perform('restore')), button('永久删除', () => perform('purge'), false, { class: 'btn danger' }))
      else {
        tools.append(button(state.review ? '退出复习' : '开始复习', async () => { if (await discard()) { state.draft = await call('read',{id:draft.id}); state.dirty=false; state.review=!state.review; state.showAnswer=false; renderDetail() } }, false, { id: 'mb-start-review' }),
          button(draft.isArchived ? '取消归档' : '归档', () => perform(draft.isArchived ? 'unarchive' : 'archive')), button('移到回收站', () => perform('delete'), false, { class: 'btn ghost danger', id: 'mb-delete' }))
        if (!draft.isArchived && draft.type==='mistake') tools.append(button('辅助分析错因', async () => {
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
  async function solveAI() {
    if(!state.draft) return
    if(state.dirty||!state.draft.id) await save()
    const node=dialog('AI 正在整理这篇笔记',h('div',{class:'mb-ai-progress'},icon('sparkles'),h('p',{text:'正在生成解答、推导或词条。内容会先保存为可核对的草稿。'})))
    const cancel=h('button',{type:'button',class:'btn ghost',text:'取消生成',id:'mb-ai-cancel',onClick:()=>void call('cancelAI')})
    node.querySelector('[aria-label="关闭对话框"]').replaceWith(cancel)
    node.addEventListener('cancel',event=>{event.preventDefault();void call('cancelAI')})
    try {state.draft=await call('solve',{id:state.draft.id});state.dirty=false;await load();notify('AI 学习草稿已生成，可核对并补充字段')}
    catch(error){throw new Error(/abort|cancel/i.test(error.message)?'AI 生成已取消，笔记内容保留':error.message)}
    finally{node.close()}
  }
  async function openVocabularyImport() {
    if(!await discard())return
    const text=h('textarea',{class:'area',id:'mb-word-import-text',rows:10,placeholder:'一行一个词条：单词 | 中文释义 | 例句\n\nabandon | 放弃 | Never abandon hope.\nconserve | 保存；保护 | We should conserve energy.'})
    const node=dialog('批量积累英语词汇',h('div',{class:'mb-settings-form'},h('p',{class:'cap',text:'支持竖线或制表符分隔。同一个词会跳过，释义可稍后手动填写或用 AI 补全。'}),text,button('导入词汇',async()=>{
      const records=text.value.split(/\r?\n/).map(line=>line.trim()).filter(Boolean).map(line=>{const [word,meaning='',...rest]=line.split(/[|\t]/).map(value=>value.trim());return{type:'vocabulary',title:word,vocabulary:{word,meaning,examples:rest.join(' | ')}}})
      if(!records.length)throw new Error('请先填写英语词汇')
      const result=await call('import',{records});state.draft=null;state.dirty=false;state.type='vocabulary';state.view='all';state.subjectID='';state.nodeID='';await load();node.close();notify(`积累 ${result.created} 个词条，跳过 ${result.skipped} 个重复词`)
    },true,{id:'mb-word-import-save'})))
  }
  async function openQuiz() {
    if(!await discard())return
    state.draft=null;state.dirty=false;await load()
    const mode=h('select',{class:'select',id:'mb-quiz-mode'},h('option',{value:'spelling',text:'看中文，写英语 · 本地检测'}),h('option',{value:'cloze',text:'AI 例句填空 · 需要模型'})),count=h('input',{class:'input',type:'number',min:1,max:20,value:10,id:'mb-quiz-count'}),body=h('div',{class:'mb-quiz-body'})
    const node=dialog('英语词汇检测',body,true)
    const cancel=h('button',{type:'button',class:'btn ghost',text:'取消生成',id:'mb-quiz-cancel',hidden:true,onClick:()=>void call('cancelAI')})
    body.append(h('div',{class:'mb-quiz-intro'},h('p',{class:'cap',text:'从已积累、未归档且有释义的词条中随机抽取。拼写检测不需要联网；AI 例句可以检验词义与语境。'}),h('div',{class:'mb-fields-row'},field('检测方式',mode),field('词条数量',count)),h('div',{class:'row'},button('开始检测',async()=>{
      const startMode=mode.value;cancel.hidden=startMode!=='cloze'
      let quiz
      try{quiz=await call('quiz.start',{mode:startMode,count:Number(count.value)})}finally{cancel.hidden=true}
      const answers=new Map(),questions=quiz.questions.map((question,index)=>h('label',{class:'mb-quiz-question'},h('strong',{text:`${index+1}. ${question.prompt}`}),h('span',{class:'cap',text:question.hint}),h('input',{class:'input',autocomplete:'off',spellcheck:'false','data-quiz-id':question.id,onInput:event=>answers.set(question.id,event.target.value)})))
      body.replaceChildren(h('p',{class:'cap',text:`共 ${quiz.questions.length} 个词条，请填写原词形。提交后显示答案，并记录复习。`}),...questions,button('提交检测',async()=>{
        const result=await call('quiz.submit',{id:quiz.id,answers:[...answers].map(([id,answer])=>({id,answer}))});await load()
        body.replaceChildren(h('div',{class:'mb-quiz-score',id:'mb-quiz-score'},h('strong',{text:`${result.score}%`}),h('span',{text:`答对 ${result.results.filter(row=>row.correct).length} / ${result.results.length}`})),h('div',{class:'mb-quiz-results'},result.results.map(row=>h('div',{class:`mb-quiz-result${row.correct?' correct':' incorrect'}`},h('strong',{text:row.expected}),h('span',{text:row.correct?'正确':`你的答案：${row.answer||'未填写'}`}),h('span',{class:'cap',text:row.recorded?'已记入复习记录':'词条已修改，本次只显示成绩'})))),button('再检测一组',async()=>{node.close();await openQuiz()},true,{id:'mb-quiz-again'}))
      },true,{id:'mb-quiz-submit'}));node.querySelector('input')?.focus()
    },true,{id:'mb-quiz-start'}),cancel)))
    node.addEventListener('cancel',()=>void call('cancelAI'))
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
    const node = dialog('笔记本设置', h('div', { class: 'mb-settings-form' },
      h('h3', { text: '图片与 PDF 识别' }), h('p', { class: 'cap', text: '使用 GLM-OCR 版面解析接口。点击识别才会发送所选文件；识别结果可校对后导入。' }), field('OCR 接口地址', endpoint), field('OCR 密钥', key), h('label', { class: 'row cap' }, clear, '清除已保存的 OCR 密钥'),
      h('h3', { text: 'AI 解答、模型推导与英语检测' }), h('p', { class: 'cap', text: '支持兼容 OpenAI 的服务。仅在点击 AI 功能后发送所选笔记；有图片时需要支持图片输入的模型。模型配置与本程序的记忆模式共用。' }), field('模型服务地址', modelURL), field('模型名称', model), field('模型密钥', modelKey), h('label', { class: 'row cap' }, clearModel, '清除已保存的模型密钥'),
      button('保存设置', async () => {
        const reply = await window.vault.settings({ baseUrl: modelURL.value, model: model.value, apiKey: modelKey.value, clearKey: clearModel.checked }); if (!reply.ok) throw new Error(reply.error)
        await call('configure', { endpoint: endpoint.value, apiKey: key.value, clearKey: clear.checked }); key.value = ''; modelKey.value = ''; node.close(); notify('设置已安全保存')
      }, true, { id: 'mb-config-save' }), h('h3', { text: '本地数据' }), h('p', { class: 'mb-data-path', text: config.path }), button('备份笔记本', async () => { if (await call('backup')) notify('笔记本已备份，包含原图') }), h('p', { class: 'cap', text: '笔记本使用独立数据库，不进入 Codex / DSH 的记忆上下文。' })))
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
      if (event.key.toLowerCase() === 'n') { event.preventDefault(); void guard(openCreate) }
      if (event.key.toLowerCase() === 's' && state.draft && !state.review) { event.preventDefault(); void guard(save) }
    }
  })
}
