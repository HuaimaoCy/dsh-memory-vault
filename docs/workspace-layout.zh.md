# 工作区布局

面向「数据库」页面的布局定制：面板宽度与位置、折叠、专注、页面宽度、密度，以及可一键切换的预设。设置即时生效并记在本机，下次打开还在。

## 打开入口

- 顶栏右侧的 **布局** 按钮（带图层图标）。展开后是所有布局选项。
- 键盘：`Ctrl/⌘ K` 打开命令面板，输入「布局」有四个命令：打开布局菜单、折叠或展开侧栏、切换专注模式、恢复默认。
- 面板里的每个控件都能用 Tab 到达、空格/回车触发，`Esc` 关闭面板并把焦点交还 **布局** 按钮。有对话框打开时 `Esc` 优先交给对话框，不会被布局菜单吞掉；勾选「专注」时菜单会顺手关闭，所以进入专注后一次 `Esc` 必定退出专注。

## 可调项

| 项目 | 做法 | 效果 |
| --- | --- | --- |
| 侧栏位置 | 布局面板 → 侧栏 → 位置：左 / 右 | 整个导航区换到右边，分隔条跟着换位 |
| 侧栏宽度 | 拖动侧栏与内容之间的分隔条，或用面板里的宽度滑杆 | 170–340 px，拖动时实时跟手 |
| 折叠侧栏 | 勾选「折叠侧栏」 | 侧栏收起，顶栏工具栏出现展开按钮；笔记本在 ≤1180 px 面包屑隐藏时也始终走工具栏，不会失去恢复入口 |
| 详情面板位置 | 详情面板 → 位置：左 / 右 | 记忆编辑器换到内容左侧 |
| 详情面板宽度 | 拖动编辑器边缘的分隔条，或用滑杆 | 300–620 px；只影响打开详情时的宽度 |
| 页面宽度 | 页面：适中 / 宽 / 满 | 内容列最大宽度约 1040 / 1320 px，或铺满 |
| 密度 | 密度：舒适 / 紧凑 | 卡片网格更密、卡片更矮、内边距更小 |
| 专注 | 勾选「专注」 | 隐藏两侧面板只留内容；`Esc` 或「退出专注」按钮退出 |
| 预设 | 默认 / 紧凑 / 宽屏 / 专注 | 一次套用一组取值，预设以各自默认值为基准 |
| 恢复默认 | 面板底部「恢复默认布局」 | 所有项回到默认，并清除已保存的偏好 |

分隔条本身也是一个键盘控件：`←/→`（或 `↑/↓`）每次 12 px，按住 `Shift` 为 40 px，`Home`/`End` 到最小/最大，`Enter` 恢复默认，双击同样恢复默认。

## 窄窗口

面板宽度用 `min(设定值, 34vw / 46vw)` 计算：窗口变窄时侧栏和详情面板先让步，内容区不会被挤出屏幕，页面也不会出现横向滚动条。布局面板自身在矮窗口里内部滚动，不会溢出窗口。

笔记本的「布局」菜单挂在 220 px 宽的侧栏底部，容器比面板（308 px）窄。面板改为在侧栏内**左锚**、并用 `min(308px, calc(100vw - 24px))` 兜住视口宽度，同时**向上展开**（`bottom: calc(100% + 8px)`），保证 1040×650 下预设第一颗、滑杆最小值等每个控件都在视口内可点。数据库侧的菜单仍在顶栏工具栏里，保持原构图。

## 偏好存在哪里

- 数据库页面：渲染层 `localStorage` 的 `alaya.db.layout`（一条 JSON），**不写入数据库文件**，因此不进入备份/导出的数据域。
- 笔记本页面：写入笔记本自己的偏好（`notebook.prefs.save`，随 `notebook.list` 读回）。两套偏好互不影响：改数据库布局不会动笔记本记录，反之亦然。
- 数据文件被替换或删除时，布局偏好不会随库迁移；清空应用站点数据会重置布局。

## 给笔记本适配（Canvas / mistakebook.js）

模块是通用的，笔记本只需两行 hook；接口固定，改动很小：

```js
import { createNotebookLayoutAdapter } from './workspace-layout.js'

const layout = createNotebookLayoutAdapter({
  shell,                              // .mb-shell 元素
  defaults: { ...LAYOUT_DEFAULTS, sideSide: 'left', sideCollapsed: false, focus: false, pageWidth: 'comfortable', density: 'comfortable' },
  read: () => prefsCache,             // 返回当前笔记本 prefs（含 order 等非布局字段）
  write: next => savePrefs(next),     // 收到 {...read(), ...布局字段}，不会丢 order
  menuHost: document.querySelector('.mb-side-bottom'),           // 「布局」菜单挂进侧栏底部
  expandHost: document.querySelector('.mb-bar .toolbar-actions'), // 折叠后的展开按钮：必须始终可见
  focusExitHost: document.querySelector('.mb-bar .toolbar-actions'),
  icon, onStatus: message => notify(message),
})
```

- 展开按钮不要挂在会被窄窗隐藏的容器里：笔记本的 `.mb-bar .breadcrumb` 在 `max-width:1180px` 时 `display:none`，挂那里会让折叠后的用户失去唯一恢复入口（`.mb-side-bottom` 也会随侧栏一起隐藏）。工具栏 `.toolbar-actions` 始终可见。
- `layout.prefs()` 返回合并后的偏好；`layout.set(patch)` 改一项；`layout.reset()` 恢复默认；`layout.apply(next)` 直接套用一份快照。
- 应用方式：`--mb-side-w` / `--mb-detail-w`、`detail-left` 类、`.mb-shell` 上的 `data-mb-side` / `data-mb-focus` / `data-mb-page` / `data-mb-density` / `data-mb-side-side`。CSS 规则全部在 `workspace-layout.css`，只依赖现有 `.mb-side`、`.mb-detail`、`.mb-body`、`.mb-main`、`.mb-splitter` 类名和 `#mb-side-split` / `#mb-detail-split` 两个 id。
- 笔记本侧默认不开放「侧栏换边」：那需要分隔条也跟着换位，否则会出现两段间距错位；需要时在 `features` 里显式加入 `sideSide`，并自行安排分隔条位置。
- 全局样式表已由 `index.html` 加载，笔记本不需要再引一次。

## 自测

```bash
node tests/run-workspace-layout.mjs          # 真 Chromium，1440×940 / 1040×650 / 620×560 / 减少动态效果
node tests/run-desktop-workspace-layout.mjs  # 真 Electron + 临时数据库，含重载持久化与窄窗可达性
node --no-warnings tests/run-desktop-canvas.mjs  # 额外覆盖笔记本 1040×650 的折叠→展开、菜单面板与专注 Esc
```

两个布局脚本都用独立临时 profile 与临时数据库，不读写用户数据。Electron 在本机沙箱里必须带 `--no-sandbox` 才能启动（脚本已内置）。

## 已知限制

- 详情面板的宽度/位置控件在未打开任何记忆时也保留，改动会在下一次打开时生效（面板里有一行说明）。
- 布局偏好不进入数据库备份；换用另一份数据库时沿用当前界面的布局。
- 数据库页面的「卡片/列表」视图切换仍是原有偏好（`memory-vault.layout`），与本次布局偏好分开保存。
- 笔记本侧栏折叠时「布局」菜单随侧栏隐藏，恢复入口是顶栏工具栏的展开按钮；画布打开时顶栏整体隐藏，先「回到笔记」再展开（画布内不会陷入无法恢复的死角）。
- 画布 / 布局相关拖拽依赖指针捕获；鼠标在窗口外松开时以 `buttons=0` 或 `lostpointercapture` 结束拖动，不会粘住卡片。
