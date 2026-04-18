/**
 * Win32 foreground-window exe detection via koffi.
 * Validated in prototype/ — calls native Win32 synchronously, no subprocess.
 */
const koffi = require('koffi');
const path  = require('path');

const user32   = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');

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

// Real-time modifier state (bypasses uiohook's stateful tracking — more accurate
// when modifiers are held across hook start/stop or focus changes).
const GetAsyncKeyState = user32.func('int16 GetAsyncKeyState(int vKey)');

const VK = { CONTROL: 0x11, SHIFT: 0x10, MENU: 0x12, LWIN: 0x5B, RWIN: 0x5C };

const PROCESS_QUERY_LIMITED = 0x1000;

function foregroundExe() {
  try {
    const hwnd = GetForegroundWindow();
    if (!hwnd) return null;

    const pid = [0];
    GetWindowThreadProcessId(hwnd, pid);
    if (!pid[0]) return null;

    const hProc = OpenProcess(PROCESS_QUERY_LIMITED, false, pid[0]);
    if (!hProc) return null;

    const buf  = Buffer.alloc(1024);
    const size = [512];
    const ok   = QueryFullProcessImageNameW(hProc, 0, buf, size);
    CloseHandle(hProc);

    if (!ok || !size[0]) return null;

    const fullPath = buf.slice(0, size[0] * 2).toString('utf16le');
    return path.basename(fullPath).toLowerCase();
  } catch (_) {
    return null;
  }
}

function isModifierPressed(vk) {
  return (GetAsyncKeyState(vk) & 0x8000) !== 0;
}

function currentMods() {
  const mods = [];
  if (isModifierPressed(VK.CONTROL)) mods.push('CTRL');
  if (isModifierPressed(VK.SHIFT))   mods.push('SHIFT');
  if (isModifierPressed(VK.MENU))    mods.push('ALT');
  if (isModifierPressed(VK.LWIN) || isModifierPressed(VK.RWIN)) mods.push('WIN');
  return mods;
}

module.exports = { foregroundExe, currentMods, VK };
