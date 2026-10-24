/**
 * 可保存视图（Notion 式）：纯模型层，一行 DOM 都没有。
 *
 * 一个「视图」是一份**展示层配置**——数据来源、形状、排序、分组、筛选——
 * 而不是数据本身。这与 `docs/notion-parity.zh.md` 的结论一致：真正缺的是
 * 「筛选 + 排序 + 分组 + 版式」能存成具名视图，不是块编辑器。
 *
 * 两条硬约束写在这个模块的边界上：
 * 1. 偏好只走渲染层 localStorage（`alaya.db.views`），**绝不写数据库 meta 表**。
 *    UI 偏好一旦进库，就会随备份/导出一起来回搬，等于污染记忆域。
 * 2. 任何来源（localStorage JSON、手改过的文件、旧版本遗留、坏数据）都要被
 *    `normalizeView` 收敛成合法对象，永远不抛异常——界面不能因为一段坏 JSON 白屏。
 *
 * 这里不做任何新请求：视图是本地配置，与 `default-src 'none'` 的 CSP 无关。
 *
 * @module dsh-memory-vault/desktop/renderer/views
 */

/** 保存视图的键名；必须以 `alaya.db.` 前缀，且只写渲染层。 */
export const VIEW_STORE_KEY = 'alaya.db.views'
/** 0.7.15 之前的全局显示档位；迁移后即删除，避免二次覆盖用户已经改过的形状。 */
export const LEGACY_LAYOUT_KEY = 'memory-vault.layout'
/** 存储结构版本，只增不减；将来加字段时按 schema 分别处理。 */
export const VIEW_SCHEMA = 1

export const VIEW_SHAPES = Object.freeze(['grid', 'rows', 'table', 'board'])
export const VIEW_SORTS = Object.freeze(['priority', 'updated', 'title'])
export const VIEW_GROUPINGS = Object.freeze(['root', 'kind', 'group'])
export const SOURCE_KINDS = Object.freeze(['all', 'scope', 'hidden', 'group'])
export const SCOPES = Object.freeze(['knowledge', 'conversation'])

/** 记忆的六种语义类型，顺序就是看板按类型分列时的列顺序。 */
export const KIND_LABELS = Object.freeze({ note: '笔记', fact: '事实', decision: '决策', preference: '偏好', summary: '总结', task: '任务' })
export const SHAPE_LABELS = Object.freeze({ grid: '卡片', rows: '列表', table: '表格', board: '看板' })
export const SORT_LABELS = Object.freeze({ priority: '优先级排序', updated: '最近更新', title: '按标题排序' })
export const GROUPING_LABELS = Object.freeze({ root: '根记忆组', kind: '类型', group: '记忆组' })
export const SOURCE_LABELS = Object.freeze({ all: '全部记忆', hidden: '隐藏', group: '记忆组' })
export const SCOPE_LABELS = Object.freeze({ knowledge: '知识库', conversation: '对话记忆' })

/** 没有归组的记忆落在这一列/这一段，并且永远排在最后。 */
export const UNGROUPED = '未分组'
export const UNNAMED_VIEW = '未命名视图'

export const MAX_VIEW_NAME = 60
export const MAX_VIEWS = 60
export const MAX_FILTER_TAGS = 20
const MAX_TAG_LENGTH = 30
const VIEW_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** 四个内置视图的 id：既是首次启动的种子，也是「恢复默认」的还原目标。 */
export const DEFAULT_VIEW_IDS = Object.freeze(['default-all', 'default-knowledge', 'default-conversation', 'default-hidden'])

const DEFAULT_VIEW_DEFS = Object.freeze([
  { id: 'default-all', name: '全部记忆', source: { kind: 'all' }, shape: 'grid', sort: 'priority', groupBy: 'root' },
  { id: 'default-knowledge', name: '知识库', source: { kind: 'scope', id: 'knowledge' }, shape: 'grid', sort: 'priority', groupBy: 'root' },
  { id: 'default-conversation', name: '对话记忆', source: { kind: 'scope', id: 'conversation' }, shape: 'grid', sort: 'priority', groupBy: 'root' },
  { id: 'default-hidden', name: '隐藏', source: { kind: 'hidden' }, shape: 'grid', sort: 'priority', groupBy: 'root' },
])

const text = value => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '')
const oneOf = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback)

/**
 * 全部筛选条件归一化：永远是同一个形状，缺省即「不过滤」。
 * @param {unknown} input - 任意来源的筛选配置。
 * @returns {{ kinds: string[], tags: string[], onlyBase: boolean, onlyWithImages: boolean }} 归一化筛选。
 */
export function normalizeFilters(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const kinds = []
  for (const raw of Array.isArray(source.kinds) ? source.kinds : []) {
    const kind = text(raw).trim()
    if (!Object.hasOwn(KIND_LABELS, kind) || kinds.includes(kind)) continue
    kinds.push(kind)
  }
  const tags = []
  for (const raw of Array.isArray(source.tags) ? source.tags : []) {
    const tag = text(raw).trim().slice(0, MAX_TAG_LENGTH)
    if (tag === '' || tags.some(existing => existing.toLowerCase() === tag.toLowerCase())) continue
    tags.push(tag)
    if (tags.length >= MAX_FILTER_TAGS) break
  }
  return { kinds, tags, onlyBase: source.onlyBase === true, onlyWithImages: source.onlyWithImages === true }
}

/**
 * 一个视图的归一化。非法字段各自回落到默认值，不会整体丢弃这个视图。
 * @param {unknown} input - 任意来源的视图对象。
 * @param {{ id?: string, defaults?: Record<string, unknown> }} [options] - id 兜底与默认形状。
 * @returns {{ id: string, name: string, source: Record<string, string>, shape: string, sort: string, groupBy: string, filters: ReturnType<typeof normalizeFilters> }} 合法视图。
 */
export function normalizeView(input, { id = '', defaults = {} } = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const rawId = text(source.id).trim()
  const fallbackId = VIEW_ID_PATTERN.test(rawId) ? rawId : VIEW_ID_PATTERN.test(text(id).trim()) ? text(id).trim() : 'view-1'
  const name = text(source.name).trim().slice(0, MAX_VIEW_NAME) || text(defaults.name) || UNNAMED_VIEW
  return {
    id: fallbackId,
    name,
    source: normalizeSource(source.source ?? defaults.source),
    shape: oneOf(source.shape, VIEW_SHAPES, oneOf(defaults.shape, VIEW_SHAPES, 'grid')),
    sort: oneOf(source.sort, VIEW_SORTS, oneOf(defaults.sort, VIEW_SORTS, 'priority')),
    groupBy: oneOf(source.groupBy, VIEW_GROUPINGS, oneOf(defaults.groupBy, VIEW_GROUPINGS, 'root')),
    filters: normalizeFilters(source.filters ?? defaults.filters),
  }
}

/**
 * 数据来源归一化：`scope` 只认两种归属，`group` 必须有 id，否则退回「全部记忆」。
 * @param {unknown} input - 任意来源的来源描述。
 * @returns {{ kind: string, id?: string }} 合法来源。
 */
export function normalizeSource(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const kind = oneOf(source.kind, SOURCE_KINDS, 'all')
  const id = text(source.id).trim()
  if (kind === 'scope') return SCOPES.includes(id) ? { kind, id } : { kind: 'all' }
  if (kind === 'group') return id === '' ? { kind: 'all' } : { kind, id }
  return { kind }
}

/** 来源是全等比较；`all`/`hidden` 没有 id，`scope`/`group` 靠 id 区分。 */
export function sourceEquals(left, right) {
  const a = normalizeSource(left), b = normalizeSource(right)
  return a.kind === b.kind && (a.id ?? '') === (b.id ?? '')
}

/** 当前视图是否由某个内置默认视图承载（「恢复默认」用来判断是否需要还原）。 */
export function isDefaultView(id) {
  return DEFAULT_VIEW_IDS.includes(text(id))
}

/**
 * 内置视图。`shape` 用于把 0.7.15 的 `memory-vault.layout` 平滑迁进来。
 * @param {{ shape?: string }} [options] - 迁移来源。
 * @returns {ReturnType<typeof normalizeView>[]} 四个默认视图。
 */
export function defaultViews({ shape } = {}) {
  // 旧档位要**覆盖**内置的 grid，所以套在定义上而不是塞进 defaults（显式字段优先）。
  const override = oneOf(shape, VIEW_SHAPES, null)
  return DEFAULT_VIEW_DEFS.map((definition) => normalizeView(override ? { ...definition, shape: override } : definition, { id: definition.id }))
}

/** 取一个当前视图列表里没用过的 id（`view-1`、`view-2`…），保证可预测、可读。 */
export function nextViewId(views = []) {
  const taken = new Set(views.map(view => text(view?.id)))
  for (let index = 1; index <= MAX_VIEWS + 1; index += 1) {
    const candidate = `view-${index}`
    if (!taken.has(candidate)) return candidate
  }
  return `view-${Date.now().toString(36)}`
}

/**
 * 「新建视图 / 复制视图」：以某个视图为底，套一层改动，名称自动去重。
 * @param {Record<string, unknown>} base - 作为底稿的视图。
 * @param {{ views?: Record<string, unknown>[], name?: string, patch?: Record<string, unknown>, suffix?: string }} [options] - 生成参数。
 * @returns {ReturnType<typeof normalizeView>} 新视图。
 */
export function createView(base, { views = [], name, patch = {}, suffix = '副本' } = {}) {
  const root = normalizeView(base)
  let nextName = text(name).trim().slice(0, MAX_VIEW_NAME)
  if (nextName === '') {
    const stem = `${root.name} ${suffix}`.slice(0, MAX_VIEW_NAME)
    nextName = stem
    for (let index = 2; views.some(view => text(view?.name) === nextName); index += 1) nextName = `${stem} ${index}`.slice(0, MAX_VIEW_NAME)
  }
  const id = nextViewId(views)
  return normalizeView({ ...root, ...patch, id, name: nextName, filters: patch.filters ?? root.filters })
}

/**
 * 存储对象归一化：去重 id、限制条数、校验 activeId；一个视图都没有时用默认视图兜底。
 * @param {unknown} raw - localStorage 反序列化后的任意值。
 * @param {{ legacyShape?: string }} [options] - 迁移来源。
 * @returns {{ schema: number, views: ReturnType<typeof normalizeView>[], activeId: string }} 合法存储。
 */
export function normalizeViewStore(raw, { legacyShape } = {}) {
  const source = Array.isArray(raw) ? { views: raw } : raw && typeof raw === 'object' ? raw : null
  const views = []
  for (const item of Array.isArray(source?.views) ? source.views : []) {
    if (views.length >= MAX_VIEWS) break
    const view = normalizeView(item, { id: nextViewId(views), defaults: { shape: legacyShape } })
    // 重复 id 会让「当前视图」指向不明，直接跳过后来者而不是覆盖前者。
    if (views.some(existing => existing.id === view.id)) continue
    views.push(view)
  }
  if (views.length === 0) {
    const seeded = defaultViews({ shape: legacyShape })
    return { schema: VIEW_SCHEMA, views: seeded, activeId: seeded[0].id }
  }
  const activeId = views.some(view => view.id === source?.activeId) ? source.activeId : views[0].id
  return { schema: VIEW_SCHEMA, views, activeId }
}

/**
 * 从任何历史状态迁到视图系统：无存储 → 用默认视图 + 旧档位；数组（更早的实验格式）→ 包一层。
 * @param {unknown} raw - `alaya.db.views` 的原始值。
 * @param {{ legacyShape?: string }} [options] - 旧 `memory-vault.layout` 的值。
 * @returns {{ schema: number, views: ReturnType<typeof normalizeView>[], activeId: string, migrated: boolean, legacyShape: string|null }} 存储与迁移状态。
 */
export function migrateViewStore(raw, { legacyShape } = {}) {
  const shape = oneOf(legacyShape, VIEW_SHAPES, null)
  const present = raw !== undefined && raw !== null
  const store = normalizeViewStore(present ? raw : null, { legacyShape: shape })
  return { ...store, migrated: !present, legacyShape: shape }
}

/** 持久化时的字段顺序固定，diff 与手工检查都更容易读。 */
export function serializeView(view) {
  const normalized = normalizeView(view)
  return { id: normalized.id, name: normalized.name, source: normalized.source, shape: normalized.shape, sort: normalized.sort, groupBy: normalized.groupBy, filters: normalized.filters }
}

/**
 * 读取存储。坏 JSON / 存储不可用都退回默认视图，绝不抛异常。
 * @param {Storage|{ getItem(k: string): string|null }} [area] - 可注入的存储（测试用内存实现）。
 * @returns {ReturnType<typeof migrateViewStore>} 存储与迁移状态。
 */
export function readViewStore(area = globalThis.localStorage) {
  let raw = null
  try { raw = JSON.parse(area?.getItem(VIEW_STORE_KEY) ?? 'null') } catch { raw = null }
  let legacy = null
  try { legacy = area?.getItem(LEGACY_LAYOUT_KEY) ?? null } catch { legacy = null }
  return migrateViewStore(raw, { legacyShape: legacy })
}

/**
 * 写入存储。存储不可用（隐私模式、配额满）时静默降级为本次会话内生效。
 * @param {{ views: Record<string, unknown>[], activeId?: string }} store - 要写的存储。
 * @param {Storage|{ setItem(k: string, v: string): void }} [area] - 可注入的存储。
 * @returns {boolean} 是否写入成功。
 */
export function writeViewStore(store, area = globalThis.localStorage) {
  const views = (Array.isArray(store?.views) ? store.views : []).slice(0, MAX_VIEWS).map(serializeView)
  try {
    area?.setItem(VIEW_STORE_KEY, JSON.stringify({ schema: VIEW_SCHEMA, views, activeId: text(store?.activeId) }))
    return true
  } catch { return false }
}

/** 迁移完成后删掉旧键，避免下次启动把用户已经改过的形状又盖上。 */
export function clearLegacyLayout(area = globalThis.localStorage) {
  try { area?.removeItem(LEGACY_LAYOUT_KEY) } catch { /* 存储不可用 */ }
}

/** 日期兜底：坏字符串返回 0，排序不会因为一个 NaN 整体错乱。 */
function timeOf(value) {
  const time = new Date(value ?? 0).getTime()
  return Number.isFinite(time) ? time : 0
}

/** 标题兜底：没有标题时用正文首行代替，与卡片显示一致。 */
export function titleOf(entry) {
  const title = text(entry?.title).trim()
  if (title !== '') return title
  return text(entry?.content).replace(/\s+/g, ' ').trim().slice(0, 40)
}

/** 一条记忆的用户标签（系统标签「AI 生成」之类也保留，筛选按字面匹配）。 */
export function tagsOf(entry) {
  return Array.isArray(entry?.tags) ? entry.tags.map(text).map(tag => tag.trim()).filter(tag => tag !== '') : []
}

/**
 * 筛选：多条条件之间是 AND，同一个字段里的多个值是 OR。
 * @param {Record<string, any>[]} entries - 已加载的记忆。
 * @param {unknown} filters - 任意来源的筛选配置。
 * @returns {Record<string, any>[]} 通过筛选的记忆（新数组，不修改入参）。
 */
export function filterEntries(entries, filters) {
  const rows = Array.isArray(entries) ? entries.filter(Boolean) : []
  const rules = normalizeFilters(filters)
  const kinds = new Set(rules.kinds)
  const wanted = rules.tags.map(tag => tag.toLowerCase())
  return rows.filter((entry) => {
    if (kinds.size > 0 && !kinds.has(entry.kind)) return false
    if (wanted.length > 0) {
      const own = tagsOf(entry).map(tag => tag.toLowerCase())
      if (!wanted.some(tag => own.includes(tag))) return false
    }
    if (rules.onlyBase && entry.base !== true) return false
    if (rules.onlyWithImages && !(Number(entry.imageCount) > 0)) return false
    return true
  })
}

/**
 * 排序：与 0.7.15 的三档排序完全一致，只是搬到了纯函数里。
 * @param {Record<string, any>[]} entries - 要排序的记忆。
 * @param {string} sort - `priority`|`updated`|`title`。
 * @returns {Record<string, any>[]} 新数组；入参顺序不变。
 */
export function sortEntries(entries, sort) {
  const rows = Array.isArray(entries) ? [...entries] : []
  const mode = oneOf(sort, VIEW_SORTS, 'priority')
  rows.sort((left, right) => {
    if (mode === 'title') return titleOf(left).localeCompare(titleOf(right), 'zh-CN')
    if (mode === 'updated') return timeOf(right.updatedAt) - timeOf(left.updatedAt)
    // 默认档：底层约定优先，其次优先级，最后最近更新（同 0.7.15）。
    return Number(right.base === true) - Number(left.base === true) || Number(right.priority ?? 0) - Number(left.priority ?? 0) || timeOf(right.updatedAt) - timeOf(left.updatedAt)
  })
  return rows
}

const kindLabelOf = entry => KIND_LABELS[entry?.kind] ?? '其他'
const groupLabelOf = entry => text(entry?.groupName).trim() || UNGROUPED

/**
 * 分组：看板用它分列，表格与卡片在非 `root` 分组时用它分节。
 *
 * 同一份记忆只会落在一列里；空组不会出现（这与「列数正确」的验收口径一致）。
 * @param {Record<string, any>[]} entries - 已排序的记忆。
 * @param {string} groupBy - `root`|`kind`|`group`。
 * @param {{ rootOf?: (entry: Record<string, any>) => string }} [context] - `root` 需要调用方提供根记忆组解析。
 * @returns {{ key: string, label: string, entries: Record<string, any>[] }[]} 分组，`未分组` 永远最后。
 */
export function groupEntries(entries, groupBy, context = {}) {
  const mode = oneOf(groupBy, VIEW_GROUPINGS, 'root')
  const rootOf = typeof context.rootOf === 'function' ? context.rootOf : groupLabelOf
  const resolve = mode === 'kind' ? kindLabelOf : mode === 'group' ? groupLabelOf : entry => text(rootOf(entry)).trim() || UNGROUPED
  const buckets = new Map()
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry) continue
    const label = text(resolve(entry)).trim() || UNGROUPED
    if (!buckets.has(label)) buckets.set(label, [])
    buckets.get(label).push(entry)
  }
  const order = mode === 'kind' ? Object.values(KIND_LABELS).concat('其他') : null
  const groups = [...buckets.entries()].map(([label, rows]) => ({ key: label, label, entries: rows }))
  groups.sort((left, right) => {
    if (order) {
      const leftIndex = order.indexOf(left.label), rightIndex = order.indexOf(right.label)
      return (leftIndex < 0 ? order.length : leftIndex) - (rightIndex < 0 ? order.length : rightIndex)
    }
    if ((left.label === UNGROUPED) !== (right.label === UNGROUPED)) return left.label === UNGROUPED ? 1 : -1
    return left.label.localeCompare(right.label, 'zh-CN')
  })
  return groups
}

/** 生效中的筛选条数（按「规则」计数，同一规则里的多个值算一条）。 */
export function activeFilterCount(filters) {
  const rules = normalizeFilters(filters)
  return (rules.kinds.length > 0 ? 1 : 0) + (rules.tags.length > 0 ? 1 : 0) + (rules.onlyBase ? 1 : 0) + (rules.onlyWithImages ? 1 : 0)
}

/**
 * 筛选只作用于「已加载的这一页」，界面必须把这条边界说出来，否则用户会把
 * 看板/表格里缺少的条目误当成不存在。
 *
 * 只有「有筛选」且「还有未加载的结果」时才需要提示；没有筛选时列表底部本来
 * 就有「加载更多」，不重复提示。
 * @param {{loaded?: number, shown?: number, hasMore?: boolean, filterCount?: number}} [input]
 * @returns {string|null}
 */
export function filterScopeNotice({ loaded = 0, shown = 0, hasMore = false, filterCount = 0 } = {}) {
  if (!filterCount || !hasMore) return null
  return `筛选只作用于已加载的 ${loaded} 条（匹配 ${shown} 条）；还有更多结果未加载`
}

/**
 * 人话描述的筛选条件，用于工具栏徽标、设置弹层与空态。
 * @param {unknown} filters - 任意来源的筛选配置。
 * @returns {string[]} 逐条描述（无筛选时为空数组）。
 */
export function describeFilters(filters) {
  const rules = normalizeFilters(filters)
  const rows = []
  if (rules.kinds.length > 0) rows.push(`类型：${rules.kinds.map(kind => KIND_LABELS[kind]).join('、')}`)
  if (rules.tags.length > 0) rows.push(`标签：${rules.tags.join('、')}`)
  if (rules.onlyBase) rows.push('只看底层约定')
  if (rules.onlyWithImages) rows.push('只看有图片')
  return rows
}

/**
 * 视图标题下的一句话说明：形状 · 分组 · 排序 ·（筛选）。
 * @param {Record<string, any>} view - 归一的视图。
 * @returns {string} 说明文本。
 */
export function describeView(view) {
  const normalized = normalizeView(view)
  const parts = [SHAPE_LABELS[normalized.shape], `按${GROUPING_LABELS[normalized.groupBy]}`, SORT_LABELS[normalized.sort]]
  const rules = describeFilters(normalized.filters)
  if (rules.length > 0) parts.push(`${rules.length} 条筛选`)
  return parts.join(' · ')
}

/** 来源的人话名字（记忆组要调用方给名字，拿不到就退回通用叫法）。 */
export function describeSource(source) {
  const normalized = normalizeSource(source)
  if (normalized.kind === 'scope') return SCOPE_LABELS[normalized.id] ?? SOURCE_LABELS.scope ?? '全部记忆'
  return SOURCE_LABELS[normalized.kind] ?? SOURCE_LABELS.all
}
