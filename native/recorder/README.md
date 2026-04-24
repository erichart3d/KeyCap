# keycap-recorder

Native Rust sidecar for KeyCap screen recording. Speaks JSON-over-stdio to
the Electron main process (see [../../server/native-recorder.js](../../server/native-recorder.js)).

## Status — Milestone 2.1

Windows display capture → raw BGRA → bundled `ffmpeg.exe` encode to
MP4/H.264. Encoder fallback chain: `nvenc → amf → qsv → x264`, probed at
session resolution.

Two capture backends:

- **DDA (default)** — DXGI Desktop Duplication. Reads the final
  framebuffer directly; works on HDR/VRR OLED ultrawides where WGC
  stalls. This is the same API OBS uses for "Display Capture."
- **WGC** — Windows Graphics Capture. Retained for debugging and future
  window-capture support. Select with `KEYCAP_CAPTURE_BACKEND=wgc`.

Not yet:
- Audio capture
- Window / app capture
- Overlay compositing (M2.5)
- Zero-copy GPU encode via Media Foundation (M3)
- macOS ScreenCaptureKit backend (M4)

## Build

Rust toolchain (stable, MSVC on Windows) — install via [rustup](https://rustup.rs/).

```sh
cd native/recorder
cargo build --release
cp target/release/keycap-recorder.exe bin/
```

The Electron app looks for the binary at `native/recorder/bin/keycap-recorder.exe`.

## Smoke test

End-to-end: spawns the binary, runs handshake + list_sources + a short
record, then `ffprobe`s the MP4.

```sh
node scripts/smoke.mjs --record-seconds=3 --encoder=auto
```

`bin/ffprobe.exe` is optional — the smoke test skips format validation if
it's not present.

## Diagnostics

Minimal WGC examples for isolating capture issues:

```sh
cargo run --release --example wgc_raw      # primary monitor, 10s
cargo run --release --example wgc_window   # first named window, 5s
```

## Overlay compositing

The KeyCap overlay (the on-screen keyboard-state layer) is baked into
recordings via the existing always-on-top transparent `BrowserWindow`
in the main process: DDA captures the final compositor framebuffer,
and always-on-top windows are part of that framebuffer. No additional
IPC or CPU compositing is required.

The main-process forwarder hook at `server/native-recorder.js:277`
(`pushOverlayFrame`) and the offscreen BGRA feed at `main.js:411` are
reserved for a future mode that composites in the sidecar so the
visible overlay can be hidden from the user's screen during recording.
That lands with GPU compositing in M3.

## Capture-backend notes

**WGC 1-frame issue.** On HDR/VRR OLED ultrawides (confirmed Samsung
Odyssey G95SC, likely others) WGC's `Direct3D11CaptureFramePool` emits
one frame and then stalls — regardless of `MinimumUpdateIntervalSettings`,
cursor movement, or `DrawBorder`. Likely cause: DirectFlip / MPO bypasses
the DWM composition path WGC hooks into. `wgc_window` still works at
60 fps on the same machine, confirming the limitation is display-path
specific. M2.1 resolves this by defaulting display capture to DDA.

**DDA quirks.** DDA only delivers a frame when the desktop image
changes (`AcquireNextFrame` returns `DXGI_ERROR_WAIT_TIMEOUT` on idle).
The capture loop re-emits the last staging texture at the target
cadence so ffmpeg sees a steady stream. On `DXGI_ERROR_ACCESS_LOST`
(resolution change, UAC prompt, fullscreen app takeover) the loop
reinitializes `IDXGIOutputDuplication` transparently.

## IPC

All control messages are newline-delimited JSON on stdin/stdout. See
[src/ipc.rs](src/ipc.rs) for the wire types. Methods: `handshake`,
`list_sources`, `start_recording`, `get_status`, `stop_recording`,
`shutdown`. Status is also pushed as periodic `event` messages while
recording.
