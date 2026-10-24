/**
 * Pure-logic tests for the quick capture module.
 *
 * These run in plain Node (`node --no-warnings tests/capture-smoke.mjs`): the
 * module's DOM half is never touched, so the target normalisation, the storage
 * key contract, tag/rules normalisation and the two payload builders are
 * exercised exactly as the Electron panel will use them.
 */
import assert from 'node:assert/strict'
import {
  CAPTURE_MODES,
  CAPTURE_STORAGE_KEY,
  DEFAULT_CAPTURE_TAGS,
  NOTEBOOK_TARGETS,
  buildMemoryEntryPayload,
  buildNotebookPayload,
  captureProblem,
  derivedTitle,
  loadCapturePrefs,
  normalizeCapturePrefs,
  normalizeCaptureTargets,
  normalizeTags,
  saveCapturePrefs,
} from '../desktop/renderer/quick-capture.js'
import { NOTE_TYPES as NOTEBOOK_NOTE_TYPES } from '../addons/mistakebook/fields.mjs'

let checks = 0
const ok = (name, fn) => {
  try {
    fn()
    checks += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    console.error(`  ✗ ${name}`)
    throw error
  }
}

const NOTE_TYPES = {
  mistake: { label: '错题', caption: '保留作答，定位错因' },
  physics: { label: '物理模型' },
  method: { label: '解题方法' },
  vocabulary: { label: '英语词汇' },
  note: { label: '笔记' },
}
const GROUPS = [
  { id: 'g-knowledge', name: '灵感', path: ['知识库'], scope: 'knowledge' },
  { id: 'g-conversation', name: '待确认', path: ['对话记忆'], scope: 'conversation' },
  { id: 'g-root', name: '收件箱', path: [], scope: 'knowledge' },
]

const fakeStorage = () => {
  const map = new Map()
  return {
    map,
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
  }
}

console.log('capture-smoke: persistence key')
ok('storage key is exactly alaya.db.capture', () => {
  assert.equal(CAPTURE_STORAGE_KEY, 'alaya.db.capture')
})
ok('default inbox tag and the three modes are exported as declared', () => {
  assert.deepEqual(DEFAULT_CAPTURE_TAGS, ['收件箱'])
  assert.deepEqual(CAPTURE_MODES, ['knowledge', 'conversation', 'notebook'])
})

console.log('capture-smoke: normalizeCaptureTargets')
ok('real memory groups keep their order, label and scope', () => {
  const targets = normalizeCaptureTargets({ groups: GROUPS, noteTypes: NOTE_TYPES })
  assert.deepEqual(targets.slice(0, 3), [
    { id: 'g-knowledge', label: '知识库 / 灵感', kind: 'memory', scope: 'knowledge' },
    { id: 'g-conversation', label: '对话记忆 / 待确认', kind: 'memory', scope: 'conversation' },
    { id: 'g-root', label: '收件箱', kind: 'memory', scope: 'knowledge' },
  ])
  assert.deepEqual(targets.slice(3), [
    { id: 'note', label: '笔记', kind: 'notebook' },
    { id: 'mistake', label: '错题', kind: 'notebook' },
    { id: 'physics', label: '物理模型', kind: 'notebook' },
    { id: 'method', label: '解题方法', kind: 'notebook' },
    { id: 'vocabulary', label: '英语词汇', kind: 'notebook' },
  ])
})
ok('missing scope defaults to knowledge; unknown scope is not trusted', () => {
  const targets = normalizeCaptureTargets({ groups: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B', scope: 'everything' }] })
  assert.deepEqual(targets.map(item => item.scope), ['knowledge', 'knowledge'])
})
ok('a nameless group still renders a usable label', () => {
  const [child] = normalizeCaptureTargets({ groups: [{ id: 'x', path: ['根'] }] })
  assert.equal(child.label, '根')
  const [bare] = normalizeCaptureTargets({ groups: [{ id: 'y' }] })
  assert.equal(bare.label, '未命名分组')
})
ok('noteTypes accepts an array of strings', () => {
  assert.deepEqual(normalizeCaptureTargets({ noteTypes: ['note', 'fact'] }).map(item => [item.id, item.label]), [
    ['note', 'note'], ['fact', 'fact'],
  ])
})
ok('noteTypes accepts id/type/value records and labels them', () => {
  const targets = normalizeCaptureTargets({ noteTypes: [{ id: 'note', label: '笔记' }, { type: 'task', name: '任务' }, { value: 'fact' }] })
  assert.deepEqual(targets, [
    { id: 'note', label: '笔记', kind: 'notebook' },
    { id: 'task', label: '任务', kind: 'notebook' },
    { id: 'fact', label: 'fact', kind: 'notebook' },
  ])
})
ok('duplicate ids are dropped (memory and notebook separately)', () => {
  const targets = normalizeCaptureTargets({
    groups: [{ id: 'same', name: '组一' }, { id: 'same', name: '组二' }],
    noteTypes: { note: { label: '笔记' } },
  })
  assert.deepEqual(targets.map(item => `${item.kind}:${item.id}`), ['memory:same', 'notebook:note'])
})
ok('broken input never throws and yields no targets', () => {
  assert.deepEqual(normalizeCaptureTargets(), [])
  assert.deepEqual(normalizeCaptureTargets(null), [])
  assert.deepEqual(normalizeCaptureTargets('nonsense'), [])
  assert.deepEqual(normalizeCaptureTargets({ groups: [null, {}, { id: '' }, 42, { id: 'ok', name: '可用' }] }).map(item => item.id), ['ok'])
  assert.deepEqual(normalizeCaptureTargets({ noteTypes: {} }), [])
  assert.deepEqual(normalizeCaptureTargets({ noteTypes: 'nope' }), [])
})

console.log('capture-smoke: normalizeTags')
ok('string input splits on half/full-width commas and newlines, trims, dedupes', () => {
  assert.deepEqual(normalizeTags('收件箱, 想法，想法\n\n思路 ,'), ['收件箱', '想法', '思路'])
})
ok('array input drops empties and duplicates and keeps order', () => {
  assert.deepEqual(normalizeTags([' 收件箱 ', '', '  ', '收件箱', '想法']), ['收件箱', '想法'])
})
ok('empty input yields an empty list', () => {
  assert.deepEqual(normalizeTags(''), [])
  assert.deepEqual(normalizeTags([]), [])
  assert.deepEqual(normalizeTags(null), [])
  assert.deepEqual(normalizeTags(undefined), [])
})
ok('tags are capped at 32 entries', () => {
  const many = Array.from({ length: 40 }, (_, index) => `标签${index}`)
  assert.equal(normalizeTags(many).length, 32)
})

console.log('capture-smoke: captureProblem (empty body and bad targets)')
const baseTargets = normalizeCaptureTargets({ groups: GROUPS, noteTypes: NOTE_TYPES })
ok('empty or whitespace-only content is refused before any IPC', () => {
  assert.equal(captureProblem({ content: '', mode: 'knowledge', targets: baseTargets, groupId: 'g-root' }), '请先输入内容再保存')
  assert.equal(captureProblem({ content: '  \n\t ', mode: 'knowledge', targets: baseTargets, groupId: 'g-root' }), '请先输入内容再保存')
  assert.equal(captureProblem({}), '请先输入内容再保存')
})
ok('a knowledge capture without a selected group is refused', () => {
  assert.equal(captureProblem({ content: '内容', mode: 'knowledge', targets: baseTargets, groupId: '' }), '请选择要写入的记忆组')
  assert.equal(captureProblem({ content: '内容', mode: 'knowledge', targets: baseTargets, groupId: 'g-conversation' }), '请选择要写入的记忆组')
})
ok('an empty domain explains itself instead of crashing', () => {
  assert.equal(
    captureProblem({ content: '内容', mode: 'knowledge', targets: [], groupId: 'x' }),
    '知识库还没有记忆组，请先在「数据库」里新建一个组',
  )
  assert.equal(
    captureProblem({ content: '内容', mode: 'conversation', targets: [], groupId: 'x' }),
    '对话记忆还没有记忆组，请先在「数据库」里新建一个组',
  )
  assert.equal(
    captureProblem({ content: '内容', mode: 'notebook', targets: [], noteType: 'note' }),
    '笔记本还没有可用的笔记类型',
  )
})
ok('notebook capture requires a real note type', () => {
  assert.equal(captureProblem({ content: '内容', mode: 'notebook', targets: baseTargets, noteType: '' }), '请选择要写入的笔记类型')
  assert.equal(captureProblem({ content: '内容', mode: 'notebook', targets: baseTargets, noteType: 'nope' }), '请选择要写入的笔记类型')
  assert.equal(captureProblem({ content: '内容', mode: 'notebook', targets: baseTargets, noteType: 'note' }), null)
})
ok('valid input passes the same rule the panel runs', () => {
  assert.equal(captureProblem({ content: '一条想法', mode: 'knowledge', targets: baseTargets, groupId: 'g-root' }), null)
  assert.equal(captureProblem({ content: '一段对话结论', mode: 'conversation', targets: baseTargets, groupId: 'g-conversation' }), null)
})

console.log('capture-smoke: preference persistence')
ok('the panel preference round-trips through storage', () => {
  const storage = fakeStorage()
  saveCapturePrefs({ mode: 'conversation', groupIds: { knowledge: 'g-k', conversation: 'g-c' }, noteType: 'note', tagsText: '收件箱, 灵感' }, storage)
  const raw = JSON.parse(storage.map.get(CAPTURE_STORAGE_KEY))
  assert.deepEqual(raw, {
    mode: 'conversation',
    groupIds: { knowledge: 'g-k', conversation: 'g-c' },
    noteType: 'note',
    tagsText: '收件箱, 灵感',
  })
  assert.deepEqual(loadCapturePrefs(storage), raw)
})
ok('only the UI preference key is written', () => {
  const storage = fakeStorage()
  saveCapturePrefs({ mode: 'notebook' }, storage)
  assert.deepEqual([...storage.map.keys()], [CAPTURE_STORAGE_KEY])
})
ok('a corrupt or hostile stored value falls back to defaults', () => {
  const corrupt = fakeStorage()
  corrupt.map.set(CAPTURE_STORAGE_KEY, '{not json')
  assert.deepEqual(loadCapturePrefs(corrupt), normalizeCapturePrefs(null))
  const weird = fakeStorage()
  weird.map.set(CAPTURE_STORAGE_KEY, JSON.stringify({ mode: 'delete', groupIds: 'x', noteType: 42, tagsText: null }))
  assert.deepEqual(loadCapturePrefs(weird), { mode: 'knowledge', groupIds: { knowledge: '', conversation: '' }, noteType: '', tagsText: '收件箱' })
  assert.deepEqual(normalizeCapturePrefs('nonsense'), normalizeCapturePrefs(null))
})
ok('unavailable storage is not an error in either direction', () => {
  assert.deepEqual(loadCapturePrefs(null), normalizeCapturePrefs(null))
  const throwing = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
  assert.deepEqual(loadCapturePrefs(throwing), normalizeCapturePrefs(null))
  assert.doesNotThrow(() => saveCapturePrefs({ mode: 'notebook' }, throwing))
})

console.log('capture-smoke: derivedTitle')
ok('markdown furniture is stripped from the derived heading', () => {
  assert.equal(derivedTitle('# 标题'), '标题')
  assert.equal(derivedTitle('> 引用一句'), '引用一句')
  assert.equal(derivedTitle('- 列表项'), '列表项')
  assert.equal(derivedTitle('1. 编号项'), '编号项')
  assert.equal(derivedTitle('**加粗**开头'), '加粗开头')
})
ok('the heading is the first non-empty line, capped at 120 characters', () => {
  assert.equal(derivedTitle('\n\n  第二行才是标题\n正文'), '第二行才是标题')
  assert.equal(derivedTitle('x'.repeat(300)).length, 120)
  assert.equal(derivedTitle(''), '')
  assert.equal(derivedTitle(null), '')
})

console.log('capture-smoke: memory payload')
ok('entry.write payload matches the vault contract exactly', () => {
  const payload = buildMemoryEntryPayload({ content: '  第一行\n第二行  ', scope: 'knowledge', groupId: 'g-root' })
  assert.deepEqual(payload, {
    title: '第一行',
    content: '第一行\n第二行',
    kind: 'note',
    tags: ['收件箱'],
    scope: 'knowledge',
    groupId: 'g-root',
    priority: 0,
    base: false,
  })
})
ok('tags default to the inbox, are normalised when edited, and may be cleared', () => {
  assert.deepEqual(buildMemoryEntryPayload({ content: 'x', tags: undefined, groupId: 'g' }).tags, ['收件箱'])
  assert.deepEqual(buildMemoryEntryPayload({ content: 'x', tags: ['收件箱', '', '收件箱', '想法'] , groupId: 'g' }).tags, ['收件箱', '想法'])
  assert.deepEqual(buildMemoryEntryPayload({ content: 'x', tags: '收件箱,想法，想法', groupId: 'g' }).tags, ['收件箱', '想法'])
  assert.deepEqual(buildMemoryEntryPayload({ content: 'x', tags: [], groupId: 'g' }).tags, [])
})
ok('scope is constrained to the two real domains and title can be overridden', () => {
  assert.equal(buildMemoryEntryPayload({ content: 'x', scope: 'conversation', groupId: 'g' }).scope, 'conversation')
  assert.equal(buildMemoryEntryPayload({ content: 'x', scope: 'notebook', groupId: 'g' }).scope, 'knowledge')
  assert.equal(buildMemoryEntryPayload({ content: 'x', title: '  自定义标题  ', groupId: 'g' }).title, '自定义标题')
})

console.log('capture-smoke: notebook payload')
ok('a plain note carries a non-empty stem, which the store requires', () => {
  const payload = buildNotebookPayload({ content: '# 标题\n\n正文', type: 'note' })
  assert.deepEqual(payload, { type: 'note', title: '标题', stem: '# 标题\n\n正文', images: [], tags: [] })
})
ok('a missing type defaults to note; other note types pass through', () => {
  assert.equal(buildNotebookPayload({ content: '一句话' }).type, 'note')
  assert.equal(buildNotebookPayload({ content: '题干', type: 'mistake' }).type, 'mistake')
  assert.equal(buildNotebookPayload({ content: '题干', type: ' physics ' }).type, 'physics')
})
ok('vocabulary splits the first line into the required word field', () => {
  const payload = buildNotebookPayload({ content: 'ephemeral\n短暂的；朝生暮死的', type: 'vocabulary' })
  assert.equal(payload.type, 'vocabulary')
  assert.equal(payload.title, 'ephemeral')
  assert.equal(payload.stem, 'ephemeral\n短暂的；朝生暮死的')
  assert.equal(payload.vocabulary.word, 'ephemeral')
  assert.equal(payload.vocabulary.meaning, '短暂的；朝生暮死的')
  assert.equal(buildNotebookPayload({ content: 'ephemeral', type: 'vocabulary' }).vocabulary.meaning, '')
})
ok('empty content still produces the shape (the rule lives in captureProblem)', () => {
  const payload = buildNotebookPayload({ content: '', type: 'note' })
  assert.equal(payload.stem, '')
  assert.equal(payload.title, '')
  assert.equal(captureProblem({ content: payload.stem, mode: 'notebook', targets: baseTargets, noteType: 'note' }), '请先输入内容再保存')
})

console.log('capture-smoke: notebook targets stay aligned with the notebook module')
ok('NOTEBOOK_TARGETS mirrors the notebook NOTE_TYPES ids and labels', () => {
  // 捕获面板不 import 笔记本模块（数据库界面要能独立启动），所以它的目标表是镜像。
  // 这条守卫让镜像漂移立刻变红：改 fields.mjs 的 NOTE_TYPES 就必须同步这里。
  const byId = rows => [...rows].sort((left, right) => String(left[0]).localeCompare(String(right[0])))
  assert.deepEqual(
    byId(NOTEBOOK_TARGETS.map(target => [target.id, target.label])),
    byId(Object.entries(NOTEBOOK_NOTE_TYPES).map(([id, meta]) => [id, meta.label])),
    '捕获面板的笔记本目标与 addons/mistakebook/fields.mjs 的 NOTE_TYPES 不一致',
  )
})

console.log(`capture-smoke: ${checks} checks passed`)
