# 图片记忆

0.6.3 起支持图片附件。图片原始字节保存在同一个 SQLite 记忆库中，不依赖原文件路径，也不会自动上传到网络。备份、恢复或复制数据库时，图片一并保留。

## 在软件中使用

1. 打开或新建一条记忆，在详情的「图片」区域点击「添加图片」。也可以把图片拖到提示区域，或在编辑器中粘贴截图。
2. 支持 PNG、JPEG、WebP、GIF。单张最多 10 MB，一条记忆最多 16 张、总计 20 MB，单张最多 4000 万像素，宽高各不超过 16384。
3. 点击「创建记忆」或「保存修改」，正文和图片会一起保存。可以只添加图片，不填写正文。
4. 点击缩略图查看大图；「移除」先修改草稿，保存后生效。只有图片的记忆不能移除最后一张并保存为空；可补写正文，或删除整条记忆。

重复图片在同一记忆内只保存一份。隐藏记忆会保留图片；删除记忆会同时删除它的附件。图片名称按普通文本显示，不作为磁盘路径使用。

DSH 面板提供同样的添加、截图粘贴、预览和保存操作。更新原插件目录后需要重启 DSH，才能启用新的图片接口。

## 助手接口

Codex MCP 与 DSH 增加 `memory_image`：

| action | 参数 | 返回 |
| --- | --- | --- |
| `list` | `entryId` | 图片 ID、名称、类型、尺寸、大小、校验值 |
| `read` | `id` | 图片及其元信息 |
| `add` | `entryId`、`data`（Base64），可选 `name`、`mimeType` | 当前图片清单 |
| `remove` | `id` | 被移除图片的元信息 |

Codex 的 `read` 返回原生 MCP 图片内容块，不将 Base64 重复写入结构化结果。DSH 会通过宿主 `ctx.attachments.saveImage` 将图像转换为持久图片引用，供会话与支持图像输入的模型读取；宿主缺少图片服务时明确报错。模型是否理解图片取决于所用模型的图像能力。

`memory_recall` 返回 `imageCount`，提醒助手按需调用图片工具。普通记忆上下文不自动附带图片，以免每次读取记忆都发送图像。

上述 DSH 持久图片引用按照 [DSH 官方附件接口](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/attachment.md) 实现。

## CLI 与通用操作

```powershell
memory-vault image add <记忆ID> --file 'C:\图片目录\截图.png'
memory-vault image list <记忆ID>
memory-vault image read <图片ID>
memory-vault image remove <图片ID>
```

通用操作为 `image.list`、`image.read`、`image.add`、`image.delete`。本地 RPC 仍使用 `POST /rpc` 与请求头 `x-dsh-memory-vault: 1`；DSH 面板仍使用原 `/memory-vault` 路由。

`entry.write` 和 `entry.update` 可以提供 `images` 数组，与正文作为一个事务保存。新增图片形如 `{ "name": "截图.png", "mimeType": "image/png", "data": "Base64…" }`；编辑时保留已有图片用 `{ "id": "img_…" }`。不传 `images` 会保留原附件，传空数组会移除附件；引用其他记忆的图片 ID 会拒绝整个操作。

首次打开旧数据库会升级到 schema 7，并生成 `.v6.bak` 快照。请让桌面程序、CLI 与 DSH 使用同一版本；旧版软件会拒绝重新打开新结构的数据库。
