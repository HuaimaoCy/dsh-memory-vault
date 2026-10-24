/**
 * 自由画布的单元与存储测试（不需要 Electron）。
 *
 * 覆盖三件事：
 *  1. 模型数学：指针中心缩放不漂移、屏幕/世界坐标互逆、回到内容、落点避让。
 *  2. 笔记本数据域：画布文档写进 notebook 元信息、随导出与备份走、导入可恢复，
 *     并且绝不落进数据库（记忆）域的 meta 表。
 *  3. 坏数据：越界与结构错误的输入被拒绝，已损坏的旧数据不会让阅读失败。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { MistakebookStore } from '../addons/mistakebook/store.mjs'
import { NOTEBOOK_LAYOUT_DEFAULTS, normalizeLayout } from '../desktop/renderer/workspace-layout.js'
import {
  CANVAS_LIMITS, activeCanvas, addCard, contentBounds, contentFits, createCanvas, defaultView, deleteCanvas,
  documentSize, edgeGeometry, emptyDocument, fitView, linkCards, mergeDocument, normalizeDocument,
  panBy, placement, removeCards, removeEdge, renameCanvas, screenToWorld, updateCard,
  worldToScreen, zoomAt,
} from '../addons/mistakebook/canvas.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const parent = join(root, 'test-tmp', 'work')
mkdirSync(parent, { recursive: true })
const folder = mkdtempSync(join(parent, 'canvas-'))
const close = value => Math.abs(value) < 1e-9
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message}：${actual} ≠ ${expected}`)

const fixture = () => ({
  version: 1,
  activeId: 'canvas-a',
  canvases: [{
    id: 'canvas-a', title: '受力分析', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
    view: { x: -40, y: 24, scale: 1.25 },
    cards: [
      { id: 'card-1', kind: 'text', x: 0, y: 0, w: 320, h: 200, text: '第一张卡片', z: 1 },
      { id: 'card-2', kind: 'sticky', x: 400, y: 120, w: 240, h: 200, text: '便签内容', tone: 'mint', z: 2 },
      { id: 'card-3', kind: 'reference', x: 120, y: 320, w: 280, h: 170, noteId: 'note-1', noteType: 'note', noteTitle: '受力模型笔记', text: '摘要', z: 3 },
    ],
    edges: [{ id: 'edge-1', from: 'card-1', to: 'card-2' }],
  }],
})

try {
  // —— 1. 模型 ——
  assert.deepEqual(emptyDocument(), { version: 1, activeId: null, canvases: [] })
  assert.equal(activeCanvas(emptyDocument()), null)

  const doc = normalizeDocument(fixture())
  assert.deepEqual(normalizeDocument(doc), doc, '归一化必须幂等')

  // 指针中心缩放：屏幕上这个点下面的世界坐标不能漂移。
  const view = { x: 37, y: -12, scale: 0.8 }
  const pointer = { x: 412, y: 296 }
  const anchored = screenToWorld(view, pointer)
  const zoomed = zoomAt(view, pointer, 2.1)
  near(screenToWorld(zoomed, pointer).x, anchored.x, '缩放后指针处的世界 x 保持不动')
  near(screenToWorld(zoomed, pointer).y, anchored.y, '缩放后指针处的世界 y 保持不动')
  near(zoomed.scale, 2.1, '缩放比例按请求生效')
  assert.equal(zoomAt(view, pointer, 99).scale, CANVAS_LIMITS.maxScale, '缩放上限收敛')
  assert.equal(zoomAt(view, pointer, 0.001).scale, CANVAS_LIMITS.minScale, '缩放下限收敛')
  const roundTrip = screenToWorld(view, worldToScreen(view, { x: -132.5, y: 88.25 }))
  assert.ok(close(roundTrip.x + 132.5) && close(roundTrip.y - 88.25), '屏幕/世界坐标互逆')

  // 平移：只挪视口，不改缩放。
  const panned = panBy(view, 25, -30)
  assert.deepEqual(panned, { x: 62, y: -42, scale: 0.8 })

  // 回到内容：所有卡片都落在视野里，单张卡片最多放大到 1:1。
  const cards = doc.canvases[0].cards
  const bounds = contentBounds(cards, 0)
  assert.deepEqual(bounds, { x: 0, y: 0, w: 640, h: 490 }, '内容包围盒取卡片的世界矩形')
  const fitted = fitView(bounds, { w: 600, h: 420 })
  assert.ok(fitted.scale > CANVAS_LIMITS.minScale && fitted.scale <= 1)
  for (const card of cards) {
    for (const corner of [{ x: card.x, y: card.y }, { x: card.x + card.w, y: card.y + card.h }]) {
      const point = worldToScreen(fitted, corner)
      assert.ok(point.x >= -0.5 && point.x <= 600.5 && point.y >= -0.5 && point.y <= 420.5, `卡片 ${card.id} 应落在视口内：${JSON.stringify(point)}`)
    }
  }
  assert.deepEqual(fitView(null, { w: 600, h: 420 }), defaultView(), '没有内容时回到默认视口')
  assert.equal(fitView(bounds, { w: 4000, h: 3000 }).scale, 1, '单张卡片不放大超过 100%')
  // 「回到内容」是否真的装下了：普通内容为真；超大内容被最小缩放卡住时必须为假，
  // 渲染层据此不再谎称「全部卡片都在视野里」。
  assert.equal(contentFits(cards, fitted, { w: 600, h: 420 }), true, '普通内容 fit 后全部卡片可见')
  const hugeBounds = { x: 0, y: 0, w: 1000000, h: 1000000 }
  const hugeFit = fitView(hugeBounds, { w: 600, h: 420 })
  assert.equal(hugeFit.scale, CANVAS_LIMITS.minScale, '超大内容被最小缩放卡住')
  assert.equal(contentFits([{ x: 0, y: 0, w: 1000000, h: 1000000 }], hugeFit, { w: 600, h: 420 }), false, '缩到最小仍装不全：contentFits 必须为假')
  assert.equal(contentFits([], defaultView(), { w: 600, h: 420 }), true, '没有卡片时视为已装下')

  // 布局宽度：null / '' 不能被 Number() 当成 0 而收敛成最窄。
  const widthInput = normalizeLayout({ sideW: null, detailW: '' }, NOTEBOOK_LAYOUT_DEFAULTS)
  assert.equal(widthInput.sideW, NOTEBOOK_LAYOUT_DEFAULTS.sideW, 'null 宽度回退默认值而不是最窄')
  assert.equal(widthInput.detailW, NOTEBOOK_LAYOUT_DEFAULTS.detailW, '空字符串宽度回退默认值而不是最窄')
  assert.equal(normalizeLayout({ sideW: 'wide' }, NOTEBOOK_LAYOUT_DEFAULTS).sideW, NOTEBOOK_LAYOUT_DEFAULTS.sideW, '非数字仍回退默认值')

  // 落点避让：新卡片不和已有卡片叠在一起。
  const spot = placement([{ x: 0, y: 0, w: 300, h: 200 }], { w: 200, h: 150 }, { x: 150, y: 100 })
  const overlap = spot.x < 300 + 16 && spot.x + 200 + 16 > 0 && spot.y < 200 + 16 && spot.y + 150 + 16 > 0
  assert.ok(!overlap, `新卡片应避开已有卡片：${JSON.stringify(spot)}`)

  // 卡片操作：新增、改尺寸、删卡片连带剪线、连线去重与几何。
  let canvas = createCanvas(emptyDocument(), '空画布').canvas
  assert.equal(canvas.cards.length, 0)
  canvas = addCard(canvas, { kind: 'text', x: 10, y: 10, w: 320, h: 200, text: '一' })
  canvas = addCard(canvas, { kind: 'sticky', x: 400, y: 10, w: 240, h: 200, text: '二' })
  assert.deepEqual(canvas.cards.map(card => card.z), [1, 2], '新卡片总在最上层')
  canvas = updateCard(canvas, canvas.cards[0].id, { w: 5000, h: 10 })
  assert.equal(canvas.cards[0].w, CANVAS_LIMITS.maxSize, '尺寸上限收敛')
  assert.equal(canvas.cards[0].h, CANVAS_LIMITS.minSize, '尺寸下限收敛')
  const [first, second] = canvas.cards
  canvas = linkCards(canvas, first.id, second.id)
  assert.throws(() => linkCards(canvas, first.id, second.id), /已经连在一起/, '同一对卡片只连一次')
  const geometry = edgeGeometry(canvas, canvas.edges[0])
  assert.ok(geometry.length > 0 && Number.isFinite(geometry.angle), '连线几何可画')
  const pruned = removeCards(canvas, [second.id])
  assert.equal(pruned.cards.length, 1)
  assert.equal(pruned.edges.length, 0, '删卡片要剪掉连线')
  assert.equal(removeEdge(canvas, canvas.edges[0].id).edges.length, 0)

  // 画布管理：改名、删除后自动切到相邻画布。
  let document = normalizeDocument({ ...fixture(), canvases: [...fixture().canvases, { id: 'canvas-b', title: 'B', cards: [], edges: [] }] })
  assert.equal(renameCanvas(document, 'canvas-a', '  ').canvases.find(row => row.id === 'canvas-a').title, '未命名画布')
  const removed = deleteCanvas(document, 'canvas-b')
  assert.equal(removed.removed, true)
  assert.equal(removed.document.canvases.length, 1)
  assert.equal(removed.document.activeId, 'canvas-a')
  assert.throws(() => createCanvas({ ...document, canvases: Array.from({ length: CANVAS_LIMITS.canvases }, (_, index) => ({ id: `canvas-${index}`, title: 'x', cards: [], edges: [] })) }, '溢出'), /最多 40 个画布/)
  const fullCanvas = { id: 'full', title: '满', cards: Array.from({ length: CANVAS_LIMITS.cards }, (_, index) => ({ id: `full-${index}`, kind: 'text', x: 0, y: 0, w: 320, h: 200, text: '' })), edges: [] }
  assert.throws(() => addCard(fullCanvas, { kind: 'text', x: 0, y: 0 }), /最多 300 张卡片/, '卡片达到上限时 addCard 必须抛错（渲染层负责转成提示）')

  // 导入合并：按 id 覆盖、其余保留、activeId 不丢。
  const merged = mergeDocument(document, { canvases: [{ ...fixture().canvases[0], title: '改名后' }, { id: 'canvas-c', title: 'C', cards: [], edges: [] }] })
  assert.equal(merged.canvases.length, 3)
  assert.equal(merged.canvases.find(row => row.id === 'canvas-a').title, '改名后')
  assert.equal(merged.activeId, document.activeId)
  assert.equal(mergeDocument(document, null).canvases.length, document.canvases.length, '没有画布段时保持本机画布')

  // —— 2. 坏数据 ——
  assert.throws(() => normalizeDocument({ canvases: 42 }), /画布数据无效/)
  assert.throws(() => normalizeDocument({ canvases: [{ id: 'c', cards: 'nope' }] }), /画布卡片数据无效/)
  assert.throws(() => normalizeDocument({ canvases: Array.from({ length: CANVAS_LIMITS.canvases + 1 }, (_, index) => ({ id: `c-${index}` })) }), /最多 40 个画布/)
  assert.throws(() => normalizeDocument({ canvases: [{ id: 'c', cards: Array.from({ length: CANVAS_LIMITS.cards + 1 }, (_, index) => ({ id: `k-${index}` })) }] }), /最多 300 张卡片/)
  assert.throws(() => normalizeDocument({ canvases: [{ id: 'c', cards: [{ id: 'k', text: 'x'.repeat(CANVAS_LIMITS.text + 1) }] }] }), /不能超过 4000 字/)
  // 数值越界只收敛，不抛错：缩放滑块与拖动都不该因为取整失败而存不进去。
  const sloppy = normalizeDocument({ canvases: [{ id: 'c', view: { scale: 40 }, cards: [{ id: 'k', x: 'oops', w: 'wide' }] }] })
  assert.equal(sloppy.canvases[0].cards[0].x, 0, '坏数字回落为 0')
  assert.equal(sloppy.canvases[0].cards[0].w, 320, '坏尺寸回落为该类型的默认宽度')
  assert.equal(sloppy.canvases[0].view.scale, CANVAS_LIMITS.maxScale)

  // —— 3. 存储：文件模式 ——
  const filePath = join(folder, 'notebook.sqlite')
  const store = new MistakebookStore(filePath)
  assert.deepEqual(store.canvasDocs(), emptyDocument(), '新库没有画布')
  assert.deepEqual(store.canvasState(), { docs: emptyDocument(), corrupted: false }, '没有记录 ≠ 数据损坏')
  store.setCanvasDocs(doc)
  assert.deepEqual(store.canvasDocs(), normalizeDocument(doc), '画布整份往返一致')
  assert.deepEqual(store.list().prefs, {}, '画布不进界面偏好')

  const exported = store.export()
  assert.equal(exported.schemaVersion, 3)
  assert.deepEqual(exported.canvas, normalizeDocument(doc), '导出带画布')
  const restored = new MistakebookStore(join(folder, 'restored.sqlite'))
  assert.equal(restored.import({ records: [], canvas: exported.canvas }).canvases, 1, '导入画布数量')
  assert.deepEqual(restored.canvasDocs(), normalizeDocument(doc), '导出 → 导入可原样恢复画布')
  assert.equal(restored.import({ records: [] }).canvases, 0, '旧版导出没有画布段时不改动本机画布')
  assert.deepEqual(restored.canvasDocs(), normalizeDocument(doc))
  restored.close()

  const backupPath = join(folder, 'backup.sqlite')
  store.backupTo(backupPath)
  const backup = new DatabaseSync(backupPath, { readOnly: true })
  const backupCanvas = backup.prepare("SELECT value FROM addon_meta WHERE key='canvas'").get()
  backup.close()
  assert.ok(backupCanvas, '笔记本备份里必须有画布')
  assert.deepEqual(JSON.parse(backupCanvas.value), normalizeDocument(doc), '备份里的画布内容完好')

  const huge = { canvases: [{ id: 'huge', title: '大', cards: Array.from({ length: 240 }, (_, index) => ({ id: `big-${index}`, x: index * 10, y: 0, text: 'x'.repeat(CANVAS_LIMITS.text) })) }] }
  assert.ok(documentSize(normalizeDocument(huge)) > CANVAS_LIMITS.bytes, '构造的文档确实超限')
  assert.throws(() => store.setCanvasDocs(huge), /画布数据过大/)
  assert.deepEqual(store.canvasDocs(), normalizeDocument(doc), '被拒绝的保存不会破坏已存画布')
  store.close()

  // —— 4. 存储：与数据库同库（注入模式）—— 画布不越域
  const vaultPath = join(folder, 'vault.sqlite')
  const shared = new DatabaseSync(vaultPath)
  shared.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES('schema','1');")
  const injected = new MistakebookStore({ database: shared, path: vaultPath })
  injected.setCanvasDocs(doc)
  assert.equal(shared.prepare("SELECT count(*) AS n FROM notebook_meta WHERE key='canvas'").get().n, 1, '画布存在笔记本域的 notebook_meta')
  assert.equal(shared.prepare("SELECT count(*) AS n FROM meta WHERE key='canvas'").get().n, 0, '画布绝不写进记忆域的 meta 表')
  const injectedBackup = join(folder, 'injected-backup.sqlite')
  injected.backupTo(injectedBackup)
  const projected = new DatabaseSync(injectedBackup, { readOnly: true })
  const projectedCanvas = projected.prepare("SELECT value FROM addon_meta WHERE key='canvas'").get()
  const carriesVaultTables = projected.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='meta'").get().n
  projected.close()
  assert.deepEqual(JSON.parse(projectedCanvas.value), normalizeDocument(doc), '同库模式的笔记本备份只投影笔记本域，且带画布')
  assert.equal(carriesVaultTables, 0, '笔记本备份不携带记忆域的表')
  // 损坏的旧数据：读取退回空文档，绝不因为一份坏画布打不开笔记本。
  // 但必须能区分「没有记录」与「读取失败」：canvasState() 标记 corrupted，
  // 渲染层才不会把坏数据当成空画布自动建一张、覆盖用户原画布。
  shared.prepare("UPDATE notebook_meta SET value='{ not json' WHERE key='canvas'").run()
  const brokenJson = injected.canvasState()
  assert.equal(brokenJson.corrupted, true, '坏 JSON 必须标记 corrupted')
  assert.deepEqual(brokenJson.docs, emptyDocument(), '坏数据仍保留 canvasDocs 的空文档语义')
  assert.deepEqual(injected.canvasDocs(), emptyDocument(), '损坏数据退回空文档（旧入口语义不变）')
  shared.prepare(`UPDATE notebook_meta SET value='{"canvases":42}' WHERE key='canvas'`).run()
  assert.equal(injected.canvasState().corrupted, true, '结构不合法的画布也标记 corrupted')
  // 正常文档仍然 corrupted=false，且 docs 与 canvasDocs 一致。
  shared.prepare("UPDATE notebook_meta SET value=? WHERE key='canvas'").run(JSON.stringify(doc))
  const healthy = injected.canvasState()
  assert.equal(healthy.corrupted, false, '合法数据不标记 corrupted')
  assert.deepEqual(healthy.docs, normalizeDocument(doc))
  assert.deepEqual(injected.canvasDocs(), healthy.docs)
  injected.close()
  shared.close()

  console.log('canvas smoke: ok')
} finally {
  if (dirname(folder) !== parent) throw new Error('测试清理路径异常')
  rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
