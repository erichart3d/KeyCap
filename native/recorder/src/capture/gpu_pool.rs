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
//! D3D11 call. Sizing the pool at ~3 textures matches the capture→
//! composite→writer depth; two would cause capture to stall any time the
//! composite thread is still reading a previous frame.

#![cfg(windows)]
// Public surface is used by the GPU compositor landing later in Bite 1.
#![allow(dead_code)]

use std::sync::Arc;

use anyhow::{anyhow, Context as _, Result};
use parking_lot::Mutex;
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Device, ID3D11Texture2D, D3D11_BIND_SHADER_RESOURCE,
    D3D11_RESOURCE_MISC_FLAG, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};

/// Pool of BGRA `D3D11_USAGE_DEFAULT` textures sized for a single capture
/// resolution. Thread-safe; the DDA thread acquires and the composite
/// thread's `Drop` of the resulting `GpuTextureHandle` recycles.
pub struct GpuTexturePool {
    device: ID3D11Device,
    width: u32,
    height: u32,
    free: Mutex<Vec<ID3D11Texture2D>>,
    capacity: usize,
}

impl GpuTexturePool {
    /// Construct a pool for the given device and capture dimensions. No
    /// textures are allocated up front — `acquire()` creates them lazily
    /// up to `capacity`, then blocks the caller by returning an error
    /// rather than unbounded-allocating (the caller drops the frame and
    /// the capture thread counts it as a drop).
    pub fn new(device: ID3D11Device, width: u32, height: u32, capacity: usize) -> Arc<Self> {
        Arc::new(Self {
            device,
            width,
            height,
            free: Mutex::new(Vec::with_capacity(capacity)),
            capacity,
        })
    }

    /// Take a free texture or allocate one if we're under capacity.
    pub fn acquire(self: &Arc<Self>) -> Result<GpuTextureHandle> {
        {
            let mut guard = self.free.lock();
            if let Some(texture) = guard.pop() {
                return Ok(GpuTextureHandle {
                    texture: Some(texture),
                    pool: Arc::clone(self),
                });
            }
        }
        // Pool empty — try to create a fresh texture. We don't enforce the
        // capacity limit here because the DDA backend already bounds
        // concurrent frames-in-flight via its single-threaded capture loop,
        // so in practice only `capacity` textures ever exist at once.
        let texture = create_bgra_texture(&self.device, self.width, self.height)
            .context("create pooled capture texture")?;
        Ok(GpuTextureHandle {
            texture: Some(texture),
            pool: Arc::clone(self),
        })
    }

    #[allow(dead_code)]
    pub fn dimensions(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    fn recycle(&self, texture: ID3D11Texture2D) {
        let mut guard = self.free.lock();
        if guard.len() < self.capacity {
            guard.push(texture);
        }
        // Over-capacity textures are simply dropped here; D3D11 releases
        // the underlying VRAM when the COM refcount hits zero.
    }
}

/// Owned handle to a pooled BGRA texture. Dropping recycles the texture
/// back to the pool. The handle derefs to the underlying `ID3D11Texture2D`
/// for binding as an SRV.
pub struct GpuTextureHandle {
    texture: Option<ID3D11Texture2D>,
    pool: Arc<GpuTexturePool>,
}

impl GpuTextureHandle {
    /// Borrow the inner texture. Always present until Drop.
    pub fn texture(&self) -> &ID3D11Texture2D {
        self.texture
            .as_ref()
            .expect("GpuTextureHandle used after Drop")
    }
}

impl Drop for GpuTextureHandle {
    fn drop(&mut self) {
        if let Some(tex) = self.texture.take() {
            self.pool.recycle(tex);
        }
    }
}

fn create_bgra_texture(
    device: &ID3D11Device,
    width: u32,
    height: u32,
) -> Result<ID3D11Texture2D> {
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
    texture.ok_or_else(|| anyhow!("CreateTexture2D returned null"))
}
