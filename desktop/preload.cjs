/**
 * The only bridge between the window and the vault.
 *
 * Two functions, both narrowing to the vault's own operation table: the window
 * cannot reach the filesystem, the network, or Node — it can only ask the main
 * process to run one named operation.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('vault', {
  /**
   * Run one vault operation in the main process.
   * @param {string} op - Operation name.
   * @param {Record<string, unknown>} [body] - Operation body.
   * @returns {Promise<{ ok: boolean, result?: unknown, error?: string }>} Result or error.
   */
  invoke: (op, body) => ipcRenderer.invoke('vault:invoke', op, body),

  /**
   * Facts about the open vault, for the status line.
   * @returns {Promise<Record<string, unknown>>} Vault identity and size.
   */
  info: () => ipcRenderer.invoke('vault:info'),

  /**
   * Subscribe to main-process diagnostics.
   * @param {(message: string) => void} listener - Called with each message.
   * @returns {() => void} Unsubscribe.
   */
  onNote: (listener) => {
    const handler = (_event, message) => { listener(String(message)) }
    ipcRenderer.on('vault:note', handler)
    return () => { ipcRenderer.removeListener('vault:note', handler) }
  },
})
