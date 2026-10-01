import { createReadStream } from 'node:fs'
import { mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createUpdateChecker, DEFAULT_UPDATE_URL, fetchUpdate, updateUrl } from '../../src/updates.js'

export function updateSettings(input = {}) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('更新设置格式无效')
  for (const key of ['autoCheck', 'notify']) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new Error('更新选项必须为开关')
  return { feedUrl: updateUrl(input.feedUrl ?? DEFAULT_UPDATE_URL), autoCheck: input.autoCheck !== false, notify: input.notify !== false, dismissedVersion: typeof input.dismissedVersion === 'string' ? input.dismissedVersion : null }
}
async function verifyFile(path, asset) {
  const metadata = await stat(path)
  if (metadata.size !== asset.size) throw new Error('安装包大小不匹配，请重新下载')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  if (hash.digest('hex') !== asset.sha256) throw new Error('安装包校验失败，请重新下载')
}
export function createDesktopUpdater(options) {
  let settings = updateSettings(options.settings)
  let transfer = { status: 'idle', received: 0, total: 0, error: null, version: null }
  let controller, pending, ready, disposed = false
  const checker = createUpdateChecker({ currentVersion: options.currentVersion, feedUrl: settings.feedUrl, platform: options.platform, timeoutMs: options.timeoutMs, onChange: () => emit() })
  const status = () => ({ ...checker.status(), settings: { ...settings }, download: { ...transfer } })
  const emit = () => { if (!disposed) options.onChange?.(status()) }
  const setTransfer = patch => { transfer = { ...transfer, ...patch }; emit() }
  const service = {
    status,
    async check() {
      if (pending) throw new Error('下载完成或取消后再检查更新')
      await checker.check()
      const checked = checker.status()
      if (ready && (checked.status !== 'available' || checked.release.version !== ready.release.version)) {
        ready = undefined
        setTransfer({ status: 'idle', received: 0, total: 0, error: null, version: null })
      }
      return status()
    },
    configure(input) {
      if (pending) throw new Error('下载完成或取消后再修改更新设置')
      const next = updateSettings({ ...settings, ...input })
      // Persist before changing active configuration; a failed write leaves it intact.
      if (next.feedUrl !== settings.feedUrl && checker.status().status === 'checking') throw new Error('检查完成后再修改更新源')
      options.saveSettings?.(next)
      const changed = next.feedUrl !== settings.feedUrl
      settings = next
      if (changed) { ready = undefined; transfer = { status: 'idle', received: 0, total: 0, error: null, version: null }; checker.configure(next.feedUrl) }
      emit(); return status()
    },
    dismiss() { return service.configure({ dismissedVersion: checker.status().release?.version ?? null }) },
    download() {
      if (pending) return pending
      const snapshot = checker.status()
      if (snapshot.status !== 'available') throw new Error('请先检查并选择可用的新版本')
      const release = snapshot.release
      ready = undefined
      controller = new AbortController()
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(options.downloadTimeoutMs ?? 30 * 60 * 1000)])
      setTransfer({ status: 'downloading', received: 0, total: release.asset.size, version: release.version, error: null })
      pending = (async () => {
        const temporary = join(options.cacheDir, `${randomUUID()}.part`)
        let file, reader
        try {
          await mkdir(options.cacheDir, { recursive: true })
          const response = await fetchUpdate(release.asset.url, { signal })
          if (!response.ok) { await response.body?.cancel(); throw new Error(`下载服务器返回 ${response.status}`) }
          reader = response.body?.getReader()
          if (!reader) throw new Error('下载内容为空')
          file = await open(temporary, 'wx')
          const hash = createHash('sha256')
          let received = 0, lastPush = 0
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            received += value.length
            if (received > release.asset.size) throw new Error('下载大小超过发布清单')
            hash.update(value)
            await file.writeFile(value)
            if (Date.now() - lastPush > 150) { lastPush = Date.now(); setTransfer({ received }) }
          }
          if (signal.aborted) throw signal.reason
          if (received !== release.asset.size || hash.digest('hex') !== release.asset.sha256) throw new Error('安装包校验失败，请重新下载')
          await file.sync(); await file.close(); file = undefined
          const target = join(options.cacheDir, `Memory-Vault-${release.version}-${release.asset.sha256.slice(0, 12)}-Setup.exe`)
          await rename(temporary, target)
          ready = { path: target, release }
          setTransfer({ status: 'ready', received })
        } catch (error) {
          setTransfer({ status: controller?.signal.aborted ? 'cancelled' : 'error', error: controller?.signal.aborted ? null : error.message })
        } finally {
          await reader?.cancel().catch(() => {})
          await file?.close().catch(() => {})
          await rm(temporary, { force: true })
          pending = undefined; controller = undefined
        }
        return status()
      })()
      return pending
    },
    cancel() { controller?.abort(); return status() },
    async installer() {
      if (!ready || transfer.status !== 'ready' || ready.release.version !== checker.status().release?.version || checker.status().status !== 'available') throw new Error('请先下载可用的更新')
      await verifyFile(ready.path, ready.release.asset)
      return ready.path
    },
    dispose() { disposed = true; controller?.abort(); checker.dispose() },
  }
  return service
}
