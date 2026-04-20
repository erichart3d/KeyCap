'use strict';

const fs = require('fs');
const path = require('path');
const { fork, spawn } = require('child_process');
const readline = require('readline');

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
  return result;
}

async function stopRecording() {
  await ensureStarted();
  const result = await request('stop_recording', {});
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
  return sendBestEffort({
    type: 'event',
    event: 'overlay_frame',
    payload: {
      width: Number(frame.width) || 0,
      height: Number(frame.height) || 0,
      buffer: Buffer.from(frame.buffer),
    },
  });
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

module.exports = {
  setEventSink,
  getStatus,
  ensureStarted,
  listSources,
  startRecording,
  stopRecording,
  fetchRecorderStatus,
  pushOverlayFrame,
  shutdown,
};
