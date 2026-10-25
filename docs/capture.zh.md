# 统一捕获（Quick Capture）

一处输入，按目标落域：**知识库 / 对话记忆 / 笔记本**。面板只做「输入 + 选目标 + 保存」，
两个域各写各的通道，互不串域：

- 记忆域 → `window.vault.invoke('entry.write', …)`（由 `call` 注入）
- 笔记本域 → `window.vault.notebook('save', …)`，写成功后用 `notebook('list', …)` 回读确认

模块文件：`desktop/renderer/quick-capture.js`、`desktop/renderer/quick-capture.css`。
本模块**不内置全局快捷键**，由 `app.js` 接线（见下文），避免和命令面板（Ctrl/⌘ K）等既有入口重复触发。

## 交互

| 操作 | 行为 |
| --- | --- |
| 打开 | `<dialog>.showModal()`，焦点落在输入框；进入模态层，遮住下方界面 |
| `Esc` | 关闭面板（`cancel` 事件与 `keydown` 双重兜底） |
| `Enter` | 保存（单行输入直接回车即可） |
| `Shift + Enter` | 输入换行 |
| `Ctrl / ⌘ + Enter` | 保存（任何模式下都可用） |
| 输入法组字中 | `isComposing` / `keyCode === 229` 时**不**触发保存 |
| 保存成功 | 清空输入、面板保持打开、焦点回输入框，显示「已保存到「目标」 · 本次 N 条」 |
| 保存失败 | 保留输入、显示内联错误（`role="alert"`），可直接重试 |

分段控件选择的结果在多次捕获之间保持（`localStorage` 键 `alaya.db.capture`，只存 UI 偏好：
`mode`、`groupIds.knowledge`、`groupIds.conversation`、`noteType`、`tagsText`）。
会话累计条数只存在内存里，关掉应用即归零。
**绝不写数据库 meta 表**：切换目标、切分段都不发 IPC；只有保存与笔记本回读会发 IPC。

## API 契约（签名不可改）

```js
import { normalizeCaptureTargets, mountQuickCapture } from './quick-capture.js'

export function normalizeCaptureTargets({ groups, noteTypes })
// → [{ id, label, kind: 'memory'|'notebook', scope?: 'knowledge'|'conversation' }]

export function mountQuickCapture({ h, icon, call, notebook, say, mount, onStatus })
// → { open(target?), close(), isOpen(), toggle(target?), setTargets({groups, noteTypes}), destroy() }
```

### `normalizeCaptureTargets`

- `groups`：`state.data.groups` 的原样数组（`{id, name, path, scope}`）。`label` 为
  `path.join(' / ') + name`；缺 `name` 时退化到上级路径或「未命名分组」；`scope` 只认
  `conversation`，其余按 `knowledge`。**保持传入顺序**（即数据库的优先级 + 名称顺序）。
- `noteTypes`：`NOTE_TYPES` 对象、id 字符串数组、或 `{id|type|value, label|name}` 记录数组均可。
  输出顺序为「普通笔记优先」，其余保持声明顺序：`note → mistake → physics → method → vocabulary`。
- 坏数据（`null`/空对象/没有 id 的行/非法类型）一律跳过，永不抛错。

### `open(target?)`

三种写法：

```js
qc.open()                                        // 恢复上次的域与目标
qc.open('notebook')                              // 只切域：'knowledge' | 'conversation' | 'notebook'
qc.open({ mode: 'knowledge', groupId: 'g-1' })   // 切域并选中目标（笔记域用 noteType 或 groupId）
qc.open('g-1')                                   // 按目标 id 反推域并选中
```

`toggle()` 返回打开后的状态：打开 → `true`，关闭 → `false`。

### `setTargets({ groups, noteTypes })`

目标列表变化（切库、增删组、刷新）后调用；幂等、可传空数组，返回归一化后的目标数组。
当前选择仍存在则保留，否则落到该域第一个目标；没有目标时下拉禁用并显示可读提示，不崩。

### `onStatus`

保存/失败时回调一次，便于面板外的审计或状态条同步：

```js
onStatus({ tone: 'ok'|'err', message, count, mode, target: { id, label, kind } | null })
```

### 接线示例（app.js）

```js
import { mountQuickCapture } from './quick-capture.js'

const capture = mountQuickCapture({
  h, icon, call, notebook: (op, body) => window.vault.notebook(op, body).then(unwrap),
  say, mount: document.body,
})

// 每次 load() 之后同步目标（内存组 + 笔记类型）
capture.setTargets({ groups: state.data.groups, noteTypes: NOTE_TYPES })

// 快捷键（建议 Ctrl/⌘ + Shift + K）。app.js 的全局处理器只认不带 Shift 的
// Ctrl/⌘+K，不会冲突；面板打开时自身仍可被同一快捷键关掉。
window.addEventListener('keydown', event => {
  if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.key.toLowerCase() !== 'k') return
  if (event.defaultPrevented || event.isComposing) return
  // 已有别的对话框时不要叠在上面（自己的面板除外，那一路是用来关闭的）。
  if (!capture.isOpen() && document.querySelector('dialog[open]')) return
  event.preventDefault()
  capture.toggle()
})
```

> `call` / `notebook` 都按「已 unwrap 成 result」编写；若传入的仍是原始 `{ok, result}` 包装，
> 模块会自己解开（`ok !== true` 时抛出 `error`），方便接线期过渡。

## 保存 payload

### 记忆域

```js
await call('entry.write', {
  title: '<首行派生，最长 120 字>',
  content: '<trim 后的正文>',
  kind: 'note',
  tags: ['收件箱'],        // 默认；面板可改，逗号分隔、去空去重、上限 32
  scope: 'knowledge',      // 或 'conversation'
  groupId: '<记忆组 id>',
  priority: 0,
  base: false,
})
```

返回值必须能取到 `{ entry }`（或直接是带 `id` 的 entry），否则视为「保存返回异常」。
注意：库里会给人工写入自动补来源标签 `人工输入`，因此读回的 `tags` 会多这一项。

### 笔记本域

`notebook.save` 走 `MistakebookStore.save(raw)`。实测契约（必填/关键字段）：

| 字段 | 要求 |
| --- | --- |
| `type` | 必须是 `NOTE_TYPES` 的键之一（`mistake/physics/method/vocabulary/note`），缺省会被 normalize 成 `mistake`，**所以必须显式传** |
| `stem` | 各类型都要求非空（store 校验：无 `stem` 且无图片、且无结构化文本 → 报错）；捕获模块把正文放进 `stem` |
| `title` | 可选，最长 500；捕获模块用首行派生（最长 120） |
| `vocabulary.word` | `type === 'vocabulary'` 时必填（≤200 字）；模块把首行作为 word、其余作为 meaning |
| `images` / `tags` | 可选数组；模块传 `[]` |

模块实际发送：

```js
await notebook('save', { type: 'note', title: '<首行>', stem: '<正文>', images: [], tags: [] })
```

写成功后模块再发一次只读确认：

```js
await notebook('list', { view: 'all', limit: 10, type, order: 'updated' })
// 列表里找不到刚写入的 id → 视为保存失败（保留输入，提示刷新确认）
```

## 安全与风格

- 全部文本经 `textContent` / `value` 写入，模块内**没有** `innerHTML`。
- 无网络请求；只注入一份同源 `<link rel="stylesheet" href="quick-capture.css">`（CSP `default-src 'none'` 下允许）。
- 样式沿用 `styles.css` 的 `--surface / --fg / --fg-2 / --fg-3 / --line / --accent / --ok / --danger`；
  笔记本模式有自己局部的绿色强调色，而面板挂在 `body` 顶层，因此保持应用级强调色（如需统一可在接线时用
  `mount` 放进对应容器）。
- 面板没有入场动画（键盘入口不应动画）；`prefers-reduced-motion: reduce` 下整棵子树禁用动画/过渡。
- 所有控件有 `aria-label` / 可见文字，保存按钮带 `aria-keyshortcuts`，状态与错误分别用 `role="status"` /
  `role="alert"`；`<dialog>` 自带焦点约束，所有控件可 Tab 到达。

## 测试

```bash
node --no-warnings tests/capture-smoke.mjs          # 纯逻辑：归一化 / 标签 / 空正文 / 错误 / 偏好键
node --no-warnings tests/run-desktop-capture.mjs    # 真 Electron + 临时库：真写、真读回、错误路径
node --no-warnings tests/run-desktop-capture.mjs --shot test-tmp/capture-shots/capture-panel.png
```

- `tests/desktop-capture.mjs` 自己组装最小环境：从 `window.vault` 取真实 IPC，用与 `app.js` 相同的
  10 行 `h` 工厂挂载模块，创建临时记忆组，然后验证：
  打开即聚焦、样式注入、`aria`、组字中 Enter 不保存、记忆域真写并用 `entries` 读回（含自定义标签归一化）、
  对话记忆分段、笔记本域 `save` 后用 `notebook.list` 读回、笔记本内容不会出现在记忆域、
  偏好只落 `localStorage`、空正文被拒且不写库、IPC 抛错时输入保留 + 错误可见、空目标兜底、
  重挂载恢复偏好、`open(target)` / `toggle` / `Esc` / `destroy`。
- 测试只使用 `--db` 指向的临时 sqlite（`mkdtemp`），从不碰 `%USERPROFILE%\.dsh\memory-vault\vault.sqlite`。
