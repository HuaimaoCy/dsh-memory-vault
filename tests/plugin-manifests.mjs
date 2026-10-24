/**
 * 插件清单守卫：ZCode / Codex 两个市场的 manifest 必须与 package.json 同版本，
 * 技能目录与 MCP 声明必须真实存在，避免「发了新版本但插件还指向旧技能」。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = file => JSON.parse(readFileSync(file, 'utf8'))
const pkg = read('package.json')
const zcode = read('.zcode-plugin/plugin.json')
const codex = read('.codex-plugin/plugin.json')
const market = read('marketplace.json')
const mcp = read('.mcp.json')

const NAME = 'alaya-notebook'
const SKILL = join('skills', NAME, 'SKILL.md')

assert.equal(zcode.name, NAME, 'ZCode 插件名')
assert.equal(codex.name, NAME, 'Codex 插件名')
assert.equal(zcode.version, pkg.version, 'ZCode 插件版本必须跟随 package.json')
assert.equal(codex.version, pkg.version, 'Codex 插件版本必须跟随 package.json')
assert.ok(existsSync(SKILL), `技能文件缺失：${SKILL}`)
assert.equal(zcode.skills, './skills/', '插件必须声明技能目录')
assert.equal(zcode.mcpServers, './.mcp.json', '插件必须声明 MCP 清单')

const skill = readFileSync(SKILL, 'utf8')
assert.match(skill, new RegExp(`^---\\nname: ${NAME}\\n`), 'SKILL.md frontmatter 的 name 必须与目录一致')
assert.match(skill, /\ndescription: \S/, 'SKILL.md 必须写 description')

const entry = market.plugins.find(plugin => plugin.name === NAME)
assert.ok(entry, '市场必须列出本插件')
assert.equal(entry.source, './', '插件源码位于仓库根目录')
assert.equal(entry.version, pkg.version, '市场条目版本必须跟随 package.json')

const server = mcp.mcpServers?.['alaya-notebook']
assert.ok(server, 'MCP 清单必须声明 alaya-notebook 服务')
assert.equal(server.command, 'node')
assert.deepEqual(server.args, ['bin/memory-vault.mjs', 'mcp'])
assert.ok(existsSync(server.args[0]), 'MCP 入口脚本必须存在')

console.log('Plugin manifests: ZCode + Codex 版本、技能与 MCP 声明一致')
