/**
 * Quick capture — the one place to type a thought and file it into exactly one
 * domain: a memory group (knowledge / conversation) or a notebook note type.
 *
 * Design rules this module keeps:
 *  - The two domains never mix: memory goes through `entry.write`, notebook
 *    goes through `notebook.save` + a `notebook.list` read-back. No shared
 *    table, no cross-domain fallback.
 *  - No raw HTML: every user string is set through `value` / `textContent`.
 *  - No network: the only request is a same-origin <link> for this module's CSS.
 *  - Keyboard-first and animation-free (a keyboard surface must never animate);
 *    `prefers-reduced-motion` is honoured for the whole panel.
 *  - UI preference (last domain / group / note type / tags) lives in
 *    localStorage under `alaya.db.capture`; it is never written to the vault's
 *    meta table.
 *
 * The module is dependency-free so Node can import the pure helpers directly
 * (`tests/capture-smoke.mjs`); the DOM half is only touched inside
 * `mountQuickCapture`.
 */

/** localStorage key for the capture panel's own UI preference. */
export const CAPTURE_STORAGE_KEY = 'alaya.db.capture'

/** Inbox convention: a capture without tags still lands in the inbox. */
export const DEFAULT_CAPTURE_TAGS = ['收件箱']

/** The three domains the segmented control offers. */
export const CAPTURE_MODES = ['knowledge', 'conversation', 'notebook']

const MODE_LABELS = { knowledge: '知识库', conversation: '对话记忆', notebook: '笔记本' }
const MODE_ICONS = { knowledge: 'book', conversation: 'conversation', notebook: 'note' }
// Quick capture most often writes a plain note; the rest keep their editor order.
const NOTE_TYPE_ORDER = ['note', 'mistake', 'physics', 'method', 'vocabulary']
/**
 * Notebook destinations the capture panel offers by default.
 *
 * These mirror `addons/mistakebook/fields.mjs` 的 NOTE_TYPES（id 与中文标签），
 * 但只镜像标签、不 import 笔记本模块：数据库界面必须能在没有笔记本模块时
 * 独立启动。`tests/capture-smoke.mjs` 有一条守卫断言两者一致，改一边会红。
 */
export const NOTEBOOK_TARGETS = Object.freeze([
  { id: 'note', label: '笔记' },
  { id: 'mistake', label: '错题' },
  { id: 'physics', label: '物理模型' },
  { id: 'method', label: '解题方法' },
  { id: 'vocabulary', label: '英语词汇' },
])
const MAX_TAGS = 32
const STYLE_LINK_ID = 'alaya-quick-capture-style'

let instanceCounter = 0

const asString = value => (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value))
const clean = value => asString(value).trim()
const scopeOf = value => (value === 'conversation' ? 'conversation' : 'knowledge')
const memoryScopeLabel = scope => (scope === 'conversation' ? '对话记忆' : '知识库')

/**
 * Normalise a tag list: split on commas (both widths) and newlines, trim,
 * drop empties and duplicates, keep order. A plain string is accepted too.
 * @param {unknown} input - Array, string, or anything else.
 * @returns {string[]} At most 32 distinct tags.
 */
export function normalizeTags(input) {
  const raw = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/[,，\n]/) : []
  const tags = []
  for (const item of raw) {
    const tag = clean(item)
    if (tag === '' || tags.includes(tag)) continue
    tags.push(tag)
    if (tags.length >= MAX_TAGS) break
  }
  return tags
}

/**
 * Turn the app's live target sources into the flat list the panel renders.
 * Accepts the real shapes: memory groups from `state.groups`
 * (`{id, name, path, scope}`) and note types either as the `NOTE_TYPES` object
 * or as an array of ids / `{id|type|value, label|name}` records.
 *
 * Bad rows never throw: anything without a usable id is skipped.
 * @param {{groups?: unknown, noteTypes?: unknown}} [input]
 * @returns {{id: string, label: string, kind: 'memory'|'notebook', scope?: 'knowledge'|'conversation'}[]}
 *   Memory targets first (input order, duplicates removed), then notebook
 *   targets (plain note first, then declaration order).
 */
export function normalizeCaptureTargets(input = {}) {
  const source = input && typeof input === 'object' ? input : {}
  const targets = []
  const seen = new Set()

  const groups = Array.isArray(source.groups) ? source.groups : []
  for (const group of groups) {
    if (!group || typeof group !== 'object' || Array.isArray(group)) continue
    const id = clean(group.id)
    if (id === '' || seen.has(`memory:${id}`)) continue
    const path = Array.isArray(group.path) ? group.path.map(clean).filter(Boolean) : []
    const name = clean(group.name)
    const label = [...path, name].filter(Boolean).join(' / ') || clean(group.label) || '未命名分组'
    seen.add(`memory:${id}`)
    targets.push({ id, label, kind: 'memory', scope: group.scope === 'conversation' ? 'conversation' : 'knowledge' })
  }

  const notes = []
  const raw = source.noteTypes
  const entries = Array.isArray(raw)
    ? raw.map(item => (typeof item === 'string' ? { id: item, label: item } : item))
    : raw && typeof raw === 'object'
      ? Object.entries(raw).map(([id, value]) => ({ id, ...(value && typeof value === 'object' ? value : { label: typeof value === 'string' ? value : '' }) }))
      : []
  for (const item of entries) {
    if (!item || typeof item !== 'object') continue
    const id = clean(item.id ?? item.type ?? item.value ?? item.key)
    if (id === '' || seen.has(`notebook:${id}`)) continue
    seen.add(`notebook:${id}`)
    notes.push({ id, label: clean(item.label ?? item.name) || id, kind: 'notebook', rank: NOTE_TYPE_ORDER.indexOf(id) })
  }
  notes.sort((a, b) => (a.rank < 0 ? NOTE_TYPE_ORDER.length : a.rank) - (b.rank < 0 ? NOTE_TYPE_ORDER.length : b.rank))
  for (const note of notes) targets.push({ id: note.id, label: note.label, kind: 'notebook' })

  return targets
}

/**
 * Coerce a persisted preference blob into the panel's fixed shape. Anything
 * missing or malformed falls back to the defaults, so a corrupted key can
 * never stop the panel from opening.
 * @param {unknown} raw - Parsed JSON (or anything).
 * @returns {{mode: string, groupIds: {knowledge: string, conversation: string}, noteType: string, tagsText: string}}
 */
export function normalizeCapturePrefs(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const groupIds = source.groupIds && typeof source.groupIds === 'object' && !Array.isArray(source.groupIds) ? source.groupIds : {}
  // Ids are opaque strings; a non-string is a corrupt value, not an id.
  const idText = value => (typeof value === 'string' ? value.trim() : '')
  return {
    mode: CAPTURE_MODES.includes(source.mode) ? source.mode : 'knowledge',
    groupIds: {
      knowledge: idText(groupIds.knowledge) || idText(source.knowledgeGroupId),
      conversation: idText(groupIds.conversation) || idText(source.conversationGroupId),
    },
    noteType: idText(source.noteType),
    tagsText: typeof source.tagsText === 'string' ? source.tagsText : DEFAULT_CAPTURE_TAGS.join(', '),
  }
}

const defaultStorage = () => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/**
 * Read the panel's own UI preference. Never throws: an unavailable storage, a
 * corrupt JSON string or an unexpected shape all yield the defaults.
 * @param {{getItem?: Function}|null} [storage] - Defaults to localStorage.
 */
export function loadCapturePrefs(storage = defaultStorage()) {
  try {
    const raw = storage?.getItem?.(CAPTURE_STORAGE_KEY)
    return normalizeCapturePrefs(raw ? JSON.parse(raw) : null)
  } catch {
    return normalizeCapturePrefs(null)
  }
}

/**
 * Persist the panel's UI preference. Writes nothing but this key, and stays
 * silent when storage refuses writes (private mode, quota, disabled).
 * @param {object} prefs
 * @param {{setItem?: Function}|null} [storage] - Defaults to localStorage.
 * @returns {object} The normalised value that was written.
 */
export function saveCapturePrefs(prefs, storage = defaultStorage()) {
  const normalized = normalizeCapturePrefs(prefs)
  try {
    storage?.setItem?.(CAPTURE_STORAGE_KEY, JSON.stringify(normalized))
  } catch {
    /* UI preference only: losing it must never break a capture. */
  }
  return normalized
}

/**
 * Derive a short heading from the first non-empty line, dropping the markdown
 * list/heading furniture the editor would not show as part of the title.
 * @param {unknown} content
 * @param {number} [max] - Hard cap in characters.
 */
export function derivedTitle(content, max = 120) {
  const first = asString(content).split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? ''
  const stripped = first.replace(/^(?:#{1,6}\s*|[-*+]\s+|>\s*|\d{1,3}[.、)]\s*)/, '').replace(/[`*]/g, '').trim()
  return (stripped || first).slice(0, max).trim()
}

/**
 * Why a save would be refused, or null when the input is savable.
 * Kept pure so the same rule drives the inline error and the tests.
 * @param {{content?: unknown, mode?: string, targets?: unknown, groupId?: string, noteType?: string}} [input]
 * @returns {string|null}
 */
export function captureProblem(input = {}) {
  const source = input && typeof input === 'object' ? input : {}
  if (clean(source.content) === '') return '请先输入内容再保存'
  const targets = Array.isArray(source.targets) ? source.targets.filter(item => item && typeof item === 'object') : []
  if (source.mode === 'notebook') {
    const notes = targets.filter(item => item.kind === 'notebook')
    if (notes.length === 0) return '笔记本还没有可用的笔记类型'
    if (!notes.some(item => item.id === clean(source.noteType))) return '请选择要写入的笔记类型'
    return null
  }
  const scope = source.mode === 'conversation' ? 'conversation' : 'knowledge'
  const groups = targets.filter(item => item.kind === 'memory' && scopeOf(item.scope) === scope)
  if (groups.length === 0) return `${memoryScopeLabel(scope)}还没有记忆组，请先在「数据库」里新建一个组`
  if (!groups.some(item => item.id === clean(source.groupId))) return '请选择要写入的记忆组'
  return null
}

/**
 * Payload for the memory domain (the exact `entry.write` body the vault's
 * policy validates). Tags default to the inbox convention when omitted;
 * an explicit empty list is honoured (the user cleared the field).
 * @param {{content?: unknown, title?: unknown, tags?: unknown, scope?: string, groupId?: unknown}} [input]
 */
export function buildMemoryEntryPayload(input = {}) {
  const source = input && typeof input === 'object' ? input : {}
  const content = clean(source.content)
  const title = source.title === undefined ? derivedTitle(content) : clean(source.title)
  return {
    title: title.slice(0, 120),
    content,
    kind: 'note',
    tags: source.tags === undefined || source.tags === null ? [...DEFAULT_CAPTURE_TAGS] : normalizeTags(source.tags),
    scope: scopeOf(source.scope),
    groupId: clean(source.groupId),
    priority: 0,
    base: false,
  }
}

/**
 * Payload for the notebook domain, matching `MistakebookStore.save`'s real
 * contract: `type` must be one of NOTE_TYPES, and the store requires a
 * non-empty stem (or title/structured text) for every type. Vocabulary needs
 * `vocabulary.word`; a captured paragraph becomes the word only when the user
 * actually chose that type.
 * @param {{content?: unknown, type?: unknown}} [input]
 */
export function buildNotebookPayload(input = {}) {
  const source = input && typeof input === 'object' ? input : {}
  const content = clean(source.content)
  const type = clean(source.type) || 'note'
  const title = derivedTitle(content)
  if (type === 'vocabulary') {
    const [first = '', ...rest] = content.split(/\r?\n/)
    const word = first.trim().slice(0, 200)
    const meaning = rest.join('\n').trim().slice(0, 2000)
    return { type, title: word, stem: content, images: [], tags: [], vocabulary: { word, meaning } }
  }
  return { type, title, stem: content, images: [], tags: [] }
}

const safeIcon = (icon, name) => {
  try {
    return typeof icon === 'function' ? icon(name) : null
  } catch {
    return null
  }
}

/** Inject this module's stylesheet once, next to the app's own <link>s. */
function ensureStyle(doc) {
  try {
    if (!doc?.head || doc.getElementById(STYLE_LINK_ID)) return
    const href = new URL('./quick-capture.css', import.meta.url).href
    const link = doc.createElement('link')
    link.id = STYLE_LINK_ID
    link.rel = 'stylesheet'
    link.href = href
    doc.head.append(link)
  } catch {
    /* Styling is cosmetic; never let it block the panel. */
  }
}

/**
 * Mount the unified capture panel.
 * @param {object} options
 * @param {Function} options.h - `h(tag, props, ...children)` factory from app.js.
 * @param {Function} [options.icon] - `icon(name)` from icons.js.
 * @param {(op: string, body?: object) => Promise<unknown>} options.call - Memory-domain IPC, already unwrapped to `result`.
 * @param {(op: string, body?: object) => Promise<unknown>} options.notebook - Notebook-domain IPC (`save`, `list`, …).
 * @param {(message: string, tone?: 'info'|'ok'|'err') => void} [options.say] - App status bar.
 * @param {Element} [options.mount] - Where the dialog is appended; defaults to `document.body`.
 * @param {(status: {tone: 'ok'|'err', message: string, count: number, mode: string, target: object|null}) => void} [options.onStatus] - Observer for saves/errors.
 * @returns {{open: Function, close: Function, isOpen: Function, toggle: Function, setTargets: Function, destroy: Function}}
 */
export function mountQuickCapture(options = {}) {
  const { h, icon, call, notebook, say } = options
  const modes=Array.isArray(options.modes)?CAPTURE_MODES.filter(mode=>options.modes.includes(mode)):CAPTURE_MODES
  if(!modes.length)throw new Error('捕获面板至少需要一个可用域')
  if (typeof h !== 'function') throw new TypeError('mountQuickCapture 需要 app.js 的 h 工厂')
  const appSay = typeof say === 'function' ? say : () => {}
  const onStatus = typeof options.onStatus === 'function' ? options.onStatus : null
  const dock = options.mount && typeof options.mount.append === 'function' ? options.mount : document.body

  const instance = ++instanceCounter
  const uid = `quick-capture-${instance}`
  const titleId = `${uid}-title`
  const hintId = `${uid}-hint`
  const errorId = `${uid}-error`
  const statusId = `${uid}-status`

  const stored = loadCapturePrefs()
  const state = {
    mode: modes.includes(stored.mode)?stored.mode:modes[0],
    groupIds: { ...stored.groupIds },
    noteType: stored.noteType,
    tagsText: stored.tagsText,
    targets: [],
    count: 0,
    busy: false,
    destroyed: false,
  }

  const report = payload => {
    try {
      onStatus?.(payload)
    } catch {
      /* An observer bug must never turn a saved entry into a failure. */
    }
  }
  const persist = () => {
    saveCapturePrefs({ mode: state.mode, groupIds: state.groupIds, noteType: state.noteType, tagsText: state.tagsText })
  }
  const modeList = () => (state.mode === 'conversation' ? 'conversation' : 'knowledge')
  const availableTargets = () => (state.mode === 'notebook'
    ? state.targets.filter(item => item.kind === 'notebook')
    : state.targets.filter(item => item.kind === 'memory' && scopeOf(item.scope) === modeList()))
  const currentTargetId = () => (state.mode === 'notebook' ? state.noteType : state.groupIds[modeList()])
  const targetById = id => state.targets.find(item => item.id === id && (item.kind === 'notebook') === (state.mode === 'notebook')) ?? null
  const unwrap = reply => {
    if (reply && typeof reply === 'object' && Object.hasOwn(reply, 'ok')) {
      if (reply.ok !== true) throw new Error(clean(reply.error) || '操作失败')
      return reply.result
    }
    return reply
  }
  const readable = error => {
    const message = clean(error?.message ?? error)
    return message === '' ? '保存失败，请重试' : message
  }

  // —— Shell ————————————————————————————————————————————————————————————
  ensureStyle(document)

  const statusLine = h('p', { class: 'qc-status', 'data-qc': 'status', id: statusId, role: 'status', 'aria-live': 'polite' })
  const errorLine = h('p', { class: 'qc-error', 'data-qc': 'error', id: errorId, role: 'alert', 'aria-live': 'assertive', hidden: true })
  const targetHint = h('p', { class: 'qc-hint', 'data-qc': 'hint', id: hintId, hidden: true })

  const contentInput = h('textarea', {
    class: 'area qc-input', 'data-qc': 'input', rows: '3', spellcheck: 'false', autocomplete: 'off',
    placeholder: '记下一句话、一个想法或一条待办…', 'aria-label': '捕获内容', 'aria-describedby': hintId,
    onKeydown: event => {
      // IME-safe: a composing Enter belongs to the input method, not to us.
      if (event.isComposing || event.keyCode === 229) return
      if (event.key !== 'Enter' || event.shiftKey) return
      event.preventDefault()
      void save()
    },
    onInput: () => {
      showError('')
      updateSaveButton()
    },
  })

  const targetLabel = h('span', { class: 'label', text: '目标分组' })
  const targetSelect = h('select', {
    class: 'select qc-target', 'data-qc': 'target', 'aria-label': '目标分组或笔记类型',
    onChange: () => {
      const id = targetSelect.value
      if (state.mode === 'notebook') state.noteType = id
      else state.groupIds[modeList()] = id
      showError('')
      updateTargetHint()
      persist()
    },
  })
  const tagsInput = h('input', {
    class: 'input qc-tags', 'data-qc': 'tags', type: 'text', autocomplete: 'off', spellcheck: 'false',
    'aria-label': '标签，用逗号分隔', placeholder: DEFAULT_CAPTURE_TAGS.join(', '),
    onInput: () => { state.tagsText = tagsInput.value },
    onChange: () => { state.tagsText = tagsInput.value; persist() },
  })

  const tagsField = h('label', { class: 'col qc-field qc-tags-field', 'data-qc': 'tags-field' },
    h('span', { class: 'label', text: '标签（逗号分隔，默认收件箱）' }), tagsInput)

  const modeButtons = new Map()
  const modeRow = h('div', { class: 'qc-modes', role: 'group', 'aria-label': '写入到哪个域' })
  for (const mode of modes) {
    const button = h('button', {
      type: 'button', class: 'qc-mode', 'data-qc': 'mode', 'data-qc-mode': mode, 'aria-pressed': 'false',
      onClick: () => setMode(mode),
    }, safeIcon(icon, MODE_ICONS[mode]), h('span', { class: 'qc-mode-label', text: MODE_LABELS[mode] }))
    modeButtons.set(mode, button)
    modeRow.append(button)
  }

  const saveButton = h('button', {
    type: 'button', class: 'btn primary qc-save', 'data-qc': 'save', 'aria-keyshortcuts': 'Control+Enter Meta+Enter',
    onClick: () => void save(),
  }, '保存')

  const closeButton = h('button', {
    type: 'button', class: 'icon-button qc-close', 'data-qc': 'close', 'aria-label': '关闭快速捕获', title: '关闭 · Esc',
    onClick: () => close(),
  }, safeIcon(icon, 'close'))

  const dialog = h('dialog', {
    id: uid, class: 'qc-dialog', 'data-qc': 'dialog', 'data-qc-instance': String(instance),
    'aria-labelledby': titleId, 'aria-modal': 'true',
    // 关闭只同步界面状态：正在进行的保存由 save() 的 finally 收尾，不能在这里
    // 把 busy 清零，否则关掉再打开会在旧写入未完成时放行第二次保存。
    onClose: () => { dialog.removeAttribute('aria-busy') },
    onCancel: event => { event.preventDefault(); close() },
    onKeydown: event => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      close()
    },
  },
    h('header', { class: 'qc-head' },
      h('div', { class: 'qc-head-text' },
        h('h2', { class: 'qc-title', id: titleId, text: '快速捕获' }),
        h('p', { class: 'cap', text: '一处输入，按目标落到知识库、对话记忆或笔记本。' })),
      closeButton),
    h('div', { class: 'qc-body' },
      h('div', { class: 'col qc-field' },
        h('span', { class: 'label', text: '写入到' }), modeRow),
      h('label', { class: 'col qc-field' }, targetLabel, targetSelect),
      tagsField,
      h('label', { class: 'col qc-field' },
        h('span', { class: 'label', text: '内容' }), contentInput)),
    h('footer', { class: 'qc-foot' },
      h('div', { class: 'qc-feedback' }, statusLine, errorLine, targetHint),
      h('div', { class: 'qc-actions' },
        h('span', { class: 'qc-kbd-hint', text: 'Ctrl/⌘ + Enter 保存 · Esc 关闭' }), saveButton)))

  dock.append(dialog)

  // —— Rendering ———————————————————————————————————————————————————————
  function syncModes() {
    for (const [mode, button] of modeButtons) {
      const active = mode === state.mode
      button.setAttribute('aria-pressed', String(active))
      button.classList.toggle('active', active)
    }
    targetLabel.textContent = state.mode === 'notebook' ? '笔记类型' : '目标分组'
    targetSelect.setAttribute('aria-label', state.mode === 'notebook' ? '笔记类型' : '目标分组')
  }

  function updateTargetHint() {
    const list = availableTargets()
    if (list.length > 0) {
      targetHint.hidden = true
      targetHint.textContent = ''
      return
    }
    targetHint.hidden = false
    targetHint.textContent = state.mode === 'notebook'
      ? '笔记本还没有可用的笔记类型'
      : `${memoryScopeLabel(modeList())}还没有记忆组，请先在「数据库」里新建一个组`
  }

  function updateTargets() {
    const list = availableTargets()
    targetSelect.replaceChildren(...list.map(item => h('option', { value: item.id, text: item.label })))
    let id = currentTargetId()
    if (!list.some(item => item.id === id)) id = list[0]?.id ?? ''
    if (state.mode === 'notebook') state.noteType = id
    else state.groupIds[modeList()] = id
    targetSelect.value = id
    targetSelect.disabled = list.length === 0
    updateTargetHint()
    updateSaveButton()
  }

  function updateTagsField() {
    tagsField.hidden = state.mode === 'notebook'
  }

  function updateSaveButton() {
    const list = availableTargets()
    saveButton.disabled = state.busy || list.length === 0
    saveButton.textContent = state.busy ? '正在保存…' : '保存'
    // One write at a time: freeze the domain/target controls so the label the
    // user saw and the row we write cannot diverge mid-flight.
    targetSelect.disabled = state.busy || list.length === 0
    tagsInput.disabled = state.busy
    for (const button of modeButtons.values()) button.disabled = state.busy
    dialog.toggleAttribute('aria-busy', state.busy)
  }

  function showStatus(message) {
    statusLine.textContent = message
  }

  function showError(message) {
    const text = clean(message)
    errorLine.textContent = text
    errorLine.hidden = text === ''
    contentInput.setAttribute('aria-describedby', text === '' ? hintId : `${hintId} ${errorId}`)
    if (text === '') contentInput.removeAttribute('aria-invalid')
    else contentInput.setAttribute('aria-invalid', 'true')
  }

  function setMode(mode, { focus = true } = {}) {
    if (state.busy) return
    if (modes.includes(mode) && mode !== state.mode) {
      state.mode = mode
      showError('')
      showStatus('')
      syncModes()
      updateTagsField()
      updateTargets()
      persist()
    } else {
      syncModes()
      updateTagsField()
      updateTargets()
    }
    if (focus && dialog.open) contentInput.focus()
  }

  // —— Saving ——————————————————————————————————————————————————————————
  async function save() {
    if (state.busy || state.destroyed) return
    const problem = captureProblem({
      content: contentInput.value, mode: state.mode, targets: state.targets,
      groupId: state.groupIds[modeList()], noteType: state.noteType,
    })
    if (problem) {
      showError(problem)
      if (!dialog.open) open()
      contentInput.focus()
      return
    }
    const content = clean(contentInput.value)
    // Snapshot the destination before the first await: the label shown in the
    // feedback and the row actually written must come from the same state.
    const mode = state.mode
    const scope = mode === 'conversation' ? 'conversation' : 'knowledge'
    const noteType = state.noteType
    const groupId = state.groupIds[scope]
    const tagsText = state.tagsText
    const target = targetById(currentTargetId())
    const label = target?.label || (mode === 'notebook' ? MODE_LABELS.notebook : memoryScopeLabel(scope))
    state.busy = true
    updateSaveButton()
    showError('')
    try {
      if (mode === 'notebook') {
        if (typeof notebook !== 'function') throw new Error('笔记本域未连接')
        const payload = buildNotebookPayload({ content, type: noteType })
        const record = unwrap(await notebook('save', payload))
        if (!record || typeof record !== 'object' || clean(record.id) === '') throw new Error('笔记本保存返回异常，未能确认写入')
        // Read-back through a plain read op proves the row is really there —
        // a successful reply alone is not evidence the notebook kept it.
        const listed = unwrap(await notebook('list', { view: 'all', limit: 10, type: payload.type, order: 'updated' }))
        const records = Array.isArray(listed?.records) ? listed.records : []
        if (!records.some(row => row && row.id === record.id)) throw new Error('笔记已写入，但回读列表里没有找到它，请刷新笔记本确认')
      } else {
        if (typeof call !== 'function') throw new Error('记忆域未连接')
        const payload = buildMemoryEntryPayload({ content, tags: tagsText, scope, groupId })
        const saved = unwrap(await call('entry.write', payload))
        const entry = saved && typeof saved === 'object' && saved.entry ? saved.entry : saved
        if (!entry || typeof entry !== 'object' || clean(entry.id) === '') throw new Error('记忆保存返回异常，未能确认写入')
      }
      state.count += 1
      contentInput.value = ''
      contentInput.removeAttribute('aria-invalid')
      const message = `已保存到「${label}」 · 本次 ${state.count} 条`
      showStatus(message)
      appSay(message, 'ok')
      report({ tone: 'ok', message, count: state.count, mode, target: target ? { id: target.id, label: target.label, kind: target.kind } : null })
      if (dialog.open) contentInput.focus()
    } catch (error) {
      const message = readable(error)
      showStatus('')
      showError(message)
      try {
        appSay(message, 'err')
      } catch {
        /* The panel's inline error is the source of truth. */
      }
      report({ tone: 'err', message, count: state.count, mode, target: null })
      if (dialog.open) contentInput.focus()
    } finally {
      state.busy = false
      updateSaveButton()
    }
  }

  // —— Target override (`open(target)`) ———————————————————————————————
  function applyTarget(target) {
    if (!target) return
    if (typeof target === 'string') {
      const found = state.targets.find(item => item.id === target)
      if (found) {
        state.mode = found.kind === 'notebook' ? 'notebook' : scopeOf(found.scope)
        if (found.kind === 'notebook') state.noteType = found.id
        else state.groupIds[scopeOf(found.scope)] = found.id
      } else if (CAPTURE_MODES.includes(target)) {
        state.mode = target
      }
    } else if (typeof target === 'object') {
      if (CAPTURE_MODES.includes(target.mode)) state.mode = target.mode
      if (target.groupIds && typeof target.groupIds === 'object') {
        const knowledge = clean(target.groupIds.knowledge)
        const conversation = clean(target.groupIds.conversation)
        if (knowledge) state.groupIds.knowledge = knowledge
        if (conversation) state.groupIds.conversation = conversation
      }
      const groupId = clean(target.groupId)
      if (groupId) {
        if (state.mode === 'notebook') state.noteType = groupId
        else state.groupIds[modeList()] = groupId
      }
      const noteType = clean(target.noteType)
      if (noteType) state.noteType = noteType
      if (typeof target.tagsText === 'string') state.tagsText = target.tagsText
      if (typeof target.content === 'string' && contentInput.value === '') contentInput.value = target.content
    }
    syncModes()
    updateTagsField()
    updateTargets()
    persist()
  }

  // —— Public controller ———————————————————————————————————————————————
  function open(target) {
    if (state.destroyed) return false
    applyTarget(target)
    if(!modes.includes(state.mode))state.mode=modes[0]
    if (tagsInput.value !== state.tagsText) tagsInput.value = state.tagsText
    if (!dialog.open) dialog.showModal()
    contentInput.focus()
    return true
  }

  function close() {
    if (dialog.open) dialog.close()
    if (dialog.hasAttribute('aria-busy')) dialog.removeAttribute('aria-busy')
  }

  const isOpen = () => Boolean(dialog.open)
  const toggle = (target) => {
    if (isOpen()) {
      close()
      return false
    }
    return open(target)
  }

  /**
   * Replace the live target sources. Safe with empty/invalid input: the panel
   * keeps working and explains what is missing.
   * @param {{groups?: unknown, noteTypes?: unknown}} [sources]
   * @returns {object[]} The normalised target list.
   */
  function setTargets(sources = {}) {
    const source = sources && typeof sources === 'object' ? sources : {}
    state.targets = normalizeCaptureTargets({ groups: source.groups, noteTypes: source.noteTypes })
    syncModes()
    updateTagsField()
    updateTargets()
    return state.targets
  }

  function destroy() {
    if (state.destroyed) return
    state.destroyed = true
    close()
    dialog.remove()
    state.targets = []
  }

  syncModes()
  updateTagsField()
  updateTargets()
  tagsInput.value = state.tagsText

  return { open, close, isOpen, toggle, setTargets, destroy }
}
