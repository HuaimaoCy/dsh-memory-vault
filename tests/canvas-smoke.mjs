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
import { inkBounds, inkIntersects, inkSVGAttributes, stabilizeInkPoint } from '../addons/mistakebook/canvas-ink.mjs'
import { canvasPrintHTML } from '../addons/mistakebook/canvas-print.mjs'
import { boxDelta, boxSelection, moveBoxSelection, offsetBoxSelection } from '../addons/mistakebook/canvas-selection.mjs'
import { shapeParts } from '../addons/mistakebook/canvas-shapes.mjs'
import { NOTEBOOK_LAYOUT_DEFAULTS, normalizeLayout } from '../desktop/renderer/workspace-layout.js'
import {
  A4_IMAGE_SIZE, CANVAS_LIMITS, activeCanvas, activePaperSheet, addCard, addPaperSheet, contentBounds, contentFits,
  createCanvas, defaultView, deleteCanvas, documentSize, edgeGeometry, emptyDocument, fitView,
  mergeDocument, normalizeDocument, normalizePaper, panBy, placement, removeCards, removeEdge, removePaperSheet,
  renameCanvas, screenToWorld, selectPaperSheet, updateCard,
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
  assert.deepEqual(emptyDocument(), { version: 3, activeId: null, canvases: [] })
  assert.equal(activeCanvas(emptyDocument()), null)

  const doc = normalizeDocument(fixture())
  assert.deepEqual(normalizeDocument(doc), doc, '归一化必须幂等')
  assert.deepEqual(doc.canvases[0].ink, [], '旧版白板自动获得空笔迹层')
  const stroke = { id: 'stroke-a', tool: 'pen', color: '#263445', width: 4, points: [[-30, 400, 15], [240, 400, 85]] }
  const strokeBounds = inkBounds(stroke)
  assert.ok(inkIntersects(stroke, strokeBounds, [30, 370], [30, 430], 3), '橡皮快速穿过笔迹时命中')
  assert.ok(!inkIntersects(stroke, strokeBounds, [300, 400], [370, 400], 3), '共线但相隔的笔迹不会被擦除')
  const staircase = { ...stroke, points: [[0, 0, 50], [1, 0, 50], [1, 1, 50], [2, 1, 50], [2, 2, 50], [10, 10, 50]] }
  const smooth = inkSVGAttributes(staircase)
  assert.match(smooth.d, /^M0 0.*Q.*L10 10$/, '平滑触控板的细碎台阶，保留落笔与收笔位置')
  assert.equal(smooth['stroke-width'], 4, '非压感笔迹使用工具设置的粗细')
  assert.equal(smooth['stroke-linecap'], 'round')
  assert.equal(inkSVGAttributes({ ...staircase, points: [[0, 0, 50], [24, 0, 50], [24, 24, 50]] }).d,
    'M0 0L24 0L24 24', '保留明确的直角')
  assert.equal(inkSVGAttributes({ ...staircase, points: [[0, 0, 50]] }).d, 'M0 0l0 0', '点按仍能落墨')
  assert.equal(inkSVGAttributes(stroke).fill, stroke.color, '真实压感仍使用可变宽轮廓')
  const longLine = { ...staircase, points: Array.from({ length: 140 }, (_, index) => [index, Math.sin(index / 3), 50]) }
  const firstPart = inkSVGAttributes(longLine, { variableWidth: false, start: 1, end: 97 }).d
  const lastPart = inkSVGAttributes(longLine, { variableWidth: false, start: 97 }).d
  const startOfLast = lastPart.indexOf('L')
  assert.ok(firstPart.endsWith(lastPart.slice(1, startOfLast)), '实时预览分段首尾相接')
  assert.equal(firstPart + lastPart.slice(startOfLast), inkSVGAttributes(longLine).d, '分段笔迹沿用保存的曲线')
  const longPressure = { ...longLine, points: longLine.points.map(([x, y], index) => [x, y, 20 + index % 60]) }
  const outlineParts = [[0, 96], [96, 140]].map(([start, end]) => inkSVGAttributes(longPressure, { variableWidth: true, start, end }).d)
  assert.equal(outlineParts.join(''), inkSVGAttributes(longPressure).d, '分段笔迹保留压感轮廓')
  const noisy = [[0, 0, 20], [3, 1, 42], [6, -1, 71], [9, 1, 60], [12, 0, 25]]
  const stabilized = noisy.map((point, index) => index > 0 && index < noisy.length - 1
    ? stabilizeInkPoint(noisy[index - 1], point, noisy[index + 1], 1) : point)
  assert.ok(stabilized.slice(1, -1).every(point => Math.abs(point[1]) < 0.6), '削弱触控板连续细小的横向抖动')
  assert.deepEqual(stabilized.map(point => point[2]), noisy.map(point => point[2]), '防抖保留真实压感')
  assert.deepEqual(stabilized[0], noisy[0])
  assert.deepEqual(stabilized.at(-1), noisy.at(-1))
  const zoomedStroke = noisy.map(([x, y, pressure]) => [x / 4, y / 4, pressure])
  const sameJitter = stabilizeInkPoint(zoomedStroke[0], zoomedStroke[1], zoomedStroke[2], 4)
  assert.ok(Math.abs(sameJitter[1] * 4 - stabilized[1][1]) < 0.003, '防抖以屏幕像素为单位，缩放前后效果一致')
  assert.deepEqual(stabilizeInkPoint([0, 0, 50], [8, 0, 50], [8, 8, 50], 1), [8, 0, 50], '保留明显转角')
  const fine = { ...stroke, width: 0.25, points: [[0.123, 0.456, 50], [0.786, 0.823, 50]] }
  assert.deepEqual(normalizeDocument({ canvases: [{ ink: [fine] }] }).canvases[0].ink[0], fine, '细笔和亚像素坐标可保存')
  assert.throws(() => normalizeDocument({ canvases: [{ ink: [{ ...stroke, color: 'url(unsafe)' }] }] }), /笔迹数据无效/)
  doc.canvases[0].ink.push(stroke)
  const square = { id: 'square-a', kind: 'square', color: '#1267ed', width: 4, x1: 80, y1: 80, x2: 30, y2: 60 }
  assert.deepEqual(shapeParts(square), [['rect', { x: 30, y: 30, width: 50, height: 50 }]], '反方向拖动仍生成正方形')
  assert.equal(shapeParts({ ...square, kind: 'arrow' }).length, 2, '箭头包含线段和箭头端点')
  const arrow = { ...square, id: 'arrow-a', kind: 'arrow', width: 2, x1: 0.375, y1: 0, x2: 100.375, y2: 0 }
  const savedArrow = normalizeDocument({ canvases: [{ shapes: [arrow] }] }).canvases[0].shapes[0]
  assert.equal(savedArrow.x1, 0.375, '缩放后绘制的图形保留亚像素坐标')
  const wings = shapeParts(savedArrow)[1][1].points.split(' ').map(pair => Number(pair.split(',')[1]))
  assert.ok(Math.max(...wings) - Math.min(...wings) < 6, '收窄细线箭头的两翼')
  const arrowCanvas = { cards: [], shapes: [savedArrow], ink: [] }
  assert.deepEqual([...boxSelection(arrowCanvas, { x: -1, y: -4, w: 103, h: 8 }).shapes], ['arrow-a'], '紧贴箭头可框选')
  assert.equal(boxSelection(arrowCanvas, { x: -1, y: -2, w: 103, h: 4 }).bounds, null, '切过箭头两翼时不算完全框住')
  doc.canvases[0].shapes.push(square)
  const boxCanvas = { ...doc.canvases[0], cards: [
    { id: 'image-underlay', kind: 'image', x: 0, y: 0, w: 400, h: 400 },
    { id: 'small-note', kind: 'text', x: 100, y: 100, w: 120, h: 120 },
  ], edges: [{ id: 'attached-edge', from: 'small-note', to: 'image-underlay' }],
  ink: [{ ...stroke, points: [[35.125, 50, 15], [70.5, 68.25, 85]] }] }
  const group = boxSelection(boxCanvas, { x: 20, y: 20, w: 210, h: 210 })
  assert.deepEqual([...group.cards], ['small-note'], '框选覆盖图片一部分时不移动整张图片')
  assert.deepEqual([...group.shapes], ['square-a'])
  assert.deepEqual([...group.ink], ['stroke-a'])
  const moved = moveBoxSelection(boxCanvas, group, 25.4, -17.8)
  assert.equal(moved.cards[0], boxCanvas.cards[0])
  assert.equal(moved.edges, boxCanvas.edges, '连线按卡片 ID 跟随，不需要改写')
  const movedEdge = edgeGeometry(moved, moved.edges[0])
  assert.deepEqual([movedEdge.x1, movedEdge.y1, movedEdge.x2, movedEdge.y2], [185, 142, 200, 200])
  assert.deepEqual([moved.cards[1].x, moved.cards[1].y], [125, 82])
  assert.deepEqual([moved.shapes[0].x1, moved.shapes[0].y1], [105, 62])
  assert.deepEqual(moved.ink[0].points, [[60.125, 32, 15], [95.5, 50.25, 85]], '整组平移保留亚像素笔迹和笔压')
  const movedGroup = offsetBoxSelection(group, 25.4, -17.8)
  assert.equal(movedGroup.cards, group.cards)
  assert.equal(movedGroup.bounds.x, group.bounds.x + 25)
  assert.equal(moveBoxSelection(moved, movedGroup, -25, 18).ink[0].points[0][0], 35.125, '同一选区可连续拖动')
  const limit = CANVAS_LIMITS.coordinate
  const limitStroke = { ...stroke, points: [[limit - 0.375, 10, 15], [limit - 3.5, 12, 85]] }
  const limitCanvas = { cards: [], shapes: [], ink: [limitStroke] }
  const limitGroup = boxSelection(limitCanvas, { x: limit - 10, y: 0, w: 20, h: 20 })
  assert.deepEqual(boxDelta(limitGroup, 30, 0), { dx: 0.375, dy: 0 })
  assert.deepEqual(moveBoxSelection(limitCanvas, limitGroup, 30, 0).ink[0].points,
    [[limit, 10, 15], [limit - 3.125, 12, 85]], '触及坐标上限时保持全组形状')
  const clipped = { ...limitCanvas, paper: { enabled: true, sheets: [{ x: 0, y: 0 }] } }
  assert.equal(boxSelection(clipped, { x: limit - 10, y: 0, w: 20, h: 20 }).bounds, null, 'A4 模式略过完全不可见的笔迹')
  const legacyPaper = normalizeDocument({ version: 2, canvases: [{ paper: { enabled: true, x: -120, y: -60 } }] }).canvases[0].paper
  assert.deepEqual(legacyPaper, { enabled: true, sheets: [{ id: 'paper-1', x: -120, y: -60 }], activeId: 'paper-1' }, '旧版单张 A4 纸保留世界坐标')
  assert.equal(normalizePaper({ enabled: false, x: 10, y: 20 }).enabled, false, '旧版保留已关闭的纸张')
  const paper = addPaperSheet(legacyPaper, { x: -120, y: 1140 })
  assert.deepEqual(normalizePaper(paper), paper, '多张 A4 纸的顺序与选中状态可往返')
  assert.equal(activePaperSheet(paper).y, 1140)
  assert.equal(selectPaperSheet(paper, legacyPaper.activeId).activeId, legacyPaper.activeId)
  assert.deepEqual(removePaperSheet(paper, paper.activeId), legacyPaper)
  assert.equal(removePaperSheet(legacyPaper, legacyPaper.activeId), null)
  assert.throws(() => normalizePaper({ enabled: true, sheets: Array(CANVAS_LIMITS.sheets + 1).fill(legacyPaper.sheets[0]) }), /最多.*张 A4 纸/)
  doc.canvases[0].paper = paper
  const printable = addCard(doc.canvases[0], { kind: 'text', x: 0, y: 1180, text: '第二张纸的内容' })
  const pdfHTML = canvasPrintHTML(printable)
  assert.equal((pdfHTML.match(/data-sheet-id=/g) ?? []).length, 2)
  assert.match(pdfHTML, /viewBox="-120 -60 794 1123"/)
  assert.match(pdfHTML, /viewBox="-120 1140 794 1123"/)
  const rasterHTML = canvasPrintHTML(printable, { sheetId: paper.activeId, imageSize: A4_IMAGE_SIZE })
  assert.equal((rasterHTML.match(/data-sheet-id=/g) ?? []).length, 1)
  assert.match(rasterHTML, /第二张纸的内容/)
  assert.doesNotMatch(rasterHTML, /第一张卡片/)
  assert.throws(() => canvasPrintHTML(printable, { sheetId: 'missing' }), /纸张不存在/)

  // 指针中心缩放：屏幕上这个点下面的世界坐标不能漂移。
  const view = { x: 37, y: -12, scale: 0.8 }
  const pointer = { x: 412, y: 296 }
  const anchored = screenToWorld(view, pointer)
  const zoomed = zoomAt(view, pointer, 2.1)
  near(screenToWorld(zoomed, pointer).x, anchored.x, '缩放后指针处的世界 x 保持不动')
  near(screenToWorld(zoomed, pointer).y, anchored.y, '缩放后指针处的世界 y 保持不动')
  near(zoomed.scale, 2.1, '缩放比例按请求生效')
  const far = { x: -890000, y: 900000, scale: 1 }
  const highZoom = zoomAt(far, pointer, 16)
  const restoredHighZoom = normalizeDocument({ canvases: [{ view: highZoom }] }).canvases[0].view
  assert.deepEqual(restoredHighZoom, highZoom, '远离原点的高倍率视口可完整保存')
  near(screenToWorld(highZoom, pointer).x, screenToWorld(far, pointer).x, '1600% 缩放仍以指针为锚点')
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
  canvas = normalizeDocument({ canvases: [{ ...canvas, edges: [{ id: 'legacy-edge', from: first.id, to: second.id }] }] }).canvases[0]
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
  const image = { name: 'diagram.png', mimeType: 'image/png', width: 1, height: 1,
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' }
  const incoming = { records: [{ id: 'original-question', type: 'mistake', title: '导入测试', stem: '跨库后可读到完整题干' }],
    canvas: { canvases: [{ id: 'photo-board', cards: [{ id: 'photo', kind: 'image', image },
      { id: 'question', kind: 'reference', noteId: 'original-question', noteType: 'mistake', question: { fields: { title: '画布内标题' } } }] }] } }
  restored.import(incoming)
  const [photo, question] = restored.canvasDocs().canvases.find(canvas => canvas.id === 'photo-board').cards
  assert.deepEqual(photo.image, image, '导入保留原图')
  assert.notEqual(question.noteId, 'original-question', '跨库时映射画布引用')
  assert.equal(restored.read(question.noteId).stem, '跨库后可读到完整题干')
  assert.equal(question.question.fields.title, '画布内标题')
  assert.throws(() => restored.setCanvasDocs({ canvases: [{ cards: [{ kind: 'image', image: { ...image, data: 'bm90IGEgcmFzdGVy' } }] }] }), /图片格式或尺寸无效/)
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
