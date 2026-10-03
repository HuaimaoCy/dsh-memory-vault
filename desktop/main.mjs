import { app, BrowserWindow, dialog, ipcMain, Notification, safeStorage, shell } from 'electron'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { openVault } from './lib/bridge.mjs'
import { connectorConfig } from './lib/connectors.mjs'
import { createModelAdapter, validateModelSettings } from '../src/model.js'
import { validateVaultFile } from './lib/databases.mjs'
import { createDesktopUpdater } from './lib/updates.mjs'
import { MistakebookStore } from '../addons/mistakebook/store.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(1)
const option = name => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1] }
const selftest = argv.includes('--selftest')
app.setPath('userData', join(app.getPath('appData'), 'Memory Vault Mistakebook'))
if (option('--user-data')) app.setPath('userData', resolve(option('--user-data')))
let bridge, window, updater, updateTimer, mistakebook, ocrRequest, aiRequest, preferences = {}, prefsPath
const simulations = new Set()
let notifiedVersion
const diagnostic = message => process.stderr.write(`memory-vault: ${message}\n`)

function savePreferences(next) {
  mkdirSync(dirname(prefsPath), { recursive: true })
  const temporary = `${prefsPath}.tmp`
  writeFileSync(temporary, JSON.stringify(next, null, 2))
  renameSync(temporary, prefsPath)
  preferences = next
}
const modelKey = () => preferences.encryptedKey ? safeStorage.decryptString(Buffer.from(preferences.encryptedKey, 'base64')) : ''
const adapter = () => createModelAdapter(() => preferences.model ?? {}, modelKey)
function checkDataTarget(path) {
  const target = resolve(path).toLowerCase()
  const protectedFiles = [bridge.databasePath, mistakebook.path, prefsPath].flatMap(file => [file, `${file}-wal`, `${file}-shm`]).map(file => resolve(file).toLowerCase())
  if (protectedFiles.includes(target) || existsSync(`${path}-wal`) || existsSync(`${path}-shm`)) throw new Error('请选择独立于正在使用的数据文件的导出或备份路径')
}
async function desktopInfo() {
  return {
    ...await bridge.info(), version: app.getVersion(), model: preferences.model ?? {}, hasKey: Boolean(preferences.encryptedKey), updates: updater.status(),
    connectors: connectorConfig({
      command: process.execPath,
      args: [app.isPackaged ? join(process.resourcesPath, 'app.asar', 'bin', 'memory-vault.mjs') : resolve(here, '..', 'bin', 'memory-vault.mjs'), 'mcp'],
      databasePath: bridge.databasePath,
    }),
  }
}
function register(channel, action) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      const expected = pathToFileURL(join(here, 'renderer', 'index.html')).href
      if (event.sender !== window?.webContents || event.senderFrame?.url !== expected) throw new Error('不允许的窗口请求')
      return { ok: true, result: await action(...args) }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
}
// Notebook handlers live in the shared op table (src/core/notebook_ops.mjs);
// this hooks object is the only place the main process meets them. The old
// `mistakebook:invoke` channel stays as a compatibility alias forwarding
// into the same table, and goes away once every caller is migrated.
const notebookHooks = {
  getWindow: () => window,
  isSelftest: () => selftest,
  simulations,
  checkDataTarget,
  getPreferences: () => preferences,
  savePreferences,
  getModel: () => adapter(),
  isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
  encryptText: text => safeStorage.encryptString(text).toString('base64'),
  getOCRKey: () => preferences.encryptedOCRKey ? safeStorage.decryptString(Buffer.from(preferences.encryptedOCRKey, 'base64')) : '',
  showSaveDialog: options => dialog.showSaveDialog(window, options),
  writeFileSync,
  saveAtomically: (target, temporary, write) => { write(temporary); renameSync(temporary, target) },
  discardTemp: temporary => rmSync(temporary, { force: true }),
  createSimulationWindow: url => {
    const simulation = new BrowserWindow({ parent: window, width: 1100, height: 780, title: '笔记本 · PhET 物理仿真', show: !selftest, autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, partition: `notebook-simulation-${randomUUID()}`, offscreen: selftest } })
    simulation.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    simulation.webContents.session.on('will-download', event => event.preventDefault())
    simulation.webContents.on('will-navigate', (event, target) => { if (new URL(target).origin !== 'https://phet.colorado.edu') event.preventDefault() })
    simulation.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    return simulation
  },
  getAI: () => aiRequest, setAI: request => { aiRequest = request },
  getOCR: () => ocrRequest, setOCR: request => { ocrRequest = request },
}
function registerDesktop() {
  register('mistakebook:invoke', (action, body = {}) => bridge.invoke(`notebook.${action}`, body))
  register('vault:updates', async (action, body) => {
    switch (action) {
      case 'status': return updater.status()
      case 'check': return updater.check()
      case 'configure': return updater.configure(body ?? {})
      case 'download': return updater.download()
      case 'cancel': return updater.cancel()
      case 'dismiss': return updater.dismiss()
      case 'install': {
        throw new Error('笔记本外挂使用独立安装包更新，请保留当前分支版本')
      }
      default: throw new Error('未知更新操作')
    }
  })
  register('vault:invoke', (op, body) => bridge.invoke(op, body))
  register('vault:info', desktopInfo)
  register('vault:confirm', async message => {
    const reply = await dialog.showMessageBox(window, { type: 'question', buttons: ['取消', '确认'], defaultId: 0, cancelId: 0, message: String(message).slice(0, 1000) })
    return reply.response === 1
  })
  register('vault:open', async () => {
    const reply = await dialog.showOpenDialog(window, { title: '打开数据库', properties: ['openFile'], filters: [{ name: 'SQLite 数据库', extensions: ['sqlite', 'db'] }] })
    if (reply.canceled) return null
    const databasePath = resolve(reply.filePaths[0])
    validateVaultFile(databasePath)
    const next = openVault({ databasePath, updates: updater, ...adapter(), logger: { info: diagnostic, warn: diagnostic } })
    // 换库后笔记本跟随新连接：注入模式下重建并挂到新 bridge；文件模式沿用原实例。
    const nextNotebook = option('--mistake-db') ? mistakebook : new MistakebookStore({ database: next.vault.store.db })
    try {
      if (!option('--mistake-db')) { try { nextNotebook.migrateFromFile(join(app.getPath('userData'), 'mistakebook.sqlite')) } catch { /* 迁移失败不阻断换库 */ } }
      next.attach({ notebook: nextNotebook, notebookHooks })
      savePreferences({ ...preferences, databasePath })
    } catch (error) { next.close(); throw error }
    const previous = bridge, previousNotebook = mistakebook
    bridge = next; mistakebook = nextNotebook
    previous.close()
    try { if (previousNotebook && previousNotebook !== mistakebook && previousNotebook.ownsDb !== false) previousNotebook.close() } catch { /* 已关闭 */ }
    return desktopInfo()
  })
  register('vault:backup', async () => {
    const reply = await dialog.showSaveDialog(window, { title: '备份数据库', defaultPath: `memory-vault-${new Date().toISOString().slice(0, 10)}.sqlite`, filters: [{ name: 'SQLite 数据库', extensions: ['sqlite'] }] })
    if (reply.canceled || !reply.filePath) return null
    const target = resolve(reply.filePath)
    if (target.toLowerCase() === resolve(bridge.databasePath).toLowerCase() || existsSync(`${target}-wal`) || existsSync(`${target}-shm`)) throw new Error('请选择不同于正在使用的数据库的备份路径')
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
      bridge.vault.store.backupTo(temporary)
      // 数据域隔离：数据库备份只含数据库域，剔除共享库中的笔记本表。
      const trimmed = new DatabaseSync(temporary)
      try { for (const row of trimmed.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'notebook_%'").all()) trimmed.exec(`DROP TABLE IF EXISTS "${row.name}"`) } finally { trimmed.close() }
      renameSync(temporary, target)
    }
    finally { rmSync(temporary, { force: true }) }
    return { path: target }
  })
  register('vault:settings', async body => {
    const model = validateModelSettings(body ?? {})
    let encryptedKey = preferences.encryptedKey
    if (body?.clearKey === true) encryptedKey = undefined
    else if (typeof body?.apiKey === 'string' && body.apiKey.trim()) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法保存密钥')
      encryptedKey = safeStorage.encryptString(body.apiKey.trim()).toString('base64')
    }
    savePreferences({ ...preferences, model, encryptedKey })
    return desktopInfo()
  })
}
async function openWindow() {
  window = new BrowserWindow({
    width: 1440, height: 940, minWidth: 1040, minHeight: 650, backgroundColor: '#fbfaf7', title: 'Alaya · 记忆与笔记',
    autoHideMenuBar: true, show: false,
    icon: join(here, 'assets', 'memory-vault.png'),
    webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, offscreen: selftest, backgroundThrottling: !selftest },
  })
  if (!selftest) window.once('ready-to-show', () => window.show())
  window.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) void shell.openExternal(url); return { action: 'deny' } })
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  const errors = []
  window.webContents.on('console-message', (event, level, message) => {
    const actualLevel = event.level ?? level
    const actualMessage = event.message ?? message
    if (actualLevel === 'error' || actualLevel >= 3) errors.push(String(actualMessage))
  })
  await window.loadFile(join(here, 'renderer', 'index.html'))
  if (selftest) {
    try {
      if (option('--test-module')) {
        const test = await import(pathToFileURL(resolve(option('--test-module'))).href)
        await test.run(window, bridge)
      } else {
        await window.webContents.executeJavaScript(`new Promise((resolve, reject) => { let n = 0; const t = setInterval(() => { if (document.querySelectorAll('#views button').length === 4) { clearInterval(t); resolve(true) } else if (++n > 100) { clearInterval(t); reject(new Error(document.querySelector('#status').textContent)) } }, 50) })`)
      }
      if (errors.length) throw new Error(errors.join('\n'))
      await new Promise(resolve => setTimeout(resolve, 500))
      if (option('--shot')) writeFileSync(resolve(option('--shot')), (await window.webContents.capturePage()).toPNG())
      diagnostic('desktop selftest passed')
      mistakebook.close(); bridge.close(); app.exit(0)
    } catch (error) {
      diagnostic(`selftest failed: ${error.stack ?? error}; console=${JSON.stringify(errors)}`)
      diagnostic(await window.webContents.executeJavaScript('document.body.innerText'))
      if (option('--shot')) writeFileSync(resolve(option('--shot')), (await window.webContents.capturePage()).toPNG())
      mistakebook.close(); bridge.close(); app.exit(1)
    }
  }
}
app.whenReady().then(async () => {
    try {
      prefsPath = join(app.getPath('userData'), 'settings.json')
      if (existsSync(prefsPath)) preferences = JSON.parse(readFileSync(prefsPath, 'utf8'))
      updater = createDesktopUpdater({
        currentVersion: app.getVersion(), cacheDir: join(app.getPath('userData'), 'updates'), settings: { ...preferences.updates, autoCheck: false },
        saveSettings: updates => savePreferences({ ...preferences, updates }),
        onChange: snapshot => {
          if (window && !window.isDestroyed()) window.webContents.send('vault:updates-changed', snapshot)
          const version = snapshot.release?.version
          if (!selftest && snapshot.status === 'available' && snapshot.settings.notify && snapshot.settings.dismissedVersion !== version && notifiedVersion !== version) {
            notifiedVersion = version
            if (window && !window.isFocused() && Notification.isSupported()) {
              const notice = new Notification({ title: 'Alaya 有新版本', body: `版本 ${version} 已发布，打开软件查看更新。`, icon: join(here, 'assets', 'memory-vault.png') })
              notice.on('click', () => { if (window && !window.isDestroyed()) { window.show(); window.focus() } })
              notice.show()
            }
          }
        },
      })
      // 笔记本是数据库（vault）之上的扩充：默认把 notebook_* 表放进 vault
      // 同一连接；旧独立 mistakebook.sqlite 首次启动幂等迁入并留备份。
      // --mistake-db 仍强制走独立文件模式（测试与调试出口）。
      const legacyNotebookPath = option('--mistake-db') ?? join(app.getPath('userData'), 'mistakebook.sqlite')
      bridge = openVault({ databasePath: option('--db') ?? process.env.MEMORY_VAULT_DB ?? preferences.databasePath, updates: updater, ...adapter(), logger: { info: diagnostic, warn: diagnostic } })
      if (option('--mistake-db')) {
        mistakebook = new MistakebookStore(option('--mistake-db'))
      } else {
        mistakebook = new MistakebookStore({ database: bridge.vault.store.db })
        try { const migrated = mistakebook.migrateFromFile(legacyNotebookPath); if (migrated?.migrated) diagnostic(`notebook data migrated from ${legacyNotebookPath}`) } catch (error) { diagnostic(`notebook migration failed, falling back to file mode: ${error.message}`); mistakebook.close(); mistakebook = new MistakebookStore(legacyNotebookPath) }
      }
      bridge.attach({ notebook: mistakebook, notebookHooks })
      registerDesktop(); await openWindow()
      if (app.isPackaged && !selftest) {
        const check = () => { if (updater.status().settings.autoCheck) void updater.check().catch(error => diagnostic(error.message)) }
        updateTimer = setTimeout(() => { check(); updateTimer = setInterval(check, 6 * 60 * 60 * 1000) }, 5000)
        updateTimer.unref()
      }
    } catch (error) { diagnostic(error.stack ?? error); if (!selftest) dialog.showErrorBox('Alaya 无法启动', error.message); app.exit(1) }
})
app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => { aiRequest?.abort(); ocrRequest?.abort(); clearTimeout(updateTimer); clearInterval(updateTimer); updater?.dispose(); mistakebook?.close(); bridge?.close() })
