# Web 端人工检查（不用 Electron）

`tests/preview-app.mjs` 把真实的渲染层（`desktop/renderer/*`）跑在 headless/普通 Chromium 里，
只把 `window.vault`（Electron preload 暴露的那层）换成假数据。所以布局、材质、交互、键盘行为
都是**真代码**在跑，只有「窗口合成、真实 DPI、真实数据库」不在里面。

## 起服务

```powershell
cd <仓库根目录>
npm.cmd run preview
```

它默认监听 **5180**（端口被占用才退回随机），并打印四个地址：

```
Alaya 预览：http://127.0.0.1:5180/
材质实验台：http://127.0.0.1:5180/glass-lab.html
笔记本界面：http://127.0.0.1:5180/?mode=mistakebook
按 Ctrl+C 退出
```

换端口：`node tests/preview-app.mjs --serve --port 5190`。

浏览器打开这个地址即可。**服务只用起一次**，模式与档位都用 URL 参数切，不用重启。

## URL 参数与快捷键

| 用法 | 作用 |
| --- | --- |
| `/` | 数据库界面，默认液态玻璃 `full`，保留上次手选的材质 |
| `/?mode=mistakebook` | 笔记本界面 |
| `/?tier=full` / `balanced` / `flat` | 指定材质档位，会记进 `localStorage`，刷新后仍生效 |
| `/?mode=memory&tier=flat` | 组合使用 |
| `/glass-lab.html` | 材质实验台：三档并排 × 五类表面 |
| `Ctrl/⌘ + Alt + 1 / 2 / 3` | 页内切 full / balanced / flat |
| `Ctrl/⌘ + Alt + M` | 在数据库与笔记本之间切换（会 reload） |
| 控制台 `alayaGlass.setTier('full')` | 等价于上面的切档 |
| 控制台 `alayaGlass.capabilities()` | 当前能力快照（backdrop-filter、减少动态、对比度、指针设备） |
| 控制台 `alayaGlass.surfaces()` | 被标记的表面清单：类型、尺寸、当前高光强度 |
| 控制台 `alayaGlass.recheck()` | 重新判定档位（系统偏好变化后想立刻生效时用） |

数据库和笔记本的右上工具条都有「外观」入口，可选择液态玻璃、柔和磨砂、清晰实心。
不支持背景模糊或设备只有 1–2 核时退到实心；不能解析 SVG 背景滤镜时退到磨砂。
高对比、强制色和减少透明度优先于手选材质；减少动态效果保留静态折射，停止指针追光。

假数据：记忆 4 张卡片 / 8 条（含 1 条隐藏）、笔记本 4 篇（物理模型、笔记、解题方法、英语词汇）、
记忆组 4 个。数据是 `tests/preview-bridge.js` 里的常量，想加内容直接改那个文件。

## 系统偏好怎么在浏览器里模拟

DevTools → ⋮ → **More tools → Rendering** → *Emulate CSS media features*：

- `prefers-reduced-motion: reduce` → 指针光源与按压弹簧应当失效（`alayaGlass.capabilities().pointerLight === false`）
- `prefers-contrast: more` → 档位应当被压到 `flat`
- `forced-colors: active` → 同上，且表面改用系统色

`prefers-reduced-transparency` 不一定出现在面板里。那条路直接用 `?tier=flat` 看回退外观；
判定顺序本身由 `tests/glass-smoke.mjs` 的用例守着，不靠肉眼。

## 人工检查清单

Ctrl+F 在应用里是「聚焦搜索」，会占用浏览器查找；想用页面查找请先点空白处再按。

| # | 检查项 | 要点 |
| --- | --- | --- |
| 1 | 顶端结构 | 侧栏贴顶、品牌在左上；紧接一枚圆形搜索；右侧一条胶囊：视图名、布局、刷新、捕获、**新建**在最右 |
| 2 | 搜索圆 | 点击展开成输入框并自动聚焦；`Esc` 或点空白处收起；`Ctrl+F` 同样展开且光标在输入框 |
| 3 | 三档差异 | 用 `?tier=full` / `balanced` / `flat` 各开一个标签页并排比；flat 必须**完全没有**背景模糊，且布局与另外两档逐像素一致 |
| 4 | 内容穿过 chrome | 滚动列表：卡片应从胶囊与搜索圆下方经过；胶囊/侧栏的圆角外侧要能看到卡片，而不是一条不透明的白带 |
| 5 | 浮层 | `Ctrl+K` 命令面板、「布局」菜单、`+`（捕获）面板、底部状态胶囊：应是不透明感更强的浮层，投影比 chrome 深 |
| 6 | 抽屉 | 点任意一张卡片打开编辑器；抽屉也是浮起的面板，右侧有留白 |
| 7 | 折叠 / 专注 | 命令面板里执行「布局：折叠或展开侧栏」「布局：切换专注模式」：展开按钮应出现在胶囊里（`.breadcrumb` 内），不是消失在页面里 |
| 8 | 命中区域 | 侧栏每一项、胶囊里每个图标都能点；圆角外侧的空白不应挡住点击（点一下卡片边缘验证） |
| 9 | 键盘 | `Tab` 焦点环始终在玻璃之上、不被材质冲淡；`Esc` 关浮层/抽屉 |
| 10 | 缩放 | 浏览器 `Ctrl+ +` 到 110%/125%/150%，或 DevTools 设备栏设 `devicePixelRatio`：排版不破、模糊不糊成一团 |
| 11 | 暗色背景压力测试 | 控制台执行 `document.documentElement.style.background='#14181f'`：文字仍可读（顶栏在暗底下的对比度实测 ≥ 9:1） |

## 它不能替代什么

| 浏览器预览做不到 | 只能在 Electron 里看 |
| --- | --- |
| 真实窗口合成、Mica、窗口背景材质 | ✔ |
| 高 DPI 下的模糊细腻度（浏览器会自己缩放） | ✔ |
| 窗口最大化/还原、多显示器移动后的重绘 | ✔ |
| GPU 显存与真实帧率（headless 走软件合成） | ✔ |
| 真实数据库读写、迁移、更新器 | ✔ |

真机那部分仍然按 `docs/liquid-glass.zh.md` §10.1 的清单走。
