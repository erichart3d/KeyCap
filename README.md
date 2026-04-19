# KeyCap

KeyCap is a Windows desktop app and local server for showing annotated
keystrokes in OBS. It captures global hotkeys, matches them against the
focused application's keymap, and renders them as animated on-screen keycaps.

The project now runs on Electron + Node.js. The old Python server is still in
the repo as a legacy reference, but the active runtime lives in `main.js` and
`server/`.

## What it does

- Captures global keypresses with `uiohook-napi`
- Detects the focused Windows app and auto-switches keymap profiles
- Serves the OBS overlay at `http://127.0.0.1:8765/`
- Serves the editor UI at `http://127.0.0.1:8765/editor`
- Lets you tune theme, position, colors, animation, captions, backgrounds,
  and saved presets
- Broadcasts config and test keys live over WebSocket to the overlay

## Run it

### Option 1: Packaged app

Open the built `KeyCap` app or installer from `dist/`. The app starts the local
server automatically and opens the editor window.

### Option 2: Local dev / source checkout

Requirements:

- Windows
- Node.js 18+

Start with the one-click launcher:

```bat
launch.bat
```

Or run from a terminal:

```bat
npm install
node server\index.js
```

Then open:

- Overlay: `http://127.0.0.1:8765/`
- Editor: `http://127.0.0.1:8765/editor`

If PowerShell blocks `npm`, use `npm.cmd` instead.

## OBS setup

1. Add a Browser Source in OBS.
2. Set the URL to `http://127.0.0.1:8765/`.
3. Set width and height to match your canvas.
4. Leave the KeyCap app or local server running while recording.

## Editor features

The editor is a browser-based control surface served from `editor/index.html`.

- Theme picker with multiple styles
- Live preview canvas with overlay positioning
- Keycap and caption scaling
- Font family and weight controls
- Color overrides for keycap text and caption styling
- Background image selection from `Backgrounds/`
- Keymap editing and profile management
- Saved visual presets
- Test-key buttons for previewing overlay output

## Keymaps

Keymaps live in `keymaps/*.json`. The active profile is chosen by matching the
foreground executable name.

Example:

```json
{
  "name": "Photoshop",
  "match": ["photoshop.exe"],
  "keys": {
    "b": "Brush",
    "ctrl+z": "Undo",
    "ctrl+shift+z": "Redo"
  }
}
```

Notes:

- `match` is a list of executable names, case-insensitive
- `keys` uses lowercase combo strings like `ctrl+s`, `shift+d`, `space`, `f5`
- By default, only annotated keys from the active profile are emitted

## HTTP and WebSocket routes

- `GET /` -> overlay for OBS
- `GET /editor` -> editor UI
- `GET /ws` -> WebSocket for live keys and config pushes
- `GET /api/status` -> running status, focused exe, active profile
- `GET /api/config` -> current overlay config
- `PUT /api/config` -> save overlay config to `config.json`
- `GET /api/keymaps` -> list keymap profiles
- `PUT /api/keymaps/:slug` -> create or update a profile
- `DELETE /api/keymaps/:slug` -> delete a profile
- `GET /api/presets` -> list saved presets
- `GET /api/presets/:slug` -> read one preset
- `PUT /api/presets/:slug` -> save a preset
- `DELETE /api/presets/:slug` -> delete a preset
- `GET /api/backgrounds` -> list available background images
- `POST /api/test-key` -> push a synthetic key event to the overlay
- `POST /api/shutdown` -> stop the local server

## Project layout

- `main.js` -> Electron app entry point
- `server/index.js` -> Express + WebSocket server
- `server/keyboard.js` -> global keyboard capture and combo building
- `server/keymaps.js` -> keymap loading and focused-app switching
- `server/config.js` -> config defaults and persistence
- `server/presets.js` -> saved visual presets
- `server/win32.js` -> Win32 foreground app and modifier detection
- `editor/index.html` -> full editor UI
- `overlay.html` -> browser-source overlay UI
- `keymaps/` -> per-app hotkey descriptions
- `Backgrounds/` -> preview scene images
- `config.json` -> current saved overlay config
- `dist/` -> packaged builds

## Build and release

Build a Windows package:

```bat
npm run build
```

Publish a release build:

```bat
npm run release
```

There is also a helper script:

```powershell
.\release.ps1
```

## Troubleshooting

### Port 8765 is already in use

Another KeyCap instance may already be running. Close the existing app or end
old `KeyCap` or `node` processes in Task Manager, then relaunch.

### OBS shows nothing

- Confirm `http://127.0.0.1:8765/` loads locally
- Confirm the app or local server is running
- Confirm your Browser Source size matches your OBS canvas

### The overlay does not react to typing

That is expected for normal text entry. The overlay is designed around hotkeys
and annotated combinations, not plain typing.

### The wrong profile is active

Check the profile's `match` array and make sure it includes the actual focused
executable name, such as `photoshop.exe`.
