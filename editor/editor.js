// KeyCap Editor — app controller (hi-fi)
// Plain JS; no frameworks. Talks to overlay_server.py /api/* endpoints.

const bridge = window.keycapApp || null;
const API_BASE = (location.origin && location.origin.startsWith('http'))
  ? location.origin : 'http://127.0.0.1:8765';

async function api(method, path, body) {
  try {
    if (bridge?.api) {
      return await bridge.api(method, path, body);
    }
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const r = await fetch(API_BASE + path, opts);
    if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
    const ct = r.headers.get('content-type') || '';
    return ct.includes('json') ? await r.json() : await r.text();
  } catch (err) {
    console.warn('api', method, path, err);
    return null;
  }
}
function profileSlug(p) { return (p.name || 'profile').toLowerCase().replace(/[^a-z0-9_-]+/g, '_'); }
async function pushProfile(key) {
  const p = state.profiles[key];
  if (!p) return;
  await api('PUT', '/api/keymaps/' + profileSlug({name:key}), {
    name: p.name, match: p.match, keys: p.keys,
  });
}
async function pushConfig() {
  await api('PUT', '/api/config', state.config);
}
async function refreshStatus() {
  const s = await api('GET', '/api/status');
  if (!s) { state.serverRunning = false; renderAll(); return; }
  state.serverRunning = !!s.running;
  state.appVersion = s.version || '--';
  state.detectedApp = s.focusedExe || null;
  state.overlayUrl = s.overlayUrl || state.overlayUrl;
  renderAll();
}
async function loadRemoteKeymaps() {
  const data = await api('GET', '/api/keymaps');
  if (!data || !Array.isArray(data.profiles) || !data.profiles.length) return;
  state.profiles = {};
  for (const p of data.profiles) {
    state.profiles[p.slug] = { name: p.name, match: p.match, keys: p.keys };
    if (p.active) state.activeProfile = p.slug;
  }
  if (!state.profiles[state.activeProfile]) {
    state.activeProfile = Object.keys(state.profiles)[0];
  }
}
async function loadRemoteConfig() {
  const c = await api('GET', '/api/config');
  if (c && typeof c === 'object') Object.assign(state.config, c);
}

async function loadBackgrounds() {
  const data = await api('GET', '/api/backgrounds');
  if (data && Array.isArray(data.backgrounds)) {
    state.backgrounds = data.backgrounds;
    renderBgToggle();
  }
}

// Try to auto-match a background to the active profile name
function autoMatchBackground() {
  if (!state.backgrounds.length) return;
  const profileName = (state.profiles[state.activeProfile]?.name || '').toLowerCase();
  const match = state.backgrounds.find(b => profileName.includes(b.name.toLowerCase()) || b.name.toLowerCase().includes(profileName));
  if (match) {
    state.previewBg = match.url;
    renderBgToggle();
    renderPreview();
  }
}

const THEMES = {
  // Keycap style — realistic mechanical keycap (concave, highlight, soft shadow)
  keycap:    { label: 'Keycap',    group: 'Keycap Style', buttonStyle: 'keycap', bg: '#e8e6df', border: '#c4c1b6', glow: '#7a766b', scanlines: false },
  // VHS style — chunky square keycaps, hard angled shadow
  vhs:       { label: 'VHS',       group: 'VHS Style',    buttonStyle: 'vhs',    bg: '#ff2e9a', border: '#00f0ff', glow: '#b967ff', scanlines: true  },
  terminal:  { label: 'Terminal',  group: 'VHS Style',    buttonStyle: 'vhs',    bg: '#001a00', border: '#39ff14', glow: '#39ff14', scanlines: true  },
  neon:      { label: 'Neon',      group: 'VHS Style',    buttonStyle: 'vhs',    bg: '#ff007a', border: '#c6ff00', glow: '#00e5ff', scanlines: false },
  chunky:    { label: 'Chunky',    group: 'VHS Style',    buttonStyle: 'vhs',    bg: '#000000', border: '#ffe066', glow: '#ff5a1f', scanlines: false },
  amber:     { label: 'Amber',     group: 'VHS Style',    buttonStyle: 'vhs',    bg: '#1a0d00', border: '#ffb300', glow: '#ff6d00', scanlines: true  },
  synthwave: { label: 'Synthwave', group: 'VHS Style',    buttonStyle: 'vhs',    bg: '#1a0030', border: '#ff2e9a', glow: '#9400ff', scanlines: true  },
  // Modern style — 6px rounded corners, soft drop shadow
  studio:    { label: 'Studio',    group: 'Modern Style', buttonStyle: 'modern', bg: '#1a1a2e', border: '#4facfe', glow: '#00f2fe', scanlines: false },
  carbon:    { label: 'Carbon',    group: 'Modern Style', buttonStyle: 'modern', bg: '#18181b', border: '#a1a1aa', glow: '#52525b', scanlines: false },
  coral:     { label: 'Coral',     group: 'Modern Style', buttonStyle: 'modern', bg: '#1a0a0a', border: '#ff6b6b', glow: '#ff8e53', scanlines: false },
  // Sleek style — pill shape, no shadow, subtle outline
  ghost:     { label: 'Ghost',     group: 'Sleek Style',  buttonStyle: 'sleek',  bg: '#f0f0f0', border: '#d0d0d0', glow: '#aaaaaa', scanlines: false },
  midnight:  { label: 'Midnight',  group: 'Sleek Style',  buttonStyle: 'sleek',  bg: '#0f172a', border: '#334155', glow: '#1e293b', scanlines: false },
  smoke:     { label: 'Smoke',     group: 'Sleek Style',  buttonStyle: 'sleek',  bg: '#2a2a2a', border: '#5a5a5a', glow: '#3a3a3a', scanlines: false },
};

const CHIP_STYLES = {
  vhs:    t => ({ radius: '0px',   shadow: `3px 3px 0 ${t.glow}` }),
  modern: t => ({ radius: '5px',   shadow: '0 3px 10px rgba(0,0,0,0.6)' }),
  sleek:  t => ({ radius: '999px', shadow: 'none' }),
  keycap: t => ({ radius: '6px',   shadow: 'inset 0 1px 0 rgba(255,255,255,0.85), inset 0 -2px 0 rgba(0,0,0,0.12), 0 3px 5px rgba(0,0,0,0.4)' }),
};

const DEFAULT_CONFIG = {
  theme: 'keycap',
  bg: '#e8e6df',
  border: '#c4c1b6',
  glow: '#7a766b',
  scanlines: false,
  fontFamily: "'Menlo', 'Consolas', monospace",
  fontWeight: 700,
  position: 'bottom-center',
  margin: 60,      // legacy fallback
  marginY: 60,
  marginX: 0,
  scale: 1.0,
  opacity: 1.0,
  keycapScale: 1.0,
  captionScale: 1.0,
  maxKeys: 4,
  lifetime: 2200,
  fade: 'glitch',
  buttonStyle: 'keycap',
  captionPosition: 'above',
  captionGap: 6,
  keycapShape: 'theme',
  captionShape: 'theme',
};

const DEFAULT_RECORDING = {
  sourceKind: 'display',
  sourceId: '',
  sourceName: '',
  resolution: 'source',
  fps: '60',
  format: 'mp4',
  outputDir: '',
};

const state = {
  config: { ...DEFAULT_CONFIG },
  previewBg: 'scene',           // 'scene' | 'checker' | '/backgrounds/Foo.png'
  serverRunning: true,
  desktopMode: !!bridge,
  nativeRecorderStatus: { backend: 'offline', ready: false, transport: 'none', sourceCount: 0, lastError: '' },
  mode: 'streaming',
  hasChosenMode: false,
  appVersion: '--',
  devMode: false,
  detectedApp: 'photoshop.exe',
  activeProfile: 'photoshop',
  capturing: false,
  overlayUrl: 'http://127.0.0.1:8765/',
  recording: { ...DEFAULT_RECORDING },
  captureSources: [],
  recordingPreviewStream: null,
  recordingSourceStream: null,
  recordingCompositeStream: null,
  recordingCompositeCanvas: null,
  recordingCompositeVideo: null,
  recordingCompositeRaf: 0,
  recordingCompositeRenderer: null,
  mediaRecorder: null,
  recordingChunks: [],
  isRecording: false,
  lastRecordingPath: '',
  overlayFramePending: null,
  overlayFrameUnsub: null,
  backgrounds: [],              // [{name, file, url}] loaded from server
  profiles: {
    photoshop: {
      name: 'Photoshop', match: ['photoshop.exe'],
      keys: {
        'b': 'Brush', 'e': 'Eraser', 'v': 'Move', 'm': 'Marquee', 'l': 'Lasso',
        'w': 'Quick select', 'c': 'Crop', 't': 'Type', 'p': 'Pen',
        'g': 'Gradient / Paint bucket', 's': 'Clone stamp', 'j': 'Spot healing',
        'i': 'Eyedropper', 'z': 'Zoom', 'h': 'Hand', 'x': 'Swap fg/bg',
        'd': 'Default colors', '[': 'Decrease brush size', ']': 'Increase brush size',
        'ctrl+z': 'Undo', 'ctrl+shift+z': 'Redo', 'ctrl+t': 'Free transform',
        'ctrl+j': 'Duplicate layer', 'ctrl+e': 'Merge down', 'ctrl+s': 'Save',
        'ctrl+shift+s': 'Save as', 'ctrl+n': 'New document', 'ctrl+d': 'Deselect',
      }
    },
    zbrush: {
      name: 'ZBrush', match: ['zbrush.exe', 'zbrushcore.exe'],
      keys: {
        'b': 'Brush palette', 's': 'Smooth', 'm': 'Move', 'e': 'Scale',
        'r': 'Rotate', 'q': 'Draw', 'x': 'Symmetry', 'f': 'Frame subtool',
        'space': 'Quick menu', 'ctrl+z': 'Undo', 'ctrl+shift+z': 'Redo',
        'ctrl+s': 'Save project', 'ctrl+d': 'Divide', 'shift+d': 'Lower subdiv',
        'd': 'Higher subdiv',
        '1': 'Clay', '2': 'Clay Buildup', '3': 'Standard', '4': 'DamStandard',
        '5': 'Move', '6': 'Trim Dynamic', '7': 'Inflate', '8': 'Zmodeler',
      }
    }
  }
};

// ---------- persistence ----------
// Config and keymaps are persisted server-side (config.json + keymaps/*.json).
// localStorage only remembers lightweight UI state so the editor reopens
// on the same tab/profile the user was last on.
const LS = 'keycap-editor-ui';
function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(LS) || 'null');
    if (s) {
      state.previewBg   = s.previewBg || 'scene';
      state.activeProfile = s.activeProfile || Object.keys(state.profiles)[0];
      state.mode = s.mode === 'recording' ? 'recording' : 'streaming';
      state.hasChosenMode = !!s.hasChosenMode;
      state.recording = { ...DEFAULT_RECORDING, ...(s.recording || {}) };
    }
  } catch(_) {}
}
function saveState() {
  try {
    localStorage.setItem(LS, JSON.stringify({
      previewBg:     state.previewBg,
      activeProfile: state.activeProfile,
      mode:          state.mode,
      hasChosenMode: state.hasChosenMode,
      recording:     state.recording,
    }));
  } catch(_) {}
}

// ---------- util ----------
const qs = (sel, root=document) => root.querySelector(sel);
const qsa = (sel, root=document) => Array.from(root.querySelectorAll(sel));
function toast(msg, kind='ok') {
  const t = qs('#toast');
  t.innerHTML = `<span class="ico">${kind === 'ok' ? '✓' : '⚠'}</span>${msg}`;
  t.classList.add('on');
  clearTimeout(t._tid);
  t._tid = setTimeout(() => t.classList.remove('on'), 1800);
}

function buildRecordingFilenamePreview() {
  return `KeyCap_YYYY-MM-DD_HH-mm-ss.${state.recording.format}`;
}

function getCaptureSourceLabel(source) {
  if (!source) return '';
  if (source.kind === 'display') {
    const pieces = [];
    const displayName = source.displayIndex ? `Display ${source.displayIndex}` : (source.displayLabel || 'Display');
    if (displayName) pieces.push(displayName);
    if (source.isPrimaryDisplay) pieces.push('primary');
    const width = Number(source.captureWidth) || Number(source.width) || 0;
    const height = Number(source.captureHeight) || Number(source.height) || 0;
    if (width && height) pieces.push(`${width}x${height}`);
    return pieces.join(' · ') || 'Display';
  }
  return source.name || 'Window';
}

// Resolve the configured resolution into actual pixel dimensions.
// Returns { width, height, label } or { width: null, height: null } if the
// capturer should be allowed to pick (the "source" option).
function resolveRecordingResolution() {
  const setting = state.recording.resolution || 'source';

  if (setting === 'source') {
    return { width: null, height: null, label: 'source resolution' };
  }

  if (setting === 'display') {
    // If the user selected a display source and main reported its pixel size,
    // that's the most accurate match. Otherwise fall back to the editor's
    // current display (window.screen × devicePixelRatio gives physical px).
    const source = state.captureSources?.find((s) => s.id === state.recording.sourceId);
    const captureWidth = Number(source?.captureWidth) || Number(source?.width) || 0;
    const captureHeight = Number(source?.captureHeight) || Number(source?.height) || 0;
    if (source && source.kind === 'display' && captureWidth && captureHeight) {
      return { width: captureWidth, height: captureHeight, label: `${captureWidth} x ${captureHeight}` };
      return { width: source.width, height: source.height, label: `${source.width} × ${source.height}` };
    }
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round((window.screen?.width || 1920) * dpr);
    const h = Math.round((window.screen?.height || 1080) * dpr);
    return { width: w, height: h, label: `${w} × ${h}` };
  }

  const [width, height] = setting.split('x').map((v) => Number(v));
  if (width && height) {
    return { width, height, label: `${width} × ${height}` };
  }
  return { width: null, height: null, label: 'source resolution' };
}

function getRecordingConstraint() {
  const constraint = {
    chromeMediaSource: 'desktop',
    chromeMediaSourceId: state.recording.sourceId,
    maxFrameRate: Number(state.recording.fps) || 60,
  };
  const resolved = resolveRecordingResolution();
  if (resolved.width && resolved.height) {
    constraint.maxWidth = resolved.width;
    constraint.maxHeight = resolved.height;
  }
  return constraint;
}

function getSelectedRecordingSource() {
  return state.captureSources.find((source) => source.id === state.recording.sourceId) || null;
}

function canUseNativeRecording() {
  // Desktop Duplication is currently reliable for monitor selection, but on
  // some Windows setups it does not include the transparent overlay window in
  // the captured output. Fall back to the in-app compositor so the baked-in
  // keycap overlay remains visible in saved videos.
  return false;
}

function buildNativeRecordingRequest() {
  const source = getSelectedRecordingSource();
  if (!source) return null;
  const resolved = resolveRecordingResolution();
  const captureWidth = Number(source.captureWidth) || Number(source.width) || null;
  const captureHeight = Number(source.captureHeight) || Number(source.height) || null;
  return {
    sourceKind: source.kind || state.recording.sourceKind || 'display',
    sourceId: source.nativeSourceId || source.id,
    width: resolved.width || captureWidth,
    height: resolved.height || captureHeight,
    captureX: Number(source.captureX) || 0,
    captureY: Number(source.captureY) || 0,
    captureWidth,
    captureHeight,
    fps: Number(state.recording.fps) || 60,
    format: state.recording.format || 'mp4',
    outputDir: state.recording.outputDir || '',
  };
}

function syncModeTabs() {
  qsa('#modeTabs .mode-tab').forEach((btn) => {
    btn.classList.toggle('on', btn.dataset.mode === state.mode);
  });
  document.body.dataset.mode = state.mode;
}

async function setMode(mode, { persist = true, autoStart = true, quietStart = false } = {}) {
  if (state.isRecording && mode !== 'recording') {
    await stopRecording();
  }
  state.mode = mode === 'recording' ? 'recording' : 'streaming';
  state.hasChosenMode = true;
  syncModeTabs();
  if (persist) saveState();
  renderAll();

  if (state.mode === 'recording') {
    await loadCaptureSources();
    await startRecordingPreview();
  } else {
    stopRecordingPreview();
  }

  if (state.mode === 'streaming' && autoStart && bridge && !state.serverRunning) {
    try {
      await bridge.startStreamingServer();
      await refreshStatus();
      if (!quietStart) toast('Streaming server started');
    } catch (_) {
      toast('Could not start streaming server', 'warn');
    }
  }
}

function syncRecordingInputs() {
  const sourceKind = qs('#recordingSourceKind');
  const sourceId = qs('#recordingSourceId');
  const resolution = qs('#recordingResolution');
  const fps = qs('#recordingFps');
  const format = qs('#recordingFormat');
  if (sourceKind) sourceKind.value = state.recording.sourceKind;
  if (sourceId) {
    sourceId.innerHTML = '';
    const candidates = state.captureSources.filter((source) => source.kind === state.recording.sourceKind);
    if (!candidates.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No sources available';
      sourceId.appendChild(opt);
    } else {
      candidates.forEach((source, index) => {
        const opt = document.createElement('option');
        opt.value = source.id;
        opt.textContent = getCaptureSourceLabel(source) || (source.kind === 'display' ? `Display ${index + 1}` : source.name);
        sourceId.appendChild(opt);
      });
      const selected = candidates.some((source) => source.id === state.recording.sourceId)
        ? state.recording.sourceId
        : candidates[0].id;
      sourceId.value = selected;
      const picked = candidates.find((source) => source.id === selected);
      state.recording.sourceId = selected;
      state.recording.sourceName = getCaptureSourceLabel(picked);
    }
  }
  if (resolution) resolution.value = state.recording.resolution;
  if (fps) fps.value = state.recording.fps;
  if (format) format.value = state.recording.format;
  qs('#recordingOutputPath').textContent = state.recording.outputDir || 'Videos folder (default)';
  qs('#recordingFilenamePreview').textContent = `File name preview: ${buildRecordingFilenamePreview()}`;
  const sourceMeta = state.recording.sourceName || (state.recording.sourceKind === 'display' ? 'choose a display' : 'choose a window');
  const resMeta = resolveRecordingResolution().label;
  qs('#recMeta').textContent = `${state.recording.format.toUpperCase()} · ${state.recording.fps} FPS · ${resMeta} · ${sourceMeta}`;
}

function handleAppEvent(msg) {
  if (!msg || !msg.type) return;
  if (msg.type === 'updater') {
    updaterUI.apply(msg);
    if (msg.phase === 'downloading') updaterUI.progress(msg.pct);
    return;
  }
  if (msg.type === 'status' || msg.type === 'server-status') {
    if (typeof msg.running === 'boolean') state.serverRunning = msg.running;
    if (msg.version) state.appVersion = msg.version;
    if ('focusedExe' in msg) state.detectedApp = msg.focusedExe || null;
    if (msg.overlayUrl) state.overlayUrl = msg.overlayUrl;
    renderAll();
    return;
  }
    if (msg.type === 'native-recorder-status') {
      state.nativeRecorderStatus = {
        ...state.nativeRecorderStatus,
        ...msg,
      };
      if (msg.outputPath) {
        state.lastRecordingPath = msg.outputPath;
      }
      if (msg.recordingState) {
        state.isRecording = msg.recordingState === 'recording';
      }
      renderAll();
      return;
    }
  if (msg.type === 'config') {
    Object.assign(state.config, msg);
    renderAll();
    return;
  }
  if (msg.type === 'key' && msg.label) {
    addKey(msg.label, msg.description || null);
  }
}

const updaterUI = (() => {
  const el = qs('#updateBanner');
  const spin = `<div class="k-spin"><div class="face">K</div></div>`;
  function show(html) {
    el.innerHTML = html;
    el.classList.add('on');
  }
  function hide() {
    el.classList.remove('on');
    el.innerHTML = '';
  }
  return {
    apply(msg) {
      if (typeof msg.devMode === 'boolean') {
        state.devMode = msg.devMode;
        qs('#debugUpdateBtn').style.display = state.devMode ? '' : 'none';
      }
      if (!msg || !msg.phase || msg.phase === 'idle' || msg.phase === 'dev-mode') {
        hide();
        return;
      }
      switch (msg.phase) {
        case 'checking':
          show(`${spin}<span class="msg">Checking for updates...</span>`);
          break;
        case 'available':
          show(`${spin}<span class="msg">Update v${msg.version || '?'} available - downloading...</span><div class="progress"><div id="updProgress" style="width:0%"></div></div>`);
          break;
        case 'downloading': {
          const version = msg.version || '';
          show(`${spin}<span class="msg">Update ${version ? `v${version} ` : ''}available - downloading...</span><div class="progress"><div id="updProgress" style="width:${msg.pct || 0}%"></div></div>`);
          break;
        }
        case 'ready':
          show(`<span class="msg">KeyCap v${msg.version || '?'} is ready to install</span><span class="spacer"></span><button class="btn primary sm" id="updRestart">Restart now</button><button class="btn ghost sm" id="updLater">Later</button>`);
          break;
        case 'up-to-date':
          hide();
          break;
        case 'error':
          hide();
          if (msg.msg) toast('Update error: ' + msg.msg, 'warn');
          break;
        default:
          break;
      }
    },
    progress(pct) {
      const bar = qs('#updProgress');
      if (bar) bar.style.width = `${pct || 0}%`;
    },
    hide,
  };
})();

async function installUpdateNow() {
  const res = await api('POST', '/api/update-install');
  if (!res) {
    toast('Could not start update install', 'warn');
    return;
  }
  toast('Restarting to install update...');
}

function connectUpdaterWs() {
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  const ws = new WebSocket(`${proto}${location.host}/ws`);
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    if (msg.type !== 'updater') return;
    updaterUI.apply(msg);
    if (msg.phase === 'downloading') updaterUI.progress(msg.pct);
  });
  ws.addEventListener('close', () => setTimeout(connectUpdaterWs, 1000));
  ws.addEventListener('error', () => { try { ws.close(); } catch (_) {} });
}

async function loadUpdateStatus() {
  const data = await api('GET', '/api/update-status');
  if (data) updaterUI.apply(data);
}

async function loadShellState() {
  if (!bridge?.getShellState) return;
  const data = await bridge.getShellState();
  if (!data) return;
  state.desktopMode = true;
  state.serverRunning = !!data.serverRunning;
  state.appVersion = data.appVersion || data.version || state.appVersion;
  state.overlayUrl = data.overlayUrl || state.overlayUrl;
  state.detectedApp = data.focusedExe || state.detectedApp;
  if (data.nativeRecorderStatus) {
    state.nativeRecorderStatus = {
      ...state.nativeRecorderStatus,
      ...data.nativeRecorderStatus,
    };
  }
}

function renderHelpContent() {
  const title = qs('#helpTitle');
  const subtitle = qs('#helpSubtitle');
  const body = qs('#helpBody');
  if (!title || !subtitle || !body) return;

  if (state.mode === 'recording') {
    title.textContent = 'Recording help';
    subtitle.textContent = 'KeyCap - local recording workflow';
    body.innerHTML = `
      <section>
        <h4>1 · Recording setup</h4>
        <p>Click the <strong>Recording mode</strong> status bar at the top to adjust format, source type, resolution, frame rate, and output folder.</p>
      </section>
      <section>
        <h4>2 · Overlay styling</h4>
        <p>The left panel still controls the overlay look, and the center preview shows exactly how the key overlay will appear once the recording engine lands.</p>
      </section>
      <section>
        <h4>3 · Hotkeys stay visible</h4>
        <p>The right panel keeps your app profiles and shortcut descriptions available in Recording mode, so you can keep refining labels without bouncing between modes.</p>
      </section>
        <section>
          <h4>4 · Current status</h4>
          <p>Display capture now records through the native recorder path, and the overlay is shown live on the selected display so it lands in the saved video. Window capture is still the next upgrade.</p>
        </section>
    `;
    return;
  }

  title.textContent = 'Streaming help';
  subtitle.textContent = 'KeyCap - OBS keystroke overlay';
  body.innerHTML = `
    <section>
      <h4>1 · Add to OBS</h4>
      <p>In OBS, add a <strong>Browser Source</strong> and paste in the overlay URL. Set width to <strong>1920</strong> and height to <strong>1080</strong>. Enable <em>Refresh browser when scene becomes active</em>.</p>
      <div class="mono-block">${buildURL()}</div>
    </section>
    <section>
      <h4>2 · Starting the server</h4>
      <p>If you're running the <strong>KeyCap app (.exe)</strong>, enter <strong>Streaming</strong> mode to start the local server. It no longer boots automatically in the background.</p>
      <p>If you're running from source, start it from the project folder:</p>
      <div class="mono-block">npm start</div>
    </section>
    <section>
      <h4>3 · Themes &amp; presets</h4>
      <p>Use the left panel to style the overlay, then save a preset when a look is worth keeping. Theme, colors, animation, and caption treatment all carry through to the live overlay.</p>
    </section>
    <section>
      <h4>4 · App profiles</h4>
      <p>Create a profile for each app you use and map shortcut combinations to descriptions. KeyCap will switch automatically when the focused app changes.</p>
    </section>
  `;
}

function openHelpModal() {
  renderHelpContent();
  qs('#modalSetup').classList.add('on');
}

function closeHelpModal() {
  qs('#modalSetup').classList.remove('on');
}

async function openRecordingSettingsModal() {
  await loadCaptureSources();
  syncRecordingInputs();
  qs('#modalRecordingSettings').classList.add('on');
}

function closeRecordingSettingsModal() {
  qs('#modalRecordingSettings').classList.remove('on');
}

async function pickRecordingOutputPath() {
  if (!bridge?.chooseRecordingOutputPath) {
    toast('Output folder picking is available in the desktop app', 'warn');
    return;
  }
  const picked = await bridge.chooseRecordingOutputPath();
  if (!picked) return;
  state.recording.outputDir = picked;
  renderAll();
  saveState();
  toast('Recording output folder updated');
}

async function loadCaptureSources({ preserveSelection = true } = {}) {
  const listSources = bridge?.listNativeRecorderSources || bridge?.listCaptureSources;
  if (!listSources) return;
  try {
    const result = await listSources();
    state.captureSources = Array.isArray(result) ? result : [];
    const matching = state.captureSources.filter((source) => source.kind === state.recording.sourceKind);
    if (!preserveSelection || !matching.some((source) => source.id === state.recording.sourceId)) {
      const next = matching[0] || null;
      state.recording.sourceId = next ? next.id : '';
      state.recording.sourceName = getCaptureSourceLabel(next);
    } else {
      const current = matching.find((source) => source.id === state.recording.sourceId);
      state.recording.sourceName = getCaptureSourceLabel(current);
    }
    syncRecordingInputs();
  } catch (err) {
    console.warn('capture sources', err);
    state.captureSources = [];
    state.recording.sourceId = '';
    state.recording.sourceName = '';
    syncRecordingInputs();
  }
}

function stopRecordingPreview() {
  const video = qs('#recordingPreviewVideo');
  const empty = qs('#recordingPreviewEmpty');
  if (state.recordingPreviewStream) {
    state.recordingPreviewStream.getTracks().forEach((track) => track.stop());
    state.recordingPreviewStream = null;
  }
  if (video) {
    video.pause();
    video.srcObject = null;
    video.classList.remove('on');
  }
  if (empty) empty.classList.remove('on');
}

function pickRecordingMime(format) {
  const wanted = format === 'mp4'
    ? ['video/mp4;codecs=h264', 'video/mp4']
    : ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  for (const mime of wanted) {
    if (window.MediaRecorder?.isTypeSupported?.(mime)) {
      return mime;
    }
  }
  const fallback = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', ''];
  for (const mime of fallback) {
    if (!mime || window.MediaRecorder?.isTypeSupported?.(mime)) return mime;
  }
  return '';
}

function stopActiveRecorderTracks(recorder = state.mediaRecorder) {
  if (!recorder?.stream) return;
  recorder.stream.getTracks().forEach((track) => track.stop());
}

function stopRecordingSourceStream() {
  if (!state.recordingSourceStream) return;
  state.recordingSourceStream.getTracks().forEach((track) => track.stop());
  state.recordingSourceStream = null;
}

function stopRecordingComposite() {
  if (state.recordingCompositeRaf) {
    cancelAnimationFrame(state.recordingCompositeRaf);
    state.recordingCompositeRaf = 0;
  }
  if (state.recordingCompositeStream) {
    state.recordingCompositeStream.getTracks().forEach((track) => track.stop());
    state.recordingCompositeStream = null;
  }
  if (state.recordingCompositeVideo) {
    try { state.recordingCompositeVideo.pause(); } catch (_) {}
    state.recordingCompositeVideo.srcObject = null;
    state.recordingCompositeVideo = null;
  }
  if (state.recordingCompositeRenderer) {
    try { state.recordingCompositeRenderer.dispose(); } catch (_) {}
    state.recordingCompositeRenderer = null;
  }
  state.recordingCompositeCanvas = null;
  stopOverlayCapture();
}

// ─── Offscreen overlay frame capture ────────────────────────────────────────
// Main process runs the real overlay page in a hidden BrowserWindow and
// streams its paint buffers (BGRA, premultiplied alpha, top-down) here.
// We stash the raw buffer and hand it straight to WebGL during compositing;
// no per-pixel JS work runs on the main thread.

function handleOverlayFrame(payload) {
  if (!payload || !payload.buffer) return;
  const { width, height } = payload;
  const view = payload.buffer instanceof Uint8Array
    ? payload.buffer
    : new Uint8Array(payload.buffer);
  if (!width || !height || view.length !== width * height * 4) return;
  state.overlayFramePending = { buffer: view, width, height };
}

async function startOverlayCapture(width, height, fps) {
  if (!bridge?.startOverlayCapture) return;
  stopOverlayCapture();
  try {
    const result = await bridge.startOverlayCapture({ width, height, fps });
    if (!result?.ok) {
      console.warn('overlay capture failed', result?.error);
      return;
    }
  } catch (err) {
    console.warn('overlay capture start', err);
    return;
  }
  state.overlayFrameUnsub = bridge.onOverlayFrame?.((payload) => {
    try { handleOverlayFrame(payload); } catch (_) {}
  }) || null;
}

function stopOverlayCapture() {
  if (typeof state.overlayFrameUnsub === 'function') {
    try { state.overlayFrameUnsub(); } catch (_) {}
    state.overlayFrameUnsub = null;
  }
  state.overlayFramePending = null;
  if (bridge?.stopOverlayCapture) {
    bridge.stopOverlayCapture().catch(() => {});
  }
}

// ─── WebGL compositor ────────────────────────────────────────────────────────
// One GPU pass that samples the source <video> and the raw BGRA overlay
// buffer and blends them. BGR→RGB is a cheap swizzle; the overlay buffer is
// premultiplied alpha, so we blend with out = ov.rgb + src * (1 - ov.a) and
// never have to unmultiply in JS. Replaces the per-pixel JS loop that was
// eating ~30ms/frame on the renderer thread at 1080p.
function createCompositeRenderer(canvas) {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance',
  });
  if (!gl) {
    console.warn('WebGL2 unavailable for recording composite');
    return null;
  }

  const vsSrc =
    '#version 300 es\n' +
    'in vec2 aPos;\n' +
    'out vec2 vUV;\n' +
    'void main() {\n' +
    '  vUV = vec2((aPos.x + 1.0) * 0.5, 1.0 - (aPos.y + 1.0) * 0.5);\n' +
    '  gl_Position = vec4(aPos, 0.0, 1.0);\n' +
    '}';

  const fsSrc =
    '#version 300 es\n' +
    'precision mediump float;\n' +
    'uniform sampler2D uVideo;\n' +
    'uniform sampler2D uOverlay;\n' +
    'uniform bool uHasOverlay;\n' +
    'in vec2 vUV;\n' +
    'out vec4 fragColor;\n' +
    'void main() {\n' +
    '  vec3 src = texture(uVideo, vUV).rgb;\n' +
    '  if (uHasOverlay) {\n' +
    '    vec4 ov = texture(uOverlay, vUV);\n' +
    '    // BGRA premultiplied -> RGBA premultiplied via .bgr swizzle;\n' +
    '    // premultiplied "over": out = ov.rgb + src * (1 - ov.a).\n' +
    '    fragColor = vec4(ov.bgr + src * (1.0 - ov.a), 1.0);\n' +
    '  } else {\n' +
    '    fragColor = vec4(src, 1.0);\n' +
    '  }\n' +
    '}';

  function compile(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.error('shader compile', gl.getShaderInfoLog(sh));
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  }
  const vs = compile(gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
  if (!vs || !fs) return null;
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error('program link', gl.getProgramInfoLog(prog));
    return null;
  }
  gl.useProgram(prog);

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1,  1, -1,  -1,  1,
    -1,  1,  1, -1,   1,  1,
  ]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, 'aPos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  function makeTex(unit) {
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }
  const videoTex = makeTex(0);
  const overlayTex = makeTex(1);

  gl.uniform1i(gl.getUniformLocation(prog, 'uVideo'), 0);
  gl.uniform1i(gl.getUniformLocation(prog, 'uOverlay'), 1);
  const uHasOverlay = gl.getUniformLocation(prog, 'uHasOverlay');

  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.disable(gl.BLEND);  // blending happens in the shader

  let videoReady = false;
  let overlayReady = false;
  let overlayW = 0;
  let overlayH = 0;

  return {
    uploadVideo(video) {
      if (!video || !video.videoWidth || !video.videoHeight) return;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, videoTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
        videoReady = true;
      } catch (err) {
        // Video may not yet have a decoded frame — silently skip this tick.
      }
    },
    uploadOverlay(view, w, h) {
      if (!view || !w || !h) return;
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, overlayTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      if (w !== overlayW || h !== overlayH) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, view);
        overlayW = w;
        overlayH = h;
      } else {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, view);
      }
      overlayReady = true;
    },
    render() {
      if (!videoReady) return;
      gl.uniform1i(uHasOverlay, overlayReady ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    },
    dispose() {
      try { gl.deleteTexture(videoTex); } catch (_) {}
      try { gl.deleteTexture(overlayTex); } catch (_) {}
      try { gl.deleteBuffer(quad); } catch (_) {}
      try { gl.deleteProgram(prog); } catch (_) {}
      try { gl.deleteShader(vs); } catch (_) {}
      try { gl.deleteShader(fs); } catch (_) {}
    },
  };
}

async function createCompositeRecordingStream(sourceStream) {
  const sourceVideo = document.createElement('video');
  sourceVideo.muted = true;
  sourceVideo.playsInline = true;
  sourceVideo.srcObject = sourceStream;
  await sourceVideo.play();

  const track = sourceStream.getVideoTracks()[0];
  const settings = track?.getSettings?.() || {};
  let width = Number(settings.width) || sourceVideo.videoWidth || 1920;
  let height = Number(settings.height) || sourceVideo.videoHeight || 1080;
  const resolved = resolveRecordingResolution();
  if (resolved.width && resolved.height) {
    width = resolved.width;
    height = resolved.height;
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const fps = Number(state.recording.fps) || 60;

  const renderer = createCompositeRenderer(canvas);
  if (!renderer) {
    throw new Error('Failed to initialise WebGL compositor');
  }
  state.recordingCompositeRenderer = renderer;

  // Kick off the offscreen overlay renderer at the same resolution/fps so
  // its paint frames drop in 1:1 without scaling.
  startOverlayCapture(width, height, fps).catch((err) => {
    console.warn('overlay capture', err);
  });

  // rAF-driven draw loop. Canvas stays fresh at the display refresh rate so
  // captureStream(fps) samples evenly-spaced frames with no duplication.
  const tick = () => {
    renderer.uploadVideo(sourceVideo);
    const pending = state.overlayFramePending;
    if (pending) {
      renderer.uploadOverlay(pending.buffer, pending.width, pending.height);
      state.overlayFramePending = null;
    }
    renderer.render();
    state.recordingCompositeRaf = requestAnimationFrame(tick);
  };
  state.recordingCompositeRaf = requestAnimationFrame(tick);

  state.recordingCompositeCanvas = canvas;
  state.recordingCompositeVideo = sourceVideo;
  state.recordingCompositeStream = canvas.captureStream(fps);
  return state.recordingCompositeStream;
}

async function finishRecording() {
  const recorder = state.mediaRecorder;
  state.mediaRecorder = null;
  state.isRecording = false;
  renderAll();

  if (!state.recordingChunks.length) {
    stopActiveRecorderTracks(recorder);
    stopRecordingComposite();
    stopRecordingSourceStream();
    state.recordingChunks = [];
    toast('Recording stopped, but no data was captured', 'warn');
    return;
  }

  const preferredFormat = state.recording.format;
  const actualExt = recorder?.mimeType?.includes('mp4') ? 'mp4' : 'webm';
  const blob = new Blob(state.recordingChunks, {
    type: recorder?.mimeType || (actualExt === 'mp4' ? 'video/mp4' : 'video/webm'),
  });
  state.recordingChunks = [];
  stopActiveRecorderTracks(recorder);
  stopRecordingComposite();
  stopRecordingSourceStream();

  try {
    const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
    const saved = await bridge?.saveRecordingFile?.({
      bytes,
      ext: actualExt,
      outputDir: state.recording.outputDir || '',
    });
    state.lastRecordingPath = saved?.path || '';
    if (preferredFormat === 'mp4' && actualExt !== 'mp4') {
      toast('Saved recording as WebM because MP4 encoding is not available on this system', 'warn');
    } else {
      toast(`Saved recording to ${state.lastRecordingPath}`, 'ok');
    }
  } catch (err) {
    console.warn('save recording', err);
    toast('Recording captured, but saving failed', 'warn');
  } finally {
    if (state.mode === 'recording') {
      await startRecordingPreview();
    }
  }
}

async function startRecording() {
  if (state.isRecording) return;
  if (!state.recording.sourceId) {
    toast('Choose a display or window first', 'warn');
    return;
  }

  try {
    await pushConfig();
  } catch (err) {
    console.warn('push config before recording', err);
  }

  if (canUseNativeRecording()) {
    const request = buildNativeRecordingRequest();
    if (!request) {
      toast('Choose a display first', 'warn');
      return;
    }
    if (request.sourceKind !== 'display') {
      toast('Native recording currently supports display capture only', 'warn');
      return;
    }
    try {
      const started = await bridge.startNativeRecording(request);
      state.isRecording = true;
      state.lastRecordingPath = started?.outputPath || '';
      renderAll();
      toast('Recording started — overlay is live on the selected display');
      return;
    } catch (err) {
      console.warn('start native recording', err);
      toast(err?.message || 'Could not start recording', 'warn');
      return;
    }
  }

  const mimeType = pickRecordingMime(state.recording.format);
  if (state.recordingPreviewStream) {
    stopRecordingPreview();
  }

  try {
    const sourceStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: getRecordingConstraint() },
    });
    state.recordingSourceStream = sourceStream;
    state.recordingPreviewStream = sourceStream;
    const previewVideo = qs('#recordingPreviewVideo');
    const previewEmpty = qs('#recordingPreviewEmpty');
    if (previewVideo && previewEmpty) {
      previewVideo.srcObject = sourceStream;
      await previewVideo.play();
      previewVideo.classList.add('on');
      previewEmpty.classList.remove('on');
    }
    const recorderStream = await createCompositeRecordingStream(sourceStream);

    const options = mimeType ? { mimeType } : {};
    const recorder = new MediaRecorder(recorderStream, options);
    state.recordingChunks = [];
    state.mediaRecorder = recorder;
    state.isRecording = true;
    renderAll();

    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        state.recordingChunks.push(event.data);
      }
    };
    recorder.onerror = (event) => {
      console.warn('media recorder', event.error || event);
      toast('Recording failed', 'warn');
    };
    recorder.onstop = () => {
      finishRecording().catch((err) => {
        console.warn('finish recording', err);
        toast('Recording finalization failed', 'warn');
      });
    };
    recorder.start(1000);
    toast('Recording started');
  } catch (err) {
    console.warn('start recording', err);
    stopRecordingComposite();
    stopRecordingSourceStream();
    state.recordingPreviewStream = null;
    state.isRecording = false;
    renderAll();
    toast('Could not start recording', 'warn');
    await startRecordingPreview();
  }
}

async function stopRecording() {
  if (canUseNativeRecording() && state.nativeRecorderStatus?.recordingState === 'recording') {
    try {
      const stopped = await bridge.stopNativeRecording();
      state.isRecording = false;
      if (stopped?.outputPath) {
        state.lastRecordingPath = stopped.outputPath;
        toast(`Saved recording to ${stopped.outputPath}`, 'ok');
      } else {
        toast('Recording stopped');
      }
      renderAll();
    } catch (err) {
      console.warn('stop native recording', err);
      toast(err?.message || 'Could not stop recording', 'warn');
    }
    return;
  }

  if (!state.mediaRecorder) return;
  if (state.mediaRecorder.state !== 'inactive') {
    state.mediaRecorder.stop();
  }
}

async function startRecordingPreview() {
  const video = qs('#recordingPreviewVideo');
  const empty = qs('#recordingPreviewEmpty');
  if (!video || !empty) return;

  stopRecordingPreview();
  if (state.mode !== 'recording') return;
  if (!state.recording.sourceId) {
    empty.classList.add('on');
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: getRecordingConstraint(),
      },
    });
    state.recordingPreviewStream = stream;
    video.srcObject = stream;
    await video.play();
    video.classList.add('on');
  } catch (err) {
    console.warn('recording preview', err);
    empty.innerHTML = `
      <div class="inner">
        <strong>Preview unavailable</strong>
        <div>KeyCap couldn't start a live capture preview for "${state.recording.sourceName || 'this source'}" yet.</div>
      </div>
    `;
    empty.classList.add('on');
  }
}

function hexToRgb(hex) {
  const h = hex.replace('#','');
  return [parseInt(h.slice(0,2),16), parseInt(h.slice(1,2),16)*0+parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
}
function hexRgb(hex) {
  const h = hex.replace('#','');
  return `${parseInt(h.slice(0,2),16)}, ${parseInt(h.slice(2,4),16)}, ${parseInt(h.slice(4,6),16)}`;
}

function normalizeHex(hex, fallback = '#000000') {
  const raw = String(hex || '').trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{6}$/.test(raw)) return `#${raw.toLowerCase()}`;
  if (/^[0-9a-fA-F]{3}$/.test(raw)) return `#${raw.split('').map((c) => c + c).join('').toLowerCase()}`;
  return fallback;
}

function mixHex(a, b, ratio = 0.5) {
  const left = normalizeHex(a);
  const right = normalizeHex(b);
  const t = Math.max(0, Math.min(1, Number(ratio) || 0));
  const mix = (start, end) => Math.round(start + (end - start) * t);
  const lr = parseInt(left.slice(1, 3), 16);
  const lg = parseInt(left.slice(3, 5), 16);
  const lb = parseInt(left.slice(5, 7), 16);
  const rr = parseInt(right.slice(1, 3), 16);
  const rg = parseInt(right.slice(3, 5), 16);
  const rb = parseInt(right.slice(5, 7), 16);
  return `#${[mix(lr, rr), mix(lg, rg), mix(lb, rb)].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

// ---------- apply preview styles ----------
function applyOverlayVars() {
  const r = document.documentElement.style;
  const keycapFillTop = mixHex(state.config.bg, '#ffffff', 0.72);
  const keycapFillMid = mixHex(state.config.bg, '#ffffff', 0.38);
  const keycapFillBottom = mixHex(state.config.bg, '#000000', 0.18);
  const keycapEdge = mixHex(state.config.border || state.config.bg, '#000000', 0.2);
  r.setProperty('--ov-bg',           state.config.bg);
  r.setProperty('--ov-border',       state.config.border);
  r.setProperty('--ov-glow',         state.config.glow);
  r.setProperty('--ov-bg-a',         `rgba(${hexRgb(state.config.bg)}, 0.55)`);
  r.setProperty('--ov-border-a',     `rgba(${hexRgb(state.config.border)}, 0.7)`);
  r.setProperty('--ov-keycap-fill-top', keycapFillTop);
  r.setProperty('--ov-keycap-fill-mid', keycapFillMid);
  r.setProperty('--ov-keycap-fill-bottom', keycapFillBottom);
  r.setProperty('--ov-keycap-edge', keycapEdge);
  r.setProperty('--ov-font-weight',  state.config.fontWeight  ?? 700);
  r.setProperty('--ov-font-family',  state.config.fontFamily  ?? "'Menlo', 'Consolas', monospace");
  r.setProperty('--ov-keycap-scale', state.config.keycapScale ?? 1);
  r.setProperty('--ov-caption-scale',state.config.captionScale ?? 1);
  r.setProperty('--ov-caption-gap',  (state.config.captionGap ?? 6) + 'px');

  // Optional per-element color overrides — empty = inherit theme/style defaults
  const setOrClear = (name, val) => val ? r.setProperty(name, val) : r.removeProperty(name);
  setOrClear('--ov-keycap-text',    state.config.keycapTextColor);
  setOrClear('--ov-caption-text',   state.config.captionTextColor);
  setOrClear('--ov-caption-bg',     state.config.captionBgColor);
  setOrClear('--ov-caption-border', state.config.captionBorderColor);
  document.body.classList.toggle('no-scanlines', !state.config.scanlines);

  const style = state.config.buttonStyle ?? 'vhs';
  document.body.classList.remove('style-vhs', 'style-modern', 'style-sleek', 'style-keycap');
  document.body.classList.add(`style-${style}`);

  const anim = state.config.fade ?? 'glitch';
  document.body.classList.remove('anim-glitch', 'anim-fade', 'anim-slide', 'anim-pop', 'anim-snap', 'anim-rise');
  document.body.classList.add(`anim-${anim}`);

  document.body.classList.remove('shape-key-square', 'shape-key-round');
  const keyShape = state.config.keycapShape ?? 'theme';
  if (keyShape === 'square' || keyShape === 'round') {
    document.body.classList.add(`shape-key-${keyShape}`);
  }
  document.body.classList.remove('shape-cap-square', 'shape-cap-round');
  const capShape = state.config.captionShape ?? 'theme';
  if (capShape === 'square' || capShape === 'round') {
    document.body.classList.add(`shape-cap-${capShape}`);
  }
}

// ---------- build URL ----------
// Config is now saved server-side and pushed live over WebSocket,
// so the OBS Browser Source URL is always just the base — no params needed.
function buildURL() {
  return state.overlayUrl || 'http://127.0.0.1:8765/';
}

// ---------- render: themes ----------
function updatePickerBtn() {
  const t = THEMES[state.config.theme];
  const chip = qs('#themePickerChip');
  const cs = t ? CHIP_STYLES[t.buttonStyle]?.(t) : null;
  chip.style.background  = state.config.bg;
  chip.style.border      = `2px solid ${state.config.border}`;
  chip.style.borderRadius = cs?.radius ?? '0px';
  chip.style.boxShadow   = cs?.shadow  ?? 'none';
  qs('#themePickerLabel').textContent = t?.label ?? 'Custom';
}

function applyTheme(key) {
  const t = THEMES[key];
  if (!t) return;
  state.config.theme = key;
  Object.assign(state.config, {
    bg: t.bg, border: t.border, glow: t.glow,
    scanlines: t.scanlines, buttonStyle: t.buttonStyle,
  });
  renderAll();
  saveState();
}

function openThemeModal() {
  const modal = qs('#themeModal');
  const body  = qs('#themeModalBody');
  modal.classList.remove('hidden');
  body.innerHTML = '';

  // Group themes by style family
  const groups = {};
  Object.entries(THEMES).forEach(([key, t]) => {
    if (!groups[t.group]) groups[t.group] = [];
    groups[t.group].push([key, t]);
  });

  Object.entries(groups).forEach(([groupName, entries]) => {
    const lbl = document.createElement('div');
    lbl.className = 'theme-group-label';
    lbl.textContent = groupName;
    body.appendChild(lbl);

    const grid = document.createElement('div');
    grid.className = 'theme-grid';

    entries.forEach(([key, t]) => {
      const cs = CHIP_STYLES[t.buttonStyle]?.(t) ?? { radius: '0px', shadow: 'none' };
      const card = document.createElement('button');
      card.className = 'theme-card' + (state.config.theme === key ? ' on' : '');
      card.innerHTML = `
        <div class="card-chip">
          <div class="card-cap" style="
            background:${t.bg}; border:2px solid ${t.border};
            box-shadow:${cs.shadow}; border-radius:${cs.radius};
          ">${t.label}</div>
        </div>
        <div class="card-label">${t.label}</div>
      `;
      card.onclick = () => {
        applyTheme(key);
        qs('#themeModal').classList.add('hidden');
      };
      grid.appendChild(card);
    });
    body.appendChild(grid);
  });
}

function demoAnimation() {
  const live = qs('#liveOverlay');
  live.innerHTML = '';
  addKey('CTRL + S', 'Save File');
  setTimeout(() => addKey('Z', 'Undo'), 160);
}

// ---------- render: color rows ----------
function effectiveDefault(overrideKey) {
  // Compute what each override inherits from, so the swatch can preview it.
  const style = state.config.buttonStyle ?? 'vhs';
  switch (overrideKey) {
    case 'keycapTextColor':     return style === 'keycap' ? '#222222' : '#ffffff';
    case 'captionTextColor':    return style === 'keycap' ? '#222222' : state.config.border;
    case 'captionBgColor':      return style === 'keycap' ? '#f5f3ec' : '#140019';
    case 'captionBorderColor':  return style === 'keycap' ? '#000000'
                                     : style === 'sleek'  ? '#00000000'
                                     : state.config.glow;
    default: return '#000000';
  }
}

function setupColorInputs() {
  ['bg','border','glow'].forEach(key => {
    const sw = qs(`#swatch-${key}`);
    const hx = qs(`#hex-${key}`);
    sw.querySelector('input[type=color]').value = state.config[key];
    sw.style.background = state.config[key];
    hx.value = state.config[key].toUpperCase();

    sw.querySelector('input[type=color]').oninput = (e) => {
      state.config[key] = e.target.value;
      state.config.theme = 'custom';
      sw.style.background = e.target.value;
      hx.value = e.target.value.toUpperCase();
      applyOverlayVars();
      updatePickerBtn();
      updateExportURL();
      saveState();
      syncOverrideSwatches();
    };
    hx.oninput = (e) => {
      const v = e.target.value.trim();
      if (/^#?[0-9a-f]{6}$/i.test(v)) {
        const col = v.startsWith('#') ? v : '#' + v;
        state.config[key] = col;
        state.config.theme = 'custom';
        sw.style.background = col;
        sw.querySelector('input[type=color]').value = col;
        applyOverlayVars();
        updatePickerBtn();
        updateExportURL();
        saveState();
        syncOverrideSwatches();
      }
    };
  });

  // Per-element overrides (keycap text, caption text/bg/border)
  const OVERRIDES = [
    { id: 'keycaptext',     key: 'keycapTextColor'    },
    { id: 'captiontext',    key: 'captionTextColor'   },
    { id: 'captionbg',      key: 'captionBgColor'     },
    { id: 'captionborder',  key: 'captionBorderColor' },
  ];
  OVERRIDES.forEach(({ id, key }) => {
    const sw = qs(`#swatch-${id}`);
    const hx = qs(`#hex-${id}`);
    const rs = qs(`#reset-${id}`);
    const picker = sw.querySelector('input[type=color]');
    const setFromOverride = (col) => {
      state.config[key] = col;
      sw.classList.remove('inherited');
      sw.style.background = col;
      picker.value = col;
      hx.value = col.toUpperCase();
      applyOverlayVars();
      saveState();
    };
    picker.oninput = (e) => setFromOverride(e.target.value);
    hx.oninput = (e) => {
      const v = e.target.value.trim();
      if (/^#?[0-9a-f]{6}$/i.test(v)) {
        setFromOverride(v.startsWith('#') ? v : '#' + v);
      }
    };
    rs.onclick = () => {
      state.config[key] = '';
      applyOverlayVars();
      saveState();
      syncOverrideSwatches();
    };
  });

  syncOverrideSwatches();
}

function syncOverrideSwatches() {
  const OVERRIDES = [
    { id: 'keycaptext',    key: 'keycapTextColor'    },
    { id: 'captiontext',   key: 'captionTextColor'   },
    { id: 'captionbg',     key: 'captionBgColor'     },
    { id: 'captionborder', key: 'captionBorderColor' },
  ];
  OVERRIDES.forEach(({ id, key }) => {
    const sw = qs(`#swatch-${id}`);
    const hx = qs(`#hex-${id}`);
    if (!sw || !hx) return;
    const val = state.config[key] || '';
    const picker = sw.querySelector('input[type=color]');
    if (val) {
      sw.classList.remove('inherited');
      sw.style.background = val;
      picker.value = val;
      hx.value = val.toUpperCase();
    } else {
      sw.classList.add('inherited');
      const fallback = effectiveDefault(key);
      sw.style.background = fallback;
      picker.value = /^#[0-9a-f]{6}$/i.test(fallback) ? fallback : '#000000';
      hx.value = '';
    }
  });
}

// ---------- anchor picker ----------
const ANCHOR_POSITIONS = [
  ['top-left','TL'],['top-center','TC'],['top-right','TR'],
  ['middle-left','ML'],['middle-center','MC'],['middle-right','MR'],
  ['bottom-left','BL'],['bottom-center','BC'],['bottom-right','BR'],
];
function renderAnchor() {
  const g = qs('#anchorPicker');
  g.innerHTML = '';
  ANCHOR_POSITIONS.forEach(([pos, label]) => {
    const c = document.createElement('button');
    c.className = 'anchor-cell' + (state.config.position === pos ? ' on' : '');
    c.title = pos;
    c.innerHTML = `<span class="dot"></span>`;
    c.onclick = () => { state.config.position = pos; renderAll(); saveState(); };
    g.appendChild(c);
  });
}

// ---------- live preview ----------
function positionOverlay(el) {
  // Scale all pixel values down to match the canvas's proportion of 1920×1080
  // so both Edit and Focus preview modes show a true 1:1 representation.
  const canvas = qs('#previewCanvas');
  const canvasScale = canvas.offsetWidth / 1920;

  const pos = state.config.position;
  const [vert, horiz] = pos.split('-');
  const my = (state.config.marginY ?? state.config.margin ?? 60) * canvasScale;
  const mx = (state.config.marginX ?? 0) * canvasScale;
  const effectiveScale = state.config.scale * canvasScale;

  el.style.top = 'auto'; el.style.bottom = 'auto';
  el.style.left = 'auto'; el.style.right = 'auto';
  el.style.transform = '';

  // vert
  if (vert === 'top') el.style.top = my + 'px';
  else if (vert === 'middle') el.style.top = '50%';
  else el.style.bottom = my + 'px';

  // horiz
  if (horiz === 'left') el.style.left = mx + 'px';
  else if (horiz === 'right') el.style.right = mx + 'px';
  else el.style.left = '50%';

  // scale + translate
  const translates = [];
  if (horiz === 'center') translates.push(`translateX(calc(-50% + ${mx}px))`);
  if (vert === 'middle') translates.push('translateY(-50%)');
  translates.push(`scale(${effectiveScale})`);
  el.style.transform = translates.join(' ');
  el.style.opacity = state.config.opacity;

  // align items based on vertical anchor
  el.style.alignItems = vert === 'top' ? 'flex-start' : 'flex-end';

  // transformOrigin relative to anchor
  const originV = vert === 'top' ? 'top' : vert === 'middle' ? 'center' : 'bottom';
  el.style.transformOrigin = `${originV} ${horiz}`;
}

function renderBgToggle() {
  const toggle = qs('#bgToggle');
  if (!toggle) return;

  // rebuild only the dynamic background image buttons, keep scene/checker
  qsa('#bgToggle .bg-thumb').forEach(b => b.remove());

  state.backgrounds.forEach(bg => {
    const btn = document.createElement('button');
    btn.className = 'bg-thumb' + (state.previewBg === bg.url ? ' on' : '');
    btn.textContent = bg.name;
    btn.dataset.bg = bg.url;
    btn.onclick = () => { state.previewBg = bg.url; renderPreview(); saveState(); };
    toggle.appendChild(btn);
  });

  // sync scene/checker active state
  qsa('#bgToggle button:not(.bg-thumb)').forEach(b =>
    b.classList.toggle('on', b.dataset.bg === state.previewBg));
}

function renderPreview() {
  const canvas = qs('#previewCanvas');
  const isScene   = state.previewBg === 'scene';
  const isChecker = state.previewBg === 'checker';
  const isImage   = !isScene && !isChecker;

  canvas.classList.toggle('bg-scene',   isScene);
  canvas.classList.toggle('bg-checker', isChecker);
  canvas.style.backgroundImage   = isImage ? `url('${state.previewBg}')` : '';
  canvas.style.backgroundSize    = isImage ? 'cover' : '';
  canvas.style.backgroundPosition = isImage ? 'center' : '';

  const live = qs('#liveOverlay');
  positionOverlay(live);

  const previewEmpty = qs('#recordingPreviewEmpty');
  if (state.mode === 'recording') {
    canvas.classList.remove('bg-scene', 'bg-checker');
    canvas.style.backgroundImage = '';
    canvas.style.backgroundSize = '';
    canvas.style.backgroundPosition = '';
    if (previewEmpty && !state.recording.sourceId) {
      previewEmpty.innerHTML = `
        <div class="inner">
          <strong>Choose a recording source</strong>
          <div>Pick a display or window in Recording setup to preview the actual capture here.</div>
        </div>
      `;
      previewEmpty.classList.add('on');
    }
  } else if (previewEmpty) {
    previewEmpty.classList.remove('on');
  }

  renderBgToggle();
}

function addKey(label, description, { sticky = false } = {}) {
  const live = qs('#liveOverlay');
  while (live.children.length >= state.config.maxKeys) {
    live.firstElementChild.remove();
  }
  const wrap = document.createElement('div');
  wrap.className = description ? 'key-cap annotated' : 'key-cap';

  const kc = document.createElement('div');
  kc.className = 'keycap-el';
  kc.textContent = label;

  let cap = null;
  if (description) {
    cap = document.createElement('div');
    cap.className = 'key-caption';
    cap.textContent = description;
  }
  const below = (state.config.captionPosition ?? 'above') === 'below';
  if (cap && !below) wrap.appendChild(cap);
  wrap.appendChild(kc);
  if (cap && below) wrap.appendChild(cap);
  live.appendChild(wrap);

  if (!sticky) {
    setTimeout(() => {
      wrap.classList.add('fading');
      setTimeout(() => {
        wrap.remove();
        // Re-seed the preview so it never ends up blank once the user plays
        // with the test keys — otherwise all you'd have is an empty canvas.
        if (!live.children.length) seedPreview();
      }, 500);
    }, state.config.lifetime);
  }
}

// Render a few sticky example keys so the preview never looks empty
function seedPreview() {
  const live = qs('#liveOverlay');
  live.innerHTML = '';
  const profile = state.profiles[state.activeProfile];
  // Make a Ctrl + S styled example
  const wrap = document.createElement('div');
  wrap.className = 'key-cap annotated';
  const below = (state.config.captionPosition ?? 'above') === 'below';
  wrap.innerHTML = below
    ? `<div class="keycap-el">CTRL + S</div><div class="key-caption">Save</div>`
    : `<div class="key-caption">Save</div><div class="keycap-el">CTRL + S</div>`;
  live.appendChild(wrap);

  const wrap2 = document.createElement('div');
  wrap2.className = 'key-cap';
  wrap2.innerHTML = `<div class="keycap-el">B</div>`;
  live.appendChild(wrap2);
}

// ---------- tester ----------
function renderTester() {
  const tk = qs('#testerKeys');
  tk.innerHTML = '';
  const profile = state.profiles[state.activeProfile];
  const quick = ['ctrl+s', 'ctrl+z', 'ctrl+shift+z', 'ctrl+t', 'b', 'space', 'shift+d', 'f5'];
  quick.forEach(combo => {
    const btn = document.createElement('button');
    btn.className = 'test-key';
    btn.textContent = combo.toUpperCase().replace(/\+/g,' + ');
    btn.onclick = () => {
      const label = formatCombo(combo);
      const desc = profile?.keys?.[combo] || null;
      addKey(label, desc);
      api('POST', '/api/test-key', { label, description: desc });
    };
    tk.appendChild(btn);
  });
  const custom = document.createElement('button');
  custom.className = 'test-key custom';
  custom.textContent = '+ custom';
  custom.onclick = () => {
    const c = prompt('Combo (e.g. ctrl+alt+k):');
    if (c) {
      const desc = profile?.keys?.[c.toLowerCase()] || null;
      addKey(formatCombo(c), desc);
    }
  };
  tk.appendChild(custom);
}
function formatCombo(combo) {
  return combo.split('+').map(p => {
    if (p === 'ctrl') return 'CTRL';
    if (p === 'shift') return '⇧';
    if (p === 'alt') return 'ALT';
    if (p === 'space') return 'SPACE';
    return p.toUpperCase();
  }).join(' + ');
}

// ---------- keymap editor ----------
function renderKmTable() {
  const body = qs('#kmRows');
  body.innerHTML = '';
  const profile = state.profiles[state.activeProfile];
  const entries = Object.entries(profile.keys)
    .sort((a,b) => a[0].localeCompare(b[0]));
  entries.forEach(([combo, desc]) => {
    const row = document.createElement('div');
    row.className = 'tr';
    const parts = combo.split('+').map(p => `<span class="kbd">${
      p === 'ctrl' ? 'Ctrl' : p === 'shift' ? '⇧' : p === 'alt' ? 'Alt' : p.toUpperCase()
    }</span>`).join('<span class="plus">+</span>');
    row.innerHTML = `
      <div class="combo">${parts}</div>
      <div class="desc"><input value="${desc.replace(/"/g,'&quot;')}" data-combo="${combo}"></div>
      <div class="actions">
        <button class="iconbtn" title="Test">⏵</button>
        <button class="iconbtn del" title="Delete">✕</button>
      </div>
    `;
    row.querySelector('input').onchange = (e) => {
      profile.keys[combo] = e.target.value;
      saveState(); pushProfile(state.activeProfile);
    };
    row.querySelector('.iconbtn:not(.del)').onclick = () => {
      addKey(formatCombo(combo), desc);
      api('POST', '/api/test-key', { label: formatCombo(combo), description: desc });
    };
    row.querySelector('.iconbtn.del').onclick = () => {
      delete profile.keys[combo];
      saveState(); renderKmTable();
      pushProfile(state.activeProfile);
    };
    body.appendChild(row);
  });
  qs('#kmCount').textContent = `${entries.length} hotkeys`;
}

// ---------- main render ----------
function renderAll() {
  syncModeTabs();
  applyOverlayVars();
  updatePickerBtn();
  if (typeof syncOverrideSwatches === 'function') syncOverrideSwatches();
  renderAnchor();
  renderPreview();
  renderKmTable();
  renderTester();

  // sliders — sync thumb position AND display text
  const marginY = state.config.marginY ?? state.config.margin ?? 60;
  const marginX = state.config.marginX ?? 0;
  qs('#slider-marginy').value      = marginY;
  qs('#val-marginy').textContent   = marginY + 'px';
  qs('#slider-marginx').value      = marginX;
  qs('#val-marginx').textContent   = marginX + 'px';
  qs('#slider-scale').value        = state.config.scale;
  qs('#val-scale').textContent     = state.config.scale.toFixed(2) + '×';
  qs('#slider-opacity').value      = state.config.opacity;
  qs('#val-opacity').textContent   = state.config.opacity.toFixed(2);
  qs('#slider-maxkeys').value      = state.config.maxKeys;
  qs('#val-maxkeys').textContent   = state.config.maxKeys;
  qs('#slider-lifetime').value     = state.config.lifetime;
  qs('#val-lifetime').textContent  = (state.config.lifetime/1000).toFixed(1) + 's';
  const keycapScale  = state.config.keycapScale  ?? 1;
  const captionScale = state.config.captionScale ?? 1;
  qs('#slider-keycapscale').value   = keycapScale;
  qs('#val-keycapscale').textContent = keycapScale.toFixed(2) + '×';
  qs('#slider-captionscale').value   = captionScale;
  qs('#val-captionscale').textContent = captionScale.toFixed(2) + '×';
  const capGap = state.config.captionGap ?? 6;
  qs('#slider-captiongap').value       = capGap;
  qs('#val-captiongap').textContent    = capGap + 'px';

  // caption position / shape pills
  const capPos = state.config.captionPosition ?? 'above';
  qsa('#captionPosPill button').forEach(b => b.classList.toggle('on', b.dataset.val === capPos));
  const kShape = state.config.keycapShape ?? 'theme';
  qsa('#keycapShapePill button').forEach(b => b.classList.toggle('on', b.dataset.val === kShape));
  const cShape = state.config.captionShape ?? 'theme';
  qsa('#captionShapePill button').forEach(b => b.classList.toggle('on', b.dataset.val === cShape));

  // fade pills
  qs('#fadeSelect').value = state.config.fade ?? 'glitch';
  // weight pills
  qs('#slider-fontweight').value    = state.config.fontWeight ?? 700;
  qs('#val-fontweight').textContent = state.config.fontWeight ?? 700;
  // scanlines
  qsa('#scanlinesPill button').forEach(b => b.classList.toggle('on', (b.dataset.val === 'on') === state.config.scanlines));

  // profile dropdown
  const sel = qs('#profileSelect');
  const prevVal = sel.value;
  sel.innerHTML = '';
  Object.entries(state.profiles).forEach(([slug, p]) => {
    const opt = document.createElement('option');
    opt.value = slug;
    opt.textContent = `${p.name}  —  ${p.match.join(', ')}`;
    sel.appendChild(opt);
  });
  sel.value = state.profiles[state.activeProfile] ? state.activeProfile : Object.keys(state.profiles)[0];

  // font — coerce legacy bare names (e.g. "Menlo") into the System-mono stack
  // so the saved config still resolves to a valid <option>.
  const fontSel = qs('#fontFamily');
  const savedFF = state.config.fontFamily || '';
  const opts    = [...fontSel.options].map(o => o.value);
  if (!opts.includes(savedFF)) {
    state.config.fontFamily = "'Menlo', 'Consolas', monospace";
  }
  fontSel.value = state.config.fontFamily;

  // server strip
  const srv = qs('#serverStrip');
  srv.classList.toggle('off', !state.serverRunning);
  qs('#appVersion').textContent = `ver ${state.appVersion}`;
  qs('#srvStatus').textContent = state.serverRunning ? 'running' : 'stopped';
  qs('#srvUrl').textContent = buildURL().replace(/\/$/, '');
  qs('#srvApp').innerHTML = state.detectedApp
    ? `focused: <b>${state.detectedApp}</b> → ${state.profiles[state.activeProfile].name}`
    : 'no focused app detected';
  qs('#startStopBtn').textContent = state.serverRunning ? '■ Stop server' : '▶ Start server';
  qs('#startStopBtn').classList.toggle('danger', state.serverRunning);
  qs('#startStopBtn').classList.toggle('primary', !state.serverRunning);
  const recorderReady = !!state.nativeRecorderStatus?.ready;
  const nativeRecordingActive = state.nativeRecorderStatus?.recordingState === 'recording';
  qs('#recStatus').textContent = state.isRecording
    ? 'recording'
    : (recorderReady ? 'ready' : (state.recording.outputDir ? 'configured' : 'setup'));
  if (qs('#recordingStateLabel')) {
    const backendLabel = canUseNativeRecording()
      ? (state.nativeRecorderStatus?.backend === 'mock-js'
        ? 'native display recorder ready'
        : 'native recorder ready')
      : 'composited recorder ready';
    qs('#recordingStateLabel').textContent = state.isRecording
      ? ((canUseNativeRecording() && nativeRecordingActive) ? 'native recording in progress' : 'recording in progress')
      : (recorderReady ? backendLabel : (state.recording.outputDir ? 'preferences ready' : 'choose a source, format, and folder'));
  }
  const recordBtn = qs('#recordBtn');
  if (recordBtn) {
    recordBtn.textContent = state.isRecording ? 'STOP' : 'Record';
    recordBtn.classList.toggle('recording-live', state.isRecording);
    recordBtn.classList.toggle('primary', !state.isRecording);
  }
  syncRecordingInputs();

  updateExportURL();
}

function updateExportURL() {
  qs('#exportURL').textContent = buildURL();
}

// ---------- presets ----------
function slugifyName(s) {
  return (s || '').trim().toLowerCase()
    .replace(/[^a-z0-9\-_]+/g, '-')
    .replace(/-+/g, '-').replace(/^-|-$/g, '');
}
async function refreshPresets() {
  const data = await api('GET', '/api/presets');
  const sel  = qs('#presetSelect');
  const prev = sel.value;
  sel.innerHTML = '<option value="">— saved presets —</option>';
  const list = (data && data.presets) || [];
  list.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.slug;
    opt.textContent = p.name;
    sel.appendChild(opt);
  });
  if (prev && list.some(p => p.slug === prev)) sel.value = prev;
}
async function loadSelectedPreset() {
  const slug = qs('#presetSelect').value;
  if (!slug) { toast('Select a preset first', 'warn'); return; }
  const data = await api('GET', '/api/presets/' + encodeURIComponent(slug));
  if (!data) { toast('Preset not found', 'warn'); return; }
  const { __name, ...cfg } = data;
  Object.assign(state.config, cfg);
  renderAll();
  await pushConfig();
  toast(`Loaded preset "${__name || slug}"`);
}
async function saveNewPreset() {
  const name = qs('#savePresetName').value.trim();
  if (!name) return;
  const slug = slugifyName(name);
  if (!slug) { toast('Invalid preset name', 'warn'); return; }
  const res = await api('PUT', '/api/presets/' + encodeURIComponent(slug), {
    name, config: state.config,
  });
  if (!res) { toast('Save failed', 'warn'); return; }
  await refreshPresets();
  qs('#presetSelect').value = slug;
  qs('#modalSavePreset').classList.remove('on');
  toast(`Saved preset "${name}"`);
}
async function deleteSelectedPreset() {
  const sel = qs('#presetSelect');
  const slug = sel.value;
  if (!slug) { toast('Select a preset first', 'warn'); return; }
  const name = sel.options[sel.selectedIndex].textContent;
  if (!confirm(`Delete preset "${name}"?`)) return;
  const res = await api('DELETE', '/api/presets/' + encodeURIComponent(slug));
  if (!res) { toast('Delete failed', 'warn'); return; }
  await refreshPresets();
  toast(`Deleted "${name}"`);
}

// ---------- wire up events ----------
function wire() {
  qs('#updateBanner').addEventListener('click', (e) => {
    if (e.target.id === 'updRestart') {
      installUpdateNow();
    } else if (e.target.id === 'updLater') {
      updaterUI.hide();
    }
  });

  qsa('#modeTabs .mode-tab').forEach((btn) => {
    btn.onclick = () => setMode(btn.dataset.mode);
  });
  qs('#chooseStreamingModeBtn').onclick = () => {
    qs('#modeChooser').classList.remove('on');
    setMode('streaming');
  };
  qs('#chooseRecordingModeBtn').onclick = () => {
    qs('#modeChooser').classList.remove('on');
    setMode('recording', { autoStart: false });
  };
  qs('#recordingStrip').onclick = () => openRecordingSettingsModal();
  qs('#closeRecordingSettingsBtn').onclick = () => closeRecordingSettingsModal();
  qs('#modalRecordingSettings').onclick = (e) => { if (e.target.id === 'modalRecordingSettings') closeRecordingSettingsModal(); };
  qs('#recordingChooseOutputBtn').onclick = () => pickRecordingOutputPath();
  qs('#refreshRecordingSourcesBtn').onclick = async () => {
    await loadCaptureSources({ preserveSelection: false });
    await startRecordingPreview();
  };

  // theme modal
  qs('#themePickerBtn').onclick = () => openThemeModal();
  qs('#themeModalClose').onclick = () => qs('#themeModal').classList.add('hidden');
  qs('#themeModalBackdrop').onclick = () => qs('#themeModal').classList.add('hidden');

  // scene bg — static buttons (image buttons are wired in renderBgToggle)
  qsa('#bgToggle button:not(.bg-thumb)').forEach(b => b.onclick = () => {
    state.previewBg = b.dataset.bg; renderPreview(); saveState();
  });

  // anchor / sliders
  qs('#slider-marginy').oninput     = e => { state.config.marginY = +e.target.value; renderPreview(); qs('#val-marginy').textContent = state.config.marginY + 'px'; updateExportURL(); saveState(); };
  qs('#slider-marginx').oninput     = e => { state.config.marginX = +e.target.value; renderPreview(); qs('#val-marginx').textContent = state.config.marginX + 'px'; updateExportURL(); saveState(); };
  qs('#slider-scale').oninput       = e => { state.config.scale = +e.target.value; renderPreview(); qs('#val-scale').textContent = state.config.scale.toFixed(2) + '×'; updateExportURL(); saveState(); };
  qs('#slider-opacity').oninput     = e => { state.config.opacity = +e.target.value; renderPreview(); qs('#val-opacity').textContent = state.config.opacity.toFixed(2); updateExportURL(); saveState(); };
  qs('#slider-maxkeys').oninput     = e => { state.config.maxKeys = +e.target.value; qs('#val-maxkeys').textContent = state.config.maxKeys; updateExportURL(); saveState(); };
  qs('#slider-lifetime').oninput    = e => { state.config.lifetime = +e.target.value; qs('#val-lifetime').textContent = (state.config.lifetime/1000).toFixed(1) + 's'; updateExportURL(); saveState(); };
  qs('#slider-keycapscale').oninput = e => { state.config.keycapScale = +e.target.value; applyOverlayVars(); qs('#val-keycapscale').textContent = state.config.keycapScale.toFixed(2) + '×'; updateExportURL(); saveState(); };
  qs('#slider-captionscale').oninput = e => { state.config.captionScale = +e.target.value; applyOverlayVars(); qs('#val-captionscale').textContent = state.config.captionScale.toFixed(2) + '×'; updateExportURL(); saveState(); };
  qs('#slider-captiongap').oninput   = e => { state.config.captionGap = +e.target.value; applyOverlayVars(); qs('#val-captiongap').textContent = state.config.captionGap + 'px'; saveState(); };

  // pill groups
  qs('#fadeSelect').onchange = e => { state.config.fade = e.target.value; renderAll(); saveState(); demoAnimation(); };
  qs('#slider-fontweight').oninput = e => { state.config.fontWeight = +e.target.value; applyOverlayVars(); qs('#val-fontweight').textContent = e.target.value; saveState(); };
  qsa('#scanlinesPill button').forEach(b => b.onclick = () => { state.config.scanlines = (b.dataset.val === 'on'); renderAll(); saveState(); });
  qsa('#captionPosPill button').forEach(b => b.onclick = () => { state.config.captionPosition = b.dataset.val; renderAll(); seedPreview(); saveState(); });
  qsa('#keycapShapePill button').forEach(b => b.onclick = () => { state.config.keycapShape = b.dataset.val; renderAll(); saveState(); });
  qsa('#captionShapePill button').forEach(b => b.onclick = () => { state.config.captionShape = b.dataset.val; renderAll(); saveState(); });

  // font
  qs('#fontFamily').onchange = e => {
    state.config.fontFamily = e.target.value;
    applyOverlayVars();   // live-update preview keycaps
    saveState();
  };

  // server actions
  qs('#startStopBtn').onclick = async () => {
    if (state.serverRunning) {
      const res = await api('POST', '/api/shutdown');
      if (res === null) {
        toast('Could not stop the server', 'warn');
        return;
      }
      state.serverRunning = false;
      renderAll();
      toast('Streaming server stopped');
    } else {
      if (bridge?.startStreamingServer) {
        try {
          await bridge.startStreamingServer();
          await refreshStatus();
          toast('Streaming server started');
        } catch (_) {
          toast('Could not start the server', 'warn');
        }
      } else {
        toast('Run npm start to begin streaming mode', 'warn');
      }
    }
  };
  qs('#openOverlayBtn').onclick = () => {
    if (bridge?.openExternal) {
      bridge.openExternal(buildURL());
      return;
    }
    window.open(buildURL(), '_blank', 'noopener');
  };
  qs('#debugUpdateBtn').onclick = async () => {
    const res = await api('POST', '/api/_debug-update');
    if (!res) {
      toast('Debug update trigger failed', 'warn');
      return;
    }
  };
  qs('#copyUrlBtn').onclick = () => {
    const url = buildURL();
    navigator.clipboard?.writeText(url).catch(()=>{});
    toast('URL copied to clipboard');
  };
  qs('#recordBtn').onclick = async () => {
    if (state.isRecording) {
      await stopRecording();
    } else {
      await startRecording();
    }
  };
  qs('#saveCfgBtn').onclick = async () => {
    const res = await pushConfig();
    toast(res === null ? 'Saved locally (server offline)' : 'Config saved → config.json', res === null ? 'warn' : 'ok');
  };
  qs('#firstRunBtn').onclick = () => openHelpModal();
  qs('#closeModalBtn').onclick = () => closeHelpModal();
  qs('#modalSetup').onclick = (e) => { if (e.target.id === 'modalSetup') closeHelpModal(); };

  // profile dropdown
  qs('#profileSelect').onchange = (e) => {
    state.activeProfile = e.target.value;
    renderAll(); saveState();
    autoMatchBackground();
  };

  // new profile modal
  qs('#newProfileBtn').onclick = () => {
    qs('#newProfileName').value = '';
    qs('#newProfileExe').value = '';
    qs('#modalNewProfile').classList.add('on');
    setTimeout(() => qs('#newProfileName').focus(), 50);
  };
  qs('#cancelNewProfileBtn').onclick  = () => qs('#modalNewProfile').classList.remove('on');
  qs('#modalNewProfile').onclick = (e) => { if (e.target.id === 'modalNewProfile') e.currentTarget.classList.remove('on'); };
  qs('#confirmNewProfileBtn').onclick = async () => {
    const name = qs('#newProfileName').value.trim();
    const exeRaw = qs('#newProfileExe').value.trim();
    if (!name) { toast('Profile name is required', 'warn'); return; }
    const match = exeRaw ? exeRaw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean) : [];
    const slug  = name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    state.profiles[slug] = { name, match, keys: {} };
    state.activeProfile = slug;
    qs('#modalNewProfile').classList.remove('on');
    renderAll(); saveState();
    await pushProfile(slug);
    autoMatchBackground();
    toast(`Created profile "${name}"`);
  };
  // also submit on Enter in the exe field
  qs('#newProfileExe').onkeydown = (e) => { if (e.key === 'Enter') qs('#confirmNewProfileBtn').click(); };

  // save preset modal
  qs('#presetSaveBtn').onclick = () => {
    qs('#savePresetName').value = '';
    qs('#modalSavePreset').classList.add('on');
    setTimeout(() => qs('#savePresetName').focus(), 50);
  };
  qs('#cancelSavePresetBtn').onclick = () => qs('#modalSavePreset').classList.remove('on');
  qs('#modalSavePreset').onclick = (e) => { if (e.target.id === 'modalSavePreset') e.currentTarget.classList.remove('on'); };
  qs('#confirmSavePresetBtn').onclick = saveNewPreset;
  qs('#savePresetName').onkeydown = (e) => { if (e.key === 'Enter') qs('#confirmSavePresetBtn').click(); };
  qs('#importBtn').onclick = () => qs('#importFile').click();
  qs('#importFile').onchange = (e) => { handleImport(e.target.files[0]); e.target.value = ''; };

  // add-row capture
  qs('#captureBtn').onclick = () => {
    state.capturing = !state.capturing;
    qs('#captureBtn').classList.toggle('active', state.capturing);
    qs('#captureBtn').textContent = state.capturing ? '● listening… press a combo' : '◎ click to capture combo';
  };
  // presets
  qs('#presetLoadBtn').onclick   = loadSelectedPreset;
  qs('#presetDeleteBtn').onclick = deleteSelectedPreset;
  refreshPresets();

  qsa('#recordingSourceKind, #recordingResolution, #recordingFps, #recordingFormat').forEach((el) => {
    el.onchange = (e) => {
      if (state.isRecording) {
        e.target.value = state.recording[e.target.id.replace('recording', '').replace(/^./, (m) => m.toLowerCase())];
        toast('Stop the current recording before changing recording settings', 'warn');
        return;
      }
      const key = e.target.id
        .replace('recording', '')
        .replace(/^./, (m) => m.toLowerCase());
      state.recording[key] = e.target.value;
      renderAll();
      saveState();
    };
  });
  qs('#recordingSourceKind').onchange = async (e) => {
    if (state.isRecording) {
      e.target.value = state.recording.sourceKind;
      toast('Stop the current recording before switching sources', 'warn');
      return;
    }
    state.recording.sourceKind = e.target.value;
    state.recording.sourceId = '';
    state.recording.sourceName = '';
    await loadCaptureSources({ preserveSelection: false });
    renderAll();
    saveState();
    await startRecordingPreview();
  };
  qs('#recordingSourceId').onchange = async (e) => {
    if (state.isRecording) {
      e.target.value = state.recording.sourceId;
      toast('Stop the current recording before switching sources', 'warn');
      return;
    }
    state.recording.sourceId = e.target.value;
    const picked = state.captureSources.find((source) => source.id === state.recording.sourceId);
    state.recording.sourceName = getCaptureSourceLabel(picked);
    saveState();
    await startRecordingPreview();
  };
  qsa('#recordingResolution, #recordingFps').forEach((el) => {
    el.addEventListener('change', () => {
      if (state.isRecording) return;
      if (state.mode === 'recording') {
        startRecordingPreview().catch(() => {});
      }
    });
  });

  document.addEventListener('keydown', (e) => {
    if (!state.capturing) return;
    e.preventDefault();
    const parts = [];
    if (e.ctrlKey) parts.push('ctrl');
    if (e.altKey) parts.push('alt');
    if (e.shiftKey) parts.push('shift');
    const base = e.key.toLowerCase();
    if (['control','alt','shift','meta'].includes(base)) return;
    parts.push(base === ' ' ? 'space' : base);
    const combo = parts.join('+');
    const desc = prompt(`Description for ${combo}:`);
    if (desc) {
      state.profiles[state.activeProfile].keys[combo] = desc;
      saveState(); renderAll();
      pushProfile(state.activeProfile);
      toast(`Added ${combo} → ${desc}`);
    }
    state.capturing = false;
    qs('#captureBtn').classList.remove('active');
    qs('#captureBtn').textContent = '◎ click to capture combo';
  });
}

// ---------- ZBrush .txt import ----------
// Format: [ACTION:NAME,keycode] // HUMAN_KEY
// e.g.  [BRUSH:CLAY,49] // 1
//        [CUSTOMUI,97]   // A

function parseZBrushHotkeys(text) {
  const result = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('//')) continue;

    // extract the [...]  block and the // comment
    const bracketMatch = line.match(/^\[(.+?)\]/);
    const commentMatch = line.match(/\/\/\s*(.+)$/);
    if (!bracketMatch || !commentMatch) continue;

    const inner   = bracketMatch[1];   // e.g. "BRUSH:CLAY,49"
    const keyHint = commentMatch[1].trim(); // e.g. "1"  or  "Popup+S"

    // skip Popup+ combos — can't represent them
    if (keyHint.toLowerCase().startsWith('popup')) continue;

    // map the hint to a canonical key
    const canonical = zbKeyToCanonical(keyHint);
    if (!canonical) continue;

    // build a human description from the action
    const actionPart = inner.split(',')[0];  // e.g. "BRUSH:CLAY"
    const desc = zbActionToDesc(actionPart);
    if (!desc) continue;

    result[canonical] = desc;
  }
  return result;
}

function zbKeyToCanonical(hint) {
  const h = hint.trim();
  // single letter → lowercase
  if (/^[A-Z]$/i.test(h)) return h.toLowerCase();
  // digit
  if (/^[0-9]$/.test(h)) return h;
  // function keys
  if (/^F[0-9]+$/i.test(h)) return h.toLowerCase();
  // named keys
  const map = {
    'space': 'space', 'enter': 'enter', 'esc': 'esc', 'escape': 'esc',
    'del': 'delete', 'delete': 'delete', 'ins': 'insert', 'insert': 'insert',
    'home': 'home', 'end': 'end', 'pgup': 'pageup', 'pgdn': 'pagedown',
    'up': 'up', 'down': 'down', 'left': 'left', 'right': 'right',
    'tab': 'tab', 'backspace': 'backspace',
  };
  return map[h.toLowerCase()] ?? null;
}

function zbActionToDesc(action) {
  // "BRUSH:CLAY"  →  "Clay"
  // "CUSTOMUI"    →  null (not meaningful without more context)
  // "ZPLUGIN:..."  → e.g. "ZPlugin · ..."
  if (!action) return null;
  const parts = action.split(':');
  if (parts.length === 1) {
    // single-word actions like CUSTOMUI aren't descriptive enough on their own
    return null;
  }
  const category = parts[0].trim();
  const name     = parts.slice(1).join(':').trim();
  // title-case the name: "CLAY BUILDUP" → "Clay Buildup"
  const pretty = name.replace(/\b\w+/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase());
  const catMap = {
    'BRUSH':    null,        // just use the name — "Clay", "DamStandard"
    'ZPLUGIN':  'ZPlugin',
    'ZSCRIPT':  'ZScript',
    'TOOL':     'Tool',
    'SUBTOOL':  'Subtool',
    'RENDER':   'Render',
    'MATERIAL': 'Material',
    'TEXTURE':  'Texture',
    'LAYER':    'Layer',
    'ALPHA':    'Alpha',
    'MACRO':    'Macro',
  };
  const prefix = catMap.hasOwnProperty(category) ? catMap[category] : category;
  return prefix ? `${prefix} · ${pretty}` : pretty;
}

function handleImport(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    let imported = {};
    let label = '';

    if (file.name.endsWith('.json')) {
      try {
        const data = JSON.parse(text);
        // accept a bare keys object or a full profile
        imported = data.keys ?? data;
        label = data.name ? `"${data.name}"` : file.name;
      } catch {
        toast('Invalid JSON file', 'warn');
        return;
      }
    } else {
      // assume ZBrush .txt format
      imported = parseZBrushHotkeys(text);
      label = 'ZBrush hotkeys';
    }

    const count = Object.keys(imported).length;
    if (!count) { toast('No importable hotkeys found', 'warn'); return; }

    // merge into active profile
    const profile = state.profiles[state.activeProfile];
    Object.assign(profile.keys, imported);
    saveState();
    renderAll();
    pushProfile(state.activeProfile);
    toast(`Imported ${count} hotkeys from ${label}`);
  };
  reader.readAsText(file);
}

// ---------- duplicate-tab detection ----------
// When launch.bat opens a new tab after a restart, the existing tab
// (which auto-reconnected via the poll) closes the duplicate automatically.
const _editorChannel = new BroadcastChannel('keycap-editor');
let _isPrimary = false;

function _announcePrimary() {
  _isPrimary = true;
  _editorChannel.postMessage({ type: 'im-primary' });
}

function _handleDuplicate() {
  // Try to close; if the browser blocks it, show a clear message instead.
  try { window.close(); } catch (_) {}
  setTimeout(() => {
    if (document.visibilityState !== 'hidden') {
      document.body.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;
          height:100vh;background:#17141a;color:#f0ecf5;
          font-family:'Space Grotesk',system-ui,sans-serif;gap:14px;text-align:center;">
          <div style="font-size:40px;color:#00f0ff;">✓</div>
          <div style="font-size:20px;font-weight:600;">Editor already open</div>
          <div style="color:#7a7488;font-size:14px;">KeyCap is running in another tab — you can close this one.</div>
          <button onclick="window.close()"
            style="margin-top:8px;padding:8px 20px;background:#00f0ff;color:#0a0a0a;
            border:none;font-family:inherit;font-size:14px;font-weight:600;cursor:pointer;">
            Close this tab
          </button>
        </div>`;
    }
  }, 250);
}

_editorChannel.onmessage = (e) => {
  if (e.data.type === 'im-primary' && !_isPrimary) {
    _handleDuplicate();
  }
  if (e.data.type === 'anyone-there' && _isPrimary) {
    _editorChannel.postMessage({ type: 'im-primary' });
  }
};

// Ask if there's already a primary tab running
_editorChannel.postMessage({ type: 'anyone-there' });

// ---------- boot ----------
// UI-only prefs (tab, mode) load instantly from localStorage.
// Config + keymaps always come from the server — it's the source of truth.
loadState();
wire();
if (bridge?.onAppEvent) {
  bridge.onAppEvent(handleAppEvent);
} else {
  connectUpdaterWs();
}

(async () => {
  await loadShellState();
  await loadUpdateStatus();
  await loadRemoteConfig();
  await loadRemoteKeymaps();
  applyOverlayVars();
  setupColorInputs();
  renderAll();
  seedPreview();
  await loadBackgrounds();
  autoMatchBackground();
  await refreshStatus();
  syncModeTabs();
  if (!state.hasChosenMode) {
    qs('#modeChooser').classList.add('on');
  } else {
    await setMode(state.mode, { persist: false, autoStart: state.mode === 'streaming', quietStart: true });
  }
  _announcePrimary();   // tell any future duplicate tabs to close
  setInterval(refreshStatus, 3000);
  setInterval(_announcePrimary, 5000);  // keep announcing so late-arriving tabs close
})();

// Re-position overlay whenever the preview canvas changes size
// (e.g. switching between Edit and Focus preview modes)
new ResizeObserver(() => {
  const live = qs('#liveOverlay');
  if (live) positionOverlay(live);
}).observe(qs('#previewCanvas'));

window.addEventListener('beforeunload', () => {
  stopRecordingPreview();
});

