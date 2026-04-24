'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const { fork, spawn } = require('child_process');
const readline = require('readline');

const OVERLAY_MAGIC = 0x594c564f; // 'OVLY' little-endian

const ROOT = path.resolve(__dirname, '..');
const MOCK_SIDECAR = path.join(ROOT, 'native', 'recorder', 'mock-sidecar.js');
const NATIVE_BINARY_CANDIDATES = [
  path.join(ROOT, 'native', 'recorder', 'bin', 'keycap-recorder.exe'),
  path.join(ROOT, 'native', 'recorder', 'target', 'release', 'keycap-recorder.exe'),
  path.join(process.resourcesPath || '', 'native', 'recorder', 'keycap-recorder.exe'),
];

const state = {
  child: null,
  transport: null,
  pending: new Map(),
  nextId: 1,
  eventSink: null,
  overlayPipeName: null,
  overlaySocket: null,
  overlayConnecting: null,
  status: {
    backend: 'offline',
    transport: 'none',
    ready: false,
    version: '',
    pid: null,
    sourceCount: 0,
    recordingState: 'idle',
    outputPath: '',
    lastError: '',
  },
};

function getStatus() {
  return { ...state.status };
}

function emitStatus(extra = {}) {
  state.status = { ...state.status, ...extra };
  if (typeof state.eventSink === 'function') {
    state.eventSink({ type: 'native-recorder-status', ...getStatus() });
  }
  return getStatus();
}

function setEventSink(fn) {
  state.eventSink = typeof fn === 'function' ? fn : null;
}

function cleanupPending(errorMessage) {
  const err = new Error(errorMessage || 'native recorder unavailable');
  for (const [, pending] of state.pending) {
    pending.reject(err);
  }
  state.pending.clear();
}

function cleanupChild(reason = 'native recorder stopped', options = {}) {
  const silent = !!options.silent;
  if (state.transport?.rl) {
    try { state.transport.rl.close(); } catch (_) {}
  }
  state.transport = null;
  state.child = null;
  state.overlayPipeName = null;
  closeOverlaySocket();
  cleanupPending(reason);
  emitStatus({
    ready: false,
    pid: null,
    sourceCount: 0,
    recordingState: 'idle',
    outputPath: '',
    lastError: silent ? '' : reason,
  });
}

function closeOverlaySocket() {
  if (state.overlaySocket) {
    try { state.overlaySocket.destroy(); } catch (_) {}
    state.overlaySocket = null;
  }
  state.overlayConnecting = null;
}

function connectOverlayPipe() {
  if (!state.overlayPipeName) return null;
  if (state.overlaySocket && !state.overlaySocket.destroyed) return state.overlaySocket;
  if (state.overlayConnecting) return state.overlayConnecting;

  state.overlayConnecting = new Promise((resolve) => {
    const socket = net.createConnection(state.overlayPipeName);
    socket.once('connect', () => {
      state.overlaySocket = socket;
      state.overlayConnecting = null;
      resolve(socket);
    });
    socket.once('error', (err) => {
      console.error('  [recorder]   overlay pipe connect failed:', err.message);
      state.overlayConnecting = null;
      try { socket.destroy(); } catch (_) {}
      resolve(null);
    });
    socket.on('close', () => {
      if (state.overlaySocket === socket) {
        state.overlaySocket = null;
      }
    });
  });
  return state.overlayConnecting;
}

function handleMessage(message) {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'response' && message.id) {
    const pending = state.pending.get(message.id);
    if (!pending) return;
    state.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message || String(message.error)));
    } else {
      pending.resolve(message.result);
    }
    return;
  }

  if (message.type === 'event' && message.event === 'status') {
    emitStatus(message.payload || {});
  }
}

function send(payload) {
  if (!state.child || !state.transport) {
    return Promise.reject(new Error('native recorder transport not started'));
  }
  if (state.transport.kind === 'ipc') {
    state.child.send(payload);
    return Promise.resolve();
  }
  if (state.transport.kind === 'stdio') {
    state.child.stdin.write(`${JSON.stringify(payload)}\n`);
    return Promise.resolve();
  }
  return Promise.reject(new Error('unknown native recorder transport'));
}

function sendBestEffort(payload) {
  if (!state.child || !state.transport) return false;
  try {
    if (state.transport.kind === 'ipc') {
      state.child.send(payload);
      return true;
    }
    if (state.transport.kind === 'stdio') {
      state.child.stdin.write(`${JSON.stringify(payload)}\n`);
      return true;
    }
  } catch (_) {}
  return false;
}

function request(method, params = {}) {
  const id = state.nextId++;
  return new Promise((resolve, reject) => {
    state.pending.set(id, { resolve, reject });
    send({ type: 'request', id, method, params }).catch((err) => {
      state.pending.delete(id);
      reject(err);
    });
  });
}

function attachCommonChildHandlers(child) {
  child.on('exit', (code, signal) => {
    cleanupChild(`native recorder exited (${signal || code || 0})`, { silent: code === 0 || signal === 'SIGTERM' });
  });
  child.on('error', (err) => {
    cleanupChild(err.message);
  });
}

function launchMockSidecar() {
  const child = fork(MOCK_SIDECAR, [], {
    cwd: ROOT,
    env: { ...process.env, KEYCAP_NATIVE_RECORDER: 'mock' },
    silent: true,
  });
  child.on('message', handleMessage);
  child.stdout?.on('data', (chunk) => {
    const text = String(chunk || '').trim();
    if (text) console.log(`  [recorder]   ${text}`);
  });
  child.stderr?.on('data', (chunk) => {
    const text = String(chunk || '').trim();
    if (text) console.error(`  [recorder]   ${text}`);
  });
  state.child = child;
  state.transport = { kind: 'ipc' };
  attachCommonChildHandlers(child);
  emitStatus({
    backend: 'mock-js',
    transport: 'ipc',
    ready: false,
    version: '',
    pid: child.pid || null,
    lastError: '',
  });
}

function launchNativeBinary(binaryPath) {
  const child = spawn(binaryPath, [], {
    cwd: path.dirname(binaryPath),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    const text = String(line || '').trim();
    if (!text) return;
    try {
      handleMessage(JSON.parse(text));
    } catch (err) {
      console.error('  [recorder]   invalid native recorder message:', err.message);
    }
  });
  child.stderr.on('data', (chunk) => {
    const text = String(chunk || '').trim();
    if (text) console.error(`  [recorder]   ${text}`);
  });
  state.child = child;
  state.transport = { kind: 'stdio', rl };
  attachCommonChildHandlers(child);
  emitStatus({
    backend: 'rust-sidecar',
    transport: 'stdio',
    ready: false,
    version: '',
    pid: child.pid || null,
    lastError: '',
  });
}

function resolveNativeBinaryPath() {
  return NATIVE_BINARY_CANDIDATES.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

async function ensureStarted() {
  if (state.child) return getStatus();

  const nativeBinary = resolveNativeBinaryPath();
  if (nativeBinary) {
    launchNativeBinary(nativeBinary);
  } else {
    launchMockSidecar();
  }

  try {
    const result = await request('handshake', { protocolVersion: 1 });
    state.overlayPipeName = (typeof result?.overlayPipe === 'string' && result.overlayPipe) || null;
    emitStatus({
      backend: result?.backend || state.status.backend,
      transport: result?.transport || state.status.transport,
      ready: true,
      version: result?.version || '',
      pid: state.child?.pid || null,
      lastError: '',
    });
    return getStatus();
  } catch (err) {
    cleanupChild(err.message);
    throw err;
  }
}

async function listSources() {
  await ensureStarted();
  const result = await request('list_sources', {});
  const sources = Array.isArray(result?.sources) ? result.sources : [];
  emitStatus({ sourceCount: sources.length, lastError: '' });
  return sources;
}

async function startRecording(params = {}) {
  await ensureStarted();
  const result = await request('start_recording', params);
  emitStatus({
    recordingState: 'recording',
    outputPath: result?.outputPath || '',
    lastError: '',
  });
  // Open the overlay pipe eagerly so the first pushOverlayFrame call
  // doesn't drop on a not-yet-connected socket.
  if (state.overlayPipeName) {
    connectOverlayPipe();
  }
  return result;
}

async function stopRecording() {
  await ensureStarted();
  const result = await request('stop_recording', {});
  closeOverlaySocket();
  emitStatus({
    recordingState: 'idle',
    outputPath: result?.outputPath || '',
    lastError: '',
  });
  return result;
}

async function fetchRecorderStatus() {
  await ensureStarted();
  const result = await request('get_status', {});
  if (result && typeof result === 'object') {
    emitStatus(result);
  }
  return getStatus();
}

function pushOverlayFrame(frame) {
  if (!state.child || state.status.recordingState !== 'recording') return false;
  if (!frame || !frame.buffer || !frame.width || !frame.height) return false;
  if (!state.overlayPipeName) return false;

  const width = Number(frame.width) | 0;
  const height = Number(frame.height) | 0;
  const payload = Buffer.isBuffer(frame.buffer) ? frame.buffer : Buffer.from(frame.buffer);
  const expected = width * height * 4;
  if (width <= 0 || height <= 0 || payload.length !== expected) return false;

  const socket = state.overlaySocket;
  if (!socket || socket.destroyed) {
    // Kick off (or continue) an async connect so later frames land.
    connectOverlayPipe();
    return false;
  }

  const header = Buffer.alloc(16);
  header.writeUInt32LE(OVERLAY_MAGIC, 0);
  header.writeUInt32LE(width, 4);
  header.writeUInt32LE(height, 8);
  header.writeUInt32LE(expected, 12);
  try {
    // Two separate writes are fine — the Rust side reads both with a
    // blocking read_exact. `write` returns false under backpressure, but
    // Node still queues the buffer; dropping frames on backpressure would
    // just starve the sidecar more, so let the OS pipe buffer handle it.
    socket.write(header);
    socket.write(payload);
    return true;
  } catch (_) {
    closeOverlaySocket();
    return false;
  }
}

async function shutdown() {
  if (!state.child) return { ok: true };
  try {
    await request('shutdown', {});
  } catch (_) {}
  if (state.child) {
    try { state.child.kill(); } catch (_) {}
  }
  cleanupChild('native recorder shutdown', { silent: true });
  return { ok: true };
}

function hasOverlayPipe() {
  return !!state.overlayPipeName;
}

module.exports = {
  setEventSink,
  getStatus,
  ensureStarted,
  listSources,
  startRecording,
  stopRecording,
  fetchRecorderStatus,
  pushOverlayFrame,
  hasOverlayPipe,
  shutdown,
};
