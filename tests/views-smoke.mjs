/**
 * 可保存视图的纯模型测试：不启动 Electron，也不碰真实数据库。
 *
 * 这里验证的是渲染层最容易被坏数据打崩的那一层——归一化、筛选、排序、分组、
 * 迁移、以及 localStorage 里塞了各种垃圾时的兜底。运行：
 *   node --no-warnings tests/views-smoke.mjs
 */
import assert from 'node:assert/strict'
import {
  DEFAULT_VIEW_IDS, KIND_LABELS, LEGACY_LAYOUT_KEY, UNGROUPED, VIEW_SCHEMA, VIEW_SHAPES, VIEW_STORE_KEY,
  activeFilterCount, clearLegacyLayout, createView, defaultViews, describeFilters, describeSource, describeView,
  filterEntries, filterScopeNotice, groupEntries, isDefaultView, migrateViewStore, nextViewId, normalizeFilters, normalizeSource,
  normalizeView, normalizeViewStore, readViewStore, serializeView, sortEntries, sourceEquals, titleOf, writeViewStore,
} from '../desktop/renderer/views.js'

let checks = 0
const check = (label, run) => { run(); checks += 1; void label }
const ok = (value, message) => assert.ok(value, message)
const is = (actual, expected, message) => assert.deepEqual(actual, expected, message)

/** 内存版 storage：与 localStorage 同形，测试结束即消失。 */
function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed))
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: key => { map.delete(key) },
    dump: () => Object.fromEntries(map),
  }
}

/** 造一条记忆视图（只填视图关心的字段）。 */
const entry = (id, patch = {}) => ({
  id, groupId: patch.groupId ?? 'g1', groupName: patch.groupName ?? '项目约定', scope: patch.scope ?? 'knowledge',
  title: patch.title ?? `记忆 ${id}`, content: patch.content ?? '', kind: patch.kind ?? 'note',
  tags: patch.tags ?? [], hidden: patch.hidden ?? false, base: patch.base ?? false,
  priority: patch.priority ?? 50, imageCount: patch.imageCount ?? 0,
  updatedAt: patch.updatedAt ?? '2026-10-01T00:00:00.000Z',
})

// —— 默认视图与模型字段 ——
check('四个内置视图', () => {
  const views = defaultViews()
  is(views.length, 4)
  is(views.map(view => view.id), [...DEFAULT_VIEW_IDS])
  is(views.map(view => view.name), ['全部记忆', '知识库', '对话记忆', '隐藏'])
  for (const view of views) {
    // 字段集合是契约：多一个少一个都不行。
    is(Object.keys(view), ['id', 'name', 'source', 'shape', 'sort', 'groupBy', 'filters'])
    is(Object.keys(view.filters), ['kinds', 'tags', 'onlyBase', 'onlyWithImages'])
    ok(VIEW_SHAPES.includes(view.shape), '默认形状必须是四档之一')
  }
  is(views[1].source, { kind: 'scope', id: 'knowledge' })
  is(views[3].source, { kind: 'hidden' })
})

// —— 归一化：坏数据一律收敛，绝不抛异常 ——
check('视图归一化兜底', () => {
  const junk = normalizeView({ id: '../../etc', name: '   ', source: { kind: 'scope', id: 'nope' }, shape: 'kanban', sort: 'id', groupBy: 'tag', filters: 'x' }, { id: 'view-9' })
  is(junk.id, 'view-9', '非法 id 用调用方给的兜底')
  is(junk.name, '未命名视图')
  is(junk.source, { kind: 'all' }, 'scope 只认 knowledge/conversation')
  is([junk.shape, junk.sort, junk.groupBy], ['grid', 'priority', 'root'])
  is(junk.filters, { kinds: [], tags: [], onlyBase: false, onlyWithImages: false })
  for (const weird of [null, undefined, 0, 'text', [], true, { source: null, filters: [] }]) {
    const view = normalizeView(weird)
    ok(view.id.length > 0 && view.name.length > 0, `坏输入 ${JSON.stringify(weird)} 也要得到合法视图`)
  }
  // 名称过长被截断，但不会变成空串。
  ok(normalizeView({ name: 'x'.repeat(200) }).name.length === 60)
})

check('来源归一化', () => {
  is(normalizeSource({ kind: 'group', id: '' }), { kind: 'all' }, 'group 没有 id 就退回全部')
  is(normalizeSource({ kind: 'group', id: 'g1' }), { kind: 'group', id: 'g1' })
  is(normalizeSource({ kind: 'scope', id: 'conversation' }), { kind: 'scope', id: 'conversation' })
  is(normalizeSource({ kind: 'hidden', id: 'ignored' }), { kind: 'hidden' })
  ok(sourceEquals({ kind: 'all' }, { kind: 'all', id: '' }), 'all 忽略多余 id')
  ok(!sourceEquals({ kind: 'scope', id: 'knowledge' }, { kind: 'scope', id: 'conversation' }))
  ok(!sourceEquals({ kind: 'group', id: 'a' }, { kind: 'group', id: 'b' }))
})

check('筛选归一化', () => {
  const rules = normalizeFilters({ kinds: ['note', 'nope', 'note', 7], tags: [' 发布 ', '发布', '', 'x'.repeat(80)], onlyBase: 'yes', onlyWithImages: 1 })
  is(rules.kinds, ['note'], '只保留已知类型并去重')
  is(rules.tags, ['发布', 'x'.repeat(30)], '标签去空、去重、截断')
  is([rules.onlyBase, rules.onlyWithImages], [false, false], '只有严格的 true 才算开启')
  is(normalizeFilters({ tags: Array.from({ length: 40 }, (_, index) => `t${index}`) }).tags.length, 20, '标签数量有上限')
})

// —— 筛选真的生效 ——
check('筛选类型/标签/底层约定/图片', () => {
  const rows = [
    entry('a', { kind: 'note', tags: ['AI 生成', '设计'] }),
    entry('b', { kind: 'fact', tags: ['接口'], base: true, imageCount: 2 }),
    entry('c', { kind: 'fact', tags: [], imageCount: 1 }),
    entry('d', { kind: 'decision', tags: ['设计', '发布'] }),
  ]
  is(filterEntries(rows, {}).map(row => row.id), ['a', 'b', 'c', 'd'], '空筛选=不过滤')
  is(filterEntries(rows, { kinds: ['fact'] }).map(row => row.id), ['b', 'c'])
  is(filterEntries(rows, { kinds: ['fact'], onlyBase: true }).map(row => row.id), ['b'], '多条规则是 AND')
  is(filterEntries(rows, { tags: ['设计', '接口'] }).map(row => row.id), ['a', 'b', 'd'], '同一字段多值取 OR')
  is(filterEntries(rows, { tags: ['设计'], kinds: ['decision'] }).map(row => row.id), ['d'])
  is(filterEntries(rows, { onlyWithImages: true }).map(row => row.id), ['b', 'c'])
  is(filterEntries(rows, { tags: ['设计'], onlyBase: true }), [], '无结果时返回空数组而不是 null')
  ok(filterEntries(rows, {}).length === rows.length, '筛选不改动入参')
  ok(Array.isArray(filterEntries(null, {})) && filterEntries(null, {}).length === 0, '坏入参返回空数组')
})

// —— 排序真的生效，且与 0.7.15 一致 ——
check('三档排序', () => {
  const rows = [
    entry('a', { title: '丙', priority: 10, updatedAt: '2026-01-01T00:00:00.000Z' }),
    entry('b', { title: '甲', priority: 90, updatedAt: '2026-09-01T00:00:00.000Z' }),
    entry('c', { title: '乙', priority: 90, base: true, updatedAt: '2026-05-01T00:00:00.000Z' }),
  ]
  is(sortEntries(rows, 'priority').map(row => row.id), ['c', 'b', 'a'], '底层约定优先，其次优先级')
  is(sortEntries(rows, 'updated').map(row => row.id), ['b', 'c', 'a'])
  // 丙(bing) < 甲(jia) < 乙(yi)：zh-CN 排序按拼音，不是按码位。
  is(sortEntries(rows, 'title').map(row => row.id), ['a', 'b', 'c'])
  is(sortEntries(rows, 'nope').map(row => row.id), ['c', 'b', 'a'], '未知排序退回默认档')
  ok(rows[0].id === 'a', '排序返回新数组，不动入参')
  // 坏日期不能把整个排序污染成 NaN 比较。
  const broken = [entry('x', { updatedAt: 'not-a-date' }), entry('y', { updatedAt: '2026-02-02T00:00:00.000Z' })]
  is(sortEntries(broken, 'updated').map(row => row.id), ['y', 'x'])
  is(sortEntries([entry('t', { title: '', content: '正文当标题' })], 'title').length, 1)
  is(titleOf({ title: '', content: '  正文当标题  ' }), '正文当标题')
})

// —— 分组：看板列数与列顺序 ——
check('三种分组', () => {
  const rows = [
    entry('a', { kind: 'note', groupName: '发布' }),
    entry('b', { kind: 'fact', groupName: '设计' }),
    entry('c', { kind: 'note', groupName: '' }),
    entry('d', { kind: 'task', groupName: '发布' }),
  ]
  const byKind = groupEntries(rows, 'kind')
  is(byKind.map(group => group.label), ['笔记', '事实', '任务'], '按类型分列，列顺序固定且空组不出现')
  is(byKind.map(group => group.entries.length), [2, 1, 1])
  const byGroup = groupEntries(rows, 'group')
  is(byGroup.map(group => group.label), ['发布', '设计', UNGROUPED], '未分组永远最后')
  is(byGroup.map(group => group.entries.length), [2, 1, 1])
  const roots = new Map([['a', '项目约定'], ['b', '项目约定'], ['c', '工作方式'], ['d', '项目约定']])
  const byRoot = groupEntries(rows, 'root', { rootOf: row => roots.get(row.id) })
  is(byRoot.map(group => group.label), ['工作方式', '项目约定'])
  is(byRoot.map(group => group.entries.length), [1, 3])
  is(groupEntries([], 'kind'), [], '空输入得到空分组')
  is(groupEntries(rows, 'nope').map(group => group.label), groupEntries(rows, 'root').map(group => group.label), '未知分组退回 root')
  ok(Object.keys(KIND_LABELS).length === 6, '六种类型')
})

// —— 迁移：0.7.15 的 grid|rows 不能丢 ——
check('迁移 memory-vault.layout', () => {
  const grid = migrateViewStore(null, { legacyShape: 'grid' })
  is([grid.migrated, grid.legacyShape], [true, 'grid'])
  is(grid.views.map(view => view.shape), ['grid', 'grid', 'grid', 'grid'])
  is(grid.activeId, 'default-all')
  const rows = migrateViewStore(undefined, { legacyShape: 'rows' })
  is(rows.views.map(view => view.shape), ['rows', 'rows', 'rows', 'rows'], '旧 rows 档位整体搬进四个内置视图')
  // 旧数据非法时退回 grid，而不是丢掉偏好。
  is(migrateViewStore(null, { legacyShape: 'bogus' }).views.map(view => view.shape), ['grid', 'grid', 'grid', 'grid'])
  // 已经有视图存储时，旧键不再覆盖用户改过的形状。
  const existing = migrateViewStore({ views: [{ id: 'default-all', name: '全部记忆', source: { kind: 'all' }, shape: 'board', sort: 'title', groupBy: 'kind', filters: {} }], activeId: 'default-all' }, { legacyShape: 'rows' })
  is(existing.migrated, false)
  is(existing.views[0].shape, 'board', '已有存储优先')
  // 更早的数组格式（没有 schema 外壳）也要能读。
  const array = migrateViewStore([{ name: '旧数组视图', shape: 'table' }], {})
  is(array.views.length, 1)
  is(array.views[0].shape, 'table')
  is(array.activeId, array.views[0].id)
})

check('存储读取与写入', () => {
  const area = memoryStorage({ [LEGACY_LAYOUT_KEY]: 'rows' })
  const first = readViewStore(area)
  is(first.migrated, true)
  is(first.views[0].shape, 'rows', '从旧键迁进来')
  const saved = writeViewStore({ views: [normalizeView({ id: 'mine', name: '我的视图', shape: 'board' })], activeId: 'mine' }, area)
  ok(saved, '写入成功')
  const stored = JSON.parse(area.getItem(VIEW_STORE_KEY))
  is(stored.schema, VIEW_SCHEMA)
  is(stored.activeId, 'mine')
  is(Object.keys(stored.views[0]), ['id', 'name', 'source', 'shape', 'sort', 'groupBy', 'filters'], '只写契约里的字段')
  ok(area.getItem(VIEW_STORE_KEY).includes('alaya.db') === false, '内容里不该出现别的键名')
  clearLegacyLayout(area)
  is(area.getItem(LEGACY_LAYOUT_KEY), null)
  const reread = readViewStore(area)
  is(reread.migrated, false)
  is(reread.views[0].shape, 'board', '删掉旧键后不会再覆盖')
  // 坏 JSON / 存储抛异常都要活下来。
  is(readViewStore(memoryStorage({ [VIEW_STORE_KEY]: '{not json' })).views.length, 4)
  is(readViewStore(memoryStorage({ [VIEW_STORE_KEY]: '"a string"' })).views.length, 4)
  is(readViewStore(memoryStorage({ [VIEW_STORE_KEY]: '42' })).views.length, 4)
  const broken = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') }, removeItem: () => { throw new Error('denied') } }
  is(readViewStore(broken).views.length, 4, '存储不可用时用默认视图')
  is(writeViewStore({ views: defaultViews(), activeId: 'default-all' }, broken), false, '写不进去要返回 false 而不是抛异常')
})

check('存储去重与上限', () => {
  const duplicates = normalizeViewStore({ views: [{ id: 'same', name: 'A' }, { id: 'same', name: 'B' }, { name: 'C' }], activeId: 'same' })
  is(duplicates.views.length, 2, '重复 id 只保留第一个')
  is(duplicates.views[0].name, 'A')
  ok(duplicates.views[1].id !== 'same', '后来者换新 id')
  is(normalizeViewStore({ views: [], activeId: 'ghost' }).views.length, 4, '空列表用默认视图兜底')
  is(normalizeViewStore({ views: [{ id: 'a' }], activeId: 'ghost' }).activeId, 'a', 'activeId 指向不存在的视图时退回第一个')
  const many = normalizeViewStore({ views: Array.from({ length: 90 }, (_, index) => ({ id: `v${index}`, name: `视图 ${index}` })) })
  is(many.views.length, 60, '视图数量有上限')
})

check('新建/复制视图', () => {
  const base = defaultViews()[0]
  const views = [base]
  const copy = createView(base, { views })
  is(copy.name, '全部记忆 副本')
  is(copy.id, 'view-1', 'id 取第一个空位')
  ok(!views.some(view => view.id === copy.id), '不会撞已有 id')
  const again = createView(base, { views: [...views, copy] })
  is(again.name, '全部记忆 副本 2', '同名自动加序号')
  const shaped = createView(base, { views, patch: { shape: 'board', sort: 'title', groupBy: 'kind', name: '按类型的看板' }, name: '按类型的看板' })
  is([shaped.shape, shaped.sort, shaped.groupBy, shaped.name], ['board', 'title', 'kind', '按类型的看板'])
  is(nextViewId([]), 'view-1')
  is(nextViewId([{ id: 'view-1' }, { id: 'view-2' }]), 'view-3')
  ok(isDefaultView('default-hidden') && !isDefaultView('view-3'))
})

check('描述文本与筛选计数', () => {
  is(activeFilterCount({}), 0)
  is(activeFilterCount({ kinds: ['note', 'fact'], tags: ['a', 'b'], onlyBase: true }), 3, '同一规则里的多个值算一条')
  is(describeFilters({ kinds: ['note'], tags: ['发布'], onlyWithImages: true }), ['类型：笔记', '标签：发布', '只看有图片'])
  is(describeFilters({}), [])
  is(describeView({ shape: 'board', sort: 'title', groupBy: 'kind', filters: {} }), '看板 · 按类型 · 按标题排序')
  ok(describeView({ shape: 'table', filters: { onlyBase: true } }).endsWith('1 条筛选'))
  is(describeSource({ kind: 'scope', id: 'knowledge' }), '知识库')
  is(describeSource({ kind: 'group', id: 'g' }), '记忆组')
  is(describeSource({ kind: 'nope' }), '全部记忆')
})

check('序列化字段顺序固定', () => {
  const view = serializeView({ id: 'x', name: 'n', shape: 'board', sort: 'title', groupBy: 'group', source: { kind: 'group', id: 'g' }, filters: { tags: ['t'] }, extra: 'ignored' })
  is(Object.keys(view), ['id', 'name', 'source', 'shape', 'sort', 'groupBy', 'filters'], '序列化不带多余字段')
  is(view.filters, { kinds: [], tags: ['t'], onlyBase: false, onlyWithImages: false })
})

check('来源与筛选互不干扰', () => {
  // 视图的 source 决定 load() 拉什么；filters 只在渲染层收敛。两者不能互相污染。
  const view = normalizeView({ source: { kind: 'scope', id: 'conversation' }, filters: { kinds: ['task'] } })
  is(view.source, { kind: 'scope', id: 'conversation' })
  is(view.filters.kinds, ['task'])
})

check('筛选范围的边界提示', () => {
  // 有筛选 + 还有未加载的结果 → 必须提示边界，否则「看板上没有」会被误读成「库里没有」。
  is(filterScopeNotice({ loaded: 200, shown: 3, hasMore: true, filterCount: 1 }), '筛选只作用于已加载的 200 条（匹配 3 条）；还有更多结果未加载')
  // 没有筛选时列表底部已有「加载更多」，不重复提示。
  is(filterScopeNotice({ loaded: 200, shown: 200, hasMore: true, filterCount: 0 }), null)
  // 已经加载完就没有边界问题。
  is(filterScopeNotice({ loaded: 42, shown: 5, hasMore: false, filterCount: 2 }), null)
  // 坏输入不能抛。
  is(filterScopeNotice(), null)
  is(filterScopeNotice({ filterCount: 'x' }), null)
  // 文案必须同时带上「已加载条数」与「匹配条数」，且不能声称是整库结果。
  const text = filterScopeNotice({ loaded: 200, shown: 0, hasMore: true, filterCount: 1 })
  ok(text.includes('已加载的 200 条') && text.includes('匹配 0 条') && !text.includes('全部'))
})

console.log(`views-smoke: ${checks} groups passed`)
