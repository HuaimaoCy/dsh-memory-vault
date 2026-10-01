/** Optional model service used by the independent desktop app. */
export function validateModelSettings(raw = {}) {
  const baseUrl = String(raw.baseUrl ?? '').trim().replace(/\/+$/, '')
  const model = String(raw.model ?? '').trim()
  if (!baseUrl && !model) return { baseUrl: '', model: '' }
  if (!baseUrl || !model) throw new Error('请同时填写服务地址和模型名称')
  const url = new URL(baseUrl)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('模型服务请使用 HTTPS；本机服务可使用 HTTP')
  if (url.username || url.password || url.search || url.hash) throw new Error('服务地址不能包含凭据、查询参数或锚点')
  return { baseUrl, model }
}

export function createModelAdapter(getSettings, getKey) {
  return {
    resolveRoute() {
      const settings = getSettings()
      return settings.baseUrl && settings.model ? { provider: 'compatible', model: settings.model } : undefined
    },
    async callModel(call) {
      const settings = validateModelSettings(getSettings())
      if (!settings.baseUrl) throw new Error('请在设置中配置 AI 服务')
      const key = getKey()
      const signal = call.signal ? AbortSignal.any([call.signal, AbortSignal.timeout(call.timeoutMs ?? 120000)]) : AbortSignal.timeout(call.timeoutMs ?? 120000)
      const response = await fetch(`${settings.baseUrl}/chat/completions`, {
        method: 'POST', signal, redirect: 'error',
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ model: settings.model, stream: false, max_tokens: call.maxTokens, messages: [
          { role: 'system', content: call.system },
          ...call.messages.map(message => ({ role: message.role, content: typeof message.content === 'string' ? message.content : message.content.map(block => block.text ?? '').join('\n') })),
        ] }),
      })
      if (!response.ok) throw new Error(`模型服务返回 HTTP ${response.status}`)
      const data = await response.json()
      const choice = data.choices?.[0]
      if (choice?.finish_reason !== 'stop') throw new Error('模型响应未完整结束，未保存任何整理结果')
      const text = choice.message?.content
      if (typeof text !== 'string' || !text.trim()) throw new Error('模型返回空内容')
      return { text, usage: data.usage ?? null, provider: 'compatible', model: settings.model }
    },
  }
}
