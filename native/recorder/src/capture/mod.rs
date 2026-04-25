//! Screen capture abstraction.
//!
//! The sidecar only needs two operations: enumerate displays, and start
//! a session that streams BGRA frames into a callback. Platform-specific
//! implementations live in sibling modules.

use serde::Serialize;

pub mod frame;

#[cfg(windows)]
pub mod gpu_pool;
#[cfg(windows)]
pub use gpu_pool::GpuTexturePool;

/// Stub on non-Windows platforms so `Option<Arc<GpuTexturePool>>` types
/// resolve in shared code (e.g. `session.rs`). The actual GPU emit path
/// is Windows-only; passing `Some(pool)` to `start_capture_loop` here
/// would be rejected by the stub backend regardless.
#[cfg(not(windows))]
pub struct GpuTexturePool;

#[cfg(windows)]
mod win;
#[cfg(windows)]
mod win_dda;
#[cfg(windows)]
pub use win::{enumerate_displays, prepare_capture, start_capture_loop, CaptureHandle};
#[allow(unused_imports)]
pub use win::CapturePrepared;

#[cfg(not(windows))]
mod stub;
#[cfg(not(windows))]
pub use stub::{enumerate_displays, prepare_capture, start_capture_loop, CaptureHandle, CapturePrepared};

#[allow(non_snake_case)]
#[derive(Debug, Serialize, Clone)]
pub struct DisplayInfo {
    pub id: String,
    pub kind: &'static str,
    pub name: String,
    pub displayIndex: u32,
    pub isPrimaryDisplay: bool,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scaleFactor: f64,
}
