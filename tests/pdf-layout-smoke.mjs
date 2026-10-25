// 错题 PDF 排版模型的纯逻辑测试：不需要 Electron、不需要浏览器。
// 覆盖越界夹紧、自动分页、阅读顺序、重叠与溢出判定，以及最终 HTML 的关键约束。
import assert from 'node:assert/strict'
import {
  PRINT_LIMITS, autoPlace, columnSlots, contentBox, documentHTML, estimateHeight,
  findOverflow, findOverlaps, normalizeLayout, normalizeSettings, paperSize, readingOrder,
} from '../addons/mistakebook/print-layout.mjs'

const checks = []
const check = (name, run) => { run(); checks.push(name) }

check('设置被夹紧而不是抛错', () => {
  const settings = normalizeSettings({ paper: 'a3', margin: 999, columns: 7, fontSize: -1, gap: 0, header: 'x'.repeat(300), fields: { image: 'yes', cause: false } })
  assert.equal(settings.paper, 'a4')
  assert.equal(settings.margin, PRINT_LIMITS.margin[1])
  assert.equal(settings.columns, 2)
  assert.equal(settings.fontSize, PRINT_LIMITS.fontSize[0])
  assert.equal(settings.gap, PRINT_LIMITS.gap[0])
  assert.equal(settings.header.length, PRINT_LIMITS.text)
  assert.equal(settings.fields.image, true, '非布尔按默认')
  assert.equal(settings.fields.cause, false)
  assert.equal(settings.fields.notes, false, '默认不显示复盘')
})

check('纸张与内容框', () => {
  assert.deepEqual(paperSize({ paper: 'a4' }), { width: 210, height: 297 })
  assert.deepEqual(paperSize({ paper: 'a4-landscape' }), { width: 297, height: 210 })
  const box = contentBox({ paper: 'a4', margin: 12 })
  assert.deepEqual(box, { x: 12, y: 12, width: 186, height: 273 })
})

check('两栏等宽且留出栏间距', () => {
  const slots = columnSlots({ margin: 12, columns: 2, gap: 6 })
  assert.equal(slots.length, 2)
  assert.equal(Math.round(slots[0].width * 10) / 10, 90)
  assert.equal(slots[0].x, 12)
  assert.equal(slots[1].x, 12 + 90 + 6)
  assert.equal(columnSlots({ columns: 1 })[0].width, contentBox({ columns: 1 }).width)
})

check('自动排版按栏铺、排满换页、不越过内容框下沿', () => {
  const settings = { paper: 'a4', margin: 12, columns: 2, gap: 6 }
  const box = contentBox(settings)
  const bottom = box.y + box.height
  const layout = autoPlace(Array.from({ length: 10 }, (_, index) => ({ questionId: `q${index}`, height: 120 })), settings)
  assert.equal(layout.pages, 3, '每页 2 栏 × 2 题，10 题 → 3 页')
  assert.equal(layout.blocks.length, 10)
  for (const block of layout.blocks) {
    assert.ok(block.y + 120 <= bottom + 0.01, `第 ${block.questionId} 题越界：${block.y + 120}`)
    assert.ok(block.x >= box.x && block.x + block.w <= box.x + box.width + 0.01)
  }
  assert.deepEqual(layout.blocks.map(block => block.page), [1, 1, 1, 1, 2, 2, 2, 2, 3, 3])
})

check('自动排版用估算高度兜底', () => {
  const record = { stem: '题目'.repeat(200), images: [{ width: 800, height: 600 }] }
  const height = estimateHeight(record, 90, { fields: { image: true } })
  assert.ok(height > 60, `估算高度应包含图片：${height}`)
  const noImage = estimateHeight(record, 90, { fields: { image: false } })
  assert.ok(noImage < height, '关掉原图后高度应变小')
})

check('版面归一化：丢弃未知与重复、夹紧坐标、页数覆盖到最深一页', () => {
  const ids = ['a', 'b']
  const layout = normalizeLayout({
    pages: 1,
    blocks: [
      { questionId: 'a', page: 99, x: -50, y: 5000, w: 999, h: 40 },
      { questionId: 'a', page: 1, x: 20, y: 20, w: 80 },
      { questionId: 'ghost', page: 1, x: 20, y: 20, w: 80 },
      { questionId: 'b', page: 2, x: 20, y: 20, w: 10 },
    ],
  }, ids, { paper: 'a4', margin: 12 })
  assert.equal(layout.blocks.length, 2)
  assert.equal(layout.pages, PRINT_LIMITS.pages, '最深一页是 99 → 夹到上限')
  const [first, second] = layout.blocks
  assert.equal(first.page, PRINT_LIMITS.pages)
  assert.equal(first.x, 12, '负坐标夹到页边距')
  assert.equal(first.y, 297 - 12 - PRINT_LIMITS.minHeight)
  assert.equal(first.w, 186, '超宽夹到内容宽')
  assert.equal(first.h, 40)
  assert.equal(second.w, PRINT_LIMITS.minWidth, '过窄抬到最小宽度')
})

check('版面上限：最多 100 道题、最多 40 页', () => {
  const ids = Array.from({ length: 150 }, (_, index) => `q${index}`)
  const layout = normalizeLayout({ pages: 99, blocks: ids.map((id, index) => ({ questionId: id, page: 1, x: 12, y: 12 + index, w: 80 })) }, ids, {})
  assert.equal(layout.blocks.length, PRINT_LIMITS.blocks)
  assert.equal(layout.pages, PRINT_LIMITS.pages)
})

check('阅读顺序：页 → 上 → 左', () => {
  const order = readingOrder([
    { questionId: 'c', page: 2, x: 12, y: 40 },
    { questionId: 'b', page: 1, x: 108, y: 20 },
    { questionId: 'a', page: 1, x: 12, y: 20 },
    { questionId: 'd', page: 1, x: 12, y: 10 },
  ]).map(block => block.questionId)
  assert.deepEqual(order, ['d', 'a', 'b', 'c'])
})

check('重叠与溢出：只报告真实问题', () => {
  const blocks = [
    { questionId: 'a', page: 1, x: 12, y: 12, w: 80, h: 40 },
    { questionId: 'b', page: 1, x: 40, y: 30, w: 80, h: 40 },
    { questionId: 'c', page: 1, x: 12, y: 80, w: 80, h: 40 },
    { questionId: 'd', page: 2, x: 12, y: 12, w: 80, h: 40 },
  ]
  assert.deepEqual(findOverlaps(blocks).map(pair => pair.join('-')), ['a-b'])
  assert.deepEqual(findOverflow(blocks, { paper: 'a4', margin: 12 }), [])
  assert.deepEqual(findOverflow([{ questionId: 'x', page: 1, y: 280, h: 40 }], { margin: 12 }), ['x'])
})

check('文档 HTML：页面尺寸、逐页页眉页脚、编号按阅读顺序、文字被转义', () => {
  const settings = normalizeSettings({ paper: 'a4', margin: 12, columns: 2, header: '<script>alert(1)</script>', footer: '内部资料' })
  const layout = {
    pages: 2,
    blocks: [
      { questionId: 'b', page: 2, x: 12, y: 20, w: 90 },
      { questionId: 'a', page: 1, x: 12, y: 20, w: 90 },
    ],
  }
  const html = documentHTML({ settings, layout, bodies: { a: '<p>第一题</p>', b: '<p>第二题</p>' }, title: '错题 · 10 月', subtitle: '共 2 题' })
  assert.match(html, /@page \{ size: 210mm 297mm; margin: 0; \}/)
  assert.equal(html.match(/class="pg"/g).length, 2)
  assert.equal(html.match(/class="blk"/g).length, 2)
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), '页眉必须转义')
  assert.ok(!html.includes('<script>alert(1)</script>'))
  assert.ok(html.includes('第 1 / 2 页') && html.includes('第 2 / 2 页'))
  assert.ok(html.indexOf('第一题') < html.indexOf('第二题'), '正文顺序应按页排')
  assert.match(html, /<span class="blk-num">1<\/span><p>第一题<\/p>/)
  assert.match(html, /<span class="blk-num">2<\/span><p>第二题<\/p>/)
  assert.ok(html.includes('共 2 题') && html.includes('内部资料'))
})

check('文档 HTML：横版、关闭编号、缺正文时给出明确占位', () => {
  const html = documentHTML({
    settings: normalizeSettings({ paper: 'a4-landscape', numbering: false }),
    layout: { pages: 1, blocks: [{ questionId: 'a', page: 1, x: 12, y: 12, w: 90 }] },
    bodies: {},
    title: '横版',
  })
  assert.match(html, /size: 297mm 210mm/)
  assert.ok(!html.includes('class="blk-num"'))
  assert.ok(html.includes('这道题的内容没有加载'))
})

check('空版面也给出一页，不会生成 0 页 PDF', () => {
  const html = documentHTML({ settings: {}, layout: { pages: 0, blocks: [] }, bodies: {} })
  assert.equal(html.match(/class="pg"/g).length, 1)
})

console.log(`pdf layout smoke: ok (${checks.length} groups)`)
