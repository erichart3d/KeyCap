/**
 * Config load/save + key/modifier tables.
 * Mirrors overlay_server.py's DEFAULT_CONFIG, NAV_KEYS, KEY_DISPLAY, CANONICAL_KEY.
 */
const fs   = require('fs');
const path = require('path');

const ROOT            = path.resolve(__dirname, '..');
const CONFIG_PATH     = path.join(ROOT, 'config.json');
const KEYMAP_DIR      = path.join(ROOT, 'keymaps');
const EDITOR_DIR      = path.join(ROOT, 'editor');
const OVERLAY_HTML    = path.join(ROOT, 'overlay.html');
const BACKGROUNDS_DIR = path.join(ROOT, 'Backgrounds');

const DEFAULT_CONFIG = {
  theme: 'vhs',
  bg: '#ff2e9a',
  border: '#00f0ff',
  glow: '#b967ff',
  scanlines: true,
  fontFamily: 'Menlo',
  fontWeight: 700,
  position: 'bottom-center',
  margin: 60,      // legacy — kept so old configs still work
  marginY: 60,
  marginX: 0,
  scale: 1.0,
  opacity: 1.0,
  keycapScale: 1.0,
  captionScale: 1.0,
  maxKeys: 4,
  lifetime: 2200,
  fade: 'glitch',
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      return { ...DEFAULT_CONFIG, ...data };
    }
  } catch (err) {
    console.log(`  [config]     couldn't read config.json (${err.message}); using defaults`);
  }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  } catch (err) {
    console.log(`  [config]     write failed: ${err.message}`);
  }
}

// Only accept keys in DEFAULT_CONFIG when merging PUT /api/config payloads
function mergeKnown(target, incoming) {
  for (const [k, v] of Object.entries(incoming || {})) {
    if (k in DEFAULT_CONFIG) target[k] = v;
  }
}

// ─── Key filtering tables (ported from overlay_server.py) ───────────────────

const NAV_KEYS = new Set([
  'esc', 'escape', 'enter', 'return', 'tab', 'space', 'backspace',
  'delete', 'del', 'insert', 'ins',
  'home', 'end', 'page up', 'page down',
  'up', 'down', 'left', 'right',
  'f1','f2','f3','f4','f5','f6','f7','f8','f9','f10','f11','f12',
  'f13','f14','f15','f16',
  'print screen', 'scroll lock', 'pause', 'break',
  'menu',
]);

const KEY_DISPLAY = {
  'up': '↑', 'down': '↓', 'left': '←', 'right': '→',
  'page up': 'PGUP', 'page down': 'PGDN',
  'esc': 'ESC', 'escape': 'ESC',
  'enter': 'ENTER', 'return': 'ENTER',
  'tab': 'TAB', 'space': 'SPACE',
  'backspace': 'BKSP',
  'delete': 'DEL', 'del': 'DEL',
  'insert': 'INS', 'ins': 'INS',
  'home': 'HOME', 'end': 'END',
  'print screen': 'PRTSC',
  'scroll lock': 'SCRLK',
  'pause': 'PAUSE', 'break': 'PAUSE',
  'menu': 'MENU',
};

// Canonical key name used for keymap lookup (matches JSON keymap keys)
const CANONICAL_KEY = {
  'escape': 'esc',
  'return': 'enter',
  'del': 'delete',
  'ins': 'insert',
  'break': 'pause',
};

module.exports = {
  ROOT, CONFIG_PATH, KEYMAP_DIR, EDITOR_DIR, OVERLAY_HTML, BACKGROUNDS_DIR,
  DEFAULT_CONFIG, loadConfig, saveConfig, mergeKnown,
  NAV_KEYS, KEY_DISPLAY, CANONICAL_KEY,
};
