const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('exponential', {
  load: () => ipcRenderer.invoke('data:load'),
  save: (data) => ipcRenderer.invoke('data:save', data),
  platform: process.platform,
  isWidget: process.argv.includes('--widget'),
  onChange: (cb) => { const h = (_e, data) => cb(data); ipcRenderer.on('data:changed', h); return () => ipcRenderer.removeListener('data:changed', h); },
  openMain: (target) => ipcRenderer.send('widget:openMain', target),
  closeWidget: () => ipcRenderer.send('widget:close'),
  onWidgetShown: (cb) => { const h = () => cb(); ipcRenderer.on('widget:shown', h); return () => ipcRenderer.removeListener('widget:shown', h); },
  onOpen: (cb) => { const h = (_e, t) => cb(t); ipcRenderer.on('open', h); return () => ipcRenderer.removeListener('open', h); },
  google: {
    getConfig: () => ipcRenderer.invoke('google:getConfig'),
    setConfig: (c) => ipcRenderer.invoke('google:setConfig', c),
    status: () => ipcRenderer.invoke('google:status'),
    signIn: () => ipcRenderer.invoke('google:signIn'),
    signOut: () => ipcRenderer.invoke('google:signOut'),
    events: (calendarId, from, to) => ipcRenderer.invoke('google:events', calendarId, from, to),
  },
});
