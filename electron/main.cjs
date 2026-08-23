const { app, BrowserWindow, ipcMain, Tray, nativeImage, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const google = require('./google.cjs');
const { autoUpdater } = require('electron-updater');

const dataFile = () => path.join(app.getPath('userData'), 'exponential-data.json');
const iconPath = path.join(__dirname, '..', 'build', 'icon.png');
const devUrl = process.env.VITE_DEV_SERVER_URL;

let mainWin = null;
let widgetWin = null;
let tray = null;

const WIDGET_W = 640;
const WIDGET_H = 460;

function loadRenderer(win, mode) {
  if (devUrl) win.loadURL(mode ? `${devUrl}?mode=${mode}` : devUrl);
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), mode ? { query: { mode } } : undefined);
}

function createMainWindow() {
  if (mainWin && !mainWin.isDestroyed()) { mainWin.show(); mainWin.focus(); return mainWin; }
  mainWin = new BrowserWindow({
    icon: iconPath,
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    // Transparent + CSS-rounded so the outer corners can be as round as the panels (macOS only).
    transparent: process.platform === 'darwin',
    backgroundColor: process.platform === 'darwin' ? '#00000000' : '#f2f2f4',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
    },
  });
  loadRenderer(mainWin, null);
  mainWin.on('swipe', (_e, direction) => mainWin?.webContents.send('swipe', direction)); // macOS trackpad page-swipe
  mainWin.on('closed', () => { mainWin = null; });
  return mainWin;
}

/** The menu-bar popover: a frameless window with just the week panel, hidden when it loses focus. */
function createWidget() {
  widgetWin = new BrowserWindow({
    width: WIDGET_W,
    height: WIDGET_H,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false, // the page draws its own shadow inside the transparent margin; the system one looked jagged
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      additionalArguments: ['--widget'],
    },
  });
  loadRenderer(widgetWin, 'widget');
  widgetWin.on('swipe', (_e, direction) => widgetWin?.webContents.send('swipe', direction));
  widgetWin.on('blur', () => { if (widgetWin && !widgetWin.webContents.isDevToolsOpened()) widgetWin.hide(); });
  widgetWin.on('closed', () => { widgetWin = null; });
  return widgetWin;
}

function toggleWidget(trayBounds) {
  if (!widgetWin) createWidget();
  if (widgetWin.isVisible()) { widgetWin.hide(); return; }
  const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
  const area = display.workArea;
  let x = Math.round(trayBounds.x + trayBounds.width / 2 - WIDGET_W / 2);
  x = Math.max(area.x + 8, Math.min(x, area.x + area.width - WIDGET_W - 8));
  const y = Math.round(trayBounds.y + trayBounds.height + 6);
  widgetWin.setPosition(x, y, false);
  widgetWin.show();
  widgetWin.focus();
  widgetWin.webContents.send('widget:shown');
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'trayTemplate.png'));
  img.setTemplateImage(true);
  tray = new Tray(img);
  tray.setToolTip('Exponential — this week');
  tray.on('click', (_e, bounds) => toggleWidget(bounds));
}

ipcMain.handle('data:load', () => {
  try {
    return JSON.parse(fs.readFileSync(dataFile(), 'utf8'));
  } catch {
    return null;
  }
});

// Persist, then tell every other window so the widget and the main app stay in sync.
ipcMain.handle('data:save', (e, data) => {
  fs.writeFileSync(dataFile(), JSON.stringify(data, null, 2));
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.webContents.id !== e.sender.id) w.webContents.send('data:changed', data);
  }
});

ipcMain.on('widget:openMain', (_e, target) => {
  const win = createMainWindow();
  if (target) {
    const send = () => win.webContents.send('open', target);
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send); else send();
  }
  if (widgetWin) widgetWin.hide();
});
ipcMain.on('widget:close', () => { if (widgetWin) widgetWin.hide(); });

ipcMain.handle('google:getConfig', () => google.getConfig());
ipcMain.handle('google:setConfig', (_e, c) => google.setConfig(c));
ipcMain.handle('google:status', () => google.status());
ipcMain.handle('google:signIn', () => google.signIn());
ipcMain.handle('google:signOut', () => google.signOut());
ipcMain.handle('google:idToken', () => google.idToken());
ipcMain.handle('google:events', (_e, calendarId, from, to) => google.events(calendarId, from, to));

/** Auto-update from GitHub Releases: check shortly after launch and every two hours; install on request. */
function setupUpdates() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  const tell = (state, info) => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send('update:state', { state, ...info }); };
  autoUpdater.on('checking-for-update', () => tell('checking'));
  autoUpdater.on('update-available', (i) => tell('available', { version: i.version }));
  autoUpdater.on('update-not-available', () => tell('none'));
  autoUpdater.on('download-progress', (p) => tell('downloading', { percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (i) => tell('ready', { version: i.version }));
  autoUpdater.on('error', (e) => { console.error('[updater]', e); tell('error', { message: String(e?.message ?? e) }); });
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 8_000);
  setInterval(check, 2 * 60 * 60 * 1000);
}
ipcMain.on('update:install', () => { if (app.isPackaged) autoUpdater.quitAndInstall(); });
ipcMain.on('update:check', () => { if (app.isPackaged) autoUpdater.checkForUpdates().catch(() => {}); });
ipcMain.handle('app:version', () => app.getVersion());

app.whenReady().then(() => {
  setupUpdates();
  // In development the dock shows Electron's own icon unless we set ours.
  if (process.platform === 'darwin' && app.dock) app.dock.setIcon(iconPath);
  createMainWindow();
  createTray();
  createWidget(); // pre-load so the first click is instant
  app.on('activate', () => {
    if (!mainWin) createMainWindow();
  });
});

// Closing the main window keeps the app (and its menu-bar widget) running on macOS.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
