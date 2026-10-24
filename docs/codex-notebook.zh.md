# 在 Codex 里读写笔记本

笔记本和记忆库共用同一个 SQLite 文件，但是两个独立数据域：`notebook_*` 表归笔记本，记忆库的表归记忆。Codex 通过 **同一台 MCP** 访问两边，工具名分别是 `notebook_*` 与 `memory_*`。

## 前提：从笔记本构建启动 MCP

`notebook_*` 工具只由**笔记本仓库**的 MCP 提供：

```powershell
node bin/memory-vault.mjs mcp --db <数据库路径>
```

只装数据库插件时，MCP 里只有 `memory_*`——这是刻意的：数据库产物不携带笔记本代码。

## 工具

| 工具 | 读/写 | 说明 |
| --- | --- | --- |
| `notebook_list` | 读 | 视图 / 类型 / 关键词 / 标签过滤，返回摘要与总数 |
| `notebook_read` | 读 | 取全文与结构化字段；`includeImages=true` 才带图片数据 |
| `notebook_save` | 写 | 新建条目，`type` 必填（note/mistake/physics/method/vocabulary） |
| `notebook_canvas_get` | 读 | 画布文档；传 `canvasId` 只看一张 |
| `notebook_canvas_add` | 写 | 追加文本/便签卡片，没有画布会先建一张 |
| `notebook_canvas_update` | 写 | 改某张卡片的文本、颜色或位置 |

## 技能

```powershell
node bin/memory-vault.mjs skill path        # 显示 SKILL.md 路径
node bin/memory-vault.mjs skill print       # 打印内容
node bin/memory-vault.mjs skill install     # 装进 $CODEX_HOME/skills/alaya-notebook/SKILL.md
node bin/memory-vault.mjs skill install --dir <目录>   # 装到指定目录
```

装好后在 Codex 里可以说：

```text
$alaya-notebook 我的错题里有没有三角函数相关的？
$alaya-notebook 把这段结论记成一篇笔记：……
```

## 边界与安全

- **只追加，不覆盖画布**：没有「替换整份画布文档」的工具。`notebook_canvas_get` 返回 `corrupted: true` 时工具会拒绝写入，避免把损坏读成空文档再覆盖用户原画布（桌面端的 P0 修复同源）。
- **画布写入走 `normalizeDocument` + `setCanvasDocs`**：坐标、卡片数、字节上限都由存储层校验，模型不能绕过。
- **写入即真实数据**：`notebook_save` 没有草稿态；同一段内容写两次会得到两条，去重靠先 `notebook_list`。
- 笔记本不进入记忆域的检索与备份口径：`memory_recall` 不会返回笔记，笔记本导出也不含记忆。

## 与数据库插件共存

同一台机器如果已经为记忆装了数据库插件，Codex 的 MCP 指向的是插件副本（只有 `memory_*`）。要让 Codex 同时看到笔记本，二选一：

1. **改指向**：把 `config.toml` 里 `[mcp_servers.memory-vault]` 的 `args` 指向笔记本仓库的 `bin/memory-vault.mjs`（服务名不变，工具变多）；
2. **加第二台**：新增 `[mcp_servers.alaya-notebook]`，`--db` 指同一个数据库，与记忆那台并存（工具名不冲突，但两个服务都会开同一库）。

两种都只改配置、不改数据；切换前先备份 `config.toml`。
## ZCode 里使用

ZCode 的插件格式与 Codex 同源：`.zcode-plugin/plugin.json`（清单）、`skills/`、`.mcp.json`。本仓库根目录同时是**插件本体**和**插件市场**：

```text
marketplace.json          # 市场清单：插件名、版本、source: "./"
.zcode-plugin/plugin.json # 插件清单：skills 与 mcpServers
.codex-plugin/plugin.json # Codex 同款清单
.mcp.json                 # alaya-notebook MCP 服务
skills/alaya-notebook/    # 技能
```

在 ZCode 里接入：

1. 打开 **设置 → 插件 → 右上角 Create → 添加市场**
2. 选 **本地目录**，指向本仓库（或填 GitHub 仓库 `HuaimaoCy/dsh-memory-vault`）
3. 在 Personal 分组里点 **安装** `alaya-notebook`

安装后技能出现在 **设置 → 技能 → Plugin skills**，MCP 出现在 **设置 → MCP → Plugin MCP servers**。改版本时 `marketplace.json` 的 `version` 也要跟着改，否则更新检查不会提示（ZCode 比较的是市场条目版本与已安装插件版本）。
