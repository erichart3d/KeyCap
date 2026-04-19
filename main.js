/**
 * KeyCap - Electron entry point
 *
 * Responsibilities:
 *   1. Start the HTTP/WebSocket server (requires server/index.js)
 *   2. Open a BrowserWindow pointing at the editor UI
 *   3. Sit in the system tray so the server keeps running when
 *      the window is closed
 *   4. Clean up the keyboard hook on exit
 */

'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');

const SERVER_URL = 'http://127.0.0.1:8765';

let mainWindow = null;
let tray = null;
let serverModule = null;
let updateCheckTimeout = null;
let updateCheckInterval = null;

// Single-instance lock
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
});

// Auto-update
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

function logUpdate(event, info) {
  console.log(`  [updater]    ${event}${info ? ' - ' + JSON.stringify(info) : ''}`);
}

function pushUpdate(phase, extra = {}) {
  logUpdate(phase, extra);
  if (serverModule?.broadcastUpdate) {
    serverModule.broadcastUpdate({ phase, ...extra });
  }
}

autoUpdater.on('checking-for-update', () => pushUpdate('checking'));
autoUpdater.on('update-available', (info) => pushUpdate('available', { version: info.version }));
autoUpdater.on('update-not-available', (info) => pushUpdate('up-to-date', { version: info.version }));
autoUpdater.on('download-progress', (progress) => pushUpdate('downloading', { pct: Math.round(progress.percent) }));
autoUpdater.on('update-downloaded', (info) => pushUpdate('ready', { version: info.version }));
autoUpdater.on('error', (err) => pushUpdate('error', { msg: err.message }));

function checkForUpdates() {
  // Only check in packaged builds - running via `npm run electron` has no
  // version context and would just spam errors.
  if (!app.isPackaged) {
    console.log('  [updater]    skipped (running in dev mode)');
    if (serverModule?.broadcastUpdate) {
      serverModule.broadcastUpdate({ phase: 'dev-mode' });
    }
    return;
  }
  autoUpdater.checkForUpdates().catch(err => {
    console.log(`  [updater]    check failed: ${err.message}`);
  });
}

// Server
function startServer() {
  // Runs in-process - same Node.js runtime as Electron, no child process needed.
  serverModule = require('./server/index.js');

  // If the server hits EADDRINUSE it calls process.exit(1) before we can
  // surface the error - so listen for the process going down here and show
  // a friendly dialog instead of the raw Node stack-trace modal.
  process.on('exit', (code) => {
    if (code === 1 && serverModule?.bindError) {
      // Too late to show dialogs from `exit` - the message was logged to
      // the console. The single-instance lock should prevent this in
      // practice; this block is defensive only.
    }
  });
}

// Catch the unhandled EADDRINUSE bubbling up from the server's listen() call
// before the server's own error handler swallows it, so we can show a clean
// message and quit without the ugly "JavaScript error" modal.
process.on('uncaughtException', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error('  [main]       Port 8765 is already in use - another KeyCap');
    console.error('               (or orphan) is holding it. Asking user.');
    const choice = dialog.showMessageBoxSync({
      type: 'error',
      title: 'KeyCap is already running',
      message: 'KeyCap could not start because port 8765 is already in use.',
      detail:
        'Another copy of KeyCap (or a leftover background process) is still running. ' +
        'Open Task Manager, end any "KeyCap" and "node" processes, then try again.\n\n' +
        'Click "Open Task Manager" to do that now, or "Quit" to exit.',
      buttons: ['Open Task Manager', 'Quit'],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice === 0) {
      shell.openPath('C:\\Windows\\System32\\taskmgr.exe').catch(() => {});
    }
    app.exit(1);
    return;
  }
  console.error('  [main]       uncaught exception:', err);
});

// Editor window
function createWindow() {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1520,
    height: 900,
    minWidth: 1280,
    minHeight: 720,
    title: 'KeyCap',
    backgroundColor: '#0a000f',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    show: false,
  });

  mainWindow.setMenu(null);
  mainWindow.loadURL(`${SERVER_URL}/editor`);
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Clicking X quits the whole app (server + tray) so the user can relaunch cleanly.
  mainWindow.on('close', () => {
    app.isQuitting = true;
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// Tray
function loadTrayIcon() {
  const iconPath = path.join(__dirname, 'assets', '256Icon.png');
  try {
    const img = nativeImage.createFromPath(iconPath);
    if (!img.isEmpty()) return img;
  } catch (_) {}
  return nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ' +
    'AAAAC0lEQVQI12NgAAIABQAABjE+ibYAAAAASUVORK5CYII='
  );
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: 'Open Editor',
      click: () => createWindow(),
    },
    {
      label: `Overlay URL - ${SERVER_URL}/`,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Quit KeyCap',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);
}

function createTray() {
  if (tray) return;
  tray = new Tray(loadTrayIcon());
  tray.setToolTip('KeyCap - key overlay running');
  tray.setContextMenu(buildTrayMenu());
  tray.on('double-click', () => createWindow());
}

// App lifecycle
app.whenReady().then(() => {
  startServer();
  if (serverModule?.setUpdateInstaller) {
    serverModule.setUpdateInstaller(() => {
      app.isQuitting = true;
      autoUpdater.quitAndInstall();
    });
  }

  // Give the HTTP server ~400 ms to bind before loading the editor URL.
  setTimeout(() => {
    createWindow();
    createTray();
  }, 400);

  // Kick off the update check after the window is up so startup is not blocked.
  updateCheckTimeout = setTimeout(checkForUpdates, 3000);
  updateCheckInterval = setInterval(checkForUpdates, 4 * 60 * 60 * 1000);
});

app.on('window-all-closed', () => {
  app.isQuitting = true;
  app.quit();
});

app.on('before-quit', () => {
  app.isQuitting = true;
  if (updateCheckTimeout) {
    clearTimeout(updateCheckTimeout);
    updateCheckTimeout = null;
  }
  if (updateCheckInterval) {
    clearInterval(updateCheckInterval);
    updateCheckInterval = null;
  }
  if (tray) {
    tray.destroy();
    tray = null;
  }
  if (serverModule?.shutdown) serverModule.shutdown();
});

// Safety net: if something keeps the event loop alive past normal quit,
// force the whole process down after 1.5s.
app.on('will-quit', () => {
  setTimeout(() => {
    process.exit(0);
  }, 1500).unref();
});

app.on('activate', () => createWindow());
