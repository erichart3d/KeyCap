//! Media Foundation Sink Writer encoder backend (M3 Bite 2).
//!
//! Zero-copy GPU encode path. The compositor renders directly into one
//! of the `Nv12Ring`'s D3D11 textures; we wrap the texture in an
//! `IMFSample` via `MFCreateDXGISurfaceBuffer` and queue it on the Sink
//! Writer with `WriteSample`. The Sink Writer hands the sample to the
//! platform hardware encoder MFT (NVENC, AMF, or QSV depending on
//! adapter) which consumes the texture in VRAM and produces an H.264
//! bitstream that the Sink Writer muxes straight into MP4.
//!
//! No `Map(READ)` anywhere on this path — composite is fire-and-forget.
//! Under GPU contention from other processes, frames may queue inside
//! MF/the encoder, but the composite thread itself never blocks on
//! readback the way the ffmpeg pipe path does.
//!
//! ## Process-wide MF init
//!
//! `MFStartup`/`MFShutdown` are reference-counted per-process. We call
//! `MFStartup(MF_VERSION, MFSTARTUP_FULL)` lazily on first encoder
//! construction (via `Once`), and intentionally never call
//! `MFShutdown` — the process is the recorder sidecar, MF is along for
//! its lifetime. If we ever want to clean up properly we can pair
//! Startup/Shutdown via reference counting; today the leak is one
//! process-lifetime MF instance, which is the same pattern OBS uses.
//!
//! ## CQP rate control
//!
//! Bite 1.5's ffmpeg pipe uses `-rc constqp -qp 19` for nvenc and
//! equivalents for amf/qsv. We translate to MF via
//! `CODECAPI_AVEncCommonRateControlMode = eAVEncCommonRateControlMode_Quality`
//! (constant quality) and `CODECAPI_AVEncCommonQuality = 70` (≈ QP 19
//! on h.264). Set on the output media type so the Sink Writer forwards
//! to the underlying MFT.

#![cfg(windows)]

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use anyhow::{anyhow, Context as _, Result};
use windows::core::{Interface, HSTRING, PCWSTR};
use windows::Win32::Graphics::Direct3D11::{ID3D11Device, ID3D11Texture2D};
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

use super::{Encoder, EncoderBackend, NvFramePayload};

/// MF version constant. `MF_SDK_VERSION` (0x0002) << 16 | `MF_API_VERSION`
/// (0x0070) = 0x00020070. The SDK headers expose this as `MF_VERSION`
/// but the windows crate doesn't re-export it as a constant; spell it
/// out so we don't hand-construct the bit shift in two places.
const MF_VERSION_VALUE: u32 = (0x0002 << 16) | 0x0070;

/// Result of the one-time `MFStartup` call. Stored in a `OnceLock` so
/// failures replay on every call instead of getting swallowed by a
/// successful first init that ran on a dead `Once`.
static MF_INIT: OnceLock<std::result::Result<(), String>> = OnceLock::new();

/// Initialize MF process-wide. Idempotent and safe to call from any
/// thread. Returns a clone of the original `MFStartup` outcome —
/// `Err(...)` once means `Err(...)` forever.
fn ensure_mf_initialized() -> Result<()> {
    let outcome = MF_INIT.get_or_init(|| unsafe {
        // Sink Writer works in any apartment; MTA matches the recorder's
        // worker-thread model and avoids accidental implicit STAs.
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        match MFStartup(MF_VERSION_VALUE, MFSTARTUP_FULL) {
            Ok(()) => Ok(()),
            Err(e) => Err(format!("MFStartup failed: {e}")),
        }
    });
    match outcome {
        Ok(()) => Ok(()),
        Err(msg) => Err(anyhow!(msg.clone())),
    }
}

/// Construction parameters for [`MfEncoder`].
///
/// Note: deliberately does NOT take the compositor's D3D11 device.
/// `MfEncoder::new` creates its own private device so the encoder
/// MFT's GPU work runs on a separate command queue from the
/// compositor's. Earlier revisions shared the device and fought the
/// compositor for GPU time — see `commit 453c0c3` for the autopsy.
///
/// `shared_handles` are the NT shared handles exported by the
/// compositor's `Nv12Ring` (one per slot). MF imports each via
/// `OpenSharedResource1` to get parallel texture handles on its
/// private device backed by the same underlying GPU surfaces.
pub struct MfParams {
    pub encoder: Encoder,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate_kbps: u32,
    pub output: PathBuf,
    pub shared_handles: Vec<windows::Win32::Foundation::HANDLE>,
    /// Path to the bundled ffmpeg.exe. Used by `finish()` for the
    /// post-encode `h264_metadata` BSF re-mux that injects BT.709
    /// limited-range VUI tags into the H.264 SPS — the encoder MFT
    /// itself doesn't emit these on this NVENC build.
    pub ffmpeg_path: PathBuf,
}

pub struct MfEncoder {
    sink_writer: IMFSinkWriter,
    stream_index: u32,
    fps: u32,
    frame_count: u64,
    encoder_label: &'static str,
    /// Held so MF's encoder MFT keeps a valid manager throughout the
    /// session. Released on Drop.
    _device_manager: IMFDXGIDeviceManager,
    /// MF's private D3D11 device. The encoder MFT runs its GPU work
    /// on this device's command queue so it doesn't contend with the
    /// compositor's queue on the DDA device.
    _mf_device: ID3D11Device,
    /// Per-slot textures opened on the MF device from the shared NT
    /// handles. Indexed by ring slot index. Each one is the "MF side"
    /// of a cross-device shared NV12 texture; the matching
    /// "compositor side" lives in `Nv12Ring`.
    slot_textures: Vec<ID3D11Texture2D>,
    /// Per-slot keyed mutex (consumer side). The MS docs say MFTs MAY
    /// participate in keyed-mutex sync via `IMFDXGIBuffer`, but NVENC's
    /// hardware MFT does not — without us driving the consumer half
    /// ourselves, the texture stays released-with-key=1 forever after
    /// our ReleaseSync(1), the producer's next-rotation
    /// `AcquireSync(0)` blocks until our timeout, and throughput
    /// collapses after one ring rotation. We do the
    /// `AcquireSync(1)` + `ReleaseSync(0)` dance around `WriteSample`
    /// ourselves to hand the slot back to the producer.
    slot_keyed_mutexes: Vec<windows::Win32::Graphics::Dxgi::IDXGIKeyedMutex>,
    /// Where the MP4 we wrote lives. Used by the `finish()` re-mux step
    /// to inject H.264 VUI color tags via ffmpeg's `h264_metadata`
    /// bitstream filter (the encoder MFT doesn't emit these tags
    /// itself).
    output_path: PathBuf,
    /// Path to ffmpeg.exe for the post-encode VUI re-mux.
    ffmpeg_path: PathBuf,
}

// SAFETY: MF Sink Writer is documented to be free-threaded — its
// internal MFT activate path doesn't pin the writer to its origin
// thread. We only call into the encoder from the writer thread (single
// owner) after construction; the COM interfaces inside contain raw
// pointers that aren't auto-Send, but the underlying objects are
// thread-safe for our usage pattern.
unsafe impl Send for MfEncoder {}


impl MfEncoder {
    pub fn new(params: &MfParams) -> Result<Self> {
        ensure_mf_initialized()?;

        if params.width % 2 != 0 || params.height % 2 != 0 {
            return Err(anyhow!(
                "MF encoder dims must be even (got {}x{})",
                params.width,
                params.height
            ));
        }
        if params.shared_handles.is_empty() {
            return Err(anyhow!("MF encoder requires at least one shared slot"));
        }

        // ── Private D3D11 device for MF ────────────────────────────────
        // Separate device from the DDA/compositor device so the
        // encoder MFT's GPU work runs on its own OS-level command
        // queue. This is the architectural fix from Bite 3 — sharing
        // the DDA device caused composite back-pressure that collapsed
        // throughput.
        let mf_device = create_d3d11_device()
            .context("create private D3D11 device for MF")?;
        unsafe {
            // Multi-thread protection: MF spawns internal threads that
            // call into this device. The default D3D11 device is NOT
            // thread-safe (single-thread context). We set the multi-
            // thread protected flag via ID3D10Multithread to make MF's
            // internal access safe.
            let mt: windows::Win32::Graphics::Direct3D11::ID3D11Multithread =
                mf_device.cast().context("QI ID3D11Multithread on MF device")?;
            // Returns the previous protection state — ignored.
            let _ = mt.SetMultithreadProtected(true);
        }

        // ── Import the compositor's NV12 ring slots onto MF's device ──
        // Each shared NT handle was exported by `Nv12Ring`. Opening
        // them on MF's private device gives us parallel
        // `ID3D11Texture2D` handles that point at the same underlying
        // GPU surface as the compositor's. The keyed mutex inside the
        // resource serializes the cross-device handoff.
        let mf_device1: windows::Win32::Graphics::Direct3D11::ID3D11Device1 =
            mf_device.cast().context("QI ID3D11Device1 on MF device")?;
        let mut slot_textures: Vec<ID3D11Texture2D> =
            Vec::with_capacity(params.shared_handles.len());
        let mut slot_keyed_mutexes: Vec<windows::Win32::Graphics::Dxgi::IDXGIKeyedMutex> =
            Vec::with_capacity(params.shared_handles.len());
        for (i, h) in params.shared_handles.iter().enumerate() {
            let tex: ID3D11Texture2D = unsafe {
                mf_device1.OpenSharedResource1(*h).with_context(|| {
                    format!("OpenSharedResource1 for ring slot {i}")
                })?
            };
            let km: windows::Win32::Graphics::Dxgi::IDXGIKeyedMutex =
                tex.cast().with_context(|| {
                    format!("QI IDXGIKeyedMutex on MF-side slot {i}")
                })?;
            slot_textures.push(tex);
            slot_keyed_mutexes.push(km);
        }

        // ── DXGI device manager wrapping MF's private device ──────────
        let mut reset_token: u32 = 0;
        let mut dev_manager: Option<IMFDXGIDeviceManager> = None;
        unsafe {
            MFCreateDXGIDeviceManager(&mut reset_token, &mut dev_manager)
                .context("MFCreateDXGIDeviceManager")?;
        }
        let dev_manager = dev_manager.ok_or_else(|| anyhow!("null IMFDXGIDeviceManager"))?;
        unsafe {
            dev_manager
                .ResetDevice(&mf_device, reset_token)
                .context("IMFDXGIDeviceManager::ResetDevice (MF private device)")?;
        }

        // ── Sink writer attributes ────────────────────────────────────
        let attrs = create_attributes(4)?;
        unsafe {
            attrs
                .SetUnknown(&MF_SINK_WRITER_D3D_MANAGER, &dev_manager)
                .context("set MF_SINK_WRITER_D3D_MANAGER")?;
            // Allow hardware MFTs (the whole point of this backend).
            attrs
                .SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1)
                .context("set MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS")?;
            // We feed live frames; let the writer prefer low-latency MFTs.
            attrs
                .SetUINT32(&MF_LOW_LATENCY, 1)
                .context("set MF_LOW_LATENCY")?;
            // Container = MP4 (matches the ffmpeg path's output).
            attrs
                .SetGUID(&MF_TRANSCODE_CONTAINERTYPE, &MFTranscodeContainerType_MPEG4)
                .context("set MF_TRANSCODE_CONTAINERTYPE")?;
        }
        // NOTE: an earlier revision attempted to set
        // `MF_SINK_WRITER_ENCODER_CONFIG` here with
        // `CODECAPI_AVEncMPVProfile=High`. On this NVENC build it puts
        // the Sink Writer into a state where the recorder process
        // exits silently after the first composite (before any
        // WriteSample completes). Profile control via the Sink Writer
        // attribute path is therefore not viable here. The H.264
        // stream stays at Constrained Baseline; if we ever need High
        // we'll have to drive an `IMFTransform` pipeline directly
        // rather than relying on Sink Writer's auto-config.
        let _unused_encoder_config_helper = build_encoder_config_attrs;

        // ── Sink writer pointed at the output file ─────────────────────
        let output_str = params
            .output
            .to_str()
            .ok_or_else(|| anyhow!("non-UTF8 output path"))?;
        let output_h = HSTRING::from(output_str);
        let sink_writer: IMFSinkWriter = unsafe {
            MFCreateSinkWriterFromURL(PCWSTR(output_h.as_ptr()), None, &attrs)
                .with_context(|| format!("MFCreateSinkWriterFromURL({})", output_str))?
        };

        // ── Output media type: H.264 ───────────────────────────────────
        let bitrate_bps: u32 = params.bitrate_kbps.saturating_mul(1000).max(1_000_000);
        let out_type = create_h264_output_type(params, bitrate_bps)?;
        let stream_index = unsafe {
            sink_writer
                .AddStream(&out_type)
                .context("IMFSinkWriter::AddStream")?
        };

        // ── Input media type: NV12 ────────────────────────────────────
        let in_type = create_nv12_input_type(params)?;
        unsafe {
            sink_writer
                .SetInputMediaType(stream_index, &in_type, None)
                .context("IMFSinkWriter::SetInputMediaType (NV12)")?;
        }

        // ── Begin writing ─────────────────────────────────────────────
        unsafe {
            sink_writer
                .BeginWriting()
                .context("IMFSinkWriter::BeginWriting")?;
        }


        Ok(Self {
            sink_writer,
            stream_index,
            fps: params.fps.max(1),
            frame_count: 0,
            encoder_label: params.encoder.label(),
            _device_manager: dev_manager,
            _mf_device: mf_device,
            slot_textures,
            slot_keyed_mutexes,
            output_path: params.output.clone(),
            ffmpeg_path: params.ffmpeg_path.clone(),
        })
    }

    fn write_gpu_slot(&mut self, slot_index: usize) -> Result<()> {
        // Look up the MF-side texture and its keyed mutex for this
        // slot. The compositor wrote into the matching compositor-side
        // texture and ReleaseSync(1)'d. We do the consumer half of the
        // keyed-mutex handoff ourselves rather than relying on the
        // encoder MFT — NVENC's MFT doesn't drive keyed mutexes, so
        // without us doing it the slot stays held with key=1 forever
        // and the producer's next-rotation AcquireSync(0) blocks until
        // its 5 s timeout.
        let texture = self
            .slot_textures
            .get(slot_index)
            .ok_or_else(|| anyhow!("slot index {} out of range", slot_index))?;
        let keyed_mutex = self
            .slot_keyed_mutexes
            .get(slot_index)
            .ok_or_else(|| anyhow!("slot index {} mutex out of range", slot_index))?;

        // Consumer-side acquire. The compositor's ReleaseSync(1) makes
        // this immediate. After WriteSample queues the sample for the
        // encoder, ReleaseSync(0) hands the slot back to the producer
        // — note this is BEFORE the encoder has actually consumed the
        // texture. That's safe: MF holds an `IMFSample` reference on
        // the texture until the encoder is done with it, which is
        // independent of the keyed mutex state. The keyed mutex only
        // serializes "who's allowed to ASK to access this texture" at
        // the COM API level; the underlying GPU work coordination is
        // handled by D3D11's resource state tracking on each device.
        unsafe {
            keyed_mutex
                .AcquireSync(1, 5_000)
                .context("MF-side AcquireSync(1) before WriteSample")?;
        }

        // Wrap the D3D11 texture in an MF media buffer. MF AddRef's the
        // ID3D11Texture2D, so the buffer/sample carry their own
        // reference for the encoder's lifetime; the compositor can
        // recycle the ring slot on next acquire as soon as we return,
        // because at minimum MF holds onto the texture until the MFT
        // has consumed it.
        let buffer: IMFMediaBuffer = unsafe {
            MFCreateDXGISurfaceBuffer(&ID3D11Texture2D::IID, texture, 0, false)
                .context("MFCreateDXGISurfaceBuffer")?
        };

        // MFCreateDXGISurfaceBuffer doesn't pre-set the buffer length.
        // Pull the contiguous length via IMF2DBuffer and stamp it.
        let buffer2d: IMF2DBuffer = buffer.cast().context("QI IMF2DBuffer")?;
        let contig_len: u32 = unsafe {
            buffer2d
                .GetContiguousLength()
                .context("IMF2DBuffer::GetContiguousLength")?
        };
        unsafe {
            buffer
                .SetCurrentLength(contig_len)
                .context("IMFMediaBuffer::SetCurrentLength")?;
        }

        let sample: IMFSample = unsafe { MFCreateSample().context("MFCreateSample")? };
        unsafe {
            sample.AddBuffer(&buffer).context("IMFSample::AddBuffer")?;
        }

        // PTS / duration in 100-ns units.
        let one_frame_100ns: i64 = 10_000_000_i64 / self.fps as i64;
        let pts_100ns: i64 = (self.frame_count as i64) * one_frame_100ns;
        unsafe {
            sample
                .SetSampleTime(pts_100ns)
                .context("IMFSample::SetSampleTime")?;
            sample
                .SetSampleDuration(one_frame_100ns)
                .context("IMFSample::SetSampleDuration")?;
        }

        let write_result = unsafe {
            self.sink_writer
                .WriteSample(self.stream_index, &sample)
                .context("IMFSinkWriter::WriteSample")
        };
        // ALWAYS release back to key=0 so the producer's next rotation
        // can acquire — even on WriteSample error. Otherwise a
        // transient failure deadlocks the producer for the full
        // AcquireSync timeout.
        let release = unsafe { keyed_mutex.ReleaseSync(0) }
            .context("MF-side ReleaseSync(0) after WriteSample");
        // Surface the WriteSample error first if both failed; a
        // release error after an already-failed write is downstream noise.
        match (write_result, release) {
            (Err(w), _) => return Err(w),
            (Ok(()), Err(r)) => return Err(r),
            (Ok(()), Ok(())) => {}
        }
        self.frame_count = self.frame_count.saturating_add(1);
        Ok(())
    }
}

impl EncoderBackend for MfEncoder {
    fn write_nv12_frame(&mut self, payload: NvFramePayload<'_>) -> Result<()> {
        match payload {
            // MF ignores fence_value — its own keyed-mutex protocol
            // synchronizes its private device with the compositor.
            NvFramePayload::GpuSlot { idx, fence_value: _ } => self.write_gpu_slot(idx),
            NvFramePayload::Cpu(_) => Err(anyhow!(
                "MF backend can't consume CPU NV12 frames; \
                 the session's encoder selection is wrong"
            )),
        }
    }

    fn label(&self) -> &'static str {
        self.encoder_label
    }

    fn finish(self: Box<Self>, _timeout: Duration) -> Result<()> {
        // Don't Flush before Finalize — Flush drops queued samples,
        // which means the encoder MFT loses any lookahead/B-frames it
        // hasn't emitted yet, AND the moov atom that depends on them
        // never gets written.
        tracing::info!(
            frame_count = self.frame_count,
            "MF backend finish: starting Finalize"
        );
        let t = std::time::Instant::now();
        unsafe {
            self.sink_writer
                .Finalize()
                .context("IMFSinkWriter::Finalize")?;
        }
        let elapsed_ms = t.elapsed().as_secs_f64() * 1000.0;
        tracing::info!(elapsed_ms, "MF backend finish: Finalize returned cleanly");

        // Post-encode: inject BT.709 limited-range VUI tags into the
        // SPS by re-muxing through `ffmpeg -c copy -bsf:v h264_metadata`.
        // The encoder MFT doesn't emit color VUI tags itself (Codex
        // confirmed `CODECAPI_AVEncVideoOutputColor*` aren't supported
        // controls on this MFT), and there's no other reliable way to
        // get the right tags through Sink Writer. Stream copy + a few
        // bytes of SPS rewrite is fast (< 1 s on typical clips).
        //
        // We tolerate a re-mux failure — better to have an un-tagged
        // playable file than to lose the recording.
        if let Err(err) = remux_h264_vui_tags(&self.ffmpeg_path, &self.output_path) {
            tracing::warn!(
                ?err,
                output = ?self.output_path,
                "VUI re-mux failed; the MP4 plays but neutral grays will be tinted"
            );
        }
        let _unused_helper2 = build_encoder_config_attrs;
        Ok(())
    }
}

// ─── helpers ───────────────────────────────────────────────────────────

fn create_attributes(initial_size: u32) -> Result<IMFAttributes> {
    let mut attrs: Option<IMFAttributes> = None;
    unsafe {
        MFCreateAttributes(&mut attrs, initial_size).context("MFCreateAttributes")?;
    }
    attrs.ok_or_else(|| anyhow!("null IMFAttributes"))
}

fn create_media_type() -> Result<IMFMediaType> {
    unsafe { MFCreateMediaType().context("MFCreateMediaType") }
}

fn pack_size(width: u32, height: u32) -> u64 {
    ((width as u64) << 32) | (height as u64)
}

fn pack_ratio(numerator: u32, denominator: u32) -> u64 {
    ((numerator as u64) << 32) | (denominator as u64)
}

fn create_h264_output_type(params: &MfParams, bitrate_bps: u32) -> Result<IMFMediaType> {
    let t = create_media_type()?;
    unsafe {
        t.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
            .context("set MF_MT_MAJOR_TYPE (out)")?;
        t.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264)
            .context("set MF_MT_SUBTYPE (out, H264)")?;
        t.SetUINT32(&MF_MT_AVG_BITRATE, bitrate_bps)
            .context("set MF_MT_AVG_BITRATE")?;
        t.SetUINT32(
            &MF_MT_INTERLACE_MODE,
            MFVideoInterlace_Progressive.0 as u32,
        )
        .context("set MF_MT_INTERLACE_MODE (out)")?;
        t.SetUINT64(&MF_MT_FRAME_SIZE, pack_size(params.width, params.height))
            .context("set MF_MT_FRAME_SIZE (out)")?;
        t.SetUINT64(&MF_MT_FRAME_RATE, pack_ratio(params.fps, 1))
            .context("set MF_MT_FRAME_RATE (out)")?;
        t.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack_ratio(1, 1))
            .context("set MF_MT_PIXEL_ASPECT_RATIO (out)")?;
        // High profile = better quality at the same bitrate. nvenc/amf/qsv
        // all support it on every plausible target hardware.
        t.SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High.0 as u32)
            .context("set MPEG2_PROFILE (out)")?;
        // BT.709 limited range — matches our compositor output and
        // the ffmpeg path's `-colorspace bt709 -color_range tv`.
        set_color_metadata(&t).context("set color metadata (out)")?;
        // Constant-quality rate control, ≈ QP 19 on h.264.
        t.SetUINT32(
            &CODECAPI_AVEncCommonRateControlMode,
            eAVEncCommonRateControlMode_Quality.0 as u32,
        )
        .context("set rate control = Quality")?;
        t.SetUINT32(&CODECAPI_AVEncCommonQuality, 70)
            .context("set CODECAPI_AVEncCommonQuality")?;
    }
    Ok(t)
}

fn create_nv12_input_type(params: &MfParams) -> Result<IMFMediaType> {
    let t = create_media_type()?;
    unsafe {
        t.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
            .context("set MF_MT_MAJOR_TYPE (in)")?;
        t.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)
            .context("set MF_MT_SUBTYPE (in, NV12)")?;
        t.SetUINT32(
            &MF_MT_INTERLACE_MODE,
            MFVideoInterlace_Progressive.0 as u32,
        )
        .context("set MF_MT_INTERLACE_MODE (in)")?;
        t.SetUINT64(&MF_MT_FRAME_SIZE, pack_size(params.width, params.height))
            .context("set MF_MT_FRAME_SIZE (in)")?;
        t.SetUINT64(&MF_MT_FRAME_RATE, pack_ratio(params.fps, 1))
            .context("set MF_MT_FRAME_RATE (in)")?;
        t.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack_ratio(1, 1))
            .context("set MF_MT_PIXEL_ASPECT_RATIO (in)")?;
        set_color_metadata(&t).context("set color metadata (in)")?;
    }
    Ok(t)
}

fn set_color_metadata(t: &IMFMediaType) -> Result<()> {
    unsafe {
        t.SetUINT32(&MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709.0 as u32)?;
        t.SetUINT32(&MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709.0 as u32)?;
        t.SetUINT32(
            &MF_MT_YUV_MATRIX,
            MFVideoTransferMatrix_BT709.0 as u32,
        )?;
        t.SetUINT32(
            &MF_MT_VIDEO_NOMINAL_RANGE,
            MFNominalRange_16_235.0 as u32,
        )?;
    }
    Ok(())
}

// Note: a separate probe function isn't needed. `MfEncoder::new` is
// the probe — at session start we attempt to construct it; if it
// errors (no MF, no encoder MFT for this format, driver missing) the
// session falls through to the ffmpeg pipe path. This matches the way
// the rest of the encoder layer treats "construction failure" as the
// signal to fall back.

/// Inject BT.709 limited-range VUI tags into an existing H.264 MP4
/// without re-encoding, by running:
///
/// ```text
/// ffmpeg -y -i <output> -c copy
///        -bsf:v h264_metadata=video_full_range_flag=0:colour_primaries=1:
///                              transfer_characteristics=1:matrix_coefficients=1
///        <output>.tagged.mp4
/// ```
///
/// then atomically replacing `<output>` with the tagged file. The
/// `h264_metadata` BSF rewrites the SPS in place; combined with `-c copy`
/// this is essentially a stream copy + a few bytes of header rewrite,
/// fast enough to run as a finish-time post-step (< 1 s on a 4K30 clip
/// of typical length).
///
/// Why we do this in post and not in the encoder: NVENC's hardware MFT
/// in Sink Writer doesn't emit color VUI (this is what was causing the
/// magenta cast on dark grays in real recordings). MS docs confirm
/// `CODECAPI_AVEncVideoOutputColor*` aren't part of the H.264 encoder's
/// supported property set. Post-encode patching is the documented path.
fn remux_h264_vui_tags(ffmpeg_path: &Path, output_path: &Path) -> Result<()> {
    use std::process::{Command, Stdio};

    if !output_path.exists() {
        return Err(anyhow!(
            "MP4 to re-mux doesn't exist: {}",
            output_path.display()
        ));
    }

    // Tagged copy goes next to the original.
    let tagged_path = output_path.with_extension("tagged.mp4");

    let bsf = "h264_metadata=video_full_range_flag=0:\
               colour_primaries=1:\
               transfer_characteristics=1:\
               matrix_coefficients=1";
    tracing::info!(
        input = ?output_path,
        tagged = ?tagged_path,
        "MF backend finish: starting h264_metadata re-mux"
    );

    let mut cmd = Command::new(ffmpeg_path);
    cmd.args([
        "-y",
        "-hide_banner",
        "-loglevel", "error",
        "-i",
    ])
    .arg(output_path)
    .args(["-c", "copy", "-bsf:v", bsf])
    .arg(&tagged_path);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let t = std::time::Instant::now();
    let output = cmd.output().with_context(|| {
        format!("spawn ffmpeg at {} for VUI re-mux", ffmpeg_path.display())
    })?;
    let elapsed_ms = t.elapsed().as_secs_f64() * 1000.0;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let _ = std::fs::remove_file(&tagged_path);
        return Err(anyhow!(
            "ffmpeg h264_metadata re-mux exited with {}: {}",
            output
                .status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "signal".to_string()),
            stderr.trim()
        ));
    }

    // Atomic replace. On Windows, `rename` over an existing file fails
    // unless we use `MoveFileEx(..., MOVEFILE_REPLACE_EXISTING)`. Easiest
    // path: `std::fs::rename` since Rust 1.5+ uses `MoveFileEx` internally
    // when needed.
    std::fs::rename(&tagged_path, output_path)
        .with_context(|| {
            format!(
                "replace {} with re-muxed {}",
                output_path.display(),
                tagged_path.display()
            )
        })?;
    tracing::info!(elapsed_ms, "MF backend finish: VUI re-mux done");
    Ok(())
}

/// Build an `IMFAttributes` containing the encoder properties we want
/// the Sink Writer to push into the encoder MFT *before* it negotiates
/// output type. The whole reason for this attribute store is that some
/// encoder properties (notably `CODECAPI_AVEncMPVProfile`) only latch
/// before `IMFTransform::SetOutputType`, and the documented way to
/// reach them on the Sink Writer path is the
/// `MF_SINK_WRITER_ENCODER_CONFIG` attribute on the writer-creation
/// attributes — not post-creation `ICodecAPI::SetValue`, which the
/// hardware H.264 encoder MFT rejects with `E_INVALIDARG`.
///
/// We only set what's documented as supported on the H.264 encoder
/// (`AVEncMPVProfile`). Color VUI tags are NOT documented as encoder
/// controls; we patch those post-encode via the `h264_metadata`
/// bitstream filter in `finish()` instead.
fn build_encoder_config_attrs() -> Result<IMFAttributes> {
    use windows::Win32::Media::MediaFoundation::{
        eAVEncH264VProfile_High, CODECAPI_AVEncMPVProfile,
    };

    let attrs = create_attributes(2)?;
    unsafe {
        attrs
            .SetUINT32(&CODECAPI_AVEncMPVProfile, eAVEncH264VProfile_High.0 as u32)
            .context("set CODECAPI_AVEncMPVProfile=High on encoder config")?;
    }
    Ok(attrs)
}

/// Create a fresh D3D11 device for MF's exclusive use. Hardware adapter,
/// feature level 11.0, BGRA support enabled. The device is intentionally
/// NOT shared with the compositor or DDA — the whole point of Bite 3 is
/// to give MF its own GPU command queue.
fn create_d3d11_device() -> Result<ID3D11Device> {
    use windows::Win32::Foundation::HMODULE;
    use windows::Win32::Graphics::Direct3D::{
        D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_11_0,
    };
    use windows::Win32::Graphics::Direct3D11::{
        D3D11CreateDevice, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_SDK_VERSION,
    };

    let mut device: Option<ID3D11Device> = None;
    let mut feature_level = D3D_FEATURE_LEVEL_11_0;
    let levels = [D3D_FEATURE_LEVEL_11_0];
    unsafe {
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            Some(&levels),
            D3D11_SDK_VERSION,
            Some(&mut device),
            Some(&mut feature_level),
            None,
        )
        .context("D3D11CreateDevice for MF private device")?;
    }
    device.ok_or_else(|| anyhow!("null D3D11 device for MF"))
}
