const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const google = require('./google.cjs');

const dataFile = () => path.join(app.getPath('userData'), 'exponential-data.json');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#f2f2f4',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 26, y: 24 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

ipcMain.handle('data:load', () => {
  try {
    return JSON.parse(fs.readFileSync(dataFile(), 'utf8'));
  } catch {
    return null;
  }
});

ipcMain.handle('data:save', (_e, data) => {
  fs.writeFileSync(dataFile(), JSON.stringify(data, null, 2));
});

ipcMain.handle('google:getConfig', () => google.getConfig());
ipcMain.handle('google:setConfig', (_e, c) => google.setConfig(c));
ipcMain.handle('google:status', () => google.status());
ipcMain.handle('google:signIn', () => google.signIn());
ipcMain.handle('google:signOut', () => google.signOut());
ipcMain.handle('google:events', (_e, calendarId, from, to) => google.events(calendarId, from, to));

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
