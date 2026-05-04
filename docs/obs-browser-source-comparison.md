# OBS Browser Source Comparison

## Summary

OBS records browser overlays smoothly because the browser is not an external frame producer that the recorder waits on. It is a first-class libobs source. CEF paints update a graphics texture, and the OBS render/output pipeline samples the latest texture on each video frame.

That is the architecture we should compare against next. The current KeyCap recovery recorder is stable for display capture and encoding, but the overlay path still has browser paint cadence gaps. Electron offscreen and CefSharp offscreen probes have shown that CPU paint callbacks are not enough, while CEF shared textures are viable but still need OBS-style scheduling or a different animation delivery model.

Source references inspected locally:

- [obs-browser `obs-browser-source.cpp`](https://github.com/obsproject/obs-browser/blob/19b1c9631bc0c4e50f03238fa72d92f78ccae6a2/obs-browser-source.cpp)
- [obs-browser `browser-client.cpp`](https://github.com/obsproject/obs-browser/blob/19b1c9631bc0c4e50f03238fa72d92f78ccae6a2/browser-client.cpp)
- [obs-browser `obs-browser-source.hpp`](https://github.com/obsproject/obs-browser/blob/19b1c9631bc0c4e50f03238fa72d92f78ccae6a2/obs-browser-source.hpp)
- [obs-browser `browser-app.cpp`](https://github.com/obsproject/obs-browser/blob/19b1c9631bc0c4e50f03238fa72d92f78ccae6a2/browser-app.cpp)
- [OBS Studio repository](https://github.com/obsproject/obs-studio/tree/085a51ab0f0573412a368905bb9a843e2de4cecd)

## What OBS Does Differently

### 1. Browser frames are graphics textures

When hardware acceleration and shared textures are available, OBS creates the CEF browser with:

- windowless rendering enabled
- shared texture support enabled
- a browser client that receives accelerated paint callbacks

On Windows, `BrowserClient::OnAcceleratedPaint` opens CEF's shared handle with `gs_texture_open_nt_shared(...)`. That mirrors what the KeyCap CEF spike discovered independently: modern CEF accelerated paint handles are D3D11.1 NT shared handles, not legacy shared handles.

The key difference is ownership. OBS immediately turns the browser paint into a libobs `gs_texture_t`. It does not copy browser pixels through a CPU pipe for the normal GPU path.

### 2. Rendering samples the latest available browser texture

`BrowserSource::Render()` draws `bs->texture` if one exists. CEF paint callbacks update that texture out of band; the render path does not block waiting for a fresh browser paint. This is the important cadence rule:

```text
video frame tick -> draw current browser texture
browser paint    -> replace/update current browser texture
```

If CEF misses a paint, OBS still produces the video frame. The browser source may visually hold for a frame, but capture/compose/encode cadence is protected.

### 3. OBS has explicit frame-rate discipline

OBS ties the browser source frame rate to either:

- the OBS canvas video FPS, or
- a custom browser source FPS

With shared textures and external begin frame support, OBS can set `windowless_frame_rate = 0` and call `SendExternalBeginFrame()` from the render flow. Without that compile-time path, it still updates `SetWindowlessFrameRate(video_fps)` when the OBS canvas FPS changes.

This is materially different from an Electron or CefSharp offscreen probe where paint callbacks arrive according to Chromium's offscreen heuristics and application message-loop timing.

### 4. Visibility, resize, and invalidation are disciplined

OBS explicitly sends browser visibility to CEF:

- visible: `WasResized()`, `WasHidden(false)`, `Invalidate(PET_VIEW)`
- hidden: `WasHidden(true)`

It also destroys/recreates textures when the browser surface changes size, and it handles sRGB/linear texture differences before drawing. Those details matter for long-running stop/retry stability.

### 5. OBS composes and encodes inside one output pipeline

The browser source, display/game/window sources, scene compositor, and encoder output all live inside libobs's graphics/output model. That removes a lot of cross-process timing ambiguity:

```text
libobs display source
  + libobs browser source
  -> libobs scene render
  -> libobs output/encoder
```

KeyCap currently has separate responsibilities spread across Electron, a Rust recorder, overlay IPC, D3D11 capture/composite, and ffmpeg encoding. The recovery build made that reliable again, but the overlay smoothness problem is still mostly about the browser source boundary.

## Current KeyCap Evidence

The browser-source probes show:

- Electron offscreen paint is roughly 30 fps even when rAF runs at 60 fps.
- CefSharp CPU paint is diagnostic only; it is not a production 60 fps transport.
- CEF shared textures can be received and copied with D3D11 cheaply.
- Simple synthetic CEF animations get much closer to 60 fps than the real KeyCap key lifecycle.
- `addKey` JavaScript time is not the primary limiter; even simplified DOM variants hover around roughly 20 ms paint cadence with occasional long gaps.

That makes the next question very specific:

> Does OBS/libobs browser-source scheduling record the real KeyCap overlay smoothly, or does the real overlay animation path still miss cadence even inside OBS's pipeline?

## Recommended Next Spike

Build a separate libobs feasibility harness. Keep it isolated from production KeyCap recording until it proves the gates.

### Harness goals

- Initialize libobs video at 1920x1080/60 and 3840x2160/60.
- Create a scene with a static background source first, then a browser source that loads the real KeyCap overlay URL/document.
- Drive the same key/config events used by stream mode.
- Record or render a short output using OBS's browser source and output pipeline.
- Repeat each run twice in the same process to test stop/retry.
- Collect timing and output validation:
  - browser source paint cadence if exposed
  - rendered video frame count
  - output FPS and duration from ffprobe
  - visible key animation consistency from the stress clip

### First harness phase

Use a static background instead of display capture. This isolates browser source cadence from DDA capture and encoder pressure.

```text
static background -> OBS browser source -> OBS output
```

Pass condition: real KeyCap key bursts look consistently snappy at 1080p60 and 4K60.

### Second harness phase

Add the real capture source or a GPU test-video source:

```text
captured/test video source -> OBS browser source -> OBS output
```

Pass condition: the browser source remains smooth while the background moves and the encoder is active.

### Decision points

- If the libobs harness is smooth, prioritize a production libobs recorder sidecar or a KeyCap-owned source modeled after libobs.
- If the harness shows the same sluggish key fades, the issue is in the overlay runtime itself and we should redesign the animation model while preserving identical stream/record visuals.
- If the harness is smooth only at 1080p60, separate browser cadence from 4K compositor/encoder pressure before choosing an architecture.

## Production Options

### Option A: Libobs recorder sidecar

Highest OBS parity. The recorder becomes a small OBS-like output pipeline: display source, browser source, scene, encoder, muxer.

Pros:

- Closest to the proven OBS behavior.
- Reuses the browser source scheduling model that already works for creators.
- Gives us mature scene/output/encoder behavior.

Cons:

- Packaging and runtime complexity are significant.
- Integrating KeyCap control/state into libobs cleanly is non-trivial.
- Licensing must be resolved before production use.

### Option B: KeyCap-owned OBS-style browser source

Reimplement the useful parts: CEF shared texture browser source, latest-texture render semantics, recorder-clocked composition, D3D11 texture ownership, and robust visibility/resize handling.

Pros:

- Keeps the recorder architecture under our control.
- Avoids adopting the whole libobs runtime if licensing/product constraints rule it out.
- Directly targets the overlay smoothness boundary.

Cons:

- More engineering risk than using libobs.
- We would be recreating years of OBS browser-source polish and driver workarounds.
- It still may not fix the real overlay animation path if the DOM/CSS lifecycle is the limiter.

### Option C: Keep current recorder, optimize overlay runtime

Keep the ffmpeg NV12 recovery pipeline and redesign key animations to be friendlier to offscreen CEF delivery.

Pros:

- Smallest recorder disruption.
- Builds on the reliable baseline already validated.

Cons:

- The current evidence says micro-optimizing `addKey` is unlikely to be enough.
- It risks diverging from the true OBS/browser-source behavior creators expect.
- It does not answer why OBS browser source handles the same class of workload so well.

## Licensing Note

OBS Studio and obs-browser source files are GPL-2.0-or-later. A local feasibility harness is useful research, but shipping libobs or obs-browser code inside KeyCap requires a deliberate product/legal decision. If GPL obligations are incompatible with KeyCap distribution, the libobs harness still helps define the behavior we need to reproduce independently.

## Proposed Gate

Before changing the production recorder again, prove one of these:

- OBS/libobs harness records the real KeyCap overlay smoothly at 1080p60 and 4K60.
- A KeyCap-owned CEF shared-texture source can match that behavior in an isolated harness.
- The overlay runtime is modified so both OBS browser source and KeyCap's recorder-owned browser source produce identical, smooth output.

The strongest next move is the libobs harness because it directly tests the user's observed truth: OBS can record the browser source smoothly.
