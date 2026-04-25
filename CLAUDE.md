# KeyCap — context for future sessions

KeyCap is an Electron screen-recorder for Windows with a native Rust sidecar
(`native/recorder/`) that does the actual capture + encode work. The Electron
main process speaks JSON-over-stdio to the sidecar (see
`native/recorder/src/ipc.rs`).

## Where this branch sits

`claude/determined-mendel-88ea14` is built on top of M3 Bite 1 / Bite 1.5 /
Bite 2 / Bite 3 (see git log). The shipped milestones are:

- **M2.1** — DXGI Desktop Duplication capture, ffmpeg-pipe encode with
  `nvenc → amf → qsv → x264` fallback. Reliable.
- **M2.5** — Overlay compositing in the sidecar over a named pipe.
- **M3 Bite 1 / 1.5** — GPU compositor on D3D11. Capture stays as a GPU
  texture; the compositor renders into NV12 textures via HLSL.
- **M3 Bite 2 / 3** — Media Foundation Sink Writer encoder backend with
  cross-device shared NV12 textures + keyed mutex. Mostly working; had
  Finalize hangs on long sessions.

This branch added an experimental **NVENC SDK direct path** (M3 Bite 4-ish)
that targets zero-copy GPU encode without going through MF or ffmpeg-pipe.
**It is currently disabled** — see "What was tried and didn't stick" below.

## What is in `main` vs this branch

This branch contains everything M2.1 through M3 Bite 3 (already on the parent
branch `cranky-dewdney-080c20`) plus the SDK experiment. The SDK code is
gated off and falls through to the existing MF / ffmpeg-pipe path on every
recording.

## Current encoder selection (session.rs `Session::start`)

```
encoder priority (auto):
  1. NVENC SDK direct           ← disabled (compile-time const false)
  2. MF Sink Writer             ← active when Encoder::Nvenc/Amf/Qsv chosen
                                  AND we have a shared D3D11 device
                                  AND composite_mode == Gpu
  3. ffmpeg-pipe NVENC/AMF/QSV  ← active fallback when MF init fails
  4. ffmpeg-pipe x264           ← CPU fallback
```

The SDK gate is a `const NVENC_SDK_DIRECT_ENABLED: bool = false` near the top
of the encoder-selection block in `session.rs`. Flipping it to `true` re-
enables the SDK try-block (which then tries CUDA-typed NVENC + per-frame
CUarray register/encode).

## What was tried and didn't stick (NVENC SDK direct)

Across roughly a day of debugging, we built and tested:

1. **Same-device D3D11 NVENC SDK** — D3D11 textures registered with NVENC,
   `nvEncEncodePicture` directly. Wedged on `nvEncMapInputResource` after
   1–8 frames intermittently. Root cause unclear; D3D11 same-device + NVENC
   SDK is unconventional (OBS uses CUDA or a separate device).
2. **Per-slot bitstream buffers** — fixed one wedge mode (single shared
   output buffer was internally serializing the encoder).
3. **`ID3D11Fence` cross-engine sync** — fixed another wedge mode (3D
   engine writes vs encoder engine reads weren't ordered).
4. **CUDA-typed NVENC** (`NV_ENC_DEVICE_TYPE_CUDA`) with per-frame CUarray
   register/unregister via `cuGraphicsD3D11RegisterResource` +
   `cuGraphicsMapResources`. **The most reliable path we got** — would
   record cleanly maybe 60-70% of the time, sometimes wedge with
   `cuGraphicsMapResources failed: 999`. Not reliable enough to ship.
5. **Explicit CABAC entropy mode** to land H.264 High profile in the SPS —
   wedged the writer at frame 0 every time, on both D3D11 and CUDA paths.
   Without CABAC, NVENC writes a Constrained Baseline SPS regardless of
   `profileGUID = HIGH`.
6. **`h264_metadata` BSF** for BT.709 SPS VUI tags — multiple syntax
   attempts; correlated with intermittent wedges. Removed.

Bottom line: the SDK direct path on this driver/GPU was too fragile to
ship. The infrastructure is in the tree if a future session wants to take
another swing.

## Files touched on this branch

New:
- `native/recorder/build.rs` — bindgen for NVENC SDK + CUDA headers
- `native/recorder/src/encoder/nvenc.rs` — direct NVENC SDK encoder backend
- `native/recorder/src/encoder/nvenc_sys.rs` — bindgen output (regenerated
  at build time into `OUT_DIR`; this file is just an `include!`)
- `native/recorder/src/encoder/cuda_sys.rs` — hand-written CUDA Driver API
  bindings (loads `nvcuda.dll`, ~13 functions) + `CudaSession` wrapper
- `native/recorder/vendor/nv-codec-headers/nvEncodeAPI.h` — vendored NVENC
  header for bindgen (NVIDIA permissively-licensed via FFmpeg's
  nv-codec-headers project)

Modified:
- `Cargo.toml` / `Cargo.lock` — added `bindgen = "0.70"` build-dep
- `src/session.rs` — encoder-selection logic (SDK gated off), plus a stop
  watchdog (8s timeout per join, abandons threads on timeout — the only
  way to make `Session::stop` bounded when an encoder pipeline wedges),
  plus `mem::forget` of `nv12_ring` / `gpu_state` on composite shutdown
  so dropping a wedged texture doesn't block thread exit.
- `src/encoder/mod.rs` — `NvFramePayload::GpuSlot { idx, fence_value }`
  now carries a fence value for the (disabled) SDK path; MF and ffmpeg
  branches ignore it.
- `src/encoder/mf.rs` — minor: matches new GpuSlot variant shape.
- `src/encoder/ffmpeg.rs` — minor: matches new GpuSlot variant shape.
  The muxer command was extended over the day; it now writes
  fragmented MP4 (`+frag_keyframe+empty_moov+default_base_moof+write_colr`)
  so a watchdog-abandoned writer leaves a playable file. `-color_*`
  flags on input + output specify BT.709 limited-range; this is the
  best we have for color metadata since the in-bitstream VUI path
  (`h264_metadata` BSF) was unreliable.
- `src/gpu/nv12_ring.rs` — `Nv12Ring::new` now takes `shared: bool`. When
  `false`, slot textures are created without `SHARED_NTHANDLE | SHARED_KEYEDMUTEX`
  flags, so they can be used same-device without the keyed-mutex
  protocol. The SDK path used `shared=false`; the MF path uses `shared=true`.
- `src/gpu/compositor.rs` — added a `composite_into_nv12_slot_same_device`
  variant that skips the keyed-mutex dance. The MF code path still uses
  the original `composite_into_nv12_slot`.
- `src/main.rs` — diagnostic log lines on the `stop_recording` IPC path
  (`request received` → `calling Session::stop` → `Session::stop returned`).

## Things that work and stay regardless of which encoder runs

- GPU compositor on D3D11 (HLSL BT.709 NV12 conversion is bit-identical
  to the CPU path in `convert.rs`).
- Per-slot ring of NV12 textures with optional shared-handle export.
- Stop watchdog so the UI un-sticks within ~10s even if the writer wedges.
- `mem::forget` of GPU state on composite shutdown so a wedged writer
  doesn't keep composite from exiting.
- Fragmented MP4 muxer config so partial recordings are still playable.

## To pick this back up

1. **First, sanity-check that the rolled-back path is reliable** for the
   user. Goal: record 5 sessions in a row at 1080p30 + 1 at 4K60, all
   produce playable files, no UI hangs. If yes, this is shippable as-is
   with the known cosmetic issues (Constrained Baseline SPS, possible
   magenta tint depending on player).

2. **If user wants the metadata fixed** (no magenta, High profile in SPS):
   - Try a post-encode `ffmpeg`-mux step that re-muxes the recorded MP4
     with explicit `-color_primaries bt709 -colorspace bt709 ...` and
     a `setts`-style metadata pass. We never tried this because we were
     trying to do it inline; running it as a finalize pass after stop
     might be cleaner.

3. **If user wants to revisit the SDK path:**
   - Switch from per-frame `cuGraphicsD3D11RegisterResource` →
     `nvEncRegisterResource(CUDAARRAY)` → `nvEncEncodePicture` → unregister
     to OBS's actual pattern: `cuMemAlloc` 16 stable CUDA buffers up-front,
     register each *once* with NVENC, per-frame `cuMemcpy2D` from the
     mapped CUarray into the stable buffer.
   - This requires a few more CUDA Driver API functions in `cuda_sys.rs`:
     `cuMemAlloc_v2`, `cuMemFree_v2`, `cuMemcpy2D_v2`, `CUDA_MEMCPY2D` struct.
   - Once that's working, separately try CABAC again — it may have been
     wedge-prone specifically because of the per-frame register churn,
     not CABAC itself.

4. **Driver caveat to remember:** during this debugging the user observed
   that the *first* recording after a fresh build sometimes wedged where
   subsequent recordings on the same binary worked. We never definitively
   pinned this on AV scanning vs driver cold-start, but if it shows up
   again, it's a known-unknown.

## Logs from the day

The user's logs are at `C:/Users/erich/Documents/KeyDisplay/Logs/Log_NN.txt`.
Key reference points:
- **Log_33** — pre-SDK, ffmpeg-pipe NVENC, recording worked end-to-end.
- **Log_49** — SDK + CUDA path, first clean working recording (24+ frames,
  per-slot bitstream buffers + fence sync).
- **Log_54** — best SDK + CUDA recording, 8.5MB / 19s / 28fps actual.
- **Log_56–57** — mid-stream wedges + ffmpeg BSF rejection.
- **Log_58** — last working SDK + CUDA recording, 14.7s / 4.9 Mbps,
  but with magenta tint and visible compression.

After Log_58 the SDK path was disabled.
