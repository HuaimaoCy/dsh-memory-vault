/**
 * 材质引擎的 Node 冒烟测试：只测纯逻辑与几何，不假装验证渲染。
 *
 * 渲染结果由 tests/preview-app.mjs 的截图负责；这里守的是「名字与规则」：
 * 表面映射表与契约一致、分级优先级不变、指针角度定义不变、位移贴图几何正确。
 */
import assert from 'node:assert/strict'

import { GLASS_SURFACES, GLASS_TIERS, glassCapabilities, glareFor, mountGlass, resolveTier, setGlassTier } from '../desktop/renderer/glass.js'
import { createRimMap, rimMapDataUrl, rimNormalAt } from '../desktop/renderer/glass-refraction.js'

const checks = []
const check = (name, run) => {
  try { run(); checks.push({ name, ok: true }) } catch (error) { checks.push({ name, ok: false, error }) }
}

check('表面表覆盖五类面，且契约里的选择器一个不少', () => {
  const kinds = new Set(GLASS_SURFACES.map(surface => surface.kind))
  assert.deepEqual([...kinds].sort(), ['chrome', 'control', 'float', 'hud', 'panel'])
  const selectors = GLASS_SURFACES.flatMap(surface => surface.selectors)
  for (const required of ['.side', '.bar', '.drawer', 'dialog', '#status', '.btn', '.nav']) {
    assert.ok(selectors.includes(required), `缺少选择器 ${required}`)
  }
  assert.deepEqual([...GLASS_TIERS], ['full', 'balanced', 'flat'])
})

check('分级：无障碍偏好压过显式选择，其次能力，最后默认', () => {
  const base = { backdropFilter: true, hardwareConcurrency: 8, forcedColors: false, contrastMore: false, reducedTransparency: false }
  assert.equal(resolveTier({ requested: 'full', capabilities: base }), 'full')
  assert.equal(resolveTier({ capabilities: base }), 'balanced')
  // 系统级无障碍偏好：连显式选择都要让位（用户看不清时，材质不该赢）
  assert.equal(resolveTier({ requested: 'full', capabilities: { ...base, forcedColors: true } }), 'flat')
  assert.equal(resolveTier({ requested: 'full', capabilities: { ...base, contrastMore: true } }), 'flat')
  assert.equal(resolveTier({ requested: 'full', capabilities: { ...base, reducedTransparency: true } }), 'flat')
  assert.equal(resolveTier({ requested: 'balanced', capabilities: { ...base, contrastMore: true } }), 'flat')
  // 能力不足时才下降
  assert.equal(resolveTier({ capabilities: { ...base, backdropFilter: false } }), 'flat')
  assert.equal(resolveTier({ capabilities: { ...base, hardwareConcurrency: 2 } }), 'flat')
  assert.equal(resolveTier({ capabilities: { ...base, hardwareConcurrency: 4 } }), 'balanced')
  assert.equal(resolveTier({ requested: 'full', capabilities: { ...base, backdropFilter: false } }), 'flat')
  assert.equal(resolveTier({ requested: 'full', capabilities: { ...base, hardwareConcurrency: 2 } }), 'flat')
  assert.equal(resolveTier({ requested: 'full', capabilities: { ...base, backdropFilterUrl: false } }), 'balanced')
  // full 永远不会被自动选中
  assert.notEqual(resolveTier({ capabilities: base }), 'full')
})

check('指针角度：顶部为 0deg，右侧 90deg，左下 -135deg', () => {
  const at = (x, y) => glareFor({ width: 200, height: 100, x, y })
  const top = at(100, 0)
  assert.ok(Math.abs(top.gx - 0.5) < 1e-6 && Math.abs(top.gy) < 1e-6)
  assert.ok(Math.abs(top.angle) < 1e-6, `顶部应为 0deg，实际 ${top.angle}`)
  assert.ok(Math.abs(at(200, 50).angle - 90) < 1e-6)
  assert.ok(Math.abs(at(0, 100).angle + 135) < 1e-6, `左下应为 -135deg，实际 ${at(0, 100).angle}`)
  // 越界坐标夹在 0–1，不产生负的高光位置
  const outside = at(-50, 400)
  assert.equal(outside.gx, 0)
  assert.equal(outside.gy, 1)
})

check('Node 环境下的能力探测安全降级为 flat', () => {
  const caps = glassCapabilities()
  assert.equal(caps.backdropFilter, false)
  assert.equal(caps.reducedMotion, true)
  assert.equal(resolveTier({ capabilities: caps }), 'flat')
  const instance = mountGlass()
  assert.equal(instance.tier(), 'flat')
  assert.deepEqual(instance.surfaces(), [])
  assert.equal(setGlassTier('full'), 'flat')
  instance.destroy()
})

check('位移贴图：中心中性 128，只有边缘带位移，通道在 0–255', () => {
  const shape = { width: 200, height: 120, radius: 24, band: 12 }
  const center = rimNormalAt({ ...shape, x: 100, y: 60 })
  assert.deepEqual([center.r, center.g], [128, 128])
  assert.equal(center.amount, 0)
  const left = rimNormalAt({ ...shape, x: 0.5, y: 60 })
  assert.ok(left.nx < 0 && left.r < 128, `左边缘应朝左位移（R<128），实际 R=${left.r} nx=${left.nx}`)
  const right = rimNormalAt({ ...shape, x: 199.5, y: 60 })
  assert.ok(right.nx > 0 && right.r > 128)
  const top = rimNormalAt({ ...shape, x: 100, y: 0.5 })
  assert.ok(top.ny < 0 && top.g < 128, `上边缘 G 应小于 128，实际 ${top.g}`)
  const bottom = rimNormalAt({ ...shape, x: 100, y: 119.5 })
  assert.ok(bottom.ny > 0 && bottom.g > 128)
  // 圆角处法线是斜的：右上角内侧同时有 +x 与 -y（再往外是圆角切掉的区域，不该有数据）
  const corner = rimNormalAt({ ...shape, x: 188, y: 12 })
  assert.ok(corner.nx > 0 && corner.ny < 0, `右上角法线应指向右上，实际 ${corner.nx},${corner.ny}`)
  const beyondCorner = rimNormalAt({ ...shape, x: 199.5, y: 0.5 })
  assert.deepEqual([beyondCorner.r, beyondCorner.g], [128, 128], '圆角外的像素必须中性，否则边缘会出现位移脏边')
  for (const sample of [left, right, top, bottom, corner]) {
    for (const value of [sample.r, sample.g, sample.b]) assert.ok(value >= 0 && value <= 255)
  }
})

check('贴图尺寸与 alpha：整张图不透明，尺寸取整', () => {
  const map = createRimMap({ width: 64.4, height: 32.6, radius: 8, band: 6 })
  assert.equal(map.width, 64)
  assert.equal(map.height, 33)
  assert.equal(map.data.length, 64 * 33 * 4)
  const pixel = (x, y) => map.data.slice((y * 64 + x) * 4, (y * 64 + x) * 4 + 4)
  assert.deepEqual([...pixel(0, 0)].slice(0, 3), [128, 128, 128].map((value, index) => pixel(0, 0)[index]))
  for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) assert.equal(pixel(x, y)[3], 255)
  const middle = pixel(32, 16)
  assert.deepEqual([middle[0], middle[1], middle[2]], [128, 128, 128])
})

check('贴图 data URI 必须有 document：Node 里显式报错而不是静默返回空串', () => {
  assert.throws(() => rimMapDataUrl({ width: 32, height: 32 }), /document/)
})

const failed = checks.filter(entry => !entry.ok)
for (const entry of checks) console.log(`${entry.ok ? 'ok  ' : 'FAIL'} ${entry.name}`)
for (const entry of failed) console.error(entry.error?.stack ?? entry.error)
if (failed.length) {
  console.error(`\nglass smoke: ${failed.length}/${checks.length} failed`)
  process.exitCode = 1
} else {
  console.log(`\nglass smoke: ${checks.length} checks, 0 failed`)
}
