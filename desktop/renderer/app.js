/**
 * The desktop window's interface.
 *
 * Plain DOM on purpose: the app ships one HTML file, one script and one
 * stylesheet, so there is no bundler to run and nothing to keep in sync with a
 * framework version. Every action goes through `window.vault.invoke`, which the
 * preload narrows to the vault's own operation table — this file never touches
 * a file, a socket, or a database.
 *
 * The board keeps the hierarchy the vault is organised by: a section per
 * **root** group, sub-headings by each memory's own first label inside it, and
 * hidden memories quarantined into a last section of their own.
 */

import { ownTags, section, subsection, SYSTEM_TAGS } from './grouping.js'

const el = (id) => document.getElementById(id)

const state = {
  /** @type {Record<string, any>|null} */ data: null,
  /** @type {{ kind: 'all'|'scope'|'hidden'|'group', id?: string }} */ view: { kind: 'all' },
  /** @type {string} */ query: '',
  /** @type {Record<string, any>|null} */ selected: null,
  /** @type {Record<string, any>|null} */ cure: null,
  /** @type {boolean} */ busy: false,
  /** @type {string[]} */ open: [],
}

/**
 * Call one vault operation.
 * @param {string} op - Operation name.
 * @param {Record<string, unknown>} [body] - Operation body.
 * @returns {Promise<Record<string, any>>} The result.
 */
async function call(op, body = {}) {
  const reply = await window.vault.invoke(op, body)
  if (reply === undefined || reply.ok !== true) {
    throw new Error(reply?.error ?? `${op} 失败`)
  }
  return reply.result ?? {}
}

/**
 * Say something in the status line.
 * @param {string} message - Text to show.
 * @param {'info'|'ok'|'err'} [tone] - How to show it.
 * @returns {void}
 */
function say(message, tone = 'info') {
  const node = el('status')
  node.textContent = message
  node.className = `status ${tone === 'info' ? '' : tone}`
}

/**
 * Run an action, reporting failure without losing the window.
 * @param {() => Promise<void>} action - Work to run.
 * @returns {Promise<void>} Resolution once it finished or failed.
 */
async function guard(action) {
  if (state.busy) return
  state.busy = true
  try {
    await action()
  } catch (error) {
    say(error instanceof Error ? error.message : String(error), 'err')
  } finally {
    state.busy = false
  }
}

/** Reload the vault state and the current view. */
async function load() {
  state.data = await call('state')
  const wanted = el('query').value.trim()
  state.query = wanted
  const result = await call('entries', {
    limit: 300,
    includeHidden: state.view.kind === 'hidden' ? true : true,
    ...(wanted === '' ? {} : { query: wanted }),
  })
  state.data.entries = Array.isArray(result.entries) ? result.entries : []
  if (state.selected !== null) {
    const fresh = state.data.entries.find((entry) => entry.id === state.selected.id)
    state.selected = fresh ?? state.selected
  }
  render()
}

/** The root group name an entry files under. */
function rootOf(entry) {
  const group = (state.data?.groups ?? []).find((item) => item.id === entry.groupId)
  if (group === undefined) return entry.groupName ?? '未分组'
  const path = Array.isArray(group.path) ? group.path : []
  return path.length > 0 ? path[0] : group.name
}

/** The entries the current view shows, before sectioning. */
function visible() {
  const rows = state.data?.entries ?? []
  if (state.view.kind === 'scope') return rows.filter((entry) => entry.scope === state.view.id)
  if (state.view.kind === 'hidden') return rows.filter((entry) => entry.hidden === true)
  if (state.view.kind === 'group') {
    const group = (state.data?.groups ?? []).find((item) => item.id === state.view.id)
    if (group === undefined) return rows
    const path = Array.isArray(group.path) ? group.path : []
    const roots = path.length > 0 ? path[0] : group.name
    return rows.filter((entry) => rootOf(entry) === roots)
  }
  return rows
}

/**
 * Build a DOM node.
 * @param {string} tag - Element name.
 * @param {Record<string, any>} [props] - Properties and attributes.
 * @param {(Node|string|null|undefined)[]} [children] - Child nodes.
 * @returns {HTMLElement} The element.
 */
function h(tag, props = {}, children = []) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') node.className = String(value)
    else if (key === 'text') node.textContent = String(value)
    else if (key === 'onClick') node.addEventListener('click', value)
    else if (key === 'onChange') node.addEventListener('change', value)
    else if (key === 'onInput') node.addEventListener('input', value)
    else if (key === 'onKeyDown') node.addEventListener('keydown', value)
    else node.setAttribute(key, String(value))
  }
  for (const child of children) {
    if (child === null || child === undefined) continue
    node.append(typeof child === 'string' ? document.createTextNode(child) : child)
  }
  return node
}

/** A tag pill. */
function tag(text, tone = '') {
  return h('span', { class: tone === '' ? 'tag' : `tag ${tone}`, text })
}

/** Draw the sidebar. */
function renderSide() {
  const stats = state.data?.stats ?? { totals: { entries: 0 }, hidden: 0 }
  const groups = state.data?.groups ?? []
  const views = el('views')
  views.replaceChildren()
  const view = (kind, label, count, id) => h('button', {
    class: state.view.kind === kind && state.view.id === id ? 'nav on' : 'nav',
    onClick: () => { state.view = { kind, ...(id === undefined ? {} : { id }) }; void guard(load) },
  }, h('span', { text: label }), h('span', { class: 'count', text: String(count) }))
  views.append(
    view('all', '全部记忆', stats.totals.entries),
    view('scope', '知识库', stats.entries?.knowledge ?? 0, 'knowledge'),
    view('scope', '对话记忆', stats.entries?.conversation ?? 0, 'conversation'),
    view('hidden', '隐藏', stats.hidden ?? 0),
  )
  const tree = el('tree')
  tree.replaceChildren()
  const ordered = [...groups].sort((left, right) => {
    const leftKey = [...(left.path ?? []), left.name].join('\u0000')
    const rightKey = [...(right.path ?? []), right.name].join('\u0000')
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
  })
  for (const group of ordered) {
    const depth = Math.max(1, Number(group.depth ?? 1))
    tree.append(h('button', {
      class: state.view.kind === 'group' && state.view.id === group.id ? 'nav on' : 'nav',
      'data-depth': String(Math.min(3, depth)),
      onClick: () => { state.view = { kind: 'group', id: group.id }; void guard(load) },
    }, h('span', { text: group.name }), h('span', { class: 'count', text: String(group.entryCount ?? 0) })))
  }
}

/** Draw the list of memories. */
function renderList() {
  const rows = visible()
  const list = el('list')
  list.replaceChildren()
  const sections = section(rows, rootOf)
  if (sections.length === 0) {
    list.append(h('div', { class: 'empty', text: state.query === '' ? '这里还没有记忆。' : '没有匹配的记忆。' }))
    return
  }
  for (const sectionRow of sections) {
    const open = state.open.includes(sectionRow.key)
    const body = h('div', { class: open ? 'sec-body' : 'sec-body hidden' })
    const parts = subsection(sectionRow.entries)
    for (const part of parts) {
      const grid = h('div', { class: 'grid' }, part.entries.map((entry) => tile(entry)))
      body.append(parts.length > 1
        ? h('div', { class: 'sub' }, h('div', { class: 'sub-head' },
            h('span', { text: part.label }), h('span', { class: 'cap', text: String(part.entries.length) })), grid)
        : grid)
    }
    list.append(h('section', { class: 'sec' },
      h('div', {
        class: 'sec-head',
        onClick: () => {
          state.open = open ? state.open.filter((key) => key !== sectionRow.key) : [...state.open, sectionRow.key]
          renderList()
        },
      },
        h('span', { text: open ? '▾' : '▸' }),
        h('span', { text: sectionRow.label }),
        h('span', { class: 'count', text: `${sectionRow.entries.length} 条` })),
      body))
  }
}

/** One memory card. */
function tile(entry) {
  const title = entry.title === '' ? String(entry.content).slice(0, 40) : entry.title
  const group = (state.data?.groups ?? []).find((item) => item.id === entry.groupId)
  const root = rootOf(entry)
  return h('div', {
    class: entry.hidden === true ? 'tile hidden-tile' : 'tile',
    onClick: () => { state.selected = entry; renderDrawer() },
  },
    h('div', { class: 'tile-title', text: title }),
    h('div', { class: 'tile-body', text: String(entry.content).replace(/\s+/g, ' ').slice(0, 110) }),
    h('div', { class: 'tags' },
      entry.groupName !== root ? tag(entry.groupName ?? '') : null,
      entry.hidden === true ? tag('已隐藏', 'warn') : null,
      Number(entry.priority ?? 0) > 0 ? tag(`P${entry.priority}`, 'info') : null,
      entry.base === true ? tag('底层 prompt', 'ok') : null,
      ...ownTags(entry).slice(0, 3).map((item) => tag(item)),
      group === undefined ? null : null),
  )
}

/** Draw the detail drawer, or hide it. */
function renderDrawer() {
  const drawer = el('drawer')
  if (state.selected === null) {
    drawer.classList.add('hidden')
    return
  }
  const entry = state.selected
  drawer.classList.remove('hidden')
  const title = h('input', { class: 'input', value: entry.title ?? '' })
  const body = h('textarea', { class: 'area' })
  body.value = entry.content ?? ''
  const groups = state.data?.groups ?? []
  const group = h('select', { class: 'select' },
    ...groups.map((item) => h('option', { value: item.id, text: item.name, ...(item.id === entry.groupId ? { selected: 'selected' } : {}) })))
  group.value = entry.groupId
  const draft = h('input', { class: 'input', placeholder: '输入标签后回车' })
  const chips = h('div', { class: 'tags' }, ...ownTags(entry).map((item) => h('span', { class: 'chip' },
    item,
    h('button', {
      text: '×',
      title: '移除这个标签',
      onClick: () => { void guard(() => save({ tags: ownTags(entry).filter((tag2) => tag2 !== item) })) },
    }))))
  draft.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    const value = draft.value.trim()
    if (value === '' || SYSTEM_TAGS.includes(value)) return
    void guard(() => save({ tags: [...new Set([...ownTags(entry), value])] }))
  })

  /**
   * Write one patch onto the open memory.
   * @param {Record<string, unknown>} patch - Fields to change.
   * @returns {Promise<void>} Resolution after the reload.
   */
  async function save(patch) {
    await call('entry.update', { id: entry.id, ...patch })
    say('已保存', 'ok')
    await load()
    renderDrawer()
  }

  drawer.replaceChildren(
    h('div', { class: 'row' },
      h('h2', { text: '记忆' }),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn ghost', text: '关闭', onClick: () => { state.selected = null; renderDrawer() } })),
    h('div', { class: 'col' },
      h('span', { class: 'label', text: '标题' }),
      title,
      h('span', { class: 'label', text: '正文（Markdown）' }),
      body,
      h('div', { class: 'row' },
        h('button', {
          class: 'btn primary',
          text: '保存',
          onClick: () => { void guard(() => save({ title: title.value, content: body.value })) },
        }),
        h('button', {
          class: 'btn',
          text: '创建',
          onClick: () => { void guard(async () => {
            await call('entry.write', { groupId: group.value, content: body.value, title: title.value, tags: ownTags(entry) })
            say('已创建', 'ok')
            state.selected = null
            await load()
          }) },
        }),
        h('button', {
          class: 'btn',
          text: entry.hidden === true ? '恢复显示' : '隐藏',
          onClick: () => { void guard(async () => {
            // Visibility has its own operation: hiding is not an edit of the
            // memory, and `entry.update` deliberately does not carry it.
            await call('entry.hide', { ids: [entry.id], hidden: entry.hidden !== true })
            say(entry.hidden === true ? '已恢复显示' : '已隐藏', 'ok')
            await load()
            renderDrawer()
          }) },
        }),
        h('button', {
          class: 'btn',
          text: '删除',
          onClick: () => { void guard(async () => {
            if (!window.confirm('删除这条记忆？')) return
            await call('entry.delete', { id: entry.id })
            state.selected = null
            await load()
          }) },
        })),
      h('span', { class: 'label', text: '归属' }),
      h('div', { class: 'row' },
        h('button', {
          class: entry.scope === 'knowledge' ? 'btn primary' : 'btn',
          text: '知识库',
          onClick: () => { void guard(() => save({ scope: 'knowledge' })) },
        }),
        h('button', {
          class: entry.scope === 'conversation' ? 'btn primary' : 'btn',
          text: '对话记忆',
          onClick: () => { void guard(() => save({ scope: 'conversation' })) },
        })),
      h('span', { class: 'label', text: '记忆组' }),
      h('div', { class: 'row' }, group, h('button', {
        class: 'btn',
        text: '移入',
        onClick: () => { void guard(() => save({ groupId: group.value })) },
      })),
      h('span', { class: 'label', text: '优先级' }),
      h('div', { class: 'row' }, ...[0, 40, 70, 90].map((value) => h('button', {
        class: Number(entry.priority ?? 0) === value ? 'btn primary' : 'btn',
        text: value === 0 ? '0' : `P${value}`,
        onClick: () => { void guard(() => save({ priority: value })) },
      }))),
      h('span', { class: 'label', text: '底层 prompt（每次对话都注入，不占知识配额）' }),
      h('div', { class: 'row' }, h('button', {
        class: entry.base === true ? 'btn primary' : 'btn',
        text: entry.base === true ? '已开启' : '未开启',
        onClick: () => { void guard(() => save({ base: entry.base !== true })) },
      })),
      h('span', { class: 'label', text: '标签（就地增删）' }),
      chips,
      draft,
      h('div', { class: 'tags' }, ...(entry.tags ?? []).filter((item) => SYSTEM_TAGS.includes(item)).map((item) => tag(item, 'sys'))),
    ),
  )
}

/** Draw the curation result card. */
function renderCure() {
  const card = el('cure-card')
  if (state.cure === null) {
    card.classList.add('hidden')
    return
  }
  const cure = state.cure
  const items = cure.mode === 'applied' ? (cure.applied ?? []) : (cure.verdicts ?? [])
  card.classList.remove('hidden')
  card.replaceChildren(
    h('div', { class: 'row' },
      h('h3', { text: cure.mode === 'applied' ? '已归类' : '整理预览' }),
      h('span', { class: 'cap', text: `${cure.model?.provider ?? ''}/${cure.model?.model ?? ''}` }),
      h('span', { class: 'spacer' }),
      h('button', {
        class: 'btn ghost',
        text: '收起',
        onClick: () => { state.cure = null; renderCure() },
      })),
    ...items.map((item) => h('div', { class: 'kv' },
      tag(item.verdict === 'reusable' ? '可复用' : '单次性', item.verdict === 'reusable' ? 'ok' : ''),
      tag(item.origin ?? '', 'sys'),
      h('span', { class: 'reason', text: item.reason ?? '' }),
      item.group === undefined || item.group === '' ? null : tag(item.group))),
    (cure.tagMap ?? []).length === 0 ? null : h('div', { class: 'kv' },
      h('span', { class: 'label', text: '标签合并' }),
      ...(cure.tagMap ?? []).map((change) => {
        const done = (cure.tagChanges ?? []).find((row) => row.from === change.from)
        return h('span', { class: 'kv' },
          tag(change.from, 'sys'), h('span', { class: 'cap', text: '→' }),
          tag(change.to === '' ? '删除该标签' : change.to, change.to === '' ? 'warn' : 'info'),
          h('span', { class: 'cap', text: done === undefined ? String(change.reason ?? '') : `${done.updated} 条` }))
      })),
  )
}

/** Draw everything. */
function render() {
  renderSide()
  renderList()
  renderDrawer()
  renderCure()
  const stats = state.data?.stats ?? { totals: { entries: 0, groups: 0 }, hidden: 0 }
  el('foot-left').textContent = `${state.data?.groups?.length ?? 0} 个记忆组 · ${stats.totals.entries} 条记忆（隐藏 ${stats.hidden ?? 0}）`
}

el('curate').addEventListener('click', () => { void guard(async () => {
  const origin = el('curate-scope').value
  say('正在整理（会用一次模型调用）…')
  state.cure = await call('curate', { origin, apply: true, limit: 20 })
  say('整理完成', 'ok')
  await load()
}) })

el('curate-review').addEventListener('click', () => { void guard(async () => {
  const origin = el('curate-scope').value
  say('正在预览（会用一次模型调用）…')
  state.cure = await call('curate', { origin, apply: false, limit: 20 })
  say('预览完成，未写入任何改动', 'ok')
  renderCure()
}) })

el('new').addEventListener('click', () => {
  state.selected = {
    id: '', title: '', content: '', tags: [], scope: 'conversation', priority: 0, base: false, hidden: false,
    groupId: state.data?.groups?.[0]?.id ?? '', groupName: '',
  }
  renderDrawer()
  say('填好内容后按「创建」')
})

let timer
el('query').addEventListener('input', () => {
  clearTimeout(timer)
  timer = setTimeout(() => { void guard(load) }, 220)
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { state.selected = null; renderDrawer() }
})

window.vault.onNote((message) => { say(message) })
state.open = []
void guard(async () => {
  const info = await window.vault.info()
  el('foot-right').textContent = info.databasePath
  say('已打开记忆库')
  await load()
})
