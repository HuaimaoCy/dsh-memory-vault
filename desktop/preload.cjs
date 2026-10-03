const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('vault', {
  mistakebook: (action, body) => ipcRenderer.invoke('mistakebook:invoke', action, body),
  // Notebook ops ride the shared vault channel: notebook('list') == invoke('notebook.list').
  notebook: (op, body) => ipcRenderer.invoke('vault:invoke', `notebook.${op}`, body),
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
