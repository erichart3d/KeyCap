//! Overlay frame receiver.
//!
//! Exposes a Windows named pipe that the Electron main process connects
//! to when a recording starts. Node writes length-prefixed BGRA frames;
//! we keep the most recent one in a mutex and the encoder loop composites
//! it onto each captured frame before handing it to ffmpeg. Compositing
//! in the sidecar is required on monitors where Multi-Plane Overlay
//! routes transparent always-on-top windows off the DWM composition path
//! that DDA reads from — typical on HDR OLED displays.
//!
//! Wire format (little-endian):
//!   u32  magic = 0x594C564F  ("OVLY")
//!   u32  width
//!   u32  height
//!   u32  byte_len   (must equal width * height * 4)
//!   u8   bgra[byte_len]
//!
//! Writers must send exactly one frame per header. There is no ack: if
//! the sidecar can't keep up, frames pile up in the pipe's OS buffer and
//! get drained at the reader's pace.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;

use anyhow::{anyhow, Context, Result};
use parking_lot::Mutex;

#[cfg(windows)]
use windows::core::PCWSTR;
#[cfg(windows)]
use windows::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
#[cfg(windows)]
use windows::Win32::Storage::FileSystem::{ReadFile, PIPE_ACCESS_DUPLEX};
#[cfg(windows)]
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE,
    PIPE_WAIT,
};

const MAGIC: u32 = 0x594C564F; // 'OVLY' (little-endian file layout)
const MAX_FRAME_BYTES: usize = 32 * 1024 * 1024; // 4K BGRA ~= 32 MiB upper bound

pub struct OverlayFrame {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
    /// Monotonically increasing sequence set by the pipe receiver. Consumers
    /// use this to detect when the overlay image has actually changed so
    /// they can skip expensive per-tick work (e.g. NN-upscaling from a
    /// DPI-clamped paint buffer up to 4K) when the overlay is stable.
    pub seq: u64,
}

pub struct OverlayReceiver {
    pipe_name: String,
    latest: Arc<Mutex<Option<OverlayFrame>>>,
    #[allow(dead_code)]
    frames_received: Arc<AtomicU64>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl OverlayReceiver {
    /// Construct a receiver bound to a unique pipe. The pipe is opened
    /// lazily on a background thread; call `pipe_name()` to hand the
    /// address to the Electron side.
    pub fn start() -> Result<Self> {
        let pid = std::process::id();
        let pipe_name = format!(r"\\.\pipe\keycap-overlay-{pid}");

        let latest: Arc<Mutex<Option<OverlayFrame>>> = Arc::new(Mutex::new(None));
        let frames_received = Arc::new(AtomicU64::new(0));
        let stop = Arc::new(AtomicBool::new(false));

        let thread_name = pipe_name.clone();
        let thread_latest = Arc::clone(&latest);
        let thread_count = Arc::clone(&frames_received);
        let thread_stop = Arc::clone(&stop);

        let thread = std::thread::Builder::new()
            .name("keycap-overlay-rx".into())
            .spawn(move || {
                if let Err(err) = run_pipe_server(
                    &thread_name,
                    &thread_latest,
                    &thread_count,
                    &thread_stop,
                ) {
                    tracing::warn!(?err, "overlay pipe server exited with error");
                }
            })
            .context("spawn overlay receiver thread")?;

        Ok(Self {
            pipe_name,
            latest,
            frames_received,
            stop,
            thread: Some(thread),
        })
    }

    pub fn pipe_name(&self) -> &str {
        &self.pipe_name
    }

    #[allow(dead_code)]
    pub fn frames_received(&self) -> u64 {
        self.frames_received.load(Ordering::Relaxed)
    }

    pub fn latest(&self) -> Arc<Mutex<Option<OverlayFrame>>> {
        Arc::clone(&self.latest)
    }
}

impl Drop for OverlayReceiver {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        // The pipe thread may be blocked inside ConnectNamedPipe or
        // ReadFile. Best we can do without platform-specific cancel APIs
        // is give it a beat; it will notice `stop` on the next loop.
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
    }
}

#[cfg(windows)]
fn run_pipe_server(
    pipe_name: &str,
    latest: &Arc<Mutex<Option<OverlayFrame>>>,
    counter: &Arc<AtomicU64>,
    stop: &Arc<AtomicBool>,
) -> Result<()> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStrExt;

    let wide: Vec<u16> = OsString::from(pipe_name)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    while !stop.load(Ordering::Relaxed) {
        let pipe = unsafe {
            CreateNamedPipeW(
                PCWSTR(wide.as_ptr()),
                PIPE_ACCESS_DUPLEX,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                1,
                0,
                MAX_FRAME_BYTES as u32,
                0,
                None,
            )
        };
        if pipe == INVALID_HANDLE_VALUE {
            return Err(anyhow!("CreateNamedPipeW failed"));
        }

        // ConnectNamedPipe with FILE_FLAG_OVERLAPPED would need an OVERLAPPED
        // + event; for simplicity use blocking mode here and rely on Drop
        // dropping the handle to unblock. The stop check at the top of the
        // loop handles the common-case clean shutdown.
        let connected = unsafe { ConnectNamedPipe(pipe, None) };
        if let Err(err) = connected {
            // ERROR_PIPE_CONNECTED (535) means a client raced in before we
            // called ConnectNamedPipe; treat as success.
            if err.code().0 as u32 != 535 {
                tracing::warn!(error = %err, "ConnectNamedPipe failed");
                unsafe {
                    let _ = CloseHandle(pipe);
                }
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                continue;
            }
        }

        tracing::info!(pipe_name = %pipe_name, "overlay client connected");
        let result = read_frames(pipe, latest, counter, stop);
        if let Err(err) = result {
            tracing::info!(?err, "overlay client disconnected");
        }

        unsafe {
            let _ = DisconnectNamedPipe(pipe);
            let _ = CloseHandle(pipe);
        }
    }
    Ok(())
}

#[cfg(windows)]
fn read_frames(
    pipe: HANDLE,
    latest: &Arc<Mutex<Option<OverlayFrame>>>,
    counter: &Arc<AtomicU64>,
    stop: &Arc<AtomicBool>,
) -> Result<()> {
    let mut header = [0u8; 16];
    let mut scratch: Vec<u8> = Vec::new();
    while !stop.load(Ordering::Relaxed) {
        read_exact(pipe, &mut header)?;
        let magic = u32::from_le_bytes([header[0], header[1], header[2], header[3]]);
        let width = u32::from_le_bytes([header[4], header[5], header[6], header[7]]);
        let height = u32::from_le_bytes([header[8], header[9], header[10], header[11]]);
        let byte_len = u32::from_le_bytes([header[12], header[13], header[14], header[15]])
            as usize;
        if magic != MAGIC {
            return Err(anyhow!(
                "overlay header magic mismatch: got 0x{magic:08x}"
            ));
        }
        let expected = (width as usize)
            .checked_mul(height as usize)
            .and_then(|p| p.checked_mul(4))
            .unwrap_or(0);
        if byte_len != expected || byte_len == 0 || byte_len > MAX_FRAME_BYTES {
            return Err(anyhow!(
                "overlay size mismatch: {width}x{height} byte_len={byte_len} expected={expected}"
            ));
        }
        if scratch.capacity() < byte_len {
            scratch.reserve(byte_len - scratch.capacity());
        }
        scratch.resize(byte_len, 0);
        read_exact(pipe, &mut scratch)?;

        // Take the buffer we just filled and store as the latest frame.
        let data = std::mem::take(&mut scratch);
        // `seq` is the post-increment counter value so 0 is a valid seq
        // (meaning "first frame") and the sentinel for "never seen" on
        // the consumer side can be `Option<u64>::None`.
        let seq = counter.fetch_add(1, Ordering::Relaxed);
        *latest.lock() = Some(OverlayFrame {
            width,
            height,
            data,
            seq,
        });
    }
    Ok(())
}

#[cfg(windows)]
fn read_exact(pipe: HANDLE, buf: &mut [u8]) -> Result<()> {
    let mut read = 0usize;
    while read < buf.len() {
        let mut n = 0u32;
        let slice = &mut buf[read..];
        let ok = unsafe {
            ReadFile(
                pipe,
                Some(slice),
                Some(&mut n as *mut u32),
                None,
            )
        };
        if ok.is_err() || n == 0 {
            return Err(anyhow!("pipe read ended early at {read}/{}", buf.len()));
        }
        read += n as usize;
    }
    Ok(())
}

#[cfg(not(windows))]
fn run_pipe_server(
    _pipe_name: &str,
    _latest: &Arc<Mutex<Option<OverlayFrame>>>,
    _counter: &Arc<AtomicU64>,
    _stop: &Arc<AtomicBool>,
) -> Result<()> {
    // Stub for non-Windows builds.
    Ok(())
}

/// In-place alpha-blend `overlay` (BGRA, straight alpha) onto `dst` (BGRA).
/// Both must be the same width/height. Straight alpha:
///     dst_rgb = dst_rgb * (1 - a) + overlay_rgb * a
/// This is the simple 8-bit form; good enough for overlay-on-video.
pub fn composite(dst: &mut [u8], overlay: &[u8], width: u32, _height: u32) {
    debug_assert_eq!(dst.len(), overlay.len());
    use rayon::prelude::*;
    let row = (width as usize) * 4;
    // Row-parallel so 4K 60fps fits in the per-frame budget.
    dst.par_chunks_mut(row)
        .zip(overlay.par_chunks(row))
        .for_each(|(dst_row, ov_row)| {
            let mut i = 0;
            while i + 4 <= dst_row.len() {
                blend_pixel(&mut dst_row[i..i + 4], &ov_row[i..i + 4]);
                i += 4;
            }
        });
}

/// Nearest-neighbor resize of a tight-packed BGRA image. Used to adapt
/// DDA's native-resolution frames to the user-requested output size
/// before compositing and piping to ffmpeg. Downscaling at the Rust side
/// halves the stdin bandwidth when the user picks a smaller output
/// resolution than their display — typically the difference between
/// hitting 60 fps and not at 4K capture → 1080p output.
pub fn resize_bgra_nn(
    src: &[u8],
    src_w: u32,
    src_h: u32,
    dst: &mut [u8],
    dst_w: u32,
    dst_h: u32,
) {
    if src_w == 0 || src_h == 0 || dst_w == 0 || dst_h == 0 {
        return;
    }
    let dst_w_us = dst_w as usize;
    let dst_h_us = dst_h as usize;
    let src_w_us = src_w as usize;
    let step_x = ((src_w as u64) << 16) / (dst_w as u64);
    let step_y = ((src_h as u64) << 16) / (dst_h as u64);
    let dst_row_bytes = dst_w_us * 4;

    use rayon::prelude::*;
    dst.par_chunks_mut(dst_row_bytes)
        .enumerate()
        .take(dst_h_us)
        .for_each(|(y, row)| {
            let sy = (y as u64) * step_y;
            let src_y = (sy >> 16) as usize;
            let src_row_off = src_y * src_w_us * 4;
            let mut sx: u64 = 0;
            let mut di = 0;
            for _ in 0..dst_w_us {
                let src_x = (sx >> 16) as usize;
                let si = src_row_off + src_x * 4;
                row[di..di + 4].copy_from_slice(&src[si..si + 4]);
                sx += step_x;
                di += 4;
            }
        });
}

/// Nearest-neighbor upscale + alpha-blend when the overlay doesn't match
/// the captured frame size. Happens when Electron's offscreen
/// `BrowserWindow` gets clamped to the monitor work area (e.g. 1920×1032
/// on a scaled 4K display) while we're capturing at the native 3840×2160.
/// Quality is fine for UI overlays — the keystroke chips are already
/// pixel-art-ish, and the alternative is either stretched JS canvas math
/// in the main process or an Electron-side DPI workaround.
#[allow(dead_code)] // kept as a general helper; session.rs now uses a
// cached resize_bgra_nn + composite combo instead.
pub fn composite_scaled(
    dst: &mut [u8],
    dst_w: u32,
    dst_h: u32,
    overlay: &[u8],
    ov_w: u32,
    ov_h: u32,
) {
    if ov_w == 0 || ov_h == 0 || dst_w == 0 || dst_h == 0 {
        return;
    }
    let dst_w = dst_w as usize;
    let dst_h = dst_h as usize;
    let ov_w = ov_w as usize;
    let ov_h = ov_h as usize;
    // Integer step in 16.16 fixed point; avoids per-pixel floating point.
    let step_x = ((ov_w as u64) << 16) / (dst_w as u64);
    let step_y = ((ov_h as u64) << 16) / (dst_h as u64);
    let dst_row_bytes = dst_w * 4;

    // Parallelize across rows. At 4K (2160 rows) this is a 6–10× speedup
    // on typical 8+-core desktops and the difference between hitting the
    // 16.67 ms budget at 60 fps vs. not.
    use rayon::prelude::*;
    dst.par_chunks_mut(dst_row_bytes)
        .enumerate()
        .take(dst_h)
        .for_each(|(y, dst_row)| {
            let sy = (y as u64) * step_y;
            let src_y = (sy >> 16) as usize;
            let src_row_off = src_y * ov_w * 4;
            let mut sx: u64 = 0;
            let mut di = 0;
            for _ in 0..dst_w {
                let src_x = (sx >> 16) as usize;
                let si = src_row_off + src_x * 4;
                blend_pixel(&mut dst_row[di..di + 4], &overlay[si..si + 4]);
                sx += step_x;
                di += 4;
            }
        });
}

#[inline(always)]
fn blend_pixel(dst: &mut [u8], overlay: &[u8]) {
    let a = overlay[3] as u32;
    if a == 0 {
        return;
    }
    if a == 255 {
        dst[0] = overlay[0];
        dst[1] = overlay[1];
        dst[2] = overlay[2];
        return;
    }
    let inv = 255 - a;
    // Fast /255: (x + (x>>8) + 128) >> 8  is exact for 0..65535, ~3× faster
    // than integer divide. We never exceed 255*255 + 255*255 + 127 < 65535.
    #[inline(always)]
    fn div255(x: u32) -> u32 {
        let t = x + 128;
        (t + (t >> 8)) >> 8
    }
    dst[0] = div255((dst[0] as u32) * inv + (overlay[0] as u32) * a) as u8;
    dst[1] = div255((dst[1] as u32) * inv + (overlay[1] as u32) * a) as u8;
    dst[2] = div255((dst[2] as u32) * inv + (overlay[2] as u32) * a) as u8;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn composite_noop_when_overlay_fully_transparent() {
        let mut dst = vec![10u8, 20, 30, 255, 40, 50, 60, 255];
        let overlay = vec![0u8; 8];
        composite(&mut dst, &overlay, 2, 1);
        assert_eq!(dst, vec![10, 20, 30, 255, 40, 50, 60, 255]);
    }

    #[test]
    fn composite_overwrites_when_fully_opaque() {
        let mut dst = vec![10u8, 20, 30, 255];
        let overlay = vec![100u8, 110, 120, 255];
        composite(&mut dst, &overlay, 1, 1);
        assert_eq!(&dst[..3], &[100, 110, 120]);
    }

    #[test]
    fn composite_half_alpha_midpoint() {
        let mut dst = vec![0u8, 0, 0, 255];
        let overlay = vec![200u8, 200, 200, 128];
        composite(&mut dst, &overlay, 1, 1);
        // (0 * 127 + 200 * 128 + 127) / 255 = 100
        assert!(dst[0] >= 99 && dst[0] <= 101);
    }
}
