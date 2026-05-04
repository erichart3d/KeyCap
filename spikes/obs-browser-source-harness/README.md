# OBS Browser Source Harness

This spike drives the installed OBS Studio runtime as a feasibility harness for KeyCap's recorder architecture work. It does not change production recorder behavior.

The harness creates an isolated OBS portable sandbox under `native/recorder/target/obs-browser-source-harness/` by junctioning the installed OBS `bin`, `data`, and `obs-plugins` directories into a writable test root. It then writes a temporary OBS profile/scene collection with:

- a static color background source
- a real OBS `browser_source` pointed at the KeyCap overlay URL
- OBS websocket enabled without auth on a spike-only port
- recording output directed into the spike run folder

During a run it starts the KeyCap overlay server if one is not already running, launches OBS with recording enabled, connects over obs-websocket, injects `/api/test-key` bursts, stops recording, and writes `report.json`.

## Run

```powershell
npm run spike:obs-source -- --width=1920 --height=1080 --fps=60 --duration=8
```

Useful variants:

```powershell
npm run spike:obs-source -- --width=3840 --height=2160 --fps=60 --duration=8
npm run spike:obs-source -- --width=1920 --height=1080 --fps=30 --duration=8 --key-interval=350
npm run spike:obs-source -- --width=3840 --height=2160 --fps=60 --duration=15 --background=video
npm run spike:obs-source -- --list-displays
npm run spike:obs-source -- --width=3840 --height=1080 --fps=60 --duration=8 --background=display --display-index=2
npm run spike:obs-source -- --width=1920 --height=1080 --fps=60 --encoder=x264 --quality=Small
npm run spike:obs-source -- --width=1920 --height=1080 --fps=60 --start-mode=websocket
npm run spike:obs-source -- --dry-run
```

Use `--background=video` to replace the static color source with a looping OBS `ffmpeg_source` at the requested canvas size and frame rate. By default the harness generates a short `testsrc2` MP4 in the run folder with `native/recorder/bin/ffmpeg.exe`; pass `--background-file="C:\path\to\clip.mp4"` to use a real video clip instead.

Use `--background=display` to replace the static color source with OBS `monitor_capture`. Run `--list-displays` first, then select with `--display-index=<n>` or `--monitor-id="\\.\DISPLAY2"`. The harness records the chosen monitor and full display list in `report.json`.

The default OBS install path is `C:\Program Files\obs-studio`. Override it with:

```powershell
npm run spike:obs-source -- --obs-root="D:\Apps\obs-studio"
```

## Outputs

Each run writes to:

```text
native/recorder/target/obs-browser-source-harness/<timestamp>-<size>-<fps>fps/
```

Important files:

- `report.json`: OBS version, source list, start/stop responses, key injection count, recording file paths, errors.
- `report.json` also includes OBS log frame counts and an ffmpeg decode probe when `native/recorder/bin/ffmpeg.exe` is present.
- `recordings/`: OBS output files, defaulting to MKV for stop-safety.
- `logs/obs-process.log`: stdout/stderr from the OBS process.
- `logs/keycap-server.log`: server output when the harness started KeyCap itself.

## Interpretation

This harness answers a narrow question:

> Does the real KeyCap overlay remain visually smooth when OBS owns the browser source and output pipeline?

A useful first pass is:

1. 1080p60 static background + KeyCap overlay.
2. 4K60 static background + KeyCap overlay.
3. 1080p60 moving background + KeyCap overlay.
4. 4K60 moving background + KeyCap overlay.
5. Selected display capture + KeyCap overlay.
6. Repeat each twice in the same app/session pattern.

If these recordings are smooth, the browser-source scheduling model is probably the missing piece in KeyCap's recorder. If they show the same sluggish fade behavior, the overlay runtime itself needs animation-model work before any recorder architecture will make it feel like OBS.

The first longer `1080p60` and `4K60` OBS NVENC clips were visually reviewed as the most fluid KeyCap key playback so far. The moving-background `1080p60` and `4K60` clips were then visually reviewed as perfectly fluid. If the `4K` overlay appears small, treat that as recording-resolution scale/layout behavior, not a frame-cadence failure.

## Safety

The harness avoids editing the user's normal OBS profile by using `--portable` with a sandbox config directory. It still launches OBS and may briefly show OBS UI while recording. Use `--dry-run` to generate the sandbox and config without launching OBS.
