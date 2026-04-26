# KeyCap — Codebase Guide

KeyCap is a streamer-friendly keystroke overlay. The app captures keypresses
via `uiohook-napi`, broadcasts them over a local WebSocket, and renders them
on a transparent overlay window the user composites into OBS or similar.

This file documents the architecture for anyone (human or LLM) coming into
the codebase fresh.

## High-level layout

```
main.js                  Electron entry. Spawns the editor window, talks to
                         the server runtime, and creates offscreen overlay
                         capture windows for recording.
preload.js               Bridge that exposes `window.keycapApp.api(...)` to
                         the editor for IPC-based API calls.
overlay.html             The OBS-side overlay page. Loaded over HTTP at
                         `http://127.0.0.1:8765/`. Pure HTML+CSS+JS.
editor/
  index.html             Editor UI shell. Loaded via file:// in Electron.
  editor.js              Editor app controller (~5000 lines). Plain JS.
  editor.css             Editor layout + theme creator styling.
  design.css             Editor design tokens + base layout.
  theme-runtime.js       Theme + pack runtime: compiles theme/pack JSON
                         into CSS, builds DOM elements, applies them. Used
                         by both overlay.html and the editor's preview.
  theme-creator.js       Theme creator helpers (color pickers etc.).
  pack-card.css          Shared CSS for Aesthetic Pack composition layers
                         (.pack-card, .pack-card-header, etc.). Linked
                         from BOTH overlay.html and editor/index.html so
                         pack chrome renders consistently in both places.
server/
  index.js               Express HTTP server + WebSocket. Serves the
                         overlay/editor and exposes /api/* routes.
  runtime.js             AppRuntime — owns config, themes, packs, presets,
                         keymaps, and the keyboard hook. Emits events.
  config.js              Config load/save + DEFAULT_CONFIG. Wires together
                         themeManager and packManager and emits resolved
                         theme + pack to clients via WebSocket.
  themes.js              ThemeManager. Built-in themes are baked into the
                         file; custom themes live in `customThemes/<slug>.json`.
  packs.js               PackManager. Built-in packs are directories under
                         `packs/<slug>/{pack.json, assets/}`. Custom packs
                         live under `customPacks/<slug>/`.
  pack-schema.js         Pack schema constants + validators + migration
                         helpers (wrapThemeAsPack for legacy themes).
  presets.js             PresetManager (full config snapshots).
  keyboard.js            uiohook-napi wrapper.
  keymaps.js             Per-app hotkey profiles.
packs/                   Built-in Aesthetic Packs.
  default/               Bare keycap+caption styling, no composition chrome.
  win95/                 Per-key Windows 95 windows.
  neo-tokyo/             Per-key CHAT.EXE-style neon panel (unpublished).
  magic-forest/          Row-scope vine frame (unpublished).
customThemes/            User-saved theme JSON files.
config.json              User's persisted config.
```

## The Aesthetic Pack system

This is the visual identity primitive. **Read this section before changing
anything in `packs/`, `server/packs.js`, `server/pack-schema.js`, or the
theme creator flow.**

### Three-layer hierarchy

```
Style Pack (top)         Visual identity + parameter declarations + assets.
   │                     Drives the overall look. Pack picker shows these.
   │  e.g. "Default", "Windows 95"
   ▼
Theme                    Named parameter values within a pack.
   │                     Saved as JSON in customThemes/<slug>.json.
   │  e.g. "My Win95" with custom title-bar colors.
   ▼
Preset                   Theme + overlay-layout overrides (position, margin,
                         maxKeys, fade, scale, etc.). Saved as JSON in
                         presets/<slug>.json.
```

A theme always belongs to exactly one pack via `__basePack: <slug>` in its
JSON. When a theme is applied, the runtime resolves its pack template +
saved `__parameterValues` into a fully-composed pack and broadcasts that
to the overlay.

### Pack on disk

```
packs/<slug>/
  pack.json              The pack manifest.
  assets/                Optional. SVG / PNG / WebP / animated WebP files
                         referenced by composition.frame.decor[] etc.
```

`pack.json` shape (see `server/pack-schema.js` for full schema):

```jsonc
{
  "schemaVersion": 1,
  "id": "win95",
  "name": "Windows 95",
  "author": "built-in",
  "version": "1.0.0",
  "published": true,           // false hides from create-theme picker
  "description": "...",
  "typography": { "primaryFont": "...", "googleFonts": [] },
  "motion": { "fade": "win95", "animationSpeed": 1 },

  "keycapTheme": {             // Default keycap+caption styling for this pack.
    "defaults": { ... },       // Same shape as legacy DEFAULT_THEME.
    "keycap": { ... },
    "caption": { ... }
  },

  "shapeLock": {               // Optional. When present, the editor's Shape
    "label": "Win95 Window",   // dropdown locks to this label and disables.
    "description": "..."
  },

  "composition": {             // Optional. null = no chrome (Default pack).
    "mode": "card" | "separate",
    "frameScope": "per-key" | "row" | "none",
    "frame": {
      "padding": { "top": 2, "right": 3, "bottom": 3, "left": 3 },
      "fill": { "type": "solid", "color": "#c0c0c0" },
      "border": {
        "style": "bevel",      // or "solid". "bevel" = pixel-accurate
        "width": 1,            // 4-color Win95 raised border.
        "highlight": "#ffffff",
        "innerHighlight": "#dfdfdf",
        "innerShadow": "#808080",
        "shadow": "#000000",
        "glow": { ... }        // Optional outer glow for neon packs.
      },
      "header": {              // Optional. The title-bar strip.
        "height": 18,
        "fill": { ... },
        "textColor": "#ffffff",
        "fontSize": 11,
        "padding": { ... },
        "buttons": [           // Inline SVG icons via `icon` keyword:
          { "type": "min",   "icon": "minimize", "bevel": "out", ... },
          { "type": "max",   "icon": "maximize", ... },
          { "type": "close", "icon": "close",    ... }
        ]
      },
      "decor": [               // Optional. Anchored SVG/img ornaments.
        { "asset": "vine.svg", "anchor": "tl", "width": 80, ... }
      ],
      "minWidth": 96,
      "gap": 2,
      "skewX": 0
    }
  },

  "parameters": [              // User-editable knobs in the theme creator.
    {
      "id": "win95.titleBarStart",
      "label": "Title bar (start)",
      "type": "color",         // see PARAMETER_TYPES in pack-schema.js
      "section": { "tab": "caption", "group": "Color" },  // where in editor
      "default": "#000080",
      "appliesTo": "composition.frame.header.fill.stops[0].color"
    }
  ],

  "hides": [                   // Standard editor widgets to suppress.
    "std.keycap.fx", "std.keycap.fill", "std.keycap.outline.color"
    // See STD_PARAM_HIDES + STD_PARAM_SELECTOR in editor.js for IDs.
  ],

  "assets": {                  // Map of asset name → relative path.
    "vine.svg": "./assets/vine.svg"
  }
}
```

### How a theme is rendered end-to-end

```
1. User picks a theme in the editor.
2. editor.js → applyTheme(slug):
     • state.config.theme = slug
     • state.config.pack = entry.basePack (set by applyThemeBasePackToConfig)
     • state.config.packData = null (forces server-side resolution)
     • PUT /api/config
3. Server runtime.updateConfig → withResolvedTheme:
     • resolvedTheme = resolveConfigTheme(...)
     • resolvedPack = resolveConfigPack(...)
         - if packData inline → use it as-is
         - else if pack slug → load packs/<slug>/pack.json, then look up
           the active theme and apply theme.__parameterValues to the pack
           template via writeAtPath()
4. Server broadcasts WebSocket: { type: 'config', ..., resolvedTheme, resolvedPack }
5. overlay.html applyConfig:
     • applyThemeCss(themeStyleEl, resolvedPack.keycapTheme, ...)
     • applyPackCss(packStyleEl, resolvedPack)
     • applyPackDom(resolvedPack, { overlay, rowFrame })
6. addKey() builds DOM:
     • If composition.mode === 'card': caption + keycap fuse into a
       .pack-card with .pack-card-header (caption + buttons) + .pack-card-body.
     • Else: caption + keycap render as siblings (legacy flat layout).
```

The editor's `#liveOverlay` follows the same flow with an editor-side `addKey`
that mirrors the overlay's logic. Pack CSS is scoped to `#liveOverlay` so
multiple packs don't bleed across pages.

### The theme creator flow

1. **"+ New Theme"** in the theme library opens a **pack picker** modal showing
   live mini-previews of each `published: true` pack.
2. User picks a pack. `openThemeCreatorView(null, { basePack: <slug> })`:
   • Pre-fetches the pack detail.
   • Seeds `state.themeCreatorDraft` from the pack's `keycapTheme` (so a
     new Win95 theme starts with Win95's transparent-keycap styling, not
     the user's previously-active theme).
   • Stores `state.themeCreatorBasePack = <slug>` and an empty
     `state.themeCreatorParameterValues = {}`.
3. The creator renders:
   • Standard Keycap and Caption tabs as usual.
   • `applyPackHidesToCreator()` hides whichever standard widgets the pack's
     `hides[]` lists (e.g. Win95 hides Material/Effects/Advanced FX).
   • `applyShapeLock()` optionally replaces the Shape dropdown with a single
     locked option from `pack.shapeLock`.
   • `renderPackSettingsPanel()` walks `pack.parameters[]` and renders one
     widget per parameter, slotted into the existing creator section it
     declares (e.g. `section: { tab: "caption", group: "Color" }`). Widgets
     get class `.pack-param-widget` so they're cleanly torn down on pack
     change.
   • Each parameter widget's onChange writes the value into
     `state.themeCreatorParameterValues[paramId]` and calls
     `pushResolvedPackToConfig()` so the live overlay updates immediately.
4. **Save** → PUT /api/themes/<slug> with payload:
   ```
   { name, basePack, theme: { ...keycapJson, __basePack, __parameterValues } }
   ```
   The theme JSON now carries the pack binding for round-tripping.

### Editor / overlay scope conventions

- **`overlay.html`** is the live overlay (loaded over HTTP). Its keys are
  `<div class="key">` and theme CSS targets `.keycap` / `.caption`.
- **`editor/index.html` → `#liveOverlay`** is the in-editor preview that
  mirrors the live overlay. Its keys are `<div class="key-cap">` and theme
  CSS targets `.keycap-el` / `.key-caption`. The editor adds `class="key"`
  to `.key-cap` when the active pack uses card or row composition so
  pack-card CSS selectors apply.
- **`editor/index.html` → `#themeCreatorPreview`** is the theme creator's
  preview pane. Same key markup as `#liveOverlay`.
- **`editor/index.html` → theme library cards** render their own sample
  key inside each card with pack CSS scoped via
  `compilePackCss(..., { scope: '[data-theme-preview="..."]' })`.

Pack CSS scoping (via `compilePackCss(pack, { scope, rowFrameSelector })`)
is the trick that lets all four surfaces show different packs side-by-side
without selector collisions.

### Adding a new pack

1. Make a directory under `packs/<slug>/`.
2. Author a `pack.json` following the schema above. Start with `published: false`
   while WIP. Reference `packs/win95/pack.json` for a complete card-mode example
   or `packs/magic-forest/pack.json` for row-mode.
3. Drop SVG/PNG art into `packs/<slug>/assets/` and reference via the `assets`
   map.
4. Add `packs/<slug>/**` to electron-builder's `files` list in `package.json`
   so the pack ships in builds. (Already covered by the existing `packs/**`
   glob.)
5. Restart the dev server (or relaunch Electron) so PackManager rescans.
6. Test via the create-theme flow: theme picker → "+ New" → pick the pack.

### Adding a new motion/animation preset

1. Add `@keyframes <name>open` and `@keyframes <name>close` to
   `editor/pack-card.css` (so both the live overlay and the editor preview
   pick them up).
2. Add `body.anim-<name> .key, body.anim-<name> .key-cap { animation-name:
   ...; }` rules in the same file for entry, and `.fading` variants for exit.
3. Add `'anim-<name>'` to the body-class clean-list in BOTH `overlay.html`
   `applyConfig` AND `editor.js` `applyOverlayVars` (search for
   `'anim-pixel-pop'` to find the existing lists).
4. Add `<option value="<name>">Display Name</option>` to all three fade
   `<select>` blocks in `editor/index.html` (search for `pixel-pop` to find
   the three locations: main panel, basic-mode, theme creator).
5. Optional: have a pack default to it via `motion.fade: "<name>"` and
   `keycapTheme.defaults.fade: "<name>"`.

### Build + run

```bash
npm install                # one-time
npm start                  # node server only (port 8765)
npm run electron           # native Electron app
npm run build              # production build to dist/win-unpacked + installer
```

Browser path: `http://localhost:8765/editor/` (note trailing slash — `/editor`
without it 404s `editor.js` due to relative path resolution).

### Known design tradeoffs

- **Saved themes snapshot pack template version.** When the runtime resolves
  a saved theme, it uses the *current* pack template + the theme's
  `__parameterValues`. This means if a built-in pack's template changes
  (e.g. we tweak Win95's bevel rendering), saved Win95-derived themes
  automatically pick up the improvement. The flip side: a parameter that
  used to apply at path X but now applies at path Y will silently stop
  taking effect for old themes. We'd need a migration strategy if we ship
  breaking parameter changes.
- **Pack CSS uses ID-anchored selectors for scoping.** Compiled theme CSS
  uses `#themeCreatorPreview .keycap-el` (1,1,1 specificity), so my
  override rules in editor.css also use ID anchors. If the page structure
  changes such that the preview lives at a different ID, override
  selectors break silently. Search for `#themeCreatorPreview`,
  `#liveOverlay`, `[data-theme-preview="..."]` in editor.css when
  refactoring.
- **`published: false` doesn't hide from runtime resolution.** Unpublished
  packs still resolve when a saved theme references them — they're hidden
  only from the create-theme picker. This is intentional so partially-built
  packs can be tested without losing in-progress work.
