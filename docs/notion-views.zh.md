# 可保存视图（Notion 式数据库渲染层）

面向 `docs/notion-parity.zh.md` §5.1 的 P0 落地记录：把 0.7.15 写死的「4 个固定入口 + grid/rows 两档显示」升级为**可命名、可保存、可复制、可删除、可恢复默认的视图**。

本文只描述渲染层。数据模型、`entries`/`groups` 表、9 个 `memory_*` 工具、MCP 与导出格式**一行未改**——视图是展示层配置，不是数据。

## 1. 视图模型（唯一契约）

```js
{
  id,        // 'default-all' | 'default-knowledge' | 'default-conversation' | 'default-hidden' | 'view-N'
  name,      // 1–60 字符，空名回落 '未命名视图'
  source: { kind: 'all' | 'scope' | 'hidden' | 'group', id? },
  shape:  'grid' | 'rows' | 'table' | 'board',
  sort:   'priority' | 'updated' | 'title',
  groupBy:'root' | 'kind' | 'group',
  filters:{ kinds?: string[], tags?: string[], onlyBase?: boolean, onlyWithImages?: boolean }
}
```

- `source.kind === 'scope'` 时 `id` 只认 `knowledge` / `conversation`；`kind === 'group'` 必须有 `id`，否则整体退回 `{ kind: 'all' }`。
- `filters` 归一化后**永远存在**且四个字段齐全（缺省值 `[] / [] / false / false`），便于比较与「清除筛选」。
- 序列化只写上面七个字段，字段顺序固定；多余键在 `serializeView` 里被丢弃。

纯模型在 `desktop/renderer/views.js`（无 DOM、可在 Node 里直接跑）。导出面：

| 分类 | 函数 |
| --- | --- |
| 归一化 | `normalizeView` `normalizeSource` `normalizeFilters` `normalizeViewStore` |
| 迁移/存储 | `migrateViewStore` `readViewStore` `writeViewStore` `clearLegacyLayout` `serializeView` |
| 内置视图 | `defaultViews` `DEFAULT_VIEW_IDS` `isDefaultView` `nextViewId` `createView` |
| 渲染计算 | `filterEntries` `sortEntries` `groupEntries` `titleOf` `tagsOf` |
| 描述 | `activeFilterCount` `describeFilters` `describeView` `describeSource` |
| 常量 | `VIEW_STORE_KEY` `LEGACY_LAYOUT_KEY` `VIEW_SCHEMA` `KIND_LABELS` `SHAPE_LABELS` `SORT_LABELS` `GROUPING_LABELS` |

## 2. 偏好存储：只写渲染层

- 键 `alaya.db.views`，值 `{ schema: 1, views: [...], activeId }`。
- **绝不写数据库 `meta` 表**。UI 偏好一旦进库就会随备份/导出一起来回搬，等于污染记忆域——这与「两域隔离 + 备份口径」冲突，也是本项目的硬错误。`tests/desktop-views.mjs` 会直接打开 SQLite 读 `meta` 表断言里面没有视图键名、视图名和 `groupBy`。
- 存储不可用（隐私模式、配额满、被拒）时静默降级为「本次会话内生效」，不抛异常。

### 0.7.15 的 `memory-vault.layout` 怎么迁

旧键只有 `'grid' | 'rows'` 两个值，作用范围是当时那 4 个固定入口。迁移规则：

1. 首次启动、`alaya.db.views` 不存在 → 用四个内置视图作为种子，`shape` 取旧键的值（`rows` 就四个都 `rows`）。
2. 立刻把种子写进 `alaya.db.views`，并**删除旧键**。这样用户以后改形状不会被旧值在下次启动时盖回去（这一条在 `tests/desktop-views.mjs` 里有一整段验证）。
3. 旧键值非法（`bogus`/空）→ 回落 `grid`，不丢默认行为。
4. 更早的实验格式（顶层是数组）也能读，包一层 `{ views }` 并取第一个为 active。

已经有 `alaya.db.views` 时旧键被完全忽略。

## 3. 界面落点

| 位置 | 做了什么 |
| --- | --- |
| 侧栏「视图」区块（`#saved-views`，在「资料库」下方、「记忆组」上方） | 列出全部保存的视图，当前项 `aria-current="page"`；内置视图带小圆点。区块标题右侧 ＋ 为「新建视图」（复制当前视图并立即打开设置）。 |
| 侧栏「资料库」（`#views`） | **保持 4 条按钮不变**：这是其它桌面套件与主进程自检的既有契约。点它永远回到对应的内置视图，不会悄悄套上用户某天给同名来源加的筛选。 |
| 工具栏形状切换 | 4 个 `button.segment`：`#view-grid` 卡片 / `#view-list` 列表 / `#view-table` 表格 / `#view-board` 看板，都带 `aria-pressed`。 |
| 工具栏排序 | 沿用 `#sort` 下拉（三档），值与当前视图双向同步。 |
| 工具栏「视图设置」（`#view-settings`） | 打开设置弹层；弹层里改名、改来源、版式、排序、分组、类型/标签/底层约定/图片筛选、另存为、删除、恢复默认。按钮上带生效中的筛选条数徽标。 |
| 主区标题 | `#view-title` 显示**视图名**（不再是来源名）；来源名留在面包屑。 |

### 四种版式

- **卡片 grid**：完全沿用 0.7.15 的 `.tile` 结构（`groupBy: 'root'` 时保留「根记忆组 + 标签子段」两级，其它分组改用视图的分组维度）。
- **列表 rows**：同一张卡横过来排（`.list.rows`），同样是既有实现。
- **表格 table**：一张紧凑多列表（标题/归属/类型/记忆组/优先级/更新时间）。分组用行内分组标题行表达，不切多张表；行可 `Tab` 聚焦、`Enter`/`Space` 打开编辑抽屉。
- **看板 board**：按 `groupBy` 分列，列固定 286px、容器 `overflow-x: auto` 横向滚动；卡片可点开编辑抽屉。

### 空态

- 有数据但被筛选清空 → `当前筛选没有结果` + 说明原因（列出具体条件）+ `清除筛选` / `视图设置`。
- 搜索无命中 / 库本身为空 → 沿用既有两种空态。

## 4. 筛选与排序在渲染层真的生效

`renderList()` 的顺序是：`filterEntries(已加载的 200 条)` → `sortEntries` → 按 `shape` 分发。没有新增请求，也没有服务端筛选参数——`entries` op 的调用方式与 0.7.15 完全一致（`includeHidden` / `onlyHidden` / `scope` / `group` 只由 `source` 决定）。

- 筛选多条规则之间是 **AND**，同一字段里的多个值是 **OR**。
- `tags` 按字面匹配（含「AI 生成」这类系统标签，大小写不敏感）。
- `priority` 排序保持 0.7.15 的口径：底层约定优先 → 优先级 → 最近更新。

## 5. 可访问性与约束

- 全部控件是可聚焦的原生元素（`button` / `select` / `input` / `tr[tabindex]`），带 `aria-label` / `aria-pressed` / `aria-current` / `aria-haspopup`；设置弹层复用应用的 `modal()`，天然有焦点陷阱与 Esc。
- 外部文本一律 `textContent`（`h()` 只写 `textContent`），全仓没有 `innerHTML`；`tests/desktop-views.mjs` 会静态断言这一点。
- 不新增任何网络请求（CSP `default-src 'none'`）；测试同样静态断言源码里没有 `fetch`/`XMLHttpRequest`/`WebSocket`/`EventSource`。
- `views.css` 末尾有 `@media (prefers-reduced-motion: reduce)`，动画在减弱动态效果时关闭。

## 6. 命令面板

新增 3 条命令，**追加在列表末尾**（前几项顺序是既有套件的契约）：

- `视图：视图设置`
- `视图：新建视图`
- `视图：恢复默认视图`

命令文案刻意不含「删除/清空」，也不含「知识库」——前者是「不得提供破坏性动作」的既有断言，后者会让「知识库」这个搜索词命中两条命令。

## 7. 测试

```powershell
npm run test:views                                  # 纯模型 + 真实 Electron + 筛选边界
node --no-warnings tests/views-smoke.mjs            # 纯函数单测（15 组）
node tests/run-desktop-views.mjs                    # 真 Electron + 临时库
node tests/run-desktop-views-scope.mjs              # 206 条数据下的筛选边界（真 Electron）
node tests/run-desktop-views.mjs --shots test-tmp/views-shots   # 顺便落截图
```

`tests/views-smoke.mjs` 覆盖：模型字段契约、坏数据兜底、来源归一化、筛选（四种条件与组合）、三档排序（含坏日期）、三种分组（列顺序、未分组最后、空组不出现）、`memory-vault.layout` 迁移、存储读写的坏 JSON/抛异常/去重/上限、新建与复制视图、描述文本、**筛选范围提示文案**。

`tests/desktop-views.mjs` 是真窗口，覆盖：新建视图 → 切看板（列数与列顺序）→ 卡片点开编辑 → 筛选生效（徽标/列收敛/空态/一键清除）→ 切表格（六列断言 + 键盘 Enter）→ localStorage 契约与 **SQLite `meta` 表不含视图配置** → 重载后视图/形状/排序仍在 → 删除视图（记忆不受影响）→ 恢复默认 → `memory-vault.layout` 迁移与旧键清理 → ARIA 与静态契约。

`tests/desktop-views-scope.mjs` 专测筛选边界：库里 206 条、首屏只拉 200 条、筛选只命中第 206 条。断言「目标不在首屏」「提示条写明已加载 200 条 / 匹配 0 条」「空态说的是『已加载的结果里没有匹配』」「点加载更多后目标出现且提示消失」「没有筛选时不出现该提示」。

## 8. 已知限制

1. 视图是**渲染层配置**：只对已加载的 200 条结果生效。翻页（「加载更多」）后新到的条目同样会被筛选，但「筛选掉多少条」这类计数不跨页统计。界面不隐瞒这一点：有筛选且还有未加载结果时，列表顶部会显示「筛选只作用于已加载的 N 条（匹配 M 条）；还有更多结果未加载」并给一键加载更多；此时空态文案是「已加载的结果里没有匹配」，不会声称整库没有。
2. 表格视图把分组表达为「分组标题行 + 按分组聚簇」，不是每个分组一张表——为了保持「紧凑多列」而不是多张表堆叠。
3. 直接在记忆组上浏览时得到的是**临时视图**（没有 id）：改形状/排序只影响本次会话，不写偏好。要保留就点「新建视图」或「另存为」。这是有意的——否则点一下记忆组就会往视图列表里塞条目。
4. 「恢复默认视图」把四个内置视图还原为出厂配置，**保留**用户自建的视图；不会删除它们。
5. 内置视图 id 固定为 `default-*`；如果删掉某个内置视图，对应「资料库」入口会退化为临时视图，仍可正常浏览，只是不再记住形状。
6. 视图不参与备份/导出，也不跨机器同步——这是第 2 节的直接后果，若将来要跨机同步需单独加 `ui_views` 表并在导出/备份里**显式排除**。
