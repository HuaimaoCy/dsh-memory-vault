# Alaya Optical Engine（0.8）

> 一句话：把 Liquid Glass 从「CSS 叠白色半透明」换成一条真实的光学链——
> **SDF → 高度场 → 法线 → Snell 折射 → 背景采样 → Fresnel + 合成**，
> 数学在 `optical/`，渲染后端可替换（SVG / WebGL2），调度层负责缓存与脏区。

本文只写实现与实测；设计依据与材质规范见 `docs/liquid-glass.zh.md`。

应用默认请求 full，并在两个产品的「外观」面板提供三档选择。
SVG 后端覆盖两侧工具条、搜索框与浮层；ResizeObserver 跟踪元素尺寸变化。
滤镜与位移贴图缓存各限制在 16 项，仅回收未使用条目；卸载与节点移除时释放绑定。
浏览器端与桌面端验证见 `tests/preview-liquid-glass.mjs`、`tests/desktop-liquid-glass.mjs`；
高 DPI 与窗口合成仍需在真机上确认。

---

## 1. 模块边界

```
desktop/renderer/optical/
├── geometry.js          SDF：圆角矩形 / 胶囊 / 圆，距离与解析梯度
├── surface.js           高度场（smoothstep / 圆弧剖面）→ 单位法线
├── optics.js            Snell 折射、Fresnel(Schlick)、色散、位移贴图编码
├── glass-engine.js      注册、共享缓存、脏区调度、质量分级、指标
├── backends/
│   ├── svg.js           feDisplacementMap 后端（实时 DOM 背景）
│   ├── webgl.js         WebGL2 后端（可控背景，单 pass 共享 shader）
│   └── shader.frag.glsl 着色器可读来源（与 webgl.js 内的字符串同步）
tests/
├── optical-smoke.mjs    纯数学自检（35 项，Node 直接跑）
├── preview-optical.mjs  界面级光学验收（折射 / 真实界面 / 动态，3 项）
├── preview-webgl.mjs    WebGL 后端验收（GPU 像素位移 4 项）
└── preview-perf.mjs     基线 vs full 档性能基准
```

渲染层没有打包步骤，所以数学模块是 **JS + JSDoc 约定**而不是 TypeScript；
接口与数据形状仍按设计文档的 `GlassOptions` 收敛（`shape/radius/bezelWidth/
thickness/ior/displacementScale/profile`）。

## 2. 数学链（每步都能单测）

| 步 | 公式 | 实现 |
| --- | --- | --- |
| SDF | `q = |p−c| − (b−r)`，`d = ‖max(q,0)‖ + min(max(qx,qy),0) − r` | `geometry.signedDistance` |
| 高度场 | `t = clamp(−d/bezel, 0, 1)`，`H = thickness · (3t²−2t³)` | `surface.heightAt` |
| 法线 | `N = normalize(−∂H/∂x, −∂H/∂y, 1)`，梯度用 SDF 解析值 | `surface.normalAt` |
| 折射 | `η=1/n`，`k=1−η²(1−cos²θ)`，`T = ηI + (ηcosθ−√k)N` | `optics.refract` |
| 位移 | `Δxy = H/(−Tz) · (Tx, Ty)` | `optics.displacement` |
| Fresnel | `F = F0 + (1−F0)(1−cosθ)^5`，`F0 = ((n−1)/(n+1))²` | `optics.fresnel` |

约定（改代码前先看这三条）：

1. **y 向下**，与 DOM 一致；WebGL 里只翻一次 `gl_FragCoord.y`。
2. **法线的符号**：指向玻璃外部。空气→玻璃的折射光朝内偏，所以位移与法线**反号**
   （单测里钉住了这条，免得两边各写一个方向互相抵消）。
3. **thickness 是 px**：法线倾角 ≈ `thickness · profile'(t) / bezel`。
   默认 `thickness = bezel·0.5` 量级才有透镜感；用 1px 得到的是一块平玻璃。

位移贴图编码：通道 128 为中性，`c = 128 + (d/maxAbs)·127`，滤镜幅值
`filterScale = 2·maxAbs`，于是 `feDisplacementMap` 的位移恰好还原 `d`。
同一张贴图可以在不同强度档位复用，只改滤镜的 `scale` 属性。

## 3. 两个后端，各自解决什么

| | SVG（`backends/svg.js`） | WebGL2（`backends/webgl.js`） |
| --- | --- | --- |
| 背景来源 | **真实 DOM**（`backdrop-filter` 采样合成结果） | **可控背景**（程序化环境色，纹理/坐标自算） |
| 能看到什么 | 玻璃后的卡片、文字、滚动内容 | 只有我们自己画的背景 |
| 形状数 | 每个面一张独立滤镜 | 单 canvas、单 program、最多 8 形状一次 draw |
| 缓存 | 贴图按几何+光学参数缓存；滤镜节点缓存 | 无贴图（坐标任意求值），保留上一帧做局部重绘 |
| 首帧成本 | 一张贴图 PNG 编码 ~几十 ms | 编译 shader ~8ms，之后每帧 <1ms |
| 用在 | **full 档默认**（顶栏胶囊、浮层） | 可控背景实验档 / 性能台 |

WebGL 不能读任意 DOM 背后的像素，这是浏览器合成器的边界，不是实现问题。
所以生产路径是 SVG；WebGL 用在「背景是我们自己画的」那种场景（本仓库里就是
环境色层），并作为将来 HTML-in-Canvas 可用后的落点。

**两者都实测过**：SVG 后端在 full 档下，胶囊区域相对 balanced 平均像素差
9.53、最大 52.2（`preview-optical.mjs`）；WebGL 后端在网格背景下，ior 1.0
与 1.5 的胶囊区域平均差 18.60、最大 202，区域外 0（`preview-webgl.mjs`）。

## 4. 性能策略与实测

设计文档给的六条，实现情况与数字：

| 策略 | 实现 | 实测 |
| --- | --- | --- |
| 共享容器 | 单引擎、单 SVG defs 树、WebGL 单 program + 单 draw | — |
| 光学数据缓存 | `mapCache`（贴图）/`filterCache`（节点）按同一 key | 指针划过 40 次：**0** 次贴图重建、**0** 次 render |
| 脏区 | 只处理 `dirty` 面；WebGL 另有 `dirtyOnly` 的 scissor 路径 | 静止 1.2s：render 次数 **0** 增长 |
| 多分辨率 | 贴图按精确尺寸（不降采样，边缘靠它）；模糊仍交给 CSS 合成器 | — |
| 事件驱动 | `invalidate()` 合并到一帧；`visibilitychange`、窗口失焦停排 | 静止不跑循环（无常驻 rAF） |
| 自适应质量 | `setQuality('auto')`：连续 6 次超预算降级、90 次稳定回升；a11y 优先级仍在 `resolveTier()` 之上 | 档位切换记录在 `metrics().qualityChanges` |

`tests/preview-perf.mjs` 的实测（headless 软件合成，同进程基线对比）：

| 场景 | 结果 |
| --- | --- |
| 基线 balanced 滚动 | p50 16.7 / p95 16.7 ms |
| 切到 full（含模块加载 + 3 张贴图） | 452–517 ms 一次性，单帧渲染 ≤ 0.5 ms（每帧最多处理 2 个面） |
| full 静止 1.2s | 引擎 render 增量 **0** |
| full 滚动 | p50 16.7 / p95 16.7–16.8 ms（与基线一致） |
| 指针扫过胶囊 40 次 | render **0**、贴图 **0**（只更新高光参数） |
| 命令面板首次打开 | 贴图 +1、render +2（一次性成本，之后复用） |

口径提醒：headless 是软件合成，绝对帧时间只作下限；**判据是「静止与交互期间
引擎渲染次数不增长」**，以及同一进程内的基线对比。

## 5. 已知边界

- **平滑背景上折射看不见**：位移 2px 在缓慢渐变上取到的颜色几乎一样。
  这不是 bug——真机上要看出折射，玻璃背后必须有高频内容（滚动中的卡片、图片、
  网格）。验收因此按设计文档要求换成网格背景来量。
- **`backdrop-filter` 会抹平折射**：同一张位移图叠 `blur(26px)` 后差异归零。
  所以 WebGL 后端接管背景时会关掉玻璃面自己的 `backdrop-filter`（CSS 只留
  tint/描边/轮廓高光），否则等于「两层玻璃」互相抵消。
- **首帧成本**：一张贴图的 PNG 编码是几十 ms 级。引擎按每帧 2 个面渐进生成，
  把一次卡顿摊成几帧；面板在完全可见之前不生成（IntersectionObserver）。
- **真机未测**：GPU 下的真实帧率、高 DPI 细腻度、多显示器仍需在真机 Electron 里补测。
