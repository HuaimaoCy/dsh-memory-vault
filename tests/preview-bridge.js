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

// 预览要能指定从哪一面启动：app.js 用 localStorage 的 alaya.mode 决定开机落在
// 数据库还是笔记本。服务端已把期望模式写进 body[data-mode]，这里对齐过去。
const requestedMode = document.body?.dataset?.mode
if (requestedMode) {
  try { localStorage.setItem('alaya.mode', requestedMode === 'mistakebook' ? 'notebook' : 'memory') } catch { /* 存储不可用就算了 */ }
}

// 人工检查用的查询参数：?tier=full|balanced|flat 直接落成「用户显式选择」，
// 刷新即可换档；不带参数时保留上次在页内用 alayaGlass.setTier() 选的那档。
const requestedTier = new URLSearchParams(location.search).get('tier')
if (requestedTier && ['full', 'balanced', 'flat'].includes(requestedTier)) {
  try { localStorage.setItem('alaya.glass', requestedTier) } catch { /* 同上 */ }
}

// 人工检查的快捷键（只在预览里存在，不进打包产物）：
//   Ctrl/⌘ + Alt + 1 / 2 / 3  → full / balanced / flat
//   Ctrl/⌘ + Alt + M          → 在数据库与笔记本之间切换
window.addEventListener('keydown', event => {
  if (!(event.ctrlKey || event.metaKey) || !event.altKey) return
  const tier = { Digit1: 'full', Digit2: 'balanced', Digit3: 'flat' }[event.code]
  if (tier) {
    event.preventDefault()
    window.alayaGlass?.setTier(tier)
    return
  }
  if (event.code === 'KeyM') {
    event.preventDefault()
    const next = document.body.dataset.mode === 'mistakebook' ? 'memory' : 'notebook'
    try { localStorage.setItem('alaya.mode', next) } catch { /* 忽略 */ }
    location.reload()
  }
})

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

// —— 笔记本域的演示数据（形状对齐 notebook.list 的真实返回）——
const notes = [
  {
    id: 'n-1', type: 'physics', title: '水平弹簧振子：从受力到运动方程', stem: '质量块连接轻弹簧，在水平面上无摩擦运动。建立模型并推导周期。',
    subjectID: 'physics', nodeID: 'node-simple-harmonic', tags: ['错题'], reviewState: 'todo', priority: 88, value: { overallScore: 88, level: 'high' },
    createdAt: now - 6 * day, updatedAt: now - 1 * day,
    physics: { object: '质量块与轻弹簧', assumptions: '忽略摩擦，弹簧质量可忽略', equations: 'F = −kx\nm x″ = −kx', derivation: '解得 ω = √(k/m)，周期 T = 2π/ω。' },
  },
  {
    id: 'n-2', type: 'note', title: '今天的学习记录', stem: '先说明假设，再写方程。\n模型是连接现实情境与数学解答的桥梁。',
    subjectID: 'physics', nodeID: 'node-modeling', tags: ['笔记'], reviewState: 'done', priority: 52, value: { overallScore: 52, level: 'low' },
    createdAt: now - 3 * day, updatedAt: now - 3 * day,
  },
  {
    id: 'n-3', type: 'method', title: '配方法：求二次函数最值', stem: '把二次函数配成完全平方，再判断顶点与区间边界。',
    subjectID: 'math', nodeID: 'node-quadratic', tags: ['方法'], reviewState: 'todo', priority: 74, value: { overallScore: 74, level: 'mid' },
    createdAt: now - 10 * day, updatedAt: now - 4 * day,
    method: { prerequisites: '先确定定义域和二次项系数', steps: '配成完全平方，找出顶点，再检查区间边界', reasoning: '平方项非负，最值可能出现在顶点或边界' },
  },
  {
    id: 'n-4', type: 'vocabulary', title: 'momentum', stem: '动量；势头',
    subjectID: 'english', nodeID: 'node-vocab', tags: ['单词'], reviewState: 'todo', priority: 61, value: { overallScore: 61, level: 'mid' },
    createdAt: now - 2 * day, updatedAt: now - 2 * day,
    vocabulary: { word: 'momentum', phonetic: '/məˈmentəm/', meaning: '动量；势头', examples: 'Momentum is conserved in an isolated system.' },
  },
]

const notebookData = (scope={}) => ({
  records: notes.map(row=>previewReadNote(row.id)).filter(row=>(!scope.type||row.type===scope.type)&&(!scope.subjectID||row.subjectID===scope.subjectID)&&(!scope.tag||row.tags.includes(scope.tag))&&(scope.view!=='mastered'||row.reviewState==='mastered')&&(scope.view!=='due'||row.reviewState!=='mastered')&&(scope.view!=='trash'||row.isSoftDeleted)&&(!scope.query||JSON.stringify(row).toLocaleLowerCase().includes(scope.query.toLocaleLowerCase()))),
  total: notes.length,
  prefs: { order: 'priority', sideWidth: 220, detailWidth: 440, detailSide: 'right' },
  sidebar: [{ id: 's-all', label: '全部笔记', view: 'all' }],
  taxonomy: {
    subjects: [{ id: 'physics', name: '物理' }, { id: 'math', name: '数学' }, { id: 'english', name: '英语' }],
    nodes: [
      { id: 'node-simple-harmonic', name: '简谐运动', subjectID: 'physics' },
      { id: 'node-modeling', name: '建模', subjectID: 'physics' },
      { id: 'node-quadratic', name: '二次函数', subjectID: 'math' },
      { id: 'node-vocab', name: '词汇', subjectID: 'english' },
    ],
  },
  counts: { all: notes.length },
  stats: {
    // 视图计数直接用 stats[view]，与 mistakebook.js 的侧栏一致
    all: notes.length, due: 3, mastered: 1, archived: 0, trash: 0,
    tags: { 错题: 1, 笔记: 1, 方法: 1, 单词: 1 },
    types: { physics: 1, note: 1, method: 1, vocabulary: 1 },
    subjects: { physics: 2, math: 1, english: 1 },
  },
})
const previewReadNote=id=>{
  const row=notes.find(note=>note.id===id)
  if(!row)throw new Error('笔记不存在')
  return {...row,revision:row.revision??1,images:row.images??[],annotations:row.annotations??[],repeatCount:row.repeatCount??0,mastery:row.mastery??0,notes:row.notes??'',reviewState:row.reviewState==='done'?'mastered':row.reviewState==='todo'?'new':row.reviewState,physics:row.physics??{},method:row.method??{},vocabulary:row.vocabulary??{}}
}

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

const previewUpdates={status:'idle',feedUrl:'',settings:{notify:false,autoCheck:false},download:{status:'idle',received:0,total:0}}
window.vault = {
  invoke: (op, body) => (handlers[op] ? ok(handlers[op](body ?? {})) : Promise.resolve({ ok: false, error: `预览桥没有实现 ${op}` })),
  info: () => ok({ version: '0.8.0-preview', databasePath: 'C:\\Users\\demo\\AppData\\Roaming\\Alaya\\alaya.sqlite', model: settings, connectors:{codex:'# Preview configuration',dsh:'# Preview configuration'}, updates:previewUpdates }),
  confirm: () => ok(false),
  open: () => ok(null),
  backup: () => ok(null),
  settings: body => ok(settings),
  updates: () => ok(previewUpdates),
  onUpdates: () => () => {},
  mistakebook: (action) => ok(action === 'list' ? notebookData() : {}),
  notebook: (op, body) => {
    if (op === 'list') return ok(notebookData(body))
    if (op === 'prefs.save' || op === 'sidebar.save') return ok(op === 'sidebar.save' ? {} : notebookData().prefs)
    if (op === 'ai.history') return ok({ messages: [] })
    if (op === 'read') return ok(previewReadNote(body?.id))
    if (op === 'save') { const id=body?.id??`n-${notes.length+1}`,index=notes.findIndex(row=>row.id===id),next={...body,id,revision:(notes[index]?.revision??0)+1,updatedAt:Date.now(),value:body.value??{overallScore:50,level:'mid'}};if(index<0)notes.push(next);else notes[index]=next;return ok(previewReadNote(id)) }
    return ok({})
  },
  canvas: (action) => ok({ docs: {}, corrupted: false }),
}
