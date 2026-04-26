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

The KeyCap overlay is composited inside this sidecar. At handshake the
sidecar returns an `overlayPipe` (a Windows named pipe, e.g.
`\\.\pipe\keycap-overlay-<pid>`). The Electron main process connects
as a client and streams length-prefixed BGRA frames through it:

    u32 magic = 0x594C564F  ("OVLY")
    u32 width
    u32 height
    u32 byte_len (= width * height * 4)
    u8  bgra[byte_len]

The encoder thread locks the most recent overlay frame and alpha-blends
it onto each captured BGRA frame before handing the pixels to ffmpeg.
See [src/overlay.rs](src/overlay.rs).

Why this exists at all: on HDR/VRR displays that use MPO (Multi-Plane
Overlay), transparent always-on-top windows get routed onto dedicated
hardware planes and bypass the DWM composition path. DDA captures the
framebuffer but not the overlay plane, so "DDA sees the always-on-top
window" is false on those displays. The pipe + CPU composite works
regardless of MPO routing, and as a bonus the visible overlay window
can be dropped during recording (the screen stays clean).

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
