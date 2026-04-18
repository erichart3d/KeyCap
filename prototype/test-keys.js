/**
 * KeyCap — Node.js keyboard hook prototype
 *
 * Tests:
 *  1. Global key capture (fires even when another app has focus)
 *  2. Modifier detection (Ctrl / Shift / Alt)
 *  3. Combo formatting  e.g.  "CTRL + Z"
 *  4. Foreground window exe detection
 *
 * Run: npm test
 * Press keys in any app — output appears in this terminal.
 * Ctrl+C to exit.
 */

const { uIOhook, UiohookKey } = require('uiohook-napi');
const koffi = require('koffi');
const path  = require('path');

// ─── Foreground window detection — direct Win32 via koffi ───────────────────
// No subprocess = no focus stealing, no "powershell.exe" false positives.
// This is the same approach we'll use in the final Electron app.

const user32   = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');

// _Out_ / _Inout_ tell koffi to copy data back to JS after the call.
const GetForegroundWindow      = user32.func('void* GetForegroundWindow()');
const GetWindowThreadProcessId = user32.func(
  'uint32 GetWindowThreadProcessId(void* hWnd, _Out_ uint32* lpdwProcessId)'
);
const OpenProcess = kernel32.func(
  'void* OpenProcess(uint32 dwDesiredAccess, bool bInheritHandle, uint32 dwProcessId)'
);
const CloseHandle = kernel32.func('bool CloseHandle(void* hObject)');
const QueryFullProcessImageNameW = kernel32.func(
  'bool QueryFullProcessImageNameW(void* hProcess, uint32 dwFlags, _Out_ uint8* lpExeName, _Inout_ uint32* lpdwSize)'
);

const PROCESS_QUERY_LIMITED = 0x1000;

function getForegroundExe() {
  try {
    const hwnd = GetForegroundWindow();
    if (!hwnd) return 'unknown';

    const pid = [0];
    GetWindowThreadProcessId(hwnd, pid);
    if (!pid[0]) return 'unknown';

    const hProc = OpenProcess(PROCESS_QUERY_LIMITED, false, pid[0]);
    if (!hProc) return 'unknown';

    const buf  = Buffer.alloc(1024);
    const size = [512];
    const ok   = QueryFullProcessImageNameW(hProc, 0, buf, size);
    CloseHandle(hProc);

    if (!ok || !size[0]) return 'unknown';

    const fullPath = buf.slice(0, size[0] * 2).toString('utf16le');
    return path.basename(fullPath).toLowerCase();
  } catch (_) {
    return 'unknown';
  }
}

// ─── Key code → label ────────────────────────────────────────────────────────
// uiohook-napi gives us numeric keycodes. Map common ones to readable names.
// Full list: https://github.com/kwhat/libuiohook/blob/main/include/uiohook.h

const KEY_LABELS = {
  [UiohookKey.A]: 'a', [UiohookKey.B]: 'b', [UiohookKey.C]: 'c',
  [UiohookKey.D]: 'd', [UiohookKey.E]: 'e', [UiohookKey.F]: 'f',
  [UiohookKey.G]: 'g', [UiohookKey.H]: 'h', [UiohookKey.I]: 'i',
  [UiohookKey.J]: 'j', [UiohookKey.K]: 'k', [UiohookKey.L]: 'l',
  [UiohookKey.M]: 'm', [UiohookKey.N]: 'n', [UiohookKey.O]: 'o',
  [UiohookKey.P]: 'p', [UiohookKey.Q]: 'q', [UiohookKey.R]: 'r',
  [UiohookKey.S]: 's', [UiohookKey.T]: 't', [UiohookKey.U]: 'u',
  [UiohookKey.V]: 'v', [UiohookKey.W]: 'w', [UiohookKey.X]: 'x',
  [UiohookKey.Y]: 'y', [UiohookKey.Z]: 'z',

  [UiohookKey.Num0]: '0', [UiohookKey.Num1]: '1', [UiohookKey.Num2]: '2',
  [UiohookKey.Num3]: '3', [UiohookKey.Num4]: '4', [UiohookKey.Num5]: '5',
  [UiohookKey.Num6]: '6', [UiohookKey.Num7]: '7', [UiohookKey.Num8]: '8',
  [UiohookKey.Num9]: '9',

  [UiohookKey.Space]:  'space',
  [UiohookKey.Enter]:  'enter',
  [UiohookKey.Escape]: 'escape',
  [UiohookKey.Tab]:    'tab',
  [UiohookKey.Backspace]: 'backspace',
  [UiohookKey.Delete]: 'delete',

  [UiohookKey.ArrowUp]:    'up',
  [UiohookKey.ArrowDown]:  'down',
  [UiohookKey.ArrowLeft]:  'left',
  [UiohookKey.ArrowRight]: 'right',

  [UiohookKey.F1]:  'f1',  [UiohookKey.F2]:  'f2',  [UiohookKey.F3]:  'f3',
  [UiohookKey.F4]:  'f4',  [UiohookKey.F5]:  'f5',  [UiohookKey.F6]:  'f6',
  [UiohookKey.F7]:  'f7',  [UiohookKey.F8]:  'f8',  [UiohookKey.F9]:  'f9',
  [UiohookKey.F10]: 'f10', [UiohookKey.F11]: 'f11', [UiohookKey.F12]: 'f12',

  // Punctuation — uiohook uses US layout codes
  0x29: '`',  0x02: '1',  0x0C: '-',  0x0D: '=',
  0x1A: '[',  0x1B: ']',  0x2B: '\\',
  0x27: ';',  0x28: "'",
  0x33: ',',  0x34: '.',  0x35: '/',
};

// Modifier key codes — we track these separately, don't emit them as solo keys
const MODIFIER_CODES = new Set([
  UiohookKey.Ctrl,   UiohookKey.CtrlRight,
  UiohookKey.Shift,  UiohookKey.ShiftRight,
  UiohookKey.Alt,    UiohookKey.AltRight,
  UiohookKey.Meta,   UiohookKey.MetaRight,
]);

// ─── Modifier state ──────────────────────────────────────────────────────────
const mods = { ctrl: false, shift: false, alt: false, meta: false };

function updateMod(keycode, down) {
  if (keycode === UiohookKey.Ctrl  || keycode === UiohookKey.CtrlRight)  mods.ctrl  = down;
  if (keycode === UiohookKey.Shift || keycode === UiohookKey.ShiftRight) mods.shift = down;
  if (keycode === UiohookKey.Alt   || keycode === UiohookKey.AltRight)   mods.alt   = down;
  if (keycode === UiohookKey.Meta  || keycode === UiohookKey.MetaRight)  mods.meta  = down;
}

// ─── Combo formatter — matches Python server output ─────────────────────────
function formatCombo(baseLabel) {
  const parts = [];
  if (mods.ctrl)  parts.push('ctrl');
  if (mods.shift) parts.push('shift');
  if (mods.alt)   parts.push('alt');
  if (mods.meta)  parts.push('meta');
  parts.push(baseLabel);
  // Single modifier-only presses are filtered before we get here
  return parts.join('+');  // e.g. "ctrl+z", "shift+d", "ctrl+shift+z"
}

// koffi Win32 calls are synchronous and take ~microseconds — no caching needed.
function currentExe() {
  return getForegroundExe();
}

// ─── Main ────────────────────────────────────────────────────────────────────
console.log('KeyCap prototype — press keys in any app (Ctrl+C here to quit)\n');

uIOhook.on('keydown', (e) => {
  updateMod(e.keycode, true);
  if (MODIFIER_CODES.has(e.keycode)) return; // skip bare modifier presses

  const label = KEY_LABELS[e.keycode];
  if (!label) {
    // Unknown keycode — log the raw value so we can add it to the map
    console.log(`[unknown keycode 0x${e.keycode.toString(16).padStart(4, '0')}]`);
    return;
  }

  const combo = formatCombo(label);
  const exe   = currentExe();

  console.log(`key: ${combo.padEnd(24)} | app: ${exe}`);
});

uIOhook.on('keyup', (e) => {
  updateMod(e.keycode, false);
});

uIOhook.start();

// Graceful shutdown on Ctrl+C
process.on('SIGINT', () => {
  uIOhook.stop();
  console.log('\nStopped.');
  process.exit(0);
});
