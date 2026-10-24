/**
 * Real-interface smoke test for quick capture (runs inside the Electron main
 * process, driving the actual renderer and a temporary SQLite vault).
 *
 * Not a static mock: every save goes through the real preload IPC into the
 * temporary database, then the test reads the row back through a fresh query.
 * It asserts the two domains stay separate (memory entry vs notebook record),
 * that an empty body is refused before any write, that an IPC failure leaves
 * the typed text and shows a readable error, and that the panel's own UI
 * preference round-trips through localStorage without any IPC call.
 *
 * app.js does not wire this module yet, so the test mounts it itself with a
 * local `h` factory (the same ten lines as app.js), the real `window.vault`
 * channels and the real note-type metadata.
 */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const moduleURL = pathToFileURL(join(root, 'desktop', 'renderer', 'quick-capture.js')).href
const iconURL = pathToFileURL(join(root, 'desktop', 'renderer', 'icons.js')).href
const fieldsURL = pathToFileURL(join(root, 'addons', 'mistakebook', 'fields.mjs')).href

export async function run(window, bridge) {
  assert.match(bridge.databasePath, /capture-test[^\\/]*\.sqlite$/i, '必须跑在 capture-test 临时库上')

  const js = async source => {
    try {
      return await window.webContents.executeJavaScript(source)
    } catch (error) {
      throw new Error(`注入脚本失败：${error?.message ?? error}\n${source}`)
    }
  }
  const sleep = ms => new Promise(done => setTimeout(done, ms))
  const until = async (expression, label = expression) => {
    for (let index = 0; index < 600; index++) {
      if (await js(expression)) return
      await sleep(30)
    }
    throw new Error(`界面超时：${label}`)
  }
  const shotIndex = process.argv.indexOf('--shot')
  const shotDirectory = shotIndex > 0 && process.argv[shotIndex + 1] ? dirname(resolve(process.argv[shotIndex + 1])) : null
  const shot = async name => {
    if (!shotDirectory) return
    mkdirSync(shotDirectory, { recursive: true })
    await sleep(150)
    writeFileSync(join(shotDirectory, `${name}.png`), (await window.webContents.capturePage()).toPNG())
  }

  const DIALOG = tier => `[data-qc="dialog"][data-qc-instance="${tier}"]`
  const part = (tier, name) => `${DIALOG(tier)} [data-qc="${name}"]`
  const value = selector => js(`document.querySelector(${JSON.stringify(selector)})?.value ?? null`)
  const textOf = selector => js(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`)
  const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const setValue = (selector, text) => js(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)})
    node.value = ${JSON.stringify(text)}
    node.dispatchEvent(new Event('input', { bubbles: true }))
    return node.value
  })()`)
  const setSelect = (selector, id) => js(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)})
    node.value = ${JSON.stringify(id)}
    node.dispatchEvent(new Event('change', { bubbles: true }))
    return node.value
  })()`)
  const pressEnter = (selector, init = {}) => js(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)})
    node.focus()
    node.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({ key: 'Enter', bubbles: true, cancelable: true, ...init })}))
    return true
  })()`)
  const entries = query => js(`(async () => {
    const reply = await window.vault.invoke('entries', { query: ${JSON.stringify(query)}, limit: 20 })
    if (reply?.ok !== true) throw new Error(reply?.error ?? 'entries 失败')
    return reply.result.entries.map(row => ({
      id: row.id, title: row.title, content: row.content, kind: row.kind, tags: row.tags,
      scope: row.scope, groupId: row.groupId, hidden: row.hidden,
    }))
  })()`)
  const noteRecords = body => js(`(async () => {
    const reply = await window.vault.notebook('list', ${JSON.stringify(body)})
    if (reply?.ok !== true) throw new Error(reply?.error ?? 'notebook.list 失败')
    return reply.result.records.map(row => ({ id: row.id, type: row.type, title: row.title, stem: row.stem, tags: row.tags }))
  })()`)
  const counts = () => js(`(async () => {
    const [state, listed] = await Promise.all([
      window.vault.invoke('state'),
      window.vault.notebook('list', { view: 'all', limit: 1 }),
    ])
    return {
      entries: state?.ok ? state.result.stats.totals.entries : -1,
      notes: listed?.ok ? listed.result.stats.all : -1,
    }
  })()`)
  const prefs = () => js(`(() => { const raw = localStorage.getItem('alaya.db.capture'); return raw ? JSON.parse(raw) : null })()`)

  // —— 0. 启动就绪与临时库里的两个域 ———————————————————————————————
  await until("Boolean(window.vault && window.vault.invoke && window.vault.notebook)", 'preload 通道就绪')
  await until("document.querySelector('#alaya-startup')===null", '启动动画结束')
  const group = async (name, scope) => js(`(async () => {
    const reply = await window.vault.invoke('group.create', { name: ${JSON.stringify(name)}, scope: ${JSON.stringify(scope)} })
    if (reply?.ok !== true) throw new Error(reply?.error ?? 'group.create 失败')
    return reply.result.group
  })()`)
  const knowledgeGroup = await group('捕获测试组', 'knowledge')
  const conversationGroup = await group('对话捕获组', 'conversation')
  assert.equal(knowledgeGroup.scope, 'knowledge')
  assert.equal(conversationGroup.scope, 'conversation')

  // —— 1. 自己搭最小环境：本地 h + 真实 IPC + 真实 NOTE_TYPES ————
  const mounted = await js(`(async () => {
    const capture = await import(${JSON.stringify(moduleURL)})
    const { icon } = await import(${JSON.stringify(iconURL)})
    const { NOTE_TYPES } = await import(${JSON.stringify(fieldsURL)})
    const h = (tag, props = {}, ...children) => {
      const node = document.createElement(tag)
      for (const [key, value] of Object.entries(props)) {
        if (value === undefined || value === null || value === false) continue
        if (key === 'class') node.className = value
        else if (key === 'text') node.textContent = value
        else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value)
        else if (['value', 'checked', 'disabled'].includes(key)) node[key] = value
        else node.setAttribute(key, String(value))
      }
      for (const child of children.flat(Infinity)) if (child !== null && child !== undefined && child !== false) node.append(child instanceof Node ? child : String(child))
      return node
    }
    const calls = { memory: [], notebook: [] }
    const call = async (op, body = {}) => {
      calls.memory.push(op)
      const reply = await window.vault.invoke(op, body)
      if (reply?.ok !== true) throw new Error(reply?.error ?? '记忆域调用失败')
      return reply.result
    }
    const notebook = async (op, body = {}) => {
      calls.notebook.push(op)
      const reply = await window.vault.notebook(op, body)
      if (reply?.ok !== true) throw new Error(reply?.error ?? '笔记本调用失败')
      return reply.result
    }
    const said = []
    const say = (message, tone = 'info') => { said.push({ message, tone }) }
    const reports = []
    const qc = capture.mountQuickCapture({ h, icon, call, notebook, say, onStatus: status => reports.push(status) })
    const reply = await window.vault.invoke('state')
    if (reply?.ok !== true) throw new Error(reply?.error ?? 'state 失败')
    const groups = reply.result.groups
    const targets = qc.setTargets({ groups, noteTypes: NOTE_TYPES })
    window.__qc = { qc, h, icon, call, notebook, NOTE_TYPES, groups, said, reports, calls, mount: capture.mountQuickCapture, normalizeCaptureTargets: capture.normalizeCaptureTargets }
    return {
      targets,
      groups: groups.map(row => ({ id: row.id, name: row.name, scope: row.scope, path: row.path })),
      noteTypes: Object.keys(NOTE_TYPES),
    }
  })()`)
  assert.deepEqual(mounted.noteTypes.slice().sort(), ['method', 'mistake', 'note', 'physics', 'vocabulary'])
  assert.ok(mounted.targets.some(item => item.kind === 'memory' && item.id === knowledgeGroup.id))
  assert.ok(mounted.targets.some(item => item.kind === 'memory' && item.id === conversationGroup.id))
  assert.ok(mounted.targets.some(item => item.kind === 'notebook' && item.id === 'note'))
  assert.equal(mounted.targets[0].kind, 'memory', '记忆域目标排在前面')

  // —— 2. 打开：模态、聚焦、样式、aria、Tab 可达 —————————————————
  await js('window.__qc.qc.open()')
  await until(`document.querySelector(${JSON.stringify(DIALOG(1))})?.open === true`, '面板打开')
  assert.equal(await js('window.__qc.qc.isOpen()'), true)
  assert.equal(await js(`document.activeElement === document.querySelector(${JSON.stringify(part(1, 'input'))})`), true, '打开即聚焦输入框')
  await until("document.getElementById('alaya-quick-capture-style') !== null", '面板样式表注入')
  const style = await js(`(() => {
    const node = document.querySelector(${JSON.stringify(DIALOG(1))})
    const computed = getComputedStyle(node)
    return { width: parseFloat(computed.width), background: computed.backgroundColor, animation: computed.animationName, transition: computed.transitionDuration, position: computed.position }
  })()`)
  assert.ok(style.width > 320 && style.width <= 560, `面板宽度应克制（实际 ${style.width}px）`)
  assert.equal(style.background, 'rgb(255, 255, 255)', '沿用 --surface')
  assert.equal(style.animation, 'none', '面板不做入场动画')
  assert.equal(style.transition, '0s', '面板不做过渡')
  const aria = await js(`(() => {
    const dialog = document.querySelector(${JSON.stringify(DIALOG(1))})
    const labelledby = document.getElementById(dialog.getAttribute('aria-labelledby'))
    const modes = [...dialog.querySelectorAll('[data-qc="mode"]')]
    return {
      modal: dialog.getAttribute('aria-modal'),
      label: labelledby?.textContent,
      modeLabels: modes.map(node => node.textContent.trim()),
      pressed: modes.filter(node => node.getAttribute('aria-pressed') === 'true').length,
      input: dialog.querySelector('[data-qc="input"]').getAttribute('aria-label'),
      target: dialog.querySelector('[data-qc="target"]').getAttribute('aria-label'),
      tags: dialog.querySelector('[data-qc="tags"]').getAttribute('aria-label'),
      save: dialog.querySelector('[data-qc="save"]').textContent,
      keys: dialog.querySelector('[data-qc="save"]').getAttribute('aria-keyshortcuts'),
      status: dialog.querySelector('[data-qc="status"]').getAttribute('role'),
      error: dialog.querySelector('[data-qc="error"]').getAttribute('role'),
      close: dialog.querySelector('[data-qc="close"]').getAttribute('aria-label'),
      focusables: dialog.querySelectorAll('button, select, input, textarea').length,
    }
  })()`)
  assert.equal(aria.modal, 'true')
  assert.equal(aria.label, '快速捕获')
  assert.deepEqual(aria.modeLabels, ['知识库', '对话记忆', '笔记本'])
  assert.equal(aria.pressed, 1, '分段控件只有一个是选中态')
  assert.equal(aria.input, '捕获内容')
  assert.equal(aria.target, '目标分组')
  assert.match(aria.tags, /标签/)
  assert.equal(aria.save, '保存')
  assert.match(aria.keys, /Control\+Enter/)
  assert.equal(aria.status, 'status')
  assert.equal(aria.error, 'alert')
  assert.equal(aria.close, '关闭快速捕获')
  assert.ok(aria.focusables >= 8, '所有控件都可用 Tab 到达')

  // —— 3. 输入法组字中的 Enter 不得触发保存 ——————————————————————
  const imeToken = `IME组字-${Date.now()}`
  await setValue(part(1, 'input'), imeToken)
  await js(`(() => {
    const node = document.querySelector(${JSON.stringify(part(1, 'input'))})
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    Object.defineProperty(event, 'isComposing', { value: true })
    node.dispatchEvent(event)
    return true
  })()`)
  await sleep(250)
  assert.equal(await js(`document.querySelector(${JSON.stringify(DIALOG(1))}).open`), true, '组字中面板保持打开')
  assert.deepEqual(await entries(imeToken), [], '组字中的 Enter 不写入任何记忆')
  assert.equal((await textOf(part(1, 'status'))) ?? '', '')

  // —— 4. 记忆域：真写临时库并用 entries 读回 ————————————————————
  await click(part(1, 'mode') + '[data-qc-mode="knowledge"]')
  await until(`document.querySelector(${JSON.stringify(`${part(1, 'mode')}[data-qc-mode="knowledge"]`)}).getAttribute('aria-pressed')==='true'`, '切到知识库')
  assert.equal(await value(part(1, 'target')), knowledgeGroup.id, '知识库分段只列知识库分组')
  assert.equal(await js(`document.querySelector(${JSON.stringify(part(1, 'tags-field'))}).hidden`), false, '记忆域显示标签输入')
  assert.equal(await value(part(1, 'tags')), '收件箱', '标签默认收件箱')

  const memoryToken = `捕获记忆-${Date.now()}`
  const memoryBody = `${memoryToken}\n第二行：把想法落进知识库。`
  await setValue(part(1, 'input'), memoryBody)
  await pressEnter(part(1, 'input'), { ctrlKey: true })
  await until(`document.querySelector(${JSON.stringify(part(1, 'status'))}).textContent.includes('已保存到')`, '记忆保存反馈')
  await until(`document.querySelector(${JSON.stringify(DIALOG(1))}).hasAttribute('aria-busy') === false`, '保存结束')
  const firstStatus = await textOf(part(1, 'status'))
  assert.match(firstStatus, /已保存到「.*捕获测试组.*」/)
  assert.match(firstStatus, /本次 1 条/, '显示本次会话累计条数')
  assert.equal(await value(part(1, 'input')), '', '保存成功后清空输入')
  assert.equal(await js(`document.activeElement === document.querySelector(${JSON.stringify(part(1, 'input'))})`), true, '焦点回到输入框')
  const said = await js('window.__qc.said.slice(-1)')
  assert.equal(said.at(-1).tone, 'ok')
  assert.match(said.at(-1).message, /已保存到/)
  const reports = await js('window.__qc.reports.slice(-1)')
  assert.equal(reports.at(-1).tone, 'ok')
  assert.equal(reports.at(-1).count, 1)
  assert.equal(reports.at(-1).target.kind, 'memory')

  const savedMemory = await entries(memoryToken)
  assert.equal(savedMemory.length, 1, `应能用 entries 读回刚写入的记忆：${JSON.stringify(savedMemory)}`)
  assert.equal(savedMemory[0].groupId, knowledgeGroup.id)
  assert.equal(savedMemory[0].scope, 'knowledge')
  assert.equal(savedMemory[0].kind, 'note')
  assert.equal(savedMemory[0].title, memoryToken)
  assert.match(savedMemory[0].content, /第二行/)
  assert.deepEqual(savedMemory[0].tags.filter(tag => tag !== '人工输入'), ['收件箱'], '标签默认收件箱（人工输入由库作为来源标签补入）')
  assert.equal(await js("window.__qc.calls.memory.length"), 1)
  assert.equal(await js("window.__qc.calls.notebook.length"), 0, '记忆保存不得触碰笔记本域')

  // 自定义标签：去空、去重（全角逗号也识别）
  await setValue(part(1, 'tags'), '收件箱, 测试标签，测试标签')
  await js(`document.querySelector(${JSON.stringify(part(1, 'tags'))}).dispatchEvent(new Event('change', { bubbles: true }))`)
  const taggedToken = `捕获标签-${Date.now()}`
  await setValue(part(1, 'input'), taggedToken)
  await pressEnter(part(1, 'input'))
  await until(`document.querySelector(${JSON.stringify(part(1, 'status'))}).textContent.includes('本次 2 条')`, '第二记忆保存')
  await until(`document.querySelector(${JSON.stringify(DIALOG(1))}).hasAttribute('aria-busy') === false`, '第二记忆结束')
  const tagged = await entries(taggedToken)
  assert.equal(tagged.length, 1)
  assert.deepEqual(tagged[0].tags.filter(tag => tag !== '人工输入'), ['收件箱', '测试标签'], '标签归一化：去空去重')
  assert.equal(await js("window.__qc.calls.memory.length"), 2)

  // —— 5. 对话记忆分段：选择切换不触发任何 IPC ——————————————————
  await click(part(1, 'mode') + '[data-qc-mode="conversation"]')
  await until(`document.querySelector(${JSON.stringify(`${part(1, 'mode')}[data-qc-mode="conversation"]`)}).getAttribute('aria-pressed')==='true'`, '切到对话记忆')
  assert.equal(await value(part(1, 'target')), conversationGroup.id, '对话记忆分段只列对话记忆分组')
  assert.equal(await js("window.__qc.calls.memory.length"), 2, '只切换分段不得写库')
  assert.equal(await js("window.__qc.calls.notebook.length"), 0)

  // —— 6. 笔记本域：真写临时库并用 notebook.list 读回 ————————————
  await click(part(1, 'mode') + '[data-qc-mode="notebook"]')
  await until(`document.querySelector(${JSON.stringify(`${part(1, 'mode')}[data-qc-mode="notebook"]`)}).getAttribute('aria-pressed')==='true'`, '切到笔记本')
  await until(`document.querySelector(${JSON.stringify(part(1, 'target'))}).value === 'note'`, '默认笔记类型')
  assert.equal(await js(`document.querySelector(${JSON.stringify(part(1, 'tags-field'))}).hidden`), true, '笔记本域隐藏标签输入')
  assert.equal(await js(`document.querySelector(${JSON.stringify(part(1, 'target'))}).disabled`), false)
  assert.equal(await js(`document.querySelector(${JSON.stringify(part(1, 'target'))}).getAttribute('aria-label')`), '笔记类型')

  const noteToken = `捕获笔记-${Date.now()}`
  await setValue(part(1, 'input'), `${noteToken}\n笔记本正文：一处输入，落进笔记。`)
  await pressEnter(part(1, 'input'), { metaKey: true })
  await until(`document.querySelector(${JSON.stringify(part(1, 'status'))}).textContent.includes('本次 3 条')`, '笔记保存反馈')
  await until(`document.querySelector(${JSON.stringify(DIALOG(1))}).hasAttribute('aria-busy') === false`, '笔记保存结束')
  const noteStatus = await textOf(part(1, 'status'))
  assert.match(noteStatus, /已保存到「笔记」/)
  assert.match(noteStatus, /本次 3 条/, '三条合计')
  // 主进程在测试结束时会用 --shot 的同名文件覆盖最终界面，所以这里另存一份
  // “面板打开中”的截图，避免被收尾截图盖掉。
  await shot('capture-panel-open')

  const listedNotes = await noteRecords({ view: 'all', limit: 10, type: 'note', order: 'updated' })
  const savedNote = listedNotes.find(row => row.stem.includes(noteToken))
  assert.ok(savedNote, `notebook.list 应能读回刚写入的笔记：${JSON.stringify(listedNotes)}`)
  assert.equal(savedNote.type, 'note')
  assert.equal(savedNote.title, noteToken)
  assert.deepEqual(await entries(noteToken), [], '笔记本内容不得写进记忆域')
  assert.equal(await js("window.__qc.calls.memory.length"), 2, '笔记本保存不调用记忆域')
  assert.equal(await js("window.__qc.calls.notebook.length"), 2, '笔记本 save + list 各一次')

  // —— 7. 偏好只落 localStorage，不是数据库 meta ————————————————
  const storedPrefs = await prefs()
  assert.ok(storedPrefs, '面板偏好应写入 alaya.db.capture')
  assert.equal(storedPrefs.mode, 'notebook')
  assert.equal(storedPrefs.noteType, 'note')
  assert.equal(storedPrefs.groupIds.knowledge, knowledgeGroup.id)
  assert.equal(storedPrefs.groupIds.conversation, conversationGroup.id)
  assert.equal(storedPrefs.tagsText, '收件箱, 测试标签，测试标签')
  const metaProbe = await js(`(async () => {
    const reply = await window.vault.notebook('list', { view: 'all', limit: 1 })
    return { ok: reply?.ok === true, hasPanelKey: JSON.stringify(reply?.result ?? {}).includes('alaya.db.capture') }
  })()`)
  assert.equal(metaProbe.ok, true)
  assert.equal(metaProbe.hasPanelKey, false, '数据库读取结果里不应出现面板偏好键')

  // —— 8. 空正文：内联报错，不写库，输入保留 ————————————————————
  const before = await counts()
  await setValue(part(1, 'input'), '   ')
  await click(part(1, 'save'))
  await until(`document.querySelector(${JSON.stringify(part(1, 'error'))}).textContent.includes('请先输入内容')`, '空正文报错')
  const emptyError = await js(`(() => {
    const dialog = document.querySelector(${JSON.stringify(DIALOG(1))})
    return {
      open: dialog.open,
      invalid: dialog.querySelector('[data-qc="input"]').getAttribute('aria-invalid'),
      hidden: dialog.querySelector('[data-qc="error"]').hidden,
      value: dialog.querySelector('[data-qc="input"]').value,
    }
  })()`)
  assert.equal(emptyError.open, true, '空正文被拒后面板保持打开')
  assert.equal(emptyError.invalid, 'true')
  assert.equal(emptyError.hidden, false)
  assert.equal(emptyError.value, '   ', '被拒时保留用户输入')
  const after = await counts()
  assert.deepEqual(after, before, '空正文不得写入记忆或笔记')

  // —— 9. IPC 抛错：显示可读错误，输入不丢，可重试 ————————————————
  const failingMount = await js(`(async () => {
    const host = document.createElement('div')
    host.id = 'qc-error-host'
    document.body.append(host)
    const fail = async () => { throw new Error('模拟 IPC 断开') }
    const said = []
    const reports = []
    const qc = window.__qc.mount({
      h: window.__qc.h, icon: window.__qc.icon, call: fail, notebook: fail,
      say: (message, tone) => said.push({ message, tone }), mount: host, onStatus: status => reports.push(status),
    })
    qc.setTargets({ groups: window.__qc.groups, noteTypes: window.__qc.NOTE_TYPES })
    qc.open({ mode: 'knowledge', groupId: ${JSON.stringify(knowledgeGroup.id)} })
    window.__qc2 = { qc, said, reports, host }
    return { open: qc.isOpen(), target: document.querySelector('[data-qc-instance="2"] [data-qc="target"]').value }
  })()`)
  assert.equal(failingMount.open, true)
  assert.equal(failingMount.target, knowledgeGroup.id, 'open(target) 应选中指定分组')
  const retryToken = `失败重试-${Date.now()}`
  await setValue(part(2, 'input'), retryToken)
  await pressEnter(part(2, 'input'), { ctrlKey: true })
  await until(`document.querySelector(${JSON.stringify(part(2, 'error'))}).textContent.includes('模拟 IPC 断开')`, 'IPC 错误可见')
  const failed = await js(`(() => {
    const dialog = document.querySelector(${JSON.stringify(DIALOG(2))})
    return {
      open: dialog.open,
      value: dialog.querySelector('[data-qc="input"]').value,
      status: dialog.querySelector('[data-qc="status"]').textContent,
      invalid: dialog.querySelector('[data-qc="input"]').getAttribute('aria-invalid'),
      said: window.__qc2.said.slice(-1),
      reports: window.__qc2.reports.slice(-1),
    }
  })()`)
  assert.equal(failed.open, true, '保存失败时面板保持打开')
  assert.equal(failed.value, retryToken, '失败时保留输入以便重试')
  assert.equal(failed.status, '', '失败时清掉上一条成功提示')
  assert.equal(failed.invalid, 'true')
  assert.equal(failed.said.at(-1).tone, 'err')
  assert.match(failed.said.at(-1).message, /模拟 IPC 断开/)
  assert.equal(failed.reports.at(-1).tone, 'err')

  // 坏数据兜底：目标列表为空时禁用下拉并给出可读提示，不崩
  await js('window.__qc2.qc.setTargets({ groups: [], noteTypes: null })')
  const emptyTargets = await js(`(() => {
    const dialog = document.querySelector(${JSON.stringify(DIALOG(2))})
    return {
      open: dialog.open,
      disabled: dialog.querySelector('[data-qc="target"]').disabled,
      options: dialog.querySelectorAll('[data-qc="target"] option').length,
      hint: dialog.querySelector('[data-qc="hint"]').textContent,
      hintHidden: dialog.querySelector('[data-qc="hint"]').hidden,
    }
  })()`)
  assert.equal(emptyTargets.open, true)
  assert.equal(emptyTargets.disabled, true)
  assert.equal(emptyTargets.options, 0)
  assert.equal(emptyTargets.hintHidden, false)
  assert.match(emptyTargets.hint, /还没有记忆组/)
  await pressEnter(part(2, 'input'), { ctrlKey: true })
  await until(`document.querySelector(${JSON.stringify(part(2, 'error'))}).textContent.includes('还没有记忆组')`, '空目标报错')
  assert.equal(await value(part(2, 'input')), retryToken, '空目标被拒时输入仍在')
  await js('window.__qc2.qc.destroy()')
  assert.equal(await js(`document.querySelector(${JSON.stringify(DIALOG(2))}) === null`), true, 'destroy 移除面板')
  assert.equal(await js("document.getElementById('qc-error-host').childElementCount"), 0)

  // —— 10. 重挂载恢复偏好；open(target)/toggle/Escape —————————————
  await js('window.__qc.qc.destroy()')
  const restored = await js(`(async () => {
    const host = document.createElement('div')
    host.id = 'qc-restore-host'
    document.body.append(host)
    const qc = window.__qc.mount({ h: window.__qc.h, icon: window.__qc.icon, call: window.__qc.call, notebook: window.__qc.notebook, mount: host })
    qc.setTargets({ groups: window.__qc.groups, noteTypes: window.__qc.NOTE_TYPES })
    window.__qc3 = qc
    qc.open()
    const dialog = document.querySelector('[data-qc-instance="3"]')
    return {
      knowledgePressed: dialog.querySelector('[data-qc-mode="knowledge"]').getAttribute('aria-pressed'),
      notebookPressed: dialog.querySelector('[data-qc-mode="notebook"]').getAttribute('aria-pressed'),
      target: dialog.querySelector('[data-qc="target"]').value,
      tagsHidden: dialog.querySelector('[data-qc="tags-field"]').hidden,
    }
  })()`)
  // 失败的实例用 open({mode:'knowledge'}) 显式切换过域，所以“上次的域”就是知识库；
  // 笔记类型与分组选择仍按域分别保存。
  assert.equal(restored.knowledgePressed, 'true', '重开恢复上次的域')
  assert.equal(restored.notebookPressed, 'false')
  assert.equal(restored.target, knowledgeGroup.id, '重开恢复上次的知识库分组')
  assert.equal(restored.tagsHidden, false)

  await js("window.__qc3.open({ mode: 'notebook' })")
  assert.equal(await value(part(3, 'target')), 'note', '重开恢复上次的笔记类型')

  await js(`window.__qc3.open({ mode: 'knowledge', groupId: ${JSON.stringify(knowledgeGroup.id)} })`)
  assert.equal(await js(`document.querySelector('[data-qc-instance="3"] [data-qc-mode="knowledge"]').getAttribute('aria-pressed')`), 'true')
  assert.equal(await value(part(3, 'target')), knowledgeGroup.id, 'open({mode,groupId}) 落到指定分组')

  const escape = async () => js(`(() => {
    const node = document.querySelector(${JSON.stringify(part(3, 'input'))})
    node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    return true
  })()`)
  await escape()
  await until(`document.querySelector(${JSON.stringify(DIALOG(3))}).open === false`, 'Escape 关闭')
  assert.equal(await js('window.__qc3.isOpen()'), false)
  assert.equal(await js('window.__qc3.toggle()'), true, 'toggle 打开')
  assert.equal(await js('window.__qc3.toggle()'), false, 'toggle 关闭')
  await js('window.__qc3.destroy()')
  assert.equal(await js("document.getElementById('qc-restore-host').childElementCount"), 0)

  const leftovers = await js(`document.querySelectorAll('[data-qc="dialog"]').length`)
  assert.equal(leftovers, 0, 'destroy 后不残留面板')
  assert.equal(await js("document.querySelectorAll('link#alaya-quick-capture-style').length"), 1, '样式表只注入一次')

  console.log('desktop-capture: OK — 记忆域写入/读回、笔记本域写入/读回、空正文拒绝、IPC 错误兜底、偏好恢复、Escape/toggle 全部通过')
}
