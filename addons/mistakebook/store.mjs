import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID, createHash, randomInt } from 'node:crypto'
import { NOTE_TYPES, normalizeFields, contentOf, typeAlias } from './fields.mjs'
import { SIMULATIONS } from './simulations.mjs'
import curriculum from './lib/curriculum.cjs'
import { normalizeImage, IMAGE_MAX_COUNT, IMAGE_TOTAL_BYTES } from '../../src/images.js'

export const taxonomy = JSON.parse(readFileSync(new URL('./data/taxonomy_seed.json', import.meta.url), 'utf8'))
const nodes = new Map(taxonomy.nodes.map(node => [node.id, node]))
export const reviewStates = ['new', 'reviewing', 'mastered']
const text = value => typeof value === 'string' ? value : value?.correctedText ?? value?.rawText ?? ''
const fingerprint = value => createHash('sha256').update(value.normalize('NFKC').replace(/\s+/g, '').trim()).digest('hex')
const dedupKey = record => fingerprint(`${record.type ?? 'mistake'}\n${record.type === 'vocabulary' ? record.vocabulary.word.toLowerCase() : record.stem.trim() || record.title}`)
export const contentHash = record => createHash('sha256').update(JSON.stringify({ ...contentOf(record), images: (record.images ?? []).map(image => image.sha256 ?? createHash('sha256').update(Buffer.from(image.data ?? '', 'base64')).digest('hex')) })).digest('hex')
const english = value => String(value ?? '').normalize('NFKC').trim().toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ')
function bounded(value, max = 100000) {
  const result = text(value)
  if (result.length > max) throw new Error('题目文字过长')
  return result
}
export function segmentQuestions(input) {
  const source = bounded(input).trim()
  if (!source) throw new Error('请填写题目文字')
  const result = [], numbered = /^\s*(?:#{1,6}\s*)?(?:\d{1,3}[.．、](?!\d)|[（(]\d{1,3}[）)]|第\s*\d+\s*题)\s*/
  let current = []
  for (const line of source.split(/\r?\n/)) {
    if (numbered.test(line) && current.join('\n').trim()) { result.push(current.join('\n').trim()); current = [] }
    current.push(line.replace(numbered, ''))
  }
  if (current.join('\n').trim()) result.push(current.join('\n').trim())
  if (result.length > 300) throw new Error('一次最多导入 300 道题，请分批导入')
  return result
}
export function classify(source) {
  let best, score = 0
  for (const node of taxonomy.nodes) {
    if (!node.parentID || !node.isActive) continue
    const hits = [node.name, ...(node.aliases ?? []).filter(alias => !alias.startsWith('grade:'))].reduce((n, word) => n + (source.includes(word) ? word.length : 0), 0)
    if (hits > score) { best = node; score = hits }
  }
  return { subjectID: best?.subjectID ?? '', primaryNodeID: best?.id ?? '', assignmentState: best ? 'suggested' : 'unclassified' }
}
function dueState(record) {
  if (!record.nextReviewAt) return 'unplanned'
  const overdue = Date.now() - Date.parse(record.nextReviewAt)
  return overdue < 0 ? 'notDue' : overdue > 7 * 86400000 ? 'overdueLong' : 'overdueShort'
}
export function evaluate(record) {
  const now = Date.now(), next = record.nextReviewAt ? Date.parse(record.nextReviewAt) : null
  return curriculum.evaluate({
    nodeID: record.nodeID, target: record.target, repeatCount: record.repeatCount, mastery: record.mastery, dueState: dueState(record), reviewState: record.reviewState,
    daysOverdue: next && now > next ? (now - next) / 86400000 : 0,
    daysUntil: next && next > now ? (next - now) / 86400000 : 0,
    lastReviewAt: record.reviewHistory?.at(-1)?.at ?? record.updatedAt ?? null,
  })
}
// 手写/普通笔记合并：旧 handwriting 记录一律按 note 处理。
const merged_type = (raw, previous) => raw?.type ?? previous?.type ?? 'mistake'
function normalize(raw, previous = {}) {
  const merged = { ...previous, ...raw, type: typeAlias(merged_type(raw, previous)) }
  const type = merged.type
  if (!Object.hasOwn(NOTE_TYPES, type)) throw new Error('无效的笔记类型')
  const physics = normalizeFields('physics', merged.physics), method = normalizeFields('method', merged.method), vocabulary = normalizeFields('vocabulary', merged.vocabulary)
  const simulationId = String(merged.simulationId ?? '')
  if (simulationId && !SIMULATIONS.some(item => item.id === simulationId)) throw new Error('无效的物理仿真')
  const classification = merged.classification ?? classify(`${text(merged.stem)}\n${text(merged.studentWork)}`)
  const nodeID = String(merged.nodeID ?? classification.primaryNodeID ?? '')
  if (nodeID && !nodes.has(nodeID)) throw new Error('知识点不存在，请重新选择')
  const subjectID = nodes.get(nodeID)?.subjectID ?? String(merged.subjectID || (type === 'physics' ? 'physics' : type === 'vocabulary' ? 'english' : classification.subjectID) || '')
  if (subjectID && !nodes.has(subjectID)) throw new Error('学科不存在')
  const reviewState = merged.reviewState ?? 'new'
  if (!reviewStates.includes(reviewState)) throw new Error('无效的复习状态')
  const repeatCount = Number(merged.repeatCount ?? 0), mastery = Number(merged.mastery ?? (reviewState === 'mastered' ? 1 : reviewState === 'reviewing' ? .5 : 0)), reciteCount = Number(merged.reciteCount ?? 0)
  if (!Number.isInteger(repeatCount) || repeatCount < 0 || repeatCount > 100000 || !Number.isFinite(mastery) || mastery < 0 || mastery > 1) throw new Error('复习次数或掌握度无效')
  if (!Number.isInteger(reciteCount) || reciteCount < 0 || reciteCount > 100000) throw new Error('背诵次数无效')
  const sortIndex = merged.sortIndex ?? null
  if (sortIndex !== null && (!Number.isInteger(sortIndex) || sortIndex < 0 || sortIndex > 1000000000)) throw new Error('排列位置无效')
  if (merged.nextReviewAt && !Number.isFinite(Date.parse(merged.nextReviewAt))) throw new Error('复习时间无效')
  let aiResult = merged.aiResult ?? null
  if (aiResult) {
    if (!Object.hasOwn(NOTE_TYPES, aiResult.type) || typeof aiResult.inputHash !== 'string' || !/^[a-f0-9]{64}$/.test(aiResult.inputHash)) throw new Error('AI 草稿格式无效')
    aiResult = { type: aiResult.type, text: bounded(aiResult.text, 40000), inputHash: aiResult.inputHash, generatedAt: bounded(aiResult.generatedAt, 100),
      fields: { referenceAnswer: bounded(aiResult.fields?.referenceAnswer), notes: bounded(aiResult.fields?.notes),
        ...fieldsForAI(aiResult.type, aiResult.fields) } }
  }
  return { id: previous.id ?? randomUUID(), type, title: bounded(merged.title ?? (type === 'vocabulary' ? vocabulary.word : ''), 500), physics, method, vocabulary, aiResult, simulationId,
    stem: bounded(merged.stem), studentWork: bounded(merged.studentWork), referenceAnswer: bounded(merged.referenceAnswer),
    notes: bounded(merged.notes), errorType: bounded(merged.errorType, 100), cause: bounded(merged.cause ?? merged.analysisResult?.conclusion, 30000),
    subjectID, nodeID, legacyNodeID: bounded(merged.legacyNodeID, 500), legacySubjectID: bounded(merged.legacySubjectID, 500), classificationSuggested: raw.nodeID !== undefined ? false : Boolean(previous.classificationSuggested ?? classification.assignmentState === 'suggested'),
    tags: Array.isArray(merged.tags) ? merged.tags.slice(0, 30).map(tag => bounded(tag, 100)) : [], target: merged.target === 'huige' ? 'huige' : 'gaokao',
    reviewState, repeatCount, reciteCount, sortIndex, mastery, nextReviewAt: merged.nextReviewAt ?? null, reviewHistory: Array.isArray(merged.reviewHistory) ? merged.reviewHistory.slice(-200).map(item => ({ at: String(item.at), result: item.result === 'pass' ? 'pass' : 'fail' })) : [],
    isArchived: Boolean(merged.isArchived), isSoftDeleted: Boolean(merged.isSoftDeleted), createdAt: previous.createdAt ?? merged.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(), revision: (previous.revision ?? 0) + 1 }
}
function fieldsForAI(type, fields = {}) { return ['physics','method','vocabulary'].includes(type) ? { [type]: normalizeFields(type, fields[type]) } : {} }

export class MistakebookStore {
  // 两种模式：
  //  - new MistakebookStore(path)：自建独立数据库文件（历史行为，测试在用）。
  //  - new MistakebookStore({ database })：注入 vault 的 DatabaseSync 连接，
  //    在其中创建/使用 notebook_* 前缀表，不拥有、不关闭该连接。
  constructor(options) {
    const injected = options && typeof options === 'object' && !(options instanceof String) && typeof options !== 'string' && 'database' in options
    if (injected) {
      if (!options.database || typeof options.database.prepare !== 'function') throw new Error('database 必须是 DatabaseSync 实例')
      this.db = options.database
      this.path = options.path ?? null
      this.ownsDb = false
      this.tables = { meta: 'notebook_meta', questions: 'notebook_questions', images: 'notebook_images', ai: 'notebook_ai_messages' }
      this.quizzes = new Map()
    } else {
      const path = typeof options === 'string' ? options : options?.path
      if (!path) throw new Error('MistakebookStore 需要文件路径或 { database }')
      this.path = path
      this.ownsDb = true
      this.tables = { meta: 'addon_meta', questions: 'questions', images: 'question_images', ai: 'ai_messages' }
      this.quizzes = new Map()
      mkdirSync(dirname(path), { recursive: true })
      this.db = new DatabaseSync(path)
    }
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
    const { meta, questions, images, ai } = this.tables
    const hasMeta = this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='${meta}'`).get()
    const version = hasMeta ? this.db.prepare(`SELECT value FROM ${meta} WHERE key='schema'`).get()?.value : null
    if (version && !['1','2'].includes(version)) { if (this.ownsDb) this.db.close(); throw new Error('笔记本数据库版本较新，请使用对应版本') }
    if (version === '1') {
      this.migrationBackup = `${this.path}.v1-${Date.now()}-${randomUUID()}.bak`
      this.db.prepare('VACUUM INTO ?').run(this.migrationBackup)
    }
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS ${meta}(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ${questions}(id TEXT PRIMARY KEY, payload TEXT NOT NULL, fingerprint TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS ${questions}_fingerprint ON ${questions}(fingerprint);
      CREATE TABLE IF NOT EXISTS ${images}(id TEXT PRIMARY KEY, question_id TEXT NOT NULL REFERENCES ${questions}(id) ON DELETE CASCADE,
        name TEXT NOT NULL, mime_type TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, sha256 TEXT NOT NULL, data BLOB NOT NULL, UNIQUE(question_id,sha256));
      CREATE TABLE IF NOT EXISTS ${ai}(id TEXT PRIMARY KEY, role TEXT NOT NULL, content TEXT NOT NULL, question_id TEXT, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS ${ai}_created ON ${ai}(created_at);`)
    try { this.transaction(() => {
      if (version === '1') for (const previous of this.records()) {
        const converted = { ...normalize(previous, previous), updatedAt: previous.updatedAt, revision: previous.revision, classificationSuggested: previous.classificationSuggested }
        this.db.prepare(`UPDATE ${questions} SET payload=?, fingerprint=? WHERE id=?`).run(JSON.stringify(converted), dedupKey(converted), previous.id)
      }
      this.db.prepare(`INSERT INTO ${meta} VALUES('schema','2') ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run()
    }) } catch (error) { if (this.ownsDb) this.db.close(); throw error }
  }
  close() { if (this.ownsDb) this.db.close() }
  // 把旧独立库（mistakebook.sqlite）的数据整库搬进当前连接的 notebook_* 表。
  // 幂等：已迁移过（notebook_meta 有标记且 legacy 无新增数据）或 legacy 不存在则跳过。
  migrateFromFile(legacyPath) {
    if (!existsSync(legacyPath)) return { migrated: false, reason: 'missing' }
    if (this.migrationFromFile?.path === legacyPath) return { migrated: false, reason: 'already' }
    const backup = `${legacyPath}.bak-${Date.now()}`
    this.db.prepare('VACUUM INTO ?').run(backup)
    const { meta, questions, images } = this.tables
    // ATTACH/DETACH 不能发生在事务内：先挂载，事务搬数据，事务提交后再卸载。
    this.db.exec(`ATTACH DATABASE '${String(legacyPath).replaceAll("'", "''")}' AS legacy_nb`)
    try {
      const result = this.transaction(() => {
        const hasLegacyQuestions = this.db.prepare("SELECT 1 FROM legacy_nb.sqlite_master WHERE type='table' AND name='questions'").get()
        const legacyCount = hasLegacyQuestions ? this.db.prepare('SELECT count(*) AS n FROM legacy_nb.questions').get().n : 0
        const done = this.db.prepare(`SELECT value FROM ${meta} WHERE key='migratedFrom'`).get()
        let previous = null
        try { previous = done ? JSON.parse(done.value) : null } catch { previous = null }
        if (previous && legacyCount <= (previous.count ?? 0)) return { migrated: false, reason: 'already' }
        let count = 0
        if (legacyCount) {
          this.db.exec(`INSERT OR REPLACE INTO ${questions}(id, payload, fingerprint) SELECT id, payload, fingerprint FROM legacy_nb.questions`)
          this.db.exec(`INSERT OR IGNORE INTO ${images}(id, question_id, name, mime_type, width, height, sha256, data)
            SELECT id, question_id, name, mime_type, width, height, sha256, data FROM legacy_nb.question_images`)
          // 防孤儿：清掉指向缺失题目的图片
          this.db.prepare(`DELETE FROM ${images} WHERE question_id NOT IN (SELECT id FROM ${questions})`).run()
          count = legacyCount
        }
        const hasLegacyMeta = this.db.prepare("SELECT 1 FROM legacy_nb.sqlite_master WHERE type='table' AND name='addon_meta'").get()
        const legacySidebar = hasLegacyMeta ? this.db.prepare("SELECT value FROM legacy_nb.addon_meta WHERE key='sidebar'").get()?.value ?? null : null
        if (legacySidebar && !this.db.prepare(`SELECT 1 FROM ${meta} WHERE key='sidebar'`).get())
          this.db.prepare(`INSERT INTO ${meta}(key, value) VALUES('sidebar', ?)`).run(legacySidebar)
        const marker = JSON.stringify({ path: String(legacyPath), count, at: new Date().toISOString() })
        if (previous) this.db.prepare(`UPDATE ${meta} SET value=? WHERE key='migratedFrom'`).run(marker)
        else this.db.prepare(`INSERT INTO ${meta}(key, value) VALUES('migratedFrom', ?)`).run(marker)
        this.migrationFromFile = { path: legacyPath }
        return { migrated: true, count, backup }
      })
      return result
    } finally { this.db.exec('DETACH DATABASE legacy_nb') }
  }
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = action(); this.db.exec('COMMIT'); return result } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  require(id) {
    const row = this.db.prepare(`SELECT payload FROM ${this.tables.questions} WHERE id=?`).get(String(id))
    if (!row) throw new Error('题目不存在')
    return JSON.parse(row.payload)
  }
  listImages(id, includeData = false) {
    return this.db.prepare(`SELECT * FROM ${this.tables.images} WHERE question_id=? ORDER BY rowid`).all(id).map(image => ({
      id: image.id, name: image.name, mimeType: image.mime_type, width: image.width, height: image.height, size: image.data.length, sha256: image.sha256,
      ...(includeData ? { data: Buffer.from(image.data).toString('base64') } : {}),
    }))
  }
  read(id) { const record = this.require(id), images = this.listImages(id, true), hash = contentHash({ ...record, images }); return { ...record, images, value: evaluate(record), contentHash: hash, aiStale: Boolean(record.aiResult && record.aiResult.inputHash !== hash) } }
  records() { return this.db.prepare(`SELECT payload FROM ${this.tables.questions}`).all().map(row => JSON.parse(row.payload)) }
  list({ view = 'all', type = '', subjectID = '', nodeID = '', query = '', tag = '', order = 'priority' } = {}) {
    const active = this.records(), now = Date.now()
    const stats = { all: 0, due: 0, mastered: 0, archived: 0, trash: 0, subjects: {}, types: {}, tags: {} }
    for (const row of active) {
      if (row.isSoftDeleted) { stats.trash++; continue }
      if (row.isArchived) { stats.archived++; continue }
      stats.all++; stats.types[row.type] = (stats.types[row.type] ?? 0) + 1; stats.subjects[row.subjectID] = (stats.subjects[row.subjectID] ?? 0) + 1
      for (const name of row.tags) stats.tags[name] = (stats.tags[name] ?? 0) + 1
      if (row.reviewState === 'mastered') stats.mastered++
      else if (!row.nextReviewAt || Date.parse(row.nextReviewAt) <= now) stats.due++
    }
    const terms = String(query).toLocaleLowerCase().trim().split(/\s+/).filter(Boolean)
    const records = active.filter(row => {
      if (view === 'trash') { if (!row.isSoftDeleted) return false } else if (row.isSoftDeleted) return false
      if (view === 'archived') { if (!row.isArchived) return false } else if (view !== 'trash' && row.isArchived) return false
      if (view === 'due' && (row.reviewState === 'mastered' || row.nextReviewAt && Date.parse(row.nextReviewAt) > now)) return false
      if (view === 'mastered' && row.reviewState !== 'mastered') return false
      if (type && row.type !== type) return false
      if (subjectID && row.subjectID !== subjectID) return false
      if (nodeID && row.nodeID !== nodeID && !row.nodeID.startsWith(`${nodeID}/`)) return false
      if (tag && !row.tags.includes(tag)) return false
      return terms.every(term => `${JSON.stringify(contentOf(row))}\n${row.tags.join(' ')}`.toLocaleLowerCase().includes(term))
    }).map(row => ({ ...row, imageCount: this.listImages(row.id).length, value: evaluate(row) }))
    records.sort((a, b) => order === 'updated' ? b.updatedAt.localeCompare(a.updatedAt) : order === 'manual' ? (a.sortIndex ?? Infinity) - (b.sortIndex ?? Infinity) || b.updatedAt.localeCompare(a.updatedAt) : b.value.overallScore - a.value.overallScore || b.updatedAt.localeCompare(a.updatedAt))
    return { records, stats, taxonomy, path: this.path, sidebar: this.sidebarConfig(), prefs: this.prefs() }
  }
  save(raw) {
    if (!raw || typeof raw !== 'object') throw new Error('无效的题目')
    return this.transaction(() => this.saveInside(raw))
  }
  saveInside(raw) {
    const previous = raw.id ? this.require(raw.id) : undefined
    if (previous && raw.revision !== previous.revision) throw new Error('题目已被其他窗口修改，请重新打开后保存')
    const record = normalize(raw, previous)
    const images = raw.images ?? (previous ? this.listImages(record.id) : [])
    if (!Array.isArray(images) || images.length > IMAGE_MAX_COUNT) throw new Error('每道题最多 16 张图片')
    let size = 0
    const prepared = images.map(image => {
      if (image.id) {
        const stored = this.db.prepare(`SELECT * FROM ${this.tables.images} WHERE id=? AND question_id=?`).get(String(image.id), record.id)
        if (!stored) throw new Error('图片不属于当前题目')
        size += stored.data.length; return { stored }
      }
      const normalized = normalizeImage(image); size += normalized.size; return { normalized }
    })
    if (size > IMAGE_TOTAL_BYTES) throw new Error('每道题的图片总计不能超过 20 MB')
    if (record.type === 'vocabulary' && !record.vocabulary.word.trim()) throw new Error('请填写英语单词或短语')
    if (!record.stem.trim() && !images.length && !(record.type === 'vocabulary' ? record.vocabulary.word.trim() : record.type !== 'mistake' && (record.title.trim() || Object.values(record[record.type] ?? {}).some(value => value.trim())))) throw new Error('请填写题干、笔记内容或添加图片')
    this.db.prepare(`INSERT INTO ${this.tables.questions} VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, fingerprint=excluded.fingerprint`)
      .run(record.id, JSON.stringify(record), dedupKey(record))
    const keep = new Set(prepared.filter(image => image.stored).map(image => image.stored.id))
    for (const old of this.listImages(record.id)) if (!keep.has(old.id)) this.db.prepare(`DELETE FROM ${this.tables.images} WHERE id=?`).run(old.id)
    const insert = this.db.prepare(`INSERT OR IGNORE INTO ${this.tables.images} VALUES(?,?,?,?,?,?,?,?)`)
    for (const { normalized: image } of prepared) if (image) insert.run(randomUUID(), record.id, image.name, image.mimeType, image.width, image.height, image.sha256, image.bytes)
    return this.read(record.id)
  }
  action(id, action) {
    return this.transaction(() => {
      const record = this.require(id)
      if (action === 'purge') {
        if (!record.isSoftDeleted) throw new Error('只有回收站中的题目可永久删除')
        this.db.prepare(`DELETE FROM ${this.tables.questions} WHERE id=?`).run(id); return { removed: true }
      }
      if (action === 'delete') record.isSoftDeleted = true
      else if (action === 'restore') record.isSoftDeleted = false
      else if (action === 'archive') record.isArchived = true
      else if (action === 'unarchive') record.isArchived = false
      else if (['pass', 'fail'].includes(action)) {
        if (record.isSoftDeleted || record.isArchived) throw new Error('请先恢复题目再复习')
        const pass = action === 'pass'
        record.mastery = pass ? Math.min(1, record.mastery + .35) : Math.max(0, record.mastery - .4)
        record.repeatCount += pass ? 0 : 1
        record.reviewState = record.mastery >= .95 ? 'mastered' : 'reviewing'
        record.nextReviewAt = new Date(Date.now() + (pass ? record.reviewState === 'mastered' ? 14 : 3 : 1) * 86400000).toISOString()
        record.reviewHistory.push({ at: new Date().toISOString(), result: action })
        record.reviewHistory = record.reviewHistory.slice(-200)
      } else throw new Error('未知题目操作')
      return this.saveInside({ ...record })
    })
  }
  // —— AI 查询记录：与笔记数据同库、独立表域，可整理成笔记 ——
  aiAppend({ role, content, questionId = null } = {}) {
    const who = role === 'assistant' ? 'assistant' : 'user'
    const body = bounded(content, 40000).trim()
    if (!body) throw new Error('AI 记录内容为空')
    const id = randomUUID()
    this.db.prepare(`INSERT INTO ${this.tables.ai}(id,role,content,question_id,created_at) VALUES(?,?,?,?,?)`)
      .run(id, who, body, questionId ? String(questionId) : null, new Date().toISOString())
    return { id, role: who, content: body, questionId: questionId ? String(questionId) : null }
  }
  aiHistory(limit = 60) {
    const size = Math.max(1, Math.min(500, Number(limit) || 60))
    return this.db.prepare(`SELECT id, role, content, question_id, created_at FROM ${this.tables.ai} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(size).reverse().map(row => ({ id: row.id, role: row.role, content: row.content, questionId: row.question_id, createdAt: row.created_at }))
  }
  aiClear() {
    const before = this.db.prepare(`SELECT COUNT(*) AS n FROM ${this.tables.ai}`).get().n
    this.db.prepare(`DELETE FROM ${this.tables.ai}`).run()
    return { removed: Number(before) }
  }
  // 把一轮问答整理成一篇笔记（类型 note），标题取问题首行，正文含问与答。
  aiToNote(questionId, title = '') {
    return this.transaction(() => {
      const rows = this.db.prepare(`SELECT id, role, content FROM ${this.tables.ai} WHERE id=? OR question_id=? ORDER BY created_at, rowid`).all(String(questionId), String(questionId))
      if (!rows.length) throw new Error('找不到这条 AI 记录')
      const question = rows.find(row => row.role === 'user')?.content ?? ''
      const answer = rows.filter(row => row.role === 'assistant').map(row => row.content).join('\n\n')
      const text = [question && `问：${question}`, answer && `答：${answer}`].filter(Boolean).join('\n\n')
      if (!text.trim()) throw new Error('这条记录没有可整理的内容')
      const heading = bounded(title, 500).trim() || question.split('\n').map(line => line.trim()).find(Boolean)?.slice(0, 60) || 'AI 问答'
      return this.saveInside({ type: 'note', title: heading, stem: text, tags: ['AI 问答'] })
    })
  }
  // —— 侧边栏配置：存 addon_meta（数据库），与记忆库侧边栏同为数据驱动 ——
  sidebarConfig() {
    const row = this.db.prepare(`SELECT value FROM ${this.tables.meta} WHERE key='sidebar'`).get()
    if (!row) return null
    try {
      const value = JSON.parse(row.value)
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null
    } catch { return null }
  }
  // —— 界面偏好（布局/排序等）：整包存 meta，随 list 返回 ——
  prefs() {
    const row = this.db.prepare(`SELECT value FROM ${this.tables.meta} WHERE key='prefs'`).get()
    if (!row) return {}
    try {
      const value = JSON.parse(row.value)
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    } catch { return {} }
  }
  setPrefs(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('偏好数据无效')
    const text = JSON.stringify(raw)
    if (text.length > 100000) throw new Error('偏好数据过大')
    this.db.prepare(`INSERT INTO ${this.tables.meta} VALUES('prefs',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(text)
    return { saved: true }
  }
  setSidebar(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('侧边栏配置无效')
    const text = JSON.stringify(raw)
    if (text.length > 100000) throw new Error('侧边栏配置过大')
    this.db.prepare(`INSERT INTO ${this.tables.meta} VALUES('sidebar',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(text)
    return { saved: true }
  }
  // 拖动改分类：笔记卡片拖到侧边栏学科项 → 换学科；拖到标签 → 补标签。
  assign(id, { subjectID = '', tag = '' } = {}) {
    return this.transaction(() => {
      const record = this.require(id)
      if (tag) {
        const name = bounded(tag, 30).trim()
        if (!name) throw new Error('标签无效')
        if (record.tags.includes(name)) return this.read(id)
        return this.saveInside({ ...record, tags: [...record.tags, name] })
      }
      if (subjectID) {
        if (!nodes.has(subjectID)) throw new Error('学科不存在')
        return this.saveInside({ ...record, subjectID, nodeID: '' })
      }
      throw new Error('请指明学科或标签')
    })
  }
  import(input) {
    const rows = Array.isArray(input) ? input : Array.isArray(input?.records) ? input.records : input?.records && typeof input.records === 'object' ? Object.values(input.records) : null
    if (!rows || rows.length > 3000) throw new Error('请选择错题本 JSON；一次最多 3000 道题')
    const sidebar = input && !Array.isArray(input) && input.sidebar && typeof input.sidebar === 'object' ? input.sidebar : null
    if (sidebar) this.setSidebar(sidebar)
    return this.transaction(() => {
      const known = new Set(this.records().filter(record => record.stem.trim() || record.title.trim() || record.type === 'vocabulary').map(dedupKey))
      let created = 0, skipped = 0, unmapped = 0, missingImages = 0
      for (const row of rows) {
        if (!row || typeof row !== 'object') throw new Error('导入包含无效题目，尚未保存')
        const stem = bounded(row.stem), draft = { ...row, type: row.type ?? 'mistake', stem, title: bounded(row.title), vocabulary: normalizeFields('vocabulary',row.vocabulary) }, hash = dedupKey(draft)
        const hasKey = stem.trim() || draft.title.trim() || draft.type === 'vocabulary'
        if (hasKey && known.has(hash)) { skipped++; continue }
        const images = (row.images ?? []).map(image => ({ name: image.name, mimeType: image.mimeType, data: image.data }))
        const candidate = { ...row, id: undefined, revision: undefined, images }
        const legacyNodeID = String(row.nodeID ?? row.classification?.primaryNodeID ?? '')
        const legacySubjectID = String(row.subjectID ?? row.classification?.subjectID ?? '')
        if (legacyNodeID && !nodes.has(legacyNodeID)) { candidate.nodeID = ''; candidate.legacyNodeID = legacyNodeID; unmapped++ }
        if (legacySubjectID && !nodes.has(legacySubjectID)) { candidate.subjectID = ''; candidate.legacySubjectID = legacySubjectID }
        if (row.imageAssetID || row.sourceRegions?.length) { candidate.notes = `${text(row.notes)}\n旧版图片为外部资源引用，请从原项目补充原图。`.trim(); missingImages++ }
        this.saveInside(candidate)
        if (hasKey) known.add(hash); created++
      }
      return { created, skipped, unmapped, missingImages }
    })
  }
  // 词典查询落库：新词条自动进入单词库并记为第 1 次背诵；重复查询不新建、
  // 不覆盖已有人工内容，只把背诵次数加一（与导入去重一样覆盖归档与回收站）。
  vocabularyByWord(word) {
    const key = english(String(word ?? '').replace(/\s+/g, ' ').trim())
    return key ? this.records().find(row => row.type === 'vocabulary' && english(row.vocabulary?.word ?? '') === key) : undefined
  }
  bumpLookup(word) {
    return this.transaction(() => {
      const existing = this.vocabularyByWord(word)
      return existing ? { created: false, record: this.saveInside({ ...existing, reciteCount: (existing.reciteCount ?? 0) + 1 }) } : null
    })
  }
  recordLookup(entry) {
    return this.transaction(() => {
      const vocabulary = normalizeFields('vocabulary', entry)
      const word = vocabulary.word.trim()
      if (!word) throw new Error('请填写英语单词或短语')
      const existing = this.vocabularyByWord(word)
      if (existing) return { created: false, record: this.saveInside({ ...existing, reciteCount: (existing.reciteCount ?? 0) + 1 }) }
      return { created: true, record: this.saveInside({ type: 'vocabulary', title: word, vocabulary, reciteCount: 1 }) }
    })
  }
  // 自由排列：把当前视图的记录按调用方给出的新顺序依次写 sortIndex。
  // 未列出的记录保持原位（旧 sortIndex 不变），手动排序按 index 升序、
  // 未排过的排在其后并按更新时间倒序。
  reorder(ids) {
    const list = [...new Set((Array.isArray(ids) ? ids : []).map(id => String(id)))]
    if (!list.length) throw new Error('没有可排列的笔记')
    return this.transaction(() => {
      let index = 0
      for (const id of list) this.saveInside({ ...this.require(id), sortIndex: index++ })
      return { ordered: list.length }
    })
  }
  acceptAI(id) {
    const record = this.read(id)
    if (!record.aiResult || record.aiStale || record.aiResult.type !== record.type) throw new Error('AI 草稿已过期或不存在，请重新生成')
    const fields = record.aiResult.fields
    for (const name of ['referenceAnswer','notes']) if (!record[name].trim() && fields[name]) record[name] = fields[name]
    if (fields[record.type]) for (const [key,value] of Object.entries(fields[record.type])) if (!record[record.type][key].trim()) record[record.type][key] = value
    // Preserve the AI draft's provenance after its own fields were accepted.
    record.aiResult.inputHash = contentHash(record)
    return this.save(record)
  }
  planQuiz(count = 10) {
    if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error('每次检测请选择 1 到 20 个词')
    const records = this.records().filter(row => row.type === 'vocabulary' && !row.isSoftDeleted && !row.isArchived && row.vocabulary.word.trim() && row.vocabulary.meaning.trim())
    for (let i=records.length-1;i>0;i--) { const j=randomInt(i+1); [records[i],records[j]]=[records[j],records[i]] }
    if (!records.length) throw new Error('请先录入至少一个有中文释义的英语词条')
    return records.slice(0,count).map(record=>this.read(record.id))
  }
  startQuiz(records, exercises = null) {
    if (!records.length || records.some(record=>{ const current=this.read(record.id); return record.contentHash!==current.contentHash || current.isArchived || current.isSoftDeleted })) throw new Error('词条已变更，请重新开始检测')
    for (const [id,session] of this.quizzes) if (Date.now()-session.createdAt>30*60000) this.quizzes.delete(id)
    if (this.quizzes.size >= 10) throw new Error('打开的检测过多，请完成现有检测或稍后重试')
    const id=randomUUID(), questions=records.map(row=>({id:row.id,prompt:exercises?.find(item=>item.id===row.id)?.prompt ?? row.vocabulary.meaning, hint:exercises?.find(item=>item.id===row.id)?.hint ?? '写出对应的英语单词或短语'}))
    this.quizzes.set(id,{createdAt:Date.now(),records:records.map(row=>({id:row.id,word:row.vocabulary.word,hash:contentHash(this.read(row.id))})),questions})
    return {id,mode:exercises?'cloze':'spelling',questions}
  }
  submitQuiz(id, answers) {
    const session=this.quizzes.get(id)
    if (!session || Date.now()-session.createdAt>30*60000) throw new Error('检测已提交或已过期，请重新开始')
    if (!Array.isArray(answers) || answers.length > session.records.length || new Set(answers.map(row=>row.id)).size !== answers.length || answers.some(row=>!session.records.some(record=>record.id===row.id) || typeof row.answer!=='string' || row.answer.length>300)) throw new Error('检测答案格式无效')
    const results=this.transaction(()=>session.records.map(item=>{
      const answer=answers.find(row=>row.id===item.id)?.answer ?? '', correct=english(answer)===english(item.word)
      if (!this.db.prepare(`SELECT 1 FROM ${this.tables.questions} WHERE id=?`).get(item.id)) return {id:item.id,answer,expected:item.word,correct,recorded:false}
      const record=this.read(item.id)
      if (record.contentHash!==item.hash || record.isSoftDeleted || record.isArchived) return {id:item.id,answer,expected:item.word,correct,recorded:false}
      const passed=correct
      record.mastery=passed?Math.min(1,record.mastery+.35):Math.max(0,record.mastery-.4);record.repeatCount+=passed?0:1
      record.reviewState=record.mastery>=.95?'mastered':'reviewing';record.nextReviewAt=new Date(Date.now()+(passed?3:1)*86400000).toISOString()
      record.reviewHistory.push({at:new Date().toISOString(),result:passed?'pass':'fail'});this.saveInside(record)
      return {id:item.id,answer,expected:item.word,correct,recorded:true}
    }))
    this.quizzes.delete(id)
    return {score:Math.round(results.filter(row=>row.correct).length/results.length*100),results}
  }
  export() { return { format: 'memory-vault-notebook', schemaVersion: 2, exportedAt: new Date().toISOString(), sidebar: this.sidebarConfig(), records: this.records().map(row => ({ ...row, images: this.listImages(row.id, true) })) } }
  backupTo(path) {
    if (this.ownsDb) { this.db.prepare('VACUUM INTO ?').run(path); return }
    // 注入模式（与数据库同库承载）：备份只投影本域 notebook_* 表，落成
    // 独立传统格式（可直接以文件模式打开，或经 migrateFromFile 迁回），
    // 绝不携带数据库（vault）域的任何数据。
    const target = new DatabaseSync(path)
    try {
      target.exec(`PRAGMA journal_mode=DELETE;
        CREATE TABLE addon_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE questions(id TEXT PRIMARY KEY, payload TEXT NOT NULL, fingerprint TEXT NOT NULL);
        CREATE INDEX questions_fingerprint ON questions(fingerprint);
        CREATE TABLE question_images(id TEXT PRIMARY KEY, question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
          name TEXT NOT NULL, mime_type TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, sha256 TEXT NOT NULL, data BLOB NOT NULL, UNIQUE(question_id,sha256));`)
      const { meta, questions, images } = this.tables
      for (const row of this.db.prepare(`SELECT key,value FROM ${meta}`).all()) target.prepare('INSERT INTO addon_meta VALUES(?,?)').run(row.key, row.value)
      for (const row of this.db.prepare(`SELECT id,payload,fingerprint FROM ${questions}`).all()) target.prepare('INSERT INTO questions VALUES(?,?,?)').run(row.id, row.payload, row.fingerprint)
      const insertImage = target.prepare('INSERT INTO question_images VALUES(?,?,?,?,?,?,?,?)')
      for (const row of this.db.prepare(`SELECT id,question_id,name,mime_type,width,height,sha256,data FROM ${images}`).all()) insertImage.run(row.id, row.question_id, row.name, row.mime_type, row.width, row.height, row.sha256, row.data)
      target.close()
    } catch (error) {
      try { target.close() } catch { /* 已关闭 */ }
      try { rmSync(path, { force: true }) } catch { /* 由调用方处理 */ }
      throw error
    }
  }
}
