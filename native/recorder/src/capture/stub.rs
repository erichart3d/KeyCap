//! Non-Windows stub. Lets `cargo check` pass on macOS/Linux before
//! Milestone 4 adds real implementations there.

use anyhow::{anyhow, Result};

use super::frame::Frame;
use super::DisplayInfo;

pub struct CaptureHandle;

impl CaptureHandle {
    pub fn stop(self) {}
}

pub fn enumerate_displays() -> Result<Vec<DisplayInfo>> {
    Ok(Vec::new())
}

pub fn start_capture(
    _display_id: &str,
    _fps: u32,
    _want_gpu_emit: bool,
    _on_frame: Box<dyn FnMut(Frame) + Send + 'static>,
) -> Result<CaptureHandle> {
    Err(anyhow!(
        "native capture is not yet implemented on this platform"
    ))
}
