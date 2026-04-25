//! Direct NVENC SDK encoder backend.
//!
//! Bypasses Media Foundation entirely. We load `nvEncodeAPI64.dll`
//! (ships with every NVIDIA driver), get the function table via
//! `NvEncodeAPICreateInstance`, open a session bound to the
//! compositor's D3D11 device, register the same NV12 textures the
//! `Nv12Ring` produces, and feed them through `nvEncEncodePicture`
//! frame-by-frame. The encoder spits raw H.264 bytes back to us via
//! `nvEncLockBitstream`; we pipe them straight into a thin ffmpeg
//! `-f h264 -i - -c copy` invocation that wraps them in MP4.
//!
//! This is the OBS architecture. The reasons it beats the MF Sink
//! Writer path:
//!
//! - We control the H.264 SPS/VUI directly via
//!   `NV_ENC_CONFIG_H264_VUI_PARAMETERS` — BT.709 limited-range tags
//!   land in the bitstream the encoder produces, no post-encode
//!   re-mux required.
//! - We control the profile via `NV_ENC_INITIALIZE_PARAMS::profileGUID`
//!   — we ask for High and we get High, no
//!   `MF_SINK_WRITER_ENCODER_CONFIG` ceremony.
//! - The encoder and the muxer are decoupled: NVENC produces bytes
//!   asynchronously, ffmpeg consumes them through a pipe, and stop /
//!   Finalize is just "send EOS frame, drain remaining locks, close
//!   the pipe" — no Sink-Writer + MFT keyed-mutex dance to deadlock on.
//! - We never use a keyed mutex on the input textures from this side
//!   at all. NVENC's `nvEncRegisterResource` holds an internal
//!   reference to the texture content during the encode; the
//!   compositor's wraparound waits via `IDXGIKeyedMutex::AcquireSync(0)`
//!   until NVENC has consumed the slot's previous use, which it
//!   signals by `nvEncUnmapInputResource` releasing the slot back to
//!   producer-ready (key=0).
//!
//! Bindings are generated from the vendored `nvEncodeAPI.h` by
//! `build.rs` running `bindgen`. See `nvenc_sys.rs`.

#![cfg(windows)]
#![allow(clippy::too_many_arguments)]

use std::ffi::c_void;
use std::io::Write;
use std::os::windows::ffi::OsStrExt;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicPtr, Ordering};
use std::time::Duration;

use anyhow::{anyhow, Context as _, Result};
use windows::Win32::Foundation::HANDLE;
use windows::Win32::Graphics::Direct3D11::{ID3D11Device, ID3D11Fence, ID3D11Texture2D};
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject, INFINITE};
use windows::core::Interface;

use super::{Encoder, EncoderBackend, NvFramePayload};
use crate::encoder::nvenc_sys as sys;

// ─── Version magic (function-like macros bindgen can't translate) ─────

/// `NVENCAPI_STRUCT_VERSION(ver)` — the version magic baked into every
/// NVENC struct's `version` field. The C macro is
/// `(uint32_t)NVENCAPI_VERSION | ((ver) << 16) | (0x7 << 28)`.
const fn struct_ver(ver: u32) -> u32 {
    sys::NVENCAPI_VERSION | (ver << 16) | (0x7 << 28)
}

/// `NV_ENC_INITIALIZE_PARAMS_VER` etc. some struct versions OR in a
/// high bit (`1u << 31`) to distinguish "client version" from
/// "internal version" — that's what the SDK headers do for the public
/// init/config/pic/lock/preset structs.
const fn struct_ver_with_high_bit(ver: u32) -> u32 {
    struct_ver(ver) | (1u32 << 31)
}

const NV_ENCODE_API_FUNCTION_LIST_VER: u32 = struct_ver(2);
const NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER: u32 = struct_ver(1);
const NV_ENC_INITIALIZE_PARAMS_VER: u32 = struct_ver_with_high_bit(7);
const NV_ENC_CONFIG_VER: u32 = struct_ver_with_high_bit(9);
const NV_ENC_PRESET_CONFIG_VER: u32 = struct_ver_with_high_bit(5);
const NV_ENC_PIC_PARAMS_VER: u32 = struct_ver_with_high_bit(7);
const NV_ENC_LOCK_BITSTREAM_VER: u32 = struct_ver_with_high_bit(2);
const NV_ENC_CREATE_BITSTREAM_BUFFER_VER: u32 = struct_ver(1);
const NV_ENC_REGISTER_RESOURCE_VER: u32 = struct_ver(5);
const NV_ENC_MAP_INPUT_RESOURCE_VER: u32 = struct_ver(4);

const NV_ENC_SUCCESS: i32 = sys::_NVENCSTATUS::NV_ENC_SUCCESS as i32;
const NV_ENC_ERR_NEED_MORE_INPUT: i32 = sys::_NVENCSTATUS::NV_ENC_ERR_NEED_MORE_INPUT as i32;

// ─── DLL loading ──────────────────────────────────────────────────────

type NvEncodeAPICreateInstanceFn =
    unsafe extern "system" fn(*mut sys::NV_ENCODE_API_FUNCTION_LIST) -> sys::NVENCSTATUS;

type NvEncodeAPIGetMaxSupportedVersionFn =
    unsafe extern "system" fn(*mut u32) -> sys::NVENCSTATUS;

static NVENC_CREATE_INSTANCE: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());
static NVENC_LOAD_FAILED: AtomicBool = AtomicBool::new(false);

fn load_nvenc_create_instance() -> Result<NvEncodeAPICreateInstanceFn> {
    use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};

    let cached = NVENC_CREATE_INSTANCE.load(Ordering::Acquire);
    if !cached.is_null() {
        let f: NvEncodeAPICreateInstanceFn = unsafe { std::mem::transmute(cached) };
        return Ok(f);
    }
    if NVENC_LOAD_FAILED.load(Ordering::Acquire) {
        return Err(anyhow!("NVENC DLL load previously failed"));
    }

    let name: Vec<u16> = OsStr::new("nvEncodeAPI64.dll")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let module = unsafe { LoadLibraryW(windows::core::PCWSTR(name.as_ptr())) }
        .context("LoadLibraryW(nvEncodeAPI64.dll) — no NVIDIA driver?")?;
    if module.is_invalid() {
        NVENC_LOAD_FAILED.store(true, Ordering::Release);
        return Err(anyhow!("LoadLibraryW returned an invalid handle"));
    }

    // Diagnostic: log driver's max NVENC API version. Returned as
    // `(major << 4) | minor` per the SDK doc. Compare against our
    // `NVENCAPI_VERSION` for context when version-mismatch errors
    // bite.
    let max_ver_proc = unsafe {
        GetProcAddress(
            module,
            windows::core::PCSTR(c"NvEncodeAPIGetMaxSupportedVersion".as_ptr() as *const u8),
        )
    };
    if let Some(p) = max_ver_proc {
        let max_ver_fn: NvEncodeAPIGetMaxSupportedVersionFn = unsafe { std::mem::transmute(p) };
        let mut driver_ver: u32 = 0;
        let st = unsafe { max_ver_fn(&mut driver_ver) };
        if st == NV_ENC_SUCCESS {
            let major = driver_ver >> 4;
            let minor = driver_ver & 0xF;
            tracing::info!(
                target = format!("{}.{}", sys::NVENCAPI_MAJOR_VERSION, sys::NVENCAPI_MINOR_VERSION),
                driver = format!("{}.{}", major, minor),
                "NVENC SDK version probe"
            );
        }
    }

    let proc = unsafe {
        GetProcAddress(
            module,
            windows::core::PCSTR(c"NvEncodeAPICreateInstance".as_ptr() as *const u8),
        )
    };
    let proc = proc.ok_or_else(|| {
        NVENC_LOAD_FAILED.store(true, Ordering::Release);
        anyhow!("GetProcAddress(NvEncodeAPICreateInstance) returned null")
    })?;

    let raw = proc as *mut c_void;
    NVENC_CREATE_INSTANCE.store(raw, Ordering::Release);
    let f: NvEncodeAPICreateInstanceFn = unsafe { std::mem::transmute(raw) };
    Ok(f)
}

fn create_function_list() -> Result<sys::NV_ENCODE_API_FUNCTION_LIST> {
    let create_fn = load_nvenc_create_instance()?;
    let mut list: sys::NV_ENCODE_API_FUNCTION_LIST = unsafe { std::mem::zeroed() };
    list.version = NV_ENCODE_API_FUNCTION_LIST_VER;
    let st = unsafe { create_fn(&mut list) };
    if st != NV_ENC_SUCCESS {
        return Err(anyhow!(
            "NvEncodeAPICreateInstance failed: NVENC status 0x{:x}",
            st
        ));
    }
    Ok(list)
}

// ─── ffmpeg muxer pipe ────────────────────────────────────────────────

/// Thin ffmpeg wrapper for "wrap this raw H.264 elementary stream in
/// MP4". Uses `-c copy` so there's no re-encode — ffmpeg just adds
/// container framing.
struct MuxerPipe {
    child: Child,
    stdin: Option<ChildStdin>,
    stderr_join: Option<std::thread::JoinHandle<()>>,
    stderr_tail: std::sync::Arc<parking_lot::Mutex<String>>,
}

impl MuxerPipe {
    fn spawn(ffmpeg_path: &Path, output: &Path, fps: u32) -> Result<Self> {
        let fps_str = fps.to_string();
        let mut cmd = Command::new(ffmpeg_path);
        // Color metadata path (after dropping the h264_metadata BSF
        // — it was rewriting the SPS in a way that clobbered the
        // High profile down to Constrained Baseline AND dropped our
        // BT.709 VUI tags, leaving the file labeled `yuv420p
        // (progressive)` with no color hints, which is what was
        // causing the magenta tint and the chunky compression):
        //
        // 1. **NVENC writes BT.709 VUI directly into the SPS** via
        //    `NV_ENC_CONFIG_H264_VUI_PARAMETERS` at session init.
        //    With the BSF gone, this is the canonical color tag.
        // 2. **Input-side `-color_*`**: tells ffmpeg the incoming raw
        //    H.264 ES is BT.709 limited-range so it doesn't have to
        //    guess from a VUI it might fail to parse.
        // 3. **Output-side `-color_*` + `+write_colr`**: writes the
        //    matching MP4 `colr` atom in the container, which is what
        //    most desktop players actually read.
        cmd.args([
            "-hide_banner",
            "-loglevel", "error",
            "-y",
            "-f", "h264",
            "-framerate", &fps_str,
            "-color_primaries", "bt709",
            "-color_trc", "bt709",
            "-colorspace", "bt709",
            "-color_range", "tv",
            "-i", "-",
            "-c", "copy",
            // h264_metadata BSF removed — multiple attempts to use
            // it correlated with mid-stream wedges on the CUDA
            // path. We rely on ffmpeg's `-color_*` flags +
            // `+write_colr` movflag to put BT.709 in the MP4 `colr`
            // atom, which is what most modern players read. The
            // SPS itself will be missing VUI (NVENC silently drops
            // our config) — players that fall back to the SPS
            // first may still show magenta, but the container atom
            // is the canonical place.
            "-color_primaries", "bt709",
            "-color_trc", "bt709",
            "-colorspace", "bt709",
            "-color_range", "tv",
            // Fragmented MP4 — interrupted writes still play.
            "-movflags", "+frag_keyframe+empty_moov+default_base_moof+write_colr",
        ]);
        cmd.arg(output);
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd
            .spawn()
            .with_context(|| format!("spawn ffmpeg muxer at {}", ffmpeg_path.display()))?;
        let stdin = child.stdin.take();
        let stderr = child.stderr.take();
        let tail = std::sync::Arc::new(parking_lot::Mutex::new(String::new()));
        let stderr_join = stderr.map(|mut s| {
            let tail = std::sync::Arc::clone(&tail);
            std::thread::spawn(move || {
                use std::io::Read;
                let mut buf = [0u8; 2048];
                loop {
                    match s.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            let chunk = String::from_utf8_lossy(&buf[..n]);
                            let mut g = tail.lock();
                            g.push_str(&chunk);
                            if g.len() > 4096 {
                                let start = g.len() - 4096;
                                *g = g[start..].to_string();
                            }
                        }
                    }
                }
            })
        });
        Ok(Self {
            child,
            stdin,
            stderr_join,
            stderr_tail: tail,
        })
    }

    fn write(&mut self, bytes: &[u8]) -> Result<()> {
        let s = self
            .stdin
            .as_mut()
            .ok_or_else(|| anyhow!("muxer stdin closed"))?;
        s.write_all(bytes).context("write h264 to muxer stdin")
    }

    fn finish(mut self, hard_timeout: Duration) -> Result<()> {
        drop(self.stdin.take());
        let deadline = std::time::Instant::now() + hard_timeout;
        loop {
            match self.child.try_wait() {
                Ok(Some(status)) => {
                    if let Some(j) = self.stderr_join.take() {
                        let _ = j.join();
                    }
                    if status.success() {
                        return Ok(());
                    }
                    let tail = self.stderr_tail.lock().clone();
                    return Err(anyhow!(
                        "ffmpeg muxer exited with {}: {}",
                        status
                            .code()
                            .map(|c| c.to_string())
                            .unwrap_or_else(|| "signal".to_string()),
                        tail.trim()
                    ));
                }
                Ok(None) => {
                    if std::time::Instant::now() >= deadline {
                        let _ = self.child.kill();
                        let _ = self.child.wait();
                        return Err(anyhow!(
                            "ffmpeg muxer didn't exit within {:?}",
                            hard_timeout
                        ));
                    }
                    std::thread::sleep(Duration::from_millis(25));
                }
                Err(e) => return Err(anyhow!("muxer wait failed: {e}")),
            }
        }
    }
}

impl Drop for MuxerPipe {
    fn drop(&mut self) {
        if let Ok(Some(_)) = self.child.try_wait() {
            return;
        }
        drop(self.stdin.take());
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

// ─── NvencEncoder ─────────────────────────────────────────────────────

// `NvencParams` is consumed once at session start and not cloned —
// it owns a `CudaSession` which holds a non-cloneable CUDA context.
pub struct NvencParams {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub output: PathBuf,
    pub ffmpeg_path: PathBuf,
    /// One per ring slot. The direct NVENC path shares a D3D11 device
    /// with the compositor, so it registers these textures directly.
    pub slot_textures: Vec<ID3D11Texture2D>,
    /// Shared D3D11 device used to open the NVENC session. NVENC's
    /// session is bound to this device so it can address the shared
    /// textures directly.
    pub device: ID3D11Device,
    /// Fence the compositor signals after each `Flush` of a ring
    /// slot. The encoder waits for the matching value before issuing
    /// `nvEncEncodePicture` so the encoder engine doesn't read the
    /// texture before the 3D engine has finished writing it.
    pub fence: ID3D11Fence,
    /// CUDA session bound to the same physical GPU as the compositor
    /// device. The encoder transfers ownership of this in `new` and
    /// uses it to register the D3D11 slot textures as CUDA graphics
    /// resources for per-frame interop. Phase 2 only exercises the
    /// register / map / unmap dance as a no-op verification; Phase 3
    /// will switch the encoder session itself to
    /// `NV_ENC_DEVICE_TYPE_CUDA` and feed `CUarray` pointers as
    /// encode inputs.
    pub cuda: super::cuda_sys::CudaSession,
}

pub struct NvencEncoder {
    fl: sys::NV_ENCODE_API_FUNCTION_LIST,
    encoder: *mut c_void,
    /// Slot textures kept alive only so they outlive the CUDA
    /// graphics resources we registered against them. We don't
    /// register them with NVENC anymore — the encoder consumes
    /// `CUarray` inputs through the CUDA path instead.
    _slot_textures: Vec<ID3D11Texture2D>,
    /// One output bitstream buffer per ring slot, indexed parallel to
    /// `registered`. Sharing a single bitstream across encodes
    /// internally serialized NVENC's pipeline on this driver and
    /// caused the second-frame `nvEncMapInputResource` to hang. With
    /// one buffer per input slot, frame N's encode + lock writes its
    /// own dedicated output buffer and frame N+1 can start mapping
    /// immediately, matching OBS's pattern.
    bitstreams: Vec<*mut c_void>,
    _fps: u32,
    frame_count: u64,
    muxer: Option<MuxerPipe>,
    width: u32,
    height: u32,
    /// Fence + Win32 event the writer thread blocks on before each
    /// encode, ensuring the compositor's render of this slot has
    /// completed on the GPU before NVENC reads it.
    fence: ID3D11Fence,
    fence_event: HANDLE,
    /// CUDA Driver API + context bound to the same physical GPU as
    /// the compositor. Phase 2 uses this only to register slot
    /// textures and exercise map/unmap as a verification layer;
    /// Phase 3 will switch the encoder session itself to consume
    /// CUarray inputs through this context.
    cuda: super::cuda_sys::CudaSession,
    /// Per-slot CUDA graphics resources, parallel to `registered` and
    /// `bitstreams`. Created once via
    /// `cuGraphicsD3D11RegisterResource`; mapped/unmapped per encode
    /// to obtain a `CUarray` for the slot's NV12 texture.
    cuda_resources: Vec<super::cuda_sys::CUgraphicsResource>,
}

// SAFETY: NVENC sessions are single-threaded on the API side but the
// session handle itself is a heap-allocated object owned by us. We
// move the encoder into the writer thread at session start and only
// touch it from there.
unsafe impl Send for NvencEncoder {}

impl NvencEncoder {
    pub fn new(params: NvencParams) -> Result<Self> {
        if params.slot_textures.is_empty() {
            return Err(anyhow!("NVENC encoder requires at least one shared slot"));
        }
        if params.width % 2 != 0 || params.height % 2 != 0 {
            return Err(anyhow!(
                "NVENC dims must be even (got {}x{})",
                params.width,
                params.height
            ));
        }

        let fl = create_function_list()?;

        let cuda = params.cuda;

        // All NVENC API calls on a CUDA-typed session need the CUDA
        // context current on the calling thread. Push it once for
        // the whole init; the matching pop is at the bottom of `new`.
        unsafe {
            let st = (cuda.api.cuCtxPushCurrent_v2)(cuda.context);
            cuda.api.check("cuCtxPushCurrent_v2 (init)", st)?;
        }

        // Open session bound to the CUDA context (not the compositor's
        // D3D11 device — see Phase 3 design notes). NVENC's encoder
        // engine reads CUarray inputs we'll feed it per-frame.
        let mut session_params: sys::NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS =
            unsafe { std::mem::zeroed() };
        session_params.version = NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER;
        session_params.deviceType = sys::_NV_ENC_DEVICE_TYPE::NV_ENC_DEVICE_TYPE_CUDA;
        session_params.device = cuda.context as *mut c_void;
        session_params.apiVersion = sys::NVENCAPI_VERSION;

        let mut encoder: *mut c_void = std::ptr::null_mut();
        let open_fn = fl
            .nvEncOpenEncodeSessionEx
            .ok_or_else(|| anyhow!("nvEncOpenEncodeSessionEx missing from function list"))?;
        let st = unsafe { open_fn(&mut session_params, &mut encoder) };
        if st != NV_ENC_SUCCESS {
            return Err(anyhow!(
                "nvEncOpenEncodeSessionEx failed: NVENC status 0x{:x}",
                st
            ));
        }

        // Build init params with a sane default config (preset P5,
        // tuning High Quality), then override profile + VUI.
        let mut init: sys::NV_ENC_INITIALIZE_PARAMS = unsafe { std::mem::zeroed() };
        init.version = NV_ENC_INITIALIZE_PARAMS_VER;
        init.encodeGUID = NV_ENC_CODEC_H264_GUID;
        init.presetGUID = NV_ENC_PRESET_P5_GUID;
        init.encodeWidth = params.width;
        init.encodeHeight = params.height;
        init.darWidth = params.width;
        init.darHeight = params.height;
        init.frameRateNum = params.fps;
        init.frameRateDen = 1;
        init.enablePTD = 1;
        init.tuningInfo =
            sys::NV_ENC_TUNING_INFO::NV_ENC_TUNING_INFO_HIGH_QUALITY;
        init.bufferFormat = sys::_NV_ENC_BUFFER_FORMAT::NV_ENC_BUFFER_FORMAT_NV12;
        init.maxEncodeWidth = params.width;
        init.maxEncodeHeight = params.height;

        // Pull a default config for the chosen preset+tuning, then
        // mutate. NVENC populates this with sensible defaults; we
        // only override the things we actually care about.
        let mut preset_cfg: sys::NV_ENC_PRESET_CONFIG = unsafe { std::mem::zeroed() };
        preset_cfg.version = NV_ENC_PRESET_CONFIG_VER;
        preset_cfg.presetCfg.version = NV_ENC_CONFIG_VER;
        let preset_fn = fl
            .nvEncGetEncodePresetConfigEx
            .ok_or_else(|| anyhow!("nvEncGetEncodePresetConfigEx missing"))?;
        let st = unsafe {
            preset_fn(
                encoder,
                NV_ENC_CODEC_H264_GUID,
                NV_ENC_PRESET_P5_GUID,
                sys::NV_ENC_TUNING_INFO::NV_ENC_TUNING_INFO_HIGH_QUALITY,
                &mut preset_cfg,
            )
        };
        if st != NV_ENC_SUCCESS {
            unsafe {
                if let Some(d) = fl.nvEncDestroyEncoder {
                    let _ = d(encoder);
                }
            }
            return Err(anyhow!(
                "nvEncGetEncodePresetConfigEx failed: NVENC status 0x{:x}",
                st
            ));
        }

        // Override profile to High and set BT.709 limited-range VUI.
        let mut config = preset_cfg.presetCfg;
        config.version = NV_ENC_CONFIG_VER;
        config.profileGUID = NV_ENC_H264_PROFILE_HIGH_GUID;
        // GOP = 2 seconds — matches what the ffmpeg path does. Smaller
        // GOPs improve seek granularity, larger improve compression.
        config.gopLength = params.fps * 2;
        config.frameIntervalP = 1; // I, P, P, ... (no B-frames for low latency)

        // VUI: BT.709, limited range. Indexes match ITU-T H.264
        // Table E-3/E-4: 1 = BT.709 for primaries/transfer/matrix.
        // video_full_range_flag = 0 → limited (16–235).
        let h264 = unsafe { &mut config.encodeCodecConfig.h264Config };
        h264.h264VUIParameters.videoSignalTypePresentFlag = 1;
        h264.h264VUIParameters.videoFormat = 5; // unspecified
        h264.h264VUIParameters.videoFullRangeFlag = 0;
        h264.h264VUIParameters.colourDescriptionPresentFlag = 1;
        h264.h264VUIParameters.colourPrimaries = 1; // BT.709
        h264.h264VUIParameters.transferCharacteristics = 1; // BT.709
        h264.h264VUIParameters.colourMatrix = 1; // BT.709
        h264.idrPeriod = config.gopLength;
        // chromaFormatIDC=1 = 4:2:0 (NV12 default; explicit anyway).
        h264.chromaFormatIDC = 1;
        // We've intentionally NOT set `entropyCodingMode = CABAC`.
        // It would normally be required for the High profile we
        // request via `profileGUID` to actually land in the SPS,
        // but on this driver setting it explicitly wedges the
        // writer at frame 0 — both on the original D3D11 path and
        // on the CUDA path. The cause is unclear (possibly related
        // to per-frame register/unregister of CUarrays). Leaving
        // entropyCodingMode at AUTOSELECT keeps recording stable;
        // the cost is the SPS being labeled Constrained Baseline
        // by parsers, even though the actual encoded content is
        // higher-quality than that label suggests. The MP4 `colr`
        // atom is still written from ffmpeg's `-color_*` flags +
        // `+write_colr`, so playback color should be correct.

        // Rate control — constant QP for predictable quality on
        // screen content. QP 19 ≈ visually transparent for this
        // codec, matches the ffmpeg path's `-rc constqp -qp 19`.
        //
        // Spatial AQ stays on: it reallocates bits within each frame
        // toward visually salient areas (text edges, gradients on
        // the overlay rainbow glow) and is safe under CONSTQP +
        // single-bitstream-buffer.
        //
        // Temporal AQ and lookahead are intentionally OFF:
        // - Temporal AQ is designed for B-frame configurations; we
        //   run IPPP (`frameIntervalP=1`).
        // - Lookahead requires the encoder to queue N input frames
        //   before producing output for the first one, but our
        //   `Nv12Ring` only has 16 slots — the compositor would
        //   wrap around and overwrite a slot before NVENC finished
        //   reading it, producing severe ghosting in the output.
        //   If we want lookahead, the ring needs `capacity >
        //   lookaheadDepth + safety_margin`.
        config.rcParams.version = struct_ver(1);
        config.rcParams.rateControlMode =
            sys::_NV_ENC_PARAMS_RC_MODE::NV_ENC_PARAMS_RC_CONSTQP;
        // QP 17 — matches the configuration that produced the
        // verified-working recording in Log_54. Lower values were
        // tried (15) and still produced Baseline-equivalent output
        // because we can't enable CABAC without wedging on this
        // driver; QP 17 + Baseline is acceptable quality for screen
        // content and keeps file sizes reasonable.
        config.rcParams.constQP = sys::NV_ENC_QP {
            qpInterP: 17,
            qpInterB: 17,
            qpIntra: 17,
        };
        // Spatial AQ at strength 4 (was 8). Strength 8 was producing
        // visible block-boundary artifacts where neighboring MBs got
        // too-different per-block QPs; 4 gives a gentler bias toward
        // text/edge preservation without the seams.
        config.rcParams.set_enableAQ(1);
        config.rcParams.set_aqStrength(4);

        init.encodeConfig = &mut config;

        let init_fn = fl
            .nvEncInitializeEncoder
            .ok_or_else(|| anyhow!("nvEncInitializeEncoder missing"))?;
        let st = unsafe { init_fn(encoder, &mut init) };
        if st != NV_ENC_SUCCESS {
            unsafe {
                if let Some(d) = fl.nvEncDestroyEncoder {
                    let _ = d(encoder);
                }
            }
            return Err(anyhow!(
                "nvEncInitializeEncoder failed: NVENC status 0x{:x}",
                st
            ));
        }

        // Register each slot's D3D11 texture as a CUDA graphics
        // resource. The NVENC encoder (now CUDA-typed) consumes
        // CUarrays produced by mapping these resources per-frame in
        // `write_gpu_slot`. We do NOT register the D3D11 textures
        // directly with NVENC anymore — that was the same-device
        // path that kept wedging.
        let mut cuda_resources: Vec<super::cuda_sys::CUgraphicsResource> =
            Vec::with_capacity(params.slot_textures.len());
        for (i, tex) in params.slot_textures.iter().enumerate() {
            let mut cuda_resource: super::cuda_sys::CUgraphicsResource =
                std::ptr::null_mut();
            let st = unsafe {
                (cuda.api.cuGraphicsD3D11RegisterResource)(
                    &mut cuda_resource,
                    tex.as_raw() as *mut c_void,
                    super::cuda_sys::CU_GRAPHICS_REGISTER_FLAGS_NONE,
                )
            };
            if st != super::cuda_sys::CUDA_SUCCESS {
                let _ = unsafe {
                    let mut popped = std::ptr::null_mut();
                    (cuda.api.cuCtxPopCurrent_v2)(&mut popped)
                };
                return Err(anyhow!(
                    "cuGraphicsD3D11RegisterResource[{i}] failed: CUDA result {st}"
                ));
            }
            cuda_resources.push(cuda_resource);
        }
        tracing::info!(
            slot_count = cuda_resources.len(),
            "CUDA: registered all slot textures as graphics resources"
        );

        // One bitstream buffer per input slot. Sharing a single
        // output buffer across encodes appears to internally serialize
        // NVENC's pipeline in a way that wedges the second-frame
        // `nvEncMapInputResource` on this driver/GPU. OBS allocates
        // per-slot output buffers and rotates them — same approach
        // here. Each `write_gpu_slot(N)` writes into `bitstreams[N]`,
        // so consecutive encodes don't contend for the same output.
        let bs_fn = fl
            .nvEncCreateBitstreamBuffer
            .ok_or_else(|| anyhow!("nvEncCreateBitstreamBuffer missing"))?;
        let mut bitstreams: Vec<*mut c_void> = Vec::with_capacity(cuda_resources.len());
        for i in 0..cuda_resources.len() {
            let mut bs_create: sys::NV_ENC_CREATE_BITSTREAM_BUFFER =
                unsafe { std::mem::zeroed() };
            bs_create.version = NV_ENC_CREATE_BITSTREAM_BUFFER_VER;
            let st = unsafe { bs_fn(encoder, &mut bs_create) };
            if st != NV_ENC_SUCCESS {
                let _ = unsafe {
                    let mut popped = std::ptr::null_mut();
                    (cuda.api.cuCtxPopCurrent_v2)(&mut popped)
                };
                return Err(anyhow!(
                    "nvEncCreateBitstreamBuffer[{i}] failed: NVENC status 0x{:x}",
                    st
                ));
            }
            bitstreams.push(bs_create.bitstreamBuffer);
        }

        // Pop the CUDA context off this thread now that init's done.
        // The writer thread will push it again per encode call.
        unsafe {
            let mut popped = std::ptr::null_mut();
            let st = (cuda.api.cuCtxPopCurrent_v2)(&mut popped);
            cuda.api.check("cuCtxPopCurrent_v2 (after init)", st)?;
        }

        // Spawn the muxer pipe — ffmpeg consumes raw H.264 ES on
        // stdin, writes MP4 to disk.
        let muxer = MuxerPipe::spawn(&params.ffmpeg_path, &params.output, params.fps)
            .context("spawn ffmpeg muxer pipe")?;

        let fence_event = unsafe {
            CreateEventW(None, false, false, windows::core::PCWSTR::null())
                .context("CreateEventW for NVENC fence wait")?
        };

        Ok(Self {
            fl,
            encoder,
            _slot_textures: params.slot_textures,
            bitstreams,
            _fps: params.fps.max(1),
            frame_count: 0,
            muxer: Some(muxer),
            width: params.width,
            height: params.height,
            fence: params.fence,
            fence_event,
            cuda,
            cuda_resources,
        })
    }

    fn write_gpu_slot(&mut self, slot_index: usize, fence_value: u64) -> Result<()> {
        let cuda_resource = *self
            .cuda_resources
            .get(slot_index)
            .ok_or_else(|| anyhow!("slot index {slot_index} out of range (no CUDA resource)"))?;
        let bitstream = *self
            .bitstreams
            .get(slot_index)
            .ok_or_else(|| anyhow!("slot index {slot_index} out of range (no bitstream)"))?;

        if self.frame_count < 30 || self.frame_count % 30 == 0 {
            tracing::info!(
                frame = self.frame_count,
                slot_index,
                fence_value,
                "NVENC/CUDA: begin encode path"
            );
        }

        // Cross-engine fence wait — same as before. Compositor's
        // `ctx4.Signal(fence, value)` after Flush guarantees the
        // GPU's 3D engine work for this slot has completed before we
        // hand the texture to the encoder engine. `cuGraphicsMapResources`
        // also synchronizes against pending D3D11 work, but the
        // explicit fence wait is cheap and removes any ambiguity.
        if fence_value > 0 {
            unsafe {
                self.fence
                    .SetEventOnCompletion(fence_value, self.fence_event)
                    .context("ID3D11Fence::SetEventOnCompletion")?;
                let wait_result = WaitForSingleObject(self.fence_event, 5_000);
                if wait_result.0 != 0 {
                    return Err(anyhow!(
                        "fence wait failed: WaitForSingleObject result 0x{:x}",
                        wait_result.0
                    ));
                }
            }
        }

        // CUDA + NVENC operations need the CUDA context current.
        unsafe {
            let st = (self.cuda.api.cuCtxPushCurrent_v2)(self.cuda.context);
            self.cuda.api.check("cuCtxPushCurrent_v2 (encode)", st)?;
        }

        // Helper for the cleanup path: pop the CUDA context. Always
        // call before bailing, even on error — leaving a context
        // pushed across function exits leaks thread-local state.
        let pop_ctx = |api: &super::cuda_sys::CudaApi| {
            unsafe {
                let mut popped = std::ptr::null_mut();
                let _ = (api.cuCtxPopCurrent_v2)(&mut popped);
            }
        };

        // Map the D3D11 NV12 texture into CUDA, get its CUarray.
        let mut resources_arr = [cuda_resource];
        let st = unsafe {
            (self.cuda.api.cuGraphicsMapResources)(
                1,
                resources_arr.as_mut_ptr(),
                std::ptr::null_mut(),
            )
        };
        if st != super::cuda_sys::CUDA_SUCCESS {
            pop_ctx(&self.cuda.api);
            return Err(anyhow!("cuGraphicsMapResources failed: {st}"));
        }

        let mut cu_array: super::cuda_sys::CUarray = std::ptr::null_mut();
        let st = unsafe {
            (self.cuda.api.cuGraphicsSubResourceGetMappedArray)(
                &mut cu_array,
                cuda_resource,
                0,
                0,
            )
        };
        if st != super::cuda_sys::CUDA_SUCCESS {
            unsafe {
                let _ = (self.cuda.api.cuGraphicsUnmapResources)(
                    1,
                    resources_arr.as_mut_ptr(),
                    std::ptr::null_mut(),
                );
            }
            pop_ctx(&self.cuda.api);
            return Err(anyhow!(
                "cuGraphicsSubResourceGetMappedArray failed: {st}"
            ));
        }

        // Register the CUarray with NVENC for this single encode.
        // The CUarray pointer changes each map call, so we re-register
        // every frame. Each register call is fast (microseconds);
        // NVENC's API supports this pattern.
        let reg_fn = match self.fl.nvEncRegisterResource {
            Some(f) => f,
            None => {
                unsafe {
                    let _ = (self.cuda.api.cuGraphicsUnmapResources)(
                        1,
                        resources_arr.as_mut_ptr(),
                        std::ptr::null_mut(),
                    );
                }
                pop_ctx(&self.cuda.api);
                return Err(anyhow!("nvEncRegisterResource missing"));
            }
        };
        let mut rr: sys::NV_ENC_REGISTER_RESOURCE = unsafe { std::mem::zeroed() };
        rr.version = NV_ENC_REGISTER_RESOURCE_VER;
        rr.resourceType =
            sys::_NV_ENC_INPUT_RESOURCE_TYPE::NV_ENC_INPUT_RESOURCE_TYPE_CUDAARRAY;
        rr.width = self.width;
        rr.height = self.height;
        rr.pitch = 0;
        rr.subResourceIndex = 0;
        rr.resourceToRegister = cu_array as *mut c_void;
        rr.bufferFormat = sys::_NV_ENC_BUFFER_FORMAT::NV_ENC_BUFFER_FORMAT_NV12;
        let st = unsafe { reg_fn(self.encoder, &mut rr) };
        if st != NV_ENC_SUCCESS {
            unsafe {
                let _ = (self.cuda.api.cuGraphicsUnmapResources)(
                    1,
                    resources_arr.as_mut_ptr(),
                    std::ptr::null_mut(),
                );
            }
            pop_ctx(&self.cuda.api);
            return Err(anyhow!(
                "nvEncRegisterResource (CUarray) failed: NVENC status 0x{:x}",
                st
            ));
        }
        let registered_handle = rr.registeredResource;

        // Map the registered resource for NVENC, encode, lock, write.
        let mut map: sys::NV_ENC_MAP_INPUT_RESOURCE = unsafe { std::mem::zeroed() };
        map.version = NV_ENC_MAP_INPUT_RESOURCE_VER;
        map.registeredResource = registered_handle;
        let map_fn = self.fl.nvEncMapInputResource.ok_or_else(|| {
            anyhow!("nvEncMapInputResource missing")
        })?;
        let st = unsafe { map_fn(self.encoder, &mut map) };
        if st != NV_ENC_SUCCESS {
            unsafe {
                if let Some(u) = self.fl.nvEncUnregisterResource {
                    let _ = u(self.encoder, registered_handle);
                }
                let _ = (self.cuda.api.cuGraphicsUnmapResources)(
                    1,
                    resources_arr.as_mut_ptr(),
                    std::ptr::null_mut(),
                );
            }
            pop_ctx(&self.cuda.api);
            return Err(anyhow!(
                "nvEncMapInputResource failed: NVENC status 0x{:x}",
                st
            ));
        }

        let mut pic: sys::NV_ENC_PIC_PARAMS = unsafe { std::mem::zeroed() };
        pic.version = NV_ENC_PIC_PARAMS_VER;
        pic.inputWidth = self.width;
        pic.inputHeight = self.height;
        pic.inputBuffer = map.mappedResource;
        pic.outputBitstream = bitstream;
        pic.bufferFmt = sys::_NV_ENC_BUFFER_FORMAT::NV_ENC_BUFFER_FORMAT_NV12;
        pic.pictureStruct = sys::_NV_ENC_PIC_STRUCT::NV_ENC_PIC_STRUCT_FRAME;
        pic.frameIdx = self.frame_count as u32;
        pic.inputTimeStamp = self.frame_count;

        let enc_fn = self
            .fl
            .nvEncEncodePicture
            .ok_or_else(|| anyhow!("nvEncEncodePicture missing"))?;
        let st = unsafe { enc_fn(self.encoder, &mut pic) };
        let success = st == NV_ENC_SUCCESS;
        let need_more = st == NV_ENC_ERR_NEED_MORE_INPUT;

        // Lock + write the bitstream if output is ready. We do this
        // BEFORE unmap/unregister/cuda-unmap to keep the order
        // simple. Capture result so cleanup always runs.
        let flush_result: Result<()> = if success {
            self.flush_bitstream(bitstream)
        } else if need_more {
            Ok(())
        } else {
            Err(anyhow!(
                "nvEncEncodePicture failed: NVENC status 0x{:x}",
                st
            ))
        };

        // Cleanup, in reverse order of acquisition. All best-effort —
        // an error in cleanup is logged, not propagated, except as
        // a fallback when `flush_result` is Ok.
        unsafe {
            if let Some(u) = self.fl.nvEncUnmapInputResource {
                let _ = u(self.encoder, map.mappedResource);
            }
            if let Some(u) = self.fl.nvEncUnregisterResource {
                let _ = u(self.encoder, registered_handle);
            }
            let _ = (self.cuda.api.cuGraphicsUnmapResources)(
                1,
                resources_arr.as_mut_ptr(),
                std::ptr::null_mut(),
            );
        }
        pop_ctx(&self.cuda.api);

        if self.frame_count < 30 || self.frame_count % 30 == 0 {
            tracing::info!(
                frame = self.frame_count,
                success,
                need_more,
                "NVENC/CUDA: encode + cleanup done"
            );
        }
        self.frame_count = self.frame_count.saturating_add(1);
        flush_result
    }

    fn flush_bitstream(&mut self, bitstream: *mut c_void) -> Result<()> {
        let mut lock: sys::NV_ENC_LOCK_BITSTREAM = unsafe { std::mem::zeroed() };
        lock.version = NV_ENC_LOCK_BITSTREAM_VER;
        lock.outputBitstream = bitstream;
        let lock_fn = self
            .fl
            .nvEncLockBitstream
            .ok_or_else(|| anyhow!("nvEncLockBitstream missing"))?;
        let st = unsafe { lock_fn(self.encoder, &mut lock) };
        if st != NV_ENC_SUCCESS {
            return Err(anyhow!(
                "nvEncLockBitstream failed: NVENC status 0x{:x}",
                st
            ));
        }
        if self.frame_count < 30 || self.frame_count % 30 == 0 {
            tracing::info!(
                frame = self.frame_count,
                bytes = lock.bitstreamSizeInBytes,
                "NVENC: locked bitstream"
            );
        }
        // Copy out of NVENC's internal buffer immediately, THEN
        // unlock, THEN write to the muxer pipe. The previous version
        // held NVENC's bitstream buffer locked across the (potentially
        // blocking) pipe write — if ffmpeg got even slightly behind,
        // NVENC couldn't reuse the buffer for the next encode and the
        // whole pipeline wedged. Copying first is ~50 KB/frame at
        // 4K60 QP=19 — sub-ms and keeps NVENC's queue draining.
        let copy: Vec<u8> = unsafe {
            std::slice::from_raw_parts(
                lock.bitstreamBufferPtr as *const u8,
                lock.bitstreamSizeInBytes as usize,
            )
        }
        .to_vec();
        let unlock_fn = self
            .fl
            .nvEncUnlockBitstream
            .ok_or_else(|| anyhow!("nvEncUnlockBitstream missing"))?;
        let _ = unsafe { unlock_fn(self.encoder, bitstream) };
        self.muxer
            .as_mut()
            .ok_or_else(|| anyhow!("muxer pipe missing"))?
            .write(&copy)?;
        if self.frame_count < 30 || self.frame_count % 30 == 0 {
            tracing::info!(frame = self.frame_count, "NVENC: muxer write finished");
        }
        Ok(())
    }

    fn drain(&mut self) -> Result<()> {
        // Send EOS to the encoder, then keep flushing bitstreams until
        // it returns NEED_MORE_INPUT (= done).
        let mut pic: sys::NV_ENC_PIC_PARAMS = unsafe { std::mem::zeroed() };
        pic.version = NV_ENC_PIC_PARAMS_VER;
        pic.encodePicFlags = sys::_NV_ENC_PIC_FLAGS::NV_ENC_PIC_FLAG_EOS as u32;
        let enc_fn = self
            .fl
            .nvEncEncodePicture
            .ok_or_else(|| anyhow!("nvEncEncodePicture missing"))?;
        let st = unsafe { enc_fn(self.encoder, &mut pic) };
        if st != NV_ENC_SUCCESS && st != NV_ENC_ERR_NEED_MORE_INPUT {
            return Err(anyhow!(
                "nvEncEncodePicture(EOS) failed: NVENC status 0x{:x}",
                st
            ));
        }
        // Drain any remaining output. With per-slot bitstream buffers,
        // pending output is in the buffer matching the original slot
        // index — we rotate through all of them once each. Each one
        // either returns the slot's pending bytes or NEED_MORE_INPUT
        // (already consumed / never used).
        for &bitstream in &self.bitstreams {
            let mut lock: sys::NV_ENC_LOCK_BITSTREAM = unsafe { std::mem::zeroed() };
            lock.version = NV_ENC_LOCK_BITSTREAM_VER;
            lock.outputBitstream = bitstream;
            let lock_fn = self
                .fl
                .nvEncLockBitstream
                .ok_or_else(|| anyhow!("nvEncLockBitstream missing"))?;
            let st = unsafe { lock_fn(self.encoder, &mut lock) };
            if st == NV_ENC_ERR_NEED_MORE_INPUT {
                continue;
            }
            if st != NV_ENC_SUCCESS {
                tracing::warn!(
                    st = format!("0x{:x}", st),
                    "nvEncLockBitstream(drain) non-OK; skipping"
                );
                continue;
            }
            let copy: Vec<u8> = unsafe {
                std::slice::from_raw_parts(
                    lock.bitstreamBufferPtr as *const u8,
                    lock.bitstreamSizeInBytes as usize,
                )
            }
            .to_vec();
            let unlock_fn = self
                .fl
                .nvEncUnlockBitstream
                .ok_or_else(|| anyhow!("nvEncUnlockBitstream missing"))?;
            let _ = unsafe { unlock_fn(self.encoder, bitstream) };
            self.muxer.as_mut().unwrap().write(&copy)?;
        }
        Ok(())
    }
}

impl Drop for NvencEncoder {
    fn drop(&mut self) {
        unsafe {
            if let Some(u) = self.fl.nvEncDestroyBitstreamBuffer {
                for &bs in &self.bitstreams {
                    if !bs.is_null() {
                        let _ = u(self.encoder, bs);
                    }
                }
                self.bitstreams.clear();
            }
            // We no longer maintain a long-lived `registered` Vec —
            // each frame's NVENC registration is unregistered before
            // the encode call returns. Nothing to clean up here.
            // Unregister CUDA graphics resources before destroying
            // the CUDA context (`CudaSession::Drop`). Push the context
            // so the call lands on this thread.
            if !self.cuda_resources.is_empty() {
                let st = (self.cuda.api.cuCtxPushCurrent_v2)(self.cuda.context);
                if st == super::cuda_sys::CUDA_SUCCESS {
                    for r in self.cuda_resources.drain(..) {
                        if !r.is_null() {
                            let _ = (self.cuda.api.cuGraphicsUnregisterResource)(r);
                        }
                    }
                    let mut popped = std::ptr::null_mut();
                    let _ = (self.cuda.api.cuCtxPopCurrent_v2)(&mut popped);
                }
            }
            if let Some(d) = self.fl.nvEncDestroyEncoder {
                if !self.encoder.is_null() {
                    let _ = d(self.encoder);
                }
            }
            if !self.fence_event.is_invalid() {
                let _ = windows::Win32::Foundation::CloseHandle(self.fence_event);
            }
            // CudaSession's own Drop runs after this and destroys the
            // CUDA context.
        }
    }
}

impl EncoderBackend for NvencEncoder {
    fn write_nv12_frame(&mut self, payload: NvFramePayload<'_>) -> Result<()> {
        match payload {
            NvFramePayload::GpuSlot { idx, fence_value } => {
                self.write_gpu_slot(idx, fence_value)
            }
            NvFramePayload::Cpu(_) => Err(anyhow!(
                "NVENC backend can't consume CPU NV12 frames"
            )),
        }
    }

    fn label(&self) -> &'static str {
        Encoder::Nvenc.label()
    }

    fn finish(mut self: Box<Self>, timeout: Duration) -> Result<()> {
        tracing::info!(frame_count = self.frame_count, "NVENC finish: draining encoder");
        let drain_result = self.drain();
        if let Err(err) = &drain_result {
            tracing::error!(?err, "NVENC drain failed");
        }
        // Always close the muxer — even on drain error, anything we
        // already wrote should still get a moov atom.
        let muxer = self.muxer.take();
        let mux_result = if let Some(m) = muxer {
            m.finish(timeout)
        } else {
            Ok(())
        };
        drain_result?;
        mux_result
    }
}

// ─── Public GUIDs (computed locally — bindgen can't do struct GUIDs) ──

const NV_ENC_CODEC_H264_GUID: sys::GUID = sys::GUID {
    Data1: 0x6bc8_2762,
    Data2: 0x4e63,
    Data3: 0x4ca4,
    Data4: [0xaa, 0x85, 0x1e, 0x50, 0xf3, 0x21, 0xf6, 0xbf],
};

// From the SDK header. Bindgen sees these as `pub static GUID` externs
// (no link target — we don't link the SDK), so we redeclare them
// inline with the canonical bytes from `nvEncodeAPI.h`.
const NV_ENC_PRESET_P5_GUID: sys::GUID = sys::GUID {
    Data1: 0x21c6_e6b4,
    Data2: 0x297a,
    Data3: 0x4cba,
    Data4: [0x99, 0x8f, 0xb6, 0xcb, 0xde, 0x72, 0xad, 0xe3],
};

const NV_ENC_H264_PROFILE_HIGH_GUID: sys::GUID = sys::GUID {
    Data1: 0xe7cb_c309,
    Data2: 0x4f7a,
    Data3: 0x4b89,
    Data4: [0xaf, 0x2a, 0xd5, 0x37, 0xc9, 0x2b, 0xe3, 0x10],
};
