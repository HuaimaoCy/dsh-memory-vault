import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID, createHash, randomInt } from 'node:crypto'
import { NOTE_TYPES, normalizeFields, contentOf } from './fields.mjs'
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
function normalize(raw, previous = {}) {
  const merged = { ...previous, ...raw }
  const type = merged.type ?? 'mistake'
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
    reviewState, repeatCount, reciteCount, mastery, nextReviewAt: merged.nextReviewAt ?? null, reviewHistory: Array.isArray(merged.reviewHistory) ? merged.reviewHistory.slice(-200).map(item => ({ at: String(item.at), result: item.result === 'pass' ? 'pass' : 'fail' })) : [],
    isArchived: Boolean(merged.isArchived), isSoftDeleted: Boolean(merged.isSoftDeleted), createdAt: previous.createdAt ?? merged.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(), revision: (previous.revision ?? 0) + 1 }
}
function fieldsForAI(type, fields = {}) { return ['physics','method','vocabulary'].includes(type) ? { [type]: normalizeFields(type, fields[type]) } : {} }

export class MistakebookStore {
  constructor(path) {
    this.path = path
    this.quizzes = new Map()
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
    const hasMeta = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='addon_meta'").get()
    const version = hasMeta ? this.db.prepare("SELECT value FROM addon_meta WHERE key='schema'").get()?.value : null
    if (version && !['1','2'].includes(version)) { this.db.close(); throw new Error('笔记本数据库版本较新，请使用对应版本') }
    if (version === '1') {
      this.migrationBackup = `${path}.v1-${Date.now()}-${randomUUID()}.bak`
      this.db.prepare('VACUUM INTO ?').run(this.migrationBackup)
    }
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS addon_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS questions(id TEXT PRIMARY KEY, payload TEXT NOT NULL, fingerprint TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS questions_fingerprint ON questions(fingerprint);
      CREATE TABLE IF NOT EXISTS question_images(id TEXT PRIMARY KEY, question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
        name TEXT NOT NULL, mime_type TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, sha256 TEXT NOT NULL, data BLOB NOT NULL, UNIQUE(question_id,sha256));`)
    try { this.transaction(() => {
      if (version === '1') for (const previous of this.records()) {
        const converted = { ...normalize(previous, previous), updatedAt: previous.updatedAt, revision: previous.revision, classificationSuggested: previous.classificationSuggested }
        this.db.prepare('UPDATE questions SET payload=?, fingerprint=? WHERE id=?').run(JSON.stringify(converted), dedupKey(converted), previous.id)
      }
      this.db.prepare("INSERT INTO addon_meta VALUES('schema','2') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run()
    }) } catch (error) { this.db.close(); throw error }
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
      id: image.id, name: image.name, mimeType: image.mime_type, width: image.width, height: image.height, size: image.data.length, sha256: image.sha256,
      ...(includeData ? { data: Buffer.from(image.data).toString('base64') } : {}),
    }))
  }
  read(id) { const record = this.require(id), images = this.listImages(id, true), hash = contentHash({ ...record, images }); return { ...record, images, value: evaluate(record), contentHash: hash, aiStale: Boolean(record.aiResult && record.aiResult.inputHash !== hash) } }
  records() { return this.db.prepare('SELECT payload FROM questions').all().map(row => JSON.parse(row.payload)) }
  list({ view = 'all', type = '', subjectID = '', nodeID = '', query = '', order = 'priority' } = {}) {
    const active = this.records(), now = Date.now()
    const stats = { all: 0, due: 0, mastered: 0, archived: 0, trash: 0, subjects: {}, types: {} }
    for (const row of active) {
      if (row.isSoftDeleted) { stats.trash++; continue }
      if (row.isArchived) { stats.archived++; continue }
      stats.all++; stats.types[row.type] = (stats.types[row.type] ?? 0) + 1; stats.subjects[row.subjectID] = (stats.subjects[row.subjectID] ?? 0) + 1
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
      return terms.every(term => `${JSON.stringify(contentOf(row))}\n${row.tags.join(' ')}`.toLocaleLowerCase().includes(term))
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
    if (record.type === 'vocabulary' && !record.vocabulary.word.trim()) throw new Error('请填写英语单词或短语')
    if (!record.stem.trim() && !images.length && !(record.type === 'vocabulary' ? record.vocabulary.word.trim() : record.type !== 'mistake' && (record.title.trim() || Object.values(record[record.type] ?? {}).some(value => value.trim())))) throw new Error('请填写题干、笔记内容或添加图片')
    this.db.prepare('INSERT INTO questions VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, fingerprint=excluded.fingerprint')
      .run(record.id, JSON.stringify(record), dedupKey(record))
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
      if (!this.db.prepare('SELECT 1 FROM questions WHERE id=?').get(item.id)) return {id:item.id,answer,expected:item.word,correct,recorded:false}
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
  export() { return { format: 'memory-vault-notebook', schemaVersion: 2, exportedAt: new Date().toISOString(), records: this.records().map(row => ({ ...row, images: this.listImages(row.id, true) })) } }
  backupTo(path) { this.db.prepare('VACUUM INTO ?').run(path) }
}
