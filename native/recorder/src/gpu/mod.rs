//! GPU compositor — M3 Bite 1 + Bite 1.5.
//!
//! On the GPU path, the DDA backend keeps captured frames as D3D11 textures
//! and hands them to this module. The compositor blends the overlay onto
//! the capture frame, converts BGRA → NV12 in a single render pass pair,
//! reads back the NV12 bytes, and hands them to the existing writer thread
//! exactly as the CPU path does. No change to ffmpeg, the encoder fallback
//! chain, the overlay pipe protocol, or the writer thread.
//!
//! Bite 1.5 binds the compositor to the **same** D3D11 device and immediate
//! context the DDA capture loop is using. The two threads share the
//! immediate context via `Arc<Mutex<ID3D11DeviceContext>>` and coordinate
//! readback through an `ID3D11Fence` so each thread's lock-hold time is
//! bounded to its own command-record window. There is no second device,
//! no IDXGIKeyedMutex bridge, no cross-adapter copy.
//!
//! The Compositor itself (shaders, RTVs, sampler state) lives in
//! sub-modules. This module exposes only:
//!
//! - `CompositeMode` — CPU vs GPU, decided once per session at start;
//! - `resolve_mode(...)` — honor `KEYCAP_RECORDER_COMPOSITE` env override,
//!   else probe the device, else fall back to CPU;
//! - `probe(...)` — checks feature level, NV12 RT support, BGRA RT support;
//! - `SessionCompositor::new(device, context, w, h)` — composite-thread
//!   state built on the shared DDA device.

#![cfg(windows)]

pub mod bgra_upload;
pub mod compositor;
pub mod nv12_ring;
pub mod shaders;

pub use bgra_upload::BgraUploader;
pub use compositor::Compositor;
#[allow(unused_imports)] // wired in by the MF encoder backend in a later bite step
pub use nv12_ring::{Nv12Ring, Nv12Slot};

use std::fmt;
use std::sync::Arc;

use anyhow::{anyhow, Context as _, Result};
use parking_lot::Mutex;
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_11_0};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
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
/// In Bite 1.5 the DDA capture device IS this device — there is no
/// second device. The compositor and the DDA capture loop share an
/// `Arc<Mutex<ID3D11DeviceContext>>`. The DDA thread holds the lock
/// only long enough to enqueue a `CopyResource` (~tens of µs); the
/// composite thread holds it across submit + Flush (also short), then
/// drops the lock and polls `Map(D3D11_MAP_FLAG_DO_NOT_WAIT)` on the
/// stagings with brief lock re-acquires per poll — bounded by a per-
/// call timeout so a wedged GPU turns into a clean error instead of
/// hanging the recorder. See `compositor.rs` for the rationale.
///
/// The compositor uploads the *overlay* BGRA (delivered as `Vec<u8>`
/// over the Electron OSR pipe) through `overlay_uploader`. The capture
/// frame is consumed directly as a `GpuTextureHandle` whose SRV the
/// shader binds — no upload step on the capture side at all.
pub struct SessionCompositor {
    pub compositor: Compositor,
    pub overlay_uploader: BgraUploader,
}

impl SessionCompositor {
    /// Build a composite thread's GPU state on the shared DDA device.
    /// Shader compile + RT creation runs here (~50–150 ms once per
    /// session). Failing here makes the session fall back to the CPU
    /// composite path.
    pub fn new(
        device: ID3D11Device,
        context: Arc<Mutex<ID3D11DeviceContext>>,
        out_width: u32,
        out_height: u32,
    ) -> Result<Self> {
        let compositor = Compositor::new(&device, Arc::clone(&context), out_width, out_height)?;
        let overlay_uploader = BgraUploader::new(device, context)?;
        Ok(Self {
            compositor,
            overlay_uploader,
        })
    }
}

/// Create a throwaway D3D11 device and run `probe` on it.
///
/// The probe runs at session start before DDA has been initialized. In
/// practice any two D3D11 devices on the same adapter report the same
/// `CheckFormatSupport` flags, so this catches the common "GPU driver
/// is broken" case without needing the DDA device early. The actual
/// compositor will use the DDA device, not this throwaway.
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
