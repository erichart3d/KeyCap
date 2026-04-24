//! Windows Graphics Capture implementation.
//!
//! Uses the `windows-capture` crate to open a per-monitor capture session
//! and deliver BGRA frames to a user callback. Frames arrive on the WGC
//! dispatcher thread, so the callback must be `Send`.

use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context as _, Result};
use parking_lot::Mutex;
use windows_capture::{
    capture::{CaptureControl, Context, GraphicsCaptureApiHandler},
    frame::Frame as WcFrame,
    graphics_capture_api::InternalCaptureControl,
    monitor::Monitor,
    settings::{
        ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
        MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
    },
};

use windows::Win32::Graphics::Direct3D11::ID3D11Device;

use super::frame::{BufferPool, Frame};
use super::win_dda::{start_dda_capture, DdaHandle};
use super::DisplayInfo;

enum Backend {
    Wgc(Option<CaptureControl<WcHandler, anyhow::Error>>),
    Dda(Option<DdaHandle>),
}

pub struct CaptureHandle(Backend);

impl CaptureHandle {
    pub fn stop(mut self) {
        self.stop_inner();
    }

    fn stop_inner(&mut self) {
        match &mut self.0 {
            Backend::Wgc(c) => {
                if let Some(control) = c.take() {
                    let _ = control.stop();
                }
            }
            Backend::Dda(h) => {
                if let Some(handle) = h.take() {
                    handle.stop();
                }
            }
        }
    }

    /// Borrow the D3D11 device the capture backend is using, if any.
    /// Only the DDA backend exposes a device — the WGC backend owns its
    /// own device inside the `windows-capture` crate and isn't shareable
    /// without an IDXGIKeyedMutex bridge we don't need. The GPU compositor
    /// path is DDA-only for Bite 1; WGC stays on the CPU composite path.
    #[allow(dead_code)] // consumed by composite-thread GPU branch landing in a later bite step
    pub fn device(&self) -> Option<&ID3D11Device> {
        match &self.0 {
            Backend::Wgc(_) => None,
            Backend::Dda(Some(handle)) => Some(handle.device()),
            Backend::Dda(None) => None,
        }
    }
}

impl Drop for CaptureHandle {
    fn drop(&mut self) {
        self.stop_inner();
    }
}

pub fn enumerate_displays() -> Result<Vec<DisplayInfo>> {
    let monitors = Monitor::enumerate().context("enumerate monitors")?;
    let primary_name = Monitor::primary()
        .ok()
        .and_then(|m| m.device_name().ok());
    let geometries = monitor_geometries_by_device_name();

    let mut out = Vec::with_capacity(monitors.len());
    for monitor in monitors {
        let device_name = match monitor.device_name() {
            Ok(name) => name,
            Err(err) => {
                tracing::warn!(?err, "skipping monitor: no device name");
                continue;
            }
        };
        let friendly = monitor
            .name()
            .ok()
            .or_else(|| monitor.device_string().ok())
            .unwrap_or_else(|| device_name.clone());
        let index = monitor.index().map(|i| i as u32).unwrap_or(0);
        let width = monitor.width().unwrap_or(0);
        let height = monitor.height().unwrap_or(0);
        let is_primary = primary_name
            .as_deref()
            .map(|p| p == device_name)
            .unwrap_or(false);
        let (x, y) = geometries
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case(&device_name))
            .map(|(_, (x, y, _, _))| (*x, *y))
            .unwrap_or((0, 0));
        out.push(DisplayInfo {
            id: device_name.clone(),
            kind: "display",
            name: friendly,
            displayIndex: index,
            isPrimaryDisplay: is_primary,
            x,
            y,
            width,
            height,
            scaleFactor: 1.0,
        });
    }
    Ok(out)
}

/// Start capturing the given display. DDA is the default backend — it
/// works on HDR OLED ultrawides where WGC stalls. Set
/// `KEYCAP_CAPTURE_BACKEND=wgc` to force the WGC path (useful for
/// debugging or for monitors where DDA is unavailable).
///
/// `want_gpu_emit` requests that the backend (when capable — only DDA
/// today) emit `FramePayload::Gpu` frames instead of CPU BGRA. WGC
/// ignores this flag; if the composite thread wanted GPU mode, the
/// session is expected to have forced the backend to DDA or to have
/// fallen back to CPU composite mode via the probe.
pub fn start_capture(
    display_id: &str,
    fps: u32,
    want_gpu_emit: bool,
    on_frame: Box<dyn FnMut(Frame) + Send + 'static>,
) -> Result<CaptureHandle> {
    let backend = std::env::var("KEYCAP_CAPTURE_BACKEND")
        .unwrap_or_else(|_| "dda".into())
        .to_lowercase();

    match backend.as_str() {
        "wgc" => {
            tracing::info!("capture backend: WGC (forced via env)");
            if want_gpu_emit {
                tracing::warn!(
                    "GPU composite requested but WGC backend doesn't emit GPU frames; \
                     composite thread will get CPU frames even in GPU mode"
                );
            }
            start_wgc(display_id, fps, on_frame)
        }
        "dda" | "" => {
            tracing::info!("capture backend: DDA");
            match start_dda_capture(display_id, fps, want_gpu_emit, on_frame) {
                Ok(h) => Ok(CaptureHandle(Backend::Dda(Some(h)))),
                Err(err) => Err(anyhow!("start DDA capture: {err}")),
            }
        }
        other => Err(anyhow!(
            "unknown KEYCAP_CAPTURE_BACKEND={other} (expected 'dda' or 'wgc')"
        )),
    }
}

fn start_wgc(
    display_id: &str,
    fps: u32,
    on_frame: Box<dyn FnMut(Frame) + Send + 'static>,
) -> Result<CaptureHandle> {
    let monitor = Monitor::enumerate()
        .context("enumerate monitors")?
        .into_iter()
        .find(|m| m.device_name().map(|n| n == display_id).unwrap_or(false))
        .ok_or_else(|| anyhow!("display {display_id} is not available"))?;

    let flags = HandlerFlags {
        on_frame: Arc::new(Mutex::new(on_frame)),
        pool: BufferPool::new(4),
        target_fps: fps.max(1),
        last_emit: Arc::new(Mutex::new(None)),
    };

    // Ask WGC to emit a frame every 1/fps seconds regardless of whether
    // the compositor presented. Without this the default WGC behavior is
    // "one frame per present," which on an otherwise idle desktop can drop
    // to ~1 Hz — catastrophic for a screen recorder.
    let min_interval = Duration::from_secs_f64(1.0 / f64::from(fps.max(1)));
    let settings = Settings::new(
        monitor,
        CursorCaptureSettings::WithCursor,
        DrawBorderSettings::WithoutBorder,
        SecondaryWindowSettings::Default,
        MinimumUpdateIntervalSettings::Custom(min_interval),
        DirtyRegionSettings::Default,
        ColorFormat::Bgra8,
        flags,
    );

    let control = WcHandler::start_free_threaded(settings)
        .map_err(|err| anyhow!("start WGC capture: {err}"))?;

    Ok(CaptureHandle(Backend::Wgc(Some(control))))
}

struct HandlerFlags {
    on_frame: Arc<Mutex<Box<dyn FnMut(Frame) + Send + 'static>>>,
    pool: Arc<BufferPool>,
    target_fps: u32,
    last_emit: Arc<Mutex<Option<Instant>>>,
}

struct WcHandler {
    on_frame: Arc<Mutex<Box<dyn FnMut(Frame) + Send + 'static>>>,
    pool: Arc<BufferPool>,
    frame_interval: Duration,
    last_emit: Arc<Mutex<Option<Instant>>>,
}

impl GraphicsCaptureApiHandler for WcHandler {
    type Flags = HandlerFlags;
    type Error = anyhow::Error;

    fn new(ctx: Context<Self::Flags>) -> std::result::Result<Self, Self::Error> {
        let frame_interval = Duration::from_secs_f64(1.0 / f64::from(ctx.flags.target_fps));
        Ok(Self {
            on_frame: ctx.flags.on_frame,
            pool: ctx.flags.pool,
            frame_interval,
            last_emit: ctx.flags.last_emit,
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut WcFrame<'_>,
        _capture_control: InternalCaptureControl,
    ) -> std::result::Result<(), Self::Error> {
        // Wall-clock throttle: WGC delivers one frame per GPU present,
        // which on a gaming rig can be 144 Hz. Down-sample to target fps
        // by time elapsed since last emit.
        {
            let mut guard = self.last_emit.lock();
            let now = Instant::now();
            if let Some(prev) = *guard {
                if now.duration_since(prev) < self.frame_interval {
                    tracing::trace!("wgc frame arrived (throttled)");
                    return Ok(());
                }
            }
            *guard = Some(now);
        }

        let width = frame.width();
        let height = frame.height();
        tracing::debug!(width, height, "wgc frame arrived");
        let mut buffer = match frame.buffer() {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!(error = %e, "frame.buffer() failed");
                return Ok(());
            }
        };
        let needed = (width as usize) * (height as usize) * 4;
        let mut data = self.pool.acquire(needed);
        if buffer.has_padding() {
            // The library writes padding-stripped rows directly into our
            // pool buffer via rayon; it indexes &buf[0..needed] and only
            // grows via resize when capacity < needed, so pre-size first.
            data.resize(needed, 0);
            let _ = buffer.as_nopadding_buffer(&mut data);
        } else {
            // Rows are tight in the GPU mapping already — copy the raw
            // mapped slice into our pool buffer before the D3D11 mapping
            // is torn down when the frame destructor runs.
            let raw: &[u8] = buffer.as_raw_buffer();
            data.extend_from_slice(raw);
        }

        let frame = self.pool.make_frame(width, height, data);
        let mut cb = self.on_frame.lock();
        (cb)(frame);
        Ok(())
    }

    fn on_closed(&mut self) -> std::result::Result<(), Self::Error> {
        Ok(())
    }
}

/// Walk monitors via `EnumDisplayMonitors` and return their device name +
/// desktop rect `(x, y, w, h)` in virtual-screen coordinates. Needed so
/// the always-on-top overlay window in the Electron main process can be
/// positioned over the correct monitor on multi-display setups.
fn monitor_geometries_by_device_name() -> Vec<(String, (i32, i32, u32, u32))> {
    use windows::Win32::Foundation::{BOOL, LPARAM, RECT};
    use windows::Win32::Graphics::Gdi::{
        EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFOEXW,
    };

    unsafe extern "system" fn cb(
        hmon: HMONITOR,
        _hdc: HDC,
        _rect: *mut RECT,
        lparam: LPARAM,
    ) -> BOOL {
        let list = &mut *(lparam.0 as *mut Vec<(String, (i32, i32, u32, u32))>);
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        if GetMonitorInfoW(hmon, &mut info.monitorInfo as *mut _).as_bool() {
            let device = {
                let raw = &info.szDevice;
                let end = raw.iter().position(|c| *c == 0).unwrap_or(raw.len());
                String::from_utf16_lossy(&raw[..end])
            };
            let r = info.monitorInfo.rcMonitor;
            let x = r.left;
            let y = r.top;
            let w = (r.right - r.left).max(0) as u32;
            let h = (r.bottom - r.top).max(0) as u32;
            list.push((device, (x, y, w, h)));
        }
        BOOL(1)
    }

    let mut list: Vec<(String, (i32, i32, u32, u32))> = Vec::new();
    let lparam = LPARAM(&mut list as *mut _ as isize);
    unsafe {
        let _ = EnumDisplayMonitors(None, None, Some(cb), lparam);
    }
    list
}
