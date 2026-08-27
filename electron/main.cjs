const { app, BrowserWindow, ipcMain, Menu, Notification, Tray, nativeImage, screen, shell } = require('electron');
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
let reallyQuit = false; // ⌘Q only closes the main window; the tray's Quit (and the updater) set this

/* ── UI zoom: our own factor, applied to the main window and persisted, so a stray
   pinch/zoom never sticks someone's app at a weird size. ⌘+ / ⌘- / ⌘0 adjust it.
   On top of that, macOS "display scaling" (Larger Text ⋯ More Space) is compensated:
   a MacBook panel's logical width shrinks as the user zooms the system in, so scaling
   our UI by logicalWidth/1512 keeps it the same physical size on every setting. ── */
const zoomFile = () => path.join(app.getPath('userData'), 'zoom.json');
const DEFAULT_ZOOM = 0.8;
let zoomFactor = DEFAULT_ZOOM;
try { zoomFactor = JSON.parse(fs.readFileSync(zoomFile(), 'utf8')).factor || DEFAULT_ZOOM; } catch { /* default */ }
function displayZoom() {
  if (process.platform !== 'darwin') return 1;
  try {
    const d = mainWin && !mainWin.isDestroyed() ? screen.getDisplayMatching(mainWin.getBounds()) : screen.getPrimaryDisplay();
    if (!d.internal) return 1; // external monitors: logical size varies with hardware, not a zoom choice
    return Math.min(1.3, Math.max(0.7, Math.round((d.workAreaSize.width / 1512) * 20) / 20));
  } catch { return 1; }
}
function applyZoom() {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.setZoomFactor(zoomFactor * displayZoom());
}
function setZoom(f) {
  zoomFactor = Math.min(1.6, Math.max(0.7, Math.round(f * 10) / 10));
  applyZoom();
  try { fs.writeFileSync(zoomFile(), JSON.stringify({ factor: zoomFactor })); } catch { /* ignore */ }
}

const WIDGET_W = 640;
const WIDGET_H = 460;

function loadRenderer(win, mode) {
  // Links in notes (window.open / target=_blank) go to the default browser, never a new Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // A fixed, per-app zoom: no pinch zoom, and any zoom Chromium remembered per-origin is overridden.
  win.webContents.on('did-finish-load', () => {
    win.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {});
    if (mode === 'widget') win.webContents.setZoomFactor(1);
    else applyZoom();
  });
  if (devUrl) win.loadURL(mode ? `${devUrl}?mode=${mode}` : devUrl);
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), mode ? { query: { mode } } : undefined);
}

/** Standard menus, but zoom is ours (persisted factor instead of Chromium's per-origin memory). */
function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => setZoom(zoomFactor + 0.1) },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', visible: false, acceleratorWorksWhenHidden: true, click: () => setZoom(zoomFactor + 0.1) },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => setZoom(zoomFactor - 0.1) },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => setZoom(DEFAULT_ZOOM) },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]));
}

function createMainWindow() {
  if (process.platform === 'darwin' && app.dock) { app.dock.show(); }
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
  mainWin.on('moved', applyZoom); // moving to a display with different scaling re-fits the UI
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
  // Below the tray on macOS (menu bar at top); above it when it wouldn't fit (Windows taskbar at bottom).
  let y = Math.round(trayBounds.y + trayBounds.height + 6);
  if (y + WIDGET_H > area.y + area.height) y = Math.round(trayBounds.y - WIDGET_H - 6);
  widgetWin.setPosition(x, y, false);
  widgetWin.show();
  widgetWin.focus();
  widgetWin.webContents.send('widget:shown');
}

function createTray() {
  // macOS gets the template glyph (recolored by the menu bar); Windows needs the colored icon,
  // since a black template image disappears on the dark taskbar.
  let img;
  if (process.platform === 'darwin') {
    img = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'trayTemplate.png'));
    img.setTemplateImage(true);
  } else {
    img = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  }
  tray = new Tray(img);
  tray.setToolTip('Exponential — this week');
  tray.on('click', (_e, bounds) => toggleWidget(bounds));
  // ⌘Q keeps the widget alive, so the tray is where the app can really be quit.
  tray.on('right-click', () => tray.popUpContextMenu(Menu.buildFromTemplate([
    { label: 'Open Exponential', click: () => createMainWindow() },
    { type: 'separator' },
    { label: 'Quit Exponential', click: () => { reallyQuit = true; app.quit(); } },
  ])));
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

// Where Claude Desktop keeps its config, per platform.
function claudeDesktopDir() {
  return process.platform === 'win32' ? path.join(process.env.APPDATA ?? '', 'Claude')
    : process.platform === 'darwin' ? path.join(app.getPath('home'), 'Library', 'Application Support', 'Claude')
    : path.join(app.getPath('home'), '.config', 'Claude');
}

function mcpServerPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'mcp', 'server.bundle.mjs')
    : path.join(__dirname, '..', 'mcp', 'server.mjs');
}

// Is our MCP server currently registered (and its files still on disk)?
ipcMain.handle('mcp:status', () => {
  const targets = [];
  const entryOk = (e) => e && Array.isArray(e.args) && fs.existsSync(e.args[0] ?? '');
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(claudeDesktopDir(), 'claude_desktop_config.json'), 'utf8'));
    if (entryOk(cfg.mcpServers?.exponential)) targets.push('Claude Desktop');
  } catch { /* not installed / not connected */ }
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(app.getPath('home'), '.claude.json'), 'utf8'));
    if (entryOk(cfg.mcpServers?.exponential)) targets.push('Claude Code');
  } catch { /* not installed / not connected */ }
  return { connected: targets.length > 0, targets, entry: { command: process.execPath, serverPath: mcpServerPath() } };
});

/* ── "Connect to Claude": register the bundled MCP server with Claude Desktop and Claude Code.
   The Exponential binary itself is the Node runtime (ELECTRON_RUN_AS_NODE), so nothing else
   needs to be installed. ── */
ipcMain.handle('mcp:connect', () => {
  const { execSync } = require('node:child_process');
  const serverPath = mcpServerPath();
  if (!fs.existsSync(serverPath)) return { ok: false, messages: ['This build is missing the Claude connector files.'] };
  const entry = { command: process.execPath, args: [serverPath], env: { ELECTRON_RUN_AS_NODE: '1' } };
  const messages = [];

  // Claude Desktop: merge our server into its JSON config (created on install; only touch it if Claude exists).
  try {
    const dir = claudeDesktopDir();
    if (fs.existsSync(dir)) {
      const f = path.join(dir, 'claude_desktop_config.json');
      let cfg = {};
      try { cfg = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* fresh */ }
      cfg.mcpServers = { ...cfg.mcpServers, exponential: entry };
      fs.writeFileSync(f, JSON.stringify(cfg, null, 2));
      messages.push('Claude Desktop — connected. Quit Claude Desktop fully (⌘Q) and reopen it: Exponential then appears in the chat’s tools menu and under Settings → Developer (not in the Connectors gallery).');
    }
  } catch (e) { messages.push(`Claude Desktop: ${e.message}`); }

  // Claude Code: through its own CLI (resolved via a login shell, since GUI apps don't get the terminal's PATH).
  try {
    const probe = execSync(
      process.platform === 'win32' ? 'where claude' : '/bin/zsh -lc "command -v claude"',
      { encoding: 'utf8', timeout: 10_000 }).trim().split(/\r?\n/)[0];
    if (probe) {
      try { execSync(`${JSON.stringify(probe)} mcp remove -s user exponential`, { encoding: 'utf8', timeout: 15_000 }); } catch { /* wasn't there */ }
      try {
        // The server name must come before -e: the env flag is greedy and would swallow it.
        execSync(`${JSON.stringify(probe)} mcp add exponential -s user -e ELECTRON_RUN_AS_NODE=1 -- ${JSON.stringify(entry.command)} ${JSON.stringify(serverPath)}`,
          { encoding: 'utf8', timeout: 15_000 });
        messages.push('Claude Code — connected for new sessions.');
      } catch (e) {
        messages.push(`Claude Code: ${(e.stderr?.toString() || e.message || String(e)).trim().split('\n')[0]}`);
      }
    }
  } catch { /* no claude CLI on this machine */ }

  if (!messages.length) return { ok: false, messages: ['Claude wasn\'t found on this computer. Install Claude Desktop or Claude Code, then try again.'] };
  return { ok: true, messages };
});

// State the out-of-process MCP server needs: the current team and whether the master plan
// is unlocked (Claude may only edit the plan while the user has it unlocked in the app).
ipcMain.on('state:set', (_e, p) => {
  try {
    const f = path.join(app.getPath('userData'), 'shared-state.json');
    const cur = (() => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } })();
    fs.writeFileSync(f, JSON.stringify({ ...cur, ...p, updatedAt: new Date().toISOString() }));
  } catch { /* ignore */ }
});

// System notifications for the inbox. Both renderers (main + widget) report what they see,
// so dedupe by notification id here; clicking one opens the referenced item in the main window.
const notifiedIds = new Set();
ipcMain.on('notify', (_e, { id, title, body, ref }) => {
  if (!id || notifiedIds.has(id) || !Notification.isSupported()) return;
  notifiedIds.add(id);
  if (notifiedIds.size > 1000) notifiedIds.delete(notifiedIds.values().next().value);
  const n = new Notification({ title: title || 'Exponential', body: body || '' });
  n.on('click', () => {
    const win = createMainWindow();
    if (ref) {
      const send = () => win.webContents.send('open', ref);
      if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send); else send();
    }
  });
  n.show();
});

// Cloud mode: a window that just wrote tells the others so they reload right away
// (realtime would get there too, but this is instant and covers same-machine deletes).
ipcMain.on('cloud:ping', (e) => {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.webContents.id !== e.sender.id) w.webContents.send('cloud:ping');
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
ipcMain.handle('google:idToken', (_e, force) => google.idToken(!!force));
ipcMain.handle('google:hasCalendar', () => google.hasCalendarScope());
ipcMain.handle('google:grantCalendar', () => google.grantCalendar());
ipcMain.handle('google:events', (_e, calendarId, from, to) => google.events(calendarId, from, to));

/** Auto-update from GitHub Releases: check shortly after launch and every two hours; install on request. */
function setupUpdates() {
  if (!app.isPackaged) return;
  const logFile = path.join(app.getPath('userData'), 'updater.log');
  const log = (...a) => { try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${a.join(' ')}\n`); } catch { /* ignore */ } };
  autoUpdater.logger = { info: (m) => log('info', m), warn: (m) => log('warn', m), error: (m) => log('error', m), debug: () => {} };
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
ipcMain.on('update:install', () => { if (app.isPackaged) { reallyQuit = true; autoUpdater.quitAndInstall(); } });
ipcMain.on('update:check', () => { if (app.isPackaged) autoUpdater.checkForUpdates().catch(() => {}); });
ipcMain.handle('app:version', () => app.getVersion());

app.whenReady().then(() => {
  buildMenu();
  setupUpdates();
  screen.on('display-metrics-changed', applyZoom); // e.g. the user changes macOS display scaling
  // In development the dock shows Electron's own icon unless we set ours.
  if (process.platform === 'darwin' && app.dock) app.dock.setIcon(iconPath);
  createMainWindow();
  createTray();
  createWidget(); // pre-load so the first click is instant
  app.on('activate', () => {
    createMainWindow();
  });
});

// ⌘Q (and dock → Quit) closes the main window and steps out of the Dock; the menu-bar
// widget keeps running. Quitting for real happens from the tray menu or the updater.
app.on('before-quit', (e) => {
  if (process.platform !== 'darwin' || reallyQuit) return;
  e.preventDefault();
  if (mainWin && !mainWin.isDestroyed()) mainWin.close();
  if (widgetWin && !widgetWin.isDestroyed()) widgetWin.hide();
  app.dock?.hide();
});

// Closing the main window keeps the app (and its menu-bar widget) running on macOS.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
