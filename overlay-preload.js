const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('overlay', { onDraw: (cb) => ipcRenderer.on('draw', (_e, m) => cb(m)) });
