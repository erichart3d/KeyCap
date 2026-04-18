/**
 * KeyCap — Electron entry point
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
const fs   = require('fs');

const SERVER_URL = 'http://127.0.0.1:8765';

let mainWindow   = null;
let tray         = null;
let serverModule = null;

// ─── Single-instance lock ────────────────────────────────────────────────────
// Without this, double-clicking the .exe while a previous instance is still
// running (or orphan-stuck) crashes the new one with EADDRINUSE on port 8765.
// Request the lock before anything else — if we don't own it, surface the
// existing window and quit silently so the user just sees their running app.

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

app.on('second-instance', () => {
  // Someone tried to launch a second copy — bring the existing window forward
  // instead of letting the duplicate crash with a JS error dialog.
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
});

// ─── Auto-update ─────────────────────────────────────────────────────────────
// Silent mode: check on launch, download in background, install on next quit.
// User never sees a dialog — they just find themselves running the new version
// after the app is restarted normally.

autoUpdater.autoDownload           = true;
autoUpdater.autoInstallOnAppQuit   = true;

// Log events so we can diagnose update issues from the console / log file.
function logUpdate(event, info) {
  console.log(`  [updater]    ${event}${info ? ' — ' + JSON.stringify(info) : ''}`);
}
autoUpdater.on('checking-for-update', () => logUpdate('checking for update'));
autoUpdater.on('update-available',    (i) => logUpdate('update available', { version: i.version }));
autoUpdater.on('update-not-available',(i) => logUpdate('up to date',       { version: i.version }));
autoUpdater.on('download-progress',   (p) => logUpdate('downloading',      { pct: Math.round(p.percent) }));
autoUpdater.on('update-downloaded',   (i) => logUpdate('update ready — will install on quit', { version: i.version }));
autoUpdater.on('error',               (e) => logUpdate('error', { msg: e.message }));

function checkForUpdates() {
  // Only check in packaged builds — running via `npm run electron` has no
  // version context and would just spam errors.
  if (!app.isPackaged) {
    console.log('  [updater]    skipped (running in dev mode)');
    return;
  }
  autoUpdater.checkForUpdates().catch(err => {
    console.log(`  [updater]    check failed: ${err.message}`);
  });
}

// ─── Server ───────────────────────────────────────────────────────────────────

function startServer() {
  // Runs in-process — same Node.js runtime as Electron, no child process needed.
  serverModule = require('./server/index.js');

  // If the server hits EADDRINUSE it calls process.exit(1) before we can
  // surface the error — so listen for the process going down here and show
  // a friendly dialog instead of the raw Node stack-trace modal.
  process.on('exit', (code) => {
    if (code === 1 && serverModule?.bindError) {
      // Too late to show dialogs from `exit` — the message was logged to
      // the console. The single-instance lock should prevent this in
      // practice; this block is defensive only.
    }
  });
}

// Catch the unhandled EADDRINUSE bubbling up from the server's listen() call
// *before* the server's own error handler swallows it, so we can show a
// clean message and quit without the ugly "JavaScript error" modal.
process.on('uncaughtException', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`  [main]       Port 8765 is already in use — another KeyCap`);
    console.error(`               (or orphan) is holding it. Asking user.`);
    const choice = dialog.showMessageBoxSync({
      type:     'error',
      title:    'KeyCap is already running',
      message:  'KeyCap couldn\'t start because port 8765 is already in use.',
      detail:   'Another copy of KeyCap (or a leftover background process) is ' +
                'still running. Open Task Manager, end any "KeyCap" and "node" ' +
                'processes, then try again.\n\nClick "Open Task Manager" to do ' +
                'that now, or "Quit" to exit.',
      buttons:  ['Open Task Manager', 'Quit'],
      defaultId: 0,
      cancelId:  1,
    });
    if (choice === 0) {
      shell.openPath('C:\\Windows\\System32\\taskmgr.exe').catch(() => {});
    }
    app.exit(1);
    return;
  }
  // Anything else — let Electron show its normal error (rare in practice).
  console.error('  [main]       uncaught exception:', err);
});

// ─── Editor window ────────────────────────────────────────────────────────────

function createWindow() {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width:           1520,
    height:          900,
    minWidth:        1280,   // 3-panel workspace needs the room
    minHeight:       720,
    title:           'KeyCap',
    backgroundColor: '#0a000f',
    autoHideMenuBar: true,   // hide the File/Edit/View/Window/Help bar
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
    },
    show: false,   // revealed in ready-to-show to avoid white flash
  });

  // Belt-and-suspenders — also drop the menu entirely so Alt key won't reveal it.
  mainWindow.setMenu(null);

  mainWindow.loadURL(`${SERVER_URL}/editor`);

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Clicking X quits the whole app (server + tray) so the user can relaunch
  // cleanly — previously this hid to tray, which caused port-in-use errors
  // when the user tried to reopen from the taskbar.
  mainWindow.on('close', () => {
    app.isQuitting = true;
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  // Open external links in the default browser, not a new Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ─── Tray ────────────────────────────────────────────────────────────────────

function loadTrayIcon() {
  // Look for assets/tray-icon.png next to main.js; fall back to blank if missing.
  const iconPath = path.join(__dirname, 'assets', '256Icon.png');
  try {
    const img = nativeImage.createFromPath(iconPath);
    if (!img.isEmpty()) return img;
  } catch (_) {}
  // Fallback: 1×1 transparent PNG so Electron doesn't throw
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
      label:   `Overlay URL — ${SERVER_URL}/`,
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
  tray = new Tray(loadTrayIcon());
  tray.setToolTip('KeyCap — key overlay running');
  tray.setContextMenu(buildTrayMenu());
  // Double-click on tray icon re-opens the editor window.
  tray.on('double-click', () => createWindow());
}

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  startServer();

  // Give the HTTP server ~400 ms to bind before loading the editor URL.
  setTimeout(() => {
    createWindow();
    createTray();
  }, 400);

  // Kick off the update check after the window is up so startup isn't blocked.
  // Runs once on launch; also re-check every 4 hours for long-running sessions.
  setTimeout(checkForUpdates, 3000);
  setInterval(checkForUpdates, 4 * 60 * 60 * 1000);
});

// Closing the last window now ends the session — server shuts down so the
// port frees up for the next launch. Tray-only mode was dropped because the
// app would refuse to restart while the previous instance was still bound.
app.on('window-all-closed', () => {
  app.isQuitting = true;
  app.quit();
});

// Stop the keyboard hook cleanly before Electron exits.
app.on('before-quit', () => {
  app.isQuitting = true;
  if (serverModule?.shutdown) serverModule.shutdown();
});

// Safety net: if something (a native thread from uiohook-napi, a lingering
// WebSocket, anything) keeps the event loop alive past normal quit, force
// the whole process down after 1.5s. This is what was leaving orphan
// KeyCap.exe + node.exe processes behind and holding port 8765.
app.on('will-quit', () => {
  setTimeout(() => {
    process.exit(0);
  }, 1500).unref();
});

// macOS: re-open window when clicking the dock icon.
app.on('activate', () => createWindow());
