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

## Initial Electron Offscreen Findings

The first Electron offscreen probe confirms the real overlay page can render at true 1080p and 4K surface sizes, including larger-than-screen 3840x2160 capture. It also shows Electron's offscreen `paint` event is not a reliable 60 fps overlay frame source on this machine.

| Target | Surface | Paint avg | Paint p95 | Paint max | rAF avg | Interpretation |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| 1080p30 | 1920x1080 | 35.0 ms | 48.9 ms | 113.2 ms | 33.3 ms | Near 30 fps, with occasional visible gaps. |
| 1080p60 | 1920x1080 | 34.0 ms | 65.2 ms | 91.7 ms | 16.7 ms | JS animation clocks at 60, but offscreen paints arrive near 30 fps. |
| 4K30 | 3840x2160 | 35.0 ms | 50.1 ms | 123.6 ms | 33.3 ms | True 4K surface works; paint cadence is still about 30 fps. |
| 4K60 | 3840x2160 | 34.5 ms | 63.1 ms | 99.8 ms | 16.8 ms | Same 60 fps mismatch as 1080p60. |

This does not invalidate the browser-source direction. It specifically argues against treating Electron offscreen `paint` as the final 60 fps transport. OBS's browser source is CEF-backed and renderer/compositor-owned, so the next feasibility step should test CEF offscreen or a GPU texture-backed browser source rather than more Electron paint-loop tuning.

## Initial CEF Offscreen Findings

The first CEF-backed probe uses CefSharp OffScreen to load the real KeyCap overlay and measure CEF `Paint` callbacks. It validates that CEF can render true 1080p and 3840x2160 transparent overlay surfaces, but naive CPU offscreen paint callbacks still do not satisfy the 60 fps recorder requirement.

| Target | Transport | Fade | Surface | Paint avg | Paint p95 | Paint max | rAF avg | Interpretation |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| 1080p30 | CPU paint | default glitch | 1920x1080 | 35.0 ms | 61.6 ms | 83.8 ms | 33.3 ms | Similar to Electron; usable only as a rough 30 fps source. |
| 1080p60 | CPU paint | default glitch | 1920x1080 | 34.0 ms | 60.9 ms | 92.6 ms | 16.7 ms | JS clocks at 60, but paint callbacks arrive near 30 fps. |
| 4K30 | CPU paint | default glitch | 3840x2160 | 34.7 ms | 48.3 ms | 96.8 ms | 33.3 ms | True 4K works; cadence is still roughly 30 fps. |
| 4K60 | CPU paint | default glitch | 3840x2160 | 34.3 ms | 61.9 ms | 97.3 ms | 16.7 ms | Same mismatch as 1080p60. |
| 1080p60 | CPU paint | crt-smear | 1920x1080 | 20.3 ms | 55.6 ms | 112.5 ms | 16.8 ms | More frequent paints, but long gaps remain visible. |
| 4K60 | CPU paint | crt-smear | 3840x2160 | 20.5 ms | 57.8 ms | 92.5 ms | 16.9 ms | Resolution is not the main limiter; callback cadence is. |
| 1080p60 | Shared texture | crt-smear | 1920x1080 | 20.3 ms | 58.1 ms | 111.0 ms | 16.9 ms | D3D11 shared handles work, but cadence still misses 60. |
| 4K60 | Shared texture | crt-smear | 3840x2160 | 20.2 ms | 65.7 ms | 108.0 ms | 16.9 ms | GPU transport avoids CPU BGRA copy but not long paint gaps. |
| 1080p60 | Shared texture + external begin frame | crt-smear | 1920x1080 | 22.1 ms | 61.7 ms | 108.1 ms | 19.1 ms | Recorder-clocked begin frames were less stable in this probe. |
| 1080p60 | Shared texture + D3D11 validation | crt-smear | 1920x1080 | 20.0 ms | 55.6 ms | 97.6 ms | 17.2 ms | Opened and copied 127/127 CEF textures; D3D11 open/copy p95 was 0.65 ms. |
| 4K60 | Shared texture + D3D11 validation | crt-smear | 3840x2160 | 20.0 ms | 67.8 ms | 90.7 ms | 17.2 ms | Opened and copied 127/127 CEF textures; D3D11 open/copy p95 was 0.54 ms. |

This narrows the path: a recorder-owned browser source is still the right product architecture, but CefSharp-style CPU `OnPaint` callbacks are only diagnostic. CEF shared textures are necessary for a production GPU path because they provide D3D11 handles, and the D3D11 validation pass proves those handles can be opened and copied into recorder-owned textures. One detail matters for production: CEF's handles must be treated as D3D11.1 NT handles and opened with `OpenSharedResource1`; legacy `OpenSharedResource` returned `E_INVALIDARG` in the spike. The renderer still needs either OBS/libobs browser-source behavior or substantial animation/compositor tuning before it can be trusted as a 60 fps source.

## CEF Cadence Diagnostics

The next diagnostic pass added controlled render modes to separate CEF/browser delivery from KeyCap's real overlay DOM and animation path. All runs used shared texture transport with D3D11 validation enabled.

| Target | Mode | Paint avg | Paint p95 | Paint max | Gaps | Interpretation |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| 1080p60 | Real fade | 20.0 ms | 30.6 ms | 109.5 ms | 21 | The real key lifecycle misses a steady 60 fps even with simple opacity fade. |
| 1080p60 | Real crt-smear | 19.7 ms | 68.4 ms | 94.7 ms | 21 | The current heavier fade has long visible gaps. |
| 1080p60 | Static real keys | 262.5 ms | 358.5 ms | 358.5 ms | 8 | Expected sparse paints; useful as DOM churn baseline, not animation cadence. |
| 1080p60 | Synthetic transform | 16.5 ms | 30.1 ms | 31.9 ms | 22 | Simple compositor motion is much closer to 60 fps. |
| 1080p60 | Synthetic opacity | 16.6 ms | 29.7 ms | 31.7 ms | 29 | Simple opacity animation is much closer to 60 fps. |
| 1080p60 | Synthetic filter | 16.5 ms | 29.5 ms | 32.9 ms | 28 | A simple filter animation alone is not enough to explain real crt-smear gaps. |
| 4K60 | Real fade | 20.1 ms | 34.1 ms | 101.2 ms | 20 | Same pattern at 4K; resolution is not the primary limiter. |
| 4K60 | Real crt-smear | 19.9 ms | 69.2 ms | 96.4 ms | 22 | The real heavy fade remains the worst p95 case. |
| 4K60 | Synthetic transform | 16.5 ms | 29.4 ms | 31.3 ms | 25 | Synthetic compositor motion remains close to 60 at 4K. |
| 4K60 | Synthetic opacity | 16.5 ms | 29.6 ms | 32.3 ms | 26 | Synthetic opacity remains close to 60 at 4K. |
| 4K60 | Synthetic filter | 16.5 ms | 27.1 ms | 35.5 ms | 15 | Synthetic filter remains close to 60 at 4K. |

The practical read: the GPU texture path is viable, and CEF can deliver simple animated surfaces near the 60 fps budget. The next work should profile and simplify KeyCap's real overlay animation path: key insertion/removal, pack/theme DOM, SVG effect layers, caption layout, and fade classes. If that work cannot remove the long paint gaps, the next architecture spike should compare against OBS/libobs browser source directly.

## Overlay Path Profiling

The follow-up pass profiled the real `addKey` path and added bypass modes for individual pieces of overlay work.

| Target | Mode | Paint avg | Paint p95 | Paint max | AddKey avg | Interpretation |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| 1080p60 | Real fade | 19.7 ms | 30.8 ms | 118.1 ms | 1.85 ms | Baseline real key path. |
| 1080p60 | Real crt-smear | 19.7 ms | 56.8 ms | 104.7 ms | 1.61 ms | Heavy fade still creates long gaps. |
| 1080p60 | Captions disabled | 19.9 ms | 31.4 ms | 110.0 ms | 1.46 ms | Caption DOM is not the limiter. |
| 1080p60 | Theme metrics no-op | 19.5 ms | 31.0 ms | 100.9 ms | 0.14 ms | Theme metrics dominate JS time but not paint cadence. |
| 1080p60 | No expire/removal pressure | 20.1 ms | 31.3 ms | 100.2 ms | 1.61 ms | Fade-out/removal pressure is not the main limiter. |
| 1080p60 | Simple key DOM | 20.2 ms | 31.2 ms | 123.1 ms | 0.18 ms | Minimal key DOM with normal classes still paints around 20 ms. |
| 1080p60 | Pooled key slots | 35.7 ms | 97.9 ms | 379.6 ms | 1.10 ms | Naive hide/show pooling is worse. |
| 4K60 | Theme metrics no-op | 20.0 ms | 31.0 ms | 92.3 ms | 0.13 ms | Same conclusion at 4K. |
| 4K60 | Simple key DOM | 19.9 ms | 31.6 ms | 99.8 ms | 0.10 ms | Same conclusion at 4K. |

This rules out a simple JavaScript micro-optimization as the primary fix. The real issue appears tied to CEF offscreen delivery of finite, dynamically introduced key animations. The next serious fork is either:

- Compare against OBS/libobs browser source directly, since OBS already solves this browser/compositor scheduling problem in production.
- Prototype a different KeyCap animation delivery model, such as persistent compositor-owned surfaces or a browser animation clock designed around recorder sampling, while proving stream and record remain visually identical.

## Acceptance Gates

- 1080p30: playable MP4, smooth overlay animation, stop under 2 seconds, repeat twice in one app session.
- 1080p60: encoded cadence near 60 fps, no visible overlay hitches in scripted bursts.
- 4K30: compositor and overlay frame handling comfortably under 33 ms.
- 4K60: average frame handling near or under 16.7 ms with no repeated long stalls.

Each gate should include a static-screen overlay stress test, a real display-selection test, and ffprobe validation for duration, frame count, codec, and MP4 structure.

