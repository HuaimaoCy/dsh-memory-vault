# 软件更新与发布

Memory Vault 0.6.2 支持 GitHub Releases 更新。软件启动后检查一次，运行期间每 6 小时检查；可在「设置与连接 → 软件更新」关闭自动检查或提醒，也可手动检查。

发现新版本时显示提示，窗口不在前台时可发送 Windows 通知。「稍后」隐藏本版本的提示，手动检查与下载仍可用。下载不影响编辑记忆。安装包大小与 SHA-256 校验通过后才能安装；安装前自动备份当前记忆库到软件用户数据目录下的 `updates` 文件夹，再打开安装程序并退出当前软件。用户在安装程序里完成更新。

默认更新清单：

`https://github.com/HuaimaoCy/Alaya-Database/releases/latest/download/latest.json`

更新清单尚未发布（404）会显示「发布源尚未提供更新清单」，不会误报为最新版本。网络错误、无效清单、下载中断和校验失败都可以重试。

## 发布新版本

1. Notebook 与统一桌面版使用 `src/version.js` 中的 `NOTEBOOK_VERSION`，同步 `desktop/package.json` 和 `desktop/package-lock.json` 的顶层版本及 `packages[""]` 版本。正式版的界面版本与包内版本相同，预览版可用 `0.8.1-alpha` 这类后缀。数据库核心使用 `CORE_VERSION`，与根目录 `package.json` 对应，独立编号。
2. 为 Notebook 更新 `docs/release-notes.txt`，这是更新弹窗使用的纯文本说明。完整 Markdown 放在 `docs/releases/<版本号>.zh.md`，从 README 链入。提交后在对应源码提交上创建 `notebook-v<版本号>` 标签，例如 `notebook-v0.8.3`。数据库核心发布标签使用 `database-v<版本号>`。
3. 在源码根目录运行 `npm run build:desktop` 生成统一版 `Alaya-<界面版本>-Setup.exe`，或加 `-- --product notebook` 构建 Notebook 独立版。正式版用实际安装包调用 `desktop/lib/release.mjs` 的 `writeReleaseManifest`，传入 `installer`、`output`、`version`、`notes` 和发布 `tag`，生成包含下载地址、大小与 SHA-256 的 `latest.json`。
4. 在 [Alaya-Database Releases](https://github.com/HuaimaoCy/Alaya-Database/releases) 使用相同标签发布，并附上匹配的安装包和 `latest.json`。预览版使用 prerelease。正式版发布后确认默认清单可读，再从旧版应用检查更新和下载。

清单里的下载地址包含版本标签与安装包文件名，两者必须与实际 Release 一致。修改安装包后必须重新构建或重新生成校验清单。软件当前提供 Windows x64 正式版本通道；不安装旧版本或预发布版本。

软件无需 GitHub 密钥。更新源可在设置的「发布源」内更改；生产源必须使用 HTTPS。本机开发测试允许 `localhost`、`127.0.0.1`、`[::1]` 的 HTTP 地址。

## Codex、DSH、CLI 与 RPC

- Codex MCP 与 DSH 插件新增 `memory_updates`，参数 `{"action":"status"}` 查询状态，`{"action":"check"}` 检查更新。安装和下载只由桌面界面发起。
- CLI：`memory-vault updates` 查询；`memory-vault updates --check` 检查。
- 通用操作接口：`updates.status` 与 `updates.check`。本地 RPC 示例：`POST /rpc`，请求头 `x-dsh-memory-vault: 1`，JSON 正文 `{"op":"updates.check"}`。
- 无桌面宿主时，可设置 `MEMORY_VAULT_UPDATE_URL` 指定清单地址。CLI、MCP 和 DSH 不在后台定时联网，只有显式检查时读取发布源；桌面设置与这些进程各自的配置分开。

更新返回 `currentVersion`、`status`、`lastChecked`、`release` 与 `error`。桌面额外返回下载进度和更新偏好。`release.notes` 是普通文本。发布源只接收更新请求，不接收记忆正文、数据库或模型密钥。
