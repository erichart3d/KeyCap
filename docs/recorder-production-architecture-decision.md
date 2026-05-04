# Recorder Production Architecture Decision

## Status

Proposed decision after the OBS harness passes.

This document turns the recorder recovery work and OBS browser-source harness results into a production direction. It is not a legal decision, but it identifies the legal/product decision that blocks one of the implementation paths.

## Decision

KeyCap recording should adopt the OBS browser-source model as the required architecture for smooth overlay recording.

The production recorder should not depend on Electron offscreen `paint` callbacks, CPU browser-frame transport, Media Foundation Sink Writer, or NVENC SDK direct mode as the default path for overlay recording. Those paths can remain as diagnostics or fallback experiments, but they should not own the user-facing recorder experience.

The next production spike should be a small recorder sidecar that uses libobs directly, if GPL distribution obligations are acceptable for KeyCap. If GPL obligations are not acceptable, use the libobs sidecar as the reference implementation and build a KeyCap-owned OBS-style browser source with the same timing model.

## Why

The old question was whether 4K60 with overlay was fundamentally too hard. The current evidence says no. OBS can do it on the same machine with the same overlay because OBS owns the browser as a graphics source inside the render/output pipeline.

The important behavior is:

```text
browser paint updates latest texture
video tick samples latest texture
video tick never waits for browser paint
```

This protects output cadence. If Chromium does not paint a new overlay frame for a particular video frame, the output still records on time using the previous complete overlay texture.

## Evidence

### Production Recovery Baseline

The stable recovery path restored working recording by prioritizing reliability over zero-copy:

```text
DDA capture -> CPU/GPU overlay composition -> NV12 -> ffmpeg h264_nvenc/x264 -> MP4
```

That fixed stop/retry and display-source correctness, but it did not solve smooth 60 fps overlay animation. The remaining problem is browser frame ownership and cadence.

### Electron And CEF Offscreen Probes

Electron offscreen and CefSharp offscreen probes proved that the real overlay can render at true 1080p and 4K surface sizes, but CPU paint callbacks are not a reliable 60 fps frame source.

CEF shared texture transport proved that D3D11 handles can be opened and copied cheaply, but shared texture transport alone did not fix cadence. The browser source needs OBS-style scheduling, not just a faster copy.

### OBS Harness Results

The installed-OBS harness now validates the real KeyCap overlay through OBS `browser_source`:

| Scenario | Result |
| --- | --- |
| 1080p60 static background | Recorded and decoded successfully. |
| 4K60 static background | Recorded and decoded successfully. |
| 1080p60 longer key bursts | Visually reviewed as more fluid than prior KeyCap recorder output. |
| 4K60 longer key bursts | Visually reviewed as more fluid than prior KeyCap recorder output. |
| 1080p60 moving background | Visually reviewed as perfectly fluid. |
| 4K60 moving background | Visually reviewed as perfectly fluid. Overlay scale was small, but cadence was flawless. |
| Selected OBS display capture at 3840x1080@60 | Recorded and decoded successfully with no harness errors. |

The result is strong enough to change the architecture question from "Can this be smooth?" to "Which production implementation gives us OBS-style browser-source ownership?"

## Non-Goals

- Do not revive MF Sink Writer as the default recorder path.
- Do not block production recording on NVENC SDK direct mode.
- Do not create a native visual reimplementation of keycap packs or themes.
- Do not accept a record mode that looks different from stream mode.
- Do not tune around Electron offscreen CPU paint as the final 60 fps transport.

## Production Options

### Option A: Libobs Recorder Sidecar

Build a sidecar that embeds libobs and uses OBS sources directly:

```text
KeyCap app control
  -> libobs recorder sidecar
  -> monitor/window/video source
  + obs-browser source for KeyCap overlay
  -> libobs scene/output/encoder
  -> MKV/MP4 output
```

Benefits:

- Highest parity with the harness that already works.
- Mature display capture, browser source scheduling, compositing, encoders, and output handling.
- Reduces the risk of reimplementing obscure CEF/graphics timing behavior.
- Gives us a credible path to window/game capture later.

Costs:

- GPL obligations must be accepted before shipping.
- Packaging OBS runtime pieces will increase installer size and complexity.
- KeyCap state/control must be mapped into an OBS scene graph cleanly.
- The app must manage libobs logs, crash boundaries, profile isolation, and plugin loading.

Recommendation if legally acceptable:

Use this path first. It is the shortest route from proven harness behavior to production behavior.

### Option B: KeyCap-Owned OBS-Style Browser Source

Build the narrow part of OBS we need:

```text
KeyCap recorder
  -> DDA/display capture
  -> recorder-owned CEF browser source
  -> latest shared D3D11 overlay texture
  -> recorder-clocked compositor
  -> ffmpeg/NVENC output
```

Required behavior:

- CEF accelerated paint with shared D3D11 textures.
- Latest-texture semantics.
- Recorder video tick never waits for Chromium.
- Explicit visibility, resize, invalidation, and device-loss handling.
- Same overlay URL/document and same theme runtime as streaming.
- Instrumented paint, stale-frame, key-to-paint, composite, encode, and stop/retry metrics.

Benefits:

- Avoids shipping GPL components if that is a product constraint.
- Keeps the recorder architecture and UI behavior under KeyCap control.
- Can reuse the current stable ffmpeg output baseline.

Costs:

- Higher engineering risk.
- We would recreate years of OBS browser-source edge-case work.
- CEF integration, packaging, and GPU texture lifetime bugs are substantial.
- Window/game capture parity remains separate work.

Recommendation if GPL is unacceptable:

Use this path, but keep the OBS harness as the golden behavior test and do not call the path production-ready until it visually matches the OBS clips.

### Option C: Current Recorder Plus Overlay Optimization

Keep the stable ffmpeg recorder and continue optimizing overlay animation/transport.

Benefits:

- Lowest packaging disruption.
- Builds on a known reliable recovery baseline.

Costs:

- Existing evidence says CPU offscreen paint cadence is the limiter.
- It risks creating different stream and record behavior.
- It does not explain why OBS is flawless with the same overlay.

Recommendation:

Do not pursue as the primary architecture. Keep only small overlay performance improvements that benefit both stream and record.

## Recommended Path

1. Make a product/legal call on GPL compatibility for shipping libobs or obs-browser code with KeyCap.
2. In parallel, create a minimal libobs sidecar proof that records one selected display plus the KeyCap browser source without using the full OBS app.
3. Keep production users on the current stable recorder until the new sidecar passes the gates.
4. If GPL is acceptable, harden the libobs sidecar into the production recorder.
5. If GPL is not acceptable, use the libobs sidecar and installed-OBS harness as the reference while building the KeyCap-owned OBS-style browser source.

## Minimal Libobs Sidecar Proof

The proof should be intentionally small:

- One executable sidecar.
- One isolated OBS profile/config directory.
- One selected monitor source.
- One browser source pointed at the existing KeyCap overlay URL.
- One recording output path.
- Start, stop, status, and logs over the existing app-side sidecar IPC shape.

It should not implement the full editor UI, scene editing, source browsing, themes, or all capture types. The goal is to prove that KeyCap can own and package the same source/output model that the installed-OBS harness validated.

### First Commands

The sidecar should support a small command surface:

```json
{ "type": "list-displays" }
{ "type": "start", "sourceKind": "display", "sourceId": "\\\\.\\DISPLAY2", "width": 3840, "height": 2160, "fps": 60, "outputPath": "..." }
{ "type": "stop" }
{ "type": "status" }
```

### First Metrics

The sidecar must report:

- Output active/inactive state.
- OBS/libobs render frames.
- Encoder output frames.
- Dropped/skipped/lagged frames when available.
- Browser source dimensions and URL.
- Selected source identity and bounds.
- Stop duration.
- Output path and ffprobe result.

## Acceptance Gates

Each gate needs visual review and machine validation.

| Gate | Requirement |
| --- | --- |
| 1080p30 | Playable file, smooth overlay, stop under 2 seconds, repeat twice in one app run. |
| 1080p60 | Same, with encoded cadence near 60 fps and no sluggish overlay fades. |
| 4K30 | Same, with comfortable compositor/output timing under 33 ms. |
| 4K60 | Same, with output cadence near 60 fps and no repeated long stalls. |
| Display selection | Preview/source/recording identity must agree for primary and secondary displays. |
| Overlay scale | 4K output must either preserve user-authored visual intent or expose an explicit scale policy that matches stream mode. |

## Open Product Questions

- Is GPL-compatible distribution acceptable for KeyCap?
- Is a larger installer acceptable if it buys OBS-grade recording reliability?
- Should recording output default to MKV with remux-to-MP4 for stop safety, like OBS?
- What should 4K overlay scale mean: CSS pixel exact, canvas-relative, or user-configurable per output?
- Should record mode use the same overlay server URL as streaming, or a recorder-private overlay document with the same runtime?

## No-Go Criteria

Do not promote a new recorder path to production if any of these are true:

- It blocks video output waiting for browser paints.
- It records smooth only when the captured display is static.
- It cannot stop and start twice in one app session.
- It requires visual differences between stream and record.
- It cannot identify the selected display in logs and reports.
- It fails to produce a playable partial recording after an abnormal stop.

## Current Recommendation

Choose Option A if GPL and packaging constraints are acceptable. It is the path most aligned with the evidence.

If Option A is blocked, choose Option B and treat OBS as the behavioral spec. Do not continue investing heavily in the current Electron offscreen overlay pipe as the final answer.
