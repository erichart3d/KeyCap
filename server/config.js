/**
 * Config load/save + key/modifier tables.
 * Mirrors overlay_server.py's DEFAULT_CONFIG, NAV_KEYS, KEY_DISPLAY, CANONICAL_KEY.
 */
const fs = require('fs');
const path = require('path');
const {
  ThemeManager,
  CUSTOM_THEMES_DIR,
  migrateLegacyConfig,
  resolveConfigTheme,
} = require('./themes');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const KEYMAP_DIR = path.join(ROOT, 'keymaps');
const PRESETS_DIR = path.join(ROOT, 'presets');
const EDITOR_DIR = path.join(ROOT, 'editor');
const OVERLAY_HTML = path.join(ROOT, 'overlay.html');
const BACKGROUNDS_DIR = path.join(ROOT, 'Backgrounds');
const DEFAULT_FONT_FAMILY = "'Menlo', 'Consolas', monospace";
const themeManager = new ThemeManager(CUSTOM_THEMES_DIR);

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
  return {
    ...normalized,
    resolvedTheme: resolveConfigTheme(normalized, themeManager),
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
  ROOT,
  CONFIG_PATH,
  KEYMAP_DIR,
  PRESETS_DIR,
  EDITOR_DIR,
  OVERLAY_HTML,
  BACKGROUNDS_DIR,
  DEFAULT_CONFIG,
  loadConfig,
  saveConfig,
  mergeKnown,
  withResolvedTheme,
  themeManager,
  NAV_KEYS,
  KEY_DISPLAY,
  CANONICAL_KEY,
};
