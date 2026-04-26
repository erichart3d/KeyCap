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

if (app.isPackaged && !process.env.KEYCAP_DATA_ROOT) {
  process.env.KEYCAP_DATA_ROOT = app.getPath('userData');
}

const runtime = require('./server/runtime');
const serverModule = require('./server/index.js');
const nativeRecorder = require('./server/native-recorder');

let mainWindow = null;
let tray = null;
let updateCheckTimeout = null;
let updateCheckInterval = null;
let overlayCaptureWindow = null;
let overlayRecordingWindow = null;
let overlayPipeWindow = null;
let shutdownStarted = false;
let quitResumePending = false;

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
    nativeRecorderStatus: nativeRecorder.getStatus(),
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

function cleanupAppResources() {
  destroyOverlayCaptureWindow();
  destroyOverlayRecordingWindow();
  destroyOverlayPipeWindow();
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
}

async function shutdownApp() {
  if (shutdownStarted) return;
  shutdownStarted = true;
  cleanupAppResources();
  try {
    if (nativeRecorder.getStatus().recordingState === 'recording') {
      await stopNativeRecording();
    }
  } catch (err) {
    console.error('  [main]       recorder stop during shutdown failed:', err.message);
  }
  await nativeRecorder.shutdown().catch(() => {});
  await serverModule.shutdown({ stopRuntime: true }).catch(() => {});
}

async function startNativeRecording(payload = {}) {
  const result = await nativeRecorder.startRecording(payload || {});
  // From here on, if anything fails the sidecar session is already
  // running — we must stop it before rethrowing so it doesn't leak
  // (subsequent start attempts would hit "recording already in progress").
  try {
    const sources = await listNativeRecorderSources();
    const requestedId = String(payload?.sourceId || payload?.nativeSourceId || '');
    const source = sources.find((item) =>
      String(item.nativeSourceId || '') === requestedId || String(item.id || '') === requestedId
    );
    if (source && source.kind === 'display') {
      const width = Number(result?.width) || source.width;
      const height = Number(result?.height) || source.height;
      const fps = Number(result?.fps) || 60;
      if (nativeRecorder.hasOverlayPipe()) {
        const outcome = await createOverlayPipeWindow({ width, height, fps });
        if (outcome && outcome.ok === false) {
          console.error('  [main]       overlay pipe window failed:', outcome.error);
          // Fall back to visible overlay — recording continues either way.
          await createOverlayRecordingWindow(source);
        }
      } else {
        await createOverlayRecordingWindow(source);
      }
    }
    return result;
  } catch (err) {
    console.error('  [main]       overlay setup failed mid-record:', err.message);
    destroyOverlayPipeWindow();
    destroyOverlayRecordingWindow();
    try {
      await nativeRecorder.stopRecording();
    } catch (_) {}
    throw err;
  }
}

async function stopNativeRecording() {
  try {
    return await nativeRecorder.stopRecording();
  } finally {
    destroyOverlayPipeWindow();
    destroyOverlayRecordingWindow();
  }
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

async function listPreviewDisplaySources() {
  const displayMap = new Map((screen.getAllDisplays() || []).map((display, index) => [
    String(display.id),
    (() => {
      const bounds = display.bounds || { x: 0, y: 0, width: 0, height: 0 };
      const scaleFactor = Number(display.scaleFactor) || 1;
      return {
        id: String(display.id),
        index: index + 1,
        label: `Display ${index + 1}`,
        primary: String(display.id) === String(screen.getPrimaryDisplay()?.id || ''),
        scaleFactor,
        dipX: Number(bounds.x) || 0,
        dipY: Number(bounds.y) || 0,
        dipWidth: Number(bounds.width) || 0,
        dipHeight: Number(bounds.height) || 0,
        captureX: Number.isFinite(Number(display.nativeOrigin?.x))
          ? Number(display.nativeOrigin.x)
          : Math.round((Number(bounds.x) || 0) * scaleFactor),
        captureY: Number.isFinite(Number(display.nativeOrigin?.y))
          ? Number(display.nativeOrigin.y)
          : Math.round((Number(bounds.y) || 0) * scaleFactor),
        captureWidth: Math.max(0, Math.round((Number(bounds.width) || 0) * scaleFactor)),
        captureHeight: Math.max(0, Math.round((Number(bounds.height) || 0) * scaleFactor)),
      };
    })(),
  ]));
  let sources = [];
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 0, height: 0 },
    });
  } catch (error) {
    console.warn('[main] preview source enumeration failed', error);
  }
  return sources.map((source, index) => {
    const displayId = String(source.display_id || '');
    const displayMeta = displayId ? displayMap.get(displayId) : null;
    return {
      previewSourceId: source.id,
      displayId,
      displayIndex: displayMeta?.index || index + 1,
      displayLabel: displayMeta?.label || `Display ${index + 1}`,
      isPrimaryDisplay: !!displayMeta?.primary,
      scaleFactor: displayMeta?.scaleFactor || 1,
      dipX: displayMeta?.dipX || 0,
      dipY: displayMeta?.dipY || 0,
      dipWidth: displayMeta?.dipWidth || 0,
      dipHeight: displayMeta?.dipHeight || 0,
      captureX: displayMeta?.captureX || 0,
      captureY: displayMeta?.captureY || 0,
      captureWidth: displayMeta?.captureWidth || 0,
      captureHeight: displayMeta?.captureHeight || 0,
      thumbnail: source.thumbnail && typeof source.thumbnail.toDataURL === 'function' && !source.thumbnail.isEmpty?.()
        ? source.thumbnail.toDataURL()
        : '',
    };
  });
}

async function listNativeRecorderSources() {
  const [nativeSources, previewDisplays] = await Promise.all([
    nativeRecorder.listSources(),
    listPreviewDisplaySources(),
  ]);

  function pickPreviewDisplay(nativeSource, fallbackIndex) {
    const nativeX = Number(nativeSource.x);
    const nativeY = Number(nativeSource.y);
    const nativeWidth = Number(nativeSource.width);
    const nativeHeight = Number(nativeSource.height);
    const nativePrimary = !!nativeSource.isPrimaryDisplay;

    const exactBounds = previewDisplays.find((candidate) =>
      Number(candidate.dipX) === nativeX &&
      Number(candidate.dipY) === nativeY &&
      Number(candidate.dipWidth) === nativeWidth &&
      Number(candidate.dipHeight) === nativeHeight
    );
    if (exactBounds) return exactBounds;

    const sameOrigin = previewDisplays.find((candidate) =>
      Number(candidate.dipX) === nativeX &&
      Number(candidate.dipY) === nativeY
    );
    if (sameOrigin) return sameOrigin;

    const samePrimary = previewDisplays.find((candidate) =>
      !!candidate.isPrimaryDisplay === nativePrimary &&
      Number(candidate.dipWidth) === nativeWidth &&
      Number(candidate.dipHeight) === nativeHeight
    );
    if (samePrimary) return samePrimary;

    const displayIndex = Number(nativeSource.displayIndex || fallbackIndex + 1);
    return previewDisplays.find((candidate) => candidate.displayIndex === displayIndex) || null;
  }

  return nativeSources.map((source, index) => {
    const displayIndex = Number(source.displayIndex || index + 1);
    const preview = pickPreviewDisplay(source, index);
    return {
      id: preview?.previewSourceId || `native-display-${displayIndex}`,
      nativeSourceId: source.id,
      previewSourceId: preview?.previewSourceId || '',
      name: source.name || `Display ${displayIndex}`,
      kind: source.kind || 'display',
      displayId: String(source.displayId || preview?.displayId || ''),
      displayIndex,
      displayLabel: source.displayLabel || preview?.displayLabel || `Display ${displayIndex}`,
      isPrimaryDisplay: typeof source.isPrimaryDisplay === 'boolean'
        ? source.isPrimaryDisplay
        : !!preview?.isPrimaryDisplay,
      x: Number(source.x ?? preview?.dipX ?? 0),
      y: Number(source.y ?? preview?.dipY ?? 0),
      width: Number(source.width ?? preview?.dipWidth ?? 0),
      height: Number(source.height ?? preview?.dipHeight ?? 0),
      captureX: Number(source.captureX ?? preview?.captureX ?? 0),
      captureY: Number(source.captureY ?? preview?.captureY ?? 0),
      captureWidth: Number(source.captureWidth ?? preview?.captureWidth ?? 0),
      captureHeight: Number(source.captureHeight ?? preview?.captureHeight ?? 0),
      thumbnail: preview?.thumbnail || '',
      appIcon: '',
    };
  });
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

function destroyOverlayRecordingWindow() {
  if (overlayRecordingWindow && !overlayRecordingWindow.isDestroyed()) {
    try { overlayRecordingWindow.destroy(); } catch (_) {}
  }
  overlayRecordingWindow = null;
}

function destroyOverlayPipeWindow() {
  if (overlayPipeWindow && !overlayPipeWindow.isDestroyed()) {
    try { overlayPipeWindow.destroy(); } catch (_) {}
  }
  overlayPipeWindow = null;
}

// Offscreen overlay-at-capture-resolution for the native sidecar path. The
// `paint` BGRA frames are pushed over a named pipe to the Rust recorder,
// which composites them onto each captured display frame before handing it
// to ffmpeg. This replaces the visible always-on-top overlay window when
// the sidecar can do the composite — the screen stays clean during the
// recording.
async function createOverlayPipeWindow(source) {
  destroyOverlayPipeWindow();
  if (!serverModule.isRunning()) {
    await ensureStreamingServer();
  }
  const overlayUrl = serverModule.getOverlayUrl();
  if (!overlayUrl) return { ok: false, error: 'overlay url unavailable' };

  const width = Math.max(320, Number(source.width) || 1920);
  const height = Math.max(180, Number(source.height) || 1080);
  const fps = Math.max(1, Math.min(120, Number(source.fps) || 60));

  overlayPipeWindow = new BrowserWindow({
    width,
    height,
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

  overlayPipeWindow.webContents.setFrameRate(fps);
  overlayPipeWindow.webContents.setAudioMuted(true);

  let paintCount = 0;
  let sentCount = 0;
  let lastSize = null;
  // Rolling-1s paint-rate window. We need this to distinguish idle
  // (few paints — fine, screen didn't change) from animating-but-slow
  // (paints firing at <fps — the visible choppiness in the baked MP4).
  let windowStart = Date.now();
  let windowPaints = 0;
  overlayPipeWindow.webContents.on('paint', (_event, _dirty, image) => {
    const size = image.getSize();
    const bitmap = Buffer.from(image.getBitmap());
    const ok = nativeRecorder.pushOverlayFrame({
      width: size.width,
      height: size.height,
      buffer: bitmap,
    });
    paintCount++;
    windowPaints++;
    if (ok) sentCount++;
    if (!lastSize || lastSize.width !== size.width || lastSize.height !== size.height) {
      console.log(`  [main]       overlay paint size: ${size.width}x${size.height} (expected ${width}x${height})`);
      lastSize = size;
    }
    const now = Date.now();
    const elapsed = now - windowStart;
    if (elapsed >= 1000) {
      const rate = (windowPaints / (elapsed / 1000)).toFixed(1);
      console.log(`  [main]       overlay paint rate=${rate}/s total=${paintCount} (target=${fps})`);
      windowStart = now;
      windowPaints = 0;
    }
  });

  try {
    await overlayPipeWindow.loadURL(overlayUrl);
    return { ok: true, width, height, fps };
  } catch (err) {
    destroyOverlayPipeWindow();
    return { ok: false, error: err.message };
  }
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

async function createOverlayRecordingWindow(source) {
  destroyOverlayRecordingWindow();
  if (!serverModule.isRunning()) {
    await ensureStreamingServer();
  }
  const overlayUrl = serverModule.getOverlayUrl();
  if (!overlayUrl) return { ok: false, error: 'overlay url unavailable' };

  const width = Math.max(320, Number(source.width) || 1920);
  const height = Math.max(180, Number(source.height) || 1080);
  const x = Number(source.x) || 0;
  const y = Number(source.y) || 0;

  overlayRecordingWindow = new BrowserWindow({
    x,
    y,
    width,
    height,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  overlayRecordingWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayRecordingWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayRecordingWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayRecordingWindow.setContentBounds({ x, y, width, height });

  try {
    await overlayRecordingWindow.loadURL(overlayUrl);
    overlayRecordingWindow.showInactive();
    return { ok: true };
  } catch (err) {
    destroyOverlayRecordingWindow();
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
    width: 1720,
    height: 900,
    minWidth: 1280,
    minHeight: 720,
    title: 'KeyCap',
    backgroundColor: '#0a000f',
    autoHideMenuBar: true,
    frame: false,
    thickFrame: true,
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

  const sendWindowState = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('keycap:window-state', {
      isMaximized: mainWindow.isMaximized(),
      isFullScreen: mainWindow.isFullScreen(),
      isFocused: mainWindow.isFocused(),
    });
  };
  mainWindow.on('maximize', sendWindowState);
  mainWindow.on('unmaximize', sendWindowState);
  mainWindow.on('enter-full-screen', sendWindowState);
  mainWindow.on('leave-full-screen', sendWindowState);
  mainWindow.on('focus', sendWindowState);
  mainWindow.on('blur', sendWindowState);

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
  if (verb === 'GET' && request === '/api/themes') {
    return runtime.listThemes();
  }
  if (verb === 'GET' && request === '/api/packs') {
    return runtime.listPacks();
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

  match = request.match(/^\/api\/themes\/(.+)$/);
  if (match) {
    const slug = decodeURIComponent(match[1]);
    if (verb === 'GET') return runtime.readTheme(slug);
    if (verb === 'PUT') return runtime.saveTheme(slug, body || {});
    if (verb === 'DELETE') return runtime.deleteTheme(slug);
  }

  match = request.match(/^\/api\/packs\/(.+)$/);
  if (match) {
    const slug = decodeURIComponent(match[1]);
    if (verb === 'GET') return runtime.readPack(slug);
    if (verb === 'PUT') return runtime.savePack(slug, body || {});
    if (verb === 'DELETE') return runtime.deletePack(slug);
  }

  throw new Error(`Unknown API route: ${verb} ${request}`);
}

function registerIpc() {
  ipcMain.handle('keycap:window-minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
  });
  ipcMain.handle('keycap:window-toggle-maximize', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });
  ipcMain.handle('keycap:window-close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  });
  ipcMain.handle('keycap:window-get-state', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return { isMaximized: false, isFullScreen: false, isFocused: false };
    return {
      isMaximized: mainWindow.isMaximized(),
      isFullScreen: mainWindow.isFullScreen(),
      isFocused: mainWindow.isFocused(),
    };
  });
  ipcMain.handle('keycap:api', (_event, request) => handleApiRequest(request || {}));
  ipcMain.handle('keycap:get-shell-state', () => getShellState());
  ipcMain.handle('keycap:get-streaming-status', () => getStreamingStatus());
  ipcMain.handle('keycap:get-native-recorder-status', () => nativeRecorder.getStatus());
  ipcMain.handle('keycap:start-native-recording', (_event, payload) => startNativeRecording(payload || {}));
  ipcMain.handle('keycap:stop-native-recording', () => stopNativeRecording());
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
  ipcMain.handle('keycap:list-native-recorder-sources', () => listNativeRecorderSources());
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
  nativeRecorder.setEventSink(sendAppEvent);
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
  nativeRecorder.ensureStarted().catch((err) => {
    console.error('  [recorder]   failed to start native recorder scaffold:', err.message);
  });
  createWindow();
  createTray();

  updateCheckTimeout = setTimeout(checkForUpdates, 3000);
  updateCheckInterval = setInterval(checkForUpdates, 4 * 60 * 60 * 1000);
});

app.on('window-all-closed', () => {
  app.isQuitting = true;
  app.quit();
});

app.on('before-quit', (event) => {
  app.isQuitting = true;
  if (quitResumePending || shutdownStarted) {
    cleanupAppResources();
    return;
  }

  event.preventDefault();
  quitResumePending = true;
  shutdownApp()
    .catch((err) => {
      console.error('  [main]       graceful shutdown failed:', err);
    })
    .finally(() => {
      app.exit(0);
    });
});

app.on('will-quit', () => {
  setTimeout(() => {
    process.exit(0);
  }, 1500).unref();
});

app.on('activate', () => createWindow());
