/**
 * Electron main process for the memory vault.
 *
 * The window is untrusted by construction: no Node integration, a sandboxed
 * renderer, a context-isolated preload that exposes exactly two functions, and
 * a content-security policy that forbids network access entirely. Everything
 * the window can do arrives through the vault's own operation table.
 *
 * `--selftest` loads the real window, screenshots it to a PNG and exits, so the
 * interface can be verified without a human watching it.
 *
 * @module dsh-memory-vault/desktop/main
 */

import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openVault } from './lib/bridge.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const selftest = process.argv.includes('--selftest')
const shotPath = (() => {
  const index = process.argv.indexOf('--shot')
  return index === -1 ? join(here, 'selftest.png') : process.argv[index + 1]
})()

/** @type {Record<string, any>} */
let bridge
/** @type {string[]} */
const pending = []

/**
 * Report a diagnostic to the console, and to the window when it is up.
 * @param {string} message - What happened.
 * @returns {void}
 */
function note(message) {
  if (bridge === undefined) pending.push(message)
  else bridge.vault.notify?.()
  process.stdout.write(`memory-vault desktop: ${message}\n`)
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('vault:note', message)
}

/**
 * Create the application window.
 * @returns {BrowserWindow} The window that was opened.
 */
function openWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 880,
    minHeight: 560,
    backgroundColor: '#101014',
    title: '记忆库',
    autoHideMenuBar: true,
    show: !selftest,
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })
  // The renderer is local and self-contained; anything trying to leave the
  // window is opened by the operator's browser instead of inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault()
  })
  void win.loadFile(join(here, 'renderer', 'index.html'))
  return win
}

ipcMain.handle('vault:invoke', async (_event, op, body) => {
  try {
    const result = await bridge.invoke(op, body)
    return { ok: true, result }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
})

ipcMain.handle('vault:info', () => bridge.info())

app.whenReady().then(async () => {
  try {
    bridge = openVault({
      logger: {
        info: (message) => { note(message) },
        warn: (message) => { note(message) },
      },
    })
    note(`vault open at ${bridge.databasePath}`)
  } catch (error) {
    note(`vault failed to open: ${error instanceof Error ? error.message : String(error)}`)
    if (selftest) app.exit(1)
    return
  }
  for (const message of pending.splice(0)) note(message)
  const win = openWindow()

  if (selftest) {
    win.webContents.once('did-finish-load', () => {
      // Give the first render and its IPC round trip time to settle, then
      // capture what a person would actually be looking at.
      setTimeout(async () => {
        try {
          const image = await win.webContents.capturePage()
          writeFileSync(shotPath, image.toPNG())
          process.stdout.write(`memory-vault desktop: screenshot ${shotPath}\n`)
        } catch (error) {
          process.stderr.write(`memory-vault desktop: screenshot failed: ${String(error)}\n`)
          app.exit(1)
          return
        }
        app.exit(0)
      }, 2200)
    })
  }
})

app.on('window-all-closed', () => { app.quit() })
app.on('before-quit', () => { bridge?.close() })
