//! Encoder backend abstraction + hardware-encoder probing and selection.
//!
//! The recorder feeds the composite thread's NV12 output into one of two
//! backend implementations:
//!
//! - [`ffmpeg::FfmpegPipe`] — original path. Tight CPU NV12 bytes go to
//!   ffmpeg's stdin; ffmpeg muxes to MP4. Used for the x264 software
//!   fallback. Also used for nvenc/amf/qsv as the safe path until the
//!   Media Foundation backend lands in Bite 2.
//! - `mf::MfEncoder` (Bite 2, not yet present) — Sink Writer that
//!   accepts the compositor's NV12 D3D11 texture directly so we never
//!   touch CPU between compositor and encoder.
//!
//! Both implement [`EncoderBackend`]. The session holds the active
//! backend as `Box<dyn EncoderBackend>` and writes one
//! [`NvFramePayload`] per composited frame; the variant the session
//! produces is determined at start by which backend was selected.
//!
//! At handshake we probe the bundled ffmpeg for working H.264 encoders
//! by running a tiny dry-run encode (not just checking `ffmpeg
//! -encoders` presence) so runtime-init failures push us down the
//! fallback chain before the user hits record.

pub mod ffmpeg;
#[cfg(windows)]
pub mod mf;

pub use ffmpeg::{FfmpegParams, FfmpegPipe};
#[cfg(windows)]
#[allow(unused_imports)] // wired into Session::start in a later step
pub use mf::{MfEncoder, MfParams};

use std::fmt;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

use anyhow::Result;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum Encoder {
    Nvenc,
    Amf,
    Qsv,
    X264,
}

impl Encoder {
    pub const fn ffmpeg_name(self) -> &'static str {
        match self {
            Encoder::Nvenc => "h264_nvenc",
            Encoder::Amf => "h264_amf",
            Encoder::Qsv => "h264_qsv",
            Encoder::X264 => "libx264",
        }
    }

    pub const fn label(self) -> &'static str {
        match self {
            Encoder::Nvenc => "nvenc",
            Encoder::Amf => "amf",
            Encoder::Qsv => "qsv",
            Encoder::X264 => "x264",
        }
    }

    pub fn from_label(s: &str) -> Option<Encoder> {
        match s {
            "nvenc" => Some(Encoder::Nvenc),
            "amf" => Some(Encoder::Amf),
            "qsv" => Some(Encoder::Qsv),
            "x264" => Some(Encoder::X264),
            _ => None,
        }
    }

    #[cfg(test)]
    pub const fn all_hardware() -> [Encoder; 3] {
        [Encoder::Nvenc, Encoder::Amf, Encoder::Qsv]
    }
}

impl fmt::Display for Encoder {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.label())
    }
}

/// Order we try encoders in when the user asks for "auto".
pub const DEFAULT_PRIORITY: [Encoder; 4] = [
    Encoder::Nvenc,
    Encoder::Amf,
    Encoder::Qsv,
    Encoder::X264,
];

/// One frame on its way to the encoder. The active backend determines
/// which variant the session produces — the session never picks a
/// variant the backend can't consume.
///
/// The lifetime parameter exists for the `Cpu` borrow; the GPU variant
/// carries only a slot index and is `'static`-able.
pub enum NvFramePayload<'a> {
    /// Tight-packed CPU NV12 bytes (`width * height * 3 / 2` long).
    /// Consumed by [`FfmpegPipe`].
    Cpu(&'a [u8]),
    /// Index into the compositor's `Nv12Ring` whose corresponding
    /// shared NV12 texture the encoder backend should consume.
    ///
    /// The compositor owns the producer-side textures; the MF backend
    /// holds parallel consumer-side textures opened from the same NT
    /// shared handles, indexed identically. The cross-device keyed
    /// mutex inside the resource serializes the handoff: composite
    /// writes under `AcquireSync(0)`/`ReleaseSync(1)`, encoder MFT
    /// reads under `AcquireSync(1)`/`ReleaseSync(0)`.
    ///
    /// Only the MF backend consumes this variant; `FfmpegPipe` errors
    /// on it because there is no slot table on the CPU side.
    GpuSlot(usize),
}

/// Behavior every encoder backend must provide to the session.
///
/// Lifetime: a backend is constructed at `Session::start`, fed one
/// frame per composite tick by the writer thread (or directly by the
/// composite thread on backends that don't need a writer indirection),
/// and consumed by `finish` on `Session::stop`.
pub trait EncoderBackend: Send {
    /// Write one composited frame to the encoder. The session is
    /// responsible for picking the right [`NvFramePayload`] variant for
    /// the active backend; passing the wrong variant must error.
    fn write_nv12_frame(&mut self, payload: NvFramePayload<'_>) -> Result<()>;

    /// Encoder label for logs / IPC status events (e.g. "nvenc",
    /// "x264"). Stable across the backend's lifetime.
    fn label(&self) -> &'static str;

    /// Tail of the backend's stderr / diagnostic stream, if any. Used
    /// to surface meaningful errors when `finish` reports failure.
    /// Default: empty string for backends that don't have a stderr
    /// (e.g. Media Foundation in-process).
    #[allow(dead_code)] // surfaced via get_status / error reporting in a later bite
    fn stderr_tail(&self) -> String {
        String::new()
    }

    /// Drain the encoder, finalize the output container, and exit.
    /// `timeout` bounds the wait for the encoder process / pipeline to
    /// flush; on expiry the implementation should kill / abort and
    /// return an error rather than hang the calling thread (which is
    /// usually `Session::stop`'s critical path).
    fn finish(self: Box<Self>, timeout: Duration) -> Result<()>;
}

/// Run a tiny dry encode at a fixed 320×180 resolution. Encoders can be
/// compiled into ffmpeg but still fail at runtime because of missing drivers
/// / busy sessions / incompatible hardware. Use this at handshake time to
/// filter out encoders that never work on this machine.
pub fn probe(ffmpeg: &Path, encoder: Encoder) -> bool {
    probe_at(ffmpeg, encoder, 320, 180, 30)
}

/// Re-probe at the resolution we are about to record at. Some hardware
/// encoders (notably older NVENC) pass the baseline probe at 320×180 but
/// fail at ultrawide / 4K inputs. Call this from Session::start before
/// committing to an encoder so we can fall through to the next candidate.
pub fn probe_at(ffmpeg: &Path, encoder: Encoder, width: u32, height: u32, fps: u32) -> bool {
    // Probe with even dims — NV12 requires both width and height to be
    // even. The session itself already enforces this via DDA's native
    // resolution, but the probe is called with arbitrary sizes.
    let width = (width.max(64) + 1) & !1;
    let height = (height.max(64) + 1) & !1;
    let fps = fps.max(1);
    let frames = 2usize;
    // NV12 = 1.5 bytes/pixel. We send the same zero-filled bytes that
    // bgra_to_nv12 would produce for solid black (Y=16, UV=128), so the
    // probe still exercises the real pipe path. Y plane then UV plane.
    let y_plane = (width as usize) * (height as usize);
    let uv_plane = y_plane / 2;
    let frame_bytes = y_plane + uv_plane;
    let mut payload = Vec::with_capacity(frame_bytes * frames);
    for _ in 0..frames {
        payload.extend(std::iter::repeat(16u8).take(y_plane));
        payload.extend(std::iter::repeat(128u8).take(uv_plane));
    }

    let child = Command::new(ffmpeg)
        .args([
            "-hide_banner",
            "-loglevel", "error",
            "-f", "rawvideo",
            "-pix_fmt", "nv12",
            "-video_size", &format!("{width}x{height}"),
            "-framerate", &fps.to_string(),
            "-i", "-",
            "-frames:v", &frames.to_string(),
            "-c:v", encoder.ffmpeg_name(),
            "-preset", preset_for(encoder),
            "-pix_fmt", "yuv420p",
            "-f", "null",
            "-",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();

    let mut child = match child {
        Ok(c) => c,
        Err(_) => return false,
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(&payload);
    }
    // Cap the probe — some failures hang on handshakes with the GPU.
    let deadline = std::time::Instant::now() + Duration::from_secs(6);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    return false;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return false,
        }
    }
}

fn preset_for(encoder: Encoder) -> &'static str {
    match encoder {
        Encoder::Nvenc | Encoder::Amf | Encoder::Qsv => "p4",
        Encoder::X264 => "medium",
    }
}

/// Pick an encoder given a user preference and the probe results.
pub fn select(
    requested: Option<Encoder>,
    available: &[Encoder],
) -> Option<Encoder> {
    if let Some(requested) = requested {
        if available.contains(&requested) {
            return Some(requested);
        }
        // Explicit request for an unavailable encoder: fall through so the
        // caller can report a targeted error.
        return None;
    }
    for candidate in DEFAULT_PRIORITY {
        if available.contains(&candidate) {
            return Some(candidate);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encoder_roundtrip_labels() {
        for e in [Encoder::Nvenc, Encoder::Amf, Encoder::Qsv, Encoder::X264] {
            assert_eq!(Encoder::from_label(e.label()), Some(e));
        }
        assert_eq!(Encoder::from_label("bogus"), None);
    }

    #[test]
    fn select_prefers_user_choice_when_available() {
        let all = Encoder::all_hardware();
        assert_eq!(
            select(Some(Encoder::Amf), &all),
            Some(Encoder::Amf)
        );
    }

    #[test]
    fn select_errors_when_explicit_choice_missing() {
        let only_x264 = [Encoder::X264];
        assert_eq!(select(Some(Encoder::Nvenc), &only_x264), None);
    }

    #[test]
    fn select_auto_follows_priority() {
        // Skip NVENC, should land on AMF next.
        let available = [Encoder::Amf, Encoder::Qsv, Encoder::X264];
        assert_eq!(select(None, &available), Some(Encoder::Amf));

        let available = [Encoder::Qsv, Encoder::X264];
        assert_eq!(select(None, &available), Some(Encoder::Qsv));

        let available = [Encoder::X264];
        assert_eq!(select(None, &available), Some(Encoder::X264));

        let available: [Encoder; 0] = [];
        assert_eq!(select(None, &available), None);
    }
}
