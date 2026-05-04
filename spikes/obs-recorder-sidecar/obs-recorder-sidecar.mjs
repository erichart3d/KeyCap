#!/usr/bin/env node
'use strict';

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

const DEFAULT_OBS_ROOT = 'C:\\Program Files\\obs-studio';
const DEFAULT_TARGET_ROOT = path.join(repoRoot, 'native', 'recorder', 'target', 'obs-recorder-sidecar');
const DEFAULT_OVERLAY_URL = 'http://127.0.0.1:8765/';
const DEFAULT_OBS_PORT = 4460;
const PROFILE_NAME = 'KeyCapSidecar';
const SCENE_NAME = 'KeyCap Recorder';
const CURRENT_OBS_VERSION = 486604803;

function parseArgs(argv) {
  const out = {};
  for (const raw of argv) {
    if (!raw.startsWith('--')) continue;
    const eq = raw.indexOf('=');
    if (eq === -1) {
      out[raw.slice(2)] = true;
    } else {
      out[raw.slice(2, eq)] = raw.slice(eq + 1);
    }
  }
  return out;
}

function intArg(args, name, fallback) {
  const raw = args[name];
  if (raw === undefined || raw === true || raw === '') return fallback;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return parsed;
}

function boolArg(args, name, fallback = false) {
  const raw = args[name];
  if (raw === undefined) return fallback;
  if (raw === true) return true;
  const normalized = String(raw).toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function iniPath(value) {
  return path.resolve(value).replace(/\\/g, '\\\\');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function exists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch (_) {
    return false;
  }
}

async function ensureDir(target) {
  await fsp.mkdir(target, { recursive: true });
}

async function ensureJunction(source, target) {
  if (await exists(target)) return;
  await ensureDir(path.dirname(target));
  await fsp.symlink(source, target, 'junction');
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...options, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      resolve({ exitCode: -1, stdout, stderr: stderr + err.message });
    });
    child.on('close', (exitCode) => {
      resolve({ exitCode, stdout, stderr });
    });
  });
}

function waitForProcessExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
    const onClose = () => {
      cleanup();
      resolve(true);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off('close', onClose);
      child.off('exit', onClose);
    };
    child.once('close', onClose);
    child.once('exit', onClose);
  });
}

async function terminateProcess(child, timeoutMs = 8000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
  try {
    child.kill();
  } catch (_) {}
  return waitForProcessExit(child, timeoutMs);
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (_) {
      payload = { text };
    }
  }
  if (!res.ok) {
    throw new Error(`${options.method || 'GET'} ${url} failed: ${res.status} ${text}`);
  }
  return payload;
}

async function waitForHttpJson(url, timeoutMs) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      return await fetchJson(url);
    } catch (err) {
      lastError = err;
      await sleep(250);
    }
  }
  throw lastError || new Error(`timed out waiting for ${url}`);
}

async function listWindowsDisplays() {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Windows.Forms',
    '$index = 0',
    '$displays = @(',
    '[System.Windows.Forms.Screen]::AllScreens | ForEach-Object {',
    '  $index++',
    '  [PSCustomObject]@{',
    '    index = $index',
    '    monitorId = $_.DeviceName',
    "    label = ('Display ' + $index)",
    '    primary = [bool]$_.Primary',
    '    x = [int]$_.Bounds.X',
    '    y = [int]$_.Bounds.Y',
    '    width = [int]$_.Bounds.Width',
    '    height = [int]$_.Bounds.Height',
    '  }',
    '}',
    ')',
    '$displays | ConvertTo-Json -Compress',
  ].join('\n');
  const result = await runProcess(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (result.exitCode !== 0) {
    throw new Error(`display enumeration failed: ${result.stderr || result.stdout}`);
  }
  const text = String(result.stdout || '').trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function resolveDisplay({ displayIndex, monitorId }) {
  const displays = await listWindowsDisplays();
  if (!displays.length) throw new Error('no Windows displays were reported');

  if (monitorId) {
    const display = displays.find((candidate) => String(candidate.monitorId).toLowerCase() === String(monitorId).toLowerCase());
    return { display: display || null, monitorId: String(monitorId), displays };
  }

  if (displayIndex) {
    const display = displays.find((candidate) => Number(candidate.index) === Number(displayIndex));
    if (!display) throw new Error(`display index ${displayIndex} did not match any display`);
    return { display, monitorId: String(display.monitorId), displays };
  }

  const display = displays.find((candidate) => !!candidate.primary) || displays[0];
  return { display, monitorId: String(display.monitorId), displays };
}

function sourceBase(name, id, settings, extra = {}) {
  return {
    prev_ver: CURRENT_OBS_VERSION,
    name,
    uuid: extra.uuid || randomUUID(),
    id,
    versioned_id: id,
    settings,
    mixers: extra.mixers ?? 0,
    sync: 0,
    flags: 0,
    volume: 1,
    balance: 0.5,
    enabled: true,
    muted: false,
    'push-to-mute': false,
    'push-to-mute-delay': 0,
    'push-to-talk': false,
    'push-to-talk-delay': 0,
    hotkeys: extra.hotkeys || {},
    deinterlace_mode: 0,
    deinterlace_field_order: 0,
    monitoring_type: 0,
    private_settings: {},
  };
}

function sceneItem(name, sourceUuid, id, bounds) {
  const item = {
    name,
    source_uuid: sourceUuid,
    visible: true,
    locked: false,
    rot: 0,
    pos: { x: 0, y: 0 },
    scale: { x: 1, y: 1 },
    align: 5,
    bounds_type: 0,
    bounds_align: 0,
    bounds: { x: 0, y: 0 },
    crop_left: 0,
    crop_top: 0,
    crop_right: 0,
    crop_bottom: 0,
    id,
    group_item_backup: false,
    scale_filter: 'disable',
    blend_method: 'default',
    blend_type: 'normal',
    show_transition: { duration: 0 },
    hide_transition: { duration: 0 },
    private_settings: {},
  };
  if (bounds) {
    item.bounds_type = 2;
    item.bounds = bounds;
  }
  return item;
}

function makeSceneCollection({ width, height, fps, overlayUrl, monitorId, captureCursor, forceSdr, method }) {
  const sceneUuid = randomUUID();
  const captureUuid = randomUUID();
  const browserUuid = randomUUID();

  return {
    current_scene: SCENE_NAME,
    current_program_scene: SCENE_NAME,
    scene_order: [{ name: SCENE_NAME }],
    name: PROFILE_NAME,
    sources: [
      sourceBase(
        SCENE_NAME,
        'scene',
        {
          custom_size: false,
          id_counter: 2,
          items: [
            sceneItem('Display Capture', captureUuid, 1, { x: width, y: height }),
            sceneItem('KeyCap Overlay', browserUuid, 2),
          ],
        },
        {
          uuid: sceneUuid,
          hotkeys: {
            'OBSBasic.SelectScene': [],
            'libobs.show_scene_item.Display Capture': [],
            'libobs.hide_scene_item.Display Capture': [],
            'libobs.show_scene_item.KeyCap Overlay': [],
            'libobs.hide_scene_item.KeyCap Overlay': [],
          },
        },
      ),
      sourceBase(
        'Display Capture',
        'monitor_capture',
        {
          monitor_id: monitorId,
          method,
          capture_cursor: captureCursor,
          force_sdr: forceSdr,
        },
        { uuid: captureUuid },
      ),
      sourceBase(
        'KeyCap Overlay',
        'browser_source',
        {
          url: overlayUrl,
          width,
          height,
          fps,
          fps_custom: true,
          shutdown: false,
          restart_when_active: false,
          reroute_audio: false,
          webpage_control_level: 1,
          css: 'body { background-color: rgba(0, 0, 0, 0); margin: 0; overflow: hidden; }',
        },
        {
          uuid: browserUuid,
          mixers: 255,
          hotkeys: {
            'libobs.mute': [],
            'libobs.unmute': [],
            'libobs.push-to-mute': [],
            'libobs.push-to-talk': [],
            'ObsBrowser.Refresh': [],
          },
        },
      ),
    ],
    groups: [],
    quick_transitions: [
      { name: 'Cut', duration: 300, hotkeys: [], id: 1, fade_to_black: false },
      { name: 'Fade', duration: 300, hotkeys: [], id: 2, fade_to_black: false },
    ],
    transitions: [],
    saved_projectors: [],
    current_transition: 'Fade',
    transition_duration: 300,
    preview_locked: false,
    scaling_enabled: false,
    scaling_level: 0,
    scaling_off_x: 0,
    scaling_off_y: 0,
    'virtual-camera': { type: 0, internal: 0 },
    modules: {
      'scripts-tool': [],
      'output-timer': {
        streamTimerHours: 0,
        streamTimerMinutes: 0,
        streamTimerSeconds: 30,
        recordTimerHours: 0,
        recordTimerMinutes: 0,
        recordTimerSeconds: 30,
        autoStartStreamTimer: false,
        autoStartRecordTimer: false,
        pauseRecordTimer: true,
      },
    },
  };
}

async function writeObsConfig({
  sandboxRoot,
  outputDir,
  width,
  height,
  fps,
  overlayUrl,
  obsPort,
  monitorId,
  captureCursor,
  forceSdr,
  method,
  encoder,
  quality,
  format,
}) {
  const configRoot = path.join(sandboxRoot, 'config', 'obs-studio');
  const profileDir = path.join(configRoot, 'basic', 'profiles', PROFILE_NAME);
  const scenesDir = path.join(configRoot, 'basic', 'scenes');
  await ensureDir(profileDir);
  await ensureDir(scenesDir);
  await ensureDir(outputDir);

  const globalIni = `[General]
Pre19Defaults=false
Pre21Defaults=false
Pre23Defaults=false
Pre24.1Defaults=false
FirstRun=false
BrowserHWAccel=true
ProcessPriority=AboveNormal
EnableAutoUpdates=false
ConfirmOnExit=false

[Basic]
Profile=${PROFILE_NAME}
ProfileDir=${PROFILE_NAME}
SceneCollection=${PROFILE_NAME}
SceneCollectionFile=${PROFILE_NAME}
ConfigOnNewProfile=false

[OBSWebSocket]
FirstLoad=false
ServerEnabled=true
ServerPort=${obsPort}
AlertsEnabled=false
AuthRequired=false

[Video]
Renderer=Direct3D 11
`;

  const basicIni = `[General]
Name=${PROFILE_NAME}

[Video]
BaseCX=${width}
BaseCY=${height}
OutputCX=${width}
OutputCY=${height}
FPSType=0
FPSCommon=${fps}
ScaleType=bicubic
FPSInt=${fps}
FPSNum=${fps}
FPSDen=1
ColorFormat=NV12
ColorSpace=709
ColorRange=Partial
SdrWhiteLevel=300
HdrNominalPeakLevel=1000

[SimpleOutput]
StreamEncoder=${encoder}
RecEncoder=${encoder}
RecQuality=${quality}
RecFormat=${format}
RecFormat2=${format}
FilePath=${iniPath(outputDir)}
VBitrate=25000
ABitrate=160
UseAdvanced=false
Preset=veryfast
NVENCPreset2=p5
RecRB=false
StreamAudioEncoder=aac
RecAudioEncoder=aac
RecTracks=1

[Output]
Mode=Simple
FilenameFormatting=keycap-obs-sidecar-%CCYY-%MM-%DD-%hh-%mm-%ss
DelayEnable=false
Reconnect=true
RetryDelay=2
MaxRetries=25
BindIP=default
LowLatencyEnable=false

[Audio]
MonitoringDeviceId=default
MonitoringDeviceName=Default
SampleRate=48000
ChannelSetup=Stereo
MeterDecayRate=23.53
PeakMeterType=0
`;

  await fsp.writeFile(path.join(configRoot, 'global.ini'), globalIni, 'utf8');
  await fsp.writeFile(path.join(profileDir, 'basic.ini'), basicIni, 'utf8');
  await fsp.writeFile(path.join(profileDir, 'streamEncoder.json'), '{}\n', 'utf8');
  await fsp.writeFile(
    path.join(scenesDir, `${PROFILE_NAME}.json`),
    JSON.stringify(makeSceneCollection({ width, height, fps, overlayUrl, monitorId, captureCursor, forceSdr, method }), null, 2),
    'utf8',
  );
}

async function prepareObsSandbox({ obsRoot, runRoot }) {
  const obsExe = path.join(obsRoot, 'bin', '64bit', 'obs64.exe');
  if (!(await exists(obsExe))) throw new Error(`OBS executable not found at ${obsExe}`);

  const sandboxRoot = path.join(runRoot, 'obs-sandbox');
  await ensureDir(sandboxRoot);
  for (const name of ['bin', 'data', 'obs-plugins']) {
    const source = path.join(obsRoot, name);
    if (!(await exists(source))) throw new Error(`OBS ${name} directory not found at ${source}`);
    await ensureJunction(source, path.join(sandboxRoot, name));
  }
  return {
    sandboxRoot,
    obsExe: path.join(sandboxRoot, 'bin', '64bit', 'obs64.exe'),
    obsCwd: path.join(sandboxRoot, 'bin', '64bit'),
  };
}

async function ensureKeyCapServer({ overlayUrl, logDir }) {
  const statusUrl = new URL('/api/status', overlayUrl).toString();
  try {
    const status = await fetchJson(statusUrl);
    return { started: false, status, process: null };
  } catch (_) {
    // The proof sidecar can launch the dev overlay server for self-contained tests.
  }

  const log = fs.openSync(path.join(logDir, 'keycap-server.log'), 'a');
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: repoRoot,
    stdio: ['ignore', log, log],
    windowsHide: true,
  });

  const status = await waitForHttpJson(statusUrl, 15000);
  return { started: true, status, process: child };
}

class ObsWebSocketClient {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.events = [];

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.op === 5) {
        this.events.push(msg.d);
        return;
      }
      if (msg.op !== 7) return;
      const requestId = msg.d?.requestId;
      const pending = this.pending.get(requestId);
      if (!pending) return;
      this.pending.delete(requestId);
      clearTimeout(pending.timeout);
      const status = msg.d.requestStatus || {};
      if (!status.result) {
        pending.reject(new Error(`${msg.d.requestType} failed: ${status.code} ${status.comment || ''}`.trim()));
      } else {
        pending.resolve(msg.d.responseData || {});
      }
    });
  }

  request(requestType, requestData = {}, timeoutMs = 20000) {
    const requestId = `${Date.now()}-${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`${requestType} timed out`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timeout });
      this.ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
    });
  }

  close() {
    this.ws.close();
  }
}

async function connectObsWebSocket(port, timeoutMs) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      return await new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        const timer = setTimeout(() => {
          ws.terminate();
          reject(new Error('OBS websocket identify timed out'));
        }, 5000);
        ws.on('error', reject);
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.op === 0) {
            if (msg.d?.authentication) {
              clearTimeout(timer);
              ws.terminate();
              reject(new Error('OBS websocket requested authentication; sandbox config should disable it'));
              return;
            }
            ws.send(JSON.stringify({ op: 1, d: { rpcVersion: 1, eventSubscriptions: 0 } }));
          } else if (msg.op === 2) {
            clearTimeout(timer);
            resolve(new ObsWebSocketClient(ws));
          }
        });
      });
    } catch (err) {
      lastError = err;
      await sleep(500);
    }
  }
  throw lastError || new Error(`timed out connecting to OBS websocket on ${port}`);
}

async function waitForRecordState(obsClient, active, timeoutMs) {
  const started = Date.now();
  let lastStatus = null;
  while (Date.now() - started < timeoutMs) {
    lastStatus = await obsClient.request('GetRecordStatus');
    if (!!lastStatus.outputActive === active) return lastStatus;
    await sleep(250);
  }
  throw new Error(`recording did not become ${active ? 'active' : 'inactive'}; last status: ${JSON.stringify(lastStatus)}`);
}

async function newestRecordingFiles(outputDir, sinceMs) {
  const entries = await fsp.readdir(outputDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/\.(mkv|mp4|mov|flv)$/i.test(entry.name)) continue;
    const fullPath = path.join(outputDir, entry.name);
    const stat = await fsp.stat(fullPath);
    if (stat.mtimeMs + 1000 < sinceMs) continue;
    files.push({ path: fullPath, size: stat.size, mtime: stat.mtime.toISOString() });
  }
  files.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return files;
}

async function latestObsLog(sandboxRoot) {
  const logDir = path.join(sandboxRoot, 'config', 'obs-studio', 'logs');
  if (!(await exists(logDir))) return null;
  const entries = await fsp.readdir(logDir, { withFileTypes: true });
  const logs = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.txt')) continue;
    const fullPath = path.join(logDir, entry.name);
    const stat = await fsp.stat(fullPath);
    logs.push({ path: fullPath, mtimeMs: stat.mtimeMs });
  }
  logs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return logs[0]?.path || null;
}

async function summarizeObsLog(sandboxRoot) {
  const logPath = await latestObsLog(sandboxRoot);
  if (!logPath) return null;
  const text = await fsp.readFile(logPath, 'utf8');
  const lines = text.split(/\r?\n/);
  const summary = {
    path: logPath,
    recordingStarted: lines.some((line) => line.includes('==== Recording Start')),
    recordingStopped: lines.some((line) => line.includes('==== Recording Stop')),
    encoderLines: lines.filter((line) => /encoder:|jim-nvenc|x264 encoder/i.test(line)).slice(0, 12),
    outputLines: lines.filter((line) => /Total frames output|Total drawn frames|Number of lagged frames|Number of skipped frames/i.test(line)),
  };
  for (const line of summary.outputLines) {
    const outputMatch = line.match(/Total frames output:\s*(\d+)/i);
    const drawnMatch = line.match(/Total drawn frames:\s*(\d+)/i);
    if (outputMatch) summary.totalFramesOutput = Number.parseInt(outputMatch[1], 10);
    if (drawnMatch) summary.totalDrawnFrames = Number.parseInt(drawnMatch[1], 10);
  }
  return summary;
}

async function probeRecording(recording) {
  const ffmpegExe = path.join(repoRoot, 'native', 'recorder', 'bin', 'ffmpeg.exe');
  if (!(await exists(ffmpegExe))) return null;
  const result = await runProcess(ffmpegExe, ['-hide_banner', '-i', recording.path, '-map', '0:v:0', '-f', 'null', '-'], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const combined = `${result.stdout}\n${result.stderr}`;
  const lines = combined.split(/\r?\n/);
  const frameMatches = [...combined.matchAll(/frame=\s*(\d+)/g)];
  const lastFrame = frameMatches.length ? Number.parseInt(frameMatches[frameMatches.length - 1][1], 10) : null;
  return {
    exitCode: result.exitCode,
    durationLine: lines.find((line) => line.includes('Duration:'))?.trim() || null,
    videoLine: lines.find((line) => line.includes('Video:'))?.trim() || null,
    decodedFrames: lastFrame,
  };
}

async function injectKeys({ overlayUrl, durationMs, keyIntervalMs }) {
  const labels = ['A', 'S', 'D', 'F', 'Space', 'Shift', 'Ctrl', 'K'];
  const started = Date.now();
  let sent = 0;
  const errors = [];
  while (Date.now() - started < durationMs) {
    const label = labels[sent % labels.length];
    try {
      await fetchJson(new URL('/api/test-key', overlayUrl).toString(), {
        method: 'POST',
        body: JSON.stringify({ label }),
      });
      sent += 1;
    } catch (err) {
      errors.push(err.message);
    }
    await sleep(keyIntervalMs);
  }
  return { sent, errors };
}

class ObsRecorderSidecar {
  constructor(args = {}) {
    this.obsRoot = path.resolve(String(args['obs-root'] || process.env.OBS_STUDIO_ROOT || DEFAULT_OBS_ROOT));
    this.targetRoot = path.resolve(String(args.output || DEFAULT_TARGET_ROOT));
    this.obsPort = intArg(args, 'obs-port', DEFAULT_OBS_PORT);
    this.session = null;
  }

  async listDisplays() {
    return { displays: await listWindowsDisplays() };
  }

  async start(params = {}) {
    if (this.session) throw new Error('recording is already active');

    const width = Number(params.width) || 1920;
    const height = Number(params.height) || 1080;
    const fps = Number(params.fps) || 60;
    const overlayUrl = String(params.overlayUrl || DEFAULT_OVERLAY_URL);
    const encoder = String(params.encoder || 'nvenc');
    const quality = String(params.quality || 'Small');
    const format = String(params.format || 'mkv').toLowerCase();
    const captureCursor = params.captureCursor !== undefined ? !!params.captureCursor : true;
    const forceSdr = !!params.forceSdr;
    const method = Number(params.displayMethod) || 0;
    if (method < 0 || method > 2) throw new Error('displayMethod must be 0 (auto), 1 (DXGI), or 2 (WGC)');

    const displayResolution = await resolveDisplay({
      displayIndex: params.displayIndex ? Number(params.displayIndex) : 0,
      monitorId: params.monitorId || params.sourceId || '',
    });
    const runName = `${timestamp()}-${width}x${height}-${fps}fps`;
    const runRoot = path.join(this.targetRoot, runName);
    const outputDir = path.resolve(String(params.outputDir || path.join(runRoot, 'recordings')));
    const logDir = path.join(runRoot, 'logs');
    await ensureDir(logDir);

    const obs = await prepareObsSandbox({ obsRoot: this.obsRoot, runRoot });
    await writeObsConfig({
      sandboxRoot: obs.sandboxRoot,
      outputDir,
      width,
      height,
      fps,
      overlayUrl,
      obsPort: this.obsPort,
      monitorId: displayResolution.monitorId,
      captureCursor,
      forceSdr,
      method,
      encoder,
      quality,
      format,
    });

    const server = await ensureKeyCapServer({ overlayUrl, logDir });
    const obsLog = fs.openSync(path.join(logDir, 'obs-process.log'), 'a');
    const obsArgs = [
      '--portable',
      '--multi',
      '--only-bundled-plugins',
      '--disable-updater',
      '--disable-missing-files-check',
      '--minimize-to-tray',
      '--profile',
      PROFILE_NAME,
      '--collection',
      PROFILE_NAME,
      '--scene',
      SCENE_NAME,
      '--startrecording',
    ];
    const obsProcess = spawn(obs.obsExe, obsArgs, {
      cwd: obs.obsCwd,
      stdio: ['ignore', obsLog, obsLog],
      windowsHide: true,
    });
    const obsClient = await connectObsWebSocket(this.obsPort, 45000);
    const recordStartedAt = Date.now();
    const version = await obsClient.request('GetVersion');
    const inputs = await obsClient.request('GetInputList');
    const sceneList = await obsClient.request('GetSceneList');
    const recordStatusAfterStart = await waitForRecordState(obsClient, true, 10000);

    this.session = {
      startedAt: new Date().toISOString(),
      recordStartedAt,
      runRoot,
      outputDir,
      logDir,
      width,
      height,
      fps,
      overlayUrl,
      encoder,
      quality,
      format,
      display: displayResolution.display,
      displays: displayResolution.displays,
      monitorId: displayResolution.monitorId,
      obs,
      obsArgs,
      obsProcess,
      obsClient,
      server,
      version,
      inputs,
      sceneList,
      recordStatusAfterStart,
      lastRecordStatus: recordStatusAfterStart,
      recordings: [],
      errors: [],
    };

    return this.statusPayload();
  }

  async status() {
    if (!this.session) return this.statusPayload();
    try {
      this.session.lastRecordStatus = await this.session.obsClient.request('GetRecordStatus', {}, 5000);
    } catch (err) {
      this.session.errors.push(err.message);
    }
    return this.statusPayload();
  }

  statusPayload(extra = {}) {
    const session = this.session;
    return {
      backend: 'obs-sidecar-proof',
      transport: 'stdio',
      ready: true,
      recordingState: session ? 'recording' : 'idle',
      obsPort: this.obsPort,
      pid: process.pid,
      outputPath: session?.recordings?.[0]?.path || '',
      runRoot: session?.runRoot || '',
      source: session
        ? {
            kind: 'display',
            monitorId: session.monitorId,
            display: session.display,
          }
        : null,
      width: session?.width || 0,
      height: session?.height || 0,
      fps: session?.fps || 0,
      obs: session
        ? {
            pid: session.obsProcess.pid,
            outputActive: !!session.lastRecordStatus?.outputActive,
            outputTimecode: session.lastRecordStatus?.outputTimecode || '',
            outputDuration: session.lastRecordStatus?.outputDuration || 0,
            outputBytes: session.lastRecordStatus?.outputBytes || 0,
          }
        : null,
      errors: session?.errors || [],
      ...extra,
    };
  }

  async stop() {
    if (!this.session) return { ...this.statusPayload(), stopped: false };
    const session = this.session;
    const stoppedAt = Date.now();
    try {
      const beforeStop = await session.obsClient.request('GetRecordStatus');
      session.lastRecordStatus = beforeStop;
      if (beforeStop.outputActive) {
        session.stopRecord = await session.obsClient.request('StopRecord', {}, 30000);
        session.recordStatusAfterStop = await waitForRecordState(session.obsClient, false, 15000);
      }
      session.recordings = await newestRecordingFiles(session.outputDir, session.recordStartedAt);
      for (const recording of session.recordings) {
        recording.ffmpegProbe = await probeRecording(recording);
      }
    } catch (err) {
      session.errors.push(err.stack || err.message);
      throw err;
    } finally {
      try {
        session.obsLog = await summarizeObsLog(session.obs.sandboxRoot);
      } catch (_) {}
      try {
        session.obsClient.close();
      } catch (_) {}
      session.obsExited = await terminateProcess(session.obsProcess, 8000);
      if (session.server?.started) {
        try {
          await fetchJson(new URL('/api/shutdown', session.overlayUrl).toString(), { method: 'POST', body: '{}' });
        } catch (_) {}
        session.serverExited = await terminateProcess(session.server.process, 5000);
      }
      session.finishedAt = new Date().toISOString();
      session.stopElapsedMs = Date.now() - stoppedAt;
      const report = this.buildReport(session);
      await fsp.writeFile(path.join(session.runRoot, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
      this.session = null;
      return {
        ...this.statusPayload({
          stopped: true,
          reportPath: path.join(session.runRoot, 'report.json'),
          recordings: session.recordings,
          obsLog: session.obsLog,
          stopElapsedMs: session.stopElapsedMs,
          errors: session.errors,
        }),
      };
    }
  }

  buildReport(session) {
    return {
      startedAt: session.startedAt,
      finishedAt: session.finishedAt,
      stopElapsedMs: session.stopElapsedMs,
      repoRoot,
      obsRoot: this.obsRoot,
      runRoot: session.runRoot,
      outputDir: session.outputDir,
      width: session.width,
      height: session.height,
      fps: session.fps,
      overlayUrl: session.overlayUrl,
      encoder: session.encoder,
      quality: session.quality,
      format: session.format,
      monitorId: session.monitorId,
      display: session.display,
      displays: session.displays,
      obs: {
        args: session.obsArgs,
        version: session.version,
        inputs: session.inputs,
        sceneList: session.sceneList,
        startStatus: session.recordStatusAfterStart,
        stopRecord: session.stopRecord || null,
        statusAfterStop: session.recordStatusAfterStop || null,
      },
      keycapServer: {
        startedBySidecar: !!session.server?.started,
        status: session.server?.status || null,
      },
      recordings: session.recordings,
      obsLog: session.obsLog || null,
      processExit: {
        obsExited: !!session.obsExited,
        serverExited: session.server?.started ? !!session.serverExited : null,
      },
      errors: session.errors,
    };
  }

  async shutdown() {
    if (this.session) return this.stop();
    return this.statusPayload({ shutdown: true });
  }
}

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function runStdioSidecar(args) {
  const sidecar = new ObsRecorderSidecar(args);
  writeMessage({ type: 'event', event: 'ready', payload: await sidecar.status() });
  const rl = readline.createInterface({ input: process.stdin });
  let shutdownRequested = false;
  for await (const line of rl) {
    if (!line.trim()) continue;
    let request = null;
    try {
      request = JSON.parse(line);
      const method = String(request.method || request.type || '');
      const params = request.params || {};
      let result = null;
      if (method === 'listDisplays' || method === 'list-displays') {
        result = await sidecar.listDisplays();
      } else if (method === 'start') {
        result = await sidecar.start(params);
      } else if (method === 'status') {
        result = await sidecar.status();
      } else if (method === 'stop') {
        result = await sidecar.stop();
      } else if (method === 'shutdown') {
        result = await sidecar.shutdown();
        writeMessage({ id: request.id ?? null, result });
        shutdownRequested = true;
        rl.close();
        break;
      } else {
        throw new Error(`unknown method: ${method}`);
      }
      writeMessage({ id: request.id ?? null, result });
    } catch (err) {
      writeMessage({ id: request?.id ?? null, error: { message: err.message, stack: err.stack } });
    }
  }
  if (shutdownRequested) {
    process.stdin.pause();
  }
}

async function runSelfTest(args) {
  const sidecar = new ObsRecorderSidecar(args);
  const displays = await sidecar.listDisplays();
  const displayIndex = intArg(args, 'display-index', 0);
  const target = displayIndex
    ? displays.displays.find((display) => Number(display.index) === displayIndex)
    : displays.displays.find((display) => !!display.primary) || displays.displays[0];
  if (!target) throw new Error('no target display found for self-test');

  const width = intArg(args, 'width', Number(target.width) || 1920);
  const height = intArg(args, 'height', Number(target.height) || 1080);
  const fps = intArg(args, 'fps', 60);
  const durationSec = intArg(args, 'duration', 6);
  const keyIntervalMs = intArg(args, 'key-interval', 350);
  const overlayUrl = String(args['overlay-url'] || DEFAULT_OVERLAY_URL);
  const start = await sidecar.start({
    displayIndex: Number(target.index),
    width,
    height,
    fps,
    overlayUrl,
    encoder: String(args.encoder || 'nvenc'),
    quality: String(args.quality || 'Small'),
    format: String(args.format || 'mkv'),
  });
  await sleep(1500);
  const keys = await injectKeys({
    overlayUrl,
    durationMs: Math.max(1000, durationSec * 1000 - 2500),
    keyIntervalMs,
  });
  await sleep(1000);
  const stop = await sidecar.stop();
  const result = { started: start, keys, stopped: stop };
  console.log(JSON.stringify(result, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (boolArg(args, 'list-displays', false)) {
    console.log(JSON.stringify(await listWindowsDisplays(), null, 2));
    return;
  }
  if (boolArg(args, 'self-test', false)) {
    await runSelfTest(args);
    return;
  }
  await runStdioSidecar(args);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
