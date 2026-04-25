//! BGRA `Vec<u8>` → `ID3D11Texture2D` + SRV uploader.
//!
//! On the M3-Bite1.5 GPU path the only consumer is the **overlay** —
//! Electron OSR delivers `(bytes, width, height, seq)` per paint and the
//! composite thread uploads it into a persistent dynamic texture. The
//! capture frame skips this path entirely now: it arrives as a pooled
//! `ID3D11Texture2D` from `capture::gpu_pool` so there are no bytes to
//! upload, just an SRV to bind.
//!
//! The uploader caches by `(width, height)` and skips the Map/Unmap when
//! `seq` is unchanged, mirroring the cache at `session.rs` that drives
//! the CPU path's overlay scaler.
//!
//! Textures are `D3D11_USAGE_DYNAMIC` + `D3D11_MAP_WRITE_DISCARD` so the
//! driver can rename on upload without blocking the capture thread.
//! The immediate context is shared with the DDA capture thread via the
//! same `Arc<Mutex<...>>` the `Compositor` uses.

#![cfg(windows)]
#![allow(dead_code)] // wired into the composite thread in a later bite step

use std::sync::Arc;

use anyhow::{anyhow, Context as _, Result};
use parking_lot::Mutex;
use windows::Win32::Graphics::Direct3D::D3D11_SRV_DIMENSION_TEXTURE2D;
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Device, ID3D11DeviceContext, ID3D11ShaderResourceView, ID3D11Texture2D,
    D3D11_BIND_SHADER_RESOURCE, D3D11_CPU_ACCESS_WRITE, D3D11_MAP_WRITE_DISCARD,
    D3D11_MAPPED_SUBRESOURCE, D3D11_SHADER_RESOURCE_VIEW_DESC,
    D3D11_SHADER_RESOURCE_VIEW_DESC_0, D3D11_TEX2D_SRV, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DYNAMIC,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};

/// Uploader for tight-packed BGRA bytes. Owns one `ID3D11Texture2D`; dims
/// changing means recreate. `seq` cache avoids re-uploading the same bytes
/// — useful for overlays where Electron paint rate < composite rate.
pub struct BgraUploader {
    device: ID3D11Device,
    context: Arc<Mutex<ID3D11DeviceContext>>,
    texture: Option<ID3D11Texture2D>,
    srv: Option<ID3D11ShaderResourceView>,
    tex_width: u32,
    tex_height: u32,
    last_seq: Option<u64>,
}

impl BgraUploader {
    pub fn new(device: ID3D11Device, context: Arc<Mutex<ID3D11DeviceContext>>) -> Result<Self> {
        Ok(Self {
            device,
            context,
            texture: None,
            srv: None,
            tex_width: 0,
            tex_height: 0,
            last_seq: None,
        })
    }

    /// Borrow the last-uploaded SRV. `None` if no overlay has been
    /// uploaded yet this session.
    pub fn current_srv(&self) -> Option<&ID3D11ShaderResourceView> {
        self.srv.as_ref()
    }

    /// Upload the overlay BGRA buffer into the cached texture.
    ///
    /// - If dimensions changed, the backing texture is recreated.
    /// - If `seq` matches the last successful upload at the same dims,
    ///   this is a no-op and returns the cached SRV.
    /// - Panics if `bytes.len() != width * height * 4`.
    pub fn upload(
        &mut self,
        bytes: &[u8],
        width: u32,
        height: u32,
        seq: u64,
    ) -> Result<&ID3D11ShaderResourceView> {
        assert_eq!(
            bytes.len(),
            (width as usize) * (height as usize) * 4,
            "overlay bgra byte length mismatch"
        );

        let dims_changed = width != self.tex_width || height != self.tex_height;
        if dims_changed {
            // Drop old texture + SRV; they'll be recreated below.
            self.texture = None;
            self.srv = None;
            self.last_seq = None;
        }

        if self.texture.is_none() {
            let (tex, srv) = create_dynamic_bgra(&self.device, width, height)
                .context("create dynamic overlay texture")?;
            self.texture = Some(tex);
            self.srv = Some(srv);
            self.tex_width = width;
            self.tex_height = height;
        }

        // Same bytes as last frame — skip the Map/Unmap.
        if self.last_seq == Some(seq) {
            return Ok(self
                .srv
                .as_ref()
                .expect("SRV should exist after texture create"));
        }

        let texture = self
            .texture
            .as_ref()
            .expect("texture should exist after create");

        let ctx = self.context.lock();
        unsafe {
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            ctx.Map(texture, 0, D3D11_MAP_WRITE_DISCARD, 0, Some(&mut mapped))
                .context("Map overlay texture")?;

            let row_pitch = mapped.RowPitch as usize;
            let row_bytes = (width as usize) * 4;
            let dst = mapped.pData as *mut u8;
            let src = bytes.as_ptr();

            if row_pitch == row_bytes {
                std::ptr::copy_nonoverlapping(src, dst, row_bytes * height as usize);
            } else {
                for y in 0..(height as usize) {
                    let s = src.add(y * row_bytes);
                    let d = dst.add(y * row_pitch);
                    std::ptr::copy_nonoverlapping(s, d, row_bytes);
                }
            }

            ctx.Unmap(texture, 0);
        }

        self.last_seq = Some(seq);
        Ok(self.srv.as_ref().unwrap())
    }
}

fn create_dynamic_bgra(
    device: &ID3D11Device,
    width: u32,
    height: u32,
) -> Result<(ID3D11Texture2D, ID3D11ShaderResourceView)> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Usage: D3D11_USAGE_DYNAMIC,
        BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
        CPUAccessFlags: D3D11_CPU_ACCESS_WRITE.0 as u32,
        MiscFlags: 0,
    };
    let mut tex: Option<ID3D11Texture2D> = None;
    unsafe {
        device
            .CreateTexture2D(&desc, None, Some(&mut tex))
            .context("CreateTexture2D dynamic BGRA")?;
    }
    let tex = tex.ok_or_else(|| anyhow!("null dynamic BGRA texture"))?;

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
            .CreateShaderResourceView(&tex, Some(&srv_desc), Some(&mut srv))
            .context("CreateShaderResourceView dynamic BGRA")?;
    }
    let srv = srv.ok_or_else(|| anyhow!("null dynamic BGRA SRV"))?;
    Ok((tex, srv))
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::Foundation::HMODULE;
    use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_WARP, D3D_FEATURE_LEVEL_11_0};
    use windows::Win32::Graphics::Direct3D11::{
        D3D11CreateDevice, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_SDK_VERSION,
    };

    fn warp_device_and_context() -> (ID3D11Device, Arc<Mutex<ID3D11DeviceContext>>) {
        let mut device: Option<ID3D11Device> = None;
        let mut context: Option<ID3D11DeviceContext> = None;
        let mut feature_level = D3D_FEATURE_LEVEL_11_0;
        let levels = [D3D_FEATURE_LEVEL_11_0];
        unsafe {
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_WARP,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                Some(&levels),
                D3D11_SDK_VERSION,
                Some(&mut device),
                Some(&mut feature_level),
                Some(&mut context),
            )
            .expect("WARP device");
        }
        (
            device.expect("null WARP device"),
            Arc::new(Mutex::new(context.expect("null WARP context"))),
        )
    }

    #[test]
    fn upload_creates_srv_on_first_call() {
        let (device, ctx) = warp_device_and_context();
        let mut up = BgraUploader::new(device, ctx).expect("uploader");
        assert!(up.current_srv().is_none());
        let bytes = vec![0u8; 8 * 8 * 4];
        up.upload(&bytes, 8, 8, 1).expect("upload");
        assert!(up.current_srv().is_some());
    }

    #[test]
    fn upload_same_seq_skips_work() {
        let (device, ctx) = warp_device_and_context();
        let mut up = BgraUploader::new(device, ctx).expect("uploader");
        let bytes = vec![0u8; 4 * 4 * 4];
        let srv1 = up.upload(&bytes, 4, 4, 7).expect("upload 1") as *const _;
        let srv2 = up.upload(&bytes, 4, 4, 7).expect("upload 2") as *const _;
        // Same seq → same cached SRV pointer.
        assert_eq!(srv1, srv2);
    }

    #[test]
    fn upload_recreates_on_dim_change() {
        let (device, ctx) = warp_device_and_context();
        let mut up = BgraUploader::new(device, ctx).expect("uploader");
        let small = vec![0u8; 4 * 4 * 4];
        up.upload(&small, 4, 4, 1).expect("upload small");
        let big = vec![0u8; 16 * 8 * 4];
        up.upload(&big, 16, 8, 1).expect("upload big");
        // Different dims → texture recreated; seq cache is reset so the
        // second upload actually performed the Map.
        assert_eq!(up.tex_width, 16);
        assert_eq!(up.tex_height, 8);
    }
}
