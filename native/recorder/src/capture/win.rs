//! Windows Graphics Capture implementation.
//!
//! Public surface is two-phase to match the GPU compositor's needs:
//!
//! 1. `prepare_capture(display_id)` — sync, on the caller thread. Picks
//!    the backend (DDA by default; WGC if `KEYCAP_CAPTURE_BACKEND=wgc`)
//!    and builds whatever state can be built without spinning a capture
//!    loop. For DDA that includes the D3D11 device, the immediate context
//!    `Arc<Mutex<...>>`, and the duplication state — those are needed by
//!    the composite thread before it can construct a `SessionCompositor`
//!    on the same device, allocate the GPU texture pool on it, and pass
//!    that pool back here.
//! 2. `start_capture_loop(prepared, fps, want_gpu_emit, capture_pool,
//!    on_frame)` — spawns the capture thread (DDA) or the WGC handler
//!    (WGC) and starts pumping frames to the callback.
//!
//! WGC doesn't share its device so it never participates in the GPU
//! composite path; if the session resolves to GPU mode, it's expected to
//! have run on the DDA backend.

use std::sync::atomic::AtomicBool;
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

use windows::Win32::Graphics::Direct3D11::{ID3D11Device, ID3D11DeviceContext};

use super::frame::{BufferPool, Frame};
use super::gpu_pool::GpuTexturePool;
use super::win_dda::{prepare_dda_capture, start_dda_loop, DdaHandle, DdaPrepared};
use super::DisplayInfo;

/// Caller-thread output of `prepare_capture`. Owns whatever state needs
/// to exist before the capture loop spins; in particular for DDA it owns
/// the shared D3D11 device + context that the composite thread builds its
/// `SessionCompositor` on.
pub enum CapturePrepared {
    Wgc(WgcPrepared),
    Dda(DdaPrepared),
}

/// WGC's prepare phase is just bookkeeping — there's no shared device to
/// hand back to the compositor (the `windows-capture` crate owns its
/// device internally and there is no public accessor). Stored as the
/// monitor + display id so `start_capture_loop` can build the WGC
/// `Settings` without re-enumerating monitors.
pub struct WgcPrepared {
    monitor: Monitor,
}

impl CapturePrepared {
    /// The shared D3D11 device, when the backend has one to share. Only
    /// DDA exposes a device today; WGC always returns `None`.
    pub fn device(&self) -> Option<&ID3D11Device> {
        match self {
            CapturePrepared::Wgc(_) => None,
            CapturePrepared::Dda(p) => Some(&p.device),
        }
    }

    /// Clone the shared immediate-context `Arc`, when the backend has
    /// one. Same DDA-only rule as `device()`.
    pub fn context(&self) -> Option<Arc<Mutex<ID3D11DeviceContext>>> {
        match self {
            CapturePrepared::Wgc(_) => None,
            CapturePrepared::Dda(p) => Some(Arc::clone(&p.context)),
        }
    }

    /// Native capture dimensions reported by the backend. For DDA this
    /// is the desktop coordinates of the duplicated output; for WGC it's
    /// the monitor's reported width/height.
    pub fn dimensions(&self) -> (u32, u32) {
        match self {
            CapturePrepared::Wgc(p) => (
                p.monitor.width().unwrap_or(0),
                p.monitor.height().unwrap_or(0),
            ),
            CapturePrepared::Dda(p) => p.dimensions(),
        }
    }
}

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
    /// without an IDXGIKeyedMutex bridge we don't need.
    #[allow(dead_code)]
    pub fn device(&self) -> Option<&ID3D11Device> {
        match &self.0 {
            Backend::Wgc(_) => None,
            Backend::Dda(Some(handle)) => Some(handle.device()),
            Backend::Dda(None) => None,
        }
    }

    /// Clone the shared immediate-context `Arc` the DDA loop is using.
    /// `None` for WGC; `None` after `stop()` has dropped the handle.
    #[allow(dead_code)]
    pub fn context(&self) -> Option<Arc<Mutex<ID3D11DeviceContext>>> {
        match &self.0 {
            Backend::Wgc(_) => None,
            Backend::Dda(Some(handle)) => Some(handle.context()),
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

/// Phase 1: caller-thread prep. DDA is the default backend — it works on
/// HDR OLED ultrawides where WGC stalls. Set `KEYCAP_CAPTURE_BACKEND=wgc`
/// to force the WGC path (useful for debugging or for monitors where DDA
/// is unavailable).
pub fn prepare_capture(display_id: &str) -> Result<CapturePrepared> {
    let backend = std::env::var("KEYCAP_CAPTURE_BACKEND")
        .unwrap_or_else(|_| "dda".into())
        .to_lowercase();

    match backend.as_str() {
        "wgc" => {
            tracing::info!("capture backend: WGC (forced via env)");
            let monitor = Monitor::enumerate()
                .context("enumerate monitors")?
                .into_iter()
                .find(|m| m.device_name().map(|n| n == display_id).unwrap_or(false))
                .ok_or_else(|| anyhow!("display {display_id} is not available"))?;
            Ok(CapturePrepared::Wgc(WgcPrepared { monitor }))
        }
        "dda" | "" => {
            tracing::info!("capture backend: DDA");
            let prepared = prepare_dda_capture(display_id)
                .context("prepare DDA capture")?;
            Ok(CapturePrepared::Dda(prepared))
        }
        other => Err(anyhow!(
            "unknown KEYCAP_CAPTURE_BACKEND={other} (expected 'dda' or 'wgc')"
        )),
    }
}

/// Phase 2: spawn the capture loop. `want_gpu_emit` requests that the
/// backend emit `FramePayload::Gpu` when capable. WGC ignores it; DDA
/// uses it together with `capture_pool` (which must be `Some` if
/// `want_gpu_emit` is true) to drive the pooled-texture emit path.
pub fn start_capture_loop(
    prepared: CapturePrepared,
    fps: u32,
    gpu_emit_active: Arc<AtomicBool>,
    capture_pool: Option<Arc<GpuTexturePool>>,
    on_frame: Box<dyn FnMut(Frame) + Send + 'static>,
) -> Result<CaptureHandle> {
    match prepared {
        CapturePrepared::Wgc(prep) => {
            if gpu_emit_active.load(std::sync::atomic::Ordering::Relaxed) {
                tracing::warn!(
                    "GPU composite requested but WGC backend doesn't emit GPU frames; \
                     composite thread will get CPU frames even in GPU mode"
                );
            }
            start_wgc(prep, fps, on_frame)
        }
        CapturePrepared::Dda(prep) => {
            let h = start_dda_loop(prep, fps, gpu_emit_active, capture_pool, on_frame)
                .context("start DDA capture loop")?;
            Ok(CaptureHandle(Backend::Dda(Some(h))))
        }
    }
}

fn start_wgc(
    prep: WgcPrepared,
    fps: u32,
    on_frame: Box<dyn FnMut(Frame) + Send + 'static>,
) -> Result<CaptureHandle> {
    let WgcPrepared { monitor } = prep;

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
