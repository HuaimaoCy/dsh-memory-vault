import { app, BrowserWindow, dialog, ipcMain, nativeTheme, Notification, safeStorage, shell } from 'electron'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { openVault } from './lib/bridge.mjs'
import { connectorConfig } from './lib/connectors.mjs'
import { createModelAdapter, validateModelSettings } from '../src/model.js'
import { validateVaultFile } from './lib/databases.mjs'
import { createDesktopUpdater } from './lib/updates.mjs'
import { MistakebookStore } from '../addons/mistakebook/store.mjs'
import { A4_IMAGE_SIZE, activePaperSheet, checkInkBudget, normalizeDocument } from '../addons/mistakebook/canvas.mjs'
import { canvasPrintHTML, cardOnPaper } from '../addons/mistakebook/canvas-print.mjs'
import { NOTEBOOK_DISPLAY_VERSION, NOTEBOOK_RELEASE_NAME } from '../src/version.js'
import {PRODUCTS} from './products.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const product=PRODUCTS[JSON.parse(readFileSync(join(here,'product.json'),'utf8')).kind]??PRODUCTS.unified
const argv = process.argv.slice(1)
const option = name => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1] }
const selftest = argv.includes('--selftest')
app.setPath('userData', join(app.getPath('appData'),product.userData))
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
  if (typeof path !== 'string' || path.trim() === '') throw new Error('导出路径无效，请重新选择')
  const target = resolve(path).toLowerCase()
  // 与记忆库共用同一个 SQLite 文件时 mistakebook.path 是 null（笔记本没有独立文件）。
  // 必须先滤掉空值再 resolve：否则 path.resolve(null) 抛 ERR_INVALID_ARG_TYPE，
  // 会把笔记本导出与备份整体变成 {ok:false}，用户只看到一句无意义的失败。
  const protectedFiles = [bridge.databasePath, mistakebook?.path, prefsPath]
    .filter(file => typeof file === 'string' && file.trim() !== '')
    .flatMap(file => [file, `${file}-wal`, `${file}-shm`])
    .map(file => resolve(file).toLowerCase())
  if (protectedFiles.includes(target) || existsSync(`${path}-wal`) || existsSync(`${path}-shm`)) throw new Error('请选择独立于正在使用的数据文件的导出或备份路径')
}
async function desktopInfo() {
  return {
    ...await bridge.info(), version: app.getVersion(), displayVersion:NOTEBOOK_DISPLAY_VERSION, releaseName:NOTEBOOK_RELEASE_NAME,product:{kind:product.kind,name:product.name}, model: preferences.model ?? {}, hasKey: Boolean(preferences.encryptedKey), updates: updater.status(),
    connectors: connectorConfig({
      kind:product.kind,pluginPath:app.isPackaged?join(process.resourcesPath,'dsh-plugin','index.js'):resolve(here,'..',product.kind==='notebook'?'notebook-plugin.js':'index.js'),
      command: process.execPath,
      args: [app.isPackaged ? join(process.resourcesPath, 'app.asar', 'bin', 'memory-vault.mjs') : resolve(here, '..', 'bin', 'memory-vault.mjs'), 'mcp'],
      databasePath: bridge.databasePath,
    }),
  }
}
function register(channel, action) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      const expected = pathToFileURL(join(here, 'renderer', product.entry)).href
      if (event.sender !== window?.webContents || event.senderFrame?.url !== expected) throw new Error('不允许的窗口请求')
      return { ok: true, result: await action(...args) }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
}
/**
 * 把一份自包含的打印 HTML 交给 Chromium 打印成 PDF。
 *
 * 排版与转义在渲染层与 `addons/mistakebook/print-layout.mjs` 完成；主进程只做
 * 三件无法在渲染层做的事：隐藏窗口、等字体就绪、printToPDF。窗口不加载 preload、
 * 不开 node、不允许弹窗与权限请求，也不复用主窗口会话——打印页只是一份静态文档。
 *
 */
async function renderPrintDocument(html, render, offscreen = false) {
  // 放在 userData 下的 print 目录，而不是系统 Temp：本机（以及这台机器的
  // DSH 沙箱上下文）对 %TEMP% 的写入会被 ACL 拒成 EPERM，userData 是应用本来
  // 就能写的位置（settings.json、updates 都在这里）。
  const directory = join(app.getPath('userData'), 'print')
  mkdirSync(directory, { recursive: true })
  const source = join(directory, `alaya-print-${randomUUID()}.html`)
  writeFileSync(source, html, 'utf8')
  const printer = new BrowserWindow({
    show: false, width: 900, height: 1200, autoHideMenuBar: true, title: 'Alaya 打印',
    webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false, offscreen, backgroundThrottling: !offscreen,
      partition: `notebook-print-${randomUUID()}`,
    },
  })
  try {
    printer.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    printer.webContents.on('will-navigate', event => event.preventDefault())
    printer.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    await printer.loadFile(source)
    // 字体（含中文回退）没就绪就打印会出现整页缺字；等 document.fonts 再出 PDF。
    await printer.webContents.executeJavaScript('document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true')
    return await render(printer.webContents)
  } finally {
    if (!printer.isDestroyed()) printer.destroy()
    rmSync(source, { force: true })
  }
}
const printPDF = html => renderPrintDocument(html, contents =>
  contents.printToPDF({ printBackground: true, preferCSSPageSize: true, margins: { marginType: 'none' } }))

function paperQuestions(store, canvas, sheets) {
  const references = new Map()
  for (const card of canvas.cards) {
    if (card.kind !== 'reference' || card.noteType !== 'mistake' || !card.noteId || !sheets.some(sheet => cardOnPaper(card, sheet))) continue
    const includesImages = !card.question?.sections || card.question.sections.includes('images')
    references.set(card.noteId, references.get(card.noteId) || includesImages)
  }
  const questions = new Map()
  for (const [id, includesImages] of references) {
    let record
    try { record = store.require(id) }
    catch (error) {
      if (error.message === '题目不存在') continue
      throw error
    }
    const images = includesImages ? store.listImages(id, true) : []
    questions.set(id, { ...record, images })
  }
  return questions
}

async function exportCanvasPaper({ format, canvas: raw, sheetId }) {
  if (!['pdf', 'png', 'jpg'].includes(format)) throw new Error('请选择 PDF、PNG 或 JPG')
  const document = normalizeDocument({ canvases: [raw] })
  checkInkBudget(document)
  const [canvas] = document.canvases
  if (!canvas.paper?.enabled) throw new Error('请先切换到 A4 纸模式')
  const paper = canvas.paper
  const isImage = format !== 'pdf'
  const sheet = isImage ? (sheetId === undefined ? activePaperSheet(paper) : paper.sheets.find(row => row.id === sheetId)) : null
  if (isImage && !sheet) throw new Error('A4 纸张不存在')
  const title = canvas.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '') || '白板'
  const pageSuffix = sheet && paper.sheets.length > 1 ? `-第 ${paper.sheets.indexOf(sheet) + 1} 页` : ''
  const store = mistakebook
  const selected = await dialog.showSaveDialog(window, {
    title: '导出 A4', defaultPath: `${title}${pageSuffix}.${format}`,
    filters: [{ name: format.toUpperCase(), extensions: [format] }],
  })
  if (selected.canceled || !selected.filePath) return { canceled: true }
  const target = extname(selected.filePath).toLowerCase() === `.${format}` ? selected.filePath : `${selected.filePath}.${format}`
  checkDataTarget(target)
  if (mistakebook !== store) throw new Error('笔记本已切换，请重新导出')
  const questions = paperQuestions(store, canvas, sheet ? [sheet] : paper.sheets)
  const rich = canvas.cards.some(card => card.kind === 'reference' && card.noteType === 'mistake') ? {
    nonce: randomUUID(),
    markdown: pathToFileURL(join(here, 'renderer', 'markdown.js')).href,
    styles: ['markdown.css', 'canvas-question.css'].map(name => pathToFileURL(join(here, 'renderer', name)).href),
  } : undefined
  let bytes
  if (!isImage) {
    bytes = await printPDF(canvasPrintHTML(canvas, { questions, rich }))
  } else {
    const size = A4_IMAGE_SIZE
    bytes = await renderPrintDocument(canvasPrintHTML(canvas, { sheetId: sheet.id, imageSize: size, questions, rich }), async contents => {
      // 用固定像素的渲染视口，避免桌面分辨率截短纸张后把内容拉伸。
      const debug = contents.debugger
      debug.attach('1.3')
      try {
        await debug.sendCommand('Emulation.setDeviceMetricsOverride', {
          width: size.w, height: size.h, deviceScaleFactor: 1, mobile: false,
        })
        const result = await debug.sendCommand('Page.captureScreenshot', {
          format: format === 'jpg' ? 'jpeg' : 'png', ...(format === 'jpg' ? { quality: 95 } : {}),
          clip: { x: 0, y: 0, width: size.w, height: size.h, scale: 1 },
          captureBeyondViewport: true,
        })
        return Buffer.from(result.data, 'base64')
      } finally { debug.detach() }
    }, true)
  }
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, bytes, { flag: 'wx' })
    renameSync(temporary, target)
  } finally {
    rmSync(temporary, { force: true })
  }
  return { canceled: false, path: target }
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
  // 错题 PDF：渲染层给自包含 HTML，这里只负责打印成字节，不碰笔记本数据。
  printPDF,
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
  register('appearance:mode', mode => {
    if (!['system', 'light', 'dark'].includes(mode)) throw new Error('无效的外观模式')
    nativeTheme.themeSource = mode
  })
  register('mistakebook:invoke', (action, body = {}) => bridge.invoke(`notebook.${action}`, body))
  // 自由画布：画布文档是笔记本域的数据（notebook_meta 的 canvas 键），与笔记同库
  // 但不进入数据库（记忆）域；读写都经过同一个 MistakebookStore 的校验与限流。
  register('notebook:canvas', (action, body = {}) => {
    if(!mistakebook)throw new Error('此 Database 发行版未启用 Notebook')
    if (action === 'load') {
      const state = mistakebook.canvasState()
      // 保留顶层文档字段：仍按「load 直接返回文档」解析的旧渲染层不会把
      // { docs, corrupted } 误当成空文档而覆盖原画布；新渲染层读 docs。
      return { ...state.docs, docs: state.docs, corrupted: state.corrupted }
    }
    if (action === 'save') return mistakebook.setCanvasDocs(body?.docs ?? body)
    if (action === 'export') return exportCanvasPaper(body)
    throw new Error('未知的画布操作')
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
    show: false,
    icon: join(here, 'assets', 'memory-vault.png'),
    webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, offscreen: selftest, backgroundThrottling: !selftest },
  })
  if (process.platform !== 'darwin') window.removeMenu()
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
  await window.loadFile(join(here,'renderer',product.entry))
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
      if(product.kind!=='database'){
      if (option('--mistake-db')) {
        mistakebook = new MistakebookStore(option('--mistake-db'))
      } else {
        mistakebook = new MistakebookStore({ database: bridge.vault.store.db })
        try { const migrated = mistakebook.migrateFromFile(legacyNotebookPath); if (migrated?.migrated) diagnostic(`notebook data migrated from ${legacyNotebookPath}`) } catch (error) { diagnostic(`notebook migration failed, falling back to file mode: ${error.message}`); mistakebook.close(); mistakebook = new MistakebookStore(legacyNotebookPath) }
      }
      bridge.attach({ notebook: mistakebook, notebookHooks })
      }
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
