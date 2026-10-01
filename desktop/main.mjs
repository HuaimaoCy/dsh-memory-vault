import { app, BrowserWindow, dialog, ipcMain, Notification, safeStorage, shell } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { openVault } from './lib/bridge.mjs'
import { connectorConfig } from './lib/connectors.mjs'
import { createModelAdapter, validateModelSettings } from '../src/model.js'
import { validateVaultFile } from './lib/databases.mjs'
import { createDesktopUpdater } from './lib/updates.mjs'
import { MistakebookStore, segmentQuestions } from '../addons/mistakebook/store.mjs'
import { recognize, analyze, solve, createCloze, extractWordsWithAI, validateOCRSettings } from '../addons/mistakebook/services.mjs'
import { SIMULATIONS, simulationURL } from '../addons/mistakebook/simulations.mjs'

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
function registerDesktop() {
  register('mistakebook:invoke', async (action, body = {}) => {
    switch (action) {
      case 'list': return mistakebook.list(body)
      case 'read': return mistakebook.read(body.id)
      case 'save': return mistakebook.save(body)
      case 'action': return mistakebook.action(body.id, body.action)
      case 'ai.accept': return mistakebook.acceptAI(body.id)
      case 'cancelAI': aiRequest?.abort(); return { cancelled: true }
      case 'solve': {
        if (aiRequest) throw new Error('已有 AI 任务正在进行')
        const request = new AbortController(); aiRequest = request
        try { const record = mistakebook.read(body.id), aiResult = await solve(record, adapter(), request.signal); return mistakebook.save({ ...record, aiResult }) }
        finally { if (aiRequest === request) aiRequest = undefined }
      }
      case 'quiz.start': {
        const records = mistakebook.planQuiz(body.count ?? 10)
        if (body.mode !== 'cloze') return mistakebook.startQuiz(records)
        if (aiRequest) throw new Error('已有 AI 任务正在进行')
        const request = new AbortController(); aiRequest = request
        try { return mistakebook.startQuiz(records, await createCloze(records, adapter(), request.signal)) }
        finally { if (aiRequest === request) aiRequest = undefined }
      }
      case 'quiz.submit': return mistakebook.submitQuiz(body.id, body.answers)
      case 'words.extract': {
        if (aiRequest) throw new Error('已有 AI 任务正在进行')
        const request = new AbortController(); aiRequest = request
        try { return await extractWordsWithAI(body?.text, adapter(), request.signal) }
        finally { if (aiRequest === request) aiRequest = undefined }
      }
      case 'simulation.info': return SIMULATIONS
      case 'simulation.open': {
        const url = simulationURL(body.id)
        if (simulations.size >= 4) throw new Error('请先关闭一个仿真窗口再打开新的仿真')
        const simulation = new BrowserWindow({ parent: window, width: 1100, height: 780, title: '笔记本 · PhET 物理仿真', show: !selftest, autoHideMenuBar: true,
          webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, partition: `notebook-simulation-${randomUUID()}`, offscreen: selftest } })
        simulations.add(simulation); simulation.on('closed',()=>simulations.delete(simulation))
        simulation.webContents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false))
        simulation.webContents.session.on('will-download',event=>event.preventDefault())
        simulation.webContents.on('will-navigate',(event,target)=>{ if (new URL(target).origin !== 'https://phet.colorado.edu') event.preventDefault() })
        simulation.webContents.setWindowOpenHandler(()=>({action:'deny'}))
        let timer
        try { await Promise.race([simulation.loadURL(url),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('timeout')),45000)})]) }
        catch { if (!simulation.isDestroyed()) simulation.destroy(); throw new Error('仿真打开失败，请检查网络连接') }
        finally { clearTimeout(timer) }
        return { opened: true, id: body.id, url }
      }
      case 'segment': return { questions: segmentQuestions(body.text) }
      case 'import': return mistakebook.import(body)
      case 'export': {
        const result = await dialog.showSaveDialog(window, { title: '导出笔记本（含图片）', defaultPath: `notebook-${new Date().toISOString().slice(0,10)}.json`, filters: [{ name: '笔记本 JSON', extensions: ['json'] }] })
        if (result.canceled || !result.filePath) return null
        checkDataTarget(result.filePath)
        const temporary = `${result.filePath}.${randomUUID()}.tmp`
        try { writeFileSync(temporary, JSON.stringify(mistakebook.export(), null, 2)); renameSync(temporary, result.filePath) }
        finally { rmSync(temporary, { force: true }) }
        return { path: result.filePath }
      }
      case 'backup': {
        const result = await dialog.showSaveDialog(window, { title: '备份笔记本', defaultPath: `notebook-${Date.now()}.sqlite`, filters: [{ name: 'SQLite 备份', extensions: ['sqlite'] }] })
        if (result.canceled || !result.filePath) return null
        checkDataTarget(result.filePath)
        const temporary = `${result.filePath}.${randomUUID()}.tmp`
        try { mistakebook.backupTo(temporary); renameSync(temporary, result.filePath) } finally { rmSync(temporary, { force: true }) }
        return { path: result.filePath }
      }
      case 'settings': return { ...validateOCRSettings(preferences.ocr), hasKey: Boolean(preferences.encryptedOCRKey), modelConfigured: Boolean(adapter().resolveRoute()), path: mistakebook.path }
      case 'configure': {
        const ocr = validateOCRSettings(body)
        let encryptedOCRKey = preferences.encryptedOCRKey
        if (body.clearKey === true) encryptedOCRKey = undefined
        else if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
          if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法保存密钥')
          encryptedOCRKey = safeStorage.encryptString(body.apiKey.trim()).toString('base64')
        }
        savePreferences({ ...preferences, ocr, encryptedOCRKey }); return { saved: true }
      }
      case 'ocr': {
        if (ocrRequest) throw new Error('已有识别任务正在进行')
        const request = new AbortController(); ocrRequest = request
        try { return await recognize(body, preferences.ocr, preferences.encryptedOCRKey ? safeStorage.decryptString(Buffer.from(preferences.encryptedOCRKey, 'base64')) : '', { signal: request.signal }) }
        finally { if (ocrRequest === request) ocrRequest = undefined }
      }
      case 'cancelOCR': ocrRequest?.abort(); return { cancelled: true }
      case 'analyze': {
        const record = mistakebook.read(body.id), result = await analyze(record, adapter())
        return mistakebook.save({ ...record, cause: result.cause })
      }
      default: throw new Error('未知笔记本操作')
    }
  })
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
    const reply = await dialog.showOpenDialog(window, { title: '打开记忆库', properties: ['openFile'], filters: [{ name: 'SQLite 记忆库', extensions: ['sqlite', 'db'] }] })
    if (reply.canceled) return null
    const databasePath = resolve(reply.filePaths[0])
    validateVaultFile(databasePath)
    const next = openVault({ databasePath, updates: updater, ...adapter() })
    try { savePreferences({ ...preferences, databasePath }) } catch (error) { next.close(); throw error }
    const previous = bridge
    bridge = next
    previous.close()
    return desktopInfo()
  })
  register('vault:backup', async () => {
    const reply = await dialog.showSaveDialog(window, { title: '备份记忆库', defaultPath: `memory-vault-${new Date().toISOString().slice(0, 10)}.sqlite`, filters: [{ name: 'SQLite 记忆库', extensions: ['sqlite'] }] })
    if (reply.canceled || !reply.filePath) return null
    const target = resolve(reply.filePath)
    if (target.toLowerCase() === resolve(bridge.databasePath).toLowerCase() || existsSync(`${target}-wal`) || existsSync(`${target}-shm`)) throw new Error('请选择不同于正在使用的数据库的备份路径')
    const temporary = `${target}.${randomUUID()}.tmp`
    try { bridge.vault.store.backupTo(temporary); renameSync(temporary, target) }
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
    width: 1440, height: 940, minWidth: 1040, minHeight: 650, backgroundColor: '#f7f8fa', title: 'Alaya · 记忆与笔记',
    autoHideMenuBar: true, show: !selftest,
    icon: join(here, 'assets', 'memory-vault.png'),
    webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, offscreen: selftest, backgroundThrottling: !selftest },
  })
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
      bridge = openVault({ databasePath: option('--db') ?? process.env.MEMORY_VAULT_DB ?? preferences.databasePath, updates: updater, ...adapter(), logger: { info: diagnostic, warn: diagnostic } })
      mistakebook = new MistakebookStore(option('--mistake-db') ?? join(app.getPath('userData'), 'mistakebook.sqlite'))
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
