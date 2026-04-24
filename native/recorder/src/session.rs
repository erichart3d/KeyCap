//! Recording session: ties capture + encoder together, owns the counters
//! that feed `get_status`.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::capture::frame::Frame;
use crate::capture::{self, CaptureHandle, DisplayInfo};
use crate::encoder::{self, Encoder, FfmpegParams, FfmpegPipe};
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

pub struct Session {
    output_path: PathBuf,
    encoder_used: Encoder,
    fps: u32,
    width: u32,
    height: u32,
    started_at: Instant,
    counters: Arc<Counters>,
    capture: Option<CaptureHandle>,
    encoder_join: Option<std::thread::JoinHandle<Result<()>>>,
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

        let width = params.width.unwrap_or(display.width).max(2);
        let height = params.height.unwrap_or(display.height).max(2);
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

        let ffmpeg_params = FfmpegParams {
            ffmpeg_path: ffmpeg_path.to_path_buf(),
            encoder: chosen,
            width,
            height,
            fps,
            bitrate_kbps,
            output: output_path.clone(),
        };
        let mut pipe = FfmpegPipe::spawn(&ffmpeg_params)
            .with_context(|| format!("spawn ffmpeg for {} encode", chosen))?;

        let counters = Counters::new();
        let stop_signal = Arc::new(Mutex::new(false));
        // Bounded channel: if the encoder stalls, newer frames are dropped
        // rather than unbounded buffering. Capacity 3 matches ~50 ms at 60 fps.
        let (tx, rx) = sync_channel::<Frame>(3);

        let encoder_counters = Arc::clone(&counters);
        let encoder_stop = Arc::clone(&stop_signal);
        let encoder_overlay = overlay_latest.clone();
        let encoder_width = width;
        let encoder_height = height;
        let encoder_join = std::thread::spawn(move || -> Result<()> {
            for mut frame in rx {
                if *encoder_stop.lock() {
                    break;
                }
                // Composite the latest overlay frame onto this captured
                // frame. Dimensions must match — the Node side is expected
                // to feed a BGRA buffer at the same capture resolution.
                if let Some(latest) = encoder_overlay.as_ref() {
                    let guard = latest.lock();
                    if let Some(ov) = guard.as_ref() {
                        if ov.width == encoder_width
                            && ov.height == encoder_height
                            && ov.data.len() == frame.data.len()
                        {
                            overlay::composite(
                                &mut frame.data,
                                &ov.data,
                                encoder_width,
                                encoder_height,
                            );
                        }
                    }
                }
                let bytes = frame.byte_len() as u64;
                match pipe.write_frame(&frame.data) {
                    Ok(()) => {
                        encoder_counters.encoded.fetch_add(1, Ordering::Relaxed);
                        encoder_counters.bytes.fetch_add(bytes, Ordering::Relaxed);
                    }
                    Err(err) => {
                        tracing::error!(?err, "encoder write failed; stopping session");
                        break;
                    }
                }
            }
            pipe.finish(Duration::from_secs(10))
        });

        // Frame callback delivered from whatever thread WGC uses.
        let capture_counters = Arc::clone(&counters);
        let capture_width = width;
        let capture_height = height;
        let frame_tx: SyncSender<Frame> = tx;
        let on_frame: Box<dyn FnMut(Frame) + Send + 'static> =
            Box::new(move |frame: Frame| {
                capture_counters.captured.fetch_add(1, Ordering::Relaxed);
                // Drop frames that don't match the expected encoder size —
                // resolution mismatches would desync ffmpeg's rawvideo
                // input and corrupt the output.
                if frame.width != capture_width || frame.height != capture_height {
                    capture_counters.dropped.fetch_add(1, Ordering::Relaxed);
                    return;
                }
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

        let capture = capture::start_capture(&display.id, fps, on_frame)
            .context("start display capture")?;

        Ok(Self {
            output_path,
            encoder_used: chosen,
            fps,
            width,
            height,
            started_at: Instant::now(),
            counters,
            capture: Some(capture),
            encoder_join: Some(encoder_join),
            stop_signal,
        })
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
        // Signal the encoder thread to break on the next channel read.
        *self.stop_signal.lock() = true;
        if let Some(handle) = self.capture.take() {
            handle.stop();
        }
        // Dropping the capture closes the sender half held by the frame
        // callback, which in turn ends the encoder thread's channel loop.

        let stats = self.snapshot_stats();
        let join_result = self
            .encoder_join
            .take()
            .ok_or_else(|| anyhow!("encoder thread already joined"))?
            .join();
        let result = match join_result {
            Ok(Ok(())) => Ok(()),
            Ok(Err(err)) => Err(err),
            Err(_) => Err(anyhow!("encoder thread panicked")),
        };

        result?;
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
