//! ffmpeg-pipe encoder with hardware-encoder probing and fallback.
//!
//! The encoder accepts raw **NV12** frames on stdin and writes an MP4
//! file. We convert BGRA → NV12 in `convert::bgra_to_nv12` on the
//! composite thread before sending to the writer. This (a) cuts pipe
//! traffic by 2.67× vs. shipping BGRA, which matters a lot at 4K60,
//! and (b) skips ffmpeg's single-threaded swscale colorspace conversion
//! since nvenc/amf/qsv all consume NV12 natively.
//!
//! At startup we probe the bundled ffmpeg for working H.264 encoders by
//! running a tiny dry-run encode (not just checking `ffmpeg -encoders`
//! presence) so runtime-init failures push us down the fallback chain
//! before the user hits record.

use std::fmt;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
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

#[derive(Debug, Clone)]
pub struct FfmpegParams {
    pub ffmpeg_path: PathBuf,
    pub encoder: Encoder,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    #[allow(dead_code)] // reserved for CBR mode (streaming / future bitrate UI)
    pub bitrate_kbps: u32,
    pub output: PathBuf,
}

pub struct FfmpegPipe {
    child: Child,
    stdin: Option<ChildStdin>,
    stderr_tail: std::sync::Arc<parking_lot::Mutex<String>>,
    stderr_join: Option<std::thread::JoinHandle<()>>,
}

impl FfmpegPipe {
    pub fn spawn(params: &FfmpegParams) -> Result<Self> {
        let size = format!("{}x{}", params.width, params.height);
        let fps = params.fps.to_string();
        let gop = (params.fps * 2).to_string();

        let mut command = Command::new(&params.ffmpeg_path);
        // Tag the rawvideo input with the color space we're actually
        // producing. `convert::bgra_to_nv12` and the GPU compositor's
        // PS_Y/PS_UV shaders both write BT.709 limited-range NV12. Without
        // these tags ffmpeg falls back to format-default heuristics (often
        // BT.601 for raw input), and the resulting MP4 ends up with
        // metadata that doesn't match its pixels — players apply the
        // wrong inverse matrix and you get subtle hue casts on neutral
        // grays plus desaturated mids on color content. Adding the same
        // tags on the output side ensures the H.264 stream's VUI carries
        // matching metadata so VLC, QuickTime, etc. decode correctly.
        command.args([
            "-hide_banner",
            "-loglevel", "error",
            "-y",
            "-f", "rawvideo",
            "-pix_fmt", "nv12",
            "-color_range", "tv",
            "-colorspace", "bt709",
            "-color_primaries", "bt709",
            "-color_trc", "bt709",
            "-video_size", &size,
            "-framerate", &fps,
            "-i", "-",
            "-an",
            "-c:v", params.encoder.ffmpeg_name(),
        ]);
        // Per-encoder quality tuning. We use CQP / CRF (quality-based rate
        // control) instead of CBR so bits go where the encoder needs them —
        // flat regions stay small, detail stays sharp. These settings match
        // OBS's "High Quality" defaults for local recording and produce
        // near-transparent screen captures at reasonable file sizes.
        match params.encoder {
            Encoder::Nvenc => {
                command.args([
                    "-preset", "p5",
                    "-tune", "hq",
                    "-rc", "constqp",
                    "-qp", "19",
                    "-multipass", "qres",
                    "-spatial-aq", "1",
                ]);
            }
            Encoder::Amf => {
                command.args([
                    "-quality", "quality",
                    "-rc", "cqp",
                    "-qp_i", "20",
                    "-qp_p", "22",
                ]);
            }
            Encoder::Qsv => {
                command.args([
                    "-preset", "slower",
                    "-global_quality", "19",
                ]);
            }
            Encoder::X264 => {
                command.args([
                    "-preset", "fast",
                    "-crf", "18",
                    "-tune", "stillimage",
                ]);
            }
        }
        command.args([
            "-g", &gop,
            "-pix_fmt", "yuv420p",
            "-color_range", "tv",
            "-colorspace", "bt709",
            "-color_primaries", "bt709",
            "-color_trc", "bt709",
            "-movflags", "+faststart",
        ]);
        command.arg(&params.output);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = command
            .spawn()
            .with_context(|| format!("spawn ffmpeg at {:?}", params.ffmpeg_path))?;

        let stdin = child.stdin.take();
        let stderr = child.stderr.take();
        let tail = std::sync::Arc::new(parking_lot::Mutex::new(String::new()));
        let stderr_join = if let Some(mut stderr) = stderr {
            let tail = std::sync::Arc::clone(&tail);
            Some(std::thread::spawn(move || {
                use std::io::Read;
                let mut buf = [0u8; 2048];
                loop {
                    match stderr.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            let chunk = String::from_utf8_lossy(&buf[..n]);
                            let mut guard = tail.lock();
                            guard.push_str(&chunk);
                            // Cap to the last 4 KiB so we don't balloon.
                            if guard.len() > 4096 {
                                let start = guard.len() - 4096;
                                *guard = guard[start..].to_string();
                            }
                        }
                        Err(_) => break,
                    }
                }
            }))
        } else {
            None
        };

        Ok(Self {
            child,
            stdin,
            stderr_tail: tail,
            stderr_join,
        })
    }

    pub fn write_frame(&mut self, bgra: &[u8]) -> Result<()> {
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| anyhow!("ffmpeg stdin already closed"))?;
        stdin
            .write_all(bgra)
            .context("write frame to ffmpeg stdin")?;
        Ok(())
    }

    pub fn stderr_tail(&self) -> String {
        self.stderr_tail.lock().clone()
    }

    /// Close stdin, wait for ffmpeg to flush, return exit code.
    pub fn finish(mut self, hard_timeout: Duration) -> Result<()> {
        drop(self.stdin.take());
        let deadline = std::time::Instant::now() + hard_timeout;
        loop {
            match self.child.try_wait() {
                Ok(Some(status)) => {
                    if let Some(join) = self.stderr_join.take() {
                        let _ = join.join();
                    }
                    if status.success() {
                        return Ok(());
                    }
                    let tail = self.stderr_tail();
                    return Err(anyhow!(
                        "ffmpeg exited with {}: {}",
                        status.code().map(|c| c.to_string()).unwrap_or_else(|| "signal".to_string()),
                        tail.trim()
                    ));
                }
                Ok(None) => {
                    if std::time::Instant::now() >= deadline {
                        let _ = self.child.kill();
                        let _ = self.child.wait();
                        let tail = self.stderr_tail();
                        return Err(anyhow!(
                            "ffmpeg did not exit within {:?}; last output: {}",
                            hard_timeout,
                            tail.trim()
                        ));
                    }
                    std::thread::sleep(Duration::from_millis(25));
                }
                Err(err) => return Err(anyhow!("ffmpeg wait failed: {err}")),
            }
        }
    }

    pub fn kill(&mut self) {
        drop(self.stdin.take());
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for FfmpegPipe {
    fn drop(&mut self) {
        if let Ok(Some(_)) = self.child.try_wait() {
            return;
        }
        self.kill();
    }
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
