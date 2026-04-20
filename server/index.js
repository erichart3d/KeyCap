'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const WebSocket = require('ws');

const runtime = require('./runtime');
const {
  EDITOR_DIR,
  OVERLAY_HTML,
  BACKGROUNDS_DIR,
} = require('./config');

const HOST = '127.0.0.1';
const PORT = 8765;
const WS_HEARTBEAT_MS = 20_000;

let app = null;
let server = null;
let wss = null;
let heartbeat = null;
let startPromise = null;
let stopPromise = null;
let bindError = null;
let runtimeListeners = null;
const clients = new Set();
const openSockets = new Set();

function getOverlayUrl() {
  return `http://${HOST}:${PORT}/`;
}

function getEditorUrl() {
  return `${getOverlayUrl()}editor`;
}

function isRunning() {
  return !!(server && server.listening);
}

function createStatusPayload() {
  return {
    ...runtime.getStatus(isRunning()),
    clients: clients.size,
    overlayUrl: getOverlayUrl(),
  };
}

function broadcast(payload) {
  if (!wss) return;
  const msg = JSON.stringify(payload);
  const stale = [];
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(msg);
      } catch (_) {
        stale.push(ws);
      }
    } else {
      stale.push(ws);
    }
  }
  for (const ws of stale) clients.delete(ws);
}

function attachRuntimeListeners() {
  if (runtimeListeners) return;
  runtimeListeners = {
    key: ({ label, description }) => {
      const payload = { type: 'key', label };
      if (description) payload.description = description;
      broadcast(payload);
    },
    config: (config) => {
      broadcast({ type: 'config', ...config });
    },
    updater: (payload) => {
      broadcast(payload);
    },
  };
  runtime.on('key', runtimeListeners.key);
  runtime.on('config', runtimeListeners.config);
  runtime.on('updater', runtimeListeners.updater);
}

function detachRuntimeListeners() {
  if (!runtimeListeners) return;
  runtime.off('key', runtimeListeners.key);
  runtime.off('config', runtimeListeners.config);
  runtime.off('updater', runtimeListeners.updater);
  runtimeListeners = null;
}

function mapBackgroundsForHttp() {
  const data = runtime.listBackgrounds();
  return {
    backgrounds: data.backgrounds.map((bg) => ({
      name: bg.name,
      file: bg.file,
      url: `/backgrounds/${bg.file}`,
    })),
  };
}

function sendEditorHtml(res) {
  const idx = path.join(EDITOR_DIR, 'index.html');
  if (!fs.existsSync(idx)) {
    return res.status(404).send('Editor not installed - missing editor/index.html');
  }
  res.set('Cache-Control', 'no-store');
  res.sendFile(idx);
}

function createExpressApp() {
  const instance = express();
  instance.use(express.json());

  instance.get('/editor', (_req, res) => sendEditorHtml(res));
  instance.get('/editor/', (_req, res) => sendEditorHtml(res));
  if (fs.existsSync(EDITOR_DIR)) {
    instance.use('/editor', express.static(EDITOR_DIR));
  }

  if (fs.existsSync(BACKGROUNDS_DIR)) {
    instance.use('/backgrounds', express.static(BACKGROUNDS_DIR));
  }

  instance.get('/', (_req, res) => res.sendFile(OVERLAY_HTML));

  instance.post('/api/shutdown', (_req, res) => {
    res.json({ ok: true });
    setTimeout(() => {
      stop({ stopRuntime: require.main === module }).then(() => {
        if (require.main === module) process.exit(0);
      }).catch(() => {});
    }, 150);
  });

  instance.get('/api/status', (_req, res) => {
    res.json(createStatusPayload());
  });

  instance.get('/api/config', (_req, res) => res.json(runtime.getConfig()));

  instance.put('/api/config', (req, res) => {
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({ error: 'object expected' });
    }
    res.json(runtime.updateConfig(req.body));
  });

  instance.get('/api/keymaps', (_req, res) => {
    res.json(runtime.listKeymaps());
  });

  instance.put('/api/keymaps/:slug', (req, res) => {
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({ error: 'object expected' });
    }
    try {
      res.json(runtime.saveKeymap(req.params.slug, req.body));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  instance.delete('/api/keymaps/:slug', (req, res) => {
    try {
      res.json(runtime.deleteKeymap(req.params.slug));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  instance.get('/api/presets', (_req, res) => {
    res.json(runtime.listPresets());
  });

  instance.get('/api/presets/:slug', (req, res) => {
    try {
      const data = runtime.readPreset(req.params.slug);
      if (!data) return res.status(404).json({ error: 'not found' });
      res.json(data);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  instance.put('/api/presets/:slug', (req, res) => {
    try {
      res.json(runtime.savePreset(req.params.slug, req.body || {}));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  instance.delete('/api/presets/:slug', (req, res) => {
    try {
      res.json(runtime.deletePreset(req.params.slug));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  instance.post('/api/test-key', (req, res) => {
    const label = ((req.body || {}).label || '').trim();
    if (!label) return res.status(400).json({ error: 'label required' });
    res.json(runtime.emitTestKey(label, req.body?.description || null));
  });

  instance.get('/api/backgrounds', (_req, res) => {
    res.json(mapBackgroundsForHttp());
  });

  instance.get('/api/update-status', (_req, res) => {
    res.json(runtime.getUpdateStatus());
  });

  instance.post('/api/update-install', (_req, res) => {
    try {
      res.json(runtime.runUpdateInstaller());
    } catch (err) {
      res.status(503).json({ error: err.message });
    }
  });

  instance.post('/api/_debug-update', (_req, res) => {
    try {
      res.json(runtime.runDebugUpdateSequence());
    } catch (err) {
      const code = err.message === 'not found' ? 404 : 400;
      res.status(code).json({ error: err.message });
    }
  });

  return instance;
}

function createRealtimeServer() {
  app = createExpressApp();
  server = http.createServer(app);
  wss = new WebSocket.Server({ server, path: '/ws' });

  server.on('connection', (socket) => {
    openSockets.add(socket);
    socket.once('close', () => openSockets.delete(socket));
  });

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.isAlive = true;

    const updaterState = runtime.getUpdateStatus();
    if (updaterState.phase && updaterState.phase !== 'idle') {
      try {
        ws.send(JSON.stringify(updaterState));
      } catch (_) {}
    }

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('close', () => {
      clients.delete(ws);
    });

    ws.on('error', () => {
      clients.delete(ws);
    });
  });

  heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, WS_HEARTBEAT_MS);

  wss.on('close', () => {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  });
}

function cleanupFailedStart() {
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
  for (const ws of clients) {
    try {
      ws.terminate();
    } catch (_) {}
  }
  clients.clear();
  try {
    wss?.close();
  } catch (_) {}
  try {
    server?.close();
  } catch (_) {}
  openSockets.clear();
  app = null;
  server = null;
  wss = null;
  detachRuntimeListeners();
}

async function start() {
  if (isRunning()) {
    return createStatusPayload();
  }
  if (startPromise) return startPromise;

  bindError = null;
  runtime.start();
  attachRuntimeListeners();
  createRealtimeServer();

  startPromise = new Promise((resolve, reject) => {
    const onError = (err) => {
      bindError = err;
      server?.off('listening', onListening);
      cleanupFailedStart();
      startPromise = null;
      reject(err);
    };
    const onListening = () => {
      server?.off('error', onError);
      startPromise = null;
      resolve(createStatusPayload());
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(PORT, HOST);
  });

  return startPromise;
}

async function stop({ stopRuntime = false } = {}) {
  if (stopPromise) return stopPromise;

  const activeServer = server;
  const activeWss = wss;

  if (!activeServer) {
    if (stopRuntime) runtime.stop();
    return createStatusPayload();
  }

  stopPromise = new Promise((resolve) => {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }

    for (const ws of clients) {
      try {
        ws.terminate();
      } catch (_) {}
    }
    clients.clear();

    if (activeWss) {
      try {
        activeWss.close();
      } catch (_) {}
    }

    for (const socket of openSockets) {
      socket.destroy();
    }
    openSockets.clear();

    detachRuntimeListeners();

    activeServer.close(() => {
      app = null;
      server = null;
      wss = null;
      stopPromise = null;
      if (stopRuntime) runtime.stop();
      resolve(createStatusPayload());
    });
  });

  return stopPromise;
}

function shutdown(options) {
  return stop(options);
}

function broadcastUpdate(payload) {
  return runtime.setUpdateStatus(payload);
}

function setUpdateInstaller(fn) {
  runtime.setUpdateInstaller(fn);
}

module.exports = {
  HOST,
  PORT,
  start,
  stop,
  shutdown,
  isRunning,
  getOverlayUrl,
  getEditorUrl,
  broadcastUpdate,
  setUpdateInstaller,
  get bindError() {
    return bindError;
  },
};

if (require.main === module) {
  start().then(() => {
    const line = '='.repeat(60);
    console.log(line);
    console.log('  KeyCap - running');
    console.log(line);
    console.log(`  Overlay URL:  ${getOverlayUrl()}`);
    console.log(`  Editor URL:   ${getEditorUrl()}`);
    console.log('  Ctrl+C to stop.');
    console.log(line);
  }).catch((err) => {
    if (err?.code === 'EADDRINUSE') {
      console.error(`\n  [server]     Port ${PORT} is already in use.`);
    } else {
      console.error('\n  [server]     failed to start:', err);
    }
    process.exit(1);
  });

  process.on('SIGINT', () => {
    console.log('\nStopped.');
    stop({ stopRuntime: true }).finally(() => process.exit(0));
  });
}
