# OBS Recorder Sidecar Proof

This spike is the first production-shaped recorder sidecar after the OBS browser-source harness passed.

It does not embed libobs yet. Instead, it controls the installed OBS Studio runtime in an isolated portable sandbox and exposes a small KeyCap-like sidecar command surface. The goal is to prove process ownership, start/stop/status behavior, source identity, and report shape before choosing whether production ships a libobs sidecar or a KeyCap-owned OBS-style browser source.

## Data Flow

```text
KeyCap app / JSON command
  -> OBS recorder sidecar proof
  -> isolated portable OBS sandbox
  -> OBS monitor_capture
  + OBS browser_source loading the real KeyCap overlay
  -> OBS output/encoder
  -> recording file + report.json
```

The important OBS behavior is preserved: the browser source is owned by OBS as a graphics source, and the output pipeline samples the latest browser texture on each video frame.

## Commands

List displays:

```powershell
npm run spike:obs-sidecar -- --list-displays
```

Run a self-contained display recording probe:

```powershell
npm run spike:obs-sidecar -- --self-test --display-index=2 --width=3840 --height=1080 --fps=60 --duration=6
```

Run as a newline-delimited JSON sidecar:

```powershell
npm run spike:obs-sidecar
```

Example stdin messages:

```json
{"id":1,"method":"listDisplays"}
{"id":2,"method":"start","params":{"displayIndex":2,"width":3840,"height":1080,"fps":60}}
{"id":3,"method":"status"}
{"id":4,"method":"stop"}
{"id":5,"method":"shutdown"}
```

Each response is one JSON line with either `result` or `error`.

## App Integration

The main app can use this proof through the existing `server/native-recorder` bridge by setting:

```powershell
$env:KEYCAP_RECORDER_BACKEND='obs'
npm run electron
```

With that flag, `server/native-recorder` launches this sidecar instead of the Rust recorder or mock sidecar. The editor still calls the same native-recorder IPC methods it already uses:

- `list_sources`
- `start_recording`
- `get_status`
- `stop_recording`
- `shutdown`

The OBS proof owns the overlay as an OBS `browser_source`, so the app does not create the old recording overlay window or overlay-pipe window for this backend.

In packaged builds, the OBS sandbox/log root is placed under `KEYCAP_DATA_ROOT\obs-recorder-sidecar`. For local testing, set `KEYCAP_OBS_SIDECAR_TARGET_ROOT` to override that work directory.

The sandboxed OBS profile is seeded as already configured (`FirstRun=true` plus `LastVersion`), so OBS should not show the auto-configuration wizard that asks whether to prioritize streaming or recording.

## Outputs

Each recording run writes to:

```text
native/recorder/target/obs-recorder-sidecar/<timestamp>-<size>-<fps>fps/
```

Important files:

- `report.json`: source identity, OBS version/input list, start/stop state, recording files, ffmpeg decode probe, OBS frame summaries, errors.
- `recordings/`: OBS output files, defaulting to MKV for stop safety.
- `logs/obs-process.log`: stdout/stderr from the OBS process.
- `logs/keycap-server.log`: server output when the sidecar started KeyCap itself.

## Scope

This is intentionally narrower than the existing OBS harness:

- display capture only
- one overlay browser source
- one recording output
- start, stop, status, shutdown
- no editor integration yet
- no production recorder behavior changes

## Promotion Gates

Before this becomes production code, it needs:

- repeat start/stop twice in one process
- 1080p30, 1080p60, 4K30, and 4K60 visual review
- selected display identity parity with KeyCap preview/source labels
- stop under 2 seconds
- playable partial recording behavior after abnormal stop
- packaging/licensing decision for OBS/libobs components

## Initial Validation

Validated on this machine with `\\.\DISPLAY2` at `3840x1080@60`:

- `node --check spikes/obs-recorder-sidecar/obs-recorder-sidecar.mjs`
- `npm run spike:obs-sidecar -- --list-displays`
- `npm run spike:obs-sidecar -- --self-test --display-index=2 --width=3840 --height=1080 --fps=60 --duration=6 --key-interval=350`
- persistent JSON sidecar process with two start/stop cycles, five injected key bursts per cycle

The self-test recorded and decoded successfully, with OBS logging 392 output frames and stop completing in about one second.

The persistent sidecar repeat test produced two playable recordings in one sidecar process:

| Run | Decoded frames | OBS output frames | Stop time |
| --- | ---: | ---: | ---: |
| 1 | 197 | 198 | 1001 ms |
| 2 | 200 | 201 | 971 ms |

Both repeat-test MP4 review copies were visually reviewed as flawless. Treat this as the first production-shaped sidecar signal that OBS-owned browser source recording can preserve KeyCap overlay cadence across repeated starts and stops.

The first repeat-test attempt exposed a real lifecycle issue: the sidecar killed OBS without waiting for the process to exit, so immediate restart could race OBS shutdown. The proof now waits for OBS and the optional overlay server to exit before reporting stop complete.

The app bridge integration was then validated through `server/native-recorder` with `KEYCAP_RECORDER_BACKEND=obs`. Two start/stop cycles in one bridge process produced playable MP4s:

| Run | Decoded frames | OBS output frames | Stop time |
| --- | ---: | ---: | ---: |
| 1 | 188 | 189 | 949 ms |
| 2 | 190 | 191 | 906 ms |

A later bridge smoke validated the packaged-app work-root override path: `KEYCAP_OBS_SIDECAR_TARGET_ROOT` was honored, one MP4 was written through the app bridge, and stop completed in 728 ms. A directory-only Windows package build (`electron-builder --win dir`) confirmed the proof sidecar is included under `resources\app\spikes\obs-recorder-sidecar` while generated `native\recorder\target` artifacts are excluded.
