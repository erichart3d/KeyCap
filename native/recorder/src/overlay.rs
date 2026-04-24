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
        *latest.lock() = Some(OverlayFrame {
            width,
            height,
            data,
        });
        counter.fetch_add(1, Ordering::Relaxed);
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

/// In-place alpha-blend `overlay` (BGRA, premultiplied or straight) onto
/// `dst` (BGRA). Both must be the same width/height. Straight alpha:
///     dst_rgb = dst_rgb * (1 - a) + overlay_rgb * a
/// This is the simple 8-bit form; good enough for overlay-on-video.
pub fn composite(dst: &mut [u8], overlay: &[u8], _width: u32, _height: u32) {
    debug_assert_eq!(dst.len(), overlay.len());
    let mut i = 0;
    let n = dst.len();
    while i + 4 <= n {
        let a = overlay[i + 3] as u32;
        if a == 0 {
            // Fully transparent — skip (common case when overlay is
            // mostly empty).
            i += 4;
            continue;
        }
        if a == 255 {
            dst[i] = overlay[i];
            dst[i + 1] = overlay[i + 1];
            dst[i + 2] = overlay[i + 2];
            i += 4;
            continue;
        }
        let inv = 255 - a;
        // Round-to-nearest blend: (dst*inv + overlay*a + 127) / 255
        dst[i] = (((dst[i] as u32) * inv + (overlay[i] as u32) * a + 127) / 255) as u8;
        dst[i + 1] =
            (((dst[i + 1] as u32) * inv + (overlay[i + 1] as u32) * a + 127) / 255) as u8;
        dst[i + 2] =
            (((dst[i + 2] as u32) * inv + (overlay[i + 2] as u32) * a + 127) / 255) as u8;
        i += 4;
    }
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
