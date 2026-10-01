#!/usr/bin/env node
/**
 * memory-vault — the vault's command line and local RPC interface.
 *
 * This is the surface non-DSH callers use: Codex (any agent that can run a
 * shell command or curl a loopback port), scripts, and people. It drives the
 * same host-free core (`src/core/vault.js`) and the same operation vocabulary
 * (`src/core/ops.js`) the DSH tools and the Web panel use, over the same
 * database file, so a memory written here is a memory DSH reads next turn —
 * and the other way around.
 *
 * Two modes:
 *
 * - CLI: `memory-vault recall --query "pnpm"` … every command is one process,
 *   one operation, JSON on stdout.
 * - `serve`: `memory-vault serve` starts a loopback JSON server (`POST /rpc`
 *   with `{ "op": "...", ...params }`) for callers that prefer HTTP — a
 *   browser-adjacent agent, a Codex MCP wrapper, anything that can curl.
 *
 * Database location: `--db <path>`, else `$MEMORY_VAULT_DB`, else the same
 * default the DSH plugin opens (`$DSH_HOME/memory-vault/vault.sqlite`).
 *
 * @module dsh-memory-vault/bin/memory-vault
 */

import { createServer } from 'node:http'
import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { IMAGE_MAX_BYTES } from '../src/images.js'
import { pathToFileURL } from 'node:url'
import { createMemoryVault } from '../src/core/vault.js'
import { VAULT_OPS, operateVault } from '../src/core/ops.js'
import { serveMcp } from '../src/mcp.js'

/** Default port for `serve`; loopback only unless explicitly overridden. */
const DEFAULT_PORT = 47321
const DEFAULT_HOST = '127.0.0.1'

/** Header every RPC caller must set — the same marker the DSH panel uses, so a cross-site form post cannot reach the vault either. */
const CLIENT_HEADER = 'x-dsh-memory-vault'

/** Largest RPC body accepted, in bytes. */
const MAX_RPC_BYTES = 32 * 1024 * 1024

/**
 * Parse CLI arguments into positionals and flags.
 *
 * `--key value`, `--key=value`, and boolean `--flag` are accepted; a flag may
 * repeat (`--tag a --tag b`), and later values append rather than overwrite.
 * @param {string[]} argv - Arguments after the command word.
 * @returns {{ positionals: string[], flags: Map<string, (string|true)[]> }} Parsed arguments.
 */
function parseArgs(argv) {
  /** @type {string[]} */
  const positionals = []
  /** @type {Map<string, (string|true)[]>} */
  const flags = new Map()
  for (let at = 0; at < argv.length; at += 1) {
    const token = argv[at]
    if (!token.startsWith('--')) {
      positionals.push(token)
      continue
    }
    const body = token.slice(2)
    const equals = body.indexOf('=')
    const key = equals === -1 ? body : body.slice(0, equals)
    if (key === '') continue
    if (equals !== -1) {
      push(flags, key, body.slice(equals + 1))
      continue
    }
    const next = argv[at + 1]
    if (next !== undefined && !next.startsWith('--')) {
      push(flags, key, next)
      at += 1
    } else {
      push(flags, key, true)
    }
  }
  return { positionals, flags }
}

/**
 * Append one flag value.
 * @param {Map<string, (string|true)[]>} flags - Flag store.
 * @param {string} key - Flag name.
 * @param {string|true} value - Value to append.
 */
function push(flags, key, value) {
  const list = flags.get(key) ?? []
  list.push(value)
  flags.set(key, list)
}

/**
 * Read one flag's single value.
 * @param {Map<string, (string|true)[]>} flags - Flag store.
 * @param {string} key - Flag name.
 * @returns {string|undefined} The last value, or undefined when absent or boolean.
 */
function option(flags, key) {
  const list = flags.get(key)
  const last = list?.[list.length - 1]
  return typeof last === 'string' ? last : undefined
}

/**
 * Read one flag's boolean truth.
 * @param {Map<string, (string|true)[]>} flags - Flag store.
 * @param {string} key - Flag name.
 * @returns {boolean} Whether the flag appeared truthy.
 */
function flag(flags, key) {
  const list = flags.get(key)
  const last = list?.[list.length - 1]
  return last === true || last === 'true' || last === 'on' || last === '1'
}

/**
 * Read one flag's values as a comma-separated list, or repeated flags.
 * @param {Map<string, (string|true)[]>} flags - Flag store.
 * @param {string} key - Flag name.
 * @returns {string[]|undefined} The joined values, or undefined when absent.
 */
function list(flags, key) {
  const list = flags.get(key)
  if (list === undefined || list.length === 0) return undefined
  return list.flatMap(value => (typeof value === 'string' ? value.split(',') : [])).map(part => part.trim()).filter(part => part !== '')
}

/**
 * The usage text, also the `help` command's output.
 * @returns {string} Usage.
 */
export function usage() {
  return [
    'memory-vault — 知识与记忆库的通用命令行接口（与 DSH 插件共用同一数据库）',
    '',
    '用法: memory-vault <command> [options]',
    '',
    '数据库位置: --db <path> 或 $MEMORY_VAULT_DB，默认与 DSH 插件相同（$DSH_HOME/memory-vault/vault.sqlite）。',
    '',
    '命令:',
    '  mcp [--session <id>]                              启动供 Codex 使用的 stdio MCP 接口',
    '  state                                             记忆库总览：统计、记忆组、标签、限额',
    '  groups [--scope conversation|knowledge]           列出记忆组（树形）',
    '  recall [--query q] [--group g] [--tag t]… [--scope s] [--limit n] [--offset n] [--include-hidden]',
    '                                                    检索记忆（query 为空格分隔关键词，全部命中）',
    '  show <id>                                         读取一条记忆的完整内容',
    '  write --content <text> [--group g] [--title t] [--kind k] [--tags a,b] [--scope s] [--priority n] [--base] [--source cli|codex|api]',
    '                                                    写入一条记忆（默认标记来源 cli）',
    '  edit <id> [--content …] [--title …] [--tags …] [--priority …] [--base on|off]',
    '                                                    修改一条记忆',
    '  delete <id> [id…]                                 删除记忆',
    '  hide <id> [id…] / unhide <id> [id…]               隐藏或恢复记忆',
    '  group create <name> [--scope s] [--parent p] [--description d] [--priority n] [--auto-summary] [--tags a,b]',
    '  group update <ref> [--name …] [--scope …] [--parent …] [--priority …] [--auto-summary on|off]',
    '  group delete <ref>                                删除记忆组（组内条目移回默认组）',
    '  assign --ids a,b [--scope s] [--group g] [--priority n] [--base on|off]',
    '                                                    调整记忆归属/优先级/底层标记',
    '  bind --session <id> [--group g]                   绑定（或用 --reset 解绑）会话的总结目标组',
    '  apply get <sessionId>                             查看某会话应用了哪些记忆',
    '  apply set <sessionId> (--groups a,b | --none | --reset) [--entries e1,e2]',
    '                                                    设置某会话应用的记忆组',
    '  observe --session <id> --role user|assistant --text <t> [--seq n]',
    '                                                    向会话转录追加一条消息（无事件流的宿主用）',
    '  threshold --session <id>                          查看自动总结阈值状态',
    '  summarize --session <id> --content <text> [--group g] [--title t] [--scope s]',
    '                                                    把结论固化为一条总结记忆（由调用方书写正文）',
    '  rpc --op <op> [--json \'{"k":v}\']                   直接调用面板同款 op 接口',
    `  serve [--port ${String(DEFAULT_PORT)}] [--host ${DEFAULT_HOST}]    启动本地 JSON RPC 服务（POST /rpc）`,
    '  help                                              显示本说明',
    '  updates [--check]                                 查询版本；--check 检查发布源',
    '  image list <entryId> | read <imageId> | remove <imageId>',
    '  image add <entryId> --file <图片路径>                添加图片附件',
    '',
    'serve 模式:',
    `  POST /rpc  body {"op":"…",…参数} → {"ok":true,"result":…}；请求需带 ${CLIENT_HEADER}: 1 头。`,
    '  GET  /health → {"ok":true}。服务只监听回环地址，除非 --host 另行指定。',
    '',
    '所有命令输出 JSON（stdout）；错误打印到 stderr 并以退出码 1 结束。',
  ].join('\n')
}

/**
 * Build the vault from CLI-level flags.
 * @param {Map<string, (string|true)[]>} flags - Parsed flags.
 * @returns {Record<string, any>} A vault handle.
 */
function vaultFrom(flags) {
  /** @type {Record<string, unknown>} */
  let config = {}
  const configFile = option(flags, 'config')
  if (configFile !== undefined) {
    config = JSON.parse(readFileSync(configFile, 'utf8'))
  }
  return createMemoryVault({
    databasePath: option(flags, 'db') ?? process.env.MEMORY_VAULT_DB,
    config,
  })
}

/**
 * Build the op body for one command word.
 *
 * CLI commands are sugar over the shared op vocabulary; this is the only place
 * the mapping lives, so the CLI can never drift from what the panel serves.
 * @param {string} command - Command word.
 * @param {{ positionals: string[], flags: Map<string, (string|true)[]> }} parsed - Parsed arguments.
 * @returns {{ body: Record<string, unknown>, vault?: Record<string, any> } | { direct: 'summarize'|'observe'|'threshold'|'show'|'serve'|'help', … }} The operation to run.
 */
function commandToOp(command, parsed) {
  const { positionals, flags } = parsed
  const body = { op: '' }
  switch (command) {
    case 'image': {
      const action = positionals[0], id = positionals[1]
      if (!id) throw new Error('image 需要记忆或图片 ID')
      if (action === 'list') return { body: { op: 'image.list', entryId: id } }
      if (action === 'read') return { body: { op: 'image.read', id } }
      if (action === 'remove') return { body: { op: 'image.delete', id } }
      if (action === 'add') {
        const file = option(flags, 'file')
        if (!file) throw new Error('image add 需要 --file 图片路径')
        const metadata = statSync(file)
        if (!metadata.isFile() || metadata.size > IMAGE_MAX_BYTES) throw new Error('每张图片不能超过 10 MB')
        return { body: { op: 'image.add', entryId: id, name: basename(file), data: readFileSync(file).toString('base64') } }
      }
      throw new Error('image action 必须为 list/read/add/remove')
    }
    case 'updates':
      return { body: { op: flag(flags, 'check') ? 'updates.check' : 'updates.status' } }
    case 'state':
      body.op = 'state'
      return { body }
    case 'groups':
    case 'list':
      body.op = 'state'
      return { body }
    case 'recall':
    case 'search':
      body.op = 'entries'
      body.query = option(flags, 'query')
      body.group = option(flags, 'group')
      const tags = list(flags, 'tag')
      if (tags !== undefined) body.tag = tags
      body.scope = option(flags, 'scope')
      body.includeHidden = flag(flags, 'include-hidden')
      if (option(flags, 'limit') !== undefined) body.limit = Number(option(flags, 'limit'))
      if (option(flags, 'offset') !== undefined) body.offset = Number(option(flags, 'offset'))
      return { body }
    case 'show': {
      const id = positionals[0]
      if (id === undefined) throw new Error('show 需要一个记忆 id')
      return { direct: 'show', id }
    }
    case 'write':
      body.op = 'entry.write'
      body.content = option(flags, 'content')
      body.group = option(flags, 'group') ?? '知识库'
      body.title = option(flags, 'title')
      body.kind = option(flags, 'kind')
      const writeTags = list(flags, 'tags')
      if (writeTags !== undefined) body.tags = writeTags
      body.scope = option(flags, 'scope')
      if (option(flags, 'priority') !== undefined) body.priority = Number(option(flags, 'priority'))
      body.base = flag(flags, 'base')
      body.source = option(flags, 'source')
      return { body }
    case 'edit':
      body.op = 'entry.update'
      body.id = positionals[0]
      body.content = option(flags, 'content')
      body.title = option(flags, 'title')
      body.kind = option(flags, 'kind')
      const editTags = list(flags, 'tags')
      if (editTags !== undefined) body.tags = editTags
      if (option(flags, 'priority') !== undefined) body.priority = Number(option(flags, 'priority'))
      if (flags.has('base')) body.base = flag(flags, 'base')
      if (body.id === undefined) throw new Error('edit 需要一个记忆 id')
      return { body }
    case 'delete':
    case 'rm':
      body.op = 'entry.delete'
      body.id = positionals[0]
      if (body.id === undefined) throw new Error('delete 需要至少一个记忆 id')
      return { body }
    case 'hide':
    case 'unhide': {
      if (positionals.length === 0) throw new Error(`${command} 需要至少一个记忆 id`)
      return { body: { op: 'entry.hide', ids: positionals, hidden: command === 'hide' } }
    }
    case 'group': {
      const action = positionals[0]
      if (action === 'create') {
        return { body: {
          op: 'group.create',
          name: positionals[1],
          scope: option(flags, 'scope'),
          parent: option(flags, 'parent'),
          description: option(flags, 'description'),
          priority: option(flags, 'priority') !== undefined ? Number(option(flags, 'priority')) : undefined,
          autoSummary: flag(flags, 'auto-summary'),
          tags: list(flags, 'tags') ?? [],
        } }
      }
      if (action === 'update') {
        const set = { op: 'group.update', id: positionals[1] }
        if (set.id === undefined) throw new Error('group update 需要一个记忆组名称或 id')
        if (option(flags, 'name') !== undefined) set.name = option(flags, 'name')
        if (option(flags, 'scope') !== undefined) set.scope = option(flags, 'scope')
        if (option(flags, 'parent') !== undefined) set.parent = option(flags, 'parent')
        if (option(flags, 'description') !== undefined) set.description = option(flags, 'description')
        if (option(flags, 'priority') !== undefined) set.priority = Number(option(flags, 'priority'))
        if (flags.has('auto-summary')) set.autoSummary = flag(flags, 'auto-summary')
        return { body: set }
      }
      if (action === 'delete') {
        const ref = positionals[1]
        if (ref === undefined) throw new Error('group delete 需要一个记忆组名称或 id')
        return { body: { op: 'group.delete', id: ref } }
      }
      if (action === 'list' || action === undefined) return { body: { op: 'state' } }
      throw new Error(`未知的 group 子命令「${String(action)}」；可用：create / update / delete / list`)
    }
    case 'assign': {
      const ids = list(flags, 'ids')
      if (ids === undefined || ids.length === 0) throw new Error('assign 需要 --ids a,b')
      if (option(flags, 'priority') !== undefined) {
        return { body: { op: 'assign', ids, priority: Number(option(flags, 'priority')) } }
      }
      if (flags.has('base')) {
        return { body: { op: 'assign', ids, base: flag(flags, 'base') } }
      }
      return { body: { op: 'assign', ids, scope: option(flags, 'scope'), targetGroup: option(flags, 'group') } }
    }
    case 'bind': {
      const sessionId = option(flags, 'session')
      if (sessionId === undefined) throw new Error('bind 需要 --session <id>')
      const groupRef = option(flags, 'group')
      return { body: { op: 'session.bind', sessionId, group: flag(flags, 'reset') ? null : groupRef ?? null } }
    }
    case 'apply': {
      const action = positionals[0]
      const sessionId = positionals[1]
      if (action === 'get') {
        if (sessionId === undefined) throw new Error('apply get 需要 <sessionId>')
        return { body: { op: 'apply.get', sessionId } }
      }
      if (action === 'set') {
        if (sessionId === undefined) throw new Error('apply set 需要 <sessionId>')
        let groups
        if (flag(flags, 'reset')) groups = null
        else if (flag(flags, 'none')) groups = []
        else {
          const named = list(flags, 'groups')
          if (named === undefined) throw new Error('apply set 需要 --groups a,b，或 --none / --reset')
          groups = named
        }
        const entries = list(flags, 'entries')
        return { body: { op: 'apply.set', sessionId, groups, entries: entries ?? [] } }
      }
      throw new Error(`未知的 apply 子命令「${String(action)}」；可用：get / set`)
    }
    case 'observe': {
      const sessionId = option(flags, 'session')
      const role = option(flags, 'role')
      const text = option(flags, 'text')
      if (sessionId === undefined || (role !== 'user' && role !== 'assistant') || text === undefined) {
        throw new Error('observe 需要 --session <id> --role user|assistant --text <内容>')
      }
      const seq = option(flags, 'seq')
      return { direct: 'observe', sessionId, role, text, seq: seq === undefined ? Date.now() : Number(seq) }
    }
    case 'threshold': {
      const sessionId = option(flags, 'session')
      if (sessionId === undefined) throw new Error('threshold 需要 --session <id>')
      return { direct: 'threshold', sessionId }
    }
    case 'summarize': {
      const sessionId = option(flags, 'session')
      const content = option(flags, 'content')
      if (sessionId === undefined) throw new Error('summarize 需要 --session <id>')
      if (content === undefined) {
        throw new Error('命令行环境没有接入模型服务，summarize 需要 --content <正文>（由调用方书写记忆正文）')
      }
      return {
        direct: 'summarize',
        sessionId,
        content,
        groupReference: option(flags, 'group'),
        title: option(flags, 'title'),
        scope: option(flags, 'scope'),
      }
    }
    case 'rpc': {
      const op = option(flags, 'op')
      if (op === undefined) {
        throw new Error(`rpc 需要 --op <op>；可用：${Object.keys(VAULT_OPS).join(', ')}`)
      }
      const extra = option(flags, 'json')
      const body = extra === undefined ? {} : JSON.parse(extra)
      return { body: { ...body, op } }
    }
    case 'serve':
      return { direct: 'serve' }
    case 'mcp':
      return { direct: 'mcp' }
    case 'help':
    case '--help':
    case '-h':
      return { direct: 'help' }
    default:
      throw new Error(`未知命令「${command}」；运行 memory-vault help 查看用法`)
  }
}

/**
 * Run one CLI invocation.
 * @param {string[]} argv - Arguments after the program name.
 * @param {{ stdout?: (text: string) => void, stderr?: (text: string) => void }} [io] - Output sinks, for tests.
 * @returns {Promise<number>} Process exit code.
 */
export async function runCli(argv, io = {}) {
  const stdout = io.stdout ?? ((text) => { process.stdout.write(text) })
  const stderr = io.stderr ?? ((text) => { process.stderr.write(text) })
  if (argv.length === 0) {
    stderr(`${usage()}\n`)
    return 1
  }
  const command = argv[0]
  const parsed = parseArgs(argv.slice(1))
  let vault
  // The server owns its vault for its whole lifetime and disposes of it on
  // shutdown; every one-shot command closes before exiting.
  let vaultLivesOn = false
  try {
    const plan = commandToOp(command, parsed)
    if ('direct' in plan && plan.direct === 'help') {
      stdout(`${usage()}\n`)
      return 0
    }
    vault = vaultFrom(parsed.flags)
    if ('direct' in plan && plan.direct === 'mcp') {
      vaultLivesOn = true
      const server = serveMcp(vault, { sessionId: option(parsed.flags, 'session') })
      const stop = () => server.close()
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
      await server.done
      process.removeListener('SIGINT', stop)
      process.removeListener('SIGTERM', stop)
      return 0
    }
    const deps = { store: vault.store, config: vault.config, notify: vault.notify, curate: vault.curate, updates: vault.updates }
    let result
    if ('direct' in plan) {
      switch (plan.direct) {
        case 'show': {
          const entry = vault.store.findEntry(plan.id)
          if (entry === undefined) throw new Error(`记忆 ${plan.id} 不存在`)
          result = { entry }
          break
        }
        case 'observe':
          vault.observe({ sessionId: plan.sessionId, role: plan.role, text: plan.text, seq: plan.seq })
          result = { observed: true, sessionId: plan.sessionId, role: plan.role }
          break
        case 'threshold':
          result = { sessionId: plan.sessionId, ...vault.threshold(plan.sessionId), summarizing: vault.isSummarizing(plan.sessionId) }
          break
        case 'summarize':
          result = await vault.summarize({
            session: { id: plan.sessionId },
            groupReference: plan.groupReference,
            scope: plan.scope,
            content: plan.content,
            title: plan.title,
            full: false,
            mode: 'manual',
          })
          break
        case 'serve': {
          vaultLivesOn = true
          // A literal `--port 0` ("assign one") must survive the default.
          const portOption = option(parsed.flags, 'port')
          const port = portOption === undefined ? DEFAULT_PORT : Number(portOption)
          if (!Number.isInteger(port) || port < 0 || port > 65535) {
            throw new Error(`--port 必须是 0-65535 的整数，收到「${String(portOption)}」`)
          }
          return await serve({ vault, port, host: option(parsed.flags, 'host') ?? DEFAULT_HOST, stdout, stderr })
        }
        default:
          throw new Error(`未实现的命令分支「${String(plan.direct)}」`)
      }
    } else {
      result = await operateVault(deps, plan.body)
    }
    stdout(`${JSON.stringify(result, null, 2)}\n`)
    return 0
  } catch (error) {
    stderr(`memory-vault: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  } finally {
    if (vault !== undefined && !vaultLivesOn) {
      try { vault.dispose() } catch (_error) { /* closing twice is harmless to ignore here */ }
    }
  }
}

/**
 * Start the loopback JSON RPC server.
 *
 * The surface is the same op vocabulary the panel serves, over the same
 * validation, with the same anti-cross-site rule: every call carries the
 * client marker header a browser form cannot set, and a mismatched Origin is
 * refused. The server binds loopback by default; binding more is the
 * operator's explicit choice.
 * @param {object} options - Server options.
 * @param {Record<string, any>} options.vault - Vault handle.
 * @param {number} options.port - Listen port.
 * @param {string} options.host - Listen host.
 * @param {(text: string) => void} [options.stdout] - Startup log sink.
 * @param {(text: string) => void} [options.stderr] - Error log sink.
 * @param {(address: { port: number, host: string, close: () => void }) => void} [options.onListening] - Resolved listen address plus a shutdown handle; port 0 is supported for tests.
 * @returns {Promise<number>} Resolves when the server stops.
 */
export function serve({ vault, port, host, stdout, stderr, onListening }) {
  const deps = { store: vault.store, config: vault.config, notify: vault.notify, curate: vault.curate, updates: vault.updates }
  const server = createServer((req, res) => {
    void handleRpc(req, res, deps).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      stderr?.(`memory-vault: rpc failure: ${message}\n`)
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: message }))
      } else {
        res.end()
      }
    })
  })
  const shutdown = () => {
    server.close()
    try { vault.dispose() } catch (_error) { /* already closing */ }
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  return new Promise((resolve) => {
    server.on('close', () => resolve(0))
    server.listen(port, host, () => {
      const address = server.address()
      const resolved = { port: typeof address === 'object' && address !== null ? address.port : port, host }
      stdout?.(`memory-vault: rpc server listening on http://${resolved.host}:${String(resolved.port)} (POST /rpc, header ${CLIENT_HEADER}: 1)\n`)
      onListening?.({ ...resolved, close: shutdown })
    })
    server.on('error', (error) => {
      stderr?.(`memory-vault: rpc server failed: ${error instanceof Error ? error.message : String(error)}\n`)
      resolve(1)
    })
  })
}

/**
 * Handle one RPC request.
 * @param {import('node:http').IncomingMessage} req - Request.
 * @param {import('node:http').ServerResponse} res - Response.
 * @param {Record<string, unknown>} deps - Vault services for {@link operateVault}.
 * @returns {Promise<void>}
 */
async function handleRpc(req, res, deps) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true, service: 'memory-vault' }))
    return
  }
  if (url.pathname !== '/rpc') {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: `unknown path ${url.pathname}` }))
    return
  }
  if ((req.method ?? '') !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: 'rpc requires POST' }))
    return
  }
  if (req.headers[CLIENT_HEADER] === undefined) {
    res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: `missing ${CLIENT_HEADER} header` }))
    return
  }
  // A same-origin browser call is fine; a mismatched Origin is a cross-site
  // attempt and is refused before any state is touched.
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
    const host = req.headers.host
    let originHost
    try {
      originHost = new URL(origin).host
    } catch (_error) {
      originHost = undefined
    }
    if (host === undefined || originHost !== host) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: 'cross-origin request refused' }))
      return
    }
  }
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > MAX_RPC_BYTES) throw new Error(`request body exceeds ${String(MAX_RPC_BYTES)} bytes`)
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  const body = text.trim() === '' ? {} : JSON.parse(text)
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('rpc body must be a JSON object')
  }
  try {
    const result = await operateVault(deps, body)
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true, result }))
  } catch (error) {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
  }
}

// Direct execution only; importing the module (tests) skips this.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli(process.argv.slice(2))
}
