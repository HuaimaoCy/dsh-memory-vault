# Memory Vault 0.6.3 使用说明

Memory Vault 是独立运行的 Windows 桌面记忆库。运行桌面软件不需要安装 DSH、Node.js 或联网。Codex、DSH、桌面程序与命令行接口读取同一个数据库文件。

## 安装和启动

运行 `Memory-Vault-0.6.3-Setup.exe`，选择安装目录，之后从开始菜单或桌面快捷方式启动「Memory Vault」。安装包包含运行环境。

为了继续使用原记忆，默认数据库位置保持为 `%USERPROFILE%\.dsh\memory-vault\vault.sqlite`；设置了 `DSH_HOME` 时使用该目录下的 `memory-vault\vault.sqlite`。也可以通过 `MEMORY_VAULT_DB` 或启动参数 `--db <绝对路径>` 指定。这里是兼容的数据路径，软件本身不需要 DSH 进程。

如果原 DSH 插件配置了其他数据库，在「设置与连接 → 打开其他记忆库」选择它。切换后桌面软件会记住路径；显式启动参数和环境变量优先于界面保存的路径。

## 日常使用

- 左侧选择全部记忆、知识库、对话记忆、隐藏或一个记忆组。选择子组只显示它及其后代，不会把兄弟组混进来。
- 顶部搜索支持以空格分隔多个关键词；结果分页，可继续「加载更多」。记忆组是一级标题，组内按条目的第一个用户标签分节。
- 记忆标题下方可切换卡片或列表视图，显示方式会保留。排序作用于已加载的记忆；加载更多后一起排序。
- 快捷键：`Ctrl+F` 搜索、`Ctrl+N` 新建、`Ctrl+S` 保存当前记忆、`Esc` 关闭详情。
- 「新建记忆」填写标题、正文、归属、分组、类型、标签和优先级，再按「创建记忆」。已有条目点开后按「保存修改」，归属和分组会一起保存。
- 详情的「图片」区域支持添加文件、拖入图片、粘贴截图、缩略图及大图预览。可以只保存图片；附件与正文一起保存、备份和恢复。完整限制与助手接口见 [图片记忆](images.zh.md)。
- 优先级范围 0–100。底层约定使用独立的知识预算；在 Codex 中必须调用工具读取这层内容，MCP 不会自动修改系统提示。
- 「隐藏」保留内容，可在隐藏视图恢复；「删除」会要求确认。
- 左侧「记忆组」旁的加号可以创建、重命名、移动和删除记忆组，最多三层，并拒绝循环父子关系。删除含子组的父组需要先处理子组。
- 其他宿主写入后，可按「刷新」；窗口重新获得焦点时也会读取最新数据。有未保存的编辑时保留编辑内容。

独立桌面详情目前提供 Markdown / LaTeX 源码编辑；DSH 面板原有的 Markdown 和数学排版继续保留。

「设置与连接」按通用、AI 服务、记忆预算、Codex 与 DSH、软件更新分页。记忆卡片上的「AI 整理」菜单提供整理范围、预览和应用操作。

「软件更新」可检查 GitHub Releases、查看说明、下载并安装新版，默认启动后及每 6 小时自动检查。下载可取消，校验通过后才能安装；安装前自动备份当前记忆库。发布源尚无清单时会显示相应提示。发布方式与接口见 [软件更新与发布](updates.zh.md)。

## 备份和恢复

「设置与连接 → 备份数据库」生成可单独打开的 `.sqlite` 文件。备份通过 SQLite 快照完成，包含 WAL 中已经提交的写入。备份不能覆盖当前打开的数据库。

恢复时先保留当前库的备份，再通过「打开其他记忆库」选择备份文件。Codex 和 DSH 如果也要使用恢复的库，需要同步修改它们的数据库路径。软件不会自动替换其他宿主的配置。

卸载程序会保留记忆数据。数据库升级前会生成 `.v<版本>.bak` 快照；程序拒绝打开比自身支持版本更新的数据库。

## Codex 接口

安装后打开「设置与连接」，复制软件生成的 Codex 配置，合并到现有 `config.toml`。该配置使用安装包自带的运行环境，因此不要求系统安装 Node.js。重启 MCP 连接或 Codex 后生效。

示意配置如下，**以软件实际生成的路径为准**：

```toml
[mcp_servers.memory_vault]
command = 'C:\实际安装目录\Memory Vault.exe'
args = ['C:\实际安装目录\resources\app.asar\bin\memory-vault.mjs', 'mcp', '--db', 'C:\Users\你的用户名\.dsh\memory-vault\vault.sqlite']
env = { ELECTRON_RUN_AS_NODE = "1" }
startup_timeout_sec = 20
tool_timeout_sec = 180
```

使用软件自带的 Node 模式启动 MCP，可避免 Windows 图形程序启动时的额外控制台输出。接口支持 MCP 初始化、工具发现、输入校验和 stdio 调用；无需另外启动本地 HTTP 服务。

可用工具：`memory_context`、`memory_group`、`memory_write`、`memory_recall`、`memory_assign`、`memory_apply`、`memory_summarize`、`memory_curate`、`memory_updates`、`memory_image`。

推荐在任务开始时调用 `memory_context` 或 `memory_recall`，在确认结论后调用 `memory_write`。为会话相关调用传入稳定且唯一的 `sessionId`，不同任务使用不同标识。`memory_apply` 返回已选择的知识正文；它不会自动注入 Codex 系统提示，也不会自动读取聊天记录。MCP 未连接独立模型服务，因此 `memory_summarize` 需要传入 `content`；AI 整理在桌面程序或 DSH 中执行。

源码环境可以直接运行：

```powershell
node --no-warnings bin/memory-vault.mjs mcp --db 'C:\你的路径\vault.sqlite'
```

Codex 的 MCP 配置格式依据 [OpenAI 官方说明](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)，内置运行环境的模式依据 [Electron 官方环境变量说明](https://www.electronjs.org/docs/latest/api/environment-variables#electron_run_as_node)。

## DSH 接口

原插件入口 `index.js`、浏览器面板 `client.js`、bundle 配置以及模型工具均保留，仍可按原方式安装。原来已经安装此目录时，更新文件后重启 `dsh web` 即可加载新代码。

```powershell
# 在 DSH 源码目录执行
pnpm dsh plugin --profile web add 'C:\Users\mdorn\Documents\deepseek-harness\default-workspace\dsh-memory-vault'
```

在 DSH 的 `cordis.patch.yml` 中保留原插件行，并让 `databasePath` 指向桌面软件正在使用的数据库。「设置与连接」也会提供该段配置。

```yaml
- id: memory-vault
  name: dsh-memory-vault
  config:
    databasePath: 'C:\你的路径\vault.sqlite'
```

DSH 继续在自己的会话内观察对话、触发总结和注入知识。SQLite WAL 与写入等待支持多个宿主同时连接。切换桌面数据库不会自动改变 DSH 正在打开的数据库。

## 独立 AI 整理

在「设置与连接 → AI 服务」填写兼容 Chat Completions 的服务地址、模型名和 API 密钥。服务地址包含 `/v1` 等实际前缀，不包含末尾的 `/chat/completions`。桌面程序只在点击整理或预览时调用该服务。配置留空时，人工管理和 Codex / DSH 数据接口照常可用。

密钥通过 Electron 的系统安全存储加密后保存，不会回传给窗口，也不写入数据库或源码。公开远程地址要求 HTTPS，本机地址允许 HTTP。更换服务时请同时换成相应密钥。

「预览」不修改数据；「AI 整理」应用模型建议。执行时会把所选候选记忆发送给配置的服务，并消耗该服务额度。截断响应、空响应、HTTP 错误和取消请求不会写入整理结果。

桌面 AI 服务使用单独配置；DSH 继续使用自身的模型路由。它们不读取或修改 Codex 的账户、模型或认证文件。

## 命令行与本地 RPC

源码调用需要 Node.js 22.5 或更高版本：

```powershell
node bin/memory-vault.mjs write --db 'C:\你的路径\vault.sqlite' --title '构建约定' --content '构建统一使用 pnpm。' --source codex
node bin/memory-vault.mjs recall --db 'C:\你的路径\vault.sqlite' --query '构建'
node bin/memory-vault.mjs serve --db 'C:\你的路径\vault.sqlite'
```

RPC 默认 `127.0.0.1:47321`，`POST /rpc` 传入同一套操作；请求带 `x-dsh-memory-vault: 1`。`GET /health` 检查服务。`memory-vault help` 列出命令。

## 开发与打包

```powershell
# 仓库根目录：完整核心、DSH 模拟宿主、CLI、RPC、桌面桥接、MCP 和独立功能回归
npm test

# 桌面运行环境和构建工具
npm --prefix desktop ci
npm run desktop

# Windows 安装包输出到 desktop/dist
npm run build:desktop
# 或仅生成完整运行目录
npm --prefix desktop run build:dir
```

`desktop/package-lock.json` 锁定桌面依赖。Electron 固定为 37.6.0，沿用在此机器验证可运行的版本。构建脚本把核心、CLI 和桌面入口放在同一个 `app.asar` 中，安装包内的相对导入和 MCP 路径不依赖源码目录。

真实窗口操作测试：

```powershell
# 请使用新的临时数据库和临时用户配置目录
desktop\node_modules\electron\dist\electron.exe desktop --selftest --test-module tests\desktop-ui.mjs --db 'C:\临时目录\ui.sqlite' --user-data 'C:\临时目录\userdata' --shot 'C:\临时目录\preview.png'
node tests\packaged-mcp.mjs 'desktop\dist\win-unpacked\Memory Vault.exe'
```

这些测试使用临时数据，不会读取真实记忆。DSH 回归使用模拟宿主；已有 DSH 部署的重启和真实模型的计费请求不属于自动测试。Windows 安装包未配置代码签名证书。
