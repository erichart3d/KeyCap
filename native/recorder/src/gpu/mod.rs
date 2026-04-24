//! GPU compositor — M3 Bite 1.
//!
//! On the GPU path, the DDA backend keeps captured frames as D3D11 textures
//! and hands them to this module. The compositor blends the overlay onto
//! the capture frame, converts BGRA → NV12 in a single render pass pair,
//! reads back the NV12 bytes, and hands them to the existing writer thread
//! exactly as the CPU path does. No change to ffmpeg, the encoder fallback
//! chain, the overlay pipe protocol, or the writer thread.
//!
//! The Compositor itself (shaders, RTVs, sampler state) lives in
//! sub-modules. This module exposes only:
//!
//! - `CompositeMode` — CPU vs GPU, decided once per session at start;
//! - `resolve_mode(...)` — honor `KEYCAP_RECORDER_COMPOSITE` env override,
//!   else probe the device, else fall back to CPU;
//! - `probe(...)` — checks feature level, NV12 RT support, BGRA RT support.
//!
//! Bite 1 keeps the CPU path as a runtime fallback behind the probe, so
//! any machine where the GPU path fails to initialize still records the
//! same way it does today (just slower, bounded by `convert::bgra_to_nv12`).

#![cfg(windows)]

pub mod bgra_upload;
pub mod compositor;
pub mod shaders;

pub use bgra_upload::BgraUploader;
pub use compositor::Compositor;

use std::fmt;

use anyhow::{anyhow, Context as _, Result};
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_11_0};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
    D3D11_FORMAT_SUPPORT_RENDER_TARGET, D3D11_FORMAT_SUPPORT_TEXTURE2D, D3D11_SDK_VERSION,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_NV12};

/// Which composite path a session is running.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompositeMode {
    /// Legacy path: CPU alpha-blend + Rayon BGRA→NV12 in `convert.rs`.
    Cpu,
    /// M3-Bite1 path: D3D11 shader composite + GPU NV12 conversion.
    Gpu,
}

impl CompositeMode {
    pub fn label(self) -> &'static str {
        match self {
            CompositeMode::Cpu => "cpu",
            CompositeMode::Gpu => "gpu",
        }
    }
}

impl fmt::Display for CompositeMode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.label())
    }
}

/// Feature-flag capabilities probed on the session device. Any `false`
/// field forces a fall-back to `CompositeMode::Cpu`.
#[derive(Debug, Clone, Copy)]
pub struct GpuSupport {
    pub feature_level_11_0: bool,
    /// NV12 supports `Texture2D` + `RenderTarget` on this driver. Common
    /// failure case: pre-GCN AMD, some old Intel iGPUs, and WARP under
    /// older SDKs. When this is false, the GPU compositor would have to
    /// render to BGRA and run a separate BGRA→NV12 compute pass — we
    /// defer that alternative to a later bite and fall back to CPU here.
    pub nv12_render_target: bool,
    /// BGRA RT + SRV support for the intermediate composite target. In
    /// practice this is always true when `D3D11_CREATE_DEVICE_BGRA_SUPPORT`
    /// was set at device creation (which DDA does today), so this is
    /// belt-and-suspenders.
    pub bgra_render_target: bool,
}

impl GpuSupport {
    pub fn is_sufficient(&self) -> bool {
        self.feature_level_11_0 && self.nv12_render_target && self.bgra_render_target
    }
}

/// Probe what this D3D11 device can actually do for the GPU composite path.
///
/// `feature_level_11_0` is assumed here because `D3D11CreateDevice` in the
/// DDA backend requests `D3D_FEATURE_LEVEL_11_0` explicitly (see
/// `win_dda.rs`), so if we got a device back at all, this is true. We still
/// set the field for symmetry — future hardware probes may demand 11.1.
pub fn probe(device: &ID3D11Device) -> GpuSupport {
    let mask = (D3D11_FORMAT_SUPPORT_TEXTURE2D.0 | D3D11_FORMAT_SUPPORT_RENDER_TARGET.0) as u32;
    let nv12_render_target = format_supports(device, DXGI_FORMAT_NV12, mask);
    let bgra_render_target = format_supports(device, DXGI_FORMAT_B8G8R8A8_UNORM, mask);
    GpuSupport {
        feature_level_11_0: true,
        nv12_render_target,
        bgra_render_target,
    }
}

fn format_supports(device: &ID3D11Device, format: windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT, required_mask: u32) -> bool {
    unsafe {
        match device.CheckFormatSupport(format) {
            Ok(flags) => (flags & required_mask) == required_mask,
            Err(_) => false,
        }
    }
}

/// All GPU state owned by the composite thread on the GPU path.
///
/// Creates its own D3D11 device so the composite thread's immediate
/// context is never shared with the DDA capture thread — each device
/// gets its own context, no mutex plumbing required. The composite
/// thread uploads CPU BGRA (captured via DDA's CPU emit path) through
/// `capture_uploader`, optionally blends the overlay BGRA through
/// `overlay_uploader`, then runs `compositor.composite_and_convert` +
/// `compositor.map_nv12` and ships the NV12 `Vec<u8>` to the writer.
pub struct SessionCompositor {
    pub compositor: Compositor,
    pub capture_uploader: BgraUploader,
    pub overlay_uploader: BgraUploader,
    capture_seq: u64,
}

impl SessionCompositor {
    pub fn new(width: u32, height: u32) -> Result<Self> {
        let device = create_composite_device().context("create composite device")?;
        let compositor = Compositor::new(&device, width, height)?;
        let capture_uploader = BgraUploader::new(device.clone())?;
        let overlay_uploader = BgraUploader::new(device)?;
        Ok(Self {
            compositor,
            capture_uploader,
            overlay_uploader,
            capture_seq: 0,
        })
    }

    /// Monotonic seq bumped on every capture upload. Capture BGRA is
    /// fresh per tick so the seq cache never hits — but `BgraUploader`
    /// demands a seq anyway, so we feed it a unique one.
    pub fn next_capture_seq(&mut self) -> u64 {
        self.capture_seq += 1;
        self.capture_seq
    }
}

fn create_composite_device() -> Result<ID3D11Device> {
    let mut device: Option<ID3D11Device> = None;
    let mut feature_level = D3D_FEATURE_LEVEL_11_0;
    let levels = [D3D_FEATURE_LEVEL_11_0];
    unsafe {
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            Some(&levels),
            D3D11_SDK_VERSION,
            Some(&mut device),
            Some(&mut feature_level),
            None,
        )
        .context("D3D11CreateDevice for composite thread")?;
    }
    device.ok_or_else(|| anyhow!("null composite D3D11 device"))
}

/// Create a throwaway D3D11 device and run `probe` on it.
///
/// Bite 1 uses this at session start so the probe outcome is known before
/// the DDA backend spins up. A later bite will thread the real DDA device
/// through here, so the probe runs on the exact device the compositor will
/// use. In practice any two D3D11 devices on the same adapter report the
/// same `CheckFormatSupport` flags — this just catches the common "GPU
/// driver is completely broken for D3D11" case without adding plumbing.
pub fn probe_adapter_default() -> Result<GpuSupport> {
    let mut device: Option<ID3D11Device> = None;
    let mut feature_level = D3D_FEATURE_LEVEL_11_0;
    let levels = [D3D_FEATURE_LEVEL_11_0];
    unsafe {
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            Some(&levels),
            D3D11_SDK_VERSION,
            Some(&mut device),
            Some(&mut feature_level),
            None,
        )
        .context("D3D11CreateDevice for GPU composite probe")?;
    }
    let device = device.ok_or_else(|| anyhow!("null D3D11 probe device"))?;
    Ok(probe(&device))
}

/// Decide the composite mode for a session.
///
/// Resolution order:
/// 1. `KEYCAP_RECORDER_COMPOSITE=cpu` — always CPU (for debugging / A/B).
/// 2. `KEYCAP_RECORDER_COMPOSITE=gpu` — demand GPU; if the probe fails,
///    log loudly and still fall back to CPU (we don't brick the recorder
///    over a capability mismatch, but the user asked for GPU so they get
///    a warning).
/// 3. Unset / any other value — auto: GPU if the probe passes, else CPU.
pub fn resolve_mode(support: GpuSupport) -> CompositeMode {
    let env = std::env::var("KEYCAP_RECORDER_COMPOSITE")
        .ok()
        .map(|s| s.to_ascii_lowercase());
    match env.as_deref() {
        Some("cpu") => {
            tracing::info!(
                composite_mode = "cpu",
                reason = "KEYCAP_RECORDER_COMPOSITE=cpu",
                "composite mode forced to CPU by env override"
            );
            CompositeMode::Cpu
        }
        Some("gpu") => {
            if support.is_sufficient() {
                tracing::info!(
                    composite_mode = "gpu",
                    reason = "KEYCAP_RECORDER_COMPOSITE=gpu",
                    "composite mode forced to GPU by env override"
                );
                CompositeMode::Gpu
            } else {
                tracing::warn!(
                    composite_mode = "cpu",
                    reason = "gpu probe failed despite KEYCAP_RECORDER_COMPOSITE=gpu",
                    ?support,
                    "falling back to CPU composite"
                );
                CompositeMode::Cpu
            }
        }
        _ => {
            if support.is_sufficient() {
                tracing::info!(
                    composite_mode = "gpu",
                    ?support,
                    "composite mode: GPU (probe passed)"
                );
                CompositeMode::Gpu
            } else {
                tracing::info!(
                    composite_mode = "cpu",
                    ?support,
                    "composite mode: CPU (GPU probe insufficient)"
                );
                CompositeMode::Cpu
            }
        }
    }
}
