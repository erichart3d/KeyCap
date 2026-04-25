//! ffmpeg-pipe encoder backend.
//!
//! This is the original encoder path: convert BGRA → NV12 on the
//! composite thread, write tight CPU bytes to ffmpeg's stdin, ffmpeg
//! handles muxing to MP4. Used unconditionally for the x264 software
//! fallback; also used for nvenc/amf/qsv when Media Foundation is
//! unavailable or has been disabled.
//!
//! See [`crate::encoder`] for the trait this implements and the
//! decision tree for which backend a session uses.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};

use super::{Encoder, EncoderBackend, NvFramePayload};

/// Construction parameters for [`FfmpegPipe`]. Owned by the caller; the
/// pipe takes a snapshot at `spawn` time and doesn't reference the
/// struct after.
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

/// ffmpeg subprocess + its stdin pipe + a tail buffer of stderr lines
/// (kept around so a non-zero exit can surface a useful error rather
/// than just an exit code).
pub struct FfmpegPipe {
    child: Child,
    stdin: Option<ChildStdin>,
    stderr_tail: std::sync::Arc<parking_lot::Mutex<String>>,
    stderr_join: Option<std::thread::JoinHandle<()>>,
    encoder_label: &'static str,
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
            encoder_label: params.encoder.label(),
        })
    }

    fn write_nv12_bytes(&mut self, bytes: &[u8]) -> Result<()> {
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| anyhow!("ffmpeg stdin already closed"))?;
        stdin
            .write_all(bytes)
            .context("write frame to ffmpeg stdin")?;
        Ok(())
    }

    pub fn stderr_tail_str(&self) -> String {
        self.stderr_tail.lock().clone()
    }

    pub fn kill(&mut self) {
        drop(self.stdin.take());
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl EncoderBackend for FfmpegPipe {
    fn write_nv12_frame(&mut self, payload: NvFramePayload<'_>) -> Result<()> {
        match payload {
            NvFramePayload::Cpu(bytes) => self.write_nv12_bytes(bytes),
            NvFramePayload::GpuSlot { .. } => Err(anyhow!(
                "ffmpeg backend can't consume GPU slot frames; \
                 the session's encoder selection is wrong"
            )),
        }
    }

    fn label(&self) -> &'static str {
        self.encoder_label
    }

    fn stderr_tail(&self) -> String {
        self.stderr_tail_str()
    }

    fn finish(mut self: Box<Self>, hard_timeout: Duration) -> Result<()> {
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
                    let tail = self.stderr_tail_str();
                    return Err(anyhow!(
                        "ffmpeg exited with {}: {}",
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
                        let tail = self.stderr_tail_str();
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
}

impl Drop for FfmpegPipe {
    fn drop(&mut self) {
        if let Ok(Some(_)) = self.child.try_wait() {
            return;
        }
        self.kill();
    }
}
