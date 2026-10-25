/**
 * 预览桥（只在浏览器预览里存在，不打包）：给渲染层一个假的 window.vault。
 *
 * 目的：在没有 Electron 的环境（headless Chromium）里真实渲染桌面 UI，
 * 用于视觉走查与截图回归。数据是固定的演示数据，op 语义与真实 vault 对齐到
 * 「界面需要的最小面」：state / entries / group.* / entry.* / image.* / settings*。
 */
/* global window */

// 渲染层的异常在 headless 里没有控制台可看：收进 body 的 data 属性，--dump 时能读到。
const errors = []
const record = message => {
  errors.push(String(message).slice(0, 300))
  if (document.body) document.body.dataset.previewErrors = errors.join(' | ')
}
window.addEventListener('error', event => record(event.message ?? event.error))
window.addEventListener('unhandledrejection', event => record(`rejection: ${event.reason?.message ?? event.reason}`))
Object.defineProperty(window, '__previewErrors', { get: () => errors })

const now = Date.now()
const day = 24 * 60 * 60 * 1000

const groups = [
  { id: 'g-work', name: '工作', parentId: null, depth: 1, path: [], entryCount: 3 },
  { id: 'g-work-dsh', name: 'DSH', parentId: 'g-work', depth: 2, path: ['工作'], entryCount: 2 },
  { id: 'g-alaya', name: 'Alaya', parentId: null, depth: 1, path: [], entryCount: 3 },
  { id: 'g-life', name: '生活', parentId: null, depth: 1, path: [], entryCount: 1 },
]

const entries = [
  {
    id: 'e-1', title: 'Alaya 架构总原则：笔记本是数据库核心的扩充',
    content: '笔记本是 Alaya 数据库（记忆库核心）之上的扩充，不是独立架构。统一操作面、统一数据层、统一配置层、统一交互层，实施时保持向后兼容。',
    kind: 'decision', tags: ['Alaya', '架构'], priority: 95, base: true, scope: 'knowledge',
    groupId: 'g-alaya', groupName: 'Alaya', source: 'AI 生成', hidden: false, imageCount: 0,
    createdAt: now - 9 * day, updatedAt: now - 1 * day,
  },
  {
    id: 'e-2', title: '约束：笔记本与数据库两域数据隔离（含备份/导出边界）',
    content: '两边数据之间严格隔离：表级命名空间隔离，备份与导出必须按域投影，内存隔离断言继续保留。',
    kind: 'fact', tags: ['Alaya', '数据隔离'], priority: 93, base: false, scope: 'knowledge',
    groupId: 'g-alaya', groupName: 'Alaya', source: 'AI 生成', hidden: false, imageCount: 2,
    createdAt: now - 8 * day, updatedAt: now - 2 * day,
  },
  {
    id: 'e-3', title: 'Liquid Glass 在 Windows 应用中的设计与实现方案',
    content: 'Windows 原生窗口材质 + 独立玻璃渲染层 + 统一设计令牌与交互系统的混合架构。玻璃是界面层而不是背景装饰。',
    kind: 'note', tags: ['设计', 'Liquid Glass'], priority: 72, base: false, scope: 'conversation',
    groupId: 'g-alaya', groupName: 'Alaya', source: '手动记录', hidden: false, imageCount: 0,
    createdAt: now - 4 * day, updatedAt: now - 4 * day,
  },
  {
    id: 'e-4', title: 'Codex Provider：私有 CODEX_HOME 与协议要点',
    content: 'Codex 走私有 CODEX_HOME，避免污染本机配置；bridge 三态、reasoning 映射与早中断是链路上的关键点。',
    kind: 'summary', tags: ['codex', 'provider'], priority: 82, base: false, scope: 'knowledge',
    groupId: 'g-work-dsh', groupName: 'DSH', source: 'AI 生成', hidden: false, imageCount: 0,
    createdAt: now - 30 * day, updatedAt: now - 6 * day,
  },
  {
    id: 'e-5', title: '发版守卫：Release 会在 push 失败时仍建成',
    content: '发布前要比树 sha（内容）而不是 commit sha，否则会把旧提交发布的产物当成本次发布。',
    kind: 'task', tags: ['发布', 'git'], priority: 84, base: false, scope: 'knowledge',
    groupId: 'g-work-dsh', groupName: 'DSH', source: '手动记录', hidden: false, imageCount: 0,
    createdAt: now - 20 * day, updatedAt: now - 7 * day,
  },
  {
    id: 'e-6', title: '周会：0.8 的界面统一方向',
    content: '先统一材质与动效令牌，再谈组件替换；导航与操作层用玻璃，内容层保持纯净可读。',
    kind: 'note', tags: ['会议'], priority: 55, base: false, scope: 'conversation',
    groupId: 'g-work', groupName: '工作', source: '手动记录', hidden: false, imageCount: 0,
    createdAt: now - 5 * day, updatedAt: now - 3 * day,
  },
  {
    id: 'e-7', title: '偏好：中文正文用雅黑，英文与数字用 Segoe UI Variable',
    content: '字号以正文 13px、注释 11px 为基线；标题不要再放大层级，靠字重和留白区分。',
    kind: 'preference', tags: ['排版'], priority: 60, base: false, scope: 'conversation',
    groupId: 'g-life', groupName: '生活', source: '手动记录', hidden: false, imageCount: 0,
    createdAt: now - 12 * day, updatedAt: now - 10 * day,
  },
  {
    id: 'e-8', title: '旧结论：0.6 时代用过的独立 mistakebook 文件',
    content: '已被 0.7.10 的共库方案取代，仅作历史参考。',
    kind: 'fact', tags: ['历史'], priority: 20, base: false, scope: 'knowledge',
    groupId: 'g-alaya', groupName: 'Alaya', source: 'AI 生成', hidden: true, imageCount: 0,
    createdAt: now - 60 * day, updatedAt: now - 40 * day,
  },
]

const stats = {
  totals: { entries: entries.filter(entry => !entry.hidden).length },
  entries: {
    knowledge: entries.filter(entry => !entry.hidden && entry.scope === 'knowledge').length,
    conversation: entries.filter(entry => !entry.hidden && entry.scope === 'conversation').length,
  },
  hidden: entries.filter(entry => entry.hidden).length,
}

const settings = { baseUrl: 'https://api.example.invalid/v1', model: 'demo-model', hasKey: true }

const ok = result => Promise.resolve({ ok: true, result })
const filter = body => {
  const query = String(body?.query ?? '').trim().toLowerCase()
  const scope = body?.scope
  const group = body?.group
  const onlyHidden = body?.onlyHidden === true
  const includeHidden = body?.includeHidden === true
  return entries.filter(entry => {
    if (onlyHidden ? !entry.hidden : entry.hidden && !includeHidden) return false
    if (onlyHidden && !entry.hidden) return false
    if (scope && entry.scope !== scope) return false
    if (group && entry.groupId !== group) return false
    if (!query) return true
    const haystack = `${entry.title} ${entry.content} ${entry.tags.join(' ')}`.toLowerCase()
    return query.split(/\s+/).every(word => haystack.includes(word))
  })
}

const handlers = {
  state: () => ({ groups, stats, limits: { title: 200, content: 20000, entries: 50 }, settings }),
  entries: body => ({ entries: filter(body).slice(0, body?.limit ?? 200), nextOffset: null }),
  'entry.write': body => ({ entry: { ...body, id: `e-${entries.length + 1}`, updatedAt: now, createdAt: now, source: 'panel', hidden: false, imageCount: 0, groupName: groups.find(group => group.id === body?.groupId)?.name ?? '未分组' } }),
  'entry.update': body => ({ entry: { ...body, updatedAt: now } }),
  'entry.delete': () => ({}),
  'entry.hide': () => ({}),
  'group.create': body => ({ group: { id: `g-${groups.length + 1}`, name: body?.name ?? '新记忆组', parentId: body?.parentId ?? null, depth: 1, path: [], entryCount: 0 } }),
  'group.update': () => ({}),
  'group.delete': () => ({}),
  'image.list': () => ({ images: [] }),
  'image.read': () => ({ data: '' }),
  'settings.set': () => settings,
  curate: () => ({ suggestions: [] }),
}

window.vault = {
  invoke: (op, body) => (handlers[op] ? ok(handlers[op](body ?? {})) : Promise.resolve({ ok: false, error: `预览桥没有实现 ${op}` })),
  info: () => ok({ version: '0.8.0-preview', databasePath: 'C:\\Users\\demo\\AppData\\Roaming\\Alaya\\alaya.sqlite', model: settings, updates: { status: 'idle', settings: { notify: false, autoCheck: false } } }),
  confirm: () => ok(false),
  open: () => ok(null),
  backup: () => ok(null),
  settings: body => ok(settings),
  updates: () => ok({ status: 'idle' }),
  onUpdates: () => () => {},
  mistakebook: (action) => ok({ notes: [], sections: [], prefs: {} }),
  notebook: (op) => ok(op === 'list' ? { notes: [], canvas: null } : {}),
  canvas: (action) => ok({ docs: {}, corrupted: false }),
}
