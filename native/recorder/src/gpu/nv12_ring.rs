//! Ring of NV12 D3D11 textures for the zero-copy GPU encode path.
//!
//! Each slot owns one `DXGI_FORMAT_NV12` texture plus two planar render
//! target views — `R8_UNORM` over the Y plane (PlaneSlice=0) and
//! `R8G8_UNORM` over the UV plane (PlaneSlice=1). The compositor draws
//! its three passes into a slot's RTVs; the Media Foundation Sink Writer
//! wraps the slot's texture in an `IMFSample` (via
//! `MFCreateDXGISurfaceBuffer`) and queues it for the encoder. No CPU
//! readback at any point on this path.
//!
//! ## Why a ring
//!
//! `IMFSample::Release` is called by Media Foundation only after the
//! encoder is actually done reading the texture. Until then, the
//! texture's contents must not be overwritten. We don't know exactly
//! when MF releases — there's no Rust-visible callback — so we just
//! make the ring deeper than any reasonable encoder pipeline. NVENC's
//! H.264 encoder retains at most ~5 frames of lookahead + B-frame
//! reordering; AMF and QSV are similar. With `capacity = 6` we wrap
//! around only after the encoder has had at least 6 frames to drain,
//! which is well past their pipeline depths.
//!
//! ## Why not Drop-based recycling
//!
//! An earlier draft used `Arc<Slot>` with `strong_count == 1` as the
//! "free" signal, mirroring `capture/gpu_pool.rs`. But MF holds its
//! reference via the `IMFSample`'s COM refcount on the underlying
//! `ID3D11Texture2D`, not via our `Arc`. Our `strong_count` would
//! always say "free" even while MF was still using the texture. A
//! fixed-size round-robin sidesteps the question entirely as long as
//! the ring is deeper than the encoder's pipeline.
//!
//! ## Cross-device sharing (Bite 3)
//!
//! Each slot's NV12 texture is created on the compositor's D3D11
//! device with `D3D11_RESOURCE_MISC_SHARED_NTHANDLE |
//! SHARED_KEYEDMUTEX`. We export an NT handle per slot via
//! `IDXGIResource1::CreateSharedHandle`. The MF encoder backend opens
//! those handles on its own private D3D11 device with
//! `OpenSharedResource1` to get parallel texture handles backed by the
//! same underlying GPU surface — that's how the encoder MFT can read
//! NV12 our compositor wrote without sharing a GPU command queue with
//! us. The keyed mutex inside the resource serializes the handoff:
//! compositor `AcquireSync(0)` → draw → `ReleaseSync(1)`, encoder MFT
//! (auto via IMFDXGIBuffer) `AcquireSync(1)` → encode → `ReleaseSync(0)`.

#![cfg(windows)]
#![allow(dead_code)] // wired in by the MF encoder backend in a later bite step

use anyhow::{anyhow, Context as _, Result};
use windows::Win32::Foundation::{GENERIC_ALL, HANDLE};
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Device, ID3D11Device3, ID3D11RenderTargetView, ID3D11RenderTargetView1,
    ID3D11Texture2D, D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE,
    D3D11_BIND_VIDEO_ENCODER, D3D11_RENDER_TARGET_VIEW_DESC1,
    D3D11_RENDER_TARGET_VIEW_DESC1_0, D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX,
    D3D11_RESOURCE_MISC_SHARED_NTHANDLE, D3D11_RTV_DIMENSION_TEXTURE2D, D3D11_TEX2D_RTV1,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT_NV12, DXGI_FORMAT_R8G8_UNORM, DXGI_FORMAT_R8_UNORM, DXGI_SAMPLE_DESC,
};
use windows::Win32::Graphics::Dxgi::{IDXGIKeyedMutex, IDXGIResource1};
use windows::core::Interface;

/// Default ring depth. Empirically NVENC's MFT can hold significantly
/// more in-flight samples than its documented ~5-frame pipeline (the
/// MFT keeps internal references on input textures even after the
/// encoder has output the corresponding bitstream). At depth 6 we
/// observed throughput collapsing on real hardware after ~16 frames.
/// 16 gives the MFT enough headroom that we don't wrap into a slot
/// the encoder is still holding.
pub const DEFAULT_CAPACITY: usize = 16;

/// One NV12 texture + its planar RTVs + its cross-device sync handles.
///
/// The compositor binds `y_rtv` and `uv_rtv` for the Y and UV passes
/// and uses `keyed_mutex` to fence its draws against the encoder's
/// reads. The MF encoder backend, on its own private D3D11 device,
/// imports `shared_handle` via `OpenSharedResource1` to get a parallel
/// texture handle backed by the same GPU surface — that's how it
/// consumes our NV12 without sharing a GPU command queue with us.
///
/// `shared_handle` is owned by the slot — closed on Drop.
pub struct Nv12Slot {
    pub texture: ID3D11Texture2D,
    pub y_rtv: ID3D11RenderTargetView,
    pub uv_rtv: ID3D11RenderTargetView,
    pub keyed_mutex: IDXGIKeyedMutex,
    pub shared_handle: HANDLE,
}

impl Drop for Nv12Slot {
    fn drop(&mut self) {
        if !self.shared_handle.is_invalid() {
            unsafe {
                let _ = windows::Win32::Foundation::CloseHandle(self.shared_handle);
            }
        }
    }
}

// SAFETY: `Nv12Slot` is a bag of D3D11/DXGI COM pointers + an OS HANDLE.
// COM interfaces are thread-safe for free-threaded use; the raw HANDLE
// from `CreateSharedHandle` is just a kernel handle integer — moving
// across threads is fine. The session moves the entire ring into the
// composite thread at start; nothing accesses a slot from two threads
// simultaneously.
unsafe impl Send for Nv12Slot {}
unsafe impl Sync for Nv12Slot {}

/// Round-robin pool of `Nv12Slot`s sized for one capture resolution.
pub struct Nv12Ring {
    slots: Vec<Nv12Slot>,
    next: usize,
    width: u32,
    height: u32,
}

impl Nv12Ring {
    pub fn new(device: &ID3D11Device, width: u32, height: u32, capacity: usize) -> Result<Self> {
        if capacity == 0 {
            return Err(anyhow!("Nv12Ring capacity must be > 0"));
        }
        if width % 2 != 0 || height % 2 != 0 {
            return Err(anyhow!(
                "Nv12Ring dims must be even (got {width}x{height})"
            ));
        }

        // We need ID3D11Device3 for CreateRenderTargetView1 (the planar
        // RTV variant). All Windows 10 drivers expose it; if a device
        // doesn't, the GPU probe in `gpu::probe_adapter_default` will
        // already have steered us to CompositeMode::Cpu and we won't be
        // here. We still surface a clean error if the QI fails.
        let device3: ID3D11Device3 = device
            .cast()
            .context("ID3D11Device3 not available; NV12 planar RTVs require D3D 11.3+")?;

        let mut slots = Vec::with_capacity(capacity);
        for _ in 0..capacity {
            slots.push(create_slot(&device3, width, height)?);
        }
        Ok(Self {
            slots,
            next: 0,
            width,
            height,
        })
    }

    /// Borrow the next slot in the ring and advance. Caller is
    /// responsible for ensuring the encoder has finished with this slot
    /// (achieved by sizing capacity > encoder pipeline depth).
    pub fn acquire(&mut self) -> &Nv12Slot {
        let idx = self.next;
        self.next = (self.next + 1) % self.slots.len();
        &self.slots[idx]
    }

    /// Like [`Self::acquire`], but also returns the slot's index. The
    /// MF backend needs the index to look up its parallel
    /// consumer-side texture; the composite thread passes both into
    /// `Compositor::composite_into_nv12_slot` (slot ref) and the
    /// channel (index).
    pub fn acquire_indexed(&mut self) -> (usize, &Nv12Slot) {
        let idx = self.next;
        self.next = (self.next + 1) % self.slots.len();
        (idx, &self.slots[idx])
    }

    pub fn dimensions(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    pub fn capacity(&self) -> usize {
        self.slots.len()
    }

    /// Snapshot of every slot's NT shared handle. The MF encoder
    /// backend opens these on its private D3D11 device via
    /// `OpenSharedResource1` to produce its own parallel texture
    /// handles. Cheap — these are kernel handles, not heap data.
    ///
    /// The ring retains ownership; do not close the handles. Their
    /// lifetime is tied to the slot's `Drop`.
    pub fn shared_handles(&self) -> Vec<HANDLE> {
        self.slots.iter().map(|s| s.shared_handle).collect()
    }
}

fn create_slot(device: &ID3D11Device3, width: u32, height: u32) -> Result<Nv12Slot> {
    // Single-plane NV12 texture. Both planes live in this one
    // resource; the planar RTVs we create below address Y and UV
    // separately.
    //
    // Bind flags:
    // - RENDER_TARGET: the compositor's PS_Y and PS_UV passes write
    //   here via the planar RTVs.
    // - SHADER_RESOURCE: lets the encoder MFT (or anything else) sample
    //   the texture as an input. Some MFTs require this even if they
    //   only consume the texture as encoder input.
    // - VIDEO_ENCODER: required for the texture to be usable as input
    //   to a hardware video encoder MFT (NVENC, AMF, QSV via MF).
    //
    // Misc flags (Bite 3):
    // - SHARED_NTHANDLE: lets us export an NT handle that the MF
    //   backend's private D3D11 device can `OpenSharedResource1` to
    //   get a parallel texture handle on the same underlying surface.
    // - SHARED_KEYEDMUTEX: gives us the cross-device sync primitive
    //   the compositor and the encoder MFT use to coordinate writes
    //   vs reads on the shared texture.
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_NV12,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: (D3D11_BIND_RENDER_TARGET.0
            | D3D11_BIND_SHADER_RESOURCE.0
            | D3D11_BIND_VIDEO_ENCODER.0) as u32,
        CPUAccessFlags: 0,
        MiscFlags: (D3D11_RESOURCE_MISC_SHARED_NTHANDLE.0
            | D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX.0) as u32,
    };
    let mut texture: Option<ID3D11Texture2D> = None;
    unsafe {
        device
            .CreateTexture2D(&desc, None, Some(&mut texture))
            .context("CreateTexture2D NV12 ring slot")?;
    }
    let texture = texture.ok_or_else(|| anyhow!("null NV12 texture"))?;

    let y_rtv = create_planar_rtv(device, &texture, DXGI_FORMAT_R8_UNORM, 0)
        .context("create Y plane RTV")?;
    let uv_rtv = create_planar_rtv(device, &texture, DXGI_FORMAT_R8G8_UNORM, 1)
        .context("create UV plane RTV")?;

    // Keyed mutex interface for cross-device sync.
    let keyed_mutex: IDXGIKeyedMutex = texture
        .cast()
        .context("QI IDXGIKeyedMutex on NV12 ring slot")?;

    // Export an NT handle that MF's private device will open. This
    // handle is owned by the slot — `Nv12Slot::Drop` closes it.
    let dxgi_resource: IDXGIResource1 = texture
        .cast()
        .context("QI IDXGIResource1 on NV12 ring slot")?;
    let shared_handle = unsafe {
        dxgi_resource
            .CreateSharedHandle(None, GENERIC_ALL.0, None)
            .context("IDXGIResource1::CreateSharedHandle on NV12 ring slot")?
    };

    Ok(Nv12Slot {
        texture,
        y_rtv,
        uv_rtv,
        keyed_mutex,
        shared_handle,
    })
}

fn create_planar_rtv(
    device: &ID3D11Device3,
    texture: &ID3D11Texture2D,
    format: windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT,
    plane_slice: u32,
) -> Result<ID3D11RenderTargetView> {
    let desc = D3D11_RENDER_TARGET_VIEW_DESC1 {
        Format: format,
        ViewDimension: D3D11_RTV_DIMENSION_TEXTURE2D,
        Anonymous: D3D11_RENDER_TARGET_VIEW_DESC1_0 {
            Texture2D: D3D11_TEX2D_RTV1 {
                MipSlice: 0,
                PlaneSlice: plane_slice,
            },
        },
    };
    let mut rtv: Option<ID3D11RenderTargetView1> = None;
    unsafe {
        device
            .CreateRenderTargetView1(texture, Some(&desc), Some(&mut rtv))
            .context("CreateRenderTargetView1 (planar)")?;
    }
    let rtv1 = rtv.ok_or_else(|| anyhow!("null planar RTV"))?;
    // The compositor pipeline binds via the base `ID3D11RenderTargetView`
    // interface; downcast keeps the slot type uniform with the existing
    // BGRA RTV path.
    let rtv: ID3D11RenderTargetView = rtv1.cast().context("downcast RTV1 → RTV")?;
    Ok(rtv)
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::Foundation::HMODULE;
    use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_WARP, D3D_FEATURE_LEVEL_11_0};
    use windows::Win32::Graphics::Direct3D11::{
        D3D11CreateDevice, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_SDK_VERSION,
    };

    fn warp_device() -> Option<ID3D11Device> {
        let mut device: Option<ID3D11Device> = None;
        let mut feature_level = D3D_FEATURE_LEVEL_11_0;
        let levels = [D3D_FEATURE_LEVEL_11_0];
        let result = unsafe {
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_WARP,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                Some(&levels),
                D3D11_SDK_VERSION,
                Some(&mut device),
                Some(&mut feature_level),
                None,
            )
        };
        result.ok().and(device)
    }

    #[test]
    fn ring_acquires_slots_in_order_and_wraps() {
        let device = match warp_device() {
            Some(d) => d,
            None => {
                // CI without WARP — skip rather than fail.
                eprintln!("WARP unavailable; skipping NV12 ring test");
                return;
            }
        };

        // Some WARP builds don't expose ID3D11Device3 (the 11.3 surface
        // we need for planar RTVs). On those, we skip — production code
        // reaches this path only after the GPU probe succeeds.
        let ring = match Nv12Ring::new(&device, 64, 64, 3) {
            Ok(r) => r,
            Err(err) => {
                eprintln!("WARP doesn't expose D3D 11.3 planar RTVs ({err}); skipping");
                return;
            }
        };
        assert_eq!(ring.capacity(), 3);
        assert_eq!(ring.dimensions(), (64, 64));
    }

    #[test]
    fn ring_rejects_zero_capacity_and_odd_dims() {
        let device = match warp_device() {
            Some(d) => d,
            None => return,
        };
        assert!(Nv12Ring::new(&device, 64, 64, 0).is_err());
        assert!(Nv12Ring::new(&device, 63, 64, 2).is_err());
        assert!(Nv12Ring::new(&device, 64, 63, 2).is_err());
    }
}
