const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('exponential', {
  load: () => ipcRenderer.invoke('data:load'),
  save: (data) => ipcRenderer.invoke('data:save', data),
  platform: process.platform,
  google: {
    getConfig: () => ipcRenderer.invoke('google:getConfig'),
    setConfig: (c) => ipcRenderer.invoke('google:setConfig', c),
    status: () => ipcRenderer.invoke('google:status'),
    signIn: () => ipcRenderer.invoke('google:signIn'),
    signOut: () => ipcRenderer.invoke('google:signOut'),
    events: (calendarId, from, to) => ipcRenderer.invoke('google:events', calendarId, from, to),
  },
});
