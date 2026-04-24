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

use super::frame::{BufferPool, Frame};
use super::DisplayInfo;

pub struct CaptureHandle {
    control: Option<CaptureControl<WcHandler, anyhow::Error>>,
}

impl CaptureHandle {
    pub fn stop(mut self) {
        if let Some(control) = self.control.take() {
            let _ = control.stop();
        }
    }
}

impl Drop for CaptureHandle {
    fn drop(&mut self) {
        if let Some(control) = self.control.take() {
            let _ = control.stop();
        }
    }
}

pub fn enumerate_displays() -> Result<Vec<DisplayInfo>> {
    let monitors = Monitor::enumerate().context("enumerate monitors")?;
    let primary_name = Monitor::primary()
        .ok()
        .and_then(|m| m.device_name().ok());

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
        out.push(DisplayInfo {
            id: device_name.clone(),
            kind: "display",
            name: friendly,
            displayIndex: index,
            isPrimaryDisplay: is_primary,
            x: 0,
            y: 0,
            width,
            height,
            scaleFactor: 1.0,
        });
    }
    Ok(out)
}

/// Start capturing the given display. Frames are forwarded via `on_frame`
/// at best effort.
pub fn start_capture(
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

    Ok(CaptureHandle {
        control: Some(control),
    })
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
