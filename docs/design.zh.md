# 界面的材质、层次与动效

这份文档记录界面的「设计层」约定：哪些表面是材质、哪些是内容，动效参数从哪来，以及在系统偏好改变时怎么退化。改界面之前先读这一节，避免又堆出一个层级。

## 1. 三层结构

| 层 | 表面 | 处理 |
| --- | --- | --- |
| 材质（chrome） | 顶栏 `.bar` / `.mb-bar`、侧栏 `.side` / `.mb-side`、品牌标 `.brand-mark` | 半透明 + `backdrop-filter: blur(24px) saturate(180%)`，一条 `--hairline` 描边，不用投影 |
| 内容 | 记忆卡片、表格、看板列、笔记卡 | 实心 `#fff`，1px `--line`，无投影 |
| 浮层 | 模态 `.modal`、命令面板、AI 整理菜单、布局面板 | 更亮的材质（`--material-float`）+ 更深投影（`--shadow-float`），模糊更重 |

规则来自 Apple 的材质层级：**结构用更重的材质，交互用更轻的材质**；两层浅色材质不能叠在一起，否则可读性塌掉。所以卡片（内容）永远是实心，只有 chrome 与浮层是半透明。

## 2. 反馈

- **按下即反馈**：`.btn` / `.icon-button` / `.nav` / `.segment` / `.tile` 在 `:active` 时 `scale(.985)`，只动 `transform`，不触发布局，120ms 收尾。
- **焦点环**：2px accent（60% 透明度）+ 2px offset，比浏览器默认的 3px 环安静。
- 键盘触发的高频 UI（命令面板）**故意不做动画**：一天要开几十次，出现必须是瞬时的。这条写在 `command-palette.js` 顶部，别改。

## 3. 动效参数

参数用 Apple 的两个：`damping`（过冲）与 `response`（多快到位，不是时长）。实现见 `desktop/renderer/motion.js`，无第三方依赖，只写 `transform` / `opacity`。

| 场景 | 参数 | 说明 |
| --- | --- | --- |
| 记忆详情抽屉入场 | `distance: 0`（纯淡入）、`response: 0.3`、`damping: 1` | 贴右边缘的全高面板一旦位移就会探出窗口，所以只淡入，几何不变 |
| 模态入场 | `scale: 0.985`、`response: 0.28`、`damping: 1` | 材质出现，不是图片淡入 |
| 菜单/弹出层 | CSS `alaya-materialize` 260ms `--spring` | 从 `scale(.97) translateY(-2px)` 长出来，`transform-origin` 指向触发点 |

弹簧永远从「当前的屏幕值」起步，因此可以被打断而不跳变；`damping < 1` 只留给手势带速度的场景（例如画布拖动），普通 UI 一律 1.0，不过冲。

## 4. 三档降级

| 偏好 | 行为 |
| --- | --- |
| `prefers-reduced-motion: reduce` | 位移与缩放全部退化为短淡入；按下的 `scale` 取消，但颜色/边框反馈保留 |
| `prefers-reduced-transparency: reduce` | chrome 与浮层变实心，`backdrop-filter` 关掉 |
| `prefers-contrast: more` | 表面转纯白，卡片/按钮/输入框描边加深到 26% 黑 |

## 5. 字体

- 字号与字距成对使用：标题越大字距越负（h1 25px / `-.3px`），正文接近 0，小型标签用 `.06em` 的正字距。
- 层级靠「字重 + 字号 + 行高」三者一起建立，不只放大字号。
- 用系统字体栈，不引第三方字体：它自带光学尺寸与平台可读性调优。

## 6. 验证

界面改动后至少跑：

```powershell
node test-tmp/probe.mjs desktop-design=design-test desktop-ui desktop-layout desktop-notebook desktop-images=images-test
node --no-warnings tests/run-desktop-views.mjs
node --no-warnings tests/run-desktop-canvas.mjs
node --no-warnings tests/run-desktop-palette.mjs
node --no-warnings tests/run-desktop-capture-app.mjs
node tests/run-desktop-workspace-layout.mjs
```

`desktop-layout` 会断言 1440×940 与 1040×650 下没有控件被推出窗口——这也是为什么贴边面板只允许淡入、不做位移。
