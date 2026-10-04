// 两条独立版本线（2026-10-05 起分离）：
// - CORE_VERSION：Alaya 数据库核心（dsh-memory-vault 包 / DSH 插件 / CLI / MCP），
//   随核心能力独立演进，发布标签 database-vX.Y.Z。
// - NOTEBOOK_VERSION：Alaya Notebook 桌面产品（Electron 应用与笔记本扩充），
//   独立演进，发布标签 notebook-vX.Y.Z，安装包与更新清单随它走。
// 两者可以长期不同号；构建守卫只要求各自与自己的 package.json 一致。
export const CORE_VERSION = '0.7.15'
export const NOTEBOOK_VERSION = '0.7.15'

// 兼容别名：核心侧（MCP serverInfo、CLI）沿用 VERSION。
export const VERSION = CORE_VERSION
