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
    name: p.name, match: p.match, keys: serializeHotkeyMap(p.keys),
  });
}
async function pushConfig() {
  return await api('PUT', '/api/config', state.config);
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
    state.profiles[p.slug] = normalizeProfile({ name: p.name, match: p.match, keys: p.keys });
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

async function loadThemes() {
  const data = await api('GET', '/api/themes');
  if (data && Array.isArray(data.themes)) {
    state.themes = data.themes;
  }
}

async function loadPacks() {
  const data = await api('GET', '/api/packs');
  if (data && Array.isArray(data.packs)) {
    state.packs = data.packs;
    // Pre-fetch every pack's full detail so theme library cards can render
    // their pack composition without per-card async fetches. Pack manifests
    // are small (mostly schema declarations), so this is cheap at boot.
    state.packDetails = state.packDetails || {};
    await Promise.all(state.packs.map(async (p) => {
      if (state.packDetails[p.slug]) return;
      try {
        const detail = await api('GET', '/api/packs/' + encodeURIComponent(p.slug));
        if (detail) state.packDetails[p.slug] = detail;
      } catch (_) { /* skip — bad pack manifest just won't render its chrome */ }
    }));
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ===== Pack-aware theme creator =============================================

// Map of standard parameter ids → which `<details><summary>` blocks to hide
// inside the creator panels when a pack lists the id in its `hides[]`. The
// existing creator HTML organizes inputs under <details> groups labeled
// "Shape", "Text", "Material", "Effects", "Advanced FX", etc., so hides target
// the section by summary text within the right panel.
//
// `std.<section>.<group>` → { panel: "keycap"|"caption", summaryText: "..." }
const STD_PARAM_HIDES = {
  'std.keycap.fx':       { panel: 'keycap',  summary: 'Advanced FX' },
  'std.keycap.glow':     { panel: 'keycap',  summary: 'Effects' },
  'std.keycap.shadow':   { panel: 'keycap',  summary: 'Effects' },
  'std.keycap.outline':  { panel: 'keycap',  summary: 'Material' },
  'std.keycap.pattern':  { panel: 'keycap',  summary: 'Material' },
  'std.keycap.texture':  { panel: 'keycap',  summary: 'Material' },
  'std.caption.fx':      { panel: 'caption', summary: 'Advanced FX' },
  'std.caption.glow':    { panel: 'caption', summary: 'Effects' },
  'std.caption.shadow':  { panel: 'caption', summary: 'Effects' },
  'std.caption.outline': { panel: 'caption', summary: 'Material' },
  'std.caption.pattern': { panel: 'caption', summary: 'Material' },
};

function findCreatorSections(panel, summaryText) {
  const root = document.querySelector(`[data-creator-panel="${panel}"]`);
  if (!root) return [];
  const matches = [];
  root.querySelectorAll('details > summary').forEach((s) => {
    if (s.textContent.trim() === summaryText) matches.push(s.parentElement);
  });
  return matches;
}

function getActivePackForCreator() {
  const slug = state.themeCreatorBasePack || 'default';
  return (state.packs || []).find((p) => p.slug === slug) || null;
}

async function getActivePackDetail() {
  const slug = state.themeCreatorBasePack || 'default';
  const cached = state.packDetails && state.packDetails[slug];
  if (cached) return cached;
  const pack = await api('GET', '/api/packs/' + encodeURIComponent(slug));
  state.packDetails = state.packDetails || {};
  if (pack) state.packDetails[slug] = pack;
  return pack;
}

/**
 * Hide the standard widgets a pack suppresses via its `hides[]` declaration.
 * Selectors that don't exist in the DOM are skipped — packs can list ids that
 * predate their corresponding sections.
 */
async function applyPackHidesToCreator() {
  // Reset all known sections first so the previous pack's hides don't leak
  // into the new one.
  Object.values(STD_PARAM_HIDES).forEach(({ panel, summary }) => {
    findCreatorSections(panel, summary).forEach((el) => { el.style.display = ''; });
  });
  // Reset finer-grained widget hides (rows inside sections that we tag with
  // data-std-id so packs can target a single field instead of a section).
  qsa('[data-std-hidden="true"]').forEach((el) => {
    el.style.display = '';
    delete el.dataset.stdHidden;
  });
  const pack = await getActivePackDetail();
  applyShapeLock(pack);
  if (!pack || !Array.isArray(pack.hides)) return;
  pack.hides.forEach((id) => {
    const target = STD_PARAM_HIDES[id];
    if (target) {
      findCreatorSections(target.panel, target.summary).forEach((el) => { el.style.display = 'none'; });
      return;
    }
    // Fallback: hide a single widget element tagged data-std-id="<id>".
    qsa(`[data-std-id="${id}"]`).forEach((el) => {
      el.style.display = 'none';
      el.dataset.stdHidden = 'true';
    });
  });
}

/**
 * When the active pack declares `shapeLock`, replace the Shape dropdown's
 * options with a single locked one and disable the control. Restoring the
 * dropdown to its native state happens in the function above when the next
 * pack render resets data-std-hidden, so we cache the original options on
 * the element and restore them when the lock isn't active.
 */
function applyShapeLock(pack) {
  ['keycap', 'caption'].forEach((kind) => {
    const sel = qs(`#creator-${kind}-shape`);
    if (!sel) return;
    if (!sel.dataset.shapeOptionsCache) {
      sel.dataset.shapeOptionsCache = sel.innerHTML;
    }
    const lock = pack && pack.shapeLock;
    // Only the keycap dropdown locks for shape-defining packs. Caption stays
    // user-editable since it lives in the title bar (not the keycap shape).
    if (lock && kind === 'keycap') {
      sel.innerHTML = `<option value="__locked__" selected>${escapeHtml(lock.label || 'Locked')}</option>`;
      sel.disabled = true;
      sel.title = lock.description || '';
    } else {
      sel.innerHTML = sel.dataset.shapeOptionsCache;
      sel.disabled = false;
      sel.title = '';
    }
  });
}

/**
 * Render pack-declared parameters into the existing creator sections (Color,
 * Shape, Effects, etc.) instead of a dedicated tab. Each parameter declares
 * `section: { tab, group }` — the renderer finds the matching <details> by
 * summary text inside the named tab and appends a widget into its grid.
 *
 * Widgets are tagged `.pack-param-widget` so they can be torn down cleanly
 * when the active pack changes (which happens whenever the user opens the
 * theme creator with a different pack).
 */
async function renderPackSettingsPanel() {
  // Tear down any pack widgets left over from a previous render so switching
  // packs doesn't leave stale knobs in the wrong sections.
  qsa('.pack-param-widget').forEach((el) => el.remove());

  const pack = await getActivePackDetail();
  const params = (pack && Array.isArray(pack.parameters)) ? pack.parameters : [];
  if (!params.length) {
    pushResolvedPackToConfig();
    return;
  }
  // Initialize parameter values from defaults if not already set for this pack.
  state.themeCreatorParameterValues = state.themeCreatorParameterValues || {};
  params.forEach((p) => {
    if (state.themeCreatorParameterValues[p.id] === undefined && p.default !== undefined) {
      state.themeCreatorParameterValues[p.id] = deepClonePack(p.default);
    }
  });

  params.forEach((p) => {
    const tab = (p.section && p.section.tab) || 'keycap';
    const group = (p.section && p.section.group) || 'Color';
    const targets = findCreatorSections(tab, group);
    if (!targets.length) return;
    // Append into the first matching <details>'s grid (the basic-mode one).
    const details = targets[0];
    let grid = details.querySelector('.theme-creator-grid');
    if (!grid) {
      grid = document.createElement('div');
      grid.className = 'theme-creator-grid';
      details.appendChild(grid);
    }
    const widget = buildPackParamWidget(p);
    widget.classList.add('pack-param-widget');
    grid.appendChild(widget);
  });

  pushResolvedPackToConfig();
  // Now that pack data + params are loaded, re-run the preview render so it
  // reflects the active pack's composition (the synchronous first render at
  // creator-open time fired before getActivePackDetail resolved).
  applyThemeCreatorPreview({ replayAnimation: true });
}

function deepClonePack(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/**
 * Ensure the editor's #liveOverlay has (or doesn't have) a #live-row-frame
 * sibling depending on whether the active pack uses row-scope composition.
 * Called from addKey on each key insert so frame state stays in sync.
 */
function ensureLiveRowFrame(live, composition) {
  if (!live) return;
  const wantsRow = composition && composition.frameScope === 'row' && composition.frame;
  let rf = live.querySelector(':scope > #live-row-frame');
  if (wantsRow && !rf) {
    rf = document.createElement('div');
    rf.id = 'live-row-frame';
    rf.setAttribute('aria-hidden', 'true');
    live.insertBefore(rf, live.firstChild);
  } else if (!wantsRow && rf) {
    rf.remove();
  }
  if (rf) {
    rf.dataset.mounted = 'true';
    // Clear and rebuild decor so pack changes flow through.
    rf.innerHTML = '';
    const frame = composition.frame;
    if (Array.isArray(frame.decor)) {
      const pack = state.config.resolvedPack;
      frame.decor.forEach((item) => {
        const url = item.asset && pack && pack.id ? `/packs/${pack.id}/assets/${item.asset}` : null;
        const wrap = document.createElement('div');
        wrap.className = 'row-frame-decor';
        const w = Number(item.width) || 32;
        const h = Number(item.height) || w;
        wrap.style.position = 'absolute';
        wrap.style.width = `${w}px`;
        wrap.style.height = `${h}px`;
        if (typeof item.opacity === 'number') wrap.style.opacity = String(item.opacity);
        if (item.zIndex != null) wrap.style.zIndex = String(item.zIndex);
        const dx = Number(item.offsetX) || 0;
        const dy = Number(item.offsetY) || 0;
        const a = item.anchor || 'tl';
        if (a === 'tl') { wrap.style.top = `${dy}px`; wrap.style.left = `${dx}px`; }
        else if (a === 'tr') { wrap.style.top = `${dy}px`; wrap.style.right = `${-dx}px`; }
        else if (a === 'bl') { wrap.style.bottom = `${-dy}px`; wrap.style.left = `${dx}px`; }
        else if (a === 'br') { wrap.style.bottom = `${-dy}px`; wrap.style.right = `${-dx}px`; }
        if (item.rotate) wrap.style.transform = `rotate(${item.rotate}deg)`;
        if (url) {
          const img = document.createElement('img');
          img.src = url;
          img.alt = '';
          wrap.appendChild(img);
        }
        rf.appendChild(wrap);
      });
    }
  }
}

/**
 * Resolve a pack template + saved parameterValues into a fully-resolved pack
 * object suitable for rendering theme card previews. Standalone helper so
 * the theme-library card render doesn't have to depend on creator state.
 */
function resolvePackForCard(packTemplate, parameterValues) {
  const resolved = deepClonePack(packTemplate);
  const params = Array.isArray(resolved.parameters) ? resolved.parameters : [];
  const values = parameterValues || {};
  params.forEach((p) => {
    const v = values[p.id] !== undefined ? values[p.id] : p.default;
    if (v === undefined) return;
    const targets = Array.isArray(p.appliesTo) ? p.appliesTo : (p.appliesTo ? [p.appliesTo] : []);
    targets.forEach((path) => writeAtPath(resolved, path, v));
  });
  return resolved;
}

function buildPackParamWidget(param) {
  const wrap = document.createElement('label');
  wrap.textContent = param.label;
  const value = state.themeCreatorParameterValues[param.id];

  if (param.type === 'color') {
    const input = document.createElement('input');
    input.type = 'color';
    input.value = colorToHex(value || '#000000');
    input.oninput = () => { state.themeCreatorParameterValues[param.id] = input.value; pushResolvedPackToConfig(); };
    wrap.appendChild(input);
  } else if (param.type === 'slider' || param.type === 'number') {
    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'slider';
    input.min = param.min ?? 0;
    input.max = param.max ?? 100;
    input.step = param.step ?? 1;
    input.value = value ?? param.default ?? 0;
    const valSpan = document.createElement('span');
    valSpan.className = 'theme-creator-value';
    valSpan.textContent = String(input.value);
    input.oninput = () => {
      const n = parseFloat(input.value);
      state.themeCreatorParameterValues[param.id] = n;
      valSpan.textContent = String(n);
      pushResolvedPackToConfig();
    };
    wrap.appendChild(input);
    wrap.appendChild(valSpan);
  } else if (param.type === 'toggle') {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!value;
    input.onchange = () => { state.themeCreatorParameterValues[param.id] = input.checked; pushResolvedPackToConfig(); };
    wrap.appendChild(input);
  } else if (param.type === 'text') {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'text-input';
    input.value = value || '';
    input.oninput = () => { state.themeCreatorParameterValues[param.id] = input.value; pushResolvedPackToConfig(); };
    wrap.appendChild(input);
  } else if (param.type === 'select') {
    const sel = document.createElement('select');
    sel.className = 'text-input';
    (param.options || []).forEach((opt) => {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label || opt.value;
      sel.appendChild(o);
    });
    sel.value = value ?? (param.options?.[0]?.value || '');
    sel.onchange = () => { state.themeCreatorParameterValues[param.id] = sel.value; pushResolvedPackToConfig(); };
    wrap.appendChild(sel);
  } else {
    // Fallback: raw JSON text input.
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'text-input';
    input.value = JSON.stringify(value ?? '');
    input.onchange = () => {
      try { state.themeCreatorParameterValues[param.id] = JSON.parse(input.value); pushResolvedPackToConfig(); }
      catch (_) { toast(`Invalid JSON for ${param.label}`, 'warn'); }
    };
    wrap.appendChild(input);
  }
  return wrap;
}

function colorToHex(value) {
  if (typeof value !== 'string') return '#000000';
  const v = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(v)) return '#' + v.slice(1).split('').map((c) => c + c).join('').toLowerCase();
  return '#000000';
}

/**
 * Walk a JSON path like "composition.frame.header.fill.stops[0].color" and
 * write `value` at that location. Creates intermediate objects/arrays as
 * needed. Used by pushResolvedPackToConfig to apply parameter values to a
 * cloned pack template.
 */
function writeAtPath(obj, path, value) {
  const parts = String(path).match(/[^.\[\]]+|\[\d+\]/g) || [];
  let cursor = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const seg = parts[i];
    const isIdx = /^\[\d+\]$/.test(seg);
    const key = isIdx ? Number(seg.slice(1, -1)) : seg;
    if (cursor[key] === undefined || cursor[key] === null) {
      const nextSeg = parts[i + 1];
      cursor[key] = /^\[\d+\]$/.test(nextSeg) ? [] : {};
    }
    cursor = cursor[key];
  }
  const lastSeg = parts[parts.length - 1];
  const lastKey = /^\[\d+\]$/.test(lastSeg) ? Number(lastSeg.slice(1, -1)) : lastSeg;
  cursor[lastKey] = value;
}

/**
 * Take the pack template, apply the user's parameterValues, and push the
 * fully-resolved pack into config.packData so the overlay re-renders live.
 */
async function pushResolvedPackToConfig() {
  const pack = await getActivePackDetail();
  if (!pack) return;
  const resolved = deepClonePack(pack);
  const params = Array.isArray(resolved.parameters) ? resolved.parameters : [];
  const values = state.themeCreatorParameterValues || {};
  params.forEach((p) => {
    if (!(p.id in values)) return;
    const targets = Array.isArray(p.appliesTo) ? p.appliesTo : (p.appliesTo ? [p.appliesTo] : []);
    targets.forEach((path) => writeAtPath(resolved, path, values[p.id]));
  });
  // Apply the parameterized pack to the live overlay via inline packData.
  state.config.pack = resolved.id;
  state.config.packData = resolved;
  scheduleConfigPush();
  // And refresh the in-creator preview so the user sees their changes there too.
  if (state.themeCreatorDraft) applyThemeCreatorPreview();
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
  themeData: null,
  resolvedTheme: ThemeRuntime.resolveTheme(ThemeRuntime.DEFAULT_THEME),
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
  animationSpeed: 1,
  fade: 'glitch',
  showCaptions: true,
  captionPosition: 'above',
  captionGap: 6,
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

const COLLAPSIBLE_GROUP_KEYS = [
  'theme',
  'presets',
  'colors',
  'caption-overrides',
  'typography',
  'layout',
  'behavior',
];

function normalizeCollapsedGroups(groups) {
  const next = {};
  COLLAPSIBLE_GROUP_KEYS.forEach((key) => {
    next[key] = !!groups?.[key];
  });
  return next;
}

const state = {
  config: { ...DEFAULT_CONFIG },
  themes: [],
  packs: [],
  packDetails: {},
  themeCreatorBasePack: null,
  themeCreatorParameterValues: {},
  themeCreatorSection: 'keycap',
  themeCreatorDraft: null,
  themeCreatorEditingSlug: null,
  themeCreatorClipboard: null,
  themeCreatorPreviewTone: 'dark',
  themeCreatorPreviewScenario: 'combo',
  themeCreatorMode: 'basic',
  themeCreatorLinked: false,
  themeCreatorPack: 'clean-education',
  themeCreatorPalette: 'paper-ink',
  themeCreatorIntensity: 'balanced',
  themeCreatorBasicShape: 'rounded',
  themeCreatorBasicMotion: 'marker-wipe',
  colorOverrideBaseThemeSlug: 'keycap',
  configPushTimer: 0,
  previewBg: 'scene',           // 'scene' | 'checker' | '/backgrounds/Foo.png'
  serverRunning: true,
  desktopMode: !!bridge,
  nativeRecorderStatus: { backend: 'offline', ready: false, transport: 'none', sourceCount: 0, lastError: '' },
  lastNativeRecorderError: '',
  mode: 'streaming',
  hasChosenMode: false,
  appVersion: '--',
  devMode: false,
  detectedApp: 'photoshop.exe',
  activeProfile: 'photoshop',
  capturing: false,
  kmDraftCombo: '',
  overlayUrl: 'http://127.0.0.1:8765/',
  collapsedGroups: normalizeCollapsedGroups(),
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
  recordingStartedAt: 0,
  recordingTimerId: 0,
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

Object.values(state.profiles).forEach((profile) => normalizeProfile(profile));

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
      state.collapsedGroups = normalizeCollapsedGroups(s.collapsedGroups);
      const savedThemeSection = s.themeCreatorSection || s.themeBuilderTab;
      state.themeCreatorSection = savedThemeSection === 'caption' ? 'caption' : 'keycap';
      state.themeCreatorPreviewTone = s.themeCreatorPreviewTone === 'light' ? 'light' : 'dark';
      state.themeCreatorPreviewScenario = ['combo', 'single', 'tutorial', 'rapid'].includes(s.themeCreatorPreviewScenario) ? s.themeCreatorPreviewScenario : 'combo';
      state.themeCreatorMode = s.themeCreatorMode === 'advanced' ? 'advanced' : 'basic';
      state.themeCreatorLinked = false;
      state.themeCreatorPack = s.themeCreatorPack || 'clean-education';
      state.themeCreatorPalette = s.themeCreatorPalette || 'paper-ink';
      state.themeCreatorIntensity = 'balanced';
      state.themeCreatorBasicShape = s.themeCreatorBasicShape || 'rounded';
      state.themeCreatorBasicMotion = s.themeCreatorBasicMotion || 'marker-wipe';
      state.colorOverrideBaseThemeSlug = s.colorOverrideBaseThemeSlug || 'keycap';
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
      collapsedGroups: state.collapsedGroups,
      themeCreatorSection: state.themeCreatorSection,
      themeCreatorPreviewTone: state.themeCreatorPreviewTone,
      themeCreatorPreviewScenario: state.themeCreatorPreviewScenario,
      themeCreatorMode: state.themeCreatorMode,
      themeCreatorLinked: state.themeCreatorLinked,
      themeCreatorPack: state.themeCreatorPack,
      themeCreatorPalette: state.themeCreatorPalette,
      themeCreatorBasicShape: state.themeCreatorBasicShape,
      themeCreatorBasicMotion: state.themeCreatorBasicMotion,
      colorOverrideBaseThemeSlug: state.colorOverrideBaseThemeSlug,
      recording:     state.recording,
    }));
  } catch(_) {}
}

// ---------- util ----------
const qs = (sel, root=document) => root.querySelector(sel);
const qsa = (sel, root=document) => Array.from(root.querySelectorAll(sel));

function getThemeEntry(slug = state.config.theme) {
  return state.themes.find((entry) => entry.slug === slug) || null;
}

function getResolvedTheme() {
  return ThemeRuntime.resolveTheme(
    state.config.resolvedTheme
      || state.config.themeData
      || getThemeEntry()?.theme
      || ThemeRuntime.DEFAULT_THEME,
  );
}

function syncResolvedTheme(theme, { selectedSlug = state.config.theme, persistThemeData = !!state.config.themeData } = {}) {
  const resolved = ThemeRuntime.resolveTheme(theme);
  state.config.resolvedTheme = resolved;
  state.config.theme = selectedSlug || null;
  state.config.themeData = persistThemeData ? ThemeRuntime.createEditableTheme(resolved) : null;
  if (selectedSlug) state.colorOverrideBaseThemeSlug = selectedSlug;
}

function scheduleConfigPush() {
  if (state.configPushTimer) clearTimeout(state.configPushTimer);
  state.configPushTimer = setTimeout(async () => {
    state.configPushTimer = 0;
    const res = await pushConfig();
    if (res && typeof res === 'object') Object.assign(state.config, res);
  }, 140);
}

function renderThemeVisuals() {
  applyOverlayVars();
  updatePickerBtn();
  syncQuickThemeSwatches();
  if (typeof syncOverrideSwatches === 'function') syncOverrideSwatches();
  renderPreview();
  renderTester();
}

function mutateTheme(mutator, { push = true, renderMode = 'full' } = {}) {
  const next = ThemeRuntime.createEditableTheme(getResolvedTheme());
  mutator(next);
  syncResolvedTheme(next, { selectedSlug: null, persistThemeData: true });
  applyThemeDefaultsToConfig(next);
  if (renderMode === 'theme') renderThemeVisuals();
  else renderAll();
  saveState();
  if (push) scheduleConfigPush();
}

function defaultSurfaceShadowLayers(section) {
  if (section === 'caption') {
    return [
      { inset: true, x: 0, y: 1, blur: 0, spread: 0, color: 'rgba(255, 255, 255, 0.35)' },
      { inset: true, x: 0, y: -1, blur: 0, spread: 0, color: 'rgba(0, 0, 0, 0.12)' },
    ];
  }
  return [
    { inset: true, x: 0, y: 1, blur: 0, spread: 0, color: 'rgba(255, 255, 255, 0.85)' },
    { inset: true, x: 0, y: -2, blur: 0, spread: 0, color: 'rgba(0, 0, 0, 0.12)' },
  ];
}

function defaultDropShadowLayer(section) {
  return section === 'caption'
    ? { x: 0, y: 3, blur: 6, spread: 0, color: 'rgba(0, 0, 0, 0.22)' }
    : { x: 0, y: 4, blur: 6, spread: 0, color: 'rgba(0, 0, 0, 0.35)' };
}

function defaultDropShadowOpacity(section) {
  return section === 'caption' ? 0.22 : 0.35;
}

function defaultGlowState(section) {
  return section === 'caption'
    ? { enabled: false, color: '#c8c1b5', spread: 12, opacity: 0.18 }
    : { enabled: false, color: '#7a766b', spread: 18, opacity: 0.35 };
}

function clampUnit(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(1, numeric));
}

function getThemeCreatorGlowState(block, section) {
  const defaults = defaultGlowState(section);
  const glow = block?.glow || {};
  return {
    enabled: glow.enabled !== undefined ? !!glow.enabled : defaults.enabled,
    color: glow.color || defaults.color || normalizeHex(block?.outline?.color || ThemeRuntime.getFillRepresentativeColor(block?.fill), '#ffffff'),
    spread: Math.max(0, Number(glow.spread ?? defaults.spread) || 0),
    opacity: clampUnit(glow.opacity ?? defaults.opacity, defaults.opacity),
  };
}

function replaceThemeCreatorEffects(block, removableTypes, nextEffects) {
  const keep = Array.isArray(block.effects)
    ? block.effects.filter((effect) => !removableTypes.includes(effect?.type))
    : [];
  block.effects = [...keep, ...nextEffects];
}

function applyThemeCreatorGlowState(block, section, glowState) {
  const defaults = defaultGlowState(section);
  block.glow = {
    enabled: glowState?.enabled !== undefined ? !!glowState.enabled : defaults.enabled,
    color: glowState?.color || defaults.color,
    spread: Math.max(0, Number(glowState?.spread ?? defaults.spread) || 0),
    opacity: clampUnit(glowState?.opacity ?? defaults.opacity, defaults.opacity),
  };
  replaceThemeCreatorEffects(
    block,
    ['outer-glow'],
    block.glow.enabled && block.glow.opacity > 0
      ? [createEffect('outer-glow', {
        color: block.glow.color,
        opacity: block.glow.opacity,
        spread: block.glow.spread,
      })]
      : [],
  );
}

function getThemeCreatorShadowState(block, section) {
  const layers = Array.isArray(block?.shadow?.layers) ? block.shadow.layers : [];
  const surfaceLayers = layers.filter((layer) => !!layer.inset);
  const dropLayer = layers.find((layer) => !layer.inset) || defaultDropShadowLayer(section);
  const dropOpacity = clampUnit(block?.shadow?.dropOpacity ?? (layers.some((layer) => !layer.inset) ? 1 : 0), 0);
  return {
    surfaceLayers: surfaceLayers.length ? ThemeRuntime.deepClone(surfaceLayers) : defaultSurfaceShadowLayers(section),
    dropLayer: ThemeRuntime.deepClone(dropLayer),
    surfaceOpacity: clampUnit(block?.shadow?.surfaceOpacity ?? block?.opacity ?? 1, 1),
    dropOpacity,
    dropEnabled: block?.shadow?.dropEnabled !== undefined
      ? !!block.shadow.dropEnabled
      : dropOpacity > 0,
  };
}

function applyThemeCreatorShadowState(block, section, shadowState) {
  const nextLayers = [];
  nextLayers.push(...ThemeRuntime.deepClone(
    shadowState.surfaceLayers?.length ? shadowState.surfaceLayers : defaultSurfaceShadowLayers(section),
  ));
  nextLayers.push({
    ...defaultDropShadowLayer(section),
    ...(shadowState.dropLayer || {}),
    inset: false,
  });
  block.opacity = clampUnit(shadowState.surfaceOpacity, 1);
  block.shadow.enabled = true;
  block.shadow.surfaceOpacity = clampUnit(shadowState.surfaceOpacity, 1);
  block.shadow.dropOpacity = clampUnit(shadowState.dropOpacity, 0);
  block.shadow.dropEnabled = !!shadowState.dropEnabled;
  block.shadow.layers = nextLayers;
  block.material = block.material || {};
  block.material.surfaceOpacity = block.shadow.surfaceOpacity;
  replaceThemeCreatorEffects(
    block,
    ['ambient-shadow', 'directional-shadow'],
    block.shadow.dropEnabled && block.shadow.dropOpacity > 0
      ? [createEffect('directional-shadow', {
        color: shadowState.dropLayer?.color || defaultDropShadowLayer(section).color,
        opacity: block.shadow.dropOpacity,
        x: Number(shadowState.dropLayer?.x) || 0,
        y: Number(shadowState.dropLayer?.y) || 0,
        blur: Number(shadowState.dropLayer?.blur) || 0,
        spread: Number(shadowState.dropLayer?.spread) || 0,
      })]
      : [],
  );
}

function getPrimaryOuterShadowLayer(themeSection) {
  const layers = Array.isArray(themeSection?.shadow?.layers) ? themeSection.shadow.layers : [];
  return layers.find((layer) => !layer.inset) || null;
}

function defaultThemeCreatorFxState() {
  return {
    enabled: false,
    preset: 'none',
    intensity: 'medium',
    speed: 1,
    colorMode: 'outline',
    colors: [],
  };
}

function defaultThemeCreatorTextEffectState() {
  return {
    preset: 'none',
    intensity: 0.6,
  };
}

const THEME_CREATOR_TEXT_EFFECT_PRESETS = ['none', 'shadow', 'glow', 'outline', 'chromatic', 'retro'];

function inferThemeCreatorTextEffectFromShadow(textShadow) {
  const raw = String(textShadow || '').trim().toLowerCase();
  if (!raw || raw === 'none') return defaultThemeCreatorTextEffectState();
  if (raw.includes('-2px 0') && raw.includes('2px 0')) return { preset: 'chromatic', intensity: 0.85 };
  if (raw.includes('0 0') && raw.includes('2px 2px 0')) return { preset: 'retro', intensity: 0.75 };
  if (raw.includes('0 0')) return { preset: 'glow', intensity: 0.65 };
  return { preset: 'shadow', intensity: 0.5 };
}

function normalizeThemeCreatorTextEffect(effect, textShadow) {
  const fallback = inferThemeCreatorTextEffectFromShadow(textShadow);
  const next = {
    ...defaultThemeCreatorTextEffectState(),
    ...fallback,
    ...((effect && typeof effect === 'object' && !Array.isArray(effect)) ? effect : {}),
  };
  next.preset = THEME_CREATOR_TEXT_EFFECT_PRESETS.includes(next.preset) ? next.preset : fallback.preset;
  next.intensity = Math.max(0, Math.min(1, Number(next.intensity) || fallback.intensity || 0.6));
  return next;
}

const THEME_CREATOR_MIN_FX_COLORS = 3;
const THEME_CREATOR_MAX_FX_COLORS = 5;

function normalizeThemeCreatorFx(fx) {
  const next = {
    ...defaultThemeCreatorFxState(),
    ...(fx || {}),
  };
  next.preset = ['none', 'neon-pulse', 'rgb-chase', 'rgb-breathe', 'comic-electric', 'triangle-orbit', 'power-charge'].includes(next.preset) ? next.preset : 'none';
  next.intensity = ['low', 'medium', 'high'].includes(next.intensity) ? next.intensity : 'medium';
  next.speed = Math.max(0.4, Math.min(2.4, Number(next.speed) || 1));
  next.colorMode = ['outline', 'palette', 'custom'].includes(next.colorMode) ? next.colorMode : 'outline';
  next.colors = Array.isArray(next.colors)
    ? next.colors.slice(0, THEME_CREATOR_MAX_FX_COLORS).map((color) => normalizeHex(color, '#ffffff'))
    : [];
  while (next.colors.length < THEME_CREATOR_MIN_FX_COLORS) next.colors.push(next.colors[next.colors.length - 1] || '#ffffff');
  next.enabled = next.preset !== 'none' && (fx?.enabled !== undefined ? !!fx.enabled : true);
  if (next.preset === 'none') next.enabled = false;
  return next;
}

function syncThemeCreatorFxSwatches(section, fx, { active } = {}) {
  const colors = Array.isArray(fx?.colors) ? fx.colors : [];
  const visibleCount = Math.max(
    THEME_CREATOR_MIN_FX_COLORS,
    Math.min(THEME_CREATOR_MAX_FX_COLORS, colors.length || THEME_CREATOR_MIN_FX_COLORS),
  );
  const showCustom = active && fx?.colorMode === 'custom';
  const container = qs(`#creator-${section}-fx-colors`);
  if (container) {
    container.hidden = !showCustom;
    container.classList.toggle('is-disabled', !showCustom);
  }
  for (let index = 0; index < THEME_CREATOR_MAX_FX_COLORS; index += 1) {
    const slot = index + 1;
    const swatch = qs(`#creator-${section}-fx-swatch-${slot}`);
    const input = qs(`#creator-${section}-fx-color-${slot}`);
    const color = colors[index] || colors[visibleCount - 1] || '#ffffff';
    if (input) {
      input.value = color;
      input.disabled = !showCustom;
    }
    if (swatch) {
      swatch.hidden = index >= visibleCount;
      swatch.classList.toggle('is-disabled', !showCustom);
      swatch.style.setProperty('--fx-swatch-color', color);
    }
  }
  const addBtn = qs(`#creator-${section}-fx-add`);
  if (addBtn) {
    addBtn.hidden = !showCustom || visibleCount >= THEME_CREATOR_MAX_FX_COLORS;
    addBtn.disabled = !showCustom || visibleCount >= THEME_CREATOR_MAX_FX_COLORS;
  }
}

function shapeSupportsAdvancedFx(shape) {
  return !!ThemeRuntime.isSupportedFxShape(shape || 'rounded');
}

function createFreshThemeDraft(basePackSlug = null) {
  // Seed the draft from the chosen pack's keycapTheme when one's specified
  // (so a new Win95 theme starts with Win95's transparent-keycap styling
  // rather than the default cream-pill look). Fall back to the legacy
  // "keycap" theme when no pack is provided.
  let seed = null;
  if (basePackSlug) {
    const detail = state.packDetails && state.packDetails[basePackSlug];
    if (detail && detail.keycapTheme && Object.keys(detail.keycapTheme).length) {
      seed = detail.keycapTheme;
    }
  }
  if (!seed) {
    seed = state.themes.find((entry) => entry.slug === 'keycap')?.theme || ThemeRuntime.DEFAULT_THEME;
  }
  const draft = ThemeRuntime.createEditableTheme(seed);
  draft.__name = 'Custom';
  return draft;
}

const THEME_CREATOR_PALETTES = {
  'paper-ink': {
    fill: '#f5efe2',
    fillAlt: '#ffffff',
    text: '#1f242b',
    outline: '#a89d86',
    accent: '#2f6fed',
    shadow: '#14243c',
    canvas: '#f5f1e8',
  },
  'studio-slate': {
    fill: '#1e232c',
    fillAlt: '#2b313c',
    text: '#f5f7fb',
    outline: '#5e728e',
    accent: '#7dd3fc',
    shadow: '#05070b',
    canvas: '#11151b',
  },
  'signal-neon': {
    fill: '#121018',
    fillAlt: '#1b1225',
    text: '#f6f7ff',
    outline: '#01d6ff',
    accent: '#ff4fd8',
    shadow: '#06030d',
    canvas: '#0a0810',
  },
  'creator-coral': {
    fill: '#2d1820',
    fillAlt: '#48222c',
    text: '#fff4ef',
    outline: '#ff8266',
    accent: '#ffd166',
    shadow: '#16070d',
    canvas: '#130a0d',
  },
  'hud-cyan': {
    fill: '#0a1720',
    fillAlt: '#102532',
    text: '#d9fbff',
    outline: '#4ef3ff',
    accent: '#83a7ff',
    shadow: '#03070b',
    canvas: '#071017',
  },
  'arcade-pop': {
    fill: '#2d1159',
    fillAlt: '#461c83',
    text: '#fff8d6',
    outline: '#ff6ad5',
    accent: '#2ef7ff',
    shadow: '#150625',
    canvas: '#12051f',
  },
  'chalkboard': {
    fill: '#183028',
    fillAlt: '#1d4236',
    text: '#f7f6f0',
    outline: '#84d1b5',
    accent: '#f8e16b',
    shadow: '#08150f',
    canvas: '#0f1e18',
  },
  'metal-ice': {
    fill: '#bcc6d5',
    fillAlt: '#e9f1fb',
    text: '#132033',
    outline: '#7087a5',
    accent: '#8ef2ff',
    shadow: '#1d2c40',
    canvas: '#dde6f3',
  },
};

const THEME_CREATOR_PACKS = {
  'clean-education': {
    keycapMaterial: 'flat',
    captionMaterial: 'flat',
    pattern: 'none',
    captionPattern: 'none',
    edge: 'flat',
    captionEdge: 'flat',
    adornment: 'underline',
    motion: 'marker-wipe',
    captionPosition: 'below',
    captionShape: 'tab',
    keycapFontSize: 22,
    captionFontSize: 16,
  },
  'tutorial-callout': {
    keycapMaterial: 'plastic',
    captionMaterial: 'glass',
    pattern: 'grid',
    captionPattern: 'none',
    edge: 'rim',
    captionEdge: 'flat',
    adornment: 'side-tabs',
    motion: 'slide',
    captionPosition: 'above',
    captionShape: 'banner',
    keycapFontSize: 22,
    captionFontSize: 15,
  },
  'broadcast-minimal': {
    keycapMaterial: 'glass',
    captionMaterial: 'flat',
    pattern: 'gradient',
    captionPattern: 'none',
    edge: 'rim',
    captionEdge: 'flat',
    adornment: 'chevrons',
    motion: 'split-in',
    captionPosition: 'above',
    captionShape: 'rounded',
    keycapFontSize: 23,
    captionFontSize: 14,
  },
  'neon-esports': {
    keycapMaterial: 'plastic',
    captionMaterial: 'glass',
    pattern: 'scanlines',
    captionPattern: 'grid',
    edge: 'bevel',
    captionEdge: 'rim',
    adornment: 'signal-ticks',
    motion: 'slam',
    captionPosition: 'above',
    captionShape: 'notched-rect',
    keycapFontSize: 24,
    captionFontSize: 14,
  },
  'hud-tech': {
    keycapMaterial: 'glass',
    captionMaterial: 'glass',
    pattern: 'blueprint',
    captionPattern: 'grid',
    edge: 'rim',
    captionEdge: 'rim',
    adornment: 'corner-brackets',
    motion: 'scan-in',
    captionPosition: 'below',
    captionShape: 'brace',
    keycapFontSize: 22,
    captionFontSize: 13,
  },
  'retro-arcade': {
    keycapMaterial: 'pixel',
    captionMaterial: 'pixel',
    pattern: 'dither',
    captionPattern: 'scanlines',
    edge: 'flat',
    captionEdge: 'flat',
    adornment: 'badge-dot',
    motion: 'pixel-pop',
    captionPosition: 'above',
    captionShape: 'square',
    keycapFontSize: 20,
    captionFontSize: 12,
  },
  'premium-mechanical': {
    keycapMaterial: 'mechanical',
    captionMaterial: 'chrome',
    pattern: 'none',
    captionPattern: 'gradient',
    edge: 'bevel',
    captionEdge: 'emboss',
    adornment: 'none',
    motion: 'soften',
    captionPosition: 'above',
    captionShape: 'pill',
    keycapFontSize: 23,
    captionFontSize: 14,
  },
  'chalk-classroom': {
    keycapMaterial: 'chalk',
    captionMaterial: 'paper',
    pattern: 'paper-grain',
    captionPattern: 'paper-grain',
    edge: 'flat',
    captionEdge: 'flat',
    adornment: 'underline',
    motion: 'chalk-write',
    captionPosition: 'below',
    captionShape: 'banner',
    keycapFontSize: 21,
    captionFontSize: 15,
  },
};

function getThemeCreatorIntensityFactor() {
  return 1;
}

function setThemeCreatorMode(mode) {
  state.themeCreatorMode = mode === 'advanced' ? 'advanced' : 'basic';
  const root = qs('#themeCreatorView');
  if (root) {
    root.classList.toggle('mode-basic', state.themeCreatorMode === 'basic');
    root.classList.toggle('mode-advanced', state.themeCreatorMode === 'advanced');
  }
  qsa('#themeCreatorMode button').forEach((button) => {
    button.classList.toggle('on', button.dataset.mode === state.themeCreatorMode);
  });
  scheduleThemeCreatorLayoutSync();
  saveState();
}

const THEME_CREATOR_SCENARIO_HELP = {
  combo: 'Preview a common hotkey stack with one labeled caption and one supporting key.',
  single: 'Preview a lone keycap so silhouette, material, and shadow can stand on their own.',
  tutorial: 'Preview an education-style callout with repeated labels and longer instructional captions.',
  rapid: 'Preview a fast gameplay input burst to judge readability when several keys appear together.',
};
const THEME_CREATOR_CANVAS_HINT = 'Drag canvas to pan and use the mouse wheel to zoom.';
const themeCreatorCanvasView = {
  panX: 0,
  panY: 0,
  zoom: 1,
};

const THEME_CREATOR_FX_HELP = {
  none: 'Animated FX sit on a lightweight SVG layer around the keycap. Leave this off for clean instructional overlays.',
  'neon-pulse': 'A soft neon stroke with a breathing halo. Good for creator overlays that want glow without a frantic loop.',
  'rgb-chase': 'A faster RGB chase that moves around the outline and feels closer to esports hardware lighting.',
  'rgb-breathe': 'A calmer RGB outline with slow color breathing that works better as an always-on stream accent.',
  'comic-electric': 'Jagged electric accents buzz around the outline for a stylized comic-book energy effect.',
  'triangle-orbit': 'Abstract triangle shards orbit the keycap and create a sharper motion-driven silhouette.',
  'power-charge': 'A charged outline builds, pulses, and releases like a powered-up esports HUD element.',
};

function getThemeCreatorFxHelp(fx, shape) {
  if (!shapeSupportsAdvancedFx(shape)) {
    return `Advanced FX is not available for ${String(shape || 'this shape').replace(/-/g, ' ')} yet. Switch shapes or leave FX off for now.`;
  }
  return THEME_CREATOR_FX_HELP[fx?.preset || 'none'] || THEME_CREATOR_FX_HELP.none;
}

function setThemeCreatorPreviewScenario(scenario, { replayAnimation = true, persist = true } = {}) {
  state.themeCreatorPreviewScenario = ['combo', 'single', 'tutorial', 'rapid'].includes(scenario) ? scenario : 'combo';
  qsa('#themeCreatorPreviewScenario button').forEach((button) => {
    button.classList.toggle('on', button.dataset.scenario === state.themeCreatorPreviewScenario);
  });
  const help = qs('#themeCreatorScenarioHelp');
  if (help) help.textContent = `${THEME_CREATOR_SCENARIO_HELP[state.themeCreatorPreviewScenario]} ${THEME_CREATOR_CANVAS_HINT}`;
  if (replayAnimation) applyThemeCreatorPreview({ replayAnimation: true });
  if (persist) saveState();
}

function setThemeCreatorIntensity(intensity, { persist = true } = {}) {
  state.themeCreatorIntensity = 'balanced';
  if (persist) saveState();
}

function createEffect(type, config = {}) {
  return { type, ...config };
}

function buildPackEffects(packKey, palette, section) {
  const factor = getThemeCreatorIntensityFactor();
  const accent = palette.accent;
  const shadow = palette.shadow;
  const outline = palette.outline;
  const isCaption = section === 'caption';
  const effects = [
    createEffect('stroke', { color: outline, width: isCaption ? 1 : 2, opacity: 1 }),
  ];

  if (['premium-mechanical', 'broadcast-minimal', 'tutorial-callout'].includes(packKey)) {
    effects.push(createEffect('reflection', { opacity: 0.14 * factor, angle: 180 }));
  }
  if (['premium-mechanical', 'broadcast-minimal', 'neon-esports'].includes(packKey)) {
    effects.push(createEffect('sheen', { opacity: 0.12 * factor, angle: 120, width: 120 }));
  }
  if (['premium-mechanical', 'tutorial-callout', 'neon-esports'].includes(packKey) && !isCaption) {
    effects.push(createEffect('bevel', { opacity: 0.78, depth: section === 'caption' ? 1 : 2 }));
  }
  if (['neon-esports', 'hud-tech', 'retro-arcade'].includes(packKey)) {
    effects.push(createEffect('outer-glow', { color: accent, opacity: (isCaption ? 0.18 : 0.36) * factor, spread: isCaption ? 12 : 22 }));
  }
  if (['clean-education', 'chalk-classroom'].includes(packKey)) {
    effects.push(createEffect('inner-glow', { color: '#ffffff', opacity: 0.08 * factor, spread: 24 }));
  }
  effects.push(createEffect(isCaption ? 'ambient-shadow' : 'directional-shadow', {
    color: shadow,
    opacity: (isCaption ? 0.12 : 0.22) * factor,
    x: isCaption ? 0 : 0,
    y: isCaption ? 3 : 6,
    blur: isCaption ? 8 : 16,
  }));
  return effects;
}

function buildPackFx(packKey, palette) {
  const defaults = defaultThemeCreatorFxState();
  const colorSet = [palette.outline, palette.accent, ThemeRuntime.mixHex(palette.accent, '#ffffff', 0.28)];
  if (packKey === 'neon-esports') {
    return {
      enabled: true,
      preset: 'power-charge',
      intensity: 'medium',
      speed: 1.05,
      colorMode: 'palette',
      colors: colorSet,
    };
  }
  if (packKey === 'hud-tech') {
    return {
      enabled: true,
      preset: 'triangle-orbit',
      intensity: 'medium',
      speed: 0.92,
      colorMode: 'palette',
      colors: [palette.outline, palette.accent, '#ffffff'],
    };
  }
  if (packKey === 'retro-arcade') {
    return {
      enabled: true,
      preset: 'comic-electric',
      intensity: 'medium',
      speed: 1.08,
      colorMode: 'palette',
      colors: [palette.outline, palette.accent, '#ffffff'],
    };
  }
  return defaults;
}

function applyThemeCreatorStylePack() {
  const pack = THEME_CREATOR_PACKS[state.themeCreatorPack] || THEME_CREATOR_PACKS['clean-education'];
  const palette = THEME_CREATOR_PALETTES[state.themeCreatorPalette] || THEME_CREATOR_PALETTES['paper-ink'];
  const shape = state.themeCreatorBasicShape || 'rounded';
  const motion = state.themeCreatorBasicMotion || pack.motion || 'marker-wipe';
  const factor = getThemeCreatorIntensityFactor();

  state.themeCreatorDraft = ThemeRuntime.createEditableTheme(state.themeCreatorDraft || createFreshThemeDraft());
  const draft = state.themeCreatorDraft;
  draft.defaults = draft.defaults || {};
  draft.defaults.captionPosition = pack.captionPosition || 'above';
  draft.defaults.motion = {
    enter: motion,
    emphasis: state.themeCreatorIntensity === 'bold' ? 'pulse' : 'none',
    exit: motion,
    reduced: ['slam', 'overshoot', 'split-in', 'scan-in', 'glitch-burst', 'crt-smear', 'pixel-pop'].includes(motion) ? 'fade' : motion,
    speed: state.themeCreatorIntensity === 'bold' ? 1.2 : state.themeCreatorIntensity === 'balanced' ? 1 : 0.86,
  };
  draft.defaults.fade = draft.defaults.motion.enter;
  draft.defaults.animationSpeed = draft.defaults.motion.speed;

  const configureSection = (section, options = {}) => {
    const block = draft[section];
    const isCaption = section === 'caption';
    const fillColor = options.fillColor || (isCaption ? palette.fillAlt : palette.fill);
    const outlineColor = options.outlineColor || palette.outline;
    const patternType = options.patternType || 'none';
    const materialPreset = options.materialPreset || (isCaption ? 'flat' : 'mechanical');
    const edgeTreatment = options.edge || 'flat';
    block.textColor = palette.text;
    block.fontSize = options.fontSize || (isCaption ? pack.captionFontSize : pack.keycapFontSize);
    block.letterSpacing = isCaption ? 2.2 : 1.8;
    block.textEffect = defaultThemeCreatorTextEffectState();
    block.textShadow = 'none';
    block.geometry = {
      shape: options.shape || shape,
      cornerRadius: options.shape === 'square' ? 0 : isCaption ? 6 : 12,
      paddingX: isCaption ? 10 : 18,
      paddingY: isCaption ? 4 : 10,
      textAlign: 'center-center',
      edgeTreatment,
    };
    block.material = {
      preset: materialPreset,
      fill: materialPreset === 'glass'
        ? { type: 'linear', angle: 180, stops: [{ color: ThemeRuntime.mixHex(fillColor, '#ffffff', 0.16), position: 0 }, { color: fillColor, position: 60 }, { color: ThemeRuntime.mixHex(fillColor, '#000000', 0.1), position: 100 }] }
        : { type: 'solid', color: fillColor },
      outline: { enabled: true, width: isCaption ? 1 : 2, color: outlineColor },
      surfaceOpacity: materialPreset === 'glass' ? 0.92 : 1,
    };
    block.pattern = {
      type: patternType,
      color: pack.keycapMaterial === 'chalk' || pack.captionMaterial === 'chalk' ? palette.text : palette.accent,
      opacity: isCaption ? 0.12 * factor : 0.18 * factor,
      density: isCaption ? 3 : 4,
      scale: state.themeCreatorIntensity === 'bold' ? 1.2 : 1,
      rotation: patternType === 'stripes' ? 32 : 0,
      gradientTo: palette.fillAlt,
    };
    block.effects = buildPackEffects(state.themeCreatorPack, palette, section);
    block.fx = isCaption || !shapeSupportsAdvancedFx(block.geometry.shape)
      ? defaultThemeCreatorFxState()
      : buildPackFx(state.themeCreatorPack, palette);
    block.adornments = [];
    block.motion = { ...draft.defaults.motion };
    block.fill = ThemeRuntime.deepClone(block.material.fill);
    block.outline = ThemeRuntime.deepClone(block.material.outline);
    block.opacity = block.material.surfaceOpacity;
    block.shape = block.geometry.shape;
    block.cornerRadius = block.geometry.cornerRadius;
    block.paddingX = block.geometry.paddingX;
    block.paddingY = block.geometry.paddingY;
    block.textAlign = block.geometry.textAlign;
    block.texture = {
      type: block.pattern.type,
      color: block.pattern.color,
      opacity: block.pattern.opacity,
      density: block.pattern.density,
      scale: block.pattern.scale,
      rotation: block.pattern.rotation,
      gradientTo: block.pattern.gradientTo,
    };
    block.glow = { enabled: false, color: palette.accent, spread: 0, opacity: 0 };
    block.shadow = { enabled: false, surfaceOpacity: 1, dropOpacity: 0, layers: [] };
  };

  configureSection('keycap', {
    shape,
    materialPreset: pack.keycapMaterial,
    patternType: pack.pattern,
    edge: pack.edge,
    adornment: pack.adornment,
    fillColor: palette.fill,
    outlineColor: palette.outline,
    fontSize: pack.keycapFontSize,
  });
  configureSection('caption', {
    shape: pack.captionShape || shape,
    materialPreset: pack.captionMaterial,
    patternType: pack.captionPattern,
    edge: pack.captionEdge,
    adornment: pack.adornment === 'underline' ? 'underline' : pack.adornment === 'corner-brackets' ? 'corner-brackets' : 'none',
    fillColor: palette.fillAlt,
    outlineColor: ThemeRuntime.mixHex(palette.outline, '#ffffff', 0.18),
    fontSize: pack.captionFontSize,
  });

  syncThemeCreatorForm({ replayAnimation: true });
}

function shadowLayerToPolar(layer) {
  const x = Number(layer?.x) || 0;
  const y = Number(layer?.y) || 0;
  const distance = Math.round(Math.sqrt((x * x) + (y * y)));
  let angle = Math.round((Math.atan2(y, x) * 180) / Math.PI);
  if (!Number.isFinite(angle)) angle = 0;
  if (angle < 0) angle += 360;
  return { angle, distance };
}

function polarToShadowOffset(angle, distance) {
  const radians = ((Number(angle) || 0) * Math.PI) / 180;
  const radius = Math.max(0, Number(distance) || 0);
  return {
    x: Math.round(Math.cos(radians) * radius),
    y: Math.round(Math.sin(radians) * radius),
  };
}

function setThemeAngleDial(section, angle) {
  const dial = qs(`#creator-${section}-shadow-angle-dial`);
  const input = qs(`#creator-${section}-shadow-angle`);
  if (dial) dial.style.setProperty('--dial-angle', `${Number(angle) || 0}deg`);
  if (input) input.value = String(((Number(angle) || 0) + 360) % 360);
}

function applyThemeDefaultsToConfig(theme) {
  const defaults = ThemeRuntime.resolveTheme(theme).defaults || {};
  if (defaults.fontWeight != null) state.config.fontWeight = +defaults.fontWeight;
  if (defaults.fontFamily) state.config.fontFamily = defaults.fontFamily;
  if (defaults.keycapScale != null) state.config.keycapScale = +defaults.keycapScale;
  if (defaults.captionScale != null) state.config.captionScale = +defaults.captionScale;
  if (defaults.captionPosition) state.config.captionPosition = defaults.captionPosition;
  if (defaults.motion?.enter || defaults.fade) state.config.fade = defaults.motion?.enter || defaults.fade;
  if (defaults.animationSpeed != null) state.config.animationSpeed = +defaults.animationSpeed;
}

function getThemeCreatorAdornmentType(block) {
  return 'none';
}

function getThemeCreatorAccentEffectType(block) {
  const effect = (block?.effects || []).find((item) => ['reflection', 'sheen', 'inner-glow', 'halo'].includes(item?.type));
  return effect?.type || 'none';
}

function buildThemeCreatorAdornment(block, section, type) {
  return [];
}

function buildThemeCreatorAccentEffect(block, type) {
  if (!type || type === 'none') return [];
  const accent = block?.glow?.color
    || block?.outline?.color
    || block?.pattern?.color
    || ThemeRuntime.getFillRepresentativeColor(block?.fill);
  if (type === 'reflection') return [createEffect('reflection', { opacity: 0.2, angle: 180 })];
  if (type === 'sheen') return [createEffect('sheen', { opacity: 0.14, angle: 120, width: 120 })];
  if (type === 'inner-glow') return [createEffect('inner-glow', { color: accent, opacity: 0.22, spread: 34 })];
  if (type === 'halo') return [createEffect('halo', { color: accent, opacity: 0.22, spread: 18 })];
  return [];
}

function buildThemeCreatorEdgeEffects(section, edge) {
  if (edge === 'bevel') return [createEffect('bevel', { opacity: section === 'caption' ? 0.5 : 0.72, depth: section === 'caption' ? 1 : 2 })];
  if (edge === 'emboss') return [createEffect('emboss', { opacity: section === 'caption' ? 0.5 : 0.72, depth: section === 'caption' ? 1 : 2 })];
  if (edge === 'rim') return [createEffect('rim-light', { color: '#ffffff', opacity: section === 'caption' ? 0.26 : 0.38, width: section === 'caption' ? 1 : 2 })];
  if (edge === 'inset') return [createEffect('inner-stroke', { color: '#000000', opacity: section === 'caption' ? 0.18 : 0.22, width: 1 })];
  return [];
}

function shapeSupportsRadius(shape) {
  return shape === 'rounded';
}

function shapeSupportsSkew(shape) {
  return ['square', 'rounded'].includes(shape);
}

function patternSupportsRotation(type) {
  return ['scanlines', 'gradient', 'stripes', 'checker', 'grid', 'blueprint'].includes(type);
}

function populateThemeCreatorFontSelects() {
  const source = qs('#fontFamily');
  if (!source) return;
  ['keycap', 'caption'].forEach((section) => {
    const target = qs(`#creator-${section}-font-family`);
    if (!target || target.dataset.populated === 'true') return;
    target.innerHTML = source.innerHTML;
    target.dataset.populated = 'true';
  });
}

function normalizeThemeCreatorCaptionFxPlacement() {
  const captionPanel = qs('.theme-creator-panel[data-creator-panel="caption"] .theme-creator-groups');
  if (!captionPanel) return;
  const leftColumn = qs('.theme-creator-groups-column--left', captionPanel);
  const rightColumn = qs('.theme-creator-groups-column--right', captionPanel);
  if (!leftColumn || !rightColumn) return;

  qsa('[data-caption-fx-misplaced="true"]').forEach((node) => {
    node.hidden = true;
  });
  [
    '#creator-caption-fx-preset-misplaced',
    '#creator-caption-fx-preset-misplaced2',
  ].forEach((selector) => {
    const details = qs(selector)?.closest('details');
    if (details) details.hidden = true;
  });

  const livePreset = qs('#creator-caption-fx-preset');
  const liveBlock = livePreset?.closest('details');
  const captionAnimationBlock = qs('#creator-caption-animation')?.closest('details');
  if (!liveBlock || !captionAnimationBlock) return;
  if (liveBlock.parentElement !== rightColumn) rightColumn.appendChild(liveBlock);
  if (captionAnimationBlock.parentElement !== leftColumn) leftColumn.appendChild(captionAnimationBlock);
}

function normalizeThemeCreatorGroupColumns() {
  qsa('.theme-creator-panel .theme-creator-groups').forEach((groups) => {
    let leftColumn = qs('.theme-creator-groups-column--left', groups);
    let rightColumn = qs('.theme-creator-groups-column--right', groups);
    if (!leftColumn) {
      leftColumn = document.createElement('div');
      leftColumn.className = 'theme-creator-groups-column theme-creator-groups-column--left';
      groups.appendChild(leftColumn);
    }
    if (!rightColumn) {
      rightColumn = document.createElement('div');
      rightColumn.className = 'theme-creator-groups-column theme-creator-groups-column--right';
      groups.appendChild(rightColumn);
    }

    qsa('.theme-creator-group', groups)
      .filter((group) => group.parentElement === groups)
      .forEach((group) => {
        const targetColumn = group.classList.contains('theme-creator-group--right') ? rightColumn : leftColumn;
        if (group.parentElement !== targetColumn) targetColumn.appendChild(group);
      });
  });
}

let themeCreatorLayoutFrame = 0;

function clampThemeCreatorPanelScroll(node) {
  if (!node) return;
  const maxScrollTop = Math.max(0, node.scrollHeight - node.clientHeight);
  if (maxScrollTop <= 1) {
    if (node.scrollTop !== 0) node.scrollTop = 0;
    return;
  }
  if (node.scrollTop > maxScrollTop) node.scrollTop = maxScrollTop;
}

function syncThemeCreatorPanelScrollPositions() {
  qsa('#themeCreatorView .theme-creator-basic-panel, #themeCreatorView .theme-creator-groups-column')
    .forEach((node) => clampThemeCreatorPanelScroll(node));
}

function getThemeCreatorVisibleBottom(node, rootTop) {
  if (!node) return null;
  const styles = window.getComputedStyle(node);
  if (styles.display === 'none' || styles.visibility === 'hidden') return null;
  const rect = node.getBoundingClientRect();
  if (!rect.width && !rect.height) return null;
  return rect.bottom - rootTop;
}

function syncThemeCreatorLayoutMetrics() {
  const modal = qs('#themeModal');
  const root = qs('#themeCreatorView');
  if (!modal || !root) return;
  if (modal.classList.contains('hidden') || root.classList.contains('hidden')) return;
  if (!modal.classList.contains('theme-modal--creator')) return;

  const rootRect = root.getBoundingClientRect();
  if (!rootRect.width || !rootRect.height) return;

  const header = qs('.theme-modal-header', modal);
  const leftHead = qs('.theme-creator-rail-head--left', root);
  const rightHead = qs('.theme-creator-rail-head--right', root);
  const bottomStack = qs('.theme-creator-bottom-stack', root);

  const headerBottom = header
    ? header.getBoundingClientRect().bottom - rootRect.top
    : 88;
  const headBottoms = [leftHead, rightHead]
    .map((node) => getThemeCreatorVisibleBottom(node, rootRect.top))
    .filter((value) => value != null);

  const railTop = Math.max(96, Math.round(headerBottom + 18));
  const panelTop = Math.max(
    railTop + 16,
    Math.round((headBottoms.length ? Math.max(...headBottoms) : railTop) + 12),
  );
  const bottomStackHeight = bottomStack
    ? Math.max(0, Math.round(bottomStack.getBoundingClientRect().height))
    : 128;

  root.style.setProperty('--creator-rail-top', `${railTop}px`);
  root.style.setProperty('--creator-panel-top', `${panelTop}px`);
  root.style.setProperty('--creator-bottom-stack-height', `${bottomStackHeight}px`);
  root.style.setProperty('--creator-rail-bottom', `${bottomStackHeight + 24}px`);
  syncThemeCreatorPanelScrollPositions();
}

function scheduleThemeCreatorLayoutSync() {
  if (themeCreatorLayoutFrame) cancelAnimationFrame(themeCreatorLayoutFrame);
  themeCreatorLayoutFrame = requestAnimationFrame(() => {
    themeCreatorLayoutFrame = 0;
    syncThemeCreatorLayoutMetrics();
  });
}

function wireThemeCreatorGroupToggles() {
  qsa('#themeCreatorView .theme-creator-group').forEach((group) => {
    if (group.dataset.layoutSyncWired === 'true') return;
    group.dataset.layoutSyncWired = 'true';
    group.addEventListener('toggle', () => scheduleThemeCreatorLayoutSync());
  });
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function applyThemeCreatorCanvasView() {
  const world = qs('#themeCreatorWorld');
  if (!world) return;
  world.style.setProperty('--pan-x', `${themeCreatorCanvasView.panX}px`);
  world.style.setProperty('--pan-y', `${themeCreatorCanvasView.panY}px`);
  world.style.setProperty('--canvas-zoom', String(themeCreatorCanvasView.zoom));
}

function resetThemeCreatorCanvasView() {
  themeCreatorCanvasView.panX = 0;
  themeCreatorCanvasView.panY = 0;
  themeCreatorCanvasView.zoom = 1;
  applyThemeCreatorCanvasView();
}

function wireThemeCreatorCanvas() {
  const stage = qs('#themeCreatorStage');
  if (!stage || stage.dataset.canvasWired === 'true') return;
  stage.dataset.canvasWired = 'true';
  let drag = null;

  const finishDrag = (event) => {
    if (!drag) return;
    drag = null;
    stage.classList.remove('dragging');
    if (event?.pointerId != null && stage.hasPointerCapture(event.pointerId)) {
      stage.releasePointerCapture(event.pointerId);
    }
  };

  stage.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    if (event.target.closest('.theme-creator-preview-toggle')) return;
    drag = {
      x: event.clientX,
      y: event.clientY,
      panX: themeCreatorCanvasView.panX,
      panY: themeCreatorCanvasView.panY,
    };
    stage.classList.add('dragging');
    stage.setPointerCapture(event.pointerId);
  });

  stage.addEventListener('pointermove', (event) => {
    if (!drag) return;
    themeCreatorCanvasView.panX = clamp(drag.panX + (event.clientX - drag.x), -700, 700);
    themeCreatorCanvasView.panY = clamp(drag.panY + (event.clientY - drag.y), -480, 480);
    applyThemeCreatorCanvasView();
  });

  stage.addEventListener('pointerup', finishDrag);
  stage.addEventListener('pointercancel', finishDrag);
  stage.addEventListener('lostpointercapture', () => finishDrag());

  stage.addEventListener('wheel', (event) => {
    if (event.target.closest('.theme-creator-preview-toggle')) return;
    event.preventDefault();
    themeCreatorCanvasView.zoom = clamp(
      Number((themeCreatorCanvasView.zoom + (event.deltaY < 0 ? 0.08 : -0.08)).toFixed(2)),
      0.5,
      2.0,
    );
    applyThemeCreatorCanvasView();
  }, { passive: false });

  stage.addEventListener('dblclick', (event) => {
    if (event.target.closest('.theme-creator-preview-toggle')) return;
    resetThemeCreatorCanvasView();
  });
}

function setThemeCreatorSection(section) {
  state.themeCreatorSection = section === 'caption' ? 'caption' : 'keycap';
  qsa('#themeCreatorTabs button').forEach((button) => {
    button.classList.toggle('on', button.dataset.section === state.themeCreatorSection);
  });
  qsa('.theme-creator-panel').forEach((panel) => {
    panel.classList.toggle('on', panel.dataset.creatorPanel === state.themeCreatorSection);
  });
  scheduleThemeCreatorLayoutSync();
  saveState();
}

function setThemeCreatorPreviewTone(tone) {
  state.themeCreatorPreviewTone = tone === 'light' ? 'light' : 'dark';
  const stage = qs('.theme-creator-preview-stage');
  if (stage) {
    stage.classList.toggle('light', state.themeCreatorPreviewTone === 'light');
    stage.classList.toggle('dark', state.themeCreatorPreviewTone !== 'light');
  }
  qsa('#themeCreatorPreviewTone button').forEach((button) => {
    button.classList.toggle('on', button.dataset.tone === state.themeCreatorPreviewTone);
  });
  saveState();
}

function buildThemeCreatorPreviewMarkup(theme, pack) {
  const below = (theme.defaults?.captionPosition ?? 'above') === 'below';
  const composition = pack && pack.composition;
  const cardMode = composition && composition.mode === 'card' && composition.frame;

  // Each preview key takes a label + optional caption. The renderer chooses
  // markup based on whether the active pack composes them into a card.
  const renderKey = (caption, keycap, annotated) => {
    if (cardMode) {
      // .key class lets compiled pack CSS (`.key > .pack-card`) match.
      // Caption sits inside the header strip; keycap fills the body.
      return `
        <div class="key-cap key${annotated ? ' annotated' : ''}">
          <div class="pack-card">
            ${caption ? `<div class="pack-card-header"><div class="key-caption">${caption}</div></div>` : ''}
            <div class="pack-card-body"><div class="keycap-el">${keycap}</div></div>
          </div>
        </div>
      `;
    }
    // Separate mode (the existing flat layout).
    const flat = below
      ? `<div class="keycap-el">${keycap}</div>${caption ? `<div class="key-caption">${caption}</div>` : ''}`
      : `${caption ? `<div class="key-caption">${caption}</div>` : ''}<div class="keycap-el">${keycap}</div>`;
    return `<div class="key-cap${annotated ? ' annotated' : ''}">${flat}</div>`;
  };

  let keys;
  if (state.themeCreatorPreviewScenario === 'single') {
    keys = [renderKey(null, 'B', false)];
  } else if (state.themeCreatorPreviewScenario === 'tutorial') {
    keys = [
      renderKey('Open Search', 'CTRL + K', true),
      renderKey('Duplicate Layer', 'CTRL + J', true),
    ];
  } else if (state.themeCreatorPreviewScenario === 'rapid') {
    keys = [
      renderKey('Dash', 'SHIFT', true),
      renderKey(null, 'A', false),
      renderKey(null, 'S', false),
      renderKey(null, 'D', false),
    ];
  } else {
    keys = [
      renderKey('Save', 'CTRL + S', true),
      renderKey(null, 'B', false),
    ];
  }
  return keys.join('');
}

function replayThemeCreatorAnimation(theme) {
  const preview = qs('#themeCreatorPreview');
  if (!preview) return;
  const fade = theme?.defaults?.motion?.enter || theme?.defaults?.fade || 'glitch';
  const speed = Math.max(0.2, Number(theme?.defaults?.motion?.speed ?? theme?.defaults?.animationSpeed) || 1);
  preview.style.setProperty('--anim-speed-multiplier', (1 / speed).toFixed(3));
  preview.classList.remove(
    'anim-glitch', 'anim-fade', 'anim-slide', 'anim-pop', 'anim-snap', 'anim-rise',
    'anim-marker-wipe', 'anim-chalk-write', 'anim-soften', 'anim-slam', 'anim-overshoot',
    'anim-split-in', 'anim-scan-in', 'anim-flash-cut', 'anim-glitch-burst', 'anim-pixel-pop', 'anim-crt-smear',
    'anim-win95'
  );
  void preview.offsetWidth;
  preview.classList.add(`anim-${fade}`);
}

function applyThemeCreatorPreview({ replayAnimation = false } = {}) {
  const theme = ThemeRuntime.resolveTheme(state.themeCreatorDraft || getResolvedTheme());
  const preview = qs('#themeCreatorPreview');
  const styleEl = qs('#themeCreatorCss');
  const packStyleEl = qs('#themeCreatorPackCss');
  // Resolve the active pack, applying any in-flight parameter values so the
  // preview matches what the user is shaping in real time.
  const packSlug = state.themeCreatorBasePack || 'default';
  const packTemplate = (state.packDetails && state.packDetails[packSlug]) || null;
  const resolvedPack = packTemplate ? resolveCreatorPackWithValues(packTemplate) : null;
  const composition = resolvedPack && resolvedPack.composition;
  const cardMode = composition && composition.mode === 'card';
  const rowScope = composition && composition.frameScope === 'row' && composition.frame;

  if (preview) {
    // Layout key forces a markup rebuild whenever the visual structure
    // changes (caption position, scenario, or pack composition mode).
    const layoutKey = `${theme.defaults?.captionPosition ?? 'above'}|${state.themeCreatorPreviewScenario}|${packSlug}|${cardMode ? 'card' : 'separate'}|${rowScope ? 'row' : 'norow'}`;
    if (preview.dataset.previewLayout !== layoutKey || !preview.children.length) {
      let markup = buildThemeCreatorPreviewMarkup(theme, resolvedPack);
      // Row-scope packs need an absolutely-positioned frame sibling that
      // sizes to the keys row. We mount #themeCreatorRowFrame inside the
      // preview overlay alongside the keys.
      if (rowScope) markup = `<div id="themeCreatorRowFrame" aria-hidden="true"></div>${markup}`;
      preview.innerHTML = markup;
      preview.dataset.previewLayout = layoutKey;
      // After DOM is built, populate per-card title-bar buttons + decor
      // using the same renderer the live overlay uses.
      hydrateCreatorPreviewPackChrome(preview, resolvedPack);
      replayAnimation = true;
    } else {
      // No structural change — just re-hydrate buttons/decor in case the
      // pack params changed (e.g. user tweaked a button color).
      hydrateCreatorPreviewPackChrome(preview, resolvedPack);
    }
  }
  ThemeRuntime.applyThemeCss(
    styleEl,
    theme,
    { keycap: '#themeCreatorPreview .keycap-el', caption: '#themeCreatorPreview .key-caption' },
  );
  // Pack CSS scoped to the preview so it doesn't bleed onto any other .key
  // elements that might exist on the editor page (e.g. #liveOverlay).
  if (packStyleEl) {
    if (resolvedPack && composition) {
      ThemeRuntime.applyPackCss(packStyleEl, resolvedPack, {
        scope: '#themeCreatorPreview',
        rowFrameSelector: '#themeCreatorRowFrame',
        skipFonts: true,
      });
    } else {
      packStyleEl.textContent = '';
    }
  }
  setThemeCreatorPreviewTone(state.themeCreatorPreviewTone);
  if (replayAnimation || preview && !preview.dataset.previewPrimed) {
    replayThemeCreatorAnimation(theme);
    if (preview) preview.dataset.previewPrimed = 'true';
  }
}

/**
 * Take a pack template and apply the user's currently-set parameter values
 * (from the live editor draft) so the creator preview shows the in-progress
 * customization, not just the pack's defaults.
 */
function resolveCreatorPackWithValues(packTemplate) {
  const resolved = deepClonePack(packTemplate);
  const params = Array.isArray(resolved.parameters) ? resolved.parameters : [];
  const values = state.themeCreatorParameterValues || {};
  params.forEach((p) => {
    const v = values[p.id] !== undefined ? values[p.id] : p.default;
    if (v === undefined) return;
    const targets = Array.isArray(p.appliesTo) ? p.appliesTo : (p.appliesTo ? [p.appliesTo] : []);
    targets.forEach((path) => writeAtPath(resolved, path, v));
  });
  return resolved;
}

/**
 * Walk each .key card in the preview and fill in title-bar buttons + per-card
 * decor matching the active pack's frame.header.buttons / frame.decor lists.
 * Idempotent — clears prior pack-chrome elements before re-rendering.
 */
function hydrateCreatorPreviewPackChrome(preview, pack) {
  if (!preview) return;
  // Clear any existing pack-chrome we previously injected.
  preview.querySelectorAll('.pack-card-buttons, .pack-card-decor').forEach((el) => el.remove());
  preview.querySelectorAll('#themeCreatorRowFrame .row-frame-decor').forEach((el) => el.remove());
  if (!pack || !pack.composition) return;
  const composition = pack.composition;
  const frame = composition.frame;
  if (!frame) return;

  // Per-key card: hydrate each .pack-card with the buttons + decor.
  if (composition.mode === 'card' && composition.frameScope !== 'row') {
    preview.querySelectorAll('.pack-card').forEach((card) => {
      const header = card.querySelector('.pack-card-header');
      if (header && Array.isArray(frame.header?.buttons) && frame.header.buttons.length) {
        const buttons = document.createElement('div');
        buttons.className = 'pack-card-buttons';
        frame.header.buttons.forEach((btn) => {
          const b = document.createElement('span');
          b.className = `pack-card-btn pack-card-btn--${btn.type || 'btn'}`;
          if (btn.icon && typeof ThemeRuntime !== 'undefined') {
            // Reuse the runtime's icon renderer for visual parity with the
            // live overlay. The function isn't exported, so inline a tiny
            // duplicate covering Win95's icons.
            b.innerHTML = creatorPreviewButtonIcon(btn.icon, btn.color || 'currentColor');
          } else if (btn.iconSvg) {
            b.innerHTML = btn.iconSvg;
          } else if (btn.glyph) {
            b.textContent = btn.glyph;
          }
          if (btn.background) b.style.background = btn.background;
          if (btn.color) b.style.color = btn.color;
          if (btn.bevel === 'out') {
            b.style.borderTop = '1px solid #ffffff';
            b.style.borderLeft = '1px solid #ffffff';
            b.style.borderRight = '1px solid #000000';
            b.style.borderBottom = '1px solid #000000';
            b.style.boxShadow = 'inset 1px 1px 0 #dfdfdf, inset -1px -1px 0 #808080';
          } else if (btn.border) {
            b.style.border = btn.border;
          }
          buttons.appendChild(b);
        });
        header.appendChild(buttons);
      }
    });
  }

  // Row scope: render decor inside the dedicated row-frame element.
  if (composition.frameScope === 'row') {
    const rowFrame = preview.querySelector('#themeCreatorRowFrame');
    if (rowFrame && Array.isArray(frame.decor)) {
      frame.decor.forEach((item) => {
        const url = item.asset && pack.id ? `/packs/${pack.id}/assets/${item.asset}` : null;
        const wrap = document.createElement('div');
        wrap.className = 'row-frame-decor';
        const w = Number(item.width) || 32;
        const h = Number(item.height) || w;
        wrap.style.position = 'absolute';
        wrap.style.width = `${w}px`;
        wrap.style.height = `${h}px`;
        if (typeof item.opacity === 'number') wrap.style.opacity = String(item.opacity);
        if (item.zIndex != null) wrap.style.zIndex = String(item.zIndex);
        // Inline the same anchor positioning logic the live overlay uses.
        const dx = Number(item.offsetX) || 0;
        const dy = Number(item.offsetY) || 0;
        const a = item.anchor || 'tl';
        if (a === 'tl') { wrap.style.top = `${dy}px`; wrap.style.left = `${dx}px`; }
        else if (a === 'tr') { wrap.style.top = `${dy}px`; wrap.style.right = `${-dx}px`; }
        else if (a === 'bl') { wrap.style.bottom = `${-dy}px`; wrap.style.left = `${dx}px`; }
        else if (a === 'br') { wrap.style.bottom = `${-dy}px`; wrap.style.right = `${-dx}px`; }
        if (item.rotate) wrap.style.transform = `rotate(${item.rotate}deg)`;
        if (url) {
          const img = document.createElement('img');
          img.src = url;
          img.alt = '';
          img.style.width = '100%';
          img.style.height = '100%';
          img.style.display = 'block';
          img.style.objectFit = 'contain';
          wrap.appendChild(img);
        }
        rowFrame.appendChild(wrap);
      });
    }
  }
}

// Subset of the runtime's icon set covering the flagship packs. Kept inline
// so the editor doesn't have to reach into a non-public runtime API.
function creatorPreviewButtonIcon(name, color) {
  const ink = color || 'currentColor';
  const wrap = (paths) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8" width="8" height="8" style="display:block;">${paths}</svg>`;
  switch (String(name)) {
    case 'minimize': return wrap(`<rect x="1" y="6" width="6" height="1" fill="${ink}"/>`);
    case 'maximize': return wrap(`<path d="M1 1h6v1H1zM1 1v6h1V2zM6 2v5h1V2zM2 6h5v1H2z" fill="${ink}"/>`);
    case 'restore':  return wrap(`<path d="M2 1h5v1H2zM2 1v3h1V2zM6 2v3h1V2zM2 4h5v1H2zM1 3h1v4h4v1H1z" fill="${ink}"/>`);
    case 'close':    return wrap(`<path d="M1 1h1v1H1zM2 2h1v1H2zM3 3h2v1H3zM5 2h1v1H5zM6 1h1v1H6zM5 5h1v1H5zM6 6h1v1H6zM3 4h2v1H3zM2 5h1v1H2zM1 6h1v1H1z" fill="${ink}"/>`);
    case 'help':     return wrap(`<path d="M3 1h2v1H3zM2 2h1v1H2zM5 2h1v1H5zM5 3h1v1H5zM4 4h1v1H4zM3 5h1v1H3zM3 6h1v1H3z" fill="${ink}"/>`);
    default: return '';
  }
}

function updateThemeCreatorSectionFx(section, mutator) {
  updateThemeCreatorDraft(section, (block) => {
    block.fx = normalizeThemeCreatorFx(block.fx);
    mutator(block.fx, block);
    block.fx = normalizeThemeCreatorFx(block.fx);
  });
}

function updateThemeCreatorKeycapFx(mutator) {
  updateThemeCreatorSectionFx('keycap', mutator);
}

function syncThemeCreatorForm({ replayAnimation = false } = {}) {
  const theme = ThemeRuntime.resolveTheme(state.themeCreatorDraft || getResolvedTheme());
  const themeDefaults = theme.defaults || {};
  ['keycap', 'caption'].forEach((section) => {
    const block = theme[section];
    const glowState = getThemeCreatorGlowState(block, section);
    const shadowState = getThemeCreatorShadowState(block, section);
    const shadow = shadowState.dropLayer;
    const polarShadow = shadowLayerToPolar(shadow);
    const glowToggle = qs(`#creator-${section}-glow-toggle`);
    const shadowToggle = qs(`#creator-${section}-shadow-toggle`);
    qs(`#creator-${section}-shape`).value = block.shape || 'rounded';
    qs(`#creator-${section}-radius`).value = Number(block.cornerRadius ?? 0);
    qs(`#creator-${section}-radius-val`).textContent = `${Number(block.cornerRadius ?? 0)}px`;
    qs(`#creator-${section}-skew`).value = Number(block.skewX ?? block.geometry?.skewX ?? 0);
    qs(`#creator-${section}-skew-val`).textContent = `${Number(block.skewX ?? block.geometry?.skewX ?? 0)}deg`;
    qs(`#creator-${section}-fill`).value = normalizeHex(ThemeRuntime.getFillRepresentativeColor(block.fill));
    qs(`#creator-${section}-text`).value = normalizeHex(block.textColor || '#000000');
    qs(`#creator-${section}-outline-width`).value = Number(block.outline?.width ?? 0);
    qs(`#creator-${section}-outline-width-val`).textContent = `${Number(block.outline?.width ?? 0)}px`;
    qs(`#creator-${section}-size-x`).value = Number(block.paddingX ?? (section === 'keycap' ? 16 : 8));
    qs(`#creator-${section}-size-x-val`).textContent = `${Number(block.paddingX ?? (section === 'keycap' ? 16 : 8))}px`;
    qs(`#creator-${section}-size-y`).value = Number(block.paddingY ?? (section === 'keycap' ? 8 : 2));
    qs(`#creator-${section}-size-y-val`).textContent = `${Number(block.paddingY ?? (section === 'keycap' ? 8 : 2))}px`;
    qs(`#creator-${section}-outline-color`).value = normalizeHex(block.outline?.color || '#000000');
      qs(`#creator-${section}-text-size`).value = Number(block.fontSize ?? (section === 'keycap' ? 22 : 16));
      qs(`#creator-${section}-text-size-val`).textContent = `${Number(block.fontSize ?? (section === 'keycap' ? 22 : 16))}px`;
      qs(`#creator-${section}-text-weight`).value = Number(themeDefaults.fontWeight ?? 700);
      qs(`#creator-${section}-text-weight-val`).textContent = `${Number(themeDefaults.fontWeight ?? 700)}`;
      qs(`#creator-${section}-font-family`).value = themeDefaults.fontFamily || state.config.fontFamily || "'Menlo', 'Consolas', monospace";
      const textEffect = normalizeThemeCreatorTextEffect(block.textEffect, block.textShadow);
      qs(`#creator-${section}-text-effect`).value = textEffect.preset;
      qs(`#creator-${section}-text-effect-intensity`).value = Number((textEffect.intensity ?? 0.6).toFixed(2));
      qs(`#creator-${section}-text-effect-intensity-val`).textContent = `${Math.round((textEffect.intensity ?? 0.6) * 100)}%`;
      qs(`#creator-${section}-text-effect-intensity`).disabled = textEffect.preset === 'none';
      const anchorValue = block.textAlign || 'center-center';
      qs(`#creator-${section}-text-align`).value = anchorValue.includes('-') ? anchorValue : 'center-center';
    qs(`#creator-${section}-material`).value = block.material?.preset || (section === 'keycap' ? 'mechanical' : 'flat');
    qs(`#creator-${section}-edge`).value = block.geometry?.edgeTreatment || 'flat';
    qs(`#creator-${section}-texture-type`).value = block.texture?.type || 'none';
    qs(`#creator-${section}-texture-color`).value = normalizeHex(block.texture?.color || '#000000');
    qs(`#creator-${section}-texture-opacity`).value = Number(block.texture?.opacity ?? 0);
    qs(`#creator-${section}-pattern-scale`).value = Number(block.pattern?.scale ?? 1);
    qs(`#creator-${section}-pattern-scale-val`).textContent = `${Number(block.pattern?.scale ?? 1).toFixed(1)}x`;
    qs(`#creator-${section}-pattern-rotation`).value = Number(block.pattern?.rotation ?? 0);
    qs(`#creator-${section}-pattern-rotation-val`).textContent = `${Number(block.pattern?.rotation ?? 0)}deg`;
    qs(`#creator-${section}-adornment`).value = getThemeCreatorAdornmentType(block);
    qs(`#creator-${section}-surface-opacity`).value = clampUnit(shadowState.surfaceOpacity, 1);
    qs(`#creator-${section}-surface-opacity-val`).textContent = clampUnit(shadowState.surfaceOpacity, 1).toFixed(2);
    qs(`#creator-${section}-glow-color`).value = normalizeHex(glowState.color || '#000000');
    qs(`#creator-${section}-glow-spread`).value = glowState.spread;
    qs(`#creator-${section}-glow-spread-val`).textContent = `${glowState.spread}px`;
    qs(`#creator-${section}-glow-opacity`).value = glowState.opacity;
    qs(`#creator-${section}-glow-opacity-val`).textContent = glowState.opacity.toFixed(2);
    setThemeAngleDial(section, polarShadow.angle);
    qs(`#creator-${section}-shadow-distance`).value = Number(polarShadow.distance ?? 0);
    qs(`#creator-${section}-shadow-distance-val`).textContent = `${Number(polarShadow.distance ?? 0)}px`;
    qs(`#creator-${section}-shadow-blur`).value = Number(shadow.blur ?? 0);
    qs(`#creator-${section}-shadow-blur-val`).textContent = `${Number(shadow.blur ?? 0)}px`;
    qs(`#creator-${section}-shadow-color`).value = normalizeHex(shadow.color || '#000000');
    qs(`#creator-${section}-shadow-opacity`).value = clampUnit(shadowState.dropOpacity, 0);
    qs(`#creator-${section}-shadow-opacity-val`).textContent = clampUnit(shadowState.dropOpacity, 0).toFixed(2);
    if (glowToggle) {
      glowToggle.classList.toggle('on', glowState.enabled);
      glowToggle.textContent = glowState.enabled ? 'Glow On' : 'Glow Off';
      glowToggle.setAttribute('aria-pressed', glowState.enabled ? 'true' : 'false');
    }
    if (shadowToggle) {
      shadowToggle.classList.toggle('on', shadowState.dropEnabled);
      shadowToggle.textContent = shadowState.dropEnabled ? 'Drop Shadow On' : 'Drop Shadow Off';
      shadowToggle.setAttribute('aria-pressed', shadowState.dropEnabled ? 'true' : 'false');
    }
    const glowInputs = [
      qs(`#creator-${section}-glow-color`),
      qs(`#creator-${section}-glow-spread`),
      qs(`#creator-${section}-glow-opacity`),
    ];
    glowInputs.forEach((input) => {
      if (input) input.disabled = !glowState.enabled;
    });
    const shadowInputs = [
      qs(`#creator-${section}-shadow-angle`),
      qs(`#creator-${section}-shadow-distance`),
      qs(`#creator-${section}-shadow-blur`),
      qs(`#creator-${section}-shadow-opacity`),
      qs(`#creator-${section}-shadow-color`),
    ];
    shadowInputs.forEach((input) => {
      if (input) input.disabled = !shadowState.dropEnabled;
    });
    const shadowDial = qs(`#creator-${section}-shadow-angle-dial`);
    if (shadowDial) shadowDial.classList.toggle('is-disabled', !shadowState.dropEnabled);
    const radiusInput = qs(`#creator-${section}-radius`);
    if (radiusInput) radiusInput.disabled = !shapeSupportsRadius(block.shape || block.geometry?.shape);
    const skewInput = qs(`#creator-${section}-skew`);
    if (skewInput) skewInput.disabled = !shapeSupportsSkew(block.shape || block.geometry?.shape);
    const rotationInput = qs(`#creator-${section}-pattern-rotation`);
    if (rotationInput) rotationInput.disabled = !patternSupportsRotation(block.texture?.type || block.pattern?.type || 'none');
    qs(`#creator-${section}-effect-accent`).value = getThemeCreatorAccentEffectType(block);
    qs(`#creator-${section}-animation`).value = block.motion?.enter || themeDefaults.motion?.enter || themeDefaults.fade || 'glitch';
    qs(`#creator-${section}-speed`).value = Number(themeDefaults.animationSpeed ?? 1);
    qs(`#creator-${section}-speed-val`).textContent = `${Number(themeDefaults.animationSpeed ?? 1).toFixed(1)}×`;
  });
  const setValue = (selector, value) => {
    const node = qs(selector);
    if (node) node.value = value;
  };
  const setText = (selector, value) => {
    const node = qs(selector);
    if (node) node.textContent = value;
  };
  ['keycap', 'caption'].forEach((section) => {
    const sectionFx = normalizeThemeCreatorFx(theme[section]?.fx);
    const sectionShape = theme[section]?.shape || theme[section]?.geometry?.shape || 'rounded';
    const supported = shapeSupportsAdvancedFx(sectionShape);
    const active = supported && sectionFx.preset !== 'none';
    setValue(`#creator-${section}-fx-preset`, sectionFx.preset);
    setValue(`#creator-${section}-fx-intensity`, sectionFx.intensity);
    setValue(`#creator-${section}-fx-speed`, sectionFx.speed);
    setText(`#creator-${section}-fx-speed-val`, `${Number(sectionFx.speed).toFixed(1)}×`);
    setValue(`#creator-${section}-fx-color-mode`, sectionFx.colorMode);
    [`#creator-${section}-fx-intensity`, `#creator-${section}-fx-speed`, `#creator-${section}-fx-color-mode`].forEach((selector) => {
      const node = qs(selector);
      if (node) node.disabled = !active;
    });
    syncThemeCreatorFxSwatches(section, sectionFx, { active });
    if (section === 'keycap') {
      setValue('#themeCreatorBasicFxPreset', sectionFx.preset);
      setValue('#themeCreatorBasicFxIntensity', sectionFx.intensity);
      setValue('#themeCreatorBasicFxSpeed', sectionFx.speed);
      setText('#themeCreatorBasicFxSpeedVal', `${Number(sectionFx.speed).toFixed(1)}×`);
      ['#themeCreatorBasicFxIntensity', '#themeCreatorBasicFxSpeed'].forEach((selector) => {
        const node = qs(selector);
        if (node) node.disabled = !active;
      });
    }
  });
  const fxHelp = qs('#themeCreatorBasicFxHelp');
  if (fxHelp) {
    const keycapFx = normalizeThemeCreatorFx(theme.keycap?.fx);
    const keycapShape = theme.keycap?.shape || theme.keycap?.geometry?.shape || 'rounded';
    fxHelp.textContent = getThemeCreatorFxHelp(keycapFx, keycapShape);
    fxHelp.classList.toggle('is-disabled', !shapeSupportsAdvancedFx(keycapShape));
  }
  const linked = qs('#themeCreatorLinked');
  if (linked) linked.checked = !!state.themeCreatorLinked;
  const pack = qs('#themeCreatorPack');
  if (pack) pack.value = state.themeCreatorPack;
  const palette = qs('#themeCreatorPalette');
  if (palette) palette.value = state.themeCreatorPalette;
  const basicShape = qs('#themeCreatorBasicShape');
  if (basicShape) basicShape.value = state.themeCreatorBasicShape;
  const basicMotion = qs('#themeCreatorBasicMotion');
  if (basicMotion) basicMotion.value = state.themeCreatorBasicMotion;
  const pasteBtn = qs('#themeCreatorPasteBtn');
  if (pasteBtn) pasteBtn.disabled = !state.themeCreatorClipboard;
  setThemeCreatorSection(state.themeCreatorSection);
  setThemeCreatorMode(state.themeCreatorMode);
  setThemeCreatorPreviewScenario(state.themeCreatorPreviewScenario, { replayAnimation: false, persist: false });
  setThemeCreatorIntensity(state.themeCreatorIntensity, { persist: false });
  applyThemeCreatorPreview({ replayAnimation });
}

function updateThemeCreatorDraft(section, mutator, { replayAnimation = false } = {}) {
  const next = ThemeRuntime.createEditableTheme(state.themeCreatorDraft || getResolvedTheme());
  mutator(next[section], next);
  if (state.themeCreatorLinked) {
    const otherSection = section === 'caption' ? 'keycap' : 'caption';
    next[otherSection] = ThemeRuntime.deepClone(next[section]);
  }
  state.themeCreatorDraft = next;
  syncThemeCreatorForm({ replayAnimation });
}

function updateThemeCreatorDraftLight(section, mutator, { replayAnimation = false } = {}) {
  const next = ThemeRuntime.createEditableTheme(state.themeCreatorDraft || getResolvedTheme());
  mutator(next[section], next);
  if (state.themeCreatorLinked) {
    const otherSection = section === 'caption' ? 'keycap' : 'caption';
    next[otherSection] = ThemeRuntime.deepClone(next[section]);
  }
  state.themeCreatorDraft = next;
  applyThemeCreatorPreview({ replayAnimation });
}

function showThemeLibraryView() {
  qs('#themeModal').classList.remove('theme-modal--creator');
  qs('#themeModalTitle').textContent = 'Theme Library';
  qs('#themeModalBody').classList.remove('hidden');
  qs('#themeCreatorView').classList.add('hidden');
  qs('#themeModalNewBtn').classList.remove('hidden');
  qs('#themeModalBackBtn').classList.add('hidden');
  qs('#themeModalBackBtn').textContent = 'Save Theme';
}

function getUniqueThemeCopyName(baseName) {
  const seed = `${baseName || 'Theme'} Copy`.trim();
  const used = new Set((state.themes || []).map((entry) => String(entry?.name || '').trim().toLowerCase()));
  let candidate = seed;
  let suffix = 2;
  while (used.has(candidate.toLowerCase())) {
    candidate = `${seed} ${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function getUniqueThemeCopySlug(baseName) {
  const seed = slugifyName(baseName) || 'theme-copy';
  const used = new Set((state.themes || []).map((entry) => String(entry?.slug || '').trim().toLowerCase()));
  let candidate = seed;
  let suffix = 2;
  while (used.has(candidate.toLowerCase())) {
    candidate = `${seed}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

async function duplicateThemeEntry(entry) {
  if (!entry?.theme) {
    toast('Theme copy failed', 'warn');
    return;
  }
  const name = getUniqueThemeCopyName(getThemeDisplayName(entry));
  const slug = getUniqueThemeCopySlug(name);
  const payload = ThemeRuntime.serializeTheme(entry.theme);
  payload.__name = name;
  const res = await api('PUT', '/api/themes/' + encodeURIComponent(slug), {
    name,
    theme: payload,
  });
  if (!res) {
    toast('Theme copy failed', 'warn');
    return;
  }
  await loadThemes();
  renderAll();
  openThemeModal();
  toast(`Created copy "${name}"`);
}

async function renameThemeEntry(entry) {
  if (!entry?.theme || entry.canRename === false) return;
  const currentName = getThemeDisplayName(entry);
  const name = prompt('Rename theme:', currentName);
  if (name == null) return;
  const nextName = name.trim();
  if (!nextName) {
    toast('Theme name is required', 'warn');
    return;
  }
  const payload = ThemeRuntime.serializeTheme(entry.theme);
  payload.__name = nextName;
  const res = await api('PUT', '/api/themes/' + encodeURIComponent(entry.slug), {
    name: nextName,
    theme: payload,
  });
  if (!res) {
    toast('Rename failed', 'warn');
    return;
  }
  await loadThemes();
  renderAll();
  openThemeModal();
  toast(`Renamed theme to "${nextName}"`);
}

async function openThemeCreatorView(entry = null, options = {}) {
  const isEditing = !!entry;
  state.themeCreatorEditingSlug = isEditing ? entry.slug : null;
  // basePack precedence: explicit option (from pack picker) > existing entry's
  // basePack > current config pack > 'default'. New themes inherit from the
  // pack the user chose; edits keep the theme's existing pack binding.
  state.themeCreatorBasePack = options.basePack
    || (entry && entry.basePack)
    || (isEditing ? 'default' : (state.config.pack || 'default'));
  state.themeCreatorParameterValues = (isEditing && entry?.theme?.__parameterValues)
    ? deepClonePack(entry.theme.__parameterValues)
    : {};
  // Pre-fetch the active pack so the draft seed and the parameter form both
  // have its data ready before the creator becomes visible.
  await getActivePackDetail();
  state.themeCreatorDraft = isEditing
    ? ThemeRuntime.createEditableTheme(entry.theme)
    : createFreshThemeDraft(state.themeCreatorBasePack);
  const nameInput = qs('#themeCreatorName');
  if (nameInput) nameInput.value = state.themeCreatorDraft.__name || '';
  qs('#themeModal').classList.add('theme-modal--creator');
  qs('#themeModalTitle').textContent = isEditing ? 'Edit Theme' : 'Theme Creator';
  qs('#themeModalBody').classList.add('hidden');
  qs('#themeCreatorView').classList.remove('hidden');
  qs('#themeModalNewBtn').classList.add('hidden');
  qs('#themeModalBackBtn').classList.remove('hidden');
  qs('#themeModalBackBtn').textContent = isEditing ? 'Save Changes' : 'Save Theme';
  resetThemeCreatorCanvasView();
  setThemeCreatorMode(state.themeCreatorMode);
  setThemeCreatorPreviewScenario(state.themeCreatorPreviewScenario, { replayAnimation: false, persist: false });
  setThemeCreatorIntensity(state.themeCreatorIntensity, { persist: false });
  syncThemeCreatorForm();
  applyPackHidesToCreator();   // hide std widgets the active pack suppresses
  renderPackSettingsPanel();   // render pack-specific params (if any)
  scheduleThemeCreatorLayoutSync();
  setTimeout(() => {
    scheduleThemeCreatorLayoutSync();
    nameInput?.focus();
  }, 0);
}

/**
 * Pack picker shown before the theme creator opens for a NEW theme. Lets the
 * user choose which pack the theme belongs to (Default / Win95 / Neo-Tokyo /
 * Magic Forest). Editing an existing theme skips this and uses entry.basePack.
 */
function openCreateThemePackPicker() {
  const modal = qs('#themeModal');
  const body  = qs('#themeModalBody');
  const titleEl = qs('#themeModalTitle');
  // Hide the existing modal action buttons during pick
  qs('#themeModalNewBtn').classList.add('hidden');
  qs('#themeModalBackBtn').classList.add('hidden');
  modal.classList.remove('hidden');
  modal.classList.remove('theme-modal--creator');
  titleEl.textContent = 'New Theme — Choose Style Pack';
  body.classList.remove('hidden');
  body.innerHTML = '';

  const grid = document.createElement('div');
  grid.className = 'theme-grid pack-picker-grid';
  const packs = Array.isArray(state.packs) ? state.packs : [];
  // Show only published packs in the create-theme flow. Unpublished packs
  // (work-in-progress) still resolve from saved themes that reference them
  // — they just don't appear here as starting options.
  const visible = packs.filter((p) => p.published !== false);
  // Default first, then flagship packs alphabetically.
  const ordered = [
    ...visible.filter((p) => p.slug === 'default'),
    ...visible.filter((p) => p.slug !== 'default').sort((a, b) => a.name.localeCompare(b.name)),
  ];
  ordered.forEach((p) => {
    const card = buildPackPickerCard(p);
    card.onclick = () => {
      qs('#themeModalNewBtn').classList.add('hidden');
      openThemeCreatorView(null, { basePack: p.slug });
    };
    grid.appendChild(card);
  });
  body.appendChild(grid);
}

/**
 * Build a pack picker card with a live mini-preview. Each card renders a
 * sample key using the pack's actual composition + keycapTheme, so users
 * see what their theme will look like before clicking.
 */
function buildPackPickerCard(p) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'theme-card pack-picker-card';
  const previewId = `pack-picker-${p.slug}`;
  card.setAttribute('data-pack-preview', previewId);

  // Resolve the pack template to its default state (no user values yet —
  // this is just a preview of the pack's out-of-the-box look).
  const detail = (state.packDetails || {})[p.slug] || null;
  const resolved = detail ? resolvePackForCard(detail, {}) : null;
  const keycapTheme = (resolved && resolved.keycapTheme && Object.keys(resolved.keycapTheme).length)
    ? ThemeRuntime.resolveTheme(resolved.keycapTheme)
    : ThemeRuntime.DEFAULT_THEME;
  const composition = resolved && resolved.composition;
  const cardMode = composition && composition.mode === 'card';
  const rowScope = composition && composition.frameScope === 'row' && composition.frame;

  // Theme CSS for the keycap + caption, scoped to this card's preview.
  const themeStyle = document.createElement('style');
  ThemeRuntime.applyThemeCss(themeStyle, keycapTheme, {
    keycap: `[data-pack-preview="${previewId}"] .pack-picker-keycap`,
    caption: `[data-pack-preview="${previewId}"] .pack-picker-caption`,
  });
  card.appendChild(themeStyle);

  // Pack CSS scoped to this card if the pack has composition.
  if (resolved && composition) {
    const packStyle = document.createElement('style');
    ThemeRuntime.applyPackCss(packStyle, resolved, {
      scope: `[data-pack-preview="${previewId}"]`,
      rowFrameSelector: '.pack-picker-row-frame',
      skipFonts: true,
    });
    card.appendChild(packStyle);
  }

  // Demo content: a single labeled key. Card mode wraps in pack-card markup
  // so the same Win95 / Neo-Tokyo / Magic Forest chrome shows in the picker.
  const captionLabel = 'SAVE';
  const keycapLabel = 'CTRL+S';
  const keyMarkup = cardMode
    ? `<div class="pack-picker-key key">
         <div class="pack-card">
           <div class="pack-card-header"><div class="pack-picker-caption">${captionLabel}</div></div>
           <div class="pack-card-body"><div class="pack-picker-keycap">${keycapLabel}</div></div>
         </div>
       </div>`
    : `<div class="pack-picker-key${rowScope ? ' key' : ''}">
         <div class="pack-picker-caption">${captionLabel}</div>
         <div class="pack-picker-keycap">${keycapLabel}</div>
       </div>`;
  const rowFrameMarkup = rowScope ? '<div class="pack-picker-row-frame" aria-hidden="true"></div>' : '';

  const innerWrap = document.createElement('div');
  innerWrap.className = 'pack-picker-card-inner';
  innerWrap.innerHTML = `
    <div class="pack-picker-stage${rowScope ? ' has-row-frame' : ''}">
      ${rowFrameMarkup}
      ${keyMarkup}
    </div>
    <div class="pack-picker-label">${escapeHtml(p.name)}</div>
  `;
  card.appendChild(innerWrap);

  // Hydrate per-card title-bar buttons / decor (same renderer as theme cards).
  if (resolved && cardMode) {
    hydrateCreatorPreviewPackChrome(innerWrap, resolved);
  }
  return card;
}

function closeThemeCreatorView() {
  state.themeCreatorDraft = null;
  state.themeCreatorEditingSlug = null;
  showThemeLibraryView();
}

function closeThemeModal() {
  closeThemeCreatorView();
  qs('#themeModal').classList.add('hidden');
}

function syncCollapsibleGroups() {
  qsa('.panel-left .group[data-group]').forEach((group) => {
    const key = group.dataset.group;
    const toggle = qs('.group-toggle', group);
    const body = qs('.group-body', group);
    if (!key || !toggle || !body) return;

    const collapsed = !!state.collapsedGroups[key];
    group.classList.toggle('collapsed', collapsed);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    body.setAttribute('aria-hidden', String(collapsed));
    body.inert = collapsed;
  });
}

function toggleCollapsibleGroup(key) {
  if (!COLLAPSIBLE_GROUP_KEYS.includes(key)) return;
  state.collapsedGroups[key] = !state.collapsedGroups[key];
  saveState();
  syncCollapsibleGroups();
}

function wireCollapsibleGroups() {
  qsa('.panel-left .group[data-group]').forEach((group) => {
    const toggle = qs('.group-toggle', group);
    const key = group.dataset.group;
    if (!toggle || !key || toggle.dataset.wired === 'true') return;
    toggle.dataset.wired = 'true';
    toggle.onclick = () => toggleCollapsibleGroup(key);
  });
}

function toast(msg, kind='ok') {
  const t = qs('#toast');
  t.innerHTML = `<span class="ico">${kind === 'ok' ? '✓' : '⚠'}</span>${msg}`;
  t.classList.add('on');
  clearTimeout(t._tid);
  t._tid = setTimeout(() => t.classList.remove('on'), 1800);
}

function formatElapsedTime(ms) {
  const totalSeconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function syncRecordingDuration() {
  const el = qs('#recordingDuration');
  if (!el) return;
  if (state.isRecording && state.recordingStartedAt) {
    el.textContent = `Recording duration ${formatElapsedTime(Date.now() - state.recordingStartedAt)}`;
    el.classList.add('live');
    return;
  }
  el.textContent = '';
  el.classList.remove('live');
}

function ensureRecordingTimer() {
  if (state.isRecording && state.recordingStartedAt) {
    syncRecordingDuration();
    if (!state.recordingTimerId) {
      state.recordingTimerId = setInterval(syncRecordingDuration, 250);
    }
    return;
  }
  if (state.recordingTimerId) {
    clearInterval(state.recordingTimerId);
    state.recordingTimerId = 0;
  }
  syncRecordingDuration();
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
  const source = getSelectedRecordingSource();
  const constraint = {
    chromeMediaSource: 'desktop',
    chromeMediaSourceId: source?.previewSourceId || state.recording.sourceId,
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
  // The Rust sidecar uses Windows Graphics Capture, which includes the
  // transparent overlay window in the captured display output. Require a
  // ready sidecar with at least one display source; fall back to MediaRecorder
  // when the binary is missing or the mock backend is running.
  const status = state.nativeRecorderStatus;
  if (!status || !status.ready) return false;
  if (status.backend !== 'rust-sidecar') return false;
  const source = getSelectedRecordingSource();
  if (!source || source.kind !== 'display') return false;
  return (state.recording.format || 'mp4') === 'mp4';
}

function buildNativeRecordingRequest() {
  const source = getSelectedRecordingSource();
  if (!source || source.kind !== 'display') return null;
  const resolved = resolveRecordingResolution();
  const captureWidth = Number(source.captureWidth) || Number(source.width) || null;
  const captureHeight = Number(source.captureHeight) || Number(source.height) || null;
  return {
    sourceKind: 'display',
    sourceId: source.nativeSourceId || source.id,
    width: resolved.width || captureWidth,
    height: resolved.height || captureHeight,
    fps: Number(state.recording.fps) || 60,
    container: 'mp4',
    encoder: state.recording.encoder || 'auto',
    bitrateKbps: Number(state.recording.bitrateKbps) || 0,
    outputDir: state.recording.outputDir || '',
  };
}

function syncModeTabs() {
  qsa('#modeTabs .mode-tab').forEach((btn) => {
    btn.classList.toggle('on', btn.dataset.mode === state.mode);
  });
  document.body.dataset.mode = state.mode;
}

async function setMode(mode, { persist = true, autoStart = false, quietStart = false } = {}) {
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
  if (sourceKind) {
    const nativeOnlyDisplay = canUseNativeRecording();
    const windowOption = sourceKind.querySelector('option[value="window"]');
    if (windowOption) {
      windowOption.disabled = nativeOnlyDisplay;
      windowOption.textContent = nativeOnlyDisplay ? 'Window (coming soon)' : 'Window';
    }
    if (nativeOnlyDisplay && state.recording.sourceKind === 'window' && !state.isRecording) {
      state.recording.sourceKind = 'display';
      state.recording.sourceId = '';
      state.recording.sourceName = '';
    }
    sourceKind.value = state.recording.sourceKind;
  }
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
        if (state.isRecording && !state.recordingStartedAt) {
          state.recordingStartedAt = Date.now();
        } else if (!state.isRecording) {
          state.recordingStartedAt = 0;
        }
        ensureRecordingTimer();
      }
      if (msg.lastError && msg.lastError !== state.lastNativeRecorderError) {
        state.lastNativeRecorderError = msg.lastError;
        if (!/native recorder (shutdown|exited)/i.test(msg.lastError)) {
          toast(`Recorder error: ${msg.lastError}`, 'warn');
        }
      } else if (!msg.lastError) {
        state.lastNativeRecorderError = '';
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
  state.recordingStartedAt = 0;
  ensureRecordingTimer();
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
      state.recordingStartedAt = Date.now();
      ensureRecordingTimer();
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
    state.recordingStartedAt = Date.now();
    ensureRecordingTimer();
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
    state.recordingStartedAt = 0;
    ensureRecordingTimer();
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
      state.recordingStartedAt = 0;
      ensureRecordingTimer();
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
  const rgb = String(hex || '').trim().match(/^rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (rgb) {
    const parts = rgb.slice(1, 4).map((part) => Math.max(0, Math.min(255, Number(part) || 0)));
    return `#${parts.map((part) => part.toString(16).padStart(2, '0')).join('')}`;
  }
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
  const theme = getResolvedTheme();
  const keycapFill = ThemeRuntime.getFillRepresentativeColor(theme.keycap?.fill) || '#e8e6df';
  const keycapBorder = theme.keycap?.outline?.color || keycapFill;
  const keycapGlow = theme.keycap?.glow?.color
    || getPrimaryOuterShadowLayer(theme.keycap)?.color
    || keycapBorder;
  r.setProperty('--ov-bg',           keycapFill);
  r.setProperty('--ov-border',       keycapBorder);
  r.setProperty('--ov-glow',         keycapGlow);
  r.setProperty('--ov-bg-a',         `rgba(${hexRgb(normalizeHex(keycapFill))}, 0.55)`);
  r.setProperty('--ov-border-a',     `rgba(${hexRgb(normalizeHex(keycapBorder))}, 0.7)`);
  r.setProperty('--ov-font-weight',  state.config.fontWeight  ?? 700);
  r.setProperty('--ov-font-family',  state.config.fontFamily  ?? "'Menlo', 'Consolas', monospace");
  r.setProperty('--ov-keycap-scale', state.config.keycapScale ?? 1);
  r.setProperty('--ov-caption-scale',state.config.captionScale ?? 1);
  r.setProperty('--ov-caption-gap',  (state.config.captionGap ?? 6) + 'px');
  const speed = Math.max(0.2, Number(state.config.animationSpeed) || 1);
  r.setProperty('--anim-speed-multiplier', (1 / speed).toFixed(3));

  // Optional per-element color overrides — empty = inherit theme/style defaults
  const anim = state.config.fade ?? 'glitch';
  document.body.classList.remove(
    'anim-glitch', 'anim-fade', 'anim-slide', 'anim-pop', 'anim-snap', 'anim-rise',
    'anim-marker-wipe', 'anim-chalk-write', 'anim-soften', 'anim-slam', 'anim-overshoot',
    'anim-split-in', 'anim-scan-in', 'anim-flash-cut', 'anim-glitch-burst', 'anim-pixel-pop', 'anim-crt-smear',
    'anim-win95'
  );
  document.body.classList.add(`anim-${anim}`);

  let styleEl = document.getElementById('editor-theme-css');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'editor-theme-css';
    document.head.appendChild(styleEl);
  }
  ThemeRuntime.applyThemeCss(styleEl, theme, { keycap: '#liveOverlay .keycap-el', caption: '#liveOverlay .key-caption' });

  // Apply pack CSS scoped to the editor's live overlay so saved pack-bound
  // themes render their composition (Win95 windows, Neo-Tokyo neon panels,
  // Magic Forest row frame) instead of just bare keycaps.
  let packStyleEl = document.getElementById('editor-pack-css');
  if (!packStyleEl) {
    packStyleEl = document.createElement('style');
    packStyleEl.id = 'editor-pack-css';
    document.head.appendChild(packStyleEl);
  }
  const livePack = state.config.resolvedPack || null;
  if (livePack && livePack.composition) {
    ThemeRuntime.applyPackCss(packStyleEl, livePack, {
      scope: '#liveOverlay',
      rowFrameSelector: '#live-row-frame',
      skipFonts: true,
    });
  } else {
    packStyleEl.textContent = '';
  }
}

// ---------- build URL ----------
// Config is now saved server-side and pushed live over WebSocket,
// so the OBS Browser Source URL is always just the base — no params needed.
function buildURL() {
  return state.overlayUrl || 'http://127.0.0.1:8765/';
}

// ---------- render: themes ----------
const THEME_CORE_LIBRARY = [
  { key: 'keycap', slug: 'keycap', label: 'Keycap' },
  { key: 'vhs', slug: 'vhs', label: 'VHS' },
  { key: 'modern', slug: 'studio', label: 'Modern' },
  { key: 'sleek', slug: 'ghost', label: 'Y2k' },
  { key: 'cyberspace', slug: 'cyberspace', label: 'Cyberspace' },
];

function getThemeDisplayName(entry) {
  if (!entry) return 'Custom';
  const alias = THEME_CORE_LIBRARY.find((item) => item.slug === entry.slug);
  return entry.name || alias?.label || 'Custom';
}

function getThemeLibraryGroups() {
  // Themes group by their basePack first — that's the primary organizing
  // axis now. Within a pack, built-ins come before customs.
  const themes = Array.isArray(state.themes) ? state.themes : [];
  const packs = Array.isArray(state.packs) ? state.packs : [];

  const themesByPack = new Map();
  themes.forEach((entry) => {
    const slug = entry.basePack || 'default';
    if (!themesByPack.has(slug)) themesByPack.set(slug, []);
    themesByPack.get(slug).push(entry);
  });

  const sortEntries = (entries) => {
    const builtins = entries.filter((e) => e.source === 'builtin');
    const customs = entries.filter((e) => e.source === 'custom').sort((a, b) =>
      getThemeDisplayName(a).localeCompare(getThemeDisplayName(b)));
    // Preserve existing core-library ordering for the default pack's built-ins.
    const coreOrder = THEME_CORE_LIBRARY.map((it) => it.slug);
    const orderedBuiltins = [
      ...coreOrder.map((slug) => builtins.find((b) => b.slug === slug)).filter(Boolean),
      ...builtins.filter((b) => !coreOrder.includes(b.slug))
        .sort((a, b) => getThemeDisplayName(a).localeCompare(getThemeDisplayName(b))),
    ];
    return [...orderedBuiltins, ...customs];
  };

  // Default pack first, then alphabetical packs. Each pack with at least one
  // theme becomes a group label "<Pack Name> themes".
  const groups = [];
  const seen = new Set();
  const pushPackGroup = (slug) => {
    if (seen.has(slug)) return;
    seen.add(slug);
    const list = themesByPack.get(slug);
    if (!list || !list.length) return;
    const meta = packs.find((p) => p.slug === slug);
    const label = meta ? `${meta.name} themes` : `Themes — ${slug}`;
    groups.push([label, sortEntries(list)]);
  };

  pushPackGroup('default');
  packs.filter((p) => p.slug !== 'default')
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((p) => pushPackGroup(p.slug));
  // Catch-all for any theme whose basePack isn't in the pack list (e.g. user
  // installed a theme whose pack was uninstalled).
  themesByPack.forEach((entries, slug) => pushPackGroup(slug));

  return groups;
}

function updatePickerBtn() {
  const entry = getThemeEntry();
  const chip = qs('#themePickerChip');
  const preview = ThemeRuntime.getThemePreviewChipStyle(getResolvedTheme());
  // Reset all properties first so prior pack styling doesn't bleed through.
  ['background', 'border', 'borderRadius', 'boxShadow', 'filter', 'clipPath']
    .forEach((p) => { chip.style[p] = ''; });
  chip.style.background = preview.background;
  chip.style.border = preview.border;
  chip.style.borderRadius = preview.borderRadius;
  chip.style.boxShadow = preview.boxShadow;
  chip.style.filter = preview.filter;
  chip.style.clipPath = preview.clipPath;
  // For pack-bound themes, swap the chip's solid keycap preview for a
  // pack-identity color stripe — a tiny title-bar gradient visible at chip
  // size, so users can recognize at a glance whether their selection is a
  // Win95 / Neo-Tokyo / etc. theme. Keeps Default themes looking identical
  // to before.
  const basePack = entry && entry.basePack;
  if (basePack && basePack !== 'default' && state.packDetails) {
    const detail = state.packDetails[basePack];
    const headerFill = detail && detail.composition && detail.composition.frame &&
      detail.composition.frame.header && detail.composition.frame.header.fill;
    if (headerFill && headerFill.stops) {
      const stops = headerFill.stops.map((s) => s.color).join(', ');
      const angle = Number(headerFill.angle) || 90;
      chip.style.background = `linear-gradient(${angle}deg, ${stops})`;
      chip.style.border = '1px solid rgba(0, 0, 0, 0.4)';
      chip.style.borderRadius = '2px';
      chip.style.boxShadow = 'inset 1px 1px 0 rgba(255, 255, 255, 0.4)';
      chip.style.filter = '';
      chip.style.clipPath = '';
    }
  }
  qs('#themePickerLabel').textContent = getThemeDisplayName(entry);
}

function applyTheme(key) {
  const entry = getThemeEntry(key);
  if (!entry) return;
  syncResolvedTheme(entry.theme, { selectedSlug: entry.slug, persistThemeData: false });
  applyThemeDefaultsToConfig(entry.theme);
  // Re-resolve the pack binding stored on the theme (__basePack +
  // __parameterValues). Without this, switching from a Win95-derived theme
  // to another theme would leave the previous pack's packData snapshot
  // active, mismatching the new theme.
  applyThemeBasePackToConfig(entry);
  renderAll();
  saveState();
  scheduleConfigPush();
}

/**
 * When a saved theme is applied, set the pack slug and clear any stale
 * inline packData so the SERVER resolves the theme's __parameterValues
 * against the pack template (see server/packs.js → resolveConfigPack).
 * Centralizing the resolution server-side means saved themes always
 * round-trip cleanly regardless of which client cached which pack.
 */
function applyThemeBasePackToConfig(entry) {
  const basePack = (entry && entry.basePack) || (entry && entry.theme && entry.theme.__basePack) || 'default';
  state.config.pack = basePack === 'default' ? null : basePack;
  state.config.packData = null;
}

function openThemeModal() {
  const modal = qs('#themeModal');
  const body  = qs('#themeModalBody');
  closeThemeCreatorView();
  modal.classList.remove('hidden');
  body.innerHTML = '';

  getThemeLibraryGroups().forEach(([groupName, entries]) => {
    if (!entries.length) return;
    const lbl = document.createElement('div');
    lbl.className = 'theme-group-label';
    lbl.textContent = groupName;
    body.appendChild(lbl);

    const grid = document.createElement('div');
    grid.className = 'theme-grid';

    entries.forEach((entry) => {
      const previewId = `theme-card-${entry.slug}`;
      const resolvedTheme = ThemeRuntime.resolveTheme(entry.theme);
      const captionBelow = (resolvedTheme.defaults?.captionPosition ?? 'above') === 'below';
      const inherited = ThemeRuntime.getInheritedDefaults(resolvedTheme);
      const card = document.createElement('button');
      card.className = 'theme-card' + (state.config.theme === entry.slug ? ' on' : '');
      card.setAttribute('data-theme-preview', previewId);
      card.style.setProperty('--theme-card-accent', inherited.keycapOutlineColor || inherited.keycapFillColor || '#4ef3ff');

      // Pack composition rendering: when this theme is bound to a non-default
      // pack, the card's preview should show the pack's chrome (Win95 window
      // bevel, Neo-Tokyo neon panel, etc.) so users can recognize their saved
      // theme at a glance. Resolve the pack template + theme.__parameterValues
      // and emit pack-card markup, scoped via the card's data-theme-preview id.
      const basePack = entry.basePack || 'default';
      const packTemplate = (basePack !== 'default' && state.packDetails) ? state.packDetails[basePack] : null;
      const resolvedPack = packTemplate ? resolvePackForCard(packTemplate, entry.theme?.__parameterValues || {}) : null;
      const cardComposition = resolvedPack && resolvedPack.composition;
      const cardMode = cardComposition && cardComposition.mode === 'card';
      const rowScope = cardComposition && cardComposition.frameScope === 'row' && cardComposition.frame;

      const previewStyle = document.createElement('style');
      const previewSelectors = {
        keycap: `[data-theme-preview="${previewId}"] .card-keycap`,
        caption: `[data-theme-preview="${previewId}"] .card-caption`,
      };
      ThemeRuntime.applyThemeCss(
        previewStyle,
        resolvedTheme,
        previewSelectors,
      );
      card.appendChild(previewStyle);

      // Pack-scoped CSS so this card's pack chrome doesn't leak to siblings.
      if (resolvedPack && cardComposition) {
        const packStyle = document.createElement('style');
        ThemeRuntime.applyPackCss(packStyle, resolvedPack, {
          scope: `[data-theme-preview="${previewId}"]`,
          rowFrameSelector: '.card-row-frame',
          skipFonts: true,
        });
        card.appendChild(packStyle);
      }

      const keyMarkup = cardMode
        ? `<div class="card-key key">
             <div class="pack-card">
               <div class="pack-card-header"><div class="card-caption">SAVE</div></div>
               <div class="pack-card-body"><div class="card-keycap">CTRL+S</div></div>
             </div>
           </div>`
        : `<div class="card-key${rowScope ? ' key' : ''}">
             ${captionBelow
               ? '<div class="card-keycap">CTRL+S</div><div class="card-caption">SAVE</div>'
               : '<div class="card-caption">SAVE</div><div class="card-keycap">CTRL+S</div>'}
           </div>`;
      const rowFrameMarkup = rowScope ? '<div class="card-row-frame" aria-hidden="true"></div>' : '';

      card.innerHTML += `
        <div class="card-chip">
          <div class="card-preview-shell">
            <div class="card-preview ${captionBelow ? 'caption-below' : 'caption-above'}${rowScope ? ' has-row-frame' : ''}">
              ${rowFrameMarkup}
              ${keyMarkup}
            </div>
          </div>
        </div>
        <div class="card-label">${getThemeDisplayName(entry)}</div>
      `;

      // Hydrate per-card pack-chrome (title-bar buttons + decor). We skip
      // hydrate for pack-card decor because thumbnails should stay simple.
      if (cardMode && resolvedPack) {
        const cardEl = card.querySelector('.pack-card');
        if (cardEl) {
          hydrateCreatorPreviewPackChrome(card.querySelector('.card-preview'), resolvedPack);
        }
      }
      card.onclick = () => {
        applyTheme(entry.slug);
        qs('#themeModal').classList.add('hidden');
      };
      const actions = document.createElement('div');
      actions.className = 'theme-card-actions';
      const copy = document.createElement('button');
      copy.className = 'theme-card-action theme-card-copy';
      copy.type = 'button';
      copy.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 1H4c-1.1 0-2 .9-2 2v12h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>';
      copy.title = `Make a copy of ${entry.name}`;
      copy.setAttribute('aria-label', `Duplicate theme ${entry.name}`);
  copy.onclick = async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await duplicateThemeEntry(entry);
      };
      actions.appendChild(copy);
      if (entry.canRename !== false) {
        const rename = document.createElement('button');
        rename.className = 'theme-card-action theme-card-rename';
        rename.type = 'button';
        rename.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3h7v7h-2V6.41l-9.29 9.3-1.42-1.42 9.3-9.29H14V3zM5 5h6v2H7v10h10v-4h2v6H5V5z"/></svg>';
        rename.title = `Rename ${entry.name}`;
        rename.setAttribute('aria-label', `Rename theme ${entry.name}`);
        rename.onclick = async (event) => {
          event.preventDefault();
          event.stopPropagation();
          await renameThemeEntry(entry);
        };
        actions.appendChild(rename);
      }
      if (entry.canEdit !== false) {
        const edit = document.createElement('button');
        edit.className = 'theme-card-action theme-card-edit';
        edit.type = 'button';
        edit.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25zm14.71-9.04a1.003 1.003 0 0 0 0-1.42l-2.5-2.5a1.003 1.003 0 0 0-1.42 0l-1.96 1.96 3.75 3.75 2.13-1.79z"/></svg>';
        edit.title = `Edit ${entry.name}`;
        edit.setAttribute('aria-label', `Edit theme ${entry.name}`);
        edit.onclick = (event) => {
          event.preventDefault();
          event.stopPropagation();
          openThemeCreatorView(entry);
        };
        actions.appendChild(edit);
      }
      if (entry.canDelete !== false) {
        const del = document.createElement('button');
        del.className = 'theme-card-action theme-card-delete';
        del.type = 'button';
        del.textContent = 'Delete';
        del.onclick = async (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!confirm(`Delete custom theme "${entry.name}"?`)) return;
          const res = await api('DELETE', '/api/themes/' + encodeURIComponent(entry.slug));
          if (!res) { toast('Delete failed', 'warn'); return; }
          await loadThemes();
          const cfg = await api('GET', '/api/config');
          if (cfg && typeof cfg === 'object') Object.assign(state.config, cfg);
          renderAll();
          openThemeModal();
        };
        actions.appendChild(del);
      }
      card.appendChild(actions);
      grid.appendChild(card);
      requestAnimationFrame(() => {
        ThemeRuntime.syncThemeMetrics(resolvedTheme, previewSelectors, card);
      });
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
  const defaults = ThemeRuntime.getInheritedDefaults(getResolvedTheme());
  switch (overrideKey) {
    case 'keycapFillColor':     return defaults.keycapFillColor;
    case 'keycapTextColor':     return defaults.keycapTextColor;
    case 'keycapOutlineColor':  return defaults.keycapOutlineColor;
    case 'keycapTextureColor':  return defaults.keycapTextureColor;
    case 'keycapShadowColor':   return defaults.keycapShadowColor;
    case 'captionFillColor':    return defaults.captionFillColor;
    case 'captionTextColor':    return defaults.captionTextColor;
    case 'captionOutlineColor': return defaults.captionOutlineColor;
    case 'captionTextureColor': return defaults.captionTextureColor;
    case 'captionShadowColor':  return defaults.captionShadowColor;
    default: return '#000000';
  }
}

function cssColorToHex(value, fallback = '#000000') {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  if (raw.startsWith('#')) return normalizeHex(raw, fallback);
  const match = raw.match(/rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/i);
  if (!match) return fallback;
  return `#${match.slice(1, 4).map((part) => Math.max(0, Math.min(255, Number(part) || 0)).toString(16).padStart(2, '0')).join('')}`;
}

const COLOR_OVERRIDE_DEFS = {
  keycapFillColor: {
    label: 'Keycap Fill',
    get: (theme) => ThemeRuntime.getFillRepresentativeColor(theme.keycap.fill),
    set: (theme, color) => {
      theme.keycap.fill = { type: 'solid', color };
      theme.keycap.material = theme.keycap.material || {};
      theme.keycap.material.fill = ThemeRuntime.deepClone(theme.keycap.fill);
    },
    reset: (theme, baseTheme) => {
      theme.keycap.fill = ThemeRuntime.deepClone(baseTheme.keycap.fill);
      theme.keycap.material = theme.keycap.material || {};
      theme.keycap.material.fill = ThemeRuntime.deepClone(baseTheme.keycap.material?.fill || baseTheme.keycap.fill);
    },
  },
  keycapTextColor: {
    label: 'Keycap Text',
    get: (theme) => theme.keycap.textColor,
    set: (theme, color) => { theme.keycap.textColor = color; },
    reset: (theme, baseTheme) => { theme.keycap.textColor = baseTheme.keycap.textColor; },
  },
  keycapOutlineColor: {
    label: 'Keycap Outline',
    get: (theme) => theme.keycap.outline?.color || '#000000',
    set: (theme, color) => {
      theme.keycap.outline.enabled = true;
      theme.keycap.outline.color = color;
      theme.keycap.material = theme.keycap.material || {};
      theme.keycap.material.outline = {
        ...(theme.keycap.material.outline || {}),
        enabled: true,
        color,
      };
    },
    reset: (theme, baseTheme) => {
      theme.keycap.outline = ThemeRuntime.deepClone(baseTheme.keycap.outline);
      theme.keycap.material = theme.keycap.material || {};
      theme.keycap.material.outline = ThemeRuntime.deepClone(baseTheme.keycap.material?.outline || baseTheme.keycap.outline);
    },
  },
  keycapTextureColor: {
    label: 'Keycap Texture',
    get: (theme) => theme.keycap.pattern?.color || theme.keycap.texture?.color || '#000000',
    set: (theme, color) => {
      theme.keycap.pattern = theme.keycap.pattern || {};
      theme.keycap.pattern.color = color;
      theme.keycap.texture = theme.keycap.texture || {};
      theme.keycap.texture.color = color;
    },
    reset: (theme, baseTheme) => {
      theme.keycap.pattern = ThemeRuntime.deepClone(baseTheme.keycap.pattern);
      theme.keycap.texture = ThemeRuntime.deepClone(baseTheme.keycap.texture);
    },
  },
  keycapShadowColor: {
    label: 'Keycap Shadow',
    get: (theme) => getPrimaryOuterShadowLayer(theme.keycap)?.color || '#000000',
    set: (theme, color) => {
      const shadowState = getThemeCreatorShadowState(theme.keycap, 'keycap');
      shadowState.dropLayer.color = color;
      shadowState.dropOpacity = Math.max(0.2, shadowState.dropOpacity || 0.2);
      applyThemeCreatorShadowState(theme.keycap, 'keycap', shadowState);
    },
    reset: (theme, baseTheme) => {
      const shadowState = getThemeCreatorShadowState(theme.keycap, 'keycap');
      const baseShadow = getThemeCreatorShadowState(baseTheme.keycap, 'keycap');
      shadowState.dropLayer.color = baseShadow.dropLayer.color;
      shadowState.dropOpacity = baseShadow.dropOpacity;
      applyThemeCreatorShadowState(theme.keycap, 'keycap', shadowState);
    },
  },
  captionFillColor: {
    label: 'Caption Fill',
    get: (theme) => ThemeRuntime.getFillRepresentativeColor(theme.caption.fill),
    set: (theme, color) => {
      theme.caption.fill = { ...(theme.caption.fill || {}), type: 'solid', color };
      theme.caption.material = theme.caption.material || {};
      theme.caption.material.fill = ThemeRuntime.deepClone(theme.caption.fill);
    },
    reset: (theme, baseTheme) => {
      theme.caption.fill = ThemeRuntime.deepClone(baseTheme.caption.fill);
      theme.caption.material = theme.caption.material || {};
      theme.caption.material.fill = ThemeRuntime.deepClone(baseTheme.caption.material?.fill || baseTheme.caption.fill);
    },
  },
  captionTextColor: {
    label: 'Caption Text',
    get: (theme) => theme.caption.textColor,
    set: (theme, color) => { theme.caption.textColor = color; },
    reset: (theme, baseTheme) => { theme.caption.textColor = baseTheme.caption.textColor; },
  },
  captionOutlineColor: {
    label: 'Caption Outline',
    get: (theme) => theme.caption.outline?.color || '#000000',
    set: (theme, color) => {
      theme.caption.outline.enabled = true;
      theme.caption.outline.color = color;
      theme.caption.material = theme.caption.material || {};
      theme.caption.material.outline = {
        ...(theme.caption.material.outline || {}),
        enabled: true,
        color,
      };
    },
    reset: (theme, baseTheme) => {
      theme.caption.outline = ThemeRuntime.deepClone(baseTheme.caption.outline);
      theme.caption.material = theme.caption.material || {};
      theme.caption.material.outline = ThemeRuntime.deepClone(baseTheme.caption.material?.outline || baseTheme.caption.outline);
    },
  },
  captionTextureColor: {
    label: 'Caption Texture',
    get: (theme) => theme.caption.pattern?.color || theme.caption.texture?.color || '#000000',
    set: (theme, color) => {
      theme.caption.pattern = theme.caption.pattern || {};
      theme.caption.pattern.color = color;
      theme.caption.texture = theme.caption.texture || {};
      theme.caption.texture.color = color;
    },
    reset: (theme, baseTheme) => {
      theme.caption.pattern = ThemeRuntime.deepClone(baseTheme.caption.pattern);
      theme.caption.texture = ThemeRuntime.deepClone(baseTheme.caption.texture);
    },
  },
  captionShadowColor: {
    label: 'Caption Shadow',
    get: (theme) => getPrimaryOuterShadowLayer(theme.caption)?.color || '#000000',
    set: (theme, color) => {
      const shadowState = getThemeCreatorShadowState(theme.caption, 'caption');
      shadowState.dropLayer.color = color;
      shadowState.dropOpacity = Math.max(0.2, shadowState.dropOpacity || 0.2);
      applyThemeCreatorShadowState(theme.caption, 'caption', shadowState);
    },
    reset: (theme, baseTheme) => {
      const shadowState = getThemeCreatorShadowState(theme.caption, 'caption');
      const baseShadow = getThemeCreatorShadowState(baseTheme.caption, 'caption');
      shadowState.dropLayer.color = baseShadow.dropLayer.color;
      shadowState.dropOpacity = baseShadow.dropOpacity;
      applyThemeCreatorShadowState(theme.caption, 'caption', shadowState);
    },
  },
};

let activeColorOverrideKey = null;
let activeColorOverrideAnchor = null;
let pendingColorOverrideFrame = 0;
let pendingColorOverrideState = null;

function getColorOverrideBaseTheme() {
  return ThemeRuntime.resolveTheme(
    getThemeEntry(state.config.theme)?.theme
    || getThemeEntry(state.colorOverrideBaseThemeSlug)?.theme
    || ThemeRuntime.DEFAULT_THEME,
  );
}

function closeColorOverridePopover() {
  const popover = qs('#colorOverridePopover');
  if (!popover) return;
  popover.classList.add('hidden');
  qsa('.color-matrix-cell.active').forEach((cell) => cell.classList.remove('active'));
  activeColorOverrideKey = null;
  activeColorOverrideAnchor = null;
}

function syncColorOverridePopover() {
  if (!activeColorOverrideKey) return;
  const definition = COLOR_OVERRIDE_DEFS[activeColorOverrideKey];
  if (!definition) return;
  const color = cssColorToHex(definition.get(getResolvedTheme()));
  qs('#colorOverridePopoverTitle').textContent = definition.label;
  qs('#colorOverridePicker').value = color;
  qs('#colorOverrideHex').value = color.toUpperCase();
  if (activeColorOverrideAnchor) positionColorOverridePopover(activeColorOverrideAnchor);
}

function positionColorOverridePopover(anchor = activeColorOverrideAnchor) {
  const popover = qs('#colorOverridePopover');
  if (!popover || popover.classList.contains('hidden') || !anchor) return;
  const anchorRect = anchor.getBoundingClientRect();
  const popRect = popover.getBoundingClientRect();
  const gutter = 12;
  let left = anchorRect.left;
  let top = anchorRect.bottom + 8;
  if (left + popRect.width > window.innerWidth - gutter) {
    left = window.innerWidth - popRect.width - gutter;
  }
  if (left < gutter) left = gutter;
  if (top + popRect.height > window.innerHeight - gutter) {
    top = anchorRect.top - popRect.height - 8;
  }
  if (top < gutter) top = gutter;
  popover.style.left = `${Math.round(left)}px`;
  popover.style.top = `${Math.round(top)}px`;
}

function openColorOverridePopover(key, anchor) {
  const definition = COLOR_OVERRIDE_DEFS[key];
  const popover = qs('#colorOverridePopover');
  if (!definition || !popover || !anchor) return;
  activeColorOverrideKey = key;
  activeColorOverrideAnchor = anchor;
  qsa('.color-matrix-cell.active').forEach((cell) => cell.classList.remove('active'));
  anchor.classList.add('active');
  syncColorOverridePopover();
  popover.classList.remove('hidden');
  positionColorOverridePopover(anchor);
}

function setColorOverride(key, color, { push = true, renderMode = 'full' } = {}) {
  const definition = COLOR_OVERRIDE_DEFS[key];
  if (!definition) return;
  mutateTheme((theme) => definition.set(theme, color), { push, renderMode });
}

function resetColorOverride(key) {
  const definition = COLOR_OVERRIDE_DEFS[key];
  if (!definition) return;
  const baseTheme = getColorOverrideBaseTheme();
  mutateTheme((theme) => definition.reset(theme, baseTheme), { renderMode: 'theme' });
}

function setupColorInputs() {
  Object.keys(COLOR_OVERRIDE_DEFS).forEach((key) => {
    const cell = qs(`#override-${key}`);
    if (!cell) return;
    cell.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (activeColorOverrideKey === key) {
        closeColorOverridePopover();
        return;
      }
      openColorOverridePopover(key, cell);
    };
  });

  qs('#colorOverridePicker').oninput = (event) => {
    if (!activeColorOverrideKey) return;
    pendingColorOverrideState = { key: activeColorOverrideKey, color: event.target.value };
    if (pendingColorOverrideFrame) return;
    pendingColorOverrideFrame = requestAnimationFrame(() => {
      pendingColorOverrideFrame = 0;
      const next = pendingColorOverrideState;
      pendingColorOverrideState = null;
      if (!next) return;
      setColorOverride(next.key, next.color, { push: false, renderMode: 'theme' });
    });
  };
  qs('#colorOverridePicker').onchange = (event) => {
    if (!activeColorOverrideKey) return;
    setColorOverride(activeColorOverrideKey, event.target.value, { push: true, renderMode: 'theme' });
  };
  qs('#colorOverrideHex').oninput = (event) => {
    if (!activeColorOverrideKey) return;
    const value = event.target.value.trim();
    if (/^#?[0-9a-f]{6}$/i.test(value)) {
      setColorOverride(activeColorOverrideKey, value.startsWith('#') ? value : `#${value}`, { push: false, renderMode: 'theme' });
    }
  };
  qs('#colorOverrideHex').onchange = (event) => {
    if (!activeColorOverrideKey) return;
    const value = event.target.value.trim();
    if (/^#?[0-9a-f]{6}$/i.test(value)) {
      setColorOverride(activeColorOverrideKey, value.startsWith('#') ? value : `#${value}`, { push: true, renderMode: 'theme' });
    }
  };
  qs('#colorOverrideResetBtn').onclick = () => {
    if (!activeColorOverrideKey) return;
    resetColorOverride(activeColorOverrideKey);
  };
  qs('#colorOverrideDoneBtn').onclick = () => closeColorOverridePopover();

  document.addEventListener('click', (event) => {
    const popover = qs('#colorOverridePopover');
    if (!popover || popover.classList.contains('hidden')) return;
    if (popover.contains(event.target) || event.target.closest('.color-matrix-cell')) return;
    closeColorOverridePopover();
  });
  window.addEventListener('resize', () => positionColorOverridePopover());
  document.addEventListener('scroll', () => positionColorOverridePopover(), true);

  syncOverrideSwatches();
}

function syncOverrideSwatches() {
  const theme = getResolvedTheme();
  const baseTheme = getColorOverrideBaseTheme();
  Object.entries(COLOR_OVERRIDE_DEFS).forEach(([key, definition]) => {
    const cell = qs(`#override-${key}`);
    if (!cell) return;
    const swatch = qs('.color-matrix-swatch', cell);
    const meta = qs('.color-matrix-meta', cell);
    const currentRaw = definition.get(theme);
    const baseRaw = definition.get(baseTheme);
    const current = cssColorToHex(currentRaw);
    const inherited = cssColorToHex(baseRaw) === current;
    swatch.style.background = currentRaw || current;
    cell.classList.toggle('inherited', inherited);
    cell.classList.toggle('custom', !inherited);
    if (meta) meta.textContent = inherited ? 'Theme' : 'Custom';
  });
  syncColorOverridePopover();
}

function syncQuickThemeSwatches() {
  syncOverrideSwatches();
}

function trimLegacyOverrideRows() {
  const captionGroup = qs('.group[data-group="caption-overrides"] .group-body');
  if (captionGroup) {
    qsa('.row', captionGroup).slice(1).forEach((row) => row.remove());
  }
}

async function saveThemeFromCreator() {
  const nameInput = qs('#themeCreatorName');
  const name = nameInput?.value.trim() || '';
  if (!name) {
    toast('Name your theme first', 'warn');
    nameInput?.focus();
    return;
  }
  const previousSlug = state.themeCreatorEditingSlug;
  const editingEntry = previousSlug ? getThemeEntry(previousSlug) : null;
  const isBuiltinEdit = editingEntry?.source === 'builtin';
  const slug = isBuiltinEdit ? previousSlug : slugifyName(name);
  if (!slug) { toast('Invalid theme name', 'warn'); return; }
  const payload = ThemeRuntime.serializeTheme(state.themeCreatorDraft || getResolvedTheme());
  payload.__name = name;
  // Persist the pack binding so the overlay can re-resolve it on load.
  // parameterValues are stored alongside the keycap theme; the runtime applies
  // them to the pack template at apply-time.
  const basePack = state.themeCreatorBasePack || 'default';
  payload.__basePack = basePack;
  const parameterValues = state.themeCreatorParameterValues || {};
  if (Object.keys(parameterValues).length) {
    payload.__parameterValues = deepClonePack(parameterValues);
  }
  const res = await api('PUT', '/api/themes/' + encodeURIComponent(slug), {
    name,
    basePack,
    theme: payload,
  });
  if (!res) { toast('Save failed', 'warn'); return; }
  if (previousSlug && previousSlug !== slug && !isBuiltinEdit) {
    const deleteRes = await api('DELETE', '/api/themes/' + encodeURIComponent(previousSlug));
    if (!deleteRes) {
      toast(`Saved "${name}", but the old theme could not be removed`, 'warn');
    }
  }
  await loadThemes();
  const entry = getThemeEntry(slug);
  if (entry) {
    syncResolvedTheme(entry.theme, { selectedSlug: entry.slug, persistThemeData: false });
    applyThemeDefaultsToConfig(entry.theme);
    renderAll();
    saveState();
    scheduleConfigPush();
  }
  closeThemeCreatorView();
  openThemeModal();
  toast(`${previousSlug ? 'Updated' : 'Saved'} theme "${name}"`);
}

function wireThemeCreator() {
  populateThemeCreatorFontSelects();
  normalizeThemeCreatorGroupColumns();
  normalizeThemeCreatorCaptionFxPlacement();
  wireThemeCreatorGroupToggles();
  wireThemeCreatorCanvas();
  const setGlobalMotion = (nextTheme, value) => {
    nextTheme.defaults = nextTheme.defaults || {};
    nextTheme.defaults.motion = {
      ...(nextTheme.defaults.motion || {}),
      enter: value,
      exit: value,
      reduced: ['slam', 'overshoot', 'split-in', 'scan-in', 'flash-cut', 'glitch-burst', 'pixel-pop', 'crt-smear'].includes(value) ? 'fade' : value,
    };
    nextTheme.defaults.fade = value;
    ['keycap', 'caption'].forEach((part) => {
      nextTheme[part] = nextTheme[part] || {};
      nextTheme[part].motion = {
        ...(nextTheme[part].motion || {}),
        enter: value,
        exit: value,
        reduced: nextTheme.defaults.motion.reduced,
      };
    });
  };

  const setGlobalMotionSpeed = (nextTheme, value) => {
    nextTheme.defaults = nextTheme.defaults || {};
    nextTheme.defaults.animationSpeed = value;
    nextTheme.defaults.motion = {
      ...(nextTheme.defaults.motion || {}),
      speed: value,
    };
    ['keycap', 'caption'].forEach((part) => {
      nextTheme[part] = nextTheme[part] || {};
      nextTheme[part].motion = {
        ...(nextTheme[part].motion || {}),
        speed: value,
      };
    });
  };

  qsa('#themeCreatorTabs button').forEach((button) => {
    button.onclick = () => setThemeCreatorSection(button.dataset.section);
  });
  qsa('#themeCreatorPreviewTone button').forEach((button) => {
    button.onclick = () => setThemeCreatorPreviewTone(button.dataset.tone);
  });
  qsa('#themeCreatorPreviewScenario button').forEach((button) => {
    button.onclick = () => setThemeCreatorPreviewScenario(button.dataset.scenario);
  });
  qsa('#themeCreatorMode button').forEach((button) => {
    button.onclick = () => setThemeCreatorMode(button.dataset.mode);
  });
  qsa('#themeCreatorIntensity button').forEach((button) => {
    button.onclick = () => {
      setThemeCreatorIntensity(button.dataset.intensity);
      if (state.themeCreatorDraft) applyThemeCreatorStylePack();
    };
  });
  qs('#themeCreatorPack').onchange = (e) => {
    state.themeCreatorPack = e.target.value;
    saveState();
    applyThemeCreatorStylePack();
  };
  qs('#themeCreatorPalette').onchange = (e) => {
    state.themeCreatorPalette = e.target.value;
    saveState();
    applyThemeCreatorStylePack();
  };
  qs('#themeCreatorBasicShape').onchange = (e) => {
    state.themeCreatorBasicShape = e.target.value;
    saveState();
    applyThemeCreatorStylePack();
  };
  qs('#themeCreatorBasicMotion').onchange = (e) => {
    state.themeCreatorBasicMotion = e.target.value;
    saveState();
    applyThemeCreatorStylePack();
  };
  qs('#themeCreatorBasicFxPreset').onchange = (e) => updateThemeCreatorKeycapFx((fx) => {
    fx.preset = e.target.value;
    fx.enabled = fx.preset !== 'none';
  });
  qs('#themeCreatorBasicFxIntensity').onchange = (e) => updateThemeCreatorKeycapFx((fx) => {
    fx.intensity = e.target.value;
  });
  qs('#themeCreatorBasicFxSpeed').oninput = (e) => updateThemeCreatorKeycapFx((fx) => {
    fx.speed = +e.target.value;
  });
  qs('#themeCreatorLinked').onchange = (e) => {
    state.themeCreatorLinked = e.target.checked;
    saveState();
  };
  qs('#themeCreatorApplyPackBtn').onclick = () => applyThemeCreatorStylePack();

  qs('#themeCreatorCopyBtn').onclick = () => {
    const source = state.themeCreatorSection;
    const draft = ThemeRuntime.resolveTheme(state.themeCreatorDraft || getResolvedTheme());
    state.themeCreatorClipboard = ThemeRuntime.deepClone(draft[source]);
    syncThemeCreatorForm();
    toast(`${source === 'keycap' ? 'Keycap' : 'Caption'} style copied`);
  };
  qs('#themeCreatorPasteBtn').onclick = () => {
    if (!state.themeCreatorClipboard) {
      toast('Copy a style first', 'warn');
      return;
    }
    updateThemeCreatorDraft(state.themeCreatorSection, (block) => {
      const copied = ThemeRuntime.deepClone(state.themeCreatorClipboard);
      Object.keys(block).forEach((key) => delete block[key]);
      Object.assign(block, copied);
    }, { replayAnimation: true });
    toast(`${state.themeCreatorSection === 'keycap' ? 'Keycap' : 'Caption'} style updated`);
  };

  ['keycap', 'caption'].forEach((section) => {
    qs(`#creator-${section}-shape`).onchange = (e) => updateThemeCreatorDraft(section, (block) => {
      block.geometry = block.geometry || {};
      block.geometry.shape = e.target.value;
      block.shape = e.target.value;
      if (e.target.value === 'square') {
        block.geometry.cornerRadius = 0;
        block.cornerRadius = 0;
      }
    });
    qs(`#creator-${section}-radius`).oninput = (e) => updateThemeCreatorDraft(section, (block) => {
      block.geometry = block.geometry || {};
      block.geometry.cornerRadius = +e.target.value;
      block.cornerRadius = +e.target.value;
    });
    qs(`#creator-${section}-skew`).oninput = (e) => updateThemeCreatorDraft(section, (block) => {
      block.geometry = block.geometry || {};
      block.geometry.skewX = +e.target.value;
      block.skewX = +e.target.value;
    });
    qs(`#creator-${section}-fill`).oninput = (e) => updateThemeCreatorDraft(section, (block) => {
      block.fill = { type: 'solid', color: e.target.value };
      block.material = block.material || {};
      block.material.fill = ThemeRuntime.deepClone(block.fill);
    });
    qs(`#creator-${section}-text`).oninput = (e) => updateThemeCreatorDraft(section, (block) => {
      block.textColor = e.target.value;
    });
    qs(`#creator-${section}-outline-width`).oninput = (e) => updateThemeCreatorDraft(section, (block) => {
      block.outline = block.outline || {};
      block.outline.width = +e.target.value;
      block.outline.enabled = (+e.target.value) > 0;
      block.material = block.material || {};
      block.material.outline = {
        ...(block.material.outline || {}),
        width: block.outline.width,
        enabled: block.outline.enabled,
      };
    });
    qs(`#creator-${section}-size-x`).oninput = (e) => updateThemeCreatorDraft(section, (block) => {
      block.geometry = block.geometry || {};
      block.geometry.paddingX = +e.target.value;
      block.paddingX = +e.target.value;
    });
    qs(`#creator-${section}-size-y`).oninput = (e) => updateThemeCreatorDraft(section, (block) => {
      block.geometry = block.geometry || {};
      block.geometry.paddingY = +e.target.value;
      block.paddingY = +e.target.value;
    });
    qs(`#creator-${section}-outline-color`).oninput = (e) => updateThemeCreatorDraft(section, (block) => {
      block.outline = block.outline || {};
      block.outline.color = e.target.value;
      block.material = block.material || {};
      block.material.outline = {
        ...(block.material.outline || {}),
        color: e.target.value,
      };
    });
    qs(`#creator-${section}-text-size`).oninput = (e) => updateThemeCreatorDraft(section, (block) => {
      block.fontSize = +e.target.value;
    });
    qs(`#creator-${section}-text-weight`).oninput = (e) => updateThemeCreatorDraft(section, (_block, nextTheme) => {
      nextTheme.defaults = nextTheme.defaults || {};
      nextTheme.defaults.fontWeight = +e.target.value;
    });
    qs(`#creator-${section}-font-family`).onchange = (e) => updateThemeCreatorDraft(section, (_block, nextTheme) => {
      nextTheme.defaults = nextTheme.defaults || {};
      nextTheme.defaults.fontFamily = e.target.value;
    });
    qs(`#creator-${section}-text-effect`).onchange = (e) => updateThemeCreatorDraft(section, (block) => {
      block.textEffect = normalizeThemeCreatorTextEffect({
        ...(block.textEffect || defaultThemeCreatorTextEffectState()),
        preset: e.target.value,
      }, block.textShadow);
    });
    qs(`#creator-${section}-text-effect-intensity`).oninput = (e) => {
      const intensity = +e.target.value;
      const valueLabel = qs(`#creator-${section}-text-effect-intensity-val`);
      if (valueLabel) valueLabel.textContent = `${Math.round(intensity * 100)}%`;
      updateThemeCreatorDraftLight(section, (block) => {
        block.textEffect = normalizeThemeCreatorTextEffect({
          ...(block.textEffect || defaultThemeCreatorTextEffectState()),
          intensity,
        }, block.textShadow);
      });
    };
    qs(`#creator-${section}-text-effect-intensity`).onchange = (e) => updateThemeCreatorDraft(section, (block) => {
      block.textEffect = normalizeThemeCreatorTextEffect({
        ...(block.textEffect || defaultThemeCreatorTextEffectState()),
        intensity: +e.target.value,
      }, block.textShadow);
    });
    qs(`#creator-${section}-text-align`).onchange = (e) => updateThemeCreatorDraft(section, (block) => {
      block.geometry = block.geometry || {};
      block.geometry.textAlign = e.target.value;
      block.textAlign = e.target.value;
    });
    qs(`#creator-${section}-material`).onchange = (e) => updateThemeCreatorDraft(section, (block) => {
      block.material = block.material || {};
      block.material.preset = e.target.value;
    });
    qs(`#creator-${section}-edge`).onchange = (e) => updateThemeCreatorDraft(section, (block) => {
      block.geometry = block.geometry || {};
      block.geometry.edgeTreatment = e.target.value;
      replaceThemeCreatorEffects(block, ['bevel', 'emboss', 'rim-light', 'inner-stroke'], buildThemeCreatorEdgeEffects(section, e.target.value));
    });
    qs(`#creator-${section}-texture-type`).onchange = (e) => updateThemeCreatorDraft(section, (block) => {
      block.pattern = block.pattern || {};
      block.pattern.type = e.target.value;
      block.texture = block.texture || {};
      block.texture.type = e.target.value;
    });
    qs(`#creator-${section}-texture-color`).oninput = (e) => updateThemeCreatorDraft(section, (block) => {
      block.pattern = block.pattern || {};
      block.pattern.color = e.target.value;
      block.texture = block.texture || {};
      block.texture.color = e.target.value;
    });
    qs(`#creator-${section}-texture-opacity`).oninput = (e) => updateThemeCreatorDraft(section, (block) => {
      block.pattern = block.pattern || {};
      block.pattern.opacity = +e.target.value;
      block.texture = block.texture || {};
      block.texture.opacity = +e.target.value;
    });
    qs(`#creator-${section}-pattern-scale`).oninput = (e) => updateThemeCreatorDraft(section, (block) => {
      block.pattern = block.pattern || {};
      block.pattern.scale = +e.target.value;
      block.texture = block.texture || {};
      block.texture.scale = +e.target.value;
    });
    qs(`#creator-${section}-pattern-rotation`).oninput = (e) => updateThemeCreatorDraft(section, (block) => {
      block.pattern = block.pattern || {};
      block.pattern.rotation = +e.target.value;
      block.texture = block.texture || {};
      block.texture.rotation = +e.target.value;
    });
    qs(`#creator-${section}-adornment`).onchange = (e) => updateThemeCreatorDraft(section, (block) => {
      block.adornments = buildThemeCreatorAdornment(block, section, e.target.value);
    });
    qs(`#creator-${section}-surface-opacity`).oninput = (e) => updateThemeCreatorDraft(section, (block) => {
      const shadowState = getThemeCreatorShadowState(block, section);
      shadowState.surfaceOpacity = clampUnit(e.target.value, 1);
      applyThemeCreatorShadowState(block, section, shadowState);
    });
    qs(`#creator-${section}-glow-color`).oninput = (e) => updateThemeCreatorDraft(section, (block) => {
      const glowState = getThemeCreatorGlowState(block, section);
      glowState.color = e.target.value;
      applyThemeCreatorGlowState(block, section, glowState);
    });
    qs(`#creator-${section}-glow-spread`).oninput = (e) => updateThemeCreatorDraft(section, (block) => {
      const glowState = getThemeCreatorGlowState(block, section);
      glowState.spread = Math.max(0, +e.target.value);
      applyThemeCreatorGlowState(block, section, glowState);
    });
    qs(`#creator-${section}-glow-opacity`).oninput = (e) => updateThemeCreatorDraft(section, (block) => {
      const glowState = getThemeCreatorGlowState(block, section);
      glowState.opacity = clampUnit(e.target.value, 0);
      applyThemeCreatorGlowState(block, section, glowState);
    });
    qs(`#creator-${section}-shadow-angle`).oninput = (e) => updateThemeCreatorDraft(section, (block) => {
      const shadowState = getThemeCreatorShadowState(block, section);
      const nextAngle = ((+e.target.value % 360) + 360) % 360;
      const polarShadow = shadowLayerToPolar(shadowState.dropLayer);
      const offset = polarToShadowOffset(nextAngle, polarShadow.distance);
      shadowState.dropLayer.x = offset.x;
      shadowState.dropLayer.y = offset.y;
      applyThemeCreatorShadowState(block, section, shadowState);
    });
    qs(`#creator-${section}-shadow-distance`).oninput = (e) => updateThemeCreatorDraft(section, (block) => {
      const shadowState = getThemeCreatorShadowState(block, section);
      const polarShadow = shadowLayerToPolar(shadowState.dropLayer);
      const offset = polarToShadowOffset(polarShadow.angle, +e.target.value);
      shadowState.dropLayer.x = offset.x;
      shadowState.dropLayer.y = offset.y;
      applyThemeCreatorShadowState(block, section, shadowState);
    });
    qs(`#creator-${section}-shadow-color`).oninput = (e) => updateThemeCreatorDraft(section, (block) => {
      const shadowState = getThemeCreatorShadowState(block, section);
      shadowState.dropLayer.color = e.target.value;
      applyThemeCreatorShadowState(block, section, shadowState);
    });
    qs(`#creator-${section}-shadow-blur`).oninput = (e) => updateThemeCreatorDraft(section, (block) => {
      const shadowState = getThemeCreatorShadowState(block, section);
      shadowState.dropLayer.blur = +e.target.value;
      applyThemeCreatorShadowState(block, section, shadowState);
    });
    qs(`#creator-${section}-shadow-opacity`).oninput = (e) => updateThemeCreatorDraft(section, (block) => {
      const shadowState = getThemeCreatorShadowState(block, section);
      shadowState.dropOpacity = clampUnit(e.target.value, 0);
      applyThemeCreatorShadowState(block, section, shadowState);
    });
    qs(`#creator-${section}-glow-toggle`).onclick = () => updateThemeCreatorDraft(section, (block) => {
      const glowState = getThemeCreatorGlowState(block, section);
      glowState.enabled = !glowState.enabled;
      if (glowState.enabled && glowState.opacity <= 0) {
        glowState.opacity = defaultGlowState(section).opacity;
      }
      applyThemeCreatorGlowState(block, section, glowState);
    });
    qs(`#creator-${section}-shadow-toggle`).onclick = () => updateThemeCreatorDraft(section, (block) => {
      const shadowState = getThemeCreatorShadowState(block, section);
      shadowState.dropEnabled = !shadowState.dropEnabled;
      if (shadowState.dropEnabled && shadowState.dropOpacity <= 0) {
        shadowState.dropOpacity = defaultDropShadowOpacity(section);
      }
      applyThemeCreatorShadowState(block, section, shadowState);
    });
    qs(`#creator-${section}-effect-accent`).onchange = (e) => updateThemeCreatorDraft(section, (block) => {
      replaceThemeCreatorEffects(block, ['reflection', 'sheen', 'inner-glow', 'halo'], buildThemeCreatorAccentEffect(block, e.target.value));
    });
    qs(`#creator-${section}-animation`).onchange = (e) => updateThemeCreatorDraft(section, (_block, nextTheme) => {
      setGlobalMotion(nextTheme, e.target.value);
    }, { replayAnimation: true });
    qs(`#creator-${section}-speed`).oninput = (e) => updateThemeCreatorDraft(section, (_block, nextTheme) => {
      setGlobalMotionSpeed(nextTheme, +e.target.value);
    }, { replayAnimation: true });

    const dial = qs(`#creator-${section}-shadow-angle-dial`);
    const updateDialFromPointer = (event) => {
      if (dial.classList.contains('is-disabled')) return;
      const rect = dial.getBoundingClientRect();
      const centerX = rect.left + (rect.width / 2);
      const centerY = rect.top + (rect.height / 2);
      let angle = Math.round((Math.atan2(event.clientY - centerY, event.clientX - centerX) * 180) / Math.PI);
      if (angle < 0) angle += 360;
      qs(`#creator-${section}-shadow-angle`).value = String(angle);
      qs(`#creator-${section}-shadow-angle`).dispatchEvent(new Event('input', { bubbles: true }));
    };
    dial.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      updateDialFromPointer(event);
      const move = (moveEvent) => updateDialFromPointer(moveEvent);
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  });

  ['keycap', 'caption'].forEach((section) => {
    qs(`#creator-${section}-fx-preset`).onchange = (e) => updateThemeCreatorSectionFx(section, (fx) => {
      fx.preset = e.target.value;
      fx.enabled = fx.preset !== 'none';
    });
    qs(`#creator-${section}-fx-intensity`).onchange = (e) => updateThemeCreatorSectionFx(section, (fx) => {
      fx.intensity = e.target.value;
    });
    qs(`#creator-${section}-fx-speed`).oninput = (e) => updateThemeCreatorSectionFx(section, (fx) => {
      fx.speed = +e.target.value;
    });
    qs(`#creator-${section}-fx-color-mode`).onchange = (e) => updateThemeCreatorSectionFx(section, (fx) => {
      fx.colorMode = e.target.value;
    });
    ['1', '2', '3', '4', '5'].forEach((slot, index) => {
      qs(`#creator-${section}-fx-color-${slot}`).oninput = (e) => updateThemeCreatorSectionFx(section, (fx) => {
        const colors = Array.isArray(fx.colors) ? [...fx.colors] : [];
        colors[index] = e.target.value;
        fx.colors = colors;
      });
    });
    qs(`#creator-${section}-fx-add`).onclick = () => updateThemeCreatorSectionFx(section, (fx) => {
      const colors = Array.isArray(fx.colors) ? [...fx.colors] : [];
      const visibleCount = Math.max(
        THEME_CREATOR_MIN_FX_COLORS,
        Math.min(THEME_CREATOR_MAX_FX_COLORS, colors.length || THEME_CREATOR_MIN_FX_COLORS),
      );
      if (visibleCount >= THEME_CREATOR_MAX_FX_COLORS) return;
      const seed = colors[visibleCount - 1] || colors[colors.length - 1] || '#ffffff';
      colors.length = visibleCount;
      colors.push(seed);
      fx.colors = colors;
    });
  });

  qs('#themeCreatorName').onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveThemeFromCreator();
    }
  };
  qs('#themeModalBackBtn').onclick = saveThemeFromCreator;
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
  // #live-row-frame (used by row-scope packs) is a non-key sibling that must
  // not be evicted when maxKeys overflows.
  const keys = Array.from(live.querySelectorAll(':scope > .key-cap'));
  while (keys.length >= state.config.maxKeys) {
    keys.shift()?.remove();
  }
  const showCaptions = state.config.showCaptions !== false;
  const hasAnnotation = !!description;
  const showCaption = hasAnnotation && showCaptions;

  // Pack composition: when the active pack's composition uses card mode the
  // editor's live overlay needs to wrap the caption + keycap in pack-card
  // markup (matching what the OBS-side overlay does). Without this the live
  // preview renders flat and saved Win95 themes look unframed.
  const pack = state.config.resolvedPack || null;
  const composition = (pack && pack.composition) || null;
  const cardMode = composition && composition.mode === 'card' && composition.frame;

  const wrap = document.createElement('div');
  wrap.className = hasAnnotation ? 'key-cap annotated' : 'key-cap';
  if (cardMode || (composition && composition.frameScope === 'row')) {
    // .key class lets compiled pack CSS (`.key > .pack-card`) match.
    wrap.classList.add('key');
  }

  const kc = document.createElement('div');
  kc.className = 'keycap-el';
  kc.textContent = label;

  let cap = null;
  if (showCaption) {
    cap = document.createElement('div');
    cap.className = 'key-caption';
    cap.textContent = description;
  }
  const below = (state.config.captionPosition ?? 'above') === 'below';

  if (cardMode) {
    // Caption goes inside the title-bar header strip; keycap fills the body.
    const card = ThemeRuntime.buildPackCardElement(composition, { caption: cap, keycap: kc });
    wrap.appendChild(card);
  } else {
    if (cap && !below) wrap.appendChild(cap);
    wrap.appendChild(kc);
    if (cap && below) wrap.appendChild(cap);
  }

  live.appendChild(wrap);
  ensureLiveRowFrame(live, composition);
  ThemeRuntime.syncThemeMetrics(getResolvedTheme(), { keycap: '.keycap-el', caption: '.key-caption' }, wrap);

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
  if (!live) return;
  live.innerHTML = '';
  // Delegate to addKey so the demo keys go through the same pack-aware
  // markup path the live keystrokes use. `sticky: true` skips the auto-fade
  // timer so they stay visible as the static preview placeholder.
  addKey('CTRL + S', 'Save', { sticky: true });
  addKey('B', null, { sticky: true });
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
      const desc = getHotkeyDescription(profile, combo, { allowDisabled: true });
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
      const combo = c.toLowerCase().trim();
      const desc = getHotkeyDescription(profile, combo, { allowDisabled: true });
      const label = formatCombo(combo);
      addKey(label, desc);
      api('POST', '/api/test-key', { label, description: desc });
    }
  };
  tk.appendChild(custom);
}
function formatCombo(combo) {
  return combo.split('+').map(p => {
    if (p === 'ctrl') return 'CTRL';
    if (p === 'shift') return 'SHIFT';
    if (p === 'alt') return 'ALT';
    if (p === 'space') return 'SPACE';
    return p.toUpperCase();
  }).join(' + ');
}

function normalizeHotkeyEntry(value) {
  if (typeof value === 'string') {
    return { description: value, enabled: true };
  }
  if (value && typeof value === 'object') {
    return {
      description: String(value.description ?? value.desc ?? ''),
      enabled: value.enabled !== false,
    };
  }
  return { description: '', enabled: true };
}

function normalizeHotkeyMap(keys) {
  const next = {};
  for (const [combo, raw] of Object.entries(keys || {})) {
    const cleanCombo = String(combo || '').toLowerCase().replace(/\s+/g, '');
    if (!cleanCombo) continue;
    next[cleanCombo] = normalizeHotkeyEntry(raw);
  }
  return next;
}

function serializeHotkeyMap(keys) {
  const next = {};
  for (const [combo, entry] of Object.entries(normalizeHotkeyMap(keys))) {
    next[combo] = {
      description: entry.description,
      enabled: entry.enabled !== false,
    };
  }
  return next;
}

function normalizeProfile(profile) {
  if (!profile || typeof profile !== 'object') return profile;
  const match = Array.isArray(profile.match) ? profile.match : (profile.match ? [profile.match] : []);
  profile.match = match.map((item) => String(item).trim().toLowerCase()).filter(Boolean);
  profile.keys = normalizeHotkeyMap(profile.keys);
  return profile;
}

function getHotkeyEntry(profile, combo) {
  return normalizeHotkeyEntry(profile?.keys?.[combo]);
}

function getHotkeyDescription(profile, combo, { allowDisabled = false } = {}) {
  const entry = getHotkeyEntry(profile, combo);
  if (!allowDisabled && entry.enabled === false) return null;
  return entry.description || null;
}

function getKmDescInput() {
  return qs('#kmDescInput') || document.querySelector('.km-add-row input');
}

function buildHotkeyTag(label, { muted = false } = {}) {
  const tag = document.createElement('span');
  tag.className = `hotkey-profile-tag${muted ? ' is-muted' : ''}`;
  tag.textContent = label;
  return tag;
}

function renderHotkeyProfileSummary(profile, entries) {
  const nameEl = qs('#hotkeyProfileName');
  const metaEl = qs('#hotkeyProfileMeta');
  const matchEl = qs('#hotkeyProfileMatch');
  const tagsEl = qs('#hotkeyProfileTags');
  const libraryMeta = qs('#hotkeyLibraryMeta');
  const matches = Array.isArray(profile?.match) ? profile.match.filter(Boolean) : [];
  const detected = String(state.detectedApp || '').toLowerCase();

  if (nameEl) nameEl.textContent = profile?.name || 'Choose a profile';
  if (metaEl) metaEl.textContent = matches.length ? `${matches.length} app${matches.length === 1 ? '' : 's'}` : 'Manual';
  if (libraryMeta) libraryMeta.textContent = entries.length ? `${entries.length} mapped` : 'Ready to map';

  if (matchEl) {
    if (matches.length === 1) {
      matchEl.textContent = `Auto-switches whenever ${matches[0]} is the focused app.`;
    } else if (matches.length > 1) {
      matchEl.textContent = 'Auto-switches whenever one of these apps is focused.';
    } else {
      matchEl.textContent = 'This profile has no app matches yet. Add executable names to make the switcher feel automatic.';
    }
  }

  if (tagsEl) {
    tagsEl.innerHTML = '';
    if (matches.length) {
      matches.slice(0, 3).forEach((match) => tagsEl.appendChild(buildHotkeyTag(match)));
      if (matches.length > 3) tagsEl.appendChild(buildHotkeyTag(`+${matches.length - 3} more`, { muted: true }));
      if (detected && matches.includes(detected)) tagsEl.appendChild(buildHotkeyTag('Focused now'));
    } else {
      tagsEl.appendChild(buildHotkeyTag('Manual profile', { muted: true }));
    }
  }
}

function syncKmComposer() {
  const profile = state.profiles[state.activeProfile];
  const descInput = getKmDescInput();
  const captureBtn = qs('#captureBtn');
  const addBtn = qs('#kmAddBtn');
  const hint = qs('#kmDraftHint');
  const combo = state.kmDraftCombo || '';
  const hasDraft = !!combo;
  const hasExisting = hasDraft && Object.prototype.hasOwnProperty.call(profile?.keys || {}, combo);

  if (captureBtn) {
    captureBtn.classList.toggle('active', state.capturing);
    captureBtn.classList.toggle('has-value', hasDraft && !state.capturing);
    captureBtn.textContent = state.capturing ? 'Listening...' : (hasDraft ? 'Retake combo' : 'Capture combo');
  }

  if (descInput) {
    descInput.placeholder = hasDraft ? `Describe ${formatCombo(combo)}` : 'Add a description';
  }

  if (addBtn) {
    const ready = hasDraft && !!descInput?.value.trim();
    addBtn.disabled = !ready;
    addBtn.textContent = hasExisting ? 'Update' : '+ add';
  }

  if (hint) {
    if (state.capturing) {
      hint.textContent = 'Press the shortcut now. Modifier keys will be captured with the next key you press.';
    } else if (hasExisting) {
      hint.textContent = `Editing ${formatCombo(combo)}. Update the description and save it back to this profile.`;
    } else if (hasDraft) {
      hint.textContent = `Captured ${formatCombo(combo)}. Add a description to save it to this profile.`;
    } else {
      hint.textContent = 'Capture a combo, then describe what it does.';
    }
  }

}

function resetKmComposer({ clearDescription = true } = {}) {
  state.capturing = false;
  state.kmDraftCombo = '';
  const descInput = getKmDescInput();
  if (clearDescription && descInput) descInput.value = '';
  syncKmComposer();
}

function commitKmDraft() {
  const profile = state.profiles[state.activeProfile];
  const descInput = getKmDescInput();
  const combo = state.kmDraftCombo;
  const description = descInput?.value.trim() || '';
  if (!profile || !combo) {
    toast('Capture a combo first', 'warn');
    return;
  }
  if (!description) {
    toast('Add a description before saving', 'warn');
    return;
  }

  const existing = getHotkeyEntry(profile, combo);
  const hadExisting = Object.prototype.hasOwnProperty.call(profile.keys, combo);
  profile.keys[combo] = {
    description,
    enabled: hadExisting ? existing.enabled !== false : true,
  };
  state.capturing = false;
  state.kmDraftCombo = '';
  if (descInput) descInput.value = '';
  saveState();
  renderAll();
  pushProfile(state.activeProfile);
  toast(`${hadExisting ? 'Updated' : 'Added'} ${formatCombo(combo)} -> ${description}`);
}

// ---------- keymap editor ----------
function renderKmTable() {
  const body = qs('#kmRows');
  body.innerHTML = '';
  const profile = state.profiles[state.activeProfile];
  profile.keys = normalizeHotkeyMap(profile.keys);
  const entries = Object.entries(profile.keys)
    .sort((a,b) => a[0].localeCompare(b[0]));
  renderHotkeyProfileSummary(profile, entries);
  entries.forEach(([combo, rawEntry]) => {
    const hotkey = normalizeHotkeyEntry(rawEntry);
    const row = document.createElement('div');
    row.className = `tr${hotkey.enabled === false ? ' is-disabled' : ''}`;
    const parts = combo.split('+').map(p => `<span class="kbd">${
      p === 'ctrl' ? 'Ctrl' : p === 'shift' ? 'Shift' : p === 'alt' ? 'Alt' : p.toUpperCase()
    }</span>`).join('<span class="plus">+</span>');
    row.innerHTML = `
      <div class="combo">${parts}</div>
      <div class="desc" data-full="${hotkey.description.replace(/"/g,'&quot;')}"><input value="${hotkey.description.replace(/"/g,'&quot;')}" data-combo="${combo}" spellcheck="false" aria-label="${hotkey.description.replace(/"/g,'&quot;')}"></div>
      <div class="actions">
        <button class="hotkey-toggle${hotkey.enabled === false ? '' : ' on'}" type="button" aria-pressed="${hotkey.enabled === false ? 'false' : 'true'}" aria-label="${hotkey.enabled === false ? 'Show hotkey on overlay' : 'Hide hotkey from overlay'}" title="${hotkey.enabled === false ? 'Show hotkey on overlay' : 'Hide hotkey from overlay'}">
          <span class="hotkey-toggle-label">${hotkey.enabled === false ? 'Off' : 'On'}</span>
        </button>
        <button class="iconbtn preview-btn" type="button" title="${hotkey.enabled === false ? 'Enable to preview on overlay' : 'Preview on overlay'}">&#9654;</button>
        <button class="iconbtn del" type="button" title="Delete hotkey">&#10005;</button>
      </div>
    `;
    row.querySelector('.preview-btn').disabled = hotkey.enabled === false;
    row.querySelector('input').onchange = (e) => {
      profile.keys[combo] = {
        ...getHotkeyEntry(profile, combo),
        description: e.target.value,
      };
      e.target.setAttribute('aria-label', e.target.value);
      e.target.parentElement.setAttribute('data-full', e.target.value);
      saveState(); pushProfile(state.activeProfile);
    };
    row.querySelector('.hotkey-toggle').onclick = () => {
      profile.keys[combo] = {
        ...getHotkeyEntry(profile, combo),
        enabled: !getHotkeyEntry(profile, combo).enabled,
      };
      saveState();
      renderKmTable();
      pushProfile(state.activeProfile);
    };
    row.querySelector('.preview-btn').onclick = () => {
      if (getHotkeyEntry(profile, combo).enabled === false) return;
      const description = getHotkeyDescription(profile, combo);
      addKey(formatCombo(combo), description);
      api('POST', '/api/test-key', { label: formatCombo(combo), description });
    };
    row.querySelector('.iconbtn.del').onclick = () => {
      delete profile.keys[combo];
      saveState(); renderKmTable();
      pushProfile(state.activeProfile);
    };
    body.appendChild(row);
  });
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'km-empty';
    empty.innerHTML = `
      <strong>No hotkeys mapped yet</strong>
      <span>Capture a combo, type the action, or import an existing list to start building this profile.</span>
    `;
    body.appendChild(empty);
  }
  qs('#kmCount').textContent = `${entries.length} hotkeys`;
  syncKmComposer();
}

// ---------- main render ----------
function renderAll() {
  syncModeTabs();
  applyOverlayVars();
  updatePickerBtn();
  syncQuickThemeSwatches();
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
  const captionsOn = state.config.showCaptions !== false;
  qsa('#captionTogglePill button').forEach(b => b.classList.toggle('on', (b.dataset.val === 'on') === captionsOn));
  const capPos = state.config.captionPosition ?? 'above';
  qsa('#captionPosPill button').forEach(b => b.classList.toggle('on', b.dataset.val === capPos));
  const theme = getResolvedTheme();

  // fade pills
  qs('#fadeSelect').value = state.config.fade ?? 'glitch';
  // weight pills
  qs('#slider-fontweight').value    = state.config.fontWeight ?? 700;
  qs('#val-fontweight').textContent = state.config.fontWeight ?? 700;
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
  ensureRecordingTimer();
  syncRecordingInputs();
  syncCollapsibleGroups();

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
    opt.dataset.readOnly = p.readOnly ? 'true' : 'false';
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
  state.config.resolvedTheme = ThemeRuntime.resolveTheme(
    (cfg.themeData && typeof cfg.themeData === 'object')
      ? cfg.themeData
      : getThemeEntry(state.config.theme)?.theme || ThemeRuntime.DEFAULT_THEME,
  );
  if (cfg.theme || (cfg.themeData && typeof cfg.themeData === 'object')) {
    applyThemeDefaultsToConfig(state.config.resolvedTheme);
  }
  renderAll();
  await pushConfig();
  toast(`Loaded preset "${__name || slug}"`);
}
async function saveNewPreset() {
  const name = qs('#savePresetName').value.trim();
  if (!name) return;
  const slug = slugifyName(name);
  if (!slug) { toast('Invalid preset name', 'warn'); return; }
  const presetConfig = { ...state.config };
  delete presetConfig.resolvedTheme;
  const res = await api('PUT', '/api/presets/' + encodeURIComponent(slug), {
    name, config: presetConfig,
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
  const option = sel.options[sel.selectedIndex];
  if (option?.dataset.readOnly === 'true') {
    toast('Built-in presets cannot be deleted', 'warn');
    return;
  }
  const name = sel.options[sel.selectedIndex].textContent;
  if (!confirm(`Delete preset "${name}"?`)) return;
  const res = await api('DELETE', '/api/presets/' + encodeURIComponent(slug));
  if (!res) { toast('Delete failed', 'warn'); return; }
  await refreshPresets();
  toast(`Deleted "${name}"`);
}

// ---------- wire up events ----------
function wire() {
  wireCollapsibleGroups();
  wireThemeCreator();
  window.addEventListener('resize', syncCollapsibleGroups);
  window.addEventListener('resize', scheduleThemeCreatorLayoutSync);
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
  qs('#themeModalNewBtn').onclick = () => openCreateThemePackPicker();
  qs('#themeModalClose').onclick = () => closeThemeModal();
  qs('#themeModalBackdrop').onclick = () => closeThemeModal();


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
  qs('#slider-keycapscale').oninput = e => {
    const value = +e.target.value;
    qs('#val-keycapscale').textContent = value.toFixed(2) + '×';
    mutateTheme((theme) => {
      theme.defaults = theme.defaults || {};
      theme.defaults.keycapScale = value;
    }, { renderMode: 'theme' });
    updateExportURL();
  };
  qs('#slider-captionscale').oninput = e => {
    const value = +e.target.value;
    qs('#val-captionscale').textContent = value.toFixed(2) + '×';
    mutateTheme((theme) => {
      theme.defaults = theme.defaults || {};
      theme.defaults.captionScale = value;
    }, { renderMode: 'theme' });
    updateExportURL();
  };
  qs('#slider-captiongap').oninput   = e => { state.config.captionGap = +e.target.value; applyOverlayVars(); qs('#val-captiongap').textContent = state.config.captionGap + 'px'; saveState(); scheduleConfigPush(); };

  // pill groups
  qs('#fadeSelect').onchange = e => {
    const value = e.target.value;
    state.config.fade = value;
    mutateTheme((theme) => {
      theme.defaults = theme.defaults || {};
      theme.defaults.motion = {
        ...(theme.defaults.motion || {}),
        enter: value,
        exit: value,
        reduced: ['slam', 'overshoot', 'split-in', 'scan-in', 'flash-cut', 'glitch-burst', 'pixel-pop', 'crt-smear'].includes(value) ? 'fade' : value,
      };
      theme.defaults.fade = value;
      ['keycap', 'caption'].forEach((part) => {
        theme[part] = theme[part] || {};
        theme[part].motion = {
          ...(theme[part].motion || {}),
          enter: value,
          exit: value,
          reduced: theme.defaults.motion.reduced,
        };
      });
    });
    demoAnimation();
  };
  qs('#slider-fontweight').oninput = e => {
    const value = +e.target.value;
    qs('#val-fontweight').textContent = String(value);
    mutateTheme((theme) => {
      theme.defaults = theme.defaults || {};
      theme.defaults.fontWeight = value;
    }, { renderMode: 'theme' });
  };
  qsa('#captionTogglePill button').forEach(b => b.onclick = () => {
    state.config.showCaptions = b.dataset.val === 'on';
    renderAll();
    seedPreview();
    saveState();
    scheduleConfigPush();
  });
  qsa('#captionPosPill button').forEach(b => b.onclick = () => {
    qsa('#captionPosPill button').forEach((btn) => btn.classList.toggle('on', btn === b));
    mutateTheme((theme) => {
      theme.defaults = theme.defaults || {};
      theme.defaults.captionPosition = b.dataset.val;
    }, { renderMode: 'theme' });
    seedPreview();
  });

  // font
  qs('#fontFamily').onchange = e => {
    mutateTheme((theme) => {
      theme.defaults = theme.defaults || {};
      theme.defaults.fontFamily = e.target.value;
    }, { renderMode: 'theme' });
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
  if (bridge?.windowMinimize) {
    const winMin = document.getElementById('winMinimize');
    const winMax = document.getElementById('winMaximize');
    const winClose = document.getElementById('winClose');
    if (winMin) winMin.onclick = () => bridge.windowMinimize();
    if (winMax) winMax.onclick = () => bridge.windowToggleMaximize();
    if (winClose) winClose.onclick = () => bridge.windowClose();
    const applyWindowState = (s) => {
      if (!s) return;
      document.body.classList.toggle('is-maximized', !!s.isMaximized);
      document.body.classList.toggle('is-window-focused', !!s.isFocused);
      if (winMax) {
        const label = s.isMaximized ? 'Restore' : 'Maximize';
        winMax.setAttribute('aria-label', label);
        winMax.setAttribute('title', label);
      }
    };
    if (bridge.windowGetState) bridge.windowGetState().then(applyWindowState).catch(() => {});
    if (bridge.onWindowState) bridge.onWindowState(applyWindowState);
  } else {
    const wc = document.getElementById('windowControls');
    if (wc) wc.style.display = 'none';
  }
  qs('#closeModalBtn').onclick = () => closeHelpModal();
  qs('#modalSetup').onclick = (e) => { if (e.target.id === 'modalSetup') closeHelpModal(); };

  // profile dropdown
  qs('#profileSelect').onchange = (e) => {
    state.activeProfile = e.target.value;
    resetKmComposer();
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
    state.profiles[slug] = normalizeProfile({ name, match, keys: {} });
    state.activeProfile = slug;
    qs('#modalNewProfile').classList.remove('on');
    resetKmComposer();
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
  qs('#exportBtn').onclick = () => handleExport();

  const kmDescInput = getKmDescInput();
  if (kmDescInput) {
    kmDescInput.addEventListener('input', () => syncKmComposer());
    kmDescInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitKmDraft();
      }
    });
  }
  const kmAddBtn = qs('#kmAddBtn');
  if (kmAddBtn) kmAddBtn.onclick = () => commitKmDraft();

  // add-row capture
  qs('#captureBtn').onclick = () => {
    state.capturing = !state.capturing;
    qs('#captureBtn').classList.toggle('active', state.capturing);
    qs('#captureBtn').textContent = state.capturing ? '● listening… press a combo' : '◎ click to capture combo';
  };
  qs('#captureBtn').addEventListener('click', () => syncKmComposer());
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
    const descInput = getKmDescInput();
    const existing = getHotkeyDescription(state.profiles[state.activeProfile], combo, { allowDisabled: true }) || '';
    state.kmDraftCombo = combo;
    state.capturing = false;
    if (descInput) {
      descInput.value = existing;
      descInput.focus();
      descInput.select();
    }
    syncKmComposer();
    return;
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

function handleExport() {
  const profile = state.profiles[state.activeProfile];
  if (!profile) { toast('No active profile to export', 'warn'); return; }
  const entries = Object.keys(profile.keys || {});
  if (!entries.length) { toast('Profile has no hotkeys to export', 'warn'); return; }
  const payload = {
    name: profile.name || state.activeProfile,
    match: Array.isArray(profile.match) ? profile.match : [],
    keys: profile.keys,
    exportedAt: new Date().toISOString(),
    exportedBy: 'KeyCap',
  };
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safeName = (payload.name || 'profile').toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '') || 'profile';
  a.href = url;
  a.download = `${safeName}-hotkeys.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`Exported ${entries.length} hotkeys`);
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
        imported = normalizeHotkeyMap(data.keys ?? data);
        label = data.name ? `"${data.name}"` : file.name;
      } catch {
        toast('Invalid JSON file', 'warn');
        return;
      }
    } else {
      // assume ZBrush .txt format
      imported = normalizeHotkeyMap(parseZBrushHotkeys(text));
      label = 'ZBrush hotkeys';
    }

    const count = Object.keys(imported).length;
    if (!count) { toast('No importable hotkeys found', 'warn'); return; }

    // merge into active profile
    const profile = state.profiles[state.activeProfile];
    Object.assign(profile.keys, normalizeHotkeyMap(imported));
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
trimLegacyOverrideRows();
if (bridge?.onAppEvent) {
  bridge.onAppEvent(handleAppEvent);
} else {
  connectUpdaterWs();
}

(async () => {
  await loadShellState();
  await loadUpdateStatus();
  await loadRemoteConfig();
  await loadThemes();
  await loadPacks();
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
    await setMode(state.mode, { persist: false, autoStart: false, quietStart: true });
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
  if (state.recordingTimerId) {
    clearInterval(state.recordingTimerId);
    state.recordingTimerId = 0;
  }
  stopRecordingPreview();
});

