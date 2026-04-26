/**
 * Config load/save + key/modifier tables.
 * Mirrors overlay_server.py's DEFAULT_CONFIG, NAV_KEYS, KEY_DISPLAY, CANONICAL_KEY.
 */
const fs = require('fs');
const path = require('path');
const {
  APP_ROOT,
  DATA_ROOT,
  ThemeManager,
  CUSTOM_THEMES_DIR,
  migrateLegacyConfig,
  resolveConfigTheme,
  resolveTheme,
} = require('./themes');

const { PackManager, resolveConfigPack } = require('./packs');

const ROOT = DATA_ROOT;
const CONFIG_PATH = path.join(DATA_ROOT, 'config.json');
const KEYMAP_DIR = path.join(DATA_ROOT, 'keymaps');
const PRESETS_DIR = path.join(DATA_ROOT, 'presets');
const PACKS_DIR = path.join(APP_ROOT, 'packs');
const CUSTOM_PACKS_DIR = path.join(DATA_ROOT, 'customPacks');
const EDITOR_DIR = path.join(APP_ROOT, 'editor');
const OVERLAY_HTML = path.join(APP_ROOT, 'overlay.html');
const BACKGROUNDS_DIR = path.join(APP_ROOT, 'Backgrounds');
const DEFAULT_FONT_FAMILY = "'Menlo', 'Consolas', monospace";

function copyLegacyStateIfMissing(source, target) {
  if (!fs.existsSync(source)) return;
  const stats = fs.statSync(source);
  if (stats.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      copyLegacyStateIfMissing(path.join(source, entry.name), path.join(target, entry.name));
    }
    return;
  }
  if (fs.existsSync(target)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function migrateWritableState() {
  if (DATA_ROOT === APP_ROOT) return;
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  copyLegacyStateIfMissing(path.join(APP_ROOT, 'config.json'), CONFIG_PATH);
  copyLegacyStateIfMissing(path.join(APP_ROOT, 'keymaps'), KEYMAP_DIR);
  copyLegacyStateIfMissing(path.join(APP_ROOT, 'presets'), PRESETS_DIR);
  copyLegacyStateIfMissing(path.join(APP_ROOT, 'customThemes'), CUSTOM_THEMES_DIR);
}

migrateWritableState();

const themeManager = new ThemeManager(CUSTOM_THEMES_DIR);
const packManager = new PackManager({
  builtinDir: PACKS_DIR,
  customDir: CUSTOM_PACKS_DIR,
  themeManager,
});

function normalizeFontFamily(value) {
  const raw = String(value || '').trim();
  if (!raw) return DEFAULT_FONT_FAMILY;

  const normalized = raw.replace(/\s+/g, ' ').trim();
  const aliases = new Map([
    ['menlo', DEFAULT_FONT_FAMILY],
    ["'menlo'", DEFAULT_FONT_FAMILY],
    ['system mono', DEFAULT_FONT_FAMILY],
    ["'jetbrains mono', monospace", "'JetBrains Mono', monospace"],
    ['jetbrains mono', "'JetBrains Mono', monospace"],
  ]);

  return aliases.get(normalized.toLowerCase()) || normalized;
}

function normalizeConfig(cfg) {
  return {
    ...cfg,
    fontFamily: normalizeFontFamily(cfg?.fontFamily),
  };
}

const DEFAULT_CONFIG = {
  theme: 'keycap',
  themeData: null,
  pack: null,
  packData: null,
  fontFamily: DEFAULT_FONT_FAMILY,
  fontWeight: 700,
  position: 'bottom-center',
  margin: 60,
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

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      const migrated = migrateLegacyConfig(data, themeManager);
      const next = normalizeConfig({ ...DEFAULT_CONFIG, ...migrated.config });
      if (migrated.changed) saveConfig(next);
      return next;
    }
  } catch (err) {
    console.log(`  [config]     couldn't read config.json (${err.message}); using defaults`);
  }
  return normalizeConfig({ ...DEFAULT_CONFIG });
}

function saveConfig(cfg) {
  try {
    const normalized = normalizeConfig(cfg);
    const payload = {};
    Object.keys(DEFAULT_CONFIG).forEach((key) => {
      payload[key] = normalized[key];
    });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(payload, null, 2), 'utf8');
  } catch (err) {
    console.log(`  [config]     write failed: ${err.message}`);
  }
}

function mergeKnown(target, incoming) {
  for (const [key, value] of Object.entries(incoming || {})) {
    if (key in DEFAULT_CONFIG) target[key] = value;
  }
  target.fontFamily = normalizeFontFamily(target.fontFamily);
}

function withResolvedTheme(cfg) {
  const normalized = normalizeConfig(cfg);
  const resolvedTheme = resolveConfigTheme(normalized, themeManager);
  // Pack resolution: explicit pack/packData wins; otherwise pack slug + theme
  // parameterValues; otherwise an empty-chrome pack wrapping the resolved
  // theme. themeManager is passed so the resolver can read __parameterValues
  // off the active theme and apply them to the pack template.
  const resolvedPack = resolveConfigPack(normalized, packManager, resolvedTheme, themeManager);
  if (resolvedPack && (!resolvedPack.keycapTheme || Object.keys(resolvedPack.keycapTheme).length === 0)) {
    resolvedPack.keycapTheme = resolvedTheme;
  }
  // NOTE: Don't merge `resolveTheme()` into pack.keycapTheme here — the
  // client's compileThemeCss does its own deep-merge, and the server's
  // DEFAULT_THEME has fields (`textEffect`) that flip the renderer into the
  // structured-section code path and override the pack's flat `keycap.fill`.
  return {
    ...normalized,
    resolvedTheme,
    resolvedPack,
  };
}

const NAV_KEYS = new Set([
  'esc', 'escape', 'enter', 'return', 'tab', 'space', 'backspace',
  'delete', 'del', 'insert', 'ins',
  'home', 'end', 'page up', 'page down',
  'up', 'down', 'left', 'right',
  'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12',
  'f13', 'f14', 'f15', 'f16',
  'print screen', 'scroll lock', 'pause', 'break',
  'menu',
]);

const KEY_DISPLAY = {
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  'page up': 'PGUP',
  'page down': 'PGDN',
  esc: 'ESC',
  escape: 'ESC',
  enter: 'ENTER',
  return: 'ENTER',
  tab: 'TAB',
  space: 'SPACE',
  backspace: 'BKSP',
  delete: 'DEL',
  del: 'DEL',
  insert: 'INS',
  ins: 'INS',
  home: 'HOME',
  end: 'END',
  'print screen': 'PRTSC',
  'scroll lock': 'SCRLK',
  pause: 'PAUSE',
  break: 'PAUSE',
  menu: 'MENU',
};

const CANONICAL_KEY = {
  escape: 'esc',
  return: 'enter',
  del: 'delete',
  ins: 'insert',
  break: 'pause',
};

module.exports = {
  APP_ROOT,
  DATA_ROOT,
  ROOT,
  CONFIG_PATH,
  KEYMAP_DIR,
  PRESETS_DIR,
  PACKS_DIR,
  CUSTOM_PACKS_DIR,
  EDITOR_DIR,
  OVERLAY_HTML,
  BACKGROUNDS_DIR,
  DEFAULT_CONFIG,
  loadConfig,
  saveConfig,
  mergeKnown,
  withResolvedTheme,
  themeManager,
  packManager,
  NAV_KEYS,
  KEY_DISPLAY,
  CANONICAL_KEY,
};
