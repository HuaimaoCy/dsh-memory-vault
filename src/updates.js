import { VERSION } from './version.js'

// 发布与更新源统一在 Alaya 仓库：笔记本版本打 notebook-vX.Y.Z 标签、安装包与
// latest.json 随该 release 发布；数据库核心版本打 database-vX.Y.Z 标签。为了让
// releases/latest 始终可用，仓库里的每份 release 都会附带 latest.json。
export const RELEASE_REPOSITORY = 'HuaimaoCy/Alaya-Database'
export const DEFAULT_UPDATE_URL = `https://github.com/${RELEASE_REPOSITORY}/releases/latest/download/latest.json`
export const MAX_INSTALLER_BYTES = 1024 * 1024 * 1024

export function updateUrl(value) {
  const url = new URL(value)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) throw new Error('更新地址必须使用 HTTPS（本机测试可使用 HTTP）')
  return url.href
}
function versionParts(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) throw new Error('更新版本号格式无效')
  const parts = value.split('.').map(Number)
  if (parts.some(part => !Number.isSafeInteger(part))) throw new Error('更新版本号超出范围')
  return parts
}
export function compareVersions(left, right) {
  const a = versionParts(left), b = versionParts(right)
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1
  return 0
}
export function parseRelease(value, platform = `${process.platform}-${process.arch}`) {
  if (!value || value.schemaVersion !== 1 || value.product !== 'memory-vault' || value.channel !== 'stable') throw new Error('更新清单与此软件不匹配')
  versionParts(value.version)
  const asset = value.assets?.[platform]
  if (!asset) throw new Error(`此更新没有适用于 ${platform} 的安装包`)
  if (typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(asset.sha256)) throw new Error('安装包校验信息无效')
  if (!Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > MAX_INSTALLER_BYTES) throw new Error('安装包大小无效')
  if (typeof value.notes !== 'string' || value.notes.length > 20000) throw new Error('更新说明格式无效')
  return {
    version: value.version, notes: value.notes,
    publishedAt: typeof value.publishedAt === 'string' ? value.publishedAt.slice(0, 100) : null,
    releaseUrl: updateUrl(value.releaseUrl),
    asset: { url: updateUrl(asset.url), sha256: asset.sha256.toLowerCase(), size: asset.size },
  }
}
// Follow redirects explicitly so every destination is checked before requesting it.
export async function fetchUpdate(url, { signal, fetchImpl = fetch } = {}) {
  let current = updateUrl(url)
  for (let i = 0; i < 7; i++) {
    const response = await fetchImpl(current, { signal, redirect: 'manual', headers: { 'User-Agent': 'Memory-Vault-Updater', Accept: 'application/json, application/octet-stream' } })
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    const location = response.headers.get('location')
    await response.body?.cancel()
    if (!location) throw new Error('更新服务器的跳转地址缺失')
    const next = updateUrl(new URL(location, current).href)
    if (new URL(current).protocol === 'https:' && new URL(next).protocol !== 'https:') throw new Error('更新服务器跳转到不安全的地址')
    current = next
  }
  throw new Error('更新服务器跳转次数过多')
}
export async function readBounded(response, maximum) {
  if (Number(response.headers.get('content-length')) > maximum) { await response.body?.cancel(); throw new Error('更新清单过大') }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('更新服务器返回空内容')
  const chunks = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > maximum) throw new Error('更新清单过大')
      chunks.push(Buffer.from(value))
    }
  } finally { await reader.cancel().catch(() => {}) }
  return Buffer.concat(chunks, size).toString('utf8')
}

export function createUpdateChecker(options = {}) {
  const currentVersion = options.currentVersion ?? VERSION
  versionParts(currentVersion)
  let feedUrl = updateUrl(options.feedUrl ?? process.env.MEMORY_VAULT_UPDATE_URL ?? DEFAULT_UPDATE_URL)
  let state = { status: 'idle', currentVersion, feedUrl, lastChecked: null, release: null, error: null }
  let pending, controller
  const status = () => structuredClone(state)
  const set = patch => { state = { ...state, ...patch }; options.onChange?.(status()); return status() }
  return {
    status,
    configure(url) {
      if (pending) throw new Error('检查更新完成后再修改更新源')
      feedUrl = updateUrl(url)
      return set({ feedUrl, status: 'idle', release: null, error: null, lastChecked: null })
    },
    check() {
      if (pending) return pending
      controller = new AbortController()
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(options.timeoutMs ?? 15000)])
      set({ status: 'checking', error: null })
      pending = (async () => {
        const lastChecked = new Date().toISOString()
        try {
          const response = await fetchUpdate(feedUrl, { signal, fetchImpl: options.fetchImpl })
          if (response.status === 404) {
            await response.body?.cancel()
            return set({ status: 'unpublished', release: null, lastChecked })
          }
          if (!response.ok) { await response.body?.cancel(); throw new Error(`更新服务器返回 ${response.status}`) }
          const release = parseRelease(JSON.parse(await readBounded(response, 1024 * 1024)), options.platform)
          return set({ status: compareVersions(release.version, currentVersion) > 0 ? 'available' : 'up_to_date', release, lastChecked })
        } catch (error) {
          return set({ status: 'error', release: null, lastChecked, error: error.name === 'TimeoutError' ? '检查超时，请稍后重试' : error.message })
        } finally { pending = undefined; controller = undefined }
      })()
      return pending
    },
    dispose() { controller?.abort() },
  }
}
