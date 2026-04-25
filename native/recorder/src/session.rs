//! Recording session: ties capture + encoder together, owns the counters
//! that feed `get_status`.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender, TryRecvError};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::capture::frame::{Frame, FramePayload};
use crate::capture::{self, CaptureHandle, DisplayInfo};
#[cfg(windows)]
use crate::capture::GpuTexturePool;
use crate::convert;
use crate::encoder::{
    self, Encoder, EncoderBackend, FfmpegParams, FfmpegPipe, NvFramePayload,
};
#[cfg(windows)]
use crate::gpu::{self, CompositeMode};
use crate::overlay::{self, OverlayFrame};

#[derive(Debug, Deserialize)]
#[allow(non_snake_case)]
pub struct StartParams {
    #[serde(default)]
    pub sourceKind: Option<String>,
    pub sourceId: String,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    #[serde(default)]
    pub fps: Option<u32>,
    #[serde(default)]
    pub format: Option<String>,
    #[serde(default)]
    pub container: Option<String>,
    #[serde(default)]
    pub bitrateKbps: Option<u32>,
    #[serde(default)]
    pub encoder: Option<String>,
    #[serde(default)]
    pub outputDir: Option<String>,
}

#[derive(Debug, Serialize)]
#[allow(non_snake_case)]
pub struct StartResult {
    pub ok: bool,
    pub outputPath: String,
    pub encoderUsed: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrateKbps: u32,
}

#[derive(Debug, Serialize)]
#[allow(non_snake_case)]
pub struct StopResult {
    pub ok: bool,
    pub outputPath: String,
    pub durationMs: u64,
    pub framesCaptured: u64,
    pub framesEncoded: u64,
    pub framesDropped: u64,
    pub encoderUsed: String,
}

#[derive(Debug, Default, Clone)]
pub struct Stats {
    pub frames_captured: u64,
    pub frames_encoded: u64,
    pub frames_dropped: u64,
    #[allow(dead_code)]
    pub bytes_piped: u64,
    pub elapsed_ms: u64,
    pub pipe_mib_per_sec: f64,
}

struct Counters {
    captured: AtomicU64,
    encoded: AtomicU64,
    dropped: AtomicU64,
    bytes: AtomicU64,
}

impl Counters {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            captured: AtomicU64::new(0),
            encoded: AtomicU64::new(0),
            dropped: AtomicU64::new(0),
            bytes: AtomicU64::new(0),
        })
    }
}

/// Message sent from composite thread to writer thread. `Frame` carries a
/// freshly-composited BGRA buffer; `Dup` tells the writer to re-write its
/// own stored last buffer (hold timeline without re-transmitting 33 MB of
/// identical bytes at 4K60).
enum WriteMsg {
    Frame(Vec<u8>),
    Dup,
}

pub struct Session {
    output_path: PathBuf,
    encoder_used: Encoder,
    fps: u32,
    width: u32,
    height: u32,
    #[cfg(windows)]
    composite_mode: CompositeMode,
    started_at: Instant,
    counters: Arc<Counters>,
    capture: Option<CaptureHandle>,
    composite_join: Option<std::thread::JoinHandle<Result<()>>>,
    writer_join: Option<std::thread::JoinHandle<Result<()>>>,
    stop_signal: Arc<Mutex<bool>>,
}

impl Session {
    pub fn start(
        ffmpeg_path: &Path,
        displays: &[DisplayInfo],
        params: StartParams,
        available_encoders: &[Encoder],
        default_output_dir: &Path,
        overlay_latest: Option<Arc<Mutex<Option<OverlayFrame>>>>,
    ) -> Result<Self> {
        let source_kind = params.sourceKind.as_deref().unwrap_or("display");
        if source_kind != "display" {
            return Err(anyhow!(
                "native recorder currently supports display capture only (got kind={source_kind})"
            ));
        }
        // Container: MP4 only in M2. WebM is explicitly rejected so the UI
        // falls back to MediaRecorder for that format.
        let container = params
            .container
            .as_deref()
            .or(params.format.as_deref())
            .unwrap_or("mp4")
            .to_lowercase();
        if container != "mp4" {
            return Err(anyhow!(
                "native recorder only writes mp4 in this build (got container={container})"
            ));
        }

        let display = displays
            .iter()
            .find(|d| d.id == params.sourceId)
            .ok_or_else(|| anyhow!("display {} is not available", params.sourceId))?;

        // Round up to even — NV12 subsamples chroma 2× in each axis, so
        // odd dims aren't representable. DDA already returns native
        // (always even) res; this only matters when the user explicitly
        // requests an odd size.
        let raw_w = params.width.unwrap_or(display.width).max(2);
        let raw_h = params.height.unwrap_or(display.height).max(2);
        let width = (raw_w + 1) & !1;
        let height = (raw_h + 1) & !1;
        let fps = params.fps.unwrap_or(60).clamp(1, 240);
        let bitrate_kbps = params
            .bitrateKbps
            .unwrap_or_else(|| default_bitrate(width, height, fps));

        let requested = params
            .encoder
            .as_deref()
            .and_then(|e| match e.to_lowercase().as_str() {
                "auto" | "" => None,
                other => Encoder::from_label(other),
            });

        // Re-probe at the real capture resolution. Some hardware encoders
        // (e.g. older NVENC silicon at ultrawide) pass the baseline probe
        // but fail to open at 5120×1440 or 4K; fall through the priority
        // list until one actually works at this size.
        let mut remaining: Vec<Encoder> = available_encoders.to_vec();
        let chosen = loop {
            let candidate = encoder::select(requested, &remaining)
                .ok_or_else(|| {
                    if let Some(requested) = requested {
                        anyhow!(
                            "requested encoder {} is not available on this machine at {}x{}",
                            requested, width, height
                        )
                    } else {
                        anyhow!(
                            "no h264 encoder can open at {}x{} on this machine",
                            width, height
                        )
                    }
                })?;
            if encoder::probe_at(ffmpeg_path, candidate, width, height, fps) {
                break candidate;
            }
            tracing::warn!(
                encoder = %candidate,
                width,
                height,
                "encoder failed resolution probe; dropping from this session"
            );
            remaining.retain(|e| *e != candidate);
            if requested == Some(candidate) {
                // User explicitly asked for an encoder that doesn't work at
                // this resolution — don't silently fall through.
                return Err(anyhow!(
                    "requested encoder {} failed to open at {}x{}",
                    candidate, width, height
                ));
            }
        };

        let output_path = build_output_path(
            params.outputDir.as_deref().map(Path::new),
            default_output_dir,
        )?;

        // Decide CPU vs GPU composite mode once, at session start. Probe
        // a throwaway D3D11 device for NV12 render-target support, then
        // honor `KEYCAP_RECORDER_COMPOSITE` if set. The actual GPU
        // compositor will be built on the DDA capture device below; this
        // probe is just an early "is the GPU even capable" gate.
        #[cfg(windows)]
        let mut composite_mode = {
            let support = match gpu::probe_adapter_default() {
                Ok(s) => s,
                Err(err) => {
                    tracing::warn!(?err, "GPU composite probe failed; using CPU path");
                    gpu::GpuSupport {
                        feature_level_11_0: false,
                        nv12_render_target: false,
                        bgra_render_target: false,
                    }
                }
            };
            gpu::resolve_mode(support)
        };

        // Phase 1: prepare the capture backend on this thread so we have
        // the D3D11 device + context (DDA only) to build the GPU
        // compositor on the SAME device the capture loop will use. This
        // is what avoids cross-device texture sharing in Bite 1.5.
        let prepared = capture::prepare_capture(&display.id)
            .context("prepare display capture")?;

        // If the env probe + monitor probe both said GPU is fine, try to
        // build the actual compositor + pool on the shared device. Any
        // failure here demotes to CPU mode for the rest of the session.
        #[cfg(windows)]
        let (gpu_state, capture_pool) = {
            if matches!(composite_mode, CompositeMode::Gpu) {
                match (prepared.device(), prepared.context()) {
                    (Some(device), Some(context)) => {
                        match gpu::SessionCompositor::new(
                            device.clone(),
                            context,
                            width,
                            height,
                        ) {
                            Ok(s) => {
                                let (cap_w, cap_h) = prepared.dimensions();
                                // Capacity 4: one texture in DDA's
                                // just-emitted slot, one in composite,
                                // one in the recycle path, one free for
                                // DDA to acquire next. Two would force
                                // DDA to stall whenever composite was
                                // mid-render.
                                let pool = GpuTexturePool::new(
                                    device.clone(),
                                    cap_w,
                                    cap_h,
                                    4,
                                );
                                tracing::info!(
                                    width,
                                    height,
                                    cap_w,
                                    cap_h,
                                    "GPU compositor + capture pool initialized on shared DDA device"
                                );
                                (Some(s), Some(pool))
                            }
                            Err(err) => {
                                tracing::warn!(
                                    ?err,
                                    "GPU compositor init failed on shared DDA device; falling back to CPU composite"
                                );
                                composite_mode = CompositeMode::Cpu;
                                (None, None)
                            }
                        }
                    }
                    _ => {
                        tracing::warn!(
                            "GPU mode requested but capture backend exposes no shared D3D11 device (likely WGC); falling back to CPU composite"
                        );
                        composite_mode = CompositeMode::Cpu;
                        (None, None)
                    }
                }
            } else {
                (None, None)
            }
        };

        let ffmpeg_params = FfmpegParams {
            ffmpeg_path: ffmpeg_path.to_path_buf(),
            encoder: chosen,
            width,
            height,
            fps,
            bitrate_kbps,
            output: output_path.clone(),
        };
        // Construct the encoder backend behind the EncoderBackend trait.
        // Today every session uses FfmpegPipe; Bite 2 will dispatch to
        // MfEncoder here when the resolved (encoder, composite_mode) pair
        // supports zero-copy GPU input.
        let backend: Box<dyn EncoderBackend> = Box::new(
            FfmpegPipe::spawn(&ffmpeg_params)
                .with_context(|| format!("spawn ffmpeg for {} encode", chosen))?,
        );
        tracing::info!(
            encoder = backend.label(),
            backend = "ffmpeg",
            width,
            height,
            fps,
            "encoder backend ready"
        );

        let counters = Counters::new();
        let stop_signal = Arc::new(Mutex::new(false));
        // Bounded channel: if the encoder stalls, newer frames are dropped
        // rather than unbounded buffering. Capacity 3 matches ~50 ms at 60 fps.
        let (tx, rx) = sync_channel::<Frame>(3);

        // Writer channel: composite thread → writer thread. Capacity 1 keeps
        // the pipeline at most one frame ahead of ffmpeg so we don't buffer
        // gigabytes under load. Blocking send on full lets the writer
        // backpressure the composite thread naturally — the wallclock pacer
        // in composite absorbs the delay and its resync branch re-aligns
        // with wallclock on the next tick. At 60 fps with compose≈write,
        // this perfectly overlaps the two stages: per-frame wallclock cost
        // drops from (compose+write) to max(compose, write).
        let (writer_tx, writer_rx) = sync_channel::<WriteMsg>(1);

        // ── Writer thread ───────────────────────────────────────────────
        // Owns the encoder backend. Blocks on the channel, writes to
        // backend. Keeps its own `last_bytes` to handle WriteMsg::Dup
        // without round-tripping the full NV12 buffer back through the
        // channel. The backend may be ffmpeg (today), Media Foundation
        // (Bite 2), or any other implementation of `EncoderBackend`.
        let writer_counters = Arc::clone(&counters);
        let writer_join = std::thread::spawn(move || -> Result<()> {
            let mut backend = backend;
            let mut last_bytes: Vec<u8> = Vec::new();
            loop {
                match writer_rx.recv() {
                    Ok(WriteMsg::Frame(bytes)) => {
                        if let Err(err) =
                            backend.write_nv12_frame(NvFramePayload::Cpu(&bytes))
                        {
                            tracing::error!(?err, "encoder write failed; stopping session");
                            break;
                        }
                        writer_counters.encoded.fetch_add(1, Ordering::Relaxed);
                        writer_counters.bytes.fetch_add(bytes.len() as u64, Ordering::Relaxed);
                        last_bytes = bytes;
                    }
                    Ok(WriteMsg::Dup) => {
                        if last_bytes.is_empty() {
                            continue;
                        }
                        if let Err(err) =
                            backend.write_nv12_frame(NvFramePayload::Cpu(&last_bytes))
                        {
                            tracing::error!(?err, "encoder dup write failed; stopping session");
                            break;
                        }
                        writer_counters.encoded.fetch_add(1, Ordering::Relaxed);
                        writer_counters.bytes.fetch_add(last_bytes.len() as u64, Ordering::Relaxed);
                    }
                    Err(_) => break, // composite thread dropped its sender
                }
            }
            backend.finish(Duration::from_secs(10))
        });

        // ── Composite thread ────────────────────────────────────────────
        // Wallclock-paced. Drains capture channel to newest frame, resizes
        // (if needed), composites overlay, hands Vec<u8> to writer. Measures
        // composite time only; write time is logged separately in writer
        // below (though keeping it visible here lets us see the pipeline
        // ratio in one place — we read a rough write estimate from
        // send-blocked time instead).
        let encoder_counters = Arc::clone(&counters);
        let encoder_stop = Arc::clone(&stop_signal);
        let encoder_overlay = overlay_latest.clone();
        let encoder_width = width;
        let encoder_height = height;
        let encoder_fps = fps;
        // Shared "is the GPU emit path live?" flag. Flipped to false here
        // on a GPU compositor failure; DDA reads it on its next iteration
        // and switches to CPU emit so the recording continues gracefully
        // on the CPU composite path. See `start_dda_loop` for details.
        #[cfg(windows)]
        let want_gpu_emit_init = matches!(composite_mode, CompositeMode::Gpu);
        #[cfg(not(windows))]
        let want_gpu_emit_init = false;
        let gpu_emit_active = Arc::new(AtomicBool::new(want_gpu_emit_init));
        let encoder_gpu_emit_active = Arc::clone(&gpu_emit_active);
        // SessionCompositor was built above on the caller thread (on the
        // shared DDA device). Move it into the composite thread; it's
        // the sole consumer.
        #[cfg(windows)]
        let mut moved_gpu_state = gpu_state;
        let composite_join = std::thread::spawn(move || -> Result<()> {
            #[cfg(windows)]
            let mut gpu_state: Option<gpu::SessionCompositor> = moved_gpu_state.take();
            // Pace the pipe at exactly target fps by wallclock. ffmpeg
            // stamps each rawvideo frame at 1/fps, so if we write fewer
            // than fps frames per wallclock second (composite stalls,
            // capture dropped, whatever), the output duration comes out
            // shorter than wallclock and the clip plays sped up. When
            // no fresh frame is available at tick time, re-write the
            // last composited bytes. The result is a CFR stream whose
            // duration always matches wallclock.
            let tick = Duration::from_secs_f64(1.0 / f64::from(encoder_fps));
            let mut next_tick = Instant::now();
            // We no longer hold `last_bytes` here — the writer thread does.
            // Composite produces one Vec<u8> per frame and ships it away.
            // Track whether we've successfully sent the first frame so we
            // can rebase the pacer after ffmpeg's codec init stall (which
            // lives inside the writer thread's first write_frame call).
            let mut primed = false;
            let mut have_first_frame = false;

            // Cached pre-scaled overlay. When the Electron paint buffer
            // is smaller than the encoder output (Windows DPI scaling
            // clamps the OSR BrowserWindow to 1920×1032 on a 4K display
            // at 200%), we used to NN-upscale + blend on every composite
            // tick via `composite_scaled`. At 4K that blew past the
            // 16.67 ms budget and produced 2× playback. Since overlay
            // updates arrive at ~5–30 Hz but composite runs at 60 Hz,
            // caching a pre-scaled copy keyed on `seq` skips the upscale
            // 50–90% of the time — turning `composite_scaled` into a
            // plain `composite` on the happy path.
            let mut scaled_cache: Vec<u8> = Vec::new();
            let mut cached_ov_seq: Option<u64> = None;
            let mut cached_ov_src_dims: (u32, u32) = (0, 0);
            let mut cached_ov_dst_dims: (u32, u32) = (0, 0);

            let mut disconnected = false;
            let mut last_log = Instant::now();
            let mut sends_since_log: u64 = 0;
            let mut dups_since_log: u64 = 0;
            let mut composite_nanos: u64 = 0;
            // Time spent blocked on the writer channel — proxy for how much
            // of our tick budget is spent waiting for the pipe. If this
            // grows, the writer is the bottleneck (pipe bandwidth / ffmpeg).
            let mut send_block_nanos: u64 = 0;
            // One-shot diagnostic: log when the FIRST captured frame arrives
            // on the composite thread. Pairs with the existing "encoder
            // pacing" log (which fires every 2 s once frames are flowing) so
            // an unhealthy session can be diagnosed from a single capture:
            // - no first-frame log    → DDA isn't delivering (static screen,
            //                            wrong display, capture broken).
            // - first-frame log only  → composite hung after frame 1 (likely
            //                            GPU readback timeout / Map error).
            // - both logs             → pipeline is healthy.
            let mut logged_first_frame = false;
            // One-shot: log the wall-clock cost of the FIRST successful
            // GPU composite. This includes the driver's per-session
            // pipeline-state compile that lives inside `Flush` / first
            // `Map(READ)` and is the dominant cost at session start.
            // Subsequent composites are an order of magnitude faster.
            #[cfg(windows)]
            let mut logged_first_gpu_composite = false;
            loop {
                if *encoder_stop.lock() {
                    break;
                }
                // Sleep until the next tick so writes are wallclock-paced.
                // recv_timeout() can't do this — it returns as soon as a
                // message is ready, which drains a backlog in no time.
                let now = Instant::now();
                if now < next_tick {
                    std::thread::sleep(next_tick - now);
                }

                // Drain all queued frames non-blockingly and keep the
                // newest one — if capture is faster than fps (e.g. 120Hz
                // display at 60 target), older frames are stale.
                let mut frame_opt: Option<Frame> = None;
                loop {
                    match rx.try_recv() {
                        Ok(f) => frame_opt = Some(f),
                        Err(TryRecvError::Empty) => break,
                        Err(TryRecvError::Disconnected) => {
                            disconnected = true;
                            break;
                        }
                    }
                }

                let msg = if let Some(frame) = frame_opt {
                    if !logged_first_frame {
                        logged_first_frame = true;
                        let payload_kind = match &frame.payload {
                            FramePayload::Cpu(_) => "cpu",
                            #[cfg(windows)]
                            FramePayload::Gpu(_) => "gpu",
                        };
                        tracing::info!(
                            payload = payload_kind,
                            frame_w = frame.width,
                            frame_h = frame.height,
                            "first capture frame received on composite thread"
                        );
                    }
                    let t_c = Instant::now();

                    // ── GPU composite path ──────────────────────────────
                    // The DDA backend already wrote the capture BGRA into
                    // a pooled GPU texture and handed us its pre-cached
                    // SRV. No upload step here — sample the SRV directly,
                    // upload only the overlay (which still arrives as a
                    // CPU `Vec<u8>` from the Electron pipe), run the
                    // shader pipeline, fence, then off-context wait + map.
                    //
                    // Any error in this block disables the GPU path for
                    // the rest of the session — we fall through to the
                    // CPU branch on the very next frame.
                    #[cfg(windows)]
                    let gpu_nv12: Option<Vec<u8>> = if let (Some(gs), FramePayload::Gpu(_)) =
                        (gpu_state.as_mut(), &frame.payload)
                    {
                        let gpu_t = Instant::now();
                        let gpu_result = (|| -> Result<Vec<u8>> {
                            // Pull the SRV out of the pool handle. The
                            // capture pool keeps texture+SRV bundled so
                            // we don't recreate the SRV per frame.
                            let gf = match &frame.payload {
                                FramePayload::Gpu(g) => g,
                                _ => unreachable!(),
                            };
                            let cap_srv = gf.texture.srv().clone();
                            let ov_srv = if let Some(latest) = encoder_overlay.as_ref() {
                                let guard = latest.lock();
                                match guard.as_ref() {
                                    Some(ov)
                                        if ov.width > 0
                                            && ov.height > 0
                                            && ov.data.len()
                                                == (ov.width as usize)
                                                    * (ov.height as usize)
                                                    * 4 =>
                                    {
                                        let srv = gs
                                            .overlay_uploader
                                            .upload(&ov.data, ov.width, ov.height, ov.seq)?
                                            .clone();
                                        Some(srv)
                                    }
                                    _ => None,
                                }
                            } else {
                                None
                            };
                            gs.compositor
                                .composite_and_convert_to_nv12(&cap_srv, ov_srv.as_ref())
                        })();
                        match gpu_result {
                            Ok(v) => {
                                if !logged_first_gpu_composite {
                                    logged_first_gpu_composite = true;
                                    tracing::info!(
                                        elapsed_ms = gpu_t.elapsed().as_secs_f64() * 1000.0,
                                        "first GPU composite succeeded (includes driver pipeline-state compile)"
                                    );
                                }
                                Some(v)
                            }
                            Err(err) => {
                                tracing::error!(
                                    ?err,
                                    elapsed_ms = gpu_t.elapsed().as_secs_f64() * 1000.0,
                                    "GPU composite failed mid-session; disabling GPU path \
                                     and switching DDA to CPU emit"
                                );
                                // Tell DDA to start emitting CPU frames on
                                // its next iteration so the rest of the
                                // session keeps producing real video on
                                // the CPU composite path. Without this,
                                // DDA would keep emitting GPU frames that
                                // the (now-disabled) GPU branch can't
                                // consume, and the composite thread would
                                // dup-write the last good frame for the
                                // remaining duration of the recording.
                                encoder_gpu_emit_active
                                    .store(false, Ordering::Relaxed);
                                None
                            }
                        }
                    } else {
                        None
                    };
                    #[cfg(windows)]
                    let gpu_path_hit = gpu_nv12.is_some();
                    #[cfg(not(windows))]
                    let gpu_nv12: Option<Vec<u8>> = None;
                    #[cfg(not(windows))]
                    let gpu_path_hit = false;

                    // On fatal GPU error, tear down so subsequent frames
                    // skip the GPU branch entirely. This matches the
                    // "fail loud, fall back once" rule in the encoder
                    // layer — we don't flap between paths mid-session.
                    #[cfg(windows)]
                    {
                        if gpu_state.is_some() && !gpu_path_hit {
                            // Note: the capture pool stays allocated; DDA
                            // is still emitting GPU frames. We just stop
                            // sampling them. Since the CPU branch below
                            // expects `FramePayload::Cpu`, dropping
                            // `gpu_state` here also requires that the
                            // surviving CPU path can handle a Gpu frame
                            // — see the unreachable! guard below.
                            gpu_state = None;
                        }
                    }

                    let nv12: Vec<u8> = if let Some(v) = gpu_nv12 {
                        v
                    } else {
                        // CPU path needs a CPU buffer. If DDA was emitting
                        // GPU frames and the GPU path just failed, this
                        // frame's texture has no CPU bytes to fall back
                        // to — we'd have to read it back, which is
                        // exactly the cost the GPU path was supposed to
                        // avoid. Drop this frame as a duplicate-tick;
                        // subsequent frames will arrive on whichever
                        // emit path the capture loop is still using. In
                        // practice the GPU path failing is rare and
                        // typically means the GPU is in trouble, not a
                        // recoverable per-frame fault.
                        #[cfg(windows)]
                        if matches!(frame.payload, FramePayload::Gpu(_)) {
                            tracing::warn!(
                                "GPU frame received but GPU compositor disabled; treating as dup tick"
                            );
                            drop(frame);
                            // Fall through to the dup branch below by
                            // forcing a zero-width retry. Easier: emit a
                            // Dup right here.
                            if have_first_frame {
                                dups_since_log += 1;
                                composite_nanos += t_c.elapsed().as_nanos() as u64;
                                let t_s = Instant::now();
                                match writer_tx.send(WriteMsg::Dup) {
                                    Ok(()) => {
                                        send_block_nanos += t_s.elapsed().as_nanos() as u64;
                                    }
                                    Err(_) => break,
                                }
                                next_tick += tick;
                                let now = Instant::now();
                                if now > next_tick + tick {
                                    next_tick = now + tick;
                                }
                                continue;
                            } else {
                                next_tick = Instant::now() + tick;
                                continue;
                            }
                        }
                    let needed = (encoder_width as usize) * (encoder_height as usize) * 4;
                    let mut buf: Vec<u8> = if frame.width == encoder_width
                        && frame.height == encoder_height
                    {
                        // Fast path: capture is already at output size.
                        // Consume the capture buffer directly instead of
                        // allocating + zeroing a fresh 33 MiB Vec and
                        // then copying the whole frame into it. Saves one
                        // full-frame copy + zero-init per fresh frame at
                        // 4K (~6–9 ms combined on a typical desktop).
                        let mut b = frame.into_buffer();
                        // In case the pooled buffer was shorter than needed,
                        // top it up. In practice it's always the full frame
                        // size, so this is a no-op.
                        if b.len() < needed {
                            b.resize(needed, 0);
                        } else if b.len() > needed {
                            b.truncate(needed);
                        }
                        b
                    } else {
                        // Downscale (or upscale) the captured frame to the
                        // requested output size. DDA always returns native
                        // resolution; the UI often picks a lower output.
                        // Skip zero-init — `resize_bgra_nn` writes every
                        // byte in dst, so the initial contents are unused.
                        let mut b: Vec<u8> = Vec::with_capacity(needed);
                        // SAFETY: `b` has capacity `needed`, u8 has no Drop
                        // side-effects, and every byte is written by
                        // `resize_bgra_nn` below before any read.
                        #[allow(clippy::uninit_vec)]
                        unsafe {
                            b.set_len(needed);
                        }
                        overlay::resize_bgra_nn(
                            frame.cpu_data(),
                            frame.width,
                            frame.height,
                            &mut b,
                            encoder_width,
                            encoder_height,
                        );
                        b
                    };
                    // Composite the overlay onto the buffer at encoder
                    // resolution rather than onto the original frame.
                    if let Some(latest) = encoder_overlay.as_ref() {
                        let guard = latest.lock();
                        if let Some(ov) = guard.as_ref() {
                            let ov_bytes_ok = ov.data.len()
                                == (ov.width as usize) * (ov.height as usize) * 4;
                            if ov.width > 0 && ov.height > 0 && ov_bytes_ok {
                                if ov.width == encoder_width && ov.height == encoder_height {
                                    // Same size — plain blend, no cache needed.
                                    overlay::composite(
                                        &mut buf,
                                        &ov.data,
                                        encoder_width,
                                        encoder_height,
                                    );
                                } else {
                                    // Scaled path. Refresh cache only when the
                                    // overlay frame or its source/dst dims have
                                    // changed; otherwise reuse the pre-scaled
                                    // bytes and do a non-scaled blend.
                                    let needed = (encoder_width as usize)
                                        * (encoder_height as usize)
                                        * 4;
                                    let src_dims = (ov.width, ov.height);
                                    let dst_dims = (encoder_width, encoder_height);
                                    let rescale = cached_ov_seq != Some(ov.seq)
                                        || cached_ov_src_dims != src_dims
                                        || cached_ov_dst_dims != dst_dims
                                        || scaled_cache.len() != needed;
                                    if rescale {
                                        scaled_cache.resize(needed, 0);
                                        overlay::resize_bgra_nn(
                                            &ov.data,
                                            ov.width,
                                            ov.height,
                                            &mut scaled_cache,
                                            encoder_width,
                                            encoder_height,
                                        );
                                        cached_ov_seq = Some(ov.seq);
                                        cached_ov_src_dims = src_dims;
                                        cached_ov_dst_dims = dst_dims;
                                    }
                                    // Drop the overlay lock before the blend so
                                    // the receiver thread can push the next
                                    // frame in parallel.
                                    drop(guard);
                                    overlay::composite(
                                        &mut buf,
                                        &scaled_cache,
                                        encoder_width,
                                        encoder_height,
                                    );
                                }
                            }
                        }
                    }
                    // BGRA → NV12 conversion. Parallelized across rows.
                    // This replaces ffmpeg's internal swscale call AND
                    // shrinks the pipe payload 2.67×. Without this the
                    // writer is bandwidth-bound at 4K60 (~2 GB/s BGRA).
                    let nv12_len = convert::nv12_byte_len(encoder_width, encoder_height);
                    let mut nv12: Vec<u8> = Vec::with_capacity(nv12_len);
                    // SAFETY: capacity is `nv12_len`, u8 has no Drop, and
                    // `bgra_to_nv12` writes every byte in `dst` before any
                    // read (it's a pure output buffer).
                    #[allow(clippy::uninit_vec)]
                    unsafe {
                        nv12.set_len(nv12_len);
                    }
                    convert::bgra_to_nv12(&buf, encoder_width, encoder_height, &mut nv12);
                        nv12
                    };
                    composite_nanos += t_c.elapsed().as_nanos() as u64;
                    have_first_frame = true;
                    WriteMsg::Frame(nv12)
                } else if have_first_frame {
                    // No fresh frame this tick — tell writer to dup its
                    // stored last buffer. Avoids round-tripping 33 MB at
                    // 4K through the channel for an identical frame.
                    dups_since_log += 1;
                    WriteMsg::Dup
                } else {
                    // No captured frame yet; wait for the first one.
                    if disconnected {
                        break;
                    }
                    next_tick = Instant::now() + tick;
                    continue;
                };

                // Blocking send. If writer is busy (pipe write in
                // progress), we pay the stall here — which is
                // correct: it enforces the pipeline rate-limit.
                let t_s = Instant::now();
                match writer_tx.send(msg) {
                    Ok(()) => {
                        send_block_nanos += t_s.elapsed().as_nanos() as u64;
                        encoder_counters.encoded.fetch_add(0, Ordering::Relaxed);
                        sends_since_log += 1;
                        if !primed {
                            // First real frame just handed to writer.
                            // Rebase the pacer so any nvenc/ffmpeg
                            // codec init stall inside the writer's first
                            // pipe.write_frame lands BEFORE t=0 in the
                            // pacer's timeline, not inside it.
                            primed = true;
                            next_tick = Instant::now();
                            last_log = Instant::now();
                        }
                    }
                    Err(_) => {
                        // Writer thread exited (channel closed). Stop.
                        break;
                    }
                }

                if last_log.elapsed() >= Duration::from_secs(2) {
                    let n = sends_since_log.max(1);
                    #[cfg(windows)]
                    let capture_mode = if gpu_state.is_some() { "gpu" } else { "cpu" };
                    #[cfg(not(windows))]
                    let capture_mode = "cpu";
                    tracing::info!(
                        fps_actual = sends_since_log as f64 / last_log.elapsed().as_secs_f64(),
                        dups_per_sec = dups_since_log as f64 / last_log.elapsed().as_secs_f64(),
                        target_fps = encoder_fps,
                        capture_mode,
                        avg_composite_ms = (composite_nanos as f64 / n as f64) / 1_000_000.0,
                        avg_send_block_ms = (send_block_nanos as f64 / n as f64) / 1_000_000.0,
                        "encoder pacing"
                    );
                    last_log = Instant::now();
                    sends_since_log = 0;
                    dups_since_log = 0;
                    composite_nanos = 0;
                    send_block_nanos = 0;
                }

                next_tick += tick;
                // If we've fallen >1 tick behind (encoder stall), resync
                // rather than burst-catch-up.
                let now = Instant::now();
                if now > next_tick + tick {
                    next_tick = now + tick;
                }

                if disconnected {
                    break;
                }
            }
            // Drop the sender so the writer thread sees Disconnected
            // and exits its recv loop, flushing ffmpeg via pipe.finish.
            drop(writer_tx);
            Ok(())
        });

        // Frame callback delivered from whatever thread WGC uses.
        let capture_counters = Arc::clone(&counters);
        let frame_tx: SyncSender<Frame> = tx;
        let on_frame: Box<dyn FnMut(Frame) + Send + 'static> =
            Box::new(move |frame: Frame| {
                capture_counters.captured.fetch_add(1, Ordering::Relaxed);
                // The encoder thread resizes to the requested output
                // dimensions, so frames at any capture size are accepted.
                match frame_tx.try_send(frame) {
                    Ok(()) => {}
                    Err(std::sync::mpsc::TrySendError::Full(_)) => {
                        capture_counters.dropped.fetch_add(1, Ordering::Relaxed);
                    }
                    Err(std::sync::mpsc::TrySendError::Disconnected(_)) => {
                        capture_counters.dropped.fetch_add(1, Ordering::Relaxed);
                    }
                }
            });

        #[cfg(windows)]
        let pool_arg = capture_pool;
        #[cfg(not(windows))]
        let pool_arg: Option<Arc<capture::GpuTexturePool>> = None;

        let capture = capture::start_capture_loop(
            prepared,
            fps,
            Arc::clone(&gpu_emit_active),
            pool_arg,
            on_frame,
        )
        .context("start display capture")?;

        Ok(Self {
            output_path,
            encoder_used: chosen,
            fps,
            width,
            height,
            #[cfg(windows)]
            composite_mode,
            started_at: Instant::now(),
            counters,
            capture: Some(capture),
            composite_join: Some(composite_join),
            writer_join: Some(writer_join),
            stop_signal,
        })
    }

    /// Resolved composite path for this session. Used by `get_status`
    /// events so the editor UI / logs can surface which path is live.
    /// On non-Windows builds there is no GPU path, so this always returns
    /// `"cpu"`.
    pub fn composite_mode_label(&self) -> &'static str {
        #[cfg(windows)]
        {
            self.composite_mode.label()
        }
        #[cfg(not(windows))]
        {
            "cpu"
        }
    }

    pub fn snapshot_stats(&self) -> Stats {
        let captured = self.counters.captured.load(Ordering::Relaxed);
        let encoded = self.counters.encoded.load(Ordering::Relaxed);
        let dropped = self.counters.dropped.load(Ordering::Relaxed);
        let bytes = self.counters.bytes.load(Ordering::Relaxed);
        let elapsed = self.started_at.elapsed();
        let elapsed_secs = elapsed.as_secs_f64().max(0.001);
        let pipe_mib_per_sec = (bytes as f64) / 1_048_576.0 / elapsed_secs;
        Stats {
            frames_captured: captured,
            frames_encoded: encoded,
            frames_dropped: dropped,
            bytes_piped: bytes,
            elapsed_ms: elapsed.as_millis() as u64,
            pipe_mib_per_sec,
        }
    }

    pub fn output_path(&self) -> &Path {
        &self.output_path
    }

    pub fn encoder_used(&self) -> Encoder {
        self.encoder_used
    }

    pub fn width(&self) -> u32 {
        self.width
    }
    pub fn height(&self) -> u32 {
        self.height
    }
    pub fn fps(&self) -> u32 {
        self.fps
    }

    pub fn stop(mut self) -> Result<StopResult> {
        // Signal the composite thread to break on its next iteration.
        *self.stop_signal.lock() = true;
        if let Some(handle) = self.capture.take() {
            handle.stop();
        }
        // Dropping the capture closes the sender half held by the frame
        // callback, which ends the composite thread's channel loop. When
        // composite exits, it drops `writer_tx`, which causes the writer
        // thread's recv to return Err and run pipe.finish().

        let stats = self.snapshot_stats();
        let composite_result = self
            .composite_join
            .take()
            .ok_or_else(|| anyhow!("composite thread already joined"))?
            .join();
        match composite_result {
            Ok(Ok(())) => {}
            Ok(Err(err)) => return Err(err),
            Err(_) => return Err(anyhow!("composite thread panicked")),
        }
        // Writer's result carries the pipe.finish() outcome — this is the
        // one we really care about (did ffmpeg flush cleanly?).
        let writer_result = self
            .writer_join
            .take()
            .ok_or_else(|| anyhow!("writer thread already joined"))?
            .join();
        match writer_result {
            Ok(Ok(())) => {}
            Ok(Err(err)) => return Err(err),
            Err(_) => return Err(anyhow!("writer thread panicked")),
        }


        Ok(StopResult {
            ok: true,
            outputPath: self.output_path.to_string_lossy().into_owned(),
            durationMs: stats.elapsed_ms,
            framesCaptured: stats.frames_captured,
            framesEncoded: stats.frames_encoded,
            framesDropped: stats.frames_dropped,
            encoderUsed: self.encoder_used.label().to_string(),
        })
    }
}

fn default_bitrate(width: u32, height: u32, fps: u32) -> u32 {
    // Crude sizing: bits-per-pixel × pixel-rate, clamped.
    let pixel_rate = (width as u64) * (height as u64) * (fps as u64);
    let bits_per_pixel = 0.10_f64;
    let kbps = (pixel_rate as f64 * bits_per_pixel / 1000.0) as u32;
    kbps.clamp(4_000, 60_000)
}

fn build_output_path(user_dir: Option<&Path>, default_dir: &Path) -> Result<PathBuf> {
    let dir = user_dir.unwrap_or(default_dir);
    fs::create_dir_all(dir)
        .with_context(|| format!("create output directory {dir:?}"))?;
    let now = chrono_like_timestamp();
    Ok(dir.join(format!("KeyCap_{now}.mp4")))
}

fn chrono_like_timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    // Avoid pulling a full datetime crate for one timestamp. Format is
    // yyyy-mm-dd_HH-MM-SS in UTC; "close enough" for filenames.
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Days since 1970-01-01 (Thu)
    let days = (seconds / 86_400) as i64;
    let sec_of_day = (seconds % 86_400) as u32;
    let (year, month, day) = ymd_from_days(days);
    let h = sec_of_day / 3600;
    let m = (sec_of_day % 3600) / 60;
    let s = sec_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}_{h:02}-{m:02}-{s:02}")
}

fn ymd_from_days(mut days: i64) -> (i32, u32, u32) {
    // Gregorian calendar math. Days since 1970-01-01.
    days += 719_468;
    let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
    let doe = (days - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    (year as i32, m as u32, d as u32)
}

pub fn default_output_dir() -> PathBuf {
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        PathBuf::from(profile).join("Videos")
    } else if let Some(home) = std::env::var_os("HOME") {
        PathBuf::from(home).join("Videos")
    } else {
        PathBuf::from(".")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_bitrate_scales_with_pixels() {
        let low = default_bitrate(640, 360, 30);
        let mid = default_bitrate(1920, 1080, 60);
        let high = default_bitrate(3840, 2160, 60);
        assert!(low < mid);
        assert!(mid < high);
        // 1080p60 should land around 12 Mbps-ish.
        assert!(mid >= 8_000 && mid <= 20_000, "got {mid}");
    }

    #[test]
    fn ymd_math_sanity() {
        // 2024-01-01 is 19_723 days since 1970-01-01.
        let (y, m, d) = ymd_from_days(19_723);
        assert_eq!((y, m, d), (2024, 1, 1));
        // 1970-01-01 itself.
        let (y, m, d) = ymd_from_days(0);
        assert_eq!((y, m, d), (1970, 1, 1));
    }
}
