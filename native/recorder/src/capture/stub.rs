//! Non-Windows stub. Lets `cargo check` pass on macOS/Linux before
//! Milestone 4 adds real implementations there.

use std::sync::Arc;

use anyhow::{anyhow, Result};

use super::frame::Frame;
use super::{DisplayInfo, GpuTexturePool};

pub struct CaptureHandle;
pub struct CapturePrepared;

impl CapturePrepared {
    pub fn dimensions(&self) -> (u32, u32) {
        (0, 0)
    }
}

impl CaptureHandle {
    pub fn stop(self) {}
}

pub fn enumerate_displays() -> Result<Vec<DisplayInfo>> {
    Ok(Vec::new())
}

pub fn prepare_capture(_display_id: &str) -> Result<CapturePrepared> {
    Err(anyhow!(
        "native capture is not yet implemented on this platform"
    ))
}

pub fn start_capture_loop(
    _prepared: CapturePrepared,
    _fps: u32,
    _gpu_emit_active: std::sync::Arc<std::sync::atomic::AtomicBool>,
    _capture_pool: Option<std::sync::Arc<()>>,
    _on_frame: Box<dyn FnMut(Frame) + Send + 'static>,
) -> Result<CaptureHandle> {
    Err(anyhow!(
        "native capture is not yet implemented on this platform"
    ))
}
