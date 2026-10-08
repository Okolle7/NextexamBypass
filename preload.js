const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayAPI', {
    onKey: (cb) => ipcRenderer.on('hook-key', (e, data) => cb(data)),
    onToggle: (cb) => ipcRenderer.on('hook-toggle', (e, mode) => cb(mode)),
    ask: (text) => ipcRenderer.send('ask-claude', text),
    onReply: (cb) => ipcRenderer.on('claude-reply', (e, data) => cb(data))
});