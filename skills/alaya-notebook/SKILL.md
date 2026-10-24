---
name: alaya-notebook
description: 在 Codex 中读写 Alaya 笔记本：笔记、错题、物理模型、解题方法、英语词汇与自由画布。当用户提到「笔记本」「错题」「单词」「画布」「把这段记成笔记」，或需要查看既有笔记来回答问题时使用。笔记与记忆库是同一个 SQLite 文件里的两个独立数据域，工具分别是 notebook_* 与 memory_*。
---

# Alaya 笔记本

笔记本是数据库的扩充，不是第二个应用：同一个 SQLite 文件、同一套存储校验，但**独立数据域**（`notebook_*` 表 vs 记忆库的表）。这里的工具只碰笔记本；记忆与知识库仍然用 `memory_*`。

## 工具

| 工具 | 读/写 | 用途 |
| --- | --- | --- |
| `notebook_list` | 读 | 按视图（all/due/mastered/archived/trash）、类型、关键词、标签列出条目，返回摘要 |
| `notebook_read` | 读 | 读一篇的完整内容与结构化字段；`includeImages=true` 才带图片二进制 |
| `notebook_save` | 写 | 新建条目：`type` 必填，正文放 `stem`，单词类型还要 `vocabulary.word` |
| `notebook_canvas_get` | 读 | 读画布文档；传 `canvasId` 只看一张 |
| `notebook_canvas_add` | 写 | 往画布追加一张文本/便签卡片（没有画布会先建一张） |
| `notebook_canvas_update` | 写 | 改某张卡片的文本、颜色或位置 |

## 典型流程

1. **回答与学习记录有关的问题**：先 `notebook_list`（可带 `query`）筛出候选，再 `notebook_read` 取正文；不要凭记忆猜笔记内容。
2. **用户说「把这段记成笔记」**：`notebook_save`，`type` 用 `note`；错题用 `mistake`，单词用 `vocabulary` 并给 `vocabulary.word`。
3. **用户说「记到画布上」或要整理思路**：`notebook_canvas_get` 看现有画布，再 `notebook_canvas_add` 追加便签；要改已经存在的卡片用 `notebook_canvas_update`。
4. **复习相关**：`view: 'due'` 取待复习，`view: 'mastered'` 取已掌握；不要自己推算复习时间。

## 硬约束

- **不跨域写入**：笔记不要写进 `memory_*`，记忆也不要写进 `notebook_save`。用户要「存成长期知识」用 `memory_write`，要「存成笔记」用 `notebook_save`。
- **画布只追加，不整体覆盖**：没有「替换整份文档」的工具是有意的——读失败时绝不能把用户画布写成空文档。`notebook_canvas_get` 返回 `corrupted: true` 时停止写入并告诉用户在桌面端处理。
- **写入即真实数据**：`notebook_save` 没有草稿态，写之前确认用户要保存的内容、类型与标签。同一段内容写两次会得到两条，去重靠先 `notebook_list` 查。
- 图片：`notebook_read` 默认只给元数据；确实要看图再传 `includeImages=true`，避免把大图塞进上下文。

## 在 Codex 里使用

```text
$alaya-notebook 我的错题里有没有关于三角函数的？
$alaya-notebook 把这段结论记成一篇笔记：……
$alaya-notebook 在画布上贴一张便签，写「下一步：补回归测试」
```

工具由 `memory-vault` MCP 提供。**注意**：只有从笔记本构建启动的 MCP（`bin/memory-vault.mjs mcp`）才带 `notebook_*`；只装了数据库插件时，MCP 里只有 `memory_*`。
