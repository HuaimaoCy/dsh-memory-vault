import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import curriculum from './lib/curriculum.cjs'
import { normalizeImage, IMAGE_MAX_COUNT, IMAGE_TOTAL_BYTES } from '../../src/images.js'

export const taxonomy = JSON.parse(readFileSync(new URL('./data/taxonomy_seed.json', import.meta.url), 'utf8'))
const nodes = new Map(taxonomy.nodes.map(node => [node.id, node]))
export const reviewStates = ['new', 'reviewing', 'mastered']
const text = value => typeof value === 'string' ? value : value?.correctedText ?? value?.rawText ?? ''
const fingerprint = value => createHash('sha256').update(value.normalize('NFKC').replace(/\s+/g, '').trim()).digest('hex')
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
  return curriculum.evaluate({ nodeID: record.nodeID, target: record.target, repeatCount: record.repeatCount, mastery: record.mastery, dueState: dueState(record) })
}
function normalize(raw, previous = {}) {
  const merged = { ...previous, ...raw }
  const classification = merged.classification ?? classify(`${text(merged.stem)}\n${text(merged.studentWork)}`)
  const nodeID = String(merged.nodeID ?? classification.primaryNodeID ?? '')
  if (nodeID && !nodes.has(nodeID)) throw new Error('知识点不存在，请重新选择')
  const subjectID = nodes.get(nodeID)?.subjectID ?? String(merged.subjectID ?? classification.subjectID ?? '')
  if (subjectID && !nodes.has(subjectID)) throw new Error('学科不存在')
  const reviewState = merged.reviewState ?? 'new'
  if (!reviewStates.includes(reviewState)) throw new Error('无效的复习状态')
  const repeatCount = Number(merged.repeatCount ?? 0), mastery = Number(merged.mastery ?? (reviewState === 'mastered' ? 1 : reviewState === 'reviewing' ? .5 : 0))
  if (!Number.isInteger(repeatCount) || repeatCount < 0 || repeatCount > 100000 || !Number.isFinite(mastery) || mastery < 0 || mastery > 1) throw new Error('复习次数或掌握度无效')
  if (merged.nextReviewAt && !Number.isFinite(Date.parse(merged.nextReviewAt))) throw new Error('复习时间无效')
  return { id: previous.id ?? randomUUID(), stem: bounded(merged.stem), studentWork: bounded(merged.studentWork), referenceAnswer: bounded(merged.referenceAnswer),
    notes: bounded(merged.notes), errorType: bounded(merged.errorType, 100), cause: bounded(merged.cause ?? merged.analysisResult?.conclusion, 30000),
    subjectID, nodeID, legacyNodeID: bounded(merged.legacyNodeID, 500), legacySubjectID: bounded(merged.legacySubjectID, 500), classificationSuggested: raw.nodeID !== undefined ? false : Boolean(previous.classificationSuggested ?? classification.assignmentState === 'suggested'),
    tags: Array.isArray(merged.tags) ? merged.tags.slice(0, 30).map(tag => bounded(tag, 100)) : [], target: merged.target === 'huige' ? 'huige' : 'gaokao',
    reviewState, repeatCount, mastery, nextReviewAt: merged.nextReviewAt ?? null, reviewHistory: Array.isArray(merged.reviewHistory) ? merged.reviewHistory.slice(-200).map(item => ({ at: String(item.at), result: item.result === 'pass' ? 'pass' : 'fail' })) : [],
    isArchived: Boolean(merged.isArchived), isSoftDeleted: Boolean(merged.isSoftDeleted), createdAt: previous.createdAt ?? merged.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(), revision: (previous.revision ?? 0) + 1 }
}

export class MistakebookStore {
  constructor(path) {
    this.path = path
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS addon_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS questions(id TEXT PRIMARY KEY, payload TEXT NOT NULL, fingerprint TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS questions_fingerprint ON questions(fingerprint);
      CREATE TABLE IF NOT EXISTS question_images(id TEXT PRIMARY KEY, question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
        name TEXT NOT NULL, mime_type TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, sha256 TEXT NOT NULL, data BLOB NOT NULL, UNIQUE(question_id,sha256));`)
    const version = this.db.prepare("SELECT value FROM addon_meta WHERE key='schema'").get()?.value
    if (version && version !== '1') { this.db.close(); throw new Error('错题本数据库版本较新，请使用对应版本') }
    this.db.prepare("INSERT OR IGNORE INTO addon_meta VALUES('schema','1')").run()
  }
  close() { this.db.close() }
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = action(); this.db.exec('COMMIT'); return result } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  require(id) {
    const row = this.db.prepare('SELECT payload FROM questions WHERE id=?').get(String(id))
    if (!row) throw new Error('题目不存在')
    return JSON.parse(row.payload)
  }
  listImages(id, includeData = false) {
    return this.db.prepare('SELECT * FROM question_images WHERE question_id=? ORDER BY rowid').all(id).map(image => ({
      id: image.id, name: image.name, mimeType: image.mime_type, width: image.width, height: image.height, size: image.data.length,
      ...(includeData ? { data: Buffer.from(image.data).toString('base64') } : {}),
    }))
  }
  read(id) { const record = this.require(id); return { ...record, images: this.listImages(id, true), value: evaluate(record) } }
  records() { return this.db.prepare('SELECT payload FROM questions').all().map(row => JSON.parse(row.payload)) }
  list({ view = 'all', subjectID = '', nodeID = '', query = '', order = 'priority' } = {}) {
    const active = this.records(), now = Date.now()
    const stats = { all: 0, due: 0, mastered: 0, archived: 0, trash: 0, subjects: {} }
    for (const row of active) {
      if (row.isSoftDeleted) { stats.trash++; continue }
      if (row.isArchived) { stats.archived++; continue }
      stats.all++; stats.subjects[row.subjectID] = (stats.subjects[row.subjectID] ?? 0) + 1
      if (row.reviewState === 'mastered') stats.mastered++
      else if (!row.nextReviewAt || Date.parse(row.nextReviewAt) <= now) stats.due++
    }
    const terms = String(query).toLocaleLowerCase().trim().split(/\s+/).filter(Boolean)
    const records = active.filter(row => {
      if (view === 'trash') { if (!row.isSoftDeleted) return false } else if (row.isSoftDeleted) return false
      if (view === 'archived') { if (!row.isArchived) return false } else if (view !== 'trash' && row.isArchived) return false
      if (view === 'due' && (row.reviewState === 'mastered' || row.nextReviewAt && Date.parse(row.nextReviewAt) > now)) return false
      if (view === 'mastered' && row.reviewState !== 'mastered') return false
      if (subjectID && row.subjectID !== subjectID) return false
      if (nodeID && row.nodeID !== nodeID && !row.nodeID.startsWith(`${nodeID}/`)) return false
      return terms.every(term => `${row.stem}\n${row.studentWork}\n${row.referenceAnswer}\n${row.notes}\n${row.cause}\n${row.tags.join(' ')}`.toLocaleLowerCase().includes(term))
    }).map(row => ({ ...row, imageCount: this.listImages(row.id).length, value: evaluate(row) }))
    records.sort((a, b) => order === 'updated' ? b.updatedAt.localeCompare(a.updatedAt) : b.value.overallScore - a.value.overallScore || b.updatedAt.localeCompare(a.updatedAt))
    return { records, stats, taxonomy, path: this.path }
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
        const stored = this.db.prepare('SELECT * FROM question_images WHERE id=? AND question_id=?').get(String(image.id), record.id)
        if (!stored) throw new Error('图片不属于当前题目')
        size += stored.data.length; return { stored }
      }
      const normalized = normalizeImage(image); size += normalized.size; return { normalized }
    })
    if (size > IMAGE_TOTAL_BYTES) throw new Error('每道题的图片总计不能超过 20 MB')
    if (!record.stem.trim() && !images.length) throw new Error('请填写题干或添加题目图片')
    this.db.prepare('INSERT INTO questions VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, fingerprint=excluded.fingerprint')
      .run(record.id, JSON.stringify(record), fingerprint(record.stem))
    const keep = new Set(prepared.filter(image => image.stored).map(image => image.stored.id))
    for (const old of this.listImages(record.id)) if (!keep.has(old.id)) this.db.prepare('DELETE FROM question_images WHERE id=?').run(old.id)
    const insert = this.db.prepare('INSERT OR IGNORE INTO question_images VALUES(?,?,?,?,?,?,?,?)')
    for (const { normalized: image } of prepared) if (image) insert.run(randomUUID(), record.id, image.name, image.mimeType, image.width, image.height, image.sha256, image.bytes)
    return this.read(record.id)
  }
  action(id, action) {
    return this.transaction(() => {
      const record = this.require(id)
      if (action === 'purge') {
        if (!record.isSoftDeleted) throw new Error('只有回收站中的题目可永久删除')
        this.db.prepare('DELETE FROM questions WHERE id=?').run(id); return { removed: true }
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
  import(input) {
    const rows = Array.isArray(input) ? input : Array.isArray(input?.records) ? input.records : input?.records && typeof input.records === 'object' ? Object.values(input.records) : null
    if (!rows || rows.length > 3000) throw new Error('请选择错题本 JSON；一次最多 3000 道题')
    return this.transaction(() => {
      const known = new Set(this.records().filter(record => record.stem.trim()).map(record => fingerprint(record.stem)))
      let created = 0, skipped = 0, unmapped = 0, missingImages = 0
      for (const row of rows) {
        if (!row || typeof row !== 'object') throw new Error('导入包含无效题目，尚未保存')
        const stem = bounded(row.stem), hash = fingerprint(stem)
        if (stem.trim() && known.has(hash)) { skipped++; continue }
        const images = (row.images ?? []).map(image => ({ name: image.name, mimeType: image.mimeType, data: image.data }))
        const candidate = { ...row, id: undefined, revision: undefined, images }
        const legacyNodeID = String(row.nodeID ?? row.classification?.primaryNodeID ?? '')
        const legacySubjectID = String(row.subjectID ?? row.classification?.subjectID ?? '')
        if (legacyNodeID && !nodes.has(legacyNodeID)) { candidate.nodeID = ''; candidate.legacyNodeID = legacyNodeID; unmapped++ }
        if (legacySubjectID && !nodes.has(legacySubjectID)) { candidate.subjectID = ''; candidate.legacySubjectID = legacySubjectID }
        if (row.imageAssetID || row.sourceRegions?.length) { candidate.notes = `${text(row.notes)}\n旧版图片为外部资源引用，请从原项目补充原图。`.trim(); missingImages++ }
        this.saveInside(candidate)
        if (stem.trim()) known.add(hash); created++
      }
      return { created, skipped, unmapped, missingImages }
    })
  }
  export() { return { format: 'memory-vault-mistakebook', schemaVersion: 1, exportedAt: new Date().toISOString(), records: this.records().map(row => ({ ...row, images: this.listImages(row.id, true) })) } }
  backupTo(path) { this.db.prepare('VACUUM INTO ?').run(path) }
}
