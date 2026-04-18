"""
VHS Key Overlay — server (v6)

New in v6:
- Mounts the KeyCap Editor at /editor  (a small web UI for live-tweaking the
  overlay look, authoring keymaps, and driving test keypresses).
- Adds a small JSON API:
      GET  /api/status               server + focused-app info
      GET  /api/config               overlay visual config
      PUT  /api/config               save config (persisted to config.json)
      GET  /api/keymaps              list all profiles with their keys
      PUT  /api/keymaps/<name>       create/update a profile (writes keymaps/<name>.json)
      DELETE /api/keymaps/<name>     remove a profile
      POST /api/test-key             body: {label, description?} — push a
                                     synthetic keypress into the overlay stream
                                     (used by the editor's "Test" buttons)
- Overlay visuals can now be configured via URL params OR via config.json
  (URL params still win when present).

Earlier features:
- Keymap profiles auto-picked by the focused window's executable
- Hot-reload of keymap JSON files
- Bigger "annotated" caps when a keymap has a description for the combo

MODE toggle:
    'all'     - show every keypress including plain letters/numbers
    'hotkeys' - only show modifier combos and navigation keys
"""

import asyncio
import ctypes
import json
import time
from ctypes import wintypes
from pathlib import Path

import keyboard
from aiohttp import web, WSMsgType

# ---------------------------------------------------------------------------
MODE = 'all'
ONLY_ANNOTATED = True       # only show keys that have a description in the active keymap
ROOT = Path(__file__).parent
KEYMAP_DIR = ROOT / 'keymaps'
EDITOR_DIR = ROOT / 'editor'
BACKGROUNDS_DIR = ROOT / 'Backgrounds'
CONFIG_PATH = ROOT / 'config.json'
KEYMAP_POLL_SECONDS = 1.0   # how often to re-check JSON mtimes & active exe
# ---------------------------------------------------------------------------


DEFAULT_CONFIG = {
    "theme": "vhs",
    "bg": "#ff2e9a",
    "border": "#00f0ff",
    "glow": "#b967ff",
    "scanlines": True,
    "fontFamily": "Menlo",
    "fontWeight": 700,
    "position": "bottom-center",
    "margin": 60,
    "scale": 1.0,
    "opacity": 1.0,
    "maxKeys": 4,
    "lifetime": 2200,
    "fade": "glitch",
}


def load_config() -> dict:
    if CONFIG_PATH.exists():
        try:
            data = json.loads(CONFIG_PATH.read_text(encoding='utf-8'))
            merged = {**DEFAULT_CONFIG, **data}
            return merged
        except (OSError, json.JSONDecodeError) as err:
            print(f"  [config]     couldn't read config.json ({err}); using defaults")
    return dict(DEFAULT_CONFIG)


def save_config(cfg: dict) -> None:
    try:
        CONFIG_PATH.write_text(json.dumps(cfg, indent=2), encoding='utf-8')
    except OSError as err:
        print(f"  [config]     write failed: {err}")


# ---------------------------------------------------------------------------
# Win32 — real-time modifier state + foreground-process lookup
# ---------------------------------------------------------------------------

VK_CONTROL = 0x11
VK_SHIFT = 0x10
VK_MENU = 0x12   # Alt
VK_LWIN = 0x5B
VK_RWIN = 0x5C

PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

try:
    _user32 = ctypes.windll.user32
    _kernel32 = ctypes.windll.kernel32
    _user32.GetAsyncKeyState.restype = ctypes.c_short
    _user32.GetForegroundWindow.restype = wintypes.HWND
    _kernel32.OpenProcess.restype = wintypes.HANDLE
    _kernel32.QueryFullProcessImageNameW.argtypes = [
        wintypes.HANDLE, wintypes.DWORD,
        wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD),
    ]

    def _is_really_pressed(vk: int) -> bool:
        return bool(_user32.GetAsyncKeyState(vk) & 0x8000)

    def _foreground_exe() -> str | None:
        hwnd = _user32.GetForegroundWindow()
        if not hwnd:
            return None
        pid = wintypes.DWORD()
        _user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if not pid.value:
            return None
        handle = _kernel32.OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION, False, pid.value
        )
        if not handle:
            return None
        try:
            size = wintypes.DWORD(512)
            buf = ctypes.create_unicode_buffer(size.value)
            if _kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
                return Path(buf.value).name.lower()
        finally:
            _kernel32.CloseHandle(handle)
        return None

except (AttributeError, OSError):
    def _is_really_pressed(vk: int) -> bool:  # type: ignore
        mapping = {
            VK_CONTROL: 'ctrl', VK_SHIFT: 'shift', VK_MENU: 'alt',
            VK_LWIN: 'left windows', VK_RWIN: 'right windows',
        }
        name = mapping.get(vk)
        return bool(name and keyboard.is_pressed(name))

    def _foreground_exe() -> str | None:  # type: ignore
        return None


# ---------------------------------------------------------------------------
# Key filtering config
# ---------------------------------------------------------------------------

NAV_KEYS = {
    'esc', 'escape', 'enter', 'return', 'tab', 'space', 'backspace',
    'delete', 'del', 'insert', 'ins',
    'home', 'end', 'page up', 'page down',
    'up', 'down', 'left', 'right',
    'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10',
    'f11', 'f12', 'f13', 'f14', 'f15', 'f16',
    'print screen', 'scroll lock', 'pause', 'break',
    'menu',
}

MODIFIER_NAMES = {
    'ctrl', 'left ctrl', 'right ctrl',
    'shift', 'left shift', 'right shift',
    'alt', 'left alt', 'right alt', 'alt gr',
    'windows', 'left windows', 'right windows',
    'cmd', 'command',
}

KEY_DISPLAY = {
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
}

# Canonical key name used for keymap lookup (JSON keys should use these)
CANONICAL_KEY = {
    'escape': 'esc',
    'return': 'enter',
    'del': 'delete',
    'ins': 'insert',
    'break': 'pause',
}

AUTO_REPEAT_WINDOW = 0.05


# ---------------------------------------------------------------------------
# Keymap manager
# ---------------------------------------------------------------------------

class KeymapManager:
    """Loads JSON keymaps from a directory and picks the one matching the
    currently-focused application. Hot-reloads on file change."""

    def __init__(self, directory: Path):
        self.directory = directory
        self.profiles: list[dict] = []      # [{name, match:[exe,...], keys:{...}, file}]
        self.last_signature: tuple = ()
        self.active_profile: dict | None = None
        self.active_exe: str | None = None

    def _directory_signature(self) -> tuple:
        if not self.directory.is_dir():
            return ()
        entries = []
        for p in sorted(self.directory.glob('*.json')):
            try:
                entries.append((p.name, p.stat().st_mtime_ns))
            except OSError:
                pass
        return tuple(entries)

    def reload_if_changed(self) -> bool:
        sig = self._directory_signature()
        if sig == self.last_signature:
            return False
        self.last_signature = sig
        self.profiles = []
        if not self.directory.is_dir():
            print(f"  [keymaps]    no directory at {self.directory} — running without profiles")
            return True
        for path in sorted(self.directory.glob('*.json')):
            try:
                data = json.loads(path.read_text(encoding='utf-8'))
            except (OSError, json.JSONDecodeError) as err:
                print(f"  [keymaps]    skipped {path.name}: {err}")
                continue
            name = data.get('name') or path.stem
            match = data.get('match') or []
            if isinstance(match, str):
                match = [match]
            match = [m.lower() for m in match]
            keys = {k.lower().replace(' ', ''): v for k, v in (data.get('keys') or {}).items()}
            self.profiles.append({'name': name, 'match': match, 'keys': keys, 'file': path.name})
        names = ', '.join(p['name'] for p in self.profiles) or '(none)'
        print(f"  [keymaps]    loaded {len(self.profiles)} profile(s): {names}")
        # Force active re-evaluation against the new profile list
        self.active_profile = None
        self.active_exe = None
        return True

    def update_active(self) -> None:
        exe = _foreground_exe()
        if exe == self.active_exe and self.active_profile is not None:
            return
        if exe != self.active_exe:
            self.active_exe = exe
        chosen = None
        if exe:
            for profile in self.profiles:
                if exe in profile['match']:
                    chosen = profile
                    break
        if chosen is not self.active_profile:
            self.active_profile = chosen
            if chosen:
                print(f"  [profile]    -> {chosen['name']}  ({exe})")
            else:
                print(f"  [profile]    -> (none)  ({exe or 'unknown'})")

    def describe(self, combo_key: str) -> str | None:
        if not self.active_profile:
            return None
        return self.active_profile['keys'].get(combo_key)

    def write_profile(self, slug: str, data: dict) -> Path:
        self.directory.mkdir(parents=True, exist_ok=True)
        path = self.directory / f"{slug}.json"
        payload = {
            "name": data.get("name") or slug,
            "match": data.get("match") or [],
            "keys": data.get("keys") or {},
        }
        path.write_text(json.dumps(payload, indent=2), encoding='utf-8')
        return path

    def delete_profile(self, slug: str) -> bool:
        path = self.directory / f"{slug}.json"
        if path.exists():
            path.unlink()
            return True
        return False

    def as_list(self) -> list[dict]:
        return [
            {
                "slug": p['file'].removesuffix('.json'),
                "name": p['name'],
                "match": p['match'],
                "keys": p['keys'],
                "active": p is self.active_profile,
            }
            for p in self.profiles
        ]


# ---------------------------------------------------------------------------

def _sanitize_slug(s: str) -> str:
    s = s.strip().lower()
    return ''.join(c if c.isalnum() or c in '-_' else '_' for c in s)


class OverlayServer:
    def __init__(self):
        self.clients: set[web.WebSocketResponse] = set()
        self.loop: asyncio.AbstractEventLoop | None = None
        self.event_queue: asyncio.Queue | None = None
        self.last_press: dict[str, float] = {}
        self.keymaps = KeymapManager(KEYMAP_DIR)
        self.config: dict = load_config()

    # ---- real key hook -----------------------------------------------------

    def on_key_press(self, event):
        name = (event.name or '').lower()
        if not name:
            return

        now = time.monotonic()
        if now - self.last_press.get(name, 0) < AUTO_REPEAT_WINDOW:
            return
        self.last_press[name] = now

        built = self._build_event(name)
        if built:
            label, description = built
            tag = f"{label}  ({description})" if description else label
            print(f"  [emit] {tag}")
            self._enqueue(label, description)

    def _enqueue(self, label: str, description: str | None):
        if self.loop and self.event_queue:
            asyncio.run_coroutine_threadsafe(
                self.event_queue.put((label, description)), self.loop
            )

    def _build_event(self, key_name: str) -> tuple[str, str | None] | None:
        if key_name in MODIFIER_NAMES:
            return None

        mods = []
        if _is_really_pressed(VK_CONTROL):
            mods.append('CTRL')
        if _is_really_pressed(VK_SHIFT):
            mods.append('SHIFT')
        if _is_really_pressed(VK_MENU):
            mods.append('ALT')
        if _is_really_pressed(VK_LWIN) or _is_really_pressed(VK_RWIN):
            mods.append('WIN')

        if MODE == 'hotkeys':
            is_nav = key_name in NAV_KEYS
            has_real_mod = any(m != 'SHIFT' for m in mods)
            if not is_nav and not has_real_mod:
                return None

        display_key = KEY_DISPLAY.get(key_name, key_name.upper())
        label = ' + '.join(mods + [display_key]) if mods else display_key

        canonical = CANONICAL_KEY.get(key_name, key_name).replace(' ', '')
        combo = '+'.join([m.lower() for m in mods] + [canonical])
        description = self.keymaps.describe(combo)
        if ONLY_ANNOTATED and not description:
            return None
        return label, description

    # ---- broadcast ---------------------------------------------------------

    async def broadcast_loop(self):
        while True:
            label, description = await self.event_queue.get()
            payload = {'type': 'key', 'label': label}
            if description:
                payload['description'] = description
            msg = json.dumps(payload)
            stale = []
            for ws in list(self.clients):
                try:
                    await ws.send_str(msg)
                except Exception:
                    stale.append(ws)
            for ws in stale:
                self.clients.discard(ws)

    async def keymap_watch_loop(self):
        while True:
            self.keymaps.reload_if_changed()
            self.keymaps.update_active()
            await asyncio.sleep(KEYMAP_POLL_SECONDS)

    # ---- websocket + static ------------------------------------------------

    async def ws_handler(self, request: web.Request):
        ws = web.WebSocketResponse(heartbeat=20.0)
        await ws.prepare(request)
        self.clients.add(ws)
        print(f"  [connect]    client connected ({len(self.clients)} total)")
        try:
            async for msg in ws:
                if msg.type in (WSMsgType.ERROR, WSMsgType.CLOSE):
                    break
        finally:
            self.clients.discard(ws)
            print(f"  [disconnect] client disconnected ({len(self.clients)} total)")
        return ws

    async def index(self, request: web.Request):
        return web.FileResponse(ROOT / 'overlay.html')

    async def editor_index(self, request: web.Request):
        path = EDITOR_DIR / 'index.html'
        if not path.exists():
            return web.Response(
                status=404,
                text="Editor not installed — missing editor/index.html",
            )
        return web.FileResponse(path)

    # ---- JSON API ----------------------------------------------------------

    async def api_shutdown(self, request: web.Request):
        print("\n  [shutdown]   requested via editor — stopping.")
        async def _stop():
            await asyncio.sleep(0.3)   # let the response send first
            asyncio.get_event_loop().stop()
        asyncio.create_task(_stop())
        return web.json_response({"ok": True})

    async def api_list_backgrounds(self, request: web.Request):
        files = []
        if BACKGROUNDS_DIR.is_dir():
            for p in sorted(BACKGROUNDS_DIR.iterdir()):
                if p.suffix.lower() in {'.png', '.jpg', '.jpeg', '.webp', '.gif'}:
                    files.append({'name': p.stem, 'file': p.name, 'url': f'/backgrounds/{p.name}'})
        return web.json_response({'backgrounds': files})

    async def api_status(self, request: web.Request):
        return web.json_response({
            "running": True,
            "mode": MODE,
            "onlyAnnotated": ONLY_ANNOTATED,
            "focusedExe": self.keymaps.active_exe,
            "activeProfile": (
                self.keymaps.active_profile['name']
                if self.keymaps.active_profile else None
            ),
            "clients": len(self.clients),
            "overlayUrl": "http://127.0.0.1:8765/",
        })

    async def api_get_config(self, request: web.Request):
        return web.json_response(self.config)

    async def api_put_config(self, request: web.Request):
        try:
            data = await request.json()
        except json.JSONDecodeError:
            return web.json_response({"error": "invalid json"}, status=400)
        if not isinstance(data, dict):
            return web.json_response({"error": "object expected"}, status=400)
        # merge only known keys
        for k, v in data.items():
            if k in DEFAULT_CONFIG:
                self.config[k] = v
        save_config(self.config)
        # Push the new config to every connected overlay so OBS updates live
        msg = json.dumps({'type': 'config', **self.config})
        stale = []
        for ws in list(self.clients):
            try:
                await ws.send_str(msg)
            except Exception:
                stale.append(ws)
        for ws in stale:
            self.clients.discard(ws)
        print(f"  [config]     saved → broadcast to {len(self.clients)} client(s)")
        return web.json_response(self.config)

    async def api_list_keymaps(self, request: web.Request):
        self.keymaps.reload_if_changed()
        return web.json_response({"profiles": self.keymaps.as_list()})

    async def api_put_keymap(self, request: web.Request):
        slug = _sanitize_slug(request.match_info.get('slug', ''))
        if not slug:
            return web.json_response({"error": "bad slug"}, status=400)
        try:
            data = await request.json()
        except json.JSONDecodeError:
            return web.json_response({"error": "invalid json"}, status=400)
        path = self.keymaps.write_profile(slug, data)
        self.keymaps.reload_if_changed()
        print(f"  [keymaps]    wrote {path.name}")
        return web.json_response({"ok": True, "file": path.name})

    async def api_delete_keymap(self, request: web.Request):
        slug = _sanitize_slug(request.match_info.get('slug', ''))
        if not slug:
            return web.json_response({"error": "bad slug"}, status=400)
        removed = self.keymaps.delete_profile(slug)
        self.keymaps.reload_if_changed()
        print(f"  [keymaps]    {'removed' if removed else 'missing'} {slug}.json")
        return web.json_response({"ok": removed})

    async def api_test_key(self, request: web.Request):
        """Push a synthetic keypress into the overlay stream."""
        try:
            data = await request.json()
        except json.JSONDecodeError:
            return web.json_response({"error": "invalid json"}, status=400)
        label = (data.get("label") or "").strip()
        if not label:
            return web.json_response({"error": "label required"}, status=400)
        description = data.get("description") or None
        self._enqueue(label, description)
        print(f"  [test]       {label}" + (f"  ({description})" if description else ""))
        return web.json_response({"ok": True})

    # ---- run ---------------------------------------------------------------

    async def run(self, host: str = '127.0.0.1', port: int = 8765):
        self.loop = asyncio.get_running_loop()
        self.event_queue = asyncio.Queue()

        self.keymaps.reload_if_changed()
        self.keymaps.update_active()

        app = web.Application()
        # overlay + ws
        app.router.add_get('/', self.index)
        app.router.add_get('/ws', self.ws_handler)
        # editor UI
        app.router.add_get('/editor', self.editor_index)
        app.router.add_get('/editor/', self.editor_index)
        if EDITOR_DIR.is_dir():
            app.router.add_static('/editor/', EDITOR_DIR, show_index=False)
        # JSON API
        app.router.add_post('/api/shutdown', self.api_shutdown)
        app.router.add_get('/api/backgrounds', self.api_list_backgrounds)
        if BACKGROUNDS_DIR.is_dir():
            app.router.add_static('/backgrounds/', BACKGROUNDS_DIR)
        app.router.add_get('/api/status', self.api_status)
        app.router.add_get('/api/config', self.api_get_config)
        app.router.add_put('/api/config', self.api_put_config)
        app.router.add_get('/api/keymaps', self.api_list_keymaps)
        app.router.add_put('/api/keymaps/{slug}', self.api_put_keymap)
        app.router.add_delete('/api/keymaps/{slug}', self.api_delete_keymap)
        app.router.add_post('/api/test-key', self.api_test_key)

        keyboard.on_press(self.on_key_press)

        asyncio.create_task(self.broadcast_loop())
        asyncio.create_task(self.keymap_watch_loop())

        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, host, port)
        await site.start()

        print("=" * 60)
        print(f"  VHS Key Overlay — running  (mode: {MODE})")
        print("=" * 60)
        print(f"  Overlay URL:  http://{host}:{port}/")
        print(f"  Editor URL:   http://{host}:{port}/editor")
        print(f"  Keymaps dir:  {KEYMAP_DIR}")
        print(f"  Config file:  {CONFIG_PATH.name}")
        print(f"  Add the overlay URL as a Browser Source in OBS.")
        print(f"  Ctrl+C to stop.")
        print("=" * 60)

        await asyncio.Future()


def main():
    server = OverlayServer()
    try:
        asyncio.run(server.run())
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == '__main__':
    main()
