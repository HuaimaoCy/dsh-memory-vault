const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('vault', {
  mistakebook: (action, body) => ipcRenderer.invoke('mistakebook:invoke', action, body),
  // Notebook ops ride the shared vault channel: notebook('list') == invoke('notebook.list').
  notebook: (op, body) => ipcRenderer.invoke('vault:invoke', `notebook.${op}`, body),
  // 自由画布文档（笔记本域）：load / save，走主进程的笔记本存储校验。
  canvas: (action, body) => ipcRenderer.invoke('notebook:canvas', action, body),
  invoke: (op, body) => ipcRenderer.invoke('vault:invoke', op, body),
  info: () => ipcRenderer.invoke('vault:info'),
  confirm: message => ipcRenderer.invoke('vault:confirm', message),
  open: () => ipcRenderer.invoke('vault:open'),
  backup: () => ipcRenderer.invoke('vault:backup'),
  settings: body => ipcRenderer.invoke('vault:settings', body),
  updates: (action, body) => ipcRenderer.invoke('vault:updates', action, body),
  onUpdates: callback => {
    const listener = (_event, snapshot) => callback(snapshot)
    ipcRenderer.on('vault:updates-changed', listener)
    return () => ipcRenderer.removeListener('vault:updates-changed', listener)
  },
})
