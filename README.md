# VHS Key Overlay

A lightweight keypress overlay for OBS tutorials, styled in VHS/vaporwave.
Shows hotkeys as a stack of chunky animated keycaps, with per-app keymap
profiles that auto-switch by the focused window. A live editor UI lets you
tweak colors, position, and keymaps from the browser.

## Quick start (Windows)

1. Double-click **`launch.bat`**.
   - First run creates a `.venv` and installs dependencies (~30s).
   - Subsequent runs just start the server.
2. The editor opens automatically at **http://127.0.0.1:8765/editor**.
3. Add the overlay to OBS as a **Browser Source** pointed at
   **http://127.0.0.1:8765/**.

Manual setup (if you prefer):
```
pip install -r requirements.txt
python overlay_server.py
```

## URLs the server exposes

| Route | What it does |
|---|---|
| `/` | Overlay — use this as the OBS Browser Source URL |
| `/editor` | Live editor UI (visuals + keymaps + test keys) |
| `/ws` | WebSocket the overlay subscribes to for key events |
| `/api/status` | JSON: running, focused exe, active profile |
| `/api/config` | `GET` / `PUT` overlay visuals (persisted to `config.json`) |
| `/api/keymaps` | `GET` list all profiles |
| `/api/keymaps/<slug>` | `PUT` / `DELETE` a profile (writes `keymaps/<slug>.json`) |
| `/api/test-key` | `POST {label, description?}` — push a synthetic keypress |

## What shows and what doesn't

**Shown:**
- Any modifier combo: `Ctrl+K`, `Ctrl+Shift+S`, `Alt+Tab`, `Win+D`, etc.
- Function keys, arrows, Esc, Enter, Tab, Space, Delete, Home/End, PageUp/Down, etc.
- (When `ONLY_ANNOTATED = True` in the server — the default — only combos that
  have a description in the active keymap profile are rendered.)

**Ignored:**
- Plain typing and modifier keys pressed alone
- `Shift+letter` (that's just capitalization)

## Keymap profiles (per-app descriptions)

Drop a JSON file into `keymaps/` for each program you want annotated. The
server auto-detects the focused window's executable and loads the matching
profile. Edit the JSON (or use the editor UI) while the server is running —
it hot-reloads.

Example — `keymaps/zbrush.json`:
```json
{
  "name": "ZBrush",
  "match": ["zbrush.exe"],
  "keys": {
    "b": "Brush palette",
    "ctrl+z": "Undo",
    "shift+d": "Lower subdivision"
  }
}
```

- `match` — executable names (case-insensitive) that activate this profile.
- `keys` — combo → description. Lowercase, no spaces, `+` between parts
  (e.g. `"ctrl+shift+s"`, `"space"`, `"f5"`).

Starter profiles included: `zbrush.json`, `photoshop.json`.

## OBS setup

1. **+ Add Source → Browser**
2. **URL:** `http://127.0.0.1:8765/`
3. **Width / Height:** match your canvas (e.g. 1920×1080)
4. Uncheck "Shutdown source when not visible"
5. Check "Refresh browser when scene becomes active"

## Files

- `launch.bat` — one-click Windows launcher
- `overlay_server.py` — Python hook + HTTP/WebSocket server + JSON API
- `overlay.html` — the overlay visual, served at `/`
- `editor/index.html` — the editor UI, served at `/editor`
- `keymaps/*.json` — per-app hotkey descriptions
- `config.json` — persisted overlay visual settings
- `requirements.txt` — pip deps

## Troubleshooting

- **Nothing appears in OBS:** confirm the terminal shows the server running,
  and the OBS URL matches. Right-click the source → Interact → check for
  WebSocket errors.
- **Editor says "Server unreachable":** the Python server isn't running or
  is bound to a different port. Re-run `launch.bat`.
- **Doesn't capture inside a game:** if the game runs as admin, run the
  launcher as admin too (right-click `launch.bat` → Run as administrator).
