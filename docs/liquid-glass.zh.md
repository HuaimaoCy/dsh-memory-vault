# Liquid Glass 材质系统

Alaya 桌面壳的材质层规范：玻璃用在哪、令牌怎么改、三档品质如何退化、哪些坑不要再踩。
布局与尺寸的约定在 `docs/workspace-layout.zh.md`，颜色、层级与动效的既有约定在 `docs/design.zh.md`；本文只负责材质。

> **取值在哪**：令牌名、`data-*` 属性、模块导出名是稳定契约；具体数值只在
> `desktop/renderer/glass.css` 的 `:root` 与 `html[data-glass-tier="…"]` 块里定义一次。
> 本文表格与 `glass.css` / `glass.js` / `glass-refraction.js` / `tests/glass-smoke.mjs` 逐项核对过：
> 改代码要顺手改表，冲突时以源码为准。

| 层面 | 约束的一句话 | 章节 |
| --- | --- | --- |
| 视觉 | 半透明、背景模糊、边缘高光；打磨边缘而不是中间 | §2 §3 |
| 交互 | 弹簧回弹、悬停抬升、从触发点展开；功能先于动效 | §5 |
| 布局 | 玻璃只覆盖导航与控件，内容永远实心 | §1 §3 |
| 工程 | 只走 GPU 合成、分级回退、有性能预算与无障碍出口 | §4 §6 §9 |

## 1. 为什么这么做

玻璃不是背景装饰，而是**界面层的标记**。四条判断决定了后面所有参数：

**玻璃是界面层，不是背景装饰。** 它标出「这块可以操作」和「这里浮在内容之上」。所以只有导航（顶栏、侧栏）、控件（按钮、分段、搜索框）与浮层（对话框、菜单、命令面板）用玻璃；记忆卡片、笔记正文、表格、图片、画布保持实心。文字压在模糊背景上只能靠加深 tint 换回可读性，等于把玻璃退化成半透明色块，收益为零，代价是每次滚动重新采样一次背景。

**边缘比内部有辨识度。** 人眼认玻璃靠的是边缘的斜面高光、1px 描边和（高档位的）色散，不是中间那点模糊。所以打磨重点是 `--glass-bevel-*`、`--glass-rim`、`--glass-hairline`；中间的 `--glass-blur` 只负责把背景推到后面，超过一定半径后继续加只会让背景变成色块，成本线性上升。

**材质随背景变化，文字不随。** 背景模糊 + tint 让材质适应底下的颜色，但文字颜色固定用 `--fg` / `--fg-2`，不为某一处背景单独调暗调亮。材质层必须自己保证最坏情况下的对比度（§6），不是让内容替它让步。

**功能先于动效。** 一天开几十次的界面（命令面板）不做入场动画；拖动中不加事后补间；减少动态效果时先砍位移，保留反馈（§5.5）。

导航与控件是浮在内容之上的两层，浮层再在它们之上。层级用材质差异表达——表面越「高」，材质越亮、投影越深、模糊越重——不额外加边框、图标或分割线来提示层级。

## 2. 令牌

全部令牌定义在 `desktop/renderer/glass.css` 的 `:root`，分级覆写在 `html[data-glass-tier="full|balanced|flat"]` 下。改一个令牌会影响什么，比它的具体取值更重要。

| 令牌 | 语义 | balanced 默认 | 分级覆写 | 改它会影响什么 |
| --- | --- | --- | --- | --- |
| `--glass-blur` | 背景模糊半径 | `20px` | full `26px`、flat `0`、control `8px`、hud `14px` | 面的「厚度」。越大越看不清底下内容，也越贵；面积大的面先到收益饱和点 |
| `--glass-saturate` | 背景饱和度 | `175%` | full `185%`、flat `100%` | 玻璃后面的颜色会不会被洗灰。过高时浅色背景会把白字推成荧光 |
| `--glass-brightness` | 背景亮度补偿 | `1.02` | flat `1` | 把背景往白里推。暗色主题下最容易糊掉文字，优先调它而不是加深 tint |
| `--glass-tint` | 面底色（主） | `rgb(255 255 255 / .60)` | full `.56`、flat 近实心 | 最坏情况下文字对比的兜底，AA 达标主要靠它 |
| `--glass-tint-strong` | 更强的底色 | `.80` | flat `.99` | 浮层与模态用；不透明度更高，模糊可以相应降低 |
| `--glass-tint-soft` | 更弱的底色 | `.46` | flat `.96` | hud 胶囊用；用在浮层上会让层级塌掉 |
| `--glass-tint-solid` | flat 档的实心底色 | `rgb(252 253 255 / .97)` | flat 的 `--glass-tint` 直接指向它 | 改它等于改「没有玻璃时」的界面外观，flat 档的可读性由它决定 |
| `--glass-hairline` | 面的浅色 1px 描边 | `rgb(255 255 255 / .62)` | flat 转深 `rgb(20 26 38 / .10)`、提高对比 `.35` | 面与背景的分界。flat 档没有模糊，去掉它就认不出边界 |
| `--glass-edge-line` | 面的深色分隔线 | `rgb(20 26 38 / .07)` | 提高对比 `.35` | chrome / panel / 控件用它画 `border-color`；与 hairline 一暗一亮，一个给深底一个给浅底 |
| `--glass-bevel-top` | 内斜面，上 | `rgb(255 255 255 / .88)` | flat `transparent` | 顶部高光，模拟光从上方来；与 bevel-bottom 成对改，反了会像凹陷的按钮 |
| `--glass-bevel-bottom` | 内斜面，下 | `rgb(20 26 38 / .05)` | flat `transparent` | 底部反射；单用会显得面在发光而不是有厚度 |
| `--glass-shadow` | chrome 投影 | 两层（近影 + 远影） | flat 略收 | 只用来抬层级。加大会让侧栏像浮窗，挤占内容的视觉重心 |
| `--glass-shadow-float` | 浮层投影 | 两层，比 chrome 更深 | flat 略收 | 浮层与 chrome 的差距主要靠它，不是靠更高的模糊 |
| `--glass-radius-chrome` | 大面圆角 | `0px` | — | 侧栏与顶栏贴边，圆角为 0；改成非 0 必须同时确认贴边一侧的描边 |
| `--glass-radius-panel` | 侧板圆角 | `0px` | — | 同上；侧板贴边，圆角只可能在一侧出现 |
| `--glass-radius-float` | 浮层圆角 | `16px` | — | 必须与浮层自身 `border-radius` 一致，否则高光层会露到圆角外 |
| `--glass-radius-control` | 控件圆角 | `8px` | — | 同上；与 `.btn` / `.icon-button` 的实际圆角同步 |
| `--glass-radius-hud` | 状态胶囊圆角 | `12px` | — | 只给 `hud` 用；改小会从胶囊退化成圆角矩形 |
| `--glass-rim` | 边缘镜面高光 | `rgb(255 255 255 / .70)` | full 直接指向 `--glass-rim-strong` | 强度的基线。它砍到看不见时玻璃就只剩模糊 |
| `--glass-rim-strong` | 高光尖峰 | `.92` | — | full 档的 `--glass-rim` 引用它；单独调它只影响 full |
| `--glass-fringe-warm` / `--glass-fringe-cool` | full 档冷暖各一条 1px 内描边 | `.55` / `.55` | 只有 full 的 chrome 与 float 用 | 色散的全部实现；balanced 不参与，所以关掉它等于降到 balanced 的边缘观感 |
| `--glass-glare` | 指针光源最大强度 | `.55` | flat `0`、提高对比 `0` | 与引擎写的 `--glass-glare-o` 相乘才是实际亮度。上限固定，指针挪到边角不会过曝 |
| `--glass-duration` | 材质过渡时长 | `180ms` | — | 只用于颜色、描边、投影的过渡，不用于位移 |
| `--glass-spring` | 材质过渡曲线 | `var(--spring, cubic-bezier(.22,1,.32,1))` | — | 与既有 `--spring` 同源；减少动态效果时整个 transition 被关掉（§5.4） |

引擎写、材质只消费的实时变量（**不要在 `glass.css` 的 `:root` 里定义它们**）：

| 变量 | 含义 | 写入时机 | 用法 |
| --- | --- | --- | --- |
| `--glass-glare-x` / `--glass-glare-y` | 指针在面内的归一化坐标 `0–1`，四位小数 | 指针移动（按 rAF 合并） | 驱动径向渐变的位置；越界坐标被夹在 `0–1` |
| `--glass-glare-o` | 光源不透明度 `0–1`，三位小数 | 进入面升到 1，离开用弹簧回落到 0 | 材质侧一律写 `var(--glass-glare-o, 0)` 兜底 |
| `--glass-rim-angle` | 边缘高光角度，一位小数的 `deg` | 与坐标同批写入 | `0deg` 指正上方，顺时针增大，与 `conic-gradient` 一致 |
| `--glass-press` | 按压态 `0` 或 `1` | 指针按下 / 抬起 | 驱动形变幅度，不承载颜色变化 |
| `--glass-w` / `--glass-h` | 面的整数内容尺寸（px） | `ResizeObserver` 尺寸变化时 | 需要按尺寸算比例的地方（如色散贴图、渐变半径） |
| `--glass-refraction-filter` | `url(#…)` 形式的位移滤镜 | 仅实验模块 `glass-refraction.js` 开启时 | 默认不存在；材质要写 `var(--glass-refraction-filter, none)` |

## 3. 五类表面

引擎按选择器给已有节点打标（不改 HTML 结构），并用 `MutationObserver` 把动态创建的浮层也纳入。
`GLASS_SURFACES` 的**顺序即优先级**：一个节点同时命中多条时先出现的赢，所以 `.bar` 里的 `.btn` 是控件，`.bar` 自己是 chrome。

| `data-glass-surface` | 打标选择器（源码 `GLASS_SURFACES`） | 用在哪 | 参数差异 |
| --- | --- | --- | --- |
| `control` | `.nav` `.btn` `.icon-button` `.segment` `.search-wrap` `.brand-mark` `.ws-segment` `.ws-preset` `.qc-mode` | 可点击 / 可输入的控件 | 最低模糊、边缘高光为主、按压形变；不投外部投影，层次靠 inset 高光 |
| `hud` | `#status` `.loading-status` | 状态提示、加载条 | 最轻的胶囊：`--glass-tint-strong`→`--glass-tint-soft` 渐变、`--glass-radius-hud`、只投 chrome 级投影 |
| `float` | `.command-palette` `.quick-capture` `.qc-panel` `.curation-popover` `.ws-panel` `.alaya-preview` `.mb-dialog` `dialog` | 菜单、布局面板、命令面板、捕获浮层、模态 | 更强模糊 + `--glass-tint-strong` + `--glass-shadow-float`，入场走弹簧（§5.3） |
| `panel` | `.drawer` `.mb-detail` `.mb-ai-side` | 详情抽屉、编辑侧板、AI 侧栏 | 与 chrome 同档模糊，高光带方向性（贴边一侧更强），`--glass-radius-panel` |
| `chrome` | `.side` `.bar` `.mb-side` `.mb-bar` | 顶栏、侧栏 | 中等模糊 + 弱色散，内斜面，`--glass-radius-chrome`，只投 chrome 级投影 |

**内容层不是玻璃**（这份清单比上面那张表更重要）：记忆卡片、列表行、笔记正文、表格、看板列、图片与画布。它们一律实心，套上玻璃等于用可读性换装饰。

两处刻意的例外，别「顺手统一」：

- 主操作按钮 `.btn.primary` 不玻璃化：它靠实色区分层级，玻璃只给它一层顶部高光。
- `.nav` 只有选中态（`.nav.on`）是彩色玻璃；其余导航项保持透明，否则侧栏会变成一排胶囊。

四条规则：

1. **新组件先选 surface，选不出来就别用玻璃。** 选不出来通常说明它是内容层。
2. **一块面只属于一个 surface，不叠加。** 两层玻璃会让同一块背景被采样两次：观感浑浊，成本翻倍。
3. **大面跟着亮。** 指针停在控件上时，它所属的 chrome / panel / float 容器同时被点亮（`LARGE_KINDS`），否则侧栏的光源会「卡住」在原地。
4. **材质层不改几何。** 只加视觉属性（颜色、模糊、描边、投影、变换），不动宽度、内边距、行高与可点击区域——桌面测试对这些有几何断言（§10）。

**实现约束**（`glass.css` 里的三个刻意取舍，动材质前先读）：

1. 高光不用 `::before` / `::after`：`.side` / `.bar` / `.status` 都是 flex 容器，伪元素会变成额外的 flex 项，直接改布局。光源与斜面全部走同一张多层 `background-image` 与 inset 阴影。
2. 不给 `.side` / `.bar` 加 `position: relative`：侧栏里有绝对定位的浮层菜单（`.mb-side-bottom .ws-panel`），加定位上下文会把锚点挪走。
3. `flat` 不是「少一点玻璃」，而是实心回退：撤掉 `backdrop-filter`，靠 tint 与 hairline 维持层级，保证高对比与关闭透明度时仍然可读可点。

## 4. 三档品质

判定写在 `resolveTier()` 里，纯函数，`tests/glass-smoke.mjs` 直接覆盖。顺序固定，前一条永远压过后一条：

1. `forced-colors: active` → `flat`。系统级接管，连用户显式选择都要让位，且**不写回**偏好。
2. 用户显式选择（`setGlassTier`，校验必须属于 `GLASS_TIERS`）→ 该档。
3. `prefers-reduced-transparency: reduce` 或 `prefers-contrast: more` → `flat`。
4. 能力探测 `backdropFilter === false` → `flat`。
5. `hardwareConcurrency` 为 1 或 2 → `flat`。
6. 其余 → `balanced`。

注意第 6 条：**full 不会被自动选中**，只能由用户显式打开。边缘色散目前只在 lab 里验证过，把不确定的档位设成默认，等于让最没把握的渲染路径承担日常观感。

| 档 | backdrop-filter | 边缘 | 层级表达 | 何时出现 |
| --- | --- | --- | --- | --- |
| `full` | `blur(26px) saturate(185%) brightness(1.02)` | 斜面 + 镜面高光 + 冷暖两条 1px 色散 | 投影 + 色散 | 用户显式选择 |
| `balanced` | `blur(20px) saturate(175%) brightness(1.02)` | 斜面 + 镜面高光，无色散 | 投影 | 默认，也是能力足够时的唯一自动档 |
| `flat` | 无（`--glass-blur: 0`，且整条 `backdrop-filter` 不写） | 实心底色 + 深色 hairline | 纯色差 | 强制色、减少透明度、提高对比度、无 `backdrop-filter`、双核 CPU |

用户选择存在 `localStorage` 的 `alaya.glass`（`mountGlass` 的 `storageKey` 参数可改），存的是**请求值**而不是解析结果，这样系统偏好恢复后能回到用户原来选的那档。每次定档会在 `<html>` 上派发 `glass:tier` 事件，`detail` 里带档位与能力快照；系统偏好变化时引擎会重新判定，不需要刷新页面。

往下降一档时必须保住四件事：

1. **几何不变**：切档不改任何尺寸与位置，三档截图可以直接叠起来比对排版。
2. **层级不变**：chrome 与 float 在 flat 下仍靠明度差区分，不会变成两块一模一样的面。
3. **对比不变或更好**：flat 一定更不透明，不会因为关掉模糊而变淡。
4. **反馈不变**：按下仍有颜色与描边变化；即使形变被减少动态效果取消，反馈本身不消失。

## 5. 交互与动效

### 5.1 指针光源

引擎在指针进入面时写 `--glass-glare-x/y` 与 `--glass-rim-angle`，把 `--glass-glare-o` 弹簧升到 `1`；离开时用同一个弹簧回落到 `0`（`response 0.34`、`damping 1`，来自 `springValue`）。高光不会瞬间归零——那样光源会「跳」。

- 只在 `(hover: hover) and (pointer: fine)` 且未开启减少动态效果时装配监听；触屏没有指针光源。
- 指针移动按 rAF 合并，一帧只算一次包围盒；窗口失焦与 `pointerleave` 时所有高光一起回落。
- 材质侧所有光源取值都要有兜底：`var(--glass-glare-o, 0)`，避免引擎未挂载时出现一个固定在中央的亮斑。
- 光源是「弱」的：亮度由 `--glass-glare` 封顶，指针位置只改梯度位置，不改总面积。

### 5.2 按压回弹

指针按下时引擎给最近的 `[data-glass-surface]` 加 `data-glass-pressed` 并把 `--glass-press` 置 `1`，抬起或取消时统一释放。形变幅度沿用既有约定（`.985`，见 `desktop/renderer/styles.css` 的 `:active` 规则），曲线走 `springValue`。参数沿用 Apple 的两个量：`damping`（过冲）与 `response`（多快到位，不是时长），实现见 `desktop/renderer/motion.js`。

| 场景 | 参数 | 出处 |
| --- | --- | --- |
| 控件按下 | `scale(.985)`，`damping 1`，`response` 以 `glass.css` 为准 | `styles.css` 既有 `:active` 幅度 + `motion.js` 弹簧 |
| 弹簧默认 | `from 0`、`to 1`、`velocity 0`、`damping 1`、`response 0.35` | `motion.js` 的 `springValue` 默认值 |
| 指针光源淡入淡出 | `response 0.34`、`damping 1` | `glass.js` 的 `setGlare` |
| 详情抽屉入场 | `distance 0`（纯淡入）、`response 0.3`、`damping 1` | `motion.js` 的 `enterPanel` |
| 模态入场 | `scale 0.985`、`response 0.28`、`damping 1` | `motion.js` 的 `enterDialog` |

反馈分层，不要混用：

| 状态 | 表达 | 禁止 |
| --- | --- | --- |
| 悬停 | 抬升 1px 或 `--glass-glare-o` 上浮 | 抬超过 2px（源码注释：会和行高打架）、改投影尺寸 |
| 按下 | `.985` 形变 + 描边加深 | 改变尺寸或内边距 |
| 焦点 | 2px accent 焦点环，与材质无关 | 用材质变化代替焦点环 |
| 禁用 | 降不透明度 | 移除描边（会让控件消失） |

### 5.3 浮层入场

材质与内容同步入场，不是先出背景再填内容：浮层从触发点附近展开（`transform-origin` 指向触发点），`transform` 与 `opacity` 同时到位。既有实现是 CSS `alaya-materialize`（`.26s` + `--spring`，从 `scale(.97) translateY(-2px)` 长出来），玻璃层不要另加一套入场——两套曲线叠在一起会看起来像掉帧。

### 5.4 减少动态效果

`prefers-reduced-motion: reduce` 下：

- 材质自己的 `transition` 整条关掉（`glass.css` 里 `[data-glass-surface]` 与各控件的 `transition: none`），悬停/按下的 `transform` 归零；颜色与描边仍随状态切换，只是瞬时；
- 既有菜单入场从位移退化为短淡入（`.18s ease`，见 `styles.css` 的 `alaya-fade`）；
- 指针光源与按压监听根本不装配（`glass.js` 在 `reducedMotion` 为真时跳过），不是装配后再关；
- 弹簧不启动：`springValue` 在减少动态效果时直接落到目标值，材质层不需要再判断一次。

### 5.5 什么时候不该动

- **命令面板**：一天开几十次，出现必须瞬时。这条写在 `desktop/renderer/command-palette.js` 顶部，材质不得覆盖。
- **键盘重复触发的操作**：方向键移动选择、Tab 切换不产生形变，否则连按 20 次像在抽搐。
- **拖动过程中**：分隔条、画布卡片拖动时不加「事后补间」，材质只跟随指针本身；松手才允许弹簧收尾。
- **贴边的全高面板**：只淡入不位移（`distance: 0`），一旦位移就会探出窗口，`desktop-layout` 会断言这一点。
- **窗口不在前台时**：不跑任何循环。`rAF` 在窗口 blur 后自然停，不要用 `setInterval` 补帧；引擎也会在 blur 时把光源全部回落。

## 6. 无障碍与对比度

- **对比度目标**：正常字号文字与背景 ≥ `4.5:1`（WCAG AA），大字与图标 ≥ `3:1`。验收对象是**最坏背景**（纯白、纯黑、高饱和图片），不是「实际背景一般都很淡」。
- **必须有不透明回退**：每个玻璃控件都要有一个可用的实心形态，`flat` 档就是它。说不清「这个控件在 flat 下长什么样」的设计，不算做完。
- **系统偏好（三层保险，不是只靠挡位）**：

  | 偏好 | 实际行为 |
  | --- | --- |
  | `prefers-reduced-transparency: reduce` | 引擎定档 `flat`，整条 `backdrop-filter` 不写，底色回落实心 |
  | `prefers-contrast: more` | 独立于档位再上一道：tint 抬到近实心（`.96` / `.99`）、`--glass-hairline` 与 `--glass-edge-line` 加深到 `.35`、`--glass-glare: 0`、`backdrop-filter: none` |
  | `forced-colors: active` | 走 flat 且交出着色：`background-color: Canvas`、`border: 1px solid CanvasText`、`box-shadow: none`；选中态用 `Highlight` / `HighlightText` |

- **焦点可见性不受材质影响**：焦点环是 2px accent（60%）+ 2px offset，画在玻璃之上，不因模糊、变换或光源而变淡。玻璃层不得给 `:focus-visible` 元素加 `opacity` / `filter`。
- **装饰不入无障碍树**：承载光源与斜面的伪元素、包装层不承载信息，不参与 tab 顺序；玻璃不改变可点击区域大小，也不改变 DOM 顺序。
- **档位可降低，不可隐藏**：用户无法关闭材质时，`flat` 就是关闭材质——它必须仍然可读、可点、层级清楚。

## 7. 已知限制与不做的部分

### 7.1 `backdrop-filter: url(#svg)`：能用但不稳定

实测（`test-tmp/glass-probe/`，headless Chromium）：

| 症状 | 现象 |
| --- | --- |
| 解析与能力检测 | `CSS.supports('backdrop-filter', 'url(#a)')` 返回 `true`，背景确实被位移——**所以 `CSS.supports()` 不能当闸门** |
| 圆角裁剪失效 | 位移后的背景越过 `border-radius` 圆角，四个角出现方角与毛边；`overflow:hidden`、`mask-image` 都兜不住（`probe4.png` 的 A/B/C 三种圆角方案全部失败，E 的纯 `blur()` 正常） |
| 边缘接缝 | 位移贴图在面边缘取样越界，形成可见的直线接缝与撕裂（`probe3-crop.png` 是放大图）；F 只开 `url()` 时背景被撕成弧形色块 |
| 几何不稳定 | 同一张贴图在不同尺寸的面里位移量不一致，必须按尺寸重建贴图（canvas → `data:URI`），成本随面积线性增长 |
| `feImage` 外部引用 | `file://` 与打包后的相对路径都不可靠；**只认 `data:` URI**（canvas → `toDataURL`） |

结论：默认档位用 `backdrop-filter` 的滤镜函数（`blur` / `saturate` / `brightness`）+ 斜面与高光层表达厚度。`url()` 只留在实验模块 `desktop/renderer/glass-refraction.js`：

| 实验模块的行为 | 说明 |
| --- | --- |
| 开关 | `enableRefraction(root, { band, scale, maxFilters })` / `disableRefraction(root)`，默认关闭 |
| 资源上限 | 尺寸按 16px 取整分桶、最多 8 张过滤器、小于 17px 的面跳过 |
| 标记 | 开启后 `html[data-glass-refraction="on"]`，受影响的节点带 `data-glass-refraction` 与 `--glass-refraction-filter` |
| 贴图几何 | `rimNormalAt` / `createRimMap` 是纯函数，中心 `128`（不位移），越靠边位移越强，中途在 `band` 内衰减 |

它只服务 lab 对照，不进入分级判定，也不出现在发布默认里。

### 7.2 不开 Mica、不做无边框窗口

- Mica 由窗口合成器画在窗口底层，而 `body` 全程有不透明底色，材质只会被遮住，白付一层合成成本。
- 无边框窗口会牵动 Snap Layouts、拖拽区、缩放热区，以及 20+ 桌面测试里的窗口几何断言；收益只有四角圆润，代价是整条窗口链路。

### 7.3 不做内容复制式折射

把内容 DOM 克隆一份、按位移贴图重绘，看起来能做出真实折射，实际上每帧都要读布局并重绘文字，与滚动强耦合，文本还会被替换成不可读的贴图。收益只在强色散档位可见，成本与可访问性代价都不划算。

### 7.4 其他已知限制

- **两层玻璃不要叠**：`backdrop-filter` 嵌套会让同一背景被采样两次，观感浑浊、成本翻倍。浮层盖在 chrome 上时，浮层用更不透明的 tint。
- **hud 目前只有两处打标**：`#status` 与 `.loading-status`，轻提示尚未单独成面，不要假设它已有玻璃。
- **数据域隔离**：材质偏好不写进数据库 `meta` 表，只落本机 `localStorage`；换数据库不改变界面材质。
- **后台恢复的首帧**：窗口最小化再恢复，合成器可能给出一帧旧的模糊结果；不要为此加补间或强制重绘。
- **截图工具**：headless 预览以 `--force-device-scale-factor=1` 运行，高 DPI 下的观感必须在 Electron 里看，不要用 1x 截图判断细腻度。
- **高光用多层 `background` 而不是伪元素**：`.side` / `.bar` / `.status` 都是 flex 容器，`::before` / `::after` 会变成额外的 flex 项，直接改布局；给它们加 `position: relative` 又会把 `.mb-side-bottom .ws-panel` 这类绝对定位浮层的锚点挪走。所以斜面、指针高光、方向光全部落在同一张 `background-image` 与 inset 阴影上。代价是不能做「只在边框上旋转」的高光——需要那种效果时再单独引入包裹层。
- **白底上的指针光源几乎看不见**：高光是白色径向渐变，落在白色侧栏/卡片上没有对比。这是观感事实，不是 bug；有颜色的背景（lab 页、深色图片、浮层下方的内容）才看得到。`--glass-rim-angle` 供浮层的方向光使用，因此浮层（命令面板、布局菜单）上的光源是可感知的。

### 7.5 内容从顶栏底下穿过（布局层的唯一改动）

材质只有在「背后真的有东西在动」时才成立，因此顶栏从「与内容各占一条」改成「浮在滚动内容之上」：

| 改动 | 位置 | 为什么几何不变 |
| --- | --- | --- |
| `.body` 上提 `--glass-bar-h`（73px） | `glass.css` | `.bar` 仍留在流里占同高；`.main` 补回同样的 `padding-top`，未滚动时内容位置逐像素一致 |
| `.bar` 抬 `z-index` | `glass.css` | 只决定绘制顺序，不参与布局 |
| 笔记本侧同构（`--glass-mb-bar-h` 76px） | `glass.css` | 同上 |

`tests/preview-glass.mjs` 会在切档时比对 `.side/.bar/.main/.board-toolbar/.tile` 的矩形，任何布局位移都会让它红。要退回原来的停靠布局，删掉 `glass.css` 里「布局层」一节的 6 条规则即可，其余材质不受影响。

## 8. 集成点

**样式表**：`glass.css` 放在层叠最后一行，确保赢得与既有 `styles.css` 的模糊规则之争。

```html
<html lang="zh-CN" data-glass-tier="balanced">
<link rel="stylesheet" href="views.css" />
<link rel="stylesheet" href="glass.css" />
```

**挂载**（`desktop/renderer/app.js`）：模块初始化时调用一次，早于首次渲染；`mountGlass` 幂等，重复调用返回同一实例。

```js
import { mountGlass, glassCapabilities, setGlassTier } from './glass.js'

const glass = mountGlass({ tier: 'balanced' })   // 扫描、打标、定档
```

玻璃是增强而不是依赖：无 DOM 环境（Node 测试）下引擎返回 `flat` 的空实现而不是抛错。挂载点因此可以留在模块顶层——但以后在它周围加逻辑时，任何异常都要吞掉，不能让材质故障变成白屏。

| 导出 / 方法 | 签名 | 作用 |
| --- | --- | --- |
| `mountGlass` | `mountGlass({ root, tier, storageKey })` | `storageKey` 默认 `alaya.glass`；无 DOM 环境（Node）返回一个 `flat` 的空实现而不是报错 |
| `glassCapabilities` | `() => object` | 能力快照，字段见下表 |
| `setGlassTier` | `(tier) => tier` | 用户显式切档并持久化；未挂载时返回 `flat` |
| `resolveTier` | `({ requested, capabilities }) => tier` | 纯函数，分级判定的唯一实现 |
| `glareFor` | `({ width, height, x, y }) => { gx, gy, angle }` | 指针归一化坐标与角度，纯函数 |
| `GLASS_TIERS` / `GLASS_SURFACES` | 冻结数组 | 档位与表面表，改它们等于改契约 |

实例方法（`mountGlass()` 的返回值，同时挂在 `window.alayaGlass` 上便于调试与冒烟测试）：

| 方法 | 返回 | 用途 |
| --- | --- | --- |
| `tier()` | `'full' \| 'balanced' \| 'flat'` | 当前生效档位（不是请求值） |
| `capabilities()` | 能力快照 | 排查「为什么降到 flat」 |
| `setTier(tier)` | 生效档位 | 等价于 `setGlassTier` |
| `refresh()` | `void` | 重扫动态节点并补订阅尺寸 |
| `surfaces()` | `[{ node, kind, size, glare }]` | 冒烟测试据此断言打标结果与光源状态 |
| `destroy()` | `void` | 解绑监听、清除标记与引擎写的变量（测试、热重载用） |

能力快照（`glassCapabilities()`）：

| 字段 | 含义 |
| --- | --- |
| `backdropFilter` | 是否支持 `backdrop-filter: blur()`（含 `-webkit-` 前缀） |
| `backdropFilterUrl` | 是否「声称」支持 `url()`；如 §7.1，它不足以作为闸门 |
| `reducedMotion` / `reducedTransparency` / `contrastMore` | 三个系统偏好 |
| `forcedColors` | 强制色模式，优先级最高 |
| `finePointer` | `(hover: hover) and (pointer: fine)`，决定是否装配指针光源 |
| `hardwareConcurrency` | 逻辑核数，`≤ 2` 直接 flat |

**引擎写入的标记**：

| 属性 | 取值 | 谁读 |
| --- | --- | --- |
| `data-glass-surface` | `chrome` / `panel` / `float` / `hud` / `control` | 材质侧全部选择器 |
| `data-glass-tier` | `full` / `balanced` / `flat`（挂在 `<html>` 上） | 分级覆写块 |
| `data-glass-pressed` | 存在即按压态 | 形变 |
| `data-glass-entering` | 入场期间存在 | 入场动画的起点 |

实时变量见 §2 末尾那张表。材质侧只消费，不定义、不重置。

## 9. 性能预算

目标是 60 FPS（每帧 16.7ms）在这些场景下不掉帧：滚动记忆列表、拖拽分隔条、窗口缩放、高 DPI 多显示器。

**为什么贵**：每个玻璃面每帧都要重新采样一次背景缓冲区，成本 ≈ 面积 × 模糊半径。所以面积越大 `--glass-blur` 越保守，控件反而可以更精致——这是 §3 里各 surface 参数差异的真正原因，不是为了好看。

| 属性 | 代价 | 约束 |
| --- | --- | --- |
| `transform` / `opacity` | 只走合成，最便宜 | 所有动效只写这两个 |
| `backdrop-filter` 取值变化 | 重新采样背景 | 只在切档与入场时变一次，不逐帧插值 `--glass-blur` |
| `filter` | 整棵子树重绘 | 不用于常驻材质 |
| `box-shadow` 变化 | 重绘 | 悬停只改 `opacity` 的低成本层，不逐帧改投影 |
| `background` / `border-color` | 重绘该面 | 过渡时长用 `--glass-duration` |
| 布局属性（`width` / `height` / `top` / `left`） | 重排 | 玻璃层一律不写 |

引擎侧的开销也要记在账上：`ResizeObserver` 只在尺寸变化时写 `--glass-w/h`（不逐帧）；`MutationObserver` 只观察 `body` 的 `childList`，新节点进来才扫描，扫描是 `querySelectorAll('*')` 的一次遍历——大列表批量插入时要求先在文档片段里拼好再插。

**分级阈值建议**（可调，先在真机采样再定值）：连续采样里 rAF 间隔 p95 > 20ms，或掉帧超过 10%，就降一档（`full → balanced → flat`）；一次会话只降不升，避免在阈值附近来回抖。升级只由用户显式操作或重开窗口触发。

**怎么测**（复用 `tests/preview-cdp.mjs` 的 `evaluate` 采样 rAF 间隔）：

```js
const frame = await session.evaluate(`(async () => {
  const gaps = []; let last = performance.now(); let n = 0
  await new Promise(done => {
    const tick = now => { gaps.push(now - last); last = now; if (++n < 180) requestAnimationFrame(tick); else done() }
    requestAnimationFrame(tick)
  })
  gaps.sort((a, b) => a - b)
  return { median: gaps[gaps.length >> 1], p95: gaps[Math.floor(gaps.length * 0.95)] }
})()`)
```

注意：`preview-cdp.mjs` 用 `--disable-gpu` 启动 Chromium，预览里的帧率是软件合成的下限，只能做**相对比较**（有玻璃 vs 关玻璃），真机帧率必须在 Electron 里测。

## 10. 验证与回归

两条命令就是验收主线：

```powershell
Push-Location work\mistake-notebook-addon
node --no-warnings tests/glass-smoke.mjs    # 规则（Node，秒级）
node tests/preview-glass.mjs                # 观感（headless Chromium，出图 + 断言）
Pop-Location
```

`glass-smoke.mjs` 守「名字与规则」而不是渲染：表面表覆盖五类面且契约选择器一个不少、分级优先级不变、指针角度定义不变、Node 环境下安全降级为 flat、位移贴图几何（中心中性、边缘有向、通道合法）。

`preview-glass.mjs` 在真实渲染层上跑三轮页面（数据库默认 / 笔记本 / 减少动态效果），把 5–6 张截图写到 `test-tmp/preview/glass/`（`--out` 可改），并断言：

| 断言 | 守的是什么 |
| --- | --- |
| 表面数量与 chrome / control / float 都非空，`window.alayaGlass` 存在 | 引擎真的挂上了，动态浮层被 `MutationObserver` 纳入 |
| 合成 `pointermove` 后 `--glass-glare-x/y/o` 与 `--glass-rim-angle` 有值 | 指针光源链路通（无细指针的设备会跳过这项） |
| 切 `full` / `flat` 后各元素的 `getBoundingClientRect` 逐项相同 | 材质层只加视觉属性，不动几何 |
| `flat` 档下 `.side` 的 `backdrop-filter` 计算值是 `none` | flat 不是只改了个属性，模糊真的撤掉了 |
| 笔记本模式也有 chrome / panel 标记 | 第二张界面同样覆盖 |
| 减少动态效果下 `reducedMotion` 为 true | 光源与按压按偏好不装配；注意 `finePointer` 描述的是设备，不随动效偏好变 |

**已知的脚本口径问题**：`tests/preview-glass.mjs` 在减少动态效果那一步断言 `capabilities().finePointer === false`，这条会误报失败——`finePointer` 是设备能力（`(hover: hover) and (pointer: fine)`），不会因为减少动态效果变 false；引擎是在装配监听时同时看 `finePointer` 与 `reducedMotion` 两个条件。要断言的是「`reducedMotion === true` 且派发 `pointermove` 后 `--glass-glare-o` 仍为空或 0」。

lab 页（`desktop/renderer/glass-lab.html`）存在时脚本会一并截图；缺失只打印 skip，不算失败。手动看参数时也可以 `node tests/preview-app.mjs --serve` 起服务后在浏览器打开它。

单张截图（调试某个状态时用）：

```powershell
node tests/preview-app.mjs --shot test-tmp/preview/glass-db.png
node tests/preview-app.mjs --shot test-tmp/preview/glass-db-dark.png --dark
node tests/preview-app.mjs --shot test-tmp/preview/glass-mb.png --mode mistakebook
node tests/preview-app.mjs --shot test-tmp/preview/glass-reduced.png --reduced-motion
```

页内速查（用 `--eval`，失败即视为材质没挂上）：

```powershell
node tests/preview-app.mjs --eval "JSON.stringify({ surfaces: window.alayaGlass.surfaces().length, kinds: [...new Set(window.alayaGlass.surfaces().map(s => s.kind))], tier: window.alayaGlass.tier(), attr: document.documentElement.dataset.glassTier })" --wait-ms 300
```

应当看到五类面都出现、`tier` 与 `<html data-glass-tier>` 一致；`surfaces` 的数量随当前视图与打开的浮层变化，**不要把它写成固定数字**（默认预览里是两位数）。

**截图必须能说明的四件事**：

1. 三档只变材质、不变几何——把三张图叠起来，排版应当逐像素对齐。
2. 亮/暗系统设置下都不退化成黑块。
3. 减少动态效果下没有位移痕迹，但反馈仍在。
4. flat 档仍能区分 chrome 与 float 两层。

**改了材质要重跑的桌面测试**：

```powershell
node test-tmp/probe.mjs desktop-design=design-test desktop-ui desktop-layout desktop-notebook desktop-images=images-test
node --no-warnings tests/run-desktop-views.mjs
node --no-warnings tests/run-desktop-canvas.mjs
node --no-warnings tests/run-desktop-palette.mjs
node --no-warnings tests/run-desktop-capture-app.mjs
node tests/run-desktop-workspace-layout.mjs
```

`desktop-layout` 会断言 1440×940 与 1040×650 下没有控件被推出窗口；`desktop-design` 会看材质与层级。材质层只加视觉属性，这两条是它能通过的底线。

## 11. 实施阶段

| 阶段 | 交付 | 验收标准 |
| --- | --- | --- |
| 1 设计系统 | `glass.css` 的令牌、五类表面、三档覆写；`glass-lab.html` 参数对照页 | 三档截图与 lab 并排对照；切档前后几何零变化 |
| 2 材质引擎 | `glass.js` 打标、定档、指针光源、按压；`glass-refraction.js` 实验模块默认关闭；`tests/glass-smoke.mjs` | 冒烟测试全绿；`alayaGlass.surfaces()` 的分类与 §3 一致；`setGlassTier` 生效且持久化 |
| 3 交互动效 | 按压回弹、浮层入场、悬停抬升、减少动态效果退化 | `--reduced-motion` 截图无位移；命令面板仍然瞬时；reduce 下反馈仍在 |
| 4 性能与兼容 | 分级阈值、无 GPU 回退、`forced-colors` / `prefers-contrast` 行为 | 四个场景达到 §9 预算；flat 档与强制色截图可读；§10 清单全绿 |
