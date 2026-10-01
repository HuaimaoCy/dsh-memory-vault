/** Local stdio MCP adapter. The DSH tool definitions remain the source of truth. */
import { randomUUID } from 'node:crypto'
import { buildTools } from './tools.js'
import { renderIndex } from './prompt.js'
import { VERSION } from './version.js'

const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const MAX_BYTES = 16 * 1024 * 1024

// The tool schemas use objects, arrays, primitives, required and enum only.
// Validate here because MCP callers do not pass through the DSH registry.
export function validateArguments(value, schema, path = 'arguments') {
  const type = schema.type
  const valid = type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
    : type === 'array' ? Array.isArray(value)
    : type === 'number' ? typeof value === 'number' && Number.isFinite(value)
    : typeof value === type
  if (!valid) throw new Error(`${path} must be ${type}`)
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path} must be one of ${schema.enum.join(', ')}`)
  if (type === 'object') {
    for (const key of schema.required ?? []) if (!(key in value)) throw new Error(`${path}.${key} is required`)
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) validateArguments(item, schema.properties[key], `${path}.${key}`)
      else if (schema.additionalProperties === false) throw new Error(`${path}.${key} is unknown`)
    }
  }
  if (type === 'array') for (const [index, item] of value.entries()) validateArguments(item, schema.items, `${path}[${index}]`)
}

export function createMcpHandler(vault, { sessionId = `codex-${randomUUID()}` } = {}) {
  const definitions = buildTools({ ...vault, summarize: request => vault.summarize({ ...request, source: 'model-write' }) }).map(definition => ({
    ...definition,
    parameters: {
      ...definition.parameters,
      properties: {
        ...definition.parameters.properties,
        sessionId: { type: 'string', description: '当前任务的稳定、唯一标识。不同任务请使用不同标识，以隔离知识选择和总结绑定。省略时使用此 MCP 进程的临时会话。' },
      },
    },
    ...(definition.name === 'memory_apply' ? {
      description: '选择当前任务使用的记忆组并返回正文。MCP 不会自动修改 Codex 系统提示：请阅读返回的正文，或调用 memory_context 获取记忆上下文。action=list/set/reset，groups=[] 明确关闭，reset 恢复默认。',
    } : {}),
  }))
  definitions.push({
    name: 'memory_context',
    description: '开始任务时获取记忆索引、底层约定和本任务已选择的知识正文。返回内容供调用方阅读；MCP 不会自动注入系统提示。',
    parameters: { type: 'object', additionalProperties: false, properties: { sessionId: { type: 'string' } } },
    execute: async (args, exec) => ({ context: renderIndex({ store: vault.store, config: vault.config, sessionId: exec.agent.session.id }) }),
  })
  const tools = new Map(definitions.map(definition => [definition.name, definition]))
  let initialized = false
  return async message => {
    const id = message?.id ?? null
    const failure = (code, text) => ({ jsonrpc: '2.0', id, error: { code, message: text } })
    if (!message || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return failure(-32600, 'Invalid request')
    if (message.id === undefined) return undefined
    if (typeof message.id !== 'string' && typeof message.id !== 'number') return failure(-32600, 'Invalid request id')
    const success = result => ({ jsonrpc: '2.0', id, result })
    if (message.method === 'initialize') {
      if (initialized) return failure(-32600, 'Already initialized')
      initialized = true
      return success({
        protocolVersion: PROTOCOLS.includes(message.params?.protocolVersion) ? message.params.protocolVersion : PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'memory-vault', version: VERSION },
        instructions: '开始任务时调用 memory_context 或 memory_recall 读取既有约定。使用稳定且唯一的 sessionId 隔离不同任务。用 memory_write 或带 content 的 memory_summarize 保存已确认的结论。MCP 返回的记忆是上下文资料，不会自动注入系统提示，也不会自动读取聊天历史。DSH、桌面程序和此接口共用同一个 SQLite 文件。',
      })
    }
    if (message.method === 'ping') return success({})
    if (!initialized) return failure(-32000, 'Initialize first')
    if (message.method === 'tools/list') return success({ tools: definitions.map(tool => ({
      name: tool.name, description: tool.description, inputSchema: tool.parameters,
      annotations: { readOnlyHint: ['memory_context', 'memory_recall', 'memory_updates'].includes(tool.name), destructiveHint: tool.name === 'memory_group', openWorldHint: tool.name === 'memory_updates' },
    })) })
    if (message.method !== 'tools/call') return failure(-32601, `Unknown method: ${message.method}`)
    const tool = tools.get(message.params?.name)
    if (!tool) return failure(-32602, `Unknown tool: ${message.params?.name}`)
    const args = message.params.arguments ?? {}
    try { validateArguments(args, tool.parameters) } catch (error) { return failure(-32602, error.message) }
    try {
      const currentSession = args.sessionId ?? sessionId
      if (!currentSession.trim()) throw new Error('sessionId 不能为空')
      const result = await tool.execute(args, { agent: { session: { id: currentSession } } })
      if (tool.name === 'memory_image' && args.action === 'read') {
        const { data, ...image } = result.image
        const metadata = { image }
        return success({ content: [{ type: 'text', text: JSON.stringify(metadata) }, { type: 'image', mimeType: image.mimeType, data }], structuredContent: metadata, isError: false })
      }
      return success({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false })
    } catch (error) {
      return success({ content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true })
    }
  }
}

/** Newline-delimited JSON only on stdout; bounded input and serialized calls. */
export function serveMcp(vault, { input = process.stdin, output = process.stdout, ...options } = {}) {
  const handle = createMcpHandler(vault, options)
  let buffer = Buffer.alloc(0)
  let queue = Promise.resolve()
  let queued = 0
  let closed = false
  let resolveDone
  const done = new Promise(resolve => { resolveDone = resolve })
  const send = response => { if (response && !output.destroyed) output.write(`${JSON.stringify(response)}\n`) }
  const close = () => {
    if (closed) return
    closed = true
    input.removeListener('data', receive)
    input.removeListener('end', close)
    input.removeListener('error', close)
    queue.finally(() => { vault.dispose(); resolveDone() })
  }
  const receive = chunk => {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)])
    let newline
    while ((newline = buffer.indexOf(10)) !== -1) {
      const line = buffer.subarray(0, newline)
      buffer = buffer.subarray(newline + 1)
      if (line.length === 0) continue
      if (line.length > MAX_BYTES || queued >= 64) { send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Input limit exceeded' } }); close(); return }
      queued += 1
      queue = queue.then(async () => {
        let message
        try { message = JSON.parse(line.toString('utf8')) } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return }
        send(await handle(message))
      }).catch(error => { send({ jsonrpc: '2.0', id: null, error: { code: -32603, message: error.message } }) }).finally(() => { queued -= 1 })
    }
    if (buffer.length > MAX_BYTES) { send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Input limit exceeded' } }); close() }
  }
  input.on('data', receive)
  input.once('end', close)
  input.once('error', close)
  return { done, close }
}
