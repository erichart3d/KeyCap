'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const { fork, spawn } = require('child_process');
const readline = require('readline');

const OVERLAY_MAGIC = 0x594c564f; // 'OVLY' little-endian

const ROOT = path.resolve(__dirname, '..');
const MOCK_SIDECAR = path.join(ROOT, 'native', 'recorder', 'mock-sidecar.js');
const OBS_SIDECAR = path.join(ROOT, 'spikes', 'obs-recorder-sidecar', 'obs-recorder-sidecar.mjs');
const DEFAULT_OBS_ROOT = 'C:\\Program Files\\obs-studio';
const NATIVE_BINARY_CANDIDATES = [
  path.join(ROOT, 'native', 'recorder', 'bin', 'keycap-recorder.exe'),
  path.join(ROOT, 'native', 'recorder', 'target', 'release', 'keycap-recorder.exe'),
  path.join(process.resourcesPath || '', 'native', 'recorder', 'keycap-recorder.exe'),
];

function normalizeBackend(value) {
  const backend = String(value || '')
    .trim()
    .toLowerCase();
  if (backend === 'obs' || backend === 'obs-sidecar' || backend === 'obs-sidecar-proof') return 'obs';
  if (backend === 'native' || backend === 'rust' || backend === 'rust-sidecar') return 'native';
  if (backend === 'mock' || backend === 'mock-js') return 'mock';
  return 'auto';
}

function hasExplicitBackendPreference() {
  return !!(process.env.KEYCAP_RECORDER_BACKEND || process.env.KEYCAP_NATIVE_RECORDER);
}

function forceBundledObsBackend() {
  return obsRuntimeMode() === 'bundled' && !hasExplicitBackendPreference();
}

function normalizeRequestedBackend(value) {
  const backend = normalizeBackend(value);
  if (forceBundledObsBackend() && backend !== 'mock') {
    return 'obs';
  }
  return backend;
}

function envBackendPreference() {
  const explicit = process.env.KEYCAP_RECORDER_BACKEND || process.env.KEYCAP_NATIVE_RECORDER;
  if (explicit) return normalizeBackend(explicit);
  return obsRuntimeMode() === 'bundled' ? 'obs' : 'auto';
}

function shouldUseObsSidecar() {
  return state.backendPreference === 'obs';
}

function obsSidecarTargetRoot() {
  if (process.env.KEYCAP_OBS_SIDECAR_TARGET_ROOT) {
    return path.resolve(process.env.KEYCAP_OBS_SIDECAR_TARGET_ROOT);
  }
  if (process.env.KEYCAP_DATA_ROOT) {
    return path.join(process.env.KEYCAP_DATA_ROOT, 'obs-recorder-sidecar');
  }
  return path.join(ROOT, 'native', 'recorder', 'target', 'obs-recorder-sidecar');
}

function obsExecutableForRoot(root) {
  return root ? path.join(root, 'bin', '64bit', 'obs64.exe') : '';
}

function obsRuntimeMode() {
  const mode = String(process.env.KEYCAP_OBS_RUNTIME_MODE || 'auto').trim().toLowerCase();
  if (mode === 'bundled' || mode === 'packaged') return 'bundled';
  if (mode === 'system' || mode === 'installed') return 'system';
  return 'auto';
}

function uniquePaths(paths) {
  const seen = new Set();
  const out = [];
  paths.filter(Boolean).forEach((item) => {
    const resolved = path.resolve(String(item));
    const key = resolved.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(resolved);
    }
  });
  return out;
}

function obsRootCandidates() {
  const bundled = [
    process.resourcesPath ? path.join(process.resourcesPath, 'obs-studio') : '',
    path.join(ROOT, 'obs-studio'),
    path.join(ROOT, 'vendor', 'obs-studio'),
  ];
  const system = [
    process.env.OBS_STUDIO_ROOT,
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'obs-studio'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'obs-studio'),
    DEFAULT_OBS_ROOT,
  ];
  const mode = obsRuntimeMode();
  if (mode === 'bundled') return uniquePaths(bundled);
  if (mode === 'system') return uniquePaths(system);
  return uniquePaths([...bundled, ...system]);
}

function resolveObsInstall() {
  const searched = obsRootCandidates();
  for (const root of searched) {
    const exe = obsExecutableForRoot(root);
    if (fs.existsSync(exe)) {
      return { available: true, root, exe, searched };
    }
  }
  return { available: false, root: '', exe: '', searched };
}

function obsStatusFields() {
  const obs = resolveObsInstall();
  return {
    backendPreference: state.backendPreference,
    obsAvailable: obs.available,
    obsRuntimeMode: obsRuntimeMode(),
    obsRoot: obs.root,
    obsPath: obs.exe,
  };
}

const state = {
  backendPreference: envBackendPreference(),
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
  return { ...state.status, ...obsStatusFields() };
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
  if ((message.type === 'response' || 'result' in message || 'error' in message) && message.id) {
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

  if (message.type === 'event' && (message.event === 'status' || message.event === 'ready')) {
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

function request(method, params = {}, timeoutMs = 60000) {
  const id = state.nextId++;
  return new Promise((resolve, reject) => {
    const timer = timeoutMs > 0
      ? setTimeout(() => {
        state.pending.delete(id);
        reject(new Error(`native recorder request timed out: ${method}`));
      }, timeoutMs)
      : null;
    state.pending.set(id, {
      resolve: (value) => {
        if (timer) clearTimeout(timer);
        resolve(value);
      },
      reject: (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      },
    });
    send({ type: 'request', id, method, params }).catch((err) => {
      state.pending.delete(id);
      if (timer) clearTimeout(timer);
      reject(err);
    });
  });
}

function findAvailablePort(start = 4460, attempts = 50) {
  return new Promise((resolve, reject) => {
    let port = Number(start) || 4460;
    const tryNext = () => {
      if (port >= start + attempts) {
        reject(new Error('no available OBS websocket port found'));
        return;
      }
      const server = net.createServer();
      server.unref();
      server.once('error', () => {
        port += 1;
        tryNext();
      });
      server.listen(port, '127.0.0.1', () => {
        const selected = port;
        server.close(() => resolve(selected));
      });
    };
    tryNext();
  });
}

function attachCommonChildHandlers(child) {
  child.on('exit', (code, signal) => {
    if (state.child !== child) return;
    cleanupChild(`native recorder exited (${signal || code || 0})`, { silent: code === 0 || signal === 'SIGTERM' });
  });
  child.on('error', (err) => {
    if (state.child !== child) return;
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
  console.log(`  [recorder]   launching native sidecar path=${binaryPath}`);
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

async function launchObsSidecar() {
  if (!fs.existsSync(OBS_SIDECAR)) {
    throw new Error(`OBS recorder sidecar proof not found at ${OBS_SIDECAR}`);
  }
  const obs = resolveObsInstall();
  const obsPort = await findAvailablePort();
  const args = [
    OBS_SIDECAR,
    `--output=${obsSidecarTargetRoot()}`,
    `--obs-port=${obsPort}`,
  ];
  if (obs.available) {
    args.push(`--obs-root=${obs.root}`);
  }
  console.log(`  [recorder]   launching OBS sidecar obs_root=${obs.root || '(missing)'} runtime_mode=${obsRuntimeMode()} port=${obsPort}`);
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, KEYCAP_NATIVE_RECORDER: 'obs-sidecar-proof', ELECTRON_RUN_AS_NODE: '1' },
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
      console.error('  [recorder]   invalid OBS sidecar message:', err.message);
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
    backend: 'obs-sidecar-proof',
    transport: 'stdio',
    ready: false,
    version: '',
    pid: child.pid || null,
    obsPort,
    lastError: '',
  });
}

function resolveNativeBinaryPath() {
  return NATIVE_BINARY_CANDIDATES.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

async function setBackendPreference(backend) {
  const next = normalizeRequestedBackend(backend);
  if (next === state.backendPreference) {
    emitStatus({ lastError: '' });
    return getStatus();
  }
  if (state.status.recordingState === 'recording') {
    throw new Error('Stop the current recording before switching recorder engines');
  }
  if (state.child) {
    await shutdown();
  }
  state.backendPreference = next;
  emitStatus({
    backend: 'offline',
    transport: 'none',
    ready: false,
    version: '',
    pid: null,
    sourceCount: 0,
    recordingState: 'idle',
    outputPath: '',
    lastError: '',
  });
  return getStatus();
}

async function ensureStarted() {
  if (state.child) return getStatus();

  const nativeBinary = resolveNativeBinaryPath();
  if (shouldUseObsSidecar()) {
    await launchObsSidecar();
  } else if (state.backendPreference === 'mock') {
    launchMockSidecar();
  } else if (nativeBinary) {
    launchNativeBinary(nativeBinary);
  } else if (state.backendPreference === 'native') {
    const message = 'KeyCap native recorder is unavailable; the recorder sidecar binary was not found.';
    emitStatus({ lastError: message });
    throw new Error(message);
  } else {
    launchMockSidecar();
  }

  try {
    const result = await request('handshake', { protocolVersion: 1 }, 30000);
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
  const result = await request('list_sources', {}, 30000);
  const sources = Array.isArray(result?.sources) ? result.sources : [];
  emitStatus({ sourceCount: sources.length, lastError: '' });
  return sources;
}

async function startRecording(params = {}) {
  const requested = normalizeRequestedBackend(params.recorderBackend || params.backend || state.backendPreference);
  if (requested !== state.backendPreference) {
    await setBackendPreference(requested);
  }
  await ensureStarted();
  if (state.status.recordingState === 'recording') {
    throw new Error('Recording is already in progress');
  }
  if (state.status.backend === 'obs-sidecar-proof') {
    const obs = resolveObsInstall();
    if (!obs.available) {
      const message = obsRuntimeMode() === 'bundled'
        ? 'Bundled OBS runtime was not found. Run npm run obs:stage-runtime, rebuild, or choose Auto/Native recorder.'
        : 'OBS Studio was not found. Install OBS Studio, set OBS_STUDIO_ROOT, or choose Auto/Native recorder.';
      emitStatus({ lastError: message });
      throw new Error(message);
    }
  }
  const result = await request('start_recording', params, 120000);
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
  if (state.status.recordingState !== 'recording') {
    return getStatus();
  }
  const result = await request('stop_recording', {}, 45000);
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
  const result = await request('get_status', {}, 30000);
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
    await request('shutdown', {}, 8000);
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

function ownsOverlay() {
  return state.status.backend === 'obs-sidecar-proof';
}

module.exports = {
  setEventSink,
  getStatus,
  setBackendPreference,
  ensureStarted,
  listSources,
  startRecording,
  stopRecording,
  fetchRecorderStatus,
  pushOverlayFrame,
  hasOverlayPipe,
  ownsOverlay,
  shutdown,
};
