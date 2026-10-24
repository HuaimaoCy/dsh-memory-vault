# Notion 方向调研与复现评估

面向本次「操作体验接近 Notion」的目标：先确认 Notion 的功能范围，再逐个判断复现价值、给出复现方案。
所有 Alaya 侧结论以当前工作树源码为准（含未提交改动）；Notion 侧结论以公开官方页面为准，证据等级在 §1 与 §9 写明。

## 0. 结论

Notion 真正值钱的是三件套：**块（block）+ 数据库（database）+ 视图（view）**。Alaya 现有的数据模型已经能撑住其中两件的骨架——「条目/组/字段/标签」相当于 Notion 的 database + properties，「网格/列表 + 排序 + 搜索」相当于一个不能配置的 view。缺的不是块编辑器，而是：

1. **视图可配置化并持久化**（筛选/排序/分组/版式存成具名视图）——复现价值最高、改动最小、不动数据表。
2. **统一捕获入口**（一处输入，按目标落到记忆域或笔记本域）——与本次 Codex 快捷录入同一条线。
3. 模板/属性扩展与块编辑器：前者可做可缓，后者**不建议做**——会推翻现有五类型固定字段、改动 MCP 注入文本与导出格式，收益（Notion 那种自由排版）在这个产品里没有对应需求。

因此建议的复现顺序是 **视图 → 捕获 → 模板**，块编辑器与协作类能力明确不做。

## 1. 证据等级

| 来源 | 用来判断什么 | 等级 |
| --- | --- | --- |
| 本仓库源码（`src/`、`desktop/renderer/`、`addons/mistakebook/`） | Alaya 现状、能改哪里 | 实测，逐处给行号 |
| Notion 官方功能页、发布日志、开发者文档导航 | Notion 功能范围 | 页面级事实，正文抓取受限（见 §9） |
| 第三方对比文章 | 只用于「Notion 是否原生有白板」这类旁证 | 弱，仅在正文里标注 |
| 未做 | 未登录 Notion 逐条点测；未在本机跑 Electron（主线程已复跑测试，本文不重复） | — |

Notion 帮助中心的正文是前端渲染的，`web_fetch` 只拿到标题与页面骨架；所以下面对 Notion 的描述限于**功能页明确列出的能力**与**开发者文档确有该对象**，不编造交互细节。

## 2. Notion 功能范围（按能力层拆）

### 2.1 内容与结构模型

- **Block**：一切内容都是块，块可嵌套、可拖动、可「turn into」另一种块。开发者文档把 `Block`、`Page`、`Database`、`Data source`、`View`、`Comment`、`File`、`User`、`Parent`、`Emoji` 都列为一等对象（[API 对象导航](https://developers.notion.com/reference/block)）。
- **Page**：既是内容容器，也是数据库里的一行。
- **Database / Data source**：一套属性 schema + 一组行；`View` 在 2026 年的 API 里已是独立对象，并有独立的 views 端点（同上导航）。
- **Comment**：区块/页面级评论。

### 2.2 编辑交互

- 斜杠命令（`/`）插入块、`@` 提及页面与人、行内链接。
- 块级拖拽、块菜单、多选块、折叠块（toggle）、callout、分栏（columns）。
- 模板（template）、按钮（button）、synced block（同一内容多处同步）。
- 写作与编辑基础见官方 [Docs 功能页](https://www.notion.com/product/features)。

### 2.3 数据能力

- **属性类型**：文本、数值、单选、多选、状态、日期、人员、文件、勾选、URL/邮箱/电话、公式（formula）、关联（relation）、汇总（rollup）、创建/更新时间、创建/更新人、唯一 ID（据开发者文档 [Data source properties](https://developers.notion.com/reference/property-object) 这一专页的存在与其在 schema 中的位置；具体类型清单本轮未逐条抓正文）。
- **视图**：官方功能页明确列出 **看板（Kanban）与甘特/时间线（Gantt/timeline）**，另有「看你的工作为 boards、timelines 等」的表述与图表（charts）能力（[features](https://www.notion.com/product/features)）；table / list / gallery / calendar 属其长期已知视图集，本轮未抓到逐条正文。
- **筛选 / 排序 / 分组**：官方帮助章节标题即「Views, filters, sorts & groups」（[help](https://www.notion.com/help/views-filters-and-sorts)）。
- **内联数据库、表单入口、数据同步（Salesforce/Jira）、图表与仪表盘**（[features](https://www.notion.com/product/features)）。

### 2.4 检索与连接

- Quick Find（全局搜索）、**Backlinks**（谁链接到我）、link previews（内联展开 Figma/GitHub）、Enterprise Search（跨 Slack/Jira 等）（[features](https://www.notion.com/product/features)）。
- **MCP**：官方定位是「把你的 AI 工具接到 Notion 的上下文」，2026-10-19 的发布说明写明 **memory sync 已上线**（[release](https://www.notion.com/releases/2026-10-19)）。

### 2.5 布局与个性化

- 页面级：全宽/默认宽、小字号、字体、封面与图标。
- 工作区级：侧栏收藏与最近访问、面包屑、页面内目录。
- 这些是**展示层偏好**，不是数据。

### 2.6 AI 与代理（2026 年重心）

2026-10-19 发布（[release](https://www.notion.com/releases/2026-10-19)）：Agents 重建（自带「一台电脑 + 浏览器」、可跑最长 24 小时、新增 Review for me 安全模式）、Auto 模型路由（官称对标前沿模型但成本低约 90%）、BYOK、**改进版 Notion MCP + memory sync**、即将上线的 AI Command Center 与新的 credit 计费。另有 3.7「Agent skills for your whole team」、3.8「Context for your agents」（同页 recent releases）。

值得注意：**Notion 自己在往「给 agent 用的共享大脑 + 记忆同步」走**，这正好是 Alaya「本地记忆库 + Codex/DSH 接入」的战场。这既是复现价值的佐证，也是必须打的差异点（本地、单文件、可离线、数据域隔离）。

### 2.7 协作与治理

实时协作、评论、粒度权限、版本历史、审计日志、SSO/SCIM、合规认证（[features](https://www.notion.com/product/features)）。
Alaya 是**单机本地应用（SQLite 单文件）**，这一整层不构成复现目标；只有「版本历史 + 回收站/归档」可能以极简形式对应（Alaya 已有归档/回收站与撤销）。

## 3. Alaya 现状（源码事实）

### 3.1 数据库（记忆域）

> 行号按当前工作树（含未提交改动）记录；若并行工作改动了 `app.js`，以标识为准——`mountWorkspaceLayout`、`mountCommandPalette`、`view-grid`/`view-list`、`alaya.db.layout`。

- 表结构 `src/store.js`：`meta`、`groups`（id/name/scope/description/tags/session_id/auto_summary/priority/parent_id/时间）、`entries`（id/group_id/scope/assigned/title/content/kind/source/session_id/tags/hidden/priority/base/时间）、`applications`、`entry_applications`、`transcript`、`sessions`、`summaries`、`images`（`store.js:147-207`）。
  → **条目没有状态、日期、关联、公式类字段**；`kind` 固定 6 类语义（summary/fact/preference/decision/task/note），`tags` 是 JSON 数组，`priority` 0–100。
- 操作面：9 个 `memory_*` 工具，全部经同一张操作表分发（`src/tools.js`，README 亦列明）。写入有 policy 与来源自动打标，UI 不得绕过。
- 数据库界面 `desktop/renderer/app.js`：
  - 视图入口固定为 `all / scope(knowledge|conversation) / hidden / group`（`app.js:146-151`、`app.js:311`）。
  - 版式只有 `grid | rows`（`app.js:334`），排序只有优先级/更新/标题三档。
  - 命令面板 11 条固定命令（新建、搜索、4 个视图、4 条布局、设置）外加每个记忆组一条（`app.js:557-570`）。
  - AI 整理（curate）在工具栏（`index.html` 的 `#curation-menu`）。
- 布局偏好：只写渲染层 `localStorage`，键 `alaya.db.layout`（`app.js:542-547`、`workspace-layout.js:94-95`），**不入库、不进备份**。

### 3.2 笔记本（笔记域）

- 五种类型 + 固定结构化字段（`addons/mistakebook/fields.mjs:4-17`）；无块编辑，编辑是字段表单。
- 记录带复习调度字段：`nextReviewAt`、`reviewState`、`mastery`、`repeatCount`、`sortIndex`、`reviewHistory`（`store.mjs:76-96`）。
- 存储：`notebook_meta / notebook_questions / notebook_images / notebook_ai_messages`（`store.mjs:112`）；侧边栏配置与**画布文档**都在元信息表（`store.mjs:356-371`，键 `canvas`）；偏好走 `notebook.prefs`（`mistakebook.js:135`）。
- 操作面：`src/core/notebook_ops.mjs` 是笔记本的共享 op 表，逐项标注读写（`notebook.list`/`read` 只读，`notebook.save`/`prefs.save`/`sidebar.save` 等写入）。画布没有进这张表，走独立的 `notebook:canvas` 通道——这是有意的，避免给 Codex/CLI/MCP 的写入面凭空加一条。
- 已有能力：标签云与标签筛选、数据驱动侧边栏（可重命名/新增/排序/隐藏/拖拽归类）、自由排列与拖拽改分类、关系树（词汇近义/反义/变形，`relations.js`）、AI 侧边栏历史入库 + 「存为笔记」（0.7.15）。
- 本轮新增：自由画布（`freeform-canvas.js` + `addons/mistakebook/canvas.mjs`，世界坐标 + 视口，存 `notebook_meta.canvas`）、通用工作区布局（`workspace-layout.js`）、命令面板（数据库侧）。

### 3.3 Codex / DSL 接入

- MCP 9 工具 + `alaya-database` skill + 本地插件清单（`.codex-plugin/`、`.mcp.json`、`.agents/`）；快捷添加的现有形态是 `$alaya-database 记住：…`（README §安装、`docs/codex.zh.md`）。

## 4. 差距矩阵与复现价值

价值判据三条：**能否放大已有数据模型**、**是否破坏两域隔离**、**维护成本是否配得上收益**。

| Notion 能力 | Alaya 现状 | 差距 | 价值 | 结论 |
| --- | --- | --- | --- | --- |
| 区块化编辑（block + turn into + 拖动） | 单段 Markdown 正文；笔记本是固定字段表单 | 数据结构层面完全不同 | 低 | **不做**（§5.3） |
| 数据库视图可配置（筛选/排序/分组保存为视图） | 4 个固定视图 + 3 档排序 + 搜索 | 无可保存的视图对象 | **高** | **P0**（§5.1） |
| 看板 / 时间线 | 无 | 分组维度已具备：数据库侧有 `group_id`/`kind`/`scope`，笔记本侧有 `reviewState`/`nextReviewAt` | 中高 | **P0**（§5.1） |
| 属性类型（状态/日期/公式/关联/汇总） | 无这些列；`kind` 与 `tags` 已覆盖一部分语义 | 需改 `entries` 表与导出 | 中 | **P1**，且只做「日期 + 状态」两列（§5.4） |
| 全局 Quick Find（跨页面/库） | 数据库侧搜索限定在当前视图内（输入框提示「搜索当前范围」）；笔记本侧搜索只搜当前笔记列表 | 无跨域统一入口 | **高** | **P0**（§5.2） |
| 快速捕获（web clipper / mobile capture） | 桌面「新建记忆」抽屉；Codex 侧 `$alaya-database 记住：…` | 无「一处输入、分域落点」 | **高** | **P0**（§5.2） |
| 模板 | 笔记本五类型即模板；数据库无 | 缺「用户自定义模板」 | 中 | **P1**（§5.4） |
| Backlinks / @提及页面 | 条目之间无引用；笔记本只有词汇关系树 | 无 entry→entry 关系 | 低中 | **缓做**（§5.5） |
| 内联数据库（页面里嵌一张库） | 无 | 需要新的块模型才能承载 | 低 | 不做 |
| 图表 / 仪表盘 | 无（有计数与统计卡片） | 独立数据可视化 | 低 | 不做 |
| 版本历史 | 归档/回收站/撤销 | 无逐版本快照 | 低 | 不做（本地单用户收益低） |
| 实时协作、评论、权限、SSO、审计 | 单机本地 | 架构不兼容 | 无 | 不做 |
| Notion MCP + memory sync | 已有 MCP 9 工具 + skill + 插件 | 缺「记忆同步/收件箱」语义 | 中高 | 与 CodexMemory 同线（§5.2） |

## 5. 复现方案

### 5.1 P0-1 视图可配置化（推荐先做）

**目标**：把「筛选 + 排序 + 分组 + 版式」存成具名视图，可切换、可复制、可恢复默认；新增看板（按记忆组或 `kind`）与列表口径一致。

**落点**：
- 新增纯模块 `desktop/renderer/views.js`（校验/合并/序列化，无 DOM，可在 Node 里测）。
- `app.js` 里把 `state.layout` + 排序 + 视图入口统一成 `state.view = { id, kind, filter, sort, groupBy, layout }`；命令面板补「切换视图 / 新建视图」两条。
- 版式新增 `board`：按 `group_id` 分列（天然对应 Notion 的 board），卡片复用现有记忆卡。

**数据落点（关键取舍）**：视图是**展示层配置**，与记忆数据域无关。建议沿用现有做法写 `localStorage`（命名空间 `alaya.db.views`），理由：
1. 一旦写进 `meta` 表，就会随数据库备份/导出一起走，等于让 UI 偏好污染记忆域，与「两域隔离 + 备份口径」冲突；
2. 现有先例已经分叉——数据库布局在 `localStorage`（`app.js:542`），笔记本布局在 `notebook.prefs` 入库（`mistakebook.js:135`）；新增视图若再选第三个口径，会把这件事弄得更乱。
3. 若将来要跨机同步视图，再单独加 `ui_views` 表，并在导出/备份里**显式排除**，作为一次有意为之的决策记录，而不是默认入库。

**测试**：`tests/views-smoke.mjs`（纯模型：非法 filter 拒绝、合并、上限）+ `tests/run-desktop-views.mjs`（真 Electron + 临时库：切换视图后重启仍在）。

### 5.2 P0-2 统一捕获 + 全库搜索

**目标**：一个入口（全局快捷键 + 命令面板首项）接收一段文字，按选择落到两个域之一：

| 目标 | 落点 | 口径 |
| --- | --- | --- |
| 记忆（数据库域） | MCP 工具 `memory_write` 的同一处理函数（`src/tools.js`，`kind` 六种已够用） | 走现有校验与来源自动打标，不裸写表 |
| 笔记（笔记本域） | `notebook.save`（共享 op 表里标 `write: true`，`src/core/notebook_ops.mjs`） | 走 `MistakebookStore` 归一化与字节闸门 |

注意：笔记本侧**没有** `notebook.create` 这个 op，「新建」就是 `notebook.save`；共享 op 表为每个 op 标了 `write` 位（画布走的是独立的 `notebook:canvas` 通道，刻意没进这张表）。所以捕获入口应当复用现有 op，而不是新开一条写入通道。

**关键约束**：
- 允许**域内默认值**，禁止跨域隐式搬运：捕获框里选错域时只提示，不自动把笔记塞进记忆域。
- 建议给捕获入口一个**收件箱常规做法**：记忆侧 `kind=note` + `tag=inbox`，笔记侧 `tag=收件箱`。用约定而不是新表——新表会扩大导出与备份面积，收益有限。
- 与 Codex 侧共用同一套写入语义：Codex 写记忆走的是 MCP 工具 `memory_write`（`src/tools.js`），`src/codex.js` 只负责安装/校验，不参与写库。捕获入口也必须落到同一个处理函数上，避免「Codex 写进去的」和「桌面写进去的」规则不同。
- 全局快捷键：用 Electron `globalShortcut`，只在主进程注册；冲突时降级为应用内快捷键并在状态条说明（不静默失败）。

**对标说明**：Notion 2026-10-19 把 MCP 的 memory sync 作为卖点（[release](https://www.notion.com/releases/2026-10-19)），说明「AI 侧快捷记忆」已被验证是刚需；Alaya 的差异是本地库 + 双域隔离，因此**捕获入口的正确形态是分域，而不是 Notion 那种单一 workspace**。

### 5.3 不做块编辑器（附理由）

- 现有笔记本是「类型 + 固定字段」，`fields.mjs` 的字段表同时驱动编辑器、导出与校验；改成块列表要重写这层并迁移全部历史记录。
- 记忆域正文会被注入系统提示（单条上限约 2400 字），块化会引入新结构、改变注入文本形态，影响 `memory_recall` 的既有输出契约。
- 收益是「自由排版」，而 Alaya 的排版自由度已经由画布（本轮）与布局（本轮）覆盖；两者叠加后再上块编辑器，属于同一种自由的第三次实现。
- 折中方案（若日后确实需要）：只在**编辑器层**做 Markdown 块命令（`/` 插入标题/表格/公式），存储仍是 Markdown 一段文本——零 schema 变更、零 MCP 影响。可作为 P2 的廉价替代。

### 5.4 P1 属性与模板（可缓）

- 属性：只加两列才划算——`due_at`（日期）与 `status`（状态）。加列要动 `entries` 表、导出格式与 9 个工具的 schema，属于契约级改动，**必须与工具层一起评审**。
- 模板：数据库侧「新建记忆预填」（标题/组/标签/kind），存 `localStorage` 即可；笔记本侧五类型已是模板，不重复造。

### 5.5 缓做：条目间引用

- 若做，最小形态是**渲染层解析**：正文里 `[[条目id]]` 渲染为可点击跳转，不新建关系表、不改 `memory_recall` 输出。
- 一旦建正式关系表，backlinks 就会进入检索与注入决策（「这条记忆被谁引用」要不要进提示），属于会改变模型行为的改动，需要单独评审。

## 6. 与本轮三条并行工作的关系

| 本轮工作 | 对应 Notion 的什么 | 现状与缺口 |
| --- | --- | --- |
| 自由画布（Canvas） | **不是** Notion 能力，属 Apple Freeform 一类 | 本轮检索未找到 Notion 官方无边画布产品页；第三方对比文章把白板当作需要集成的能力（弱证据）。结论：画布不与 Notion 复现冲突。缺口：`canvas.mjs` 的 `reference` 卡片是「标题 + 摘要快照」，而 Notion 的 mention/linked view 是**活引用**；建议后续只在渲染层按 id 拉活数据，不改存储结构。 |
| 工作区布局（Layout） | 页面宽度/字体/侧栏偏好 | 已覆盖。**口径分叉需写进文档**：数据库布局在 `localStorage`（`app.js:542`），笔记本布局入库（`mistakebook.js:135`）。这是有意的（笔记本偏好本来就入库），但备份语义不同，文档必须说清；主线程已发现的 `savePrefs` 嵌套 guard 与「重读 prefs 未回灌」是必修项。 |
| Codex 插件与快捷录入（CodexMemory） | Notion MCP + memory sync | 方向正确且是差异点。缺口：没有「收件箱」约定（§5.2），以及捕获框缺一个统一的桌面入口。 |

## 7. 落地顺序与工作量（估算，非实测）

| 序 | 事项 | 估算 | 风险 |
| --- | --- | --- | --- |
| 1 | 视图可配置 + 看板（§5.1） | 2 人日 | 低：只动渲染层与命令面板 |
| 2 | 统一捕获 + 全局快捷键（§5.2） | 1.5 人日 | 中：`globalShortcut` 冲突、双域误投 |
| 3 | 编辑器层块命令（§5.3 折中） | 1 人日 | 低：纯 Markdown |
| 4 | 模板预填（§5.4） | 1 人日 | 低 |
| 5 | 属性两列（§5.4） | 3 人日 | **高：动 schema/导出/9 个工具** |
| 6 | 条目引用（§5.5） | 2 人日 | 中：影响注入语义需评审 |

## 8. 给集成者的不变量与验收

1. **两域隔离不破**：画布（`notebook_meta.canvas`）、布局、视图偏好均不得进入 `entries` / `groups`；数据库备份不含笔记本表，笔记本备份不含记忆表（现有 `docs/freeform.zh.md` §数据位置已声明，新增视图须沿用同一口径）。
2. **导出格式**：笔记本导出已是 `schemaVersion: 3` 且带 `canvas` 段；若新增 `views` 段必须同样「按 id 合并、旧版缺失就不动本机」。
3. **工具面不扩**：UI 新增能力不得绕开 `memory_*` 操作表直接写库；捕获入口与 Codex 写入必须同一条路径。
4. **测试口径**：只用 `test-tmp/` 下临时配置与临时数据库；Electron 在本机沙箱需 `--no-sandbox`（仅测试进程）。可执行的回归命令：

```powershell
node --no-warnings tests/canvas-smoke.mjs
node --no-warnings tests/run-desktop-canvas.mjs
node --no-warnings tests/run-workspace-layout.mjs
node --no-warnings tests/run-desktop-workspace-layout.mjs
node --no-warnings tests/run-desktop-palette.mjs
```

## 9. 未验证与已知限制

- Notion 帮助中心正文由前端渲染，本轮只取到页面标题/骨架；§2.3 的属性类型清单与 table/list/gallery/calendar 视图集属**已知分类**而非本轮抓取正文逐条核对。看板、时间线、图表、表单、Backlinks、MCP、Agents/Auto/BYOK 有官方页面明确列出。
- 未登录 Notion 做交互实测；不引用任何未标注来源的「Notion 内部行为」。
- 本文不重复主线程已完成的 Electron 复跑结论；文中引用的测试命令是建议口径，不代表本轮新跑。
- 工作量是估算，未做真实计时；P1-5（属性两列）的实际成本取决于 9 个工具的 schema 与导出迁移面。
