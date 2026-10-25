/**
 * 光学核心的自检：SDF、高度场、法线、Snell、Fresnel、位移图编码。
 *
 *   node tests/optical-smoke.mjs
 *
 * 这些是纯函数，不依赖 DOM 与浏览器——先把数学钉住，后端（SVG / WebGL）才有对照物。
 */
import assert from 'node:assert/strict'
import { buildDistanceField, radiusFor, sdfGradient, signedDistance } from '../desktop/renderer/optical/geometry.js'
import { buildNormalField, normalAt, PROFILES } from '../desktop/renderer/optical/surface.js'
import { buildDisplacementMap, buildReflectionMap, displacement, fresnel, refract } from '../desktop/renderer/optical/optics.js'

const SIZE = { width: 200, height: 100, radius: 20 }
let checks = 0
const ok = (label, condition) => { assert.ok(condition, label); checks++ }
const near = (label, actual, expected, tolerance = 1e-6) => ok(`${label}（${actual} vs ${expected}）`, Math.abs(actual - expected) <= tolerance)

// ---------- 1. 几何 ----------
near('圆角矩形中心在内部', Math.sign(signedDistance({ x: 100, y: 50, ...SIZE })), -1)
ok('圆角矩形外部为正', signedDistance({ x: 5, y: 5, ...SIZE }) > 0)
near('左直边距离', signedDistance({ x: 0.5, y: 50, ...SIZE }), -0.5, 1e-6)
near('pill 的半径等于半高', radiusFor({ shape: 'pill', width: 200, height: 40 }), 20)
near('circle 的半径等于半宽', radiusFor({ shape: 'circle', width: 40, height: 40 }), 20)
ok('圆角段梯度是单位向量', Math.abs(Math.hypot(sdfGradient({ x: 8, y: 8, ...SIZE }).x, sdfGradient({ x: 8, y: 8, ...SIZE }).y) - 1) < 1e-9)
ok('直边段梯度指向外侧', sdfGradient({ x: 1, y: 50, ...SIZE }).x === -1)
const field = buildDistanceField({ width: 40, height: 20, radius: 6 })
ok('距离场尺寸正确', field.data.length === 40 * 20)
ok('距离场中心为负、四角为正', field.data[10 * 40 + 20] < 0 && field.data[0] > 0)

// ---------- 2. 表面：高度与法线 ----------
const center = normalAt({ x: 100, y: 50, ...SIZE, bezelWidth: 16, thickness: 8 })
// 法线在 bezel 的中点最陡：smoothstep 在 t=0 与 t=1 处斜率为 0。
// thickness 是 px：真实倒角大约是 bezel 的一半，否则法线几乎不倾斜、没有透镜感。
const edge = normalAt({ x: 8, y: 50, ...SIZE, bezelWidth: 16, thickness: 8 })
ok('中心法线几乎垂直屏幕', center.z > 0.999)
ok('边缘法线明显倾斜', Math.abs(edge.x) > 0.2)
ok('边缘法线指向外侧', edge.x < 0)
ok('中心高度大于边缘高度', center.height > edge.height)
ok('arc 剖面比 smooth 更陡', PROFILES.arc.height(0.5) > PROFILES.smooth.height(0.5))
const normalField = buildNormalField({ width: 60, height: 30, radius: 8 })
ok('法线场每个像素都是单位向量', (() => {
  for (let i = 0; i < normalField.data.length; i += 4) {
    const length = Math.hypot(normalField.data[i], normalField.data[i + 1], normalField.data[i + 2])
    if (Math.abs(length - 1) > 1e-5) return false
  }
  return true
})())

// ---------- 3. Snell 与 Fresnel ----------
const vertical = refract({ incident: { x: 0, y: 0, z: -1 }, normal: { x: 0, y: 0, z: 1 }, ior: 1.5 })
near('垂直入射不偏折', Math.hypot(vertical.x, vertical.y), 0, 1e-9)
ok('垂直入射仍在向背景传播', vertical.z < 0)
const tilted = refract({ incident: { x: 0, y: 0, z: -1 }, normal: { x: 0.6, y: 0, z: 0.8 }, ior: 1.5 })
ok('倾斜入射产生方向变化', Math.abs(tilted.x) > 0.05)
near('折射方向仍是单位向量', Math.hypot(tilted.x, tilted.y, tilted.z), 1, 1e-9)
// 空气 → 玻璃（η < 1）不会发生全反射；掠射只是把方向压向表面，这正是不该误报 TIR 的边界
const grazing = refract({ incident: { x: 0, y: 0, z: -1 }, normal: { x: 1, y: 0, z: 0 }, ior: 1.5 })
ok('空气进入玻璃不判全反射', grazing.tir === false)
ok('掠射时方向明显偏转', Math.abs(grazing.x) > 0.3)
near('垂直观察时 Fresnel 约为 F0', fresnel({ cosTheta: 1, ior: 1.5 }), 0.04, 1e-3)
ok('掠射时 Fresnel 接近 1', fresnel({ cosTheta: 0, ior: 1.5 }) > 0.9)

// ---------- 4. 位移：中心为零、边缘最大 ----------
const flatNormal = { x: 0, y: 0, z: 1 }
near('垂直法线不产生位移', Math.hypot(displacement({ height: 1, normal: flatNormal }).x, displacement({ height: 1, normal: flatNormal }).y), 0, 1e-9)
const tiltedShift = displacement({ height: 0.5, normal: { x: 0.5, y: 0, z: Math.sqrt(0.75) }, ior: 1.5 })
ok('倾斜法线产生位移', Math.abs(tiltedShift.x) > 0.01)
// 法线朝外时，折射光朝内偏（空气→玻璃 n 变大，光线贴近法线），所以位移与法线反号
ok('位移方向与法线反号', Math.sign(tiltedShift.x) === -Math.sign(0.5))
ok('位移幅值随法线倾角增大', Math.abs(tiltedShift.x) > Math.abs(displacement({ height: 0.5, normal: { x: 0.1, y: 0, z: Math.sqrt(0.99) }, ior: 1.5 }).x))

// ---------- 5. 位移贴图编码 ----------
const map = buildDisplacementMap({ width: 80, height: 40, radius: 10, bezelWidth: 12, thickness: 6, ior: 1.5, displacementScale: 30 })
ok('贴图尺寸与元素一致', map.width === 80 && map.height === 40 && map.data.length === 80 * 40 * 4)
const centerPixel = ((20 * 80) + 40) * 4
near('贴图中心是中性值', map.data[centerPixel], 128, 1)
// 最大位移出现在 bezel 中段（smoothstep 在端点斜率为 0），所以整图的最大偏离接近饱和
const maxDeviation = Math.max(...Array.from({ length: map.width * map.height }, (_, i) => Math.abs(map.data[i * 4] - 128)))
ok('贴图里存在接近饱和的位移', maxDeviation > 100)
ok('R 与 B 通道相同（x 位移）', map.data[centerPixel] === map.data[centerPixel + 2])
ok('位移贴图 alpha 完全不透明，避免预乘污染中性值', map.data.filter((_,index)=>index%4===3).every(value=>value===255))
ok('滤镜幅值覆盖实际最大位移', map.filterScale / 2 >= map.maxDisplacement - 1e-6)
ok('滤镜幅值有下限', map.filterScale >= 0.5)
ok('所有像素都在字节范围内', map.data.every(value => value >= 0 && value <= 255))

const reflections=buildReflectionMap({width:160,height:80,radius:20,bezelWidth:10,thickness:6})
const alphaAt=(image,x,y)=>image.data[(y*image.width+x)*4+3]
ok('平坦中心不叠白色反射',alphaAt(reflections,80,40)===0)
ok('倒角反射有方向：顶部亮于底部',alphaAt(reflections,80,0)>alphaAt(reflections,80,79))
ok('圆角外不产生反射',alphaAt(reflections,0,0)===0)
ok('中央磨砂遮罩完整',alphaAt(reflections.frostMask,80,40)===255)
ok('最外侧倒角保留透明采样',alphaAt(reflections.frostMask,80,0)<8)
const production=buildDisplacementMap({width:400,height:44,radius:22,bezelWidth:10,thickness:5.5,ior:1.46,profile:'arc',displacementScale:2.6})
ok('生产位移控制在真实像素量级',production.maxDisplacement>1 && production.maxDisplacement<8)
console.log(`optical smoke: ${checks} checks, 0 failed`)
