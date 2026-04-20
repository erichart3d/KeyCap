'use strict';

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const FFMPEG_PATH = path.join(__dirname, 'bin', 'ffmpeg.exe');

const state = {
  displays: [],
  recording: null,
};

function send(message) {
  if (typeof process.send === 'function') {
    process.send(message);
  }
}

function reply(id, result, error) {
  if (error) {
    send({ type: 'response', id, error: { message: error.message || String(error) } });
    return;
  }
  send({ type: 'response', id, result });
}

function emitStatus(extra = {}) {
  send({
    type: 'event',
    event: 'status',
    payload: {
      backend: 'mock-js',
      transport: 'ipc',
      ready: true,
      version: 'mock-0.1.0',
      pid: process.pid,
      sourceCount: state.displays.length,
      recordingState: state.recording ? 'recording' : 'idle',
      outputPath: state.recording?.outputPath || '',
      ...extra,
    },
  });
}

function listDisplays() {
  return new Promise((resolve, reject) => {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      'Add-Type -AssemblyName System.Windows.Forms',
      '$i = 0',
      '$screens = @(',
      '[System.Windows.Forms.Screen]::AllScreens | ForEach-Object {',
      '  $i++',
      '  [PSCustomObject]@{',
      '    id = $_.DeviceName',
      "    kind = 'display'",
      "    name = ('Display ' + $i)",
      '    displayIndex = $i',
      "    displayLabel = ('Display ' + $i)",
      '    isPrimaryDisplay = [bool]$_.Primary',
      '    x = [int]$_.Bounds.X',
      '    y = [int]$_.Bounds.Y',
      '    width = [int]$_.Bounds.Width',
      '    height = [int]$_.Bounds.Height',
      '  }',
      '}',
      ')',
      '$screens | ConvertTo-Json -Compress',
    ].join('\n');

    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || error.message || 'display enumeration failed'));
          return;
        }
        try {
          const text = String(stdout || '').trim();
          if (!text) {
            resolve([]);
            return;
          }
          const parsed = JSON.parse(text);
          const displays = Array.isArray(parsed) ? parsed : [parsed];
          resolve(assignDdagrabIndices(displays));
        } catch (err) {
          reject(err);
        }
      }
    );
  });
}

async function ensureDisplays(force = false) {
  if (!force && state.displays.length) return state.displays;
  state.displays = await listDisplays();
  return state.displays;
}

function buildTimestamp() {
  return new Date().toISOString().replace(/:/g, '-').replace('T', '_').slice(0, 19);
}

function buildOutputPath(outputDir, ext) {
  const baseDir = outputDir || path.join(process.env.USERPROFILE || process.cwd(), 'Videos');
  fs.mkdirSync(baseDir, { recursive: true });
  return path.join(baseDir, `KeyCap_${buildTimestamp()}.${ext}`);
}

function assignDdagrabIndices(displays) {
  const ordered = [...displays].sort((a, b) =>
    (Number(!!b.isPrimaryDisplay) - Number(!!a.isPrimaryDisplay)) ||
    ((Number(a.y) || 0) - (Number(b.y) || 0)) ||
    ((Number(a.x) || 0) - (Number(b.x) || 0)) ||
    String(a.id || '').localeCompare(String(b.id || ''))
  );
  const indexById = new Map(ordered.map((display, index) => [String(display.id || ''), index]));
  return displays.map((display) => ({
    ...display,
    ddagrabOutputIndex: indexById.get(String(display.id || '')) ?? null,
  }));
}

function buildFfmpegArgs(source, params, outputPath) {
  const fps = Math.max(1, Math.min(60, Number(params.fps) || 60));
  const captureX = Number.isFinite(Number(params.captureX)) ? Number(params.captureX) : (Number(source.x) || 0);
  const captureY = Number.isFinite(Number(params.captureY)) ? Number(params.captureY) : (Number(source.y) || 0);
  const sourceWidth = Number(params.captureWidth) || Number(source.width) || 1920;
  const sourceHeight = Number(params.captureHeight) || Number(source.height) || 1080;
  const targetWidth = Number(params.width) || sourceWidth;
  const targetHeight = Number(params.height) || sourceHeight;
  const format = String(params.format || 'mp4').toLowerCase();
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
  ];
  const outputIdx = Number.isFinite(Number(source.ddagrabOutputIndex))
    ? Number(source.ddagrabOutputIndex)
    : null;
  const videoFilters = [];

  if (outputIdx !== null) {
    args.push(
      '-f', 'lavfi',
      '-i', `ddagrab=output_idx=${outputIdx}:framerate=${fps}:draw_mouse=1`
    );
    videoFilters.push('hwdownload', 'format=bgra');
  } else {
    args.push(
      '-f', 'gdigrab',
      '-draw_mouse', '1',
      '-framerate', String(fps),
      '-offset_x', String(captureX),
      '-offset_y', String(captureY),
      '-video_size', `${sourceWidth}x${sourceHeight}`,
      '-i', 'desktop'
    );
  }

  if (targetWidth !== sourceWidth || targetHeight !== sourceHeight) {
    videoFilters.push(`scale=${targetWidth}:${targetHeight}:flags=lanczos`);
  }
  if (videoFilters.length) {
    args.push('-vf', videoFilters.join(','));
  }

  if (format === 'webm') {
    args.push(
      '-an',
      '-c:v', 'libvpx-vp9',
      '-deadline', 'realtime',
      '-cpu-used', '6',
      '-row-mt', '1',
      '-pix_fmt', 'yuv420p',
      outputPath
    );
  } else {
    args.push(
      '-an',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      outputPath
    );
  }

  return args;
}

async function startRecording(params = {}) {
  if (state.recording) {
    throw new Error('recording already in progress');
  }
  if (!fs.existsSync(FFMPEG_PATH)) {
    throw new Error('ffmpeg binary is missing');
  }
  if ((params.sourceKind || 'display') !== 'display') {
    throw new Error('native recorder currently supports display capture only');
  }

  const displays = await ensureDisplays(true);
  const requestedId = String(params.sourceId || params.nativeSourceId || '');
  const source = displays.find((display) => String(display.id) === requestedId);
  if (!source) {
    throw new Error('selected display is no longer available');
  }

  const format = String(params.format || 'mp4').toLowerCase() === 'webm' ? 'webm' : 'mp4';
  const outputPath = buildOutputPath(String(params.outputDir || ''), format);
  const args = buildFfmpegArgs(source, params, outputPath);
  const ffmpeg = spawn(FFMPEG_PATH, args, {
    cwd: path.dirname(FFMPEG_PATH),
    windowsHide: true,
    stdio: ['pipe', 'ignore', 'pipe'],
  });

  const session = {
    ffmpeg,
    outputPath,
    sourceId: source.id,
    stopping: false,
    stderrTail: '',
    stopPromise: null,
    done: null,
    resolveDone: null,
    rejectDone: null,
  };
  session.done = new Promise((resolve, reject) => {
    session.resolveDone = resolve;
    session.rejectDone = reject;
  });

  ffmpeg.stderr.on('data', (chunk) => {
    const text = String(chunk || '');
    if (!text) return;
    session.stderrTail = `${session.stderrTail}${text}`.slice(-4000);
  });

  ffmpeg.on('error', (error) => {
    if (state.recording !== session) return;
    state.recording = null;
    emitStatus({ lastError: error.message || String(error), outputPath: outputPath, recordingState: 'idle' });
    session.rejectDone(error);
  });

  ffmpeg.on('exit', (code, signal) => {
    if (state.recording === session) {
      state.recording = null;
    }

    const ok = code === 0;
    const reason = ok
      ? ''
      : `ffmpeg exited (${signal || code || 0})${session.stderrTail ? `: ${session.stderrTail.trim()}` : ''}`;
    emitStatus({
      outputPath,
      recordingState: 'idle',
      lastError: reason,
    });

    if (ok) {
      session.resolveDone({ ok: true, outputPath });
    } else {
      session.rejectDone(new Error(reason));
    }
  });

  state.recording = session;
  emitStatus({
    outputPath,
    recordingState: 'recording',
    lastError: '',
  });

  return { ok: true, outputPath };
}

async function stopRecording() {
  if (!state.recording) {
    return { ok: true, outputPath: '' };
  }

  const session = state.recording;
  if (!session.stopPromise) {
    session.stopping = true;
    session.stopPromise = new Promise((resolve, reject) => {
      const killTimer = setTimeout(() => {
        try { session.ffmpeg.kill(); } catch (_) {}
      }, 7000);

      session.done
        .then((result) => {
          clearTimeout(killTimer);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(killTimer);
          reject(error);
        });

      try {
        session.ffmpeg.stdin.write('q\n');
        session.ffmpeg.stdin.end();
      } catch (_) {
        try { session.ffmpeg.kill(); } catch (_) {}
      }
    });
  }

  return session.stopPromise;
}

function getStatusPayload() {
  return {
    backend: 'mock-js',
    transport: 'ipc',
    ready: true,
    version: 'mock-0.1.0',
    pid: process.pid,
    sourceCount: state.displays.length,
    recordingState: state.recording ? 'recording' : 'idle',
    outputPath: state.recording?.outputPath || '',
    lastError: '',
  };
}

process.on('message', async (message) => {
  if (!message) return;
  if (message.type !== 'request') return;
  const { id, method } = message;
  try {
    switch (method) {
      case 'handshake':
        await ensureDisplays(true);
        emitStatus({ lastError: '' });
        reply(id, {
          ok: true,
          backend: 'mock-js',
          transport: 'ipc',
          version: 'mock-0.1.0',
        });
        return;

      case 'list_sources': {
        const sources = await ensureDisplays(true);
        emitStatus({ lastError: '' });
        reply(id, { sources });
        return;
      }

      case 'start_recording': {
        const result = await startRecording(message.params || {});
        reply(id, result);
        return;
      }

      case 'stop_recording': {
        const result = await stopRecording();
        reply(id, result);
        return;
      }

      case 'get_status': {
        await ensureDisplays();
        reply(id, getStatusPayload());
        return;
      }

      case 'shutdown':
        try {
          await stopRecording();
        } catch (_) {}
        reply(id, { ok: true });
        setTimeout(() => process.exit(0), 25).unref();
        return;

      default:
        reply(id, null, new Error(`unknown method: ${method}`));
        return;
    }
  } catch (error) {
    emitStatus({ lastError: error.message || String(error) });
    reply(id, null, error);
  }
});

emitStatus({ lastError: '' });
