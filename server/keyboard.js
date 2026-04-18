/**
 * KeyboardHook — uiohook-napi global key capture wired to KeymapManager.
 *
 * Ports overlay_server.py's on_key_press / _build_event logic:
 *   - Real modifier state via Win32 GetAsyncKeyState (more reliable than
 *     tracking from uiohook events — correct even when modifiers are held
 *     before the hook starts)
 *   - ONLY_ANNOTATED filter: only emit keys that have a description in the
 *     active keymap profile
 *   - Auto-repeat suppression (50 ms window, same as Python)
 *   - Emits 'key' events: { label, description }
 */

const EventEmitter  = require('events');
const { uIOhook, UiohookKey } = require('uiohook-napi');
const { currentMods } = require('./win32');
const { NAV_KEYS, KEY_DISPLAY, CANONICAL_KEY } = require('./config');

// ─── uiohook keycode → canonical key name ────────────────────────────────────
// Canonical names match the keys used in keymap JSON files.
const KEY_NAMES = {
  // Letters
  [UiohookKey.A]: 'a', [UiohookKey.B]: 'b', [UiohookKey.C]: 'c',
  [UiohookKey.D]: 'd', [UiohookKey.E]: 'e', [UiohookKey.F]: 'f',
  [UiohookKey.G]: 'g', [UiohookKey.H]: 'h', [UiohookKey.I]: 'i',
  [UiohookKey.J]: 'j', [UiohookKey.K]: 'k', [UiohookKey.L]: 'l',
  [UiohookKey.M]: 'm', [UiohookKey.N]: 'n', [UiohookKey.O]: 'o',
  [UiohookKey.P]: 'p', [UiohookKey.Q]: 'q', [UiohookKey.R]: 'r',
  [UiohookKey.S]: 's', [UiohookKey.T]: 't', [UiohookKey.U]: 'u',
  [UiohookKey.V]: 'v', [UiohookKey.W]: 'w', [UiohookKey.X]: 'x',
  [UiohookKey.Y]: 'y', [UiohookKey.Z]: 'z',

  // Top-row numbers
  [UiohookKey.Num1]: '1', [UiohookKey.Num2]: '2', [UiohookKey.Num3]: '3',
  [UiohookKey.Num4]: '4', [UiohookKey.Num5]: '5', [UiohookKey.Num6]: '6',
  [UiohookKey.Num7]: '7', [UiohookKey.Num8]: '8', [UiohookKey.Num9]: '9',
  [UiohookKey.Num0]: '0',

  // Navigation & whitespace
  [UiohookKey.Space]:     'space',
  [UiohookKey.Enter]:     'enter',
  [UiohookKey.Escape]:    'escape',
  [UiohookKey.Tab]:       'tab',
  [UiohookKey.Backspace]: 'backspace',
  [UiohookKey.Delete]:    'delete',
  [UiohookKey.Insert]:    'insert',
  [UiohookKey.Home]:      'home',
  [UiohookKey.End]:       'end',
  [UiohookKey.PageUp]:    'page up',
  [UiohookKey.PageDown]:  'page down',

  // Arrow keys
  [UiohookKey.ArrowUp]:    'up',
  [UiohookKey.ArrowDown]:  'down',
  [UiohookKey.ArrowLeft]:  'left',
  [UiohookKey.ArrowRight]: 'right',

  // Function keys
  [UiohookKey.F1]:  'f1',  [UiohookKey.F2]:  'f2',  [UiohookKey.F3]:  'f3',
  [UiohookKey.F4]:  'f4',  [UiohookKey.F5]:  'f5',  [UiohookKey.F6]:  'f6',
  [UiohookKey.F7]:  'f7',  [UiohookKey.F8]:  'f8',  [UiohookKey.F9]:  'f9',
  [UiohookKey.F10]: 'f10', [UiohookKey.F11]: 'f11', [UiohookKey.F12]: 'f12',

  // Punctuation (US layout)
  [UiohookKey.Minus]:         '-',
  [UiohookKey.Equal]:         '=',
  [UiohookKey.BracketLeft]:   '[',
  [UiohookKey.BracketRight]:  ']',
  [UiohookKey.Backslash]:     '\\',
  [UiohookKey.Semicolon]:     ';',
  [UiohookKey.Quote]:         "'",
  [UiohookKey.Comma]:         ',',
  [UiohookKey.Period]:        '.',
  [UiohookKey.Slash]:         '/',
  [UiohookKey.Backquote]:     '`',

  // Print Screen / Scroll Lock / Pause
  [UiohookKey.PrintScreen]:   'print screen',
  [UiohookKey.ScrollLock]:    'scroll lock',
  [UiohookKey.Pause]:         'pause',
};

// Modifier keycodes — never emitted as standalone key events
const MODIFIER_CODES = new Set([
  UiohookKey.Ctrl,        UiohookKey.CtrlRight,
  UiohookKey.Shift,       UiohookKey.ShiftRight,
  UiohookKey.Alt,         UiohookKey.AltRight,
  UiohookKey.Meta,        UiohookKey.MetaRight,
  UiohookKey.CapsLock,
]);

const MODE              = 'all';       // 'all' | 'hotkeys'
const AUTO_REPEAT_MS    = 50;

class KeyboardHook extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('./keymaps').KeymapManager} opts.keymaps
   * @param {boolean} [opts.onlyAnnotated=true]
   */
  constructor({ keymaps, onlyAnnotated = true }) {
    super();
    this.keymaps       = keymaps;
    this.onlyAnnotated = onlyAnnotated;
    this._lastPress    = new Map();   // keyName → timestamp (ms)
    this._running      = false;
    this._onKeydown    = this._onKeydown.bind(this);
  }

  start() {
    if (this._running) return;
    this._running = true;
    uIOhook.on('keydown', this._onKeydown);
    uIOhook.start();
    console.log('  [keyboard]   hook started');
  }

  stop() {
    if (!this._running) return;
    this._running = false;
    uIOhook.removeListener('keydown', this._onKeydown);
    uIOhook.stop();
    console.log('  [keyboard]   hook stopped');
  }

  // ── private ──────────────────────────────────────────────────────────────

  _onKeydown(e) {
    if (MODIFIER_CODES.has(e.keycode)) return;

    const keyName = KEY_NAMES[e.keycode];
    if (!keyName) return;   // unmapped key — ignore silently

    // Auto-repeat suppression
    const now  = Date.now();
    const last = this._lastPress.get(keyName) || 0;
    if (now - last < AUTO_REPEAT_MS) return;
    this._lastPress.set(keyName, now);

    const result = this._buildEvent(keyName);
    if (!result) return;

    const [label, description] = result;
    const tag = description ? `${label}  (${description})` : label;
    console.log(`  [emit]       ${tag}`);
    this.emit('key', { label, description });
  }

  _buildEvent(keyName) {
    // Real modifier state from Win32 GetAsyncKeyState
    const mods = currentMods();  // e.g. ['CTRL', 'SHIFT']

    // In 'hotkeys' mode suppress bare letter/number presses
    if (MODE === 'hotkeys') {
      const isNav      = NAV_KEYS.has(keyName);
      const hasRealMod = mods.some(m => m !== 'SHIFT');
      if (!isNav && !hasRealMod) return null;
    }

    // Display label shown on the overlay: "CTRL + Z"
    const displayKey = KEY_DISPLAY[keyName] || keyName.toUpperCase();
    const label      = mods.length
      ? [...mods, displayKey].join(' + ')
      : displayKey;

    // Lookup combo used to find the keymap description: "ctrl+z"
    const canonical = (CANONICAL_KEY[keyName] || keyName).replace(/\s+/g, '');
    const combo     = [...mods.map(m => m.toLowerCase()), canonical].join('+');

    const description = this.keymaps.describe(combo);
    if (this.onlyAnnotated && !description) return null;

    return [label, description];
  }
}

module.exports = { KeyboardHook };
