/**
 * KeyCap — Node.js server (replaces overlay_server.py)
 *
 * API surface is identical to the Python v6 server so the editor and
 * OBS overlay work without any changes.
 *
 * Routes:
 *   GET  /                   → overlay.html (OBS Browser Source)
 *   GET  /ws                 → WebSocket (key events + config pushes)
 *   GET  /editor             → editor UI
 *   GET  /editor/*           → editor static assets
 *   GET  /backgrounds/*      → background images
 *   POST /api/shutdown       → graceful stop
 *   GET  /api/status         → server + focused-app info
 *   GET  /api/config         → current overlay config
 *   PUT  /api/config         → save config + broadcast to overlay live
 *   GET  /api/keymaps        → list all profiles
 *   PUT  /api/keymaps/:slug  → create / update a profile
 *   DELETE /api/keymaps/:slug→ remove a profile
 *   POST /api/test-key       → push a synthetic keypress to the overlay
 *   GET  /api/backgrounds    → list background image files
 */

'use strict';

const http    = require('http');
const path    = require('path');
const fs      = require('fs');
const express = require('express');
const WebSocket = require('ws');

const {
  loadConfig, saveConfig, mergeKnown,
  KEYMAP_DIR, EDITOR_DIR, OVERLAY_HTML, BACKGROUNDS_DIR,
} = require('./config');
const { KeymapManager, sanitizeSlug } = require('./keymaps');
const { KeyboardHook } = require('./keyboard');

const HOST             = '127.0.0.1';
const PORT             = 8765;
const KEYMAP_POLL_MS   = 1000;
const WS_HEARTBEAT_MS  = 20_000;
const IMG_EXTS         = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

// ─── State ───────────────────────────────────────────────────────────────────

const config  = loadConfig();
const keymaps = new KeymapManager(KEYMAP_DIR);
const clients = new Set();   // active WebSocket connections

// ─── Broadcast helpers ────────────────────────────────────────────────────────

function broadcast(payload) {
  const msg   = JSON.stringify(payload);
  const stale = [];
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(msg); } catch (_) { stale.push(ws); }
    } else {
      stale.push(ws);
    }
  }
  for (const ws of stale) clients.delete(ws);
}

// ─── Keyboard hook ────────────────────────────────────────────────────────────

const hook = new KeyboardHook({ keymaps, onlyAnnotated: true });

hook.on('key', ({ label, description }) => {
  const payload = { type: 'key', label };
  if (description) payload.description = description;
  broadcast(payload);
});

// ─── Keymap watch loop ────────────────────────────────────────────────────────

function startKeymapWatcher() {
  keymaps.reloadIfChanged();
  keymaps.updateActive();
  setInterval(() => {
    keymaps.reloadIfChanged();
    keymaps.updateActive();
  }, KEYMAP_POLL_MS);
}

// ─── Express app ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// ── Static files ──────────────────────────────────────────────────────────────

// /editor  → explicit routes first so /editor hits index.html,
//            then static catches all sub-assets (/editor/style.css, etc.)
// no-store prevents Electron's Chromium from serving a stale cached copy
// after the source file changes between dev runs.
function sendEditorHtml(res) {
  const idx = path.join(EDITOR_DIR, 'index.html');
  if (!fs.existsSync(idx)) {
    return res.status(404).send('Editor not installed — missing editor/index.html');
  }
  res.set('Cache-Control', 'no-store');
  res.sendFile(idx);
}
app.get('/editor',  (_req, res) => sendEditorHtml(res));
app.get('/editor/', (_req, res) => sendEditorHtml(res));
if (fs.existsSync(EDITOR_DIR)) {
  app.use('/editor', express.static(EDITOR_DIR));
}

// /backgrounds → static image files
if (fs.existsSync(BACKGROUNDS_DIR)) {
  app.use('/backgrounds', express.static(BACKGROUNDS_DIR));
}

// / → OBS overlay
app.get('/', (_req, res) => res.sendFile(OVERLAY_HTML));

// ── JSON API ──────────────────────────────────────────────────────────────────

app.post('/api/shutdown', (_req, res) => {
  console.log('\n  [shutdown]   requested via editor — stopping.');
  res.json({ ok: true });
  setTimeout(() => {
    hook.stop();
    process.exit(0);
  }, 300);
});

app.get('/api/status', (_req, res) => {
  res.json({
    running:       true,
    mode:          'all',
    onlyAnnotated: true,
    focusedExe:    keymaps.activeExe,
    activeProfile: keymaps.activeProfile?.name ?? null,
    clients:       clients.size,
    overlayUrl:    `http://${HOST}:${PORT}/`,
  });
});

app.get('/api/config', (_req, res) => res.json(config));

app.put('/api/config', (req, res) => {
  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({ error: 'object expected' });
  }
  mergeKnown(config, req.body);
  saveConfig(config);
  broadcast({ type: 'config', ...config });
  console.log(`  [config]     saved → broadcast to ${clients.size} client(s)`);
  res.json(config);
});

app.get('/api/keymaps', (_req, res) => {
  keymaps.reloadIfChanged();
  res.json({ profiles: keymaps.asList() });
});

app.put('/api/keymaps/:slug', (req, res) => {
  const slug = sanitizeSlug(req.params.slug);
  if (!slug) return res.status(400).json({ error: 'bad slug' });
  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({ error: 'object expected' });
  }
  const file = keymaps.writeProfile(slug, req.body);
  keymaps.reloadIfChanged();
  const basename = path.basename(file);
  console.log(`  [keymaps]    wrote ${basename}`);
  res.json({ ok: true, file: basename });
});

app.delete('/api/keymaps/:slug', (req, res) => {
  const slug = sanitizeSlug(req.params.slug);
  if (!slug) return res.status(400).json({ error: 'bad slug' });
  const removed = keymaps.deleteProfile(slug);
  keymaps.reloadIfChanged();
  console.log(`  [keymaps]    ${removed ? 'removed' : 'missing'} ${slug}.json`);
  res.json({ ok: removed });
});

app.post('/api/test-key', (req, res) => {
  const label = ((req.body || {}).label || '').trim();
  if (!label) return res.status(400).json({ error: 'label required' });
  const description = (req.body.description || null) || null;
  const payload = { type: 'key', label };
  if (description) payload.description = description;
  broadcast(payload);
  console.log(`  [test]       ${label}${description ? `  (${description})` : ''}`);
  res.json({ ok: true });
});

app.get('/api/backgrounds', (_req, res) => {
  const files = [];
  if (fs.existsSync(BACKGROUNDS_DIR)) {
    for (const f of fs.readdirSync(BACKGROUNDS_DIR).sort()) {
      const ext = path.extname(f).toLowerCase();
      if (IMG_EXTS.has(ext)) {
        files.push({
          name: path.basename(f, ext),
          file: f,
          url:  `/backgrounds/${f}`,
        });
      }
    }
  }
  res.json({ backgrounds: files });
});

// ─── HTTP + WebSocket server ──────────────────────────────────────────────────

const server = http.createServer(app);
const wss    = new WebSocket.Server({ server, path: '/ws' });

// Track every open TCP socket so shutdown() can forcibly destroy them,
// releasing the port immediately even if keep-alive connections are open.
const openSockets = new Set();
server.on('connection', socket => {
  openSockets.add(socket);
  socket.once('close', () => openSockets.delete(socket));
});

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.isAlive = true;
  console.log(`  [connect]    client connected (${clients.size} total)`);

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`  [disconnect] client disconnected (${clients.size} total)`);
  });

  ws.on('error', () => clients.delete(ws));
});

// Ping/pong keepalive — keeps OBS Browser Source WS connections alive
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, WS_HEARTBEAT_MS);

wss.on('close', () => clearInterval(heartbeat));

// ─── Boot ─────────────────────────────────────────────────────────────────────

startKeymapWatcher();
hook.start();

server.listen(PORT, HOST, () => {
  const line = '='.repeat(60);
  console.log(line);
  console.log('  KeyCap — running');
  console.log(line);
  console.log(`  Overlay URL:  http://${HOST}:${PORT}/`);
  console.log(`  Editor URL:   http://${HOST}:${PORT}/editor`);
  console.log(`  Keymaps dir:  ${KEYMAP_DIR}`);
  console.log(`  Config file:  config.json`);
  console.log(`  Add the overlay URL as a Browser Source in OBS.`);
  console.log(`  Ctrl+C to stop.`);
  console.log(line);
});

// If the port is still held by a prior (likely zombied) instance, we used to
// crash with an unhandled EADDRINUSE and show a scary Node stack dialog.
// Now we emit a clean message, tear down our own stuff, and exit — so the
// user just sees nothing happen and can try again after Task-Manager cleanup.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  [server]     Port ${PORT} is already in use — likely another`);
    console.error(`               KeyCap instance is still running. Exiting.`);
    try { hook.stop(); } catch (_) {}
    // Surface the error through the exports so main.js can show a dialog.
    module.exports.bindError = err;
    process.exit(1);
  } else {
    console.error('  [server]     unexpected error:', err);
  }
});

// ─── Shutdown (called by Electron main.js or Ctrl+C) ─────────────────────────

function shutdown() {
  hook.stop();
  clearInterval(heartbeat);

  // Terminate all WebSocket clients immediately.
  for (const ws of wss.clients) {
    try { ws.terminate(); } catch (_) {}
  }

  // Destroy every open TCP socket so the port is freed right away.
  // Without this, keep-alive connections hold the port open and the
  // next launch gets EADDRINUSE.
  for (const socket of openSockets) {
    socket.destroy();
  }
  openSockets.clear();

  server.close();
}

module.exports = { shutdown };

// Only handle Ctrl+C when run directly with `node server/index.js`.
// In Electron mode, app lifecycle is managed by main.js.
if (require.main === module) {
  process.on('SIGINT', () => {
    console.log('\nStopped.');
    shutdown();
    process.exit(0);
  });
}
