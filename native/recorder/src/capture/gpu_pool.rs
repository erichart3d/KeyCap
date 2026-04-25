//! GPU texture pool for capture frames.
//!
//! On the M3-Bite1 GPU path, the DDA backend `CopyResource`s each captured
//! frame into a pool-managed `D3D11_USAGE_DEFAULT` BGRA texture (rather
//! than a single `D3D11_USAGE_STAGING` texture it then Maps to CPU). The
//! composite thread samples that texture as an SRV, so we can't reuse the
//! same texture for the next capture until the GPU has finished sampling
//! it — that's what the fence value in `GpuFrame` gates.
//!
//! Recycling whole textures matters more than recycling CPU Vecs: each 4K
//! BGRA texture is ~33 MiB of VRAM, and `CreateTexture2D` is an expensive
//! D3D11 call. Capacity 4 keeps DDA from blocking when composite is one
//! frame behind: at any moment, one texture sits in DDA's "just emitted"
//! channel slot, one in the composite thread, one in the (recently-dropped)
//! recycle path, and one free for DDA to acquire next. Two would force DDA
//! to stall if composite is mid-render.

#![cfg(windows)]
// Public surface is used by the GPU compositor landing later in Bite 1.
#![allow(dead_code)]

use std::sync::Arc;

use anyhow::{anyhow, Context as _, Result};
use parking_lot::Mutex;
use windows::Win32::Graphics::Direct3D::D3D11_SRV_DIMENSION_TEXTURE2D;
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Device, ID3D11ShaderResourceView, ID3D11Texture2D, D3D11_BIND_SHADER_RESOURCE,
    D3D11_RESOURCE_MISC_FLAG, D3D11_SHADER_RESOURCE_VIEW_DESC, D3D11_SHADER_RESOURCE_VIEW_DESC_0,
    D3D11_TEX2D_SRV, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};

/// One pooled BGRA capture texture and its companion SRV. The compositor
/// shader binds the SRV; nothing outside the pool touches the raw texture
/// directly. Stored together so recycling brings them back as a unit and
/// neither outlives the other.
struct PoolEntry {
    texture: ID3D11Texture2D,
    srv: ID3D11ShaderResourceView,
}

/// Pool of BGRA `D3D11_USAGE_DEFAULT` textures sized for a single capture
/// resolution. Thread-safe; the DDA thread acquires and the composite
/// thread's `Drop` of the resulting `GpuTextureHandle` recycles.
pub struct GpuTexturePool {
    device: ID3D11Device,
    width: u32,
    height: u32,
    free: Mutex<Vec<PoolEntry>>,
    capacity: usize,
}

impl GpuTexturePool {
    /// Construct a pool for the given device and capture dimensions. No
    /// textures are allocated up front — `acquire()` creates them lazily
    /// up to `capacity`. Over-capacity textures get dropped on recycle
    /// rather than retained, so a brief load spike doesn't permanently
    /// inflate VRAM.
    pub fn new(device: ID3D11Device, width: u32, height: u32, capacity: usize) -> Arc<Self> {
        Arc::new(Self {
            device,
            width,
            height,
            free: Mutex::new(Vec::with_capacity(capacity)),
            capacity,
        })
    }

    /// Take a free texture+SRV or allocate a fresh one.
    pub fn acquire(self: &Arc<Self>) -> Result<GpuTextureHandle> {
        {
            let mut guard = self.free.lock();
            if let Some(entry) = guard.pop() {
                return Ok(GpuTextureHandle {
                    entry: Some(entry),
                    pool: Arc::clone(self),
                });
            }
        }
        let entry = create_pool_entry(&self.device, self.width, self.height)
            .context("create pooled capture texture")?;
        Ok(GpuTextureHandle {
            entry: Some(entry),
            pool: Arc::clone(self),
        })
    }

    #[allow(dead_code)]
    pub fn dimensions(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    fn recycle(&self, entry: PoolEntry) {
        let mut guard = self.free.lock();
        if guard.len() < self.capacity {
            guard.push(entry);
        }
        // Over-capacity: dropped here; D3D11 releases the VRAM when the
        // COM refcount hits zero.
    }
}

/// Owned handle to a pooled BGRA texture + its SRV. Dropping recycles
/// both back to the pool atomically. Borrow `texture()` for binds that
/// need a texture (CopyResource source/dest) and `srv()` for shader
/// reads.
pub struct GpuTextureHandle {
    entry: Option<PoolEntry>,
    pool: Arc<GpuTexturePool>,
}

impl GpuTextureHandle {
    /// Borrow the inner texture. Always present until Drop.
    pub fn texture(&self) -> &ID3D11Texture2D {
        &self
            .entry
            .as_ref()
            .expect("GpuTextureHandle used after Drop")
            .texture
    }

    /// Borrow the inner SRV. Same lifetime as `texture()`.
    pub fn srv(&self) -> &ID3D11ShaderResourceView {
        &self
            .entry
            .as_ref()
            .expect("GpuTextureHandle used after Drop")
            .srv
    }
}

impl Drop for GpuTextureHandle {
    fn drop(&mut self) {
        if let Some(entry) = self.entry.take() {
            self.pool.recycle(entry);
        }
    }
}

fn create_pool_entry(
    device: &ID3D11Device,
    width: u32,
    height: u32,
) -> Result<PoolEntry> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
        CPUAccessFlags: 0,
        MiscFlags: D3D11_RESOURCE_MISC_FLAG(0).0 as u32,
    };
    let mut texture: Option<ID3D11Texture2D> = None;
    unsafe {
        device
            .CreateTexture2D(&desc, None, Some(&mut texture))
            .context("CreateTexture2D (BGRA capture)")?;
    }
    let texture = texture.ok_or_else(|| anyhow!("CreateTexture2D returned null"))?;

    let srv_desc = D3D11_SHADER_RESOURCE_VIEW_DESC {
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        ViewDimension: D3D11_SRV_DIMENSION_TEXTURE2D,
        Anonymous: D3D11_SHADER_RESOURCE_VIEW_DESC_0 {
            Texture2D: D3D11_TEX2D_SRV {
                MostDetailedMip: 0,
                MipLevels: 1,
            },
        },
    };
    let mut srv: Option<ID3D11ShaderResourceView> = None;
    unsafe {
        device
            .CreateShaderResourceView(&texture, Some(&srv_desc), Some(&mut srv))
            .context("CreateShaderResourceView pool BGRA")?;
    }
    let srv = srv.ok_or_else(|| anyhow!("null pool BGRA SRV"))?;
    Ok(PoolEntry { texture, srv })
}
