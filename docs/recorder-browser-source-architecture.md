# Recorder Browser Source Architecture

## Summary

KeyCap recording and streaming must render keycaps from the same browser-owned visual runtime. The recorder should not maintain a native Rust reimplementation of keycap styling, pack composition, CSS animation, or user-authored looks. Browser rendering is the contract; recorder engineering should focus on capturing that rendered browser surface at stable cadence and compositing it over captured display frames.

The current reliable baseline remains the production default:

```text
display capture -> overlay frame source -> compositor -> NV12 -> ffmpeg h264_nvenc/x264 -> MP4
```

The next architecture goal is to replace the fragile Electron offscreen overlay pipe with a recorder-owned browser source that behaves like an OBS browser source: same HTML/CSS/theme runtime, recorder-clocked frame consumption, and latest-frame semantics.

## Why Browser Rendering Is Canonical

- Stream mode already uses Chromium/browser rendering, and creators will author looks against that behavior.
- CSS, pack chrome, captions, fonts, SVG assets, and animation timing must match between stream and record.
- A native overlay renderer would inevitably become a second visual implementation with drift risk.
- Recorder reliability should come from isolating browser frame delivery from capture/encode timing, not from approximating the visuals.

## Target Data Flow

```text
Key event/config runtime
  -> browser overlay document
  -> transparent BGRA/RGBA browser frame
  -> latest-frame overlay buffer
  -> recorder compositor samples latest overlay frame per video frame
  -> encoder/muxer
```

Important timing rule: the recorder must never wait for the browser to paint. On each video frame, the compositor uses the newest complete overlay frame available. If the browser misses a paint, the recorder reuses the prior overlay frame and logs the staleness. This protects capture and encode cadence while making overlay hitches measurable.

## Phase One Feasibility Probe

The first probe is intentionally separate from production recorder code. It uses Electron offscreen rendering because Electron is already in the app and can exercise the real overlay document immediately. The probe answers:

- Can the real overlay page paint at 60 fps at 1080p and 4K sizes under scripted key bursts?
- How often do Chromium paints exceed the frame budget?
- What is the latency from a scripted key injection to the next painted overlay frame?
- Do heavy pack themes or fade animations change paint cadence enough to be visible?

Run it with:

```powershell
npm run spike:browser-source -- --width=3840 --height=2160 --fps=60 --duration=8 --key-interval=350
```

The probe writes its report under `native/recorder/target/browser-source-feasibility/`, which is ignored by Git.

## Phase Two Recorder-Owned Browser Source

After the Electron probe establishes expected paint cadence and failure signatures, build the native browser source behind an experimental recorder feature flag. Preferred direction is CEF offscreen rendering owned by the recorder process:

- Load the same overlay URL or bundled overlay document.
- Send the same key/config events used by streaming.
- Receive transparent browser frames into a latest-frame buffer.
- Publish timing counters: browser paint fps, paint p95/max delta, stale overlay frames, key-to-paint latency, compositor frame time, encode frame time.
- Keep production recording on the stable ffmpeg baseline until the browser source passes 1080p30, 1080p60, 4K30, and 4K60 gates.

If CEF integration is too large for the first native spike, the fallback is a shared-memory latest-frame bridge from an Electron-owned offscreen window into the recorder. That is a stepping stone, not the final architecture, because recorder startup/shutdown and browser lifetime would still be split across processes.

## Acceptance Gates

- 1080p30: playable MP4, smooth overlay animation, stop under 2 seconds, repeat twice in one app session.
- 1080p60: encoded cadence near 60 fps, no visible overlay hitches in scripted bursts.
- 4K30: compositor and overlay frame handling comfortably under 33 ms.
- 4K60: average frame handling near or under 16.7 ms with no repeated long stalls.

Each gate should include a static-screen overlay stress test, a real display-selection test, and ffprobe validation for duration, frame count, codec, and MP4 structure.

