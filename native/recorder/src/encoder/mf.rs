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

use std::path::PathBuf;
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
#[derive(Clone)]
pub struct MfParams {
    /// The shared DDA D3D11 device — MF wraps it in an
    /// `IMFDXGIDeviceManager` so the encoder MFT runs on the same GPU
    /// the compositor used to fill the NV12 textures.
    pub device: ID3D11Device,
    pub encoder: Encoder,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate_kbps: u32,
    pub output: PathBuf,
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

        // ── DXGI device manager ────────────────────────────────────────
        // Wraps the shared D3D11 device so the encoder MFT can sample
        // our NV12 textures in VRAM without an extra device boundary.
        let mut reset_token: u32 = 0;
        let mut dev_manager: Option<IMFDXGIDeviceManager> = None;
        unsafe {
            MFCreateDXGIDeviceManager(&mut reset_token, &mut dev_manager)
                .context("MFCreateDXGIDeviceManager")?;
        }
        let dev_manager = dev_manager.ok_or_else(|| anyhow!("null IMFDXGIDeviceManager"))?;
        unsafe {
            dev_manager
                .ResetDevice(&params.device, reset_token)
                .context("IMFDXGIDeviceManager::ResetDevice")?;
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
        })
    }

    fn write_gpu_frame(&mut self, texture: &ID3D11Texture2D) -> Result<()> {
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

        let t = std::time::Instant::now();
        unsafe {
            self.sink_writer
                .WriteSample(self.stream_index, &sample)
                .context("IMFSinkWriter::WriteSample")?;
        }
        let elapsed_ms = t.elapsed().as_secs_f64() * 1000.0;
        if self.frame_count == 0 || self.frame_count == 1 || self.frame_count == 10 {
            tracing::info!(
                frame_count = self.frame_count,
                write_sample_ms = elapsed_ms,
                "MF WriteSample completed"
            );
        }
        self.frame_count = self.frame_count.saturating_add(1);
        Ok(())
    }
}

impl EncoderBackend for MfEncoder {
    fn write_nv12_frame(&mut self, payload: NvFramePayload<'_>) -> Result<()> {
        match payload {
            #[cfg(windows)]
            NvFramePayload::Gpu(tex) => self.write_gpu_frame(tex),
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
        // Belt-and-suspenders: explicitly Flush the stream first. On
        // some MFTs (notably nvenc-via-MF), Finalize alone doesn't
        // force the encoder to drain its lookahead; it waits for an
        // EOS that never arrives if the input queue still has samples.
        // Flush + Finalize forces the drain, then writes the moov atom.
        tracing::info!(frame_count = self.frame_count, "MF backend finish: starting Flush");
        unsafe {
            if let Err(err) = self.sink_writer.Flush(self.stream_index) {
                tracing::warn!(?err, "IMFSinkWriter::Flush failed (continuing)");
            }
        }
        tracing::info!("MF backend finish: starting Finalize");
        unsafe {
            self.sink_writer
                .Finalize()
                .context("IMFSinkWriter::Finalize")?;
        }
        tracing::info!("MF backend finish: Finalize returned cleanly");
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
