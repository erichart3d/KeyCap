//! Screen capture abstraction.
//!
//! The sidecar only needs two operations: enumerate displays, and start
//! a session that streams BGRA frames into a callback. Platform-specific
//! implementations live in sibling modules.

use serde::Serialize;

pub mod frame;

#[cfg(windows)]
mod win;
#[cfg(windows)]
mod win_dda;
#[cfg(windows)]
pub use win::{enumerate_displays, start_capture, CaptureHandle};

#[cfg(not(windows))]
mod stub;
#[cfg(not(windows))]
pub use stub::{enumerate_displays, start_capture, CaptureHandle};

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
