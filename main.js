/**
 * KeyCap - Electron entry point
 *
 * Responsibilities:
 *   1. Run the shared app runtime (keyboard hook, config, profiles)
 *   2. Load the desktop editor locally from disk
 *   3. Start/stop the OBS overlay server on demand
 *   4. Keep tray + updater lifecycle in sync with the app shell
 */

'use strict';

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  shell,
  dialog,
  ipcMain,
  desktopCapturer,
  screen,
} = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs/promises');

const runtime = require('./server/runtime');
const serverModule = require('./server/index.js');

let mainWindow = null;
let tray = null;
let updateCheckTimeout = null;
let updateCheckInterval = null;
let overlayCaptureWindow = null;

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

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

function logUpdate(event, info) {
  console.log(`  [updater]    ${event}${info ? ' - ' + JSON.stringify(info) : ''}`);
}

function sendAppEvent(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('keycap:app-event', payload);
}

function getStreamingStatus() {
  return {
    running: serverModule.isRunning(),
    overlayUrl: serverModule.getOverlayUrl(),
  };
}

function getShellState() {
  return {
    appVersion: app.getVersion(),
    overlayUrl: serverModule.getOverlayUrl(),
    editorUrl: serverModule.getEditorUrl(),
    serverRunning: serverModule.isRunning(),
    focusedExe: runtime.keymaps.activeExe || null,
    activeProfile: runtime.keymaps.activeProfile?.name ?? null,
    desktop: true,
  };
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(buildTrayMenu());
  tray.setToolTip(serverModule.isRunning()
    ? 'KeyCap - streaming server running'
    : 'KeyCap - editor open, streaming server off');
}

function pushUpdate(phase, extra = {}) {
  logUpdate(phase, extra);
  const payload = runtime.setUpdateStatus({ phase, ...extra });
  sendAppEvent(payload);
}

autoUpdater.on('checking-for-update', () => pushUpdate('checking'));
autoUpdater.on('update-available', (info) => pushUpdate('available', { version: info.version }));
autoUpdater.on('update-not-available', (info) => pushUpdate('up-to-date', { version: info.version }));
autoUpdater.on('download-progress', (progress) => pushUpdate('downloading', { pct: Math.round(progress.percent) }));
autoUpdater.on('update-downloaded', (info) => pushUpdate('ready', { version: info.version }));
autoUpdater.on('error', (err) => pushUpdate('error', { msg: err.message }));

function checkForUpdates() {
  if (!app.isPackaged) {
    console.log('  [updater]    skipped (running in dev mode)');
    const payload = runtime.setUpdateStatus({ phase: 'dev-mode' });
    sendAppEvent(payload);
    return;
  }
  autoUpdater.checkForUpdates().catch((err) => {
    console.log(`  [updater]    check failed: ${err.message}`);
  });
}

function showPortInUseDialog() {
  const choice = dialog.showMessageBoxSync({
    type: 'error',
    title: 'KeyCap server is already running',
    message: 'KeyCap could not start the streaming server because port 8765 is already in use.',
    detail:
      'Another copy of KeyCap (or a leftover background process) is still holding the port. ' +
      'Open Task Manager, end any "KeyCap" and "node" processes, then try again.\n\n' +
      'Click "Open Task Manager" to do that now, or "Close" to keep working in the editor.',
    buttons: ['Open Task Manager', 'Close'],
    defaultId: 0,
    cancelId: 1,
  });
  if (choice === 0) {
    shell.openPath('C:\\Windows\\System32\\taskmgr.exe').catch(() => {});
  }
}

async function ensureStreamingServer() {
  try {
    await serverModule.start();
    refreshTrayMenu();
    const status = getStreamingStatus();
    sendAppEvent({ type: 'server-status', ...status });
    sendAppEvent({ type: 'status', ...runtime.getStatus(status.running) });
    return status;
  } catch (err) {
    if (err && err.code === 'EADDRINUSE') {
      showPortInUseDialog();
    } else {
      console.error('  [main]       failed to start streaming server:', err);
    }
    throw err;
  }
}

async function stopStreamingServer() {
  await serverModule.stop();
  refreshTrayMenu();
  const status = getStreamingStatus();
  sendAppEvent({ type: 'server-status', ...status });
  sendAppEvent({ type: 'status', ...runtime.getStatus(status.running) });
  return status;
}

// ─── Offscreen overlay capture ────────────────────────────────────────────────
// Recording mode needs the keycap overlay baked into the video. Instead of
// redrawing it onto a canvas with hand-rolled primitives (which loses
// gradients, shadows, fonts, animations), we render the REAL overlay page in
// a hidden offscreen BrowserWindow and pipe its paint frames to the editor.

function destroyOverlayCaptureWindow() {
  if (overlayCaptureWindow && !overlayCaptureWindow.isDestroyed()) {
    try { overlayCaptureWindow.destroy(); } catch (_) {}
  }
  overlayCaptureWindow = null;
}

async function createOverlayCaptureWindow({ width, height, fps }) {
  destroyOverlayCaptureWindow();

  // Overlay page is served by the streaming server — make sure it's up.
  if (!serverModule.isRunning()) {
    await ensureStreamingServer();
  }
  const overlayUrl = serverModule.getOverlayUrl();
  if (!overlayUrl) return { ok: false, error: 'overlay url unavailable' };

  const w = Math.max(640, Math.floor(Number(width) || 1920));
  const h = Math.max(360, Math.floor(Number(height) || 1080));
  const frameRate = Math.max(1, Math.min(60, Math.floor(Number(fps) || 60)));

  overlayCaptureWindow = new BrowserWindow({
    width: w,
    height: h,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      offscreen: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  overlayCaptureWindow.webContents.setFrameRate(frameRate);
  overlayCaptureWindow.webContents.setAudioMuted(true);

  overlayCaptureWindow.webContents.on('paint', (_event, _dirty, image) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const size = image.getSize();
    // getBitmap() returns BGRA — copy it, since Electron reuses the underlying
    // buffer for the next frame otherwise.
    const bitmap = Buffer.from(image.getBitmap());
    mainWindow.webContents.send('keycap:overlay-frame', {
      width: size.width,
      height: size.height,
      buffer: bitmap,
    });
  });

  try {
    await overlayCaptureWindow.loadURL(overlayUrl);
    return { ok: true, width: w, height: h, fps: frameRate };
  } catch (err) {
    destroyOverlayCaptureWindow();
    return { ok: false, error: err.message };
  }
}

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
      preload: path.join(__dirname, 'preload.js'),
    },
    show: false,
  });

  mainWindow.setMenu(null);
  mainWindow.loadFile(path.join(__dirname, 'editor', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

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
  const running = serverModule.isRunning();
  return Menu.buildFromTemplate([
    {
      label: 'Open Editor',
      click: () => createWindow(),
    },
    {
      label: running ? 'Stop Streaming Server' : 'Start Streaming Server',
      click: () => {
        const op = running ? stopStreamingServer() : ensureStreamingServer();
        op.catch(() => {});
      },
    },
    {
      label: `Overlay URL - ${running ? serverModule.getOverlayUrl() : 'server stopped'}`,
      enabled: running,
      click: () => {
        if (running) shell.openExternal(serverModule.getOverlayUrl());
      },
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
  refreshTrayMenu();
  tray.on('double-click', () => createWindow());
}

async function handleApiRequest({ method, path: requestPath, body }) {
  const verb = String(method || 'GET').toUpperCase();
  const request = String(requestPath || '');

  if (verb === 'GET' && request === '/api/status') {
    return runtime.getStatus(serverModule.isRunning());
  }
  if (verb === 'GET' && request === '/api/config') {
    return runtime.getConfig();
  }
  if (verb === 'PUT' && request === '/api/config') {
    return runtime.updateConfig(body || {});
  }
  if (verb === 'GET' && request === '/api/keymaps') {
    return runtime.listKeymaps();
  }
  if (verb === 'GET' && request === '/api/presets') {
    return runtime.listPresets();
  }
  if (verb === 'GET' && request === '/api/backgrounds') {
    return runtime.listBackgrounds();
  }
  if (verb === 'GET' && request === '/api/update-status') {
    return runtime.getUpdateStatus();
  }
  if (verb === 'POST' && request === '/api/update-install') {
    return runtime.runUpdateInstaller();
  }
  if (verb === 'POST' && request === '/api/_debug-update') {
    return runtime.runDebugUpdateSequence();
  }
  if (verb === 'POST' && request === '/api/test-key') {
    const label = String(body?.label || '').trim();
    if (!label) throw new Error('label required');
    return runtime.emitTestKey(label, body?.description || null);
  }
  if (verb === 'POST' && request === '/api/shutdown') {
    return stopStreamingServer();
  }

  let match = request.match(/^\/api\/keymaps\/(.+)$/);
  if (match) {
    if (verb === 'PUT') return runtime.saveKeymap(decodeURIComponent(match[1]), body || {});
    if (verb === 'DELETE') return runtime.deleteKeymap(decodeURIComponent(match[1]));
  }

  match = request.match(/^\/api\/presets\/(.+)$/);
  if (match) {
    const slug = decodeURIComponent(match[1]);
    if (verb === 'GET') return runtime.readPreset(slug);
    if (verb === 'PUT') return runtime.savePreset(slug, body || {});
    if (verb === 'DELETE') return runtime.deletePreset(slug);
  }

  throw new Error(`Unknown API route: ${verb} ${request}`);
}

function registerIpc() {
  ipcMain.handle('keycap:api', (_event, request) => handleApiRequest(request || {}));
  ipcMain.handle('keycap:get-shell-state', () => getShellState());
  ipcMain.handle('keycap:get-streaming-status', () => getStreamingStatus());
  ipcMain.handle('keycap:start-streaming-server', () => ensureStreamingServer());
  ipcMain.handle('keycap:stop-streaming-server', () => stopStreamingServer());
  ipcMain.handle('keycap:choose-recording-output-path', async () => {
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose recording output folder',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: app.getPath('videos'),
    });
    return result.canceled ? null : (result.filePaths[0] || null);
  });
  ipcMain.handle('keycap:list-capture-sources', async () => {
    const displayMap = new Map((screen.getAllDisplays() || []).map((display, index) => [
      String(display.id),
      {
        id: String(display.id),
        index: index + 1,
        label: `Display ${index + 1}`,
        primary: String(display.id) === String(screen.getPrimaryDisplay()?.id || ''),
        width: display.size?.width || display.bounds?.width || 0,
        height: display.size?.height || display.bounds?.height || 0,
      },
    ]));
    const mapSource = (source, index, preferredKind = '') => {
      const displayId = source.display_id || '';
      const name = String(source.name || '');
      const kind = preferredKind
        || (source.id.startsWith('screen:') ? 'display' : '')
        || (displayId && displayMap.has(String(displayId)) ? 'display' : '')
        || (/^entire screen$/i.test(name) || /^screen\s+\d+/i.test(name) ? 'display' : 'window');
      const displayMeta = displayId ? displayMap.get(String(displayId)) : null;
      const thumbnail = source.thumbnail && typeof source.thumbnail.toDataURL === 'function' && !source.thumbnail.isEmpty?.()
        ? source.thumbnail.toDataURL()
        : '';
      const appIcon = source.appIcon && typeof source.appIcon.toDataURL === 'function' && !source.appIcon.isEmpty?.()
        ? source.appIcon.toDataURL()
        : '';
      return {
        id: source.id,
        name,
        kind,
        displayId,
        displayIndex: displayMeta?.index || (kind === 'display' ? index + 1 : 0),
        displayLabel: displayMeta?.label || '',
        isPrimaryDisplay: !!displayMeta?.primary,
        width: displayMeta?.width || 0,
        height: displayMeta?.height || 0,
        thumbnail,
        appIcon,
      };
    };

    let screenSources = [];
    let windowSources = [];
    try {
      screenSources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 0, height: 0 },
      });
    } catch (error) {
      console.warn('[main] screen capture source enumeration failed', error);
    }
    try {
      windowSources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: 0, height: 0 },
        fetchWindowIcons: true,
      });
    } catch (error) {
      console.warn('[main] window capture source enumeration failed', error);
    }

    return [
      ...screenSources.map((source, index) => mapSource(source, index, 'display')),
      ...windowSources.map((source, index) => mapSource(source, index, 'window')),
    ];
  });
  ipcMain.handle('keycap:save-recording-file', async (_event, payload) => {
    const bytes = payload?.bytes ? Buffer.from(payload.bytes) : null;
    if (!bytes || !bytes.length) throw new Error('recording payload missing');
    const ext = String(payload?.ext || 'webm').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'webm';
    const outputDir = String(payload?.outputDir || app.getPath('videos'));
    await fs.mkdir(outputDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/:/g, '-').replace('T', '_').slice(0, 19);
    const outputPath = path.join(outputDir, `KeyCap_${stamp}.${ext}`);
    await fs.writeFile(outputPath, bytes);
    return { ok: true, path: outputPath };
  });
  ipcMain.handle('keycap:reveal-path', (_event, targetPath) => {
    shell.showItemInFolder(String(targetPath || ''));
    return { ok: true };
  });
  ipcMain.handle('keycap:open-external', (_event, url) => shell.openExternal(String(url || '')));
  ipcMain.handle('keycap:start-overlay-capture', (_event, options) => {
    return createOverlayCaptureWindow(options || {});
  });
  ipcMain.handle('keycap:stop-overlay-capture', () => {
    destroyOverlayCaptureWindow();
    return { ok: true };
  });
}

process.on('uncaughtException', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error('  [main]       Port 8765 is already in use.');
    showPortInUseDialog();
    return;
  }
  console.error('  [main]       uncaught exception:', err);
});

app.whenReady().then(() => {
  runtime.start();
  runtime.setUpdateInstaller(() => {
    app.isQuitting = true;
    autoUpdater.quitAndInstall(true, true);
  });

  runtime.on('key', ({ label, description }) => {
    const payload = { type: 'key', label };
    if (description) payload.description = description;
    sendAppEvent(payload);
  });

  runtime.on('config', (config) => {
    sendAppEvent({ type: 'config', ...config });
  });

  runtime.on('updater', (payload) => {
    sendAppEvent(payload);
  });

  runtime.on('status', () => {
    sendAppEvent({ type: 'status', ...runtime.getStatus(serverModule.isRunning()) });
  });

  registerIpc();
  createWindow();
  createTray();

  updateCheckTimeout = setTimeout(checkForUpdates, 3000);
  updateCheckInterval = setInterval(checkForUpdates, 4 * 60 * 60 * 1000);
});

app.on('window-all-closed', () => {
  app.isQuitting = true;
  app.quit();
});

app.on('before-quit', () => {
  app.isQuitting = true;
  destroyOverlayCaptureWindow();
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
  serverModule.shutdown({ stopRuntime: true }).catch(() => {});
});

app.on('will-quit', () => {
  setTimeout(() => {
    process.exit(0);
  }, 1500).unref();
});

app.on('activate', () => createWindow());
