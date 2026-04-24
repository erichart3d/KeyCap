# keycap-recorder

Native Rust sidecar for KeyCap screen recording. Speaks JSON-over-stdio to
the Electron main process (see [../../server/native-recorder.js](../../server/native-recorder.js)).

## Status — Milestone 2

Windows display capture via Windows Graphics Capture → raw BGRA → bundled
`ffmpeg.exe` encode to MP4/H.264. Encoder fallback chain:
`nvenc → amf → qsv → x264`, probed at session resolution.

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

## Known limitation: WGC + some HDR OLED ultrawides

On certain displays — confirmed on Samsung Odyssey G95SC, likely other
HDR / VRR / ultrawide OLED panels — WGC's `Direct3D11CaptureFramePool`
stops emitting frames after the first one, regardless of
`MinimumUpdateIntervalSettings`, cursor movement, or `DrawBorder` flags.
The same machine captures windows at 60 fps via `wgc_window`, confirming
the issue is monitor-specific, not a code bug. Likely cause: DirectFlip /
MPO overlay bypassing the DWM composition path WGC hooks into.

**Mitigation (planned M2.1):** fall back to D3D11 Desktop Duplication
(DXGI DDA) when WGC delivers fewer than N frames/sec during the first
second of capture. DDA reads from the framebuffer directly and is not
subject to the compositor-present hook.

## IPC

All control messages are newline-delimited JSON on stdin/stdout. See
[src/ipc.rs](src/ipc.rs) for the wire types. Methods: `handshake`,
`list_sources`, `start_recording`, `get_status`, `stop_recording`,
`shutdown`. Status is also pushed as periodic `event` messages while
recording.
