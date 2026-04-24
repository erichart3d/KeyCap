//! GPU compositor — runs the three shader passes that replace the CPU
//! composite + `convert::bgra_to_nv12` path.
//!
//! Pipeline:
//!
//! 1. **Composite pass** — samples the capture SRV (BGRA) and optional
//!    overlay SRV (BGRA), writes blended BGRA into `intermediate_rt`.
//!    The capture SRV can be any size — the bilinear sampler scales to
//!    encoder dims for free, replacing the CPU `resize_bgra_nn` path.
//! 2. **Y pass** — samples `intermediate_rt`, writes limited-range luma
//!    into `y_rt` (R8_UNORM, encoder dims).
//! 3. **UV pass** — samples `intermediate_rt`, writes 2×2-averaged
//!    (Cb, Cr) pairs into `uv_rt` (R8G8_UNORM, half encoder dims).
//!
//! After the draws, `y_rt` and `uv_rt` are `CopyResource`-d into staging
//! textures the composite thread maps to pull tight NV12 bytes. The byte
//! layout matches `convert::nv12_byte_len` exactly so the writer thread
//! is format-identical on both paths.

#![cfg(windows)]
#![allow(dead_code)] // wired into the composite thread in a later bite step

use anyhow::{anyhow, Context as _, Result};
use windows::Win32::Graphics::Direct3D::{D3D11_SRV_DIMENSION_TEXTURE2D, D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST};
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Buffer, ID3D11Device, ID3D11DeviceContext, ID3D11PixelShader,
    ID3D11RenderTargetView, ID3D11SamplerState, ID3D11ShaderResourceView, ID3D11Texture2D,
    ID3D11VertexShader, D3D11_BIND_CONSTANT_BUFFER, D3D11_BIND_RENDER_TARGET,
    D3D11_BIND_SHADER_RESOURCE, D3D11_BUFFER_DESC, D3D11_COMPARISON_NEVER, D3D11_CPU_ACCESS_READ,
    D3D11_CPU_ACCESS_WRITE, D3D11_FILTER_MIN_MAG_MIP_LINEAR, D3D11_MAP_READ,
    D3D11_MAP_WRITE_DISCARD, D3D11_MAPPED_SUBRESOURCE, D3D11_RENDER_TARGET_VIEW_DESC,
    D3D11_RENDER_TARGET_VIEW_DESC_0, D3D11_RESOURCE_MISC_FLAG, D3D11_RTV_DIMENSION_TEXTURE2D,
    D3D11_SAMPLER_DESC, D3D11_SHADER_RESOURCE_VIEW_DESC, D3D11_SHADER_RESOURCE_VIEW_DESC_0,
    D3D11_SUBRESOURCE_DATA, D3D11_TEX2D_RTV, D3D11_TEX2D_SRV, D3D11_TEXTURE2D_DESC,
    D3D11_TEXTURE_ADDRESS_CLAMP, D3D11_USAGE_DEFAULT, D3D11_USAGE_DYNAMIC, D3D11_USAGE_STAGING,
    D3D11_VIEWPORT,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_R8G8_UNORM, DXGI_FORMAT_R8_UNORM, DXGI_SAMPLE_DESC,
};

use super::shaders::{compile_ps_composite, compile_ps_uv, compile_ps_y, compile_vs_main};

/// Runtime constant buffer for the composite pixel shader. Matches the
/// `cbuffer Params` in `PS_COMPOSITE`.
#[repr(C)]
#[derive(Clone, Copy)]
struct CompositeParams {
    has_overlay: u32,
    _pad: [u32; 3],
}

/// The compositor owns every D3D11 resource it needs to turn a capture
/// texture (+ optional overlay) into tight-packed NV12 bytes. All fields
/// are refcounted COM pointers — constructing the compositor is expensive
/// (shader compile + RT creation) but running it is just draws + maps.
///
/// The compositor does NOT own the capture texture pool or the overlay
/// upload texture — capture textures come from `capture::gpu_pool` and
/// overlay uploads live in `gpu::overlay_upload`.
pub struct Compositor {
    device: ID3D11Device,
    context: ID3D11DeviceContext,

    vs: ID3D11VertexShader,
    ps_composite: ID3D11PixelShader,
    ps_y: ID3D11PixelShader,
    ps_uv: ID3D11PixelShader,

    /// Intermediate BGRA render target — the composite pass writes here,
    /// then the Y and UV passes sample from it.
    intermediate_rt: ID3D11Texture2D,
    intermediate_rtv: ID3D11RenderTargetView,
    intermediate_srv: ID3D11ShaderResourceView,

    y_rt: ID3D11Texture2D,
    y_rtv: ID3D11RenderTargetView,
    y_staging: ID3D11Texture2D,

    uv_rt: ID3D11Texture2D,
    uv_rtv: ID3D11RenderTargetView,
    uv_staging: ID3D11Texture2D,

    sampler: ID3D11SamplerState,
    composite_cbuf: ID3D11Buffer,

    out_width: u32,
    out_height: u32,
}

impl Compositor {
    /// Build a compositor for the given output dimensions. Shader compile
    /// runs here (~50–150 ms once per session).
    ///
    /// `out_width` / `out_height` must be even (NV12 chroma subsampling).
    pub fn new(device: &ID3D11Device, out_width: u32, out_height: u32) -> Result<Self> {
        if out_width % 2 != 0 || out_height % 2 != 0 {
            return Err(anyhow!(
                "compositor output dims must be even (got {out_width}x{out_height})"
            ));
        }

        let context = unsafe { device.GetImmediateContext() }
            .context("get immediate context")?;

        // Compile shaders first — if HLSL doesn't parse, fail before we
        // allocate any GPU memory.
        let vs_blob = compile_vs_main()?;
        let ps_comp_blob = compile_ps_composite()?;
        let ps_y_blob = compile_ps_y()?;
        let ps_uv_blob = compile_ps_uv()?;

        let mut vs: Option<ID3D11VertexShader> = None;
        let mut ps_composite: Option<ID3D11PixelShader> = None;
        let mut ps_y: Option<ID3D11PixelShader> = None;
        let mut ps_uv: Option<ID3D11PixelShader> = None;
        unsafe {
            device
                .CreateVertexShader(vs_blob.bytecode(), None, Some(&mut vs))
                .context("CreateVertexShader")?;
            device
                .CreatePixelShader(ps_comp_blob.bytecode(), None, Some(&mut ps_composite))
                .context("CreatePixelShader (composite)")?;
            device
                .CreatePixelShader(ps_y_blob.bytecode(), None, Some(&mut ps_y))
                .context("CreatePixelShader (Y)")?;
            device
                .CreatePixelShader(ps_uv_blob.bytecode(), None, Some(&mut ps_uv))
                .context("CreatePixelShader (UV)")?;
        }
        let vs = vs.ok_or_else(|| anyhow!("null VS"))?;
        let ps_composite = ps_composite.ok_or_else(|| anyhow!("null PS composite"))?;
        let ps_y = ps_y.ok_or_else(|| anyhow!("null PS Y"))?;
        let ps_uv = ps_uv.ok_or_else(|| anyhow!("null PS UV"))?;

        // Intermediate BGRA render target at output dimensions. The
        // composite pass samples capture (any size) and writes here, so
        // the bilinear sampler absorbs resize for free.
        let (intermediate_rt, intermediate_rtv, intermediate_srv) = create_bgra_rt_srv(
            device, out_width, out_height,
        )
        .context("create intermediate BGRA RT")?;

        // Y plane: R8 render target at output dimensions.
        let (y_rt, y_rtv) =
            create_r_rt(device, DXGI_FORMAT_R8_UNORM, out_width, out_height)
                .context("create Y R8 RT")?;
        let y_staging = create_staging(device, DXGI_FORMAT_R8_UNORM, out_width, out_height)
            .context("create Y R8 staging")?;

        // UV plane: R8G8 render target at half dimensions.
        let (uv_rt, uv_rtv) = create_r_rt(
            device,
            DXGI_FORMAT_R8G8_UNORM,
            out_width / 2,
            out_height / 2,
        )
        .context("create UV R8G8 RT")?;
        let uv_staging = create_staging(
            device,
            DXGI_FORMAT_R8G8_UNORM,
            out_width / 2,
            out_height / 2,
        )
        .context("create UV R8G8 staging")?;

        let sampler = create_linear_clamp_sampler(device)?;
        let composite_cbuf = create_composite_cbuffer(device)?;

        Ok(Compositor {
            device: device.clone(),
            context,
            vs,
            ps_composite,
            ps_y,
            ps_uv,
            intermediate_rt,
            intermediate_rtv,
            intermediate_srv,
            y_rt,
            y_rtv,
            y_staging,
            uv_rt,
            uv_rtv,
            uv_staging,
            sampler,
            composite_cbuf,
            out_width,
            out_height,
        })
    }

    pub fn output_dimensions(&self) -> (u32, u32) {
        (self.out_width, self.out_height)
    }

    /// Run the three passes. `capture_srv` is an SRV over the capture
    /// texture (any BGRA format sampleable as float4). `overlay_srv` is
    /// optional — when `None`, the composite pass uses only the capture.
    ///
    /// This call does not itself block on GPU completion; `map_nv12`
    /// does. A future bite step can double-buffer the staging textures
    /// to overlap the next composite with the current readback.
    pub fn composite_and_convert(
        &self,
        capture_srv: &ID3D11ShaderResourceView,
        overlay_srv: Option<&ID3D11ShaderResourceView>,
    ) -> Result<()> {
        unsafe {
            // Upload the composite params cbuffer.
            let params = CompositeParams {
                has_overlay: if overlay_srv.is_some() { 1 } else { 0 },
                _pad: [0; 3],
            };
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            self.context
                .Map(&self.composite_cbuf, 0, D3D11_MAP_WRITE_DISCARD, 0, Some(&mut mapped))
                .context("Map composite cbuffer")?;
            std::ptr::copy_nonoverlapping(
                &params as *const _ as *const u8,
                mapped.pData as *mut u8,
                std::mem::size_of::<CompositeParams>(),
            );
            self.context.Unmap(&self.composite_cbuf, 0);

            // Shared pipeline state.
            self.context.IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
            self.context.IASetInputLayout(None);
            self.context.VSSetShader(&self.vs, None);
            let samplers = [Some(self.sampler.clone())];
            self.context.PSSetSamplers(0, Some(&samplers));

            // ── Pass 1: composite ───────────────────────────────────────
            let rtvs: [Option<ID3D11RenderTargetView>; 1] = [Some(self.intermediate_rtv.clone())];
            self.context.OMSetRenderTargets(Some(&rtvs), None);

            let srvs: [Option<ID3D11ShaderResourceView>; 2] = [
                Some(capture_srv.clone()),
                overlay_srv.cloned(),
            ];
            self.context.PSSetShaderResources(0, Some(&srvs));

            let cbufs = [Some(self.composite_cbuf.clone())];
            self.context.PSSetConstantBuffers(0, Some(&cbufs));

            self.context.PSSetShader(&self.ps_composite, None);
            set_viewport(&self.context, self.out_width, self.out_height);
            self.context.Draw(3, 0);

            // Unbind intermediate RT before using it as SRV.
            let no_rtv: [Option<ID3D11RenderTargetView>; 1] = [None];
            self.context.OMSetRenderTargets(Some(&no_rtv), None);

            // ── Pass 2: Y ──────────────────────────────────────────────
            let rtvs: [Option<ID3D11RenderTargetView>; 1] = [Some(self.y_rtv.clone())];
            self.context.OMSetRenderTargets(Some(&rtvs), None);
            let srvs: [Option<ID3D11ShaderResourceView>; 2] =
                [Some(self.intermediate_srv.clone()), None];
            self.context.PSSetShaderResources(0, Some(&srvs));
            self.context.PSSetShader(&self.ps_y, None);
            set_viewport(&self.context, self.out_width, self.out_height);
            self.context.Draw(3, 0);

            self.context.OMSetRenderTargets(Some(&no_rtv), None);

            // ── Pass 3: UV (half-res) ──────────────────────────────────
            let rtvs: [Option<ID3D11RenderTargetView>; 1] = [Some(self.uv_rtv.clone())];
            self.context.OMSetRenderTargets(Some(&rtvs), None);
            let srvs: [Option<ID3D11ShaderResourceView>; 2] =
                [Some(self.intermediate_srv.clone()), None];
            self.context.PSSetShaderResources(0, Some(&srvs));
            self.context.PSSetShader(&self.ps_uv, None);
            set_viewport(&self.context, self.out_width / 2, self.out_height / 2);
            self.context.Draw(3, 0);

            self.context.OMSetRenderTargets(Some(&no_rtv), None);

            // Copy RT → staging for CPU readback.
            self.context.CopyResource(&self.y_staging, &self.y_rt);
            self.context.CopyResource(&self.uv_staging, &self.uv_rt);
        }
        Ok(())
    }

    /// Map both staging textures and return a tight NV12 `Vec<u8>` of
    /// exactly `nv12_byte_len(out_width, out_height)` bytes.
    ///
    /// `Map(READ)` stalls the caller until the GPU has finished the
    /// copy. Caller is expected to have issued `composite_and_convert`
    /// before this.
    pub fn map_nv12(&self) -> Result<Vec<u8>> {
        let w = self.out_width as usize;
        let h = self.out_height as usize;
        let y_bytes = w * h;
        let uv_bytes = w * h / 2; // half-res (w/2 × h/2) × 2 channels
        let total = y_bytes + uv_bytes;

        let mut out = Vec::with_capacity(total);
        // SAFETY: we fully overwrite all `total` bytes via the two planes
        // below before returning.
        #[allow(clippy::uninit_vec)]
        unsafe {
            out.set_len(total);
        }

        // ── Y plane ─────────────────────────────────────────────────────
        unsafe {
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            self.context
                .Map(&self.y_staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
                .context("Map Y staging")?;
            let row_pitch = mapped.RowPitch as usize;
            let src = mapped.pData as *const u8;
            if row_pitch == w {
                std::ptr::copy_nonoverlapping(src, out.as_mut_ptr(), y_bytes);
            } else {
                for y in 0..h {
                    let s = src.add(y * row_pitch);
                    let d = out.as_mut_ptr().add(y * w);
                    std::ptr::copy_nonoverlapping(s, d, w);
                }
            }
            self.context.Unmap(&self.y_staging, 0);
        }

        // ── UV plane ────────────────────────────────────────────────────
        unsafe {
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            self.context
                .Map(&self.uv_staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
                .context("Map UV staging")?;
            let row_pitch = mapped.RowPitch as usize;
            let uv_row_bytes = w; // (w/2 pairs of R8G8) × 2 bytes = w
            let uv_rows = h / 2;
            let src = mapped.pData as *const u8;
            let dst_base = out.as_mut_ptr().add(y_bytes);
            if row_pitch == uv_row_bytes {
                std::ptr::copy_nonoverlapping(src, dst_base, uv_bytes);
            } else {
                for y in 0..uv_rows {
                    let s = src.add(y * row_pitch);
                    let d = dst_base.add(y * uv_row_bytes);
                    std::ptr::copy_nonoverlapping(s, d, uv_row_bytes);
                }
            }
            self.context.Unmap(&self.uv_staging, 0);
        }

        Ok(out)
    }
}

fn set_viewport(ctx: &ID3D11DeviceContext, width: u32, height: u32) {
    let vp = D3D11_VIEWPORT {
        TopLeftX: 0.0,
        TopLeftY: 0.0,
        Width: width as f32,
        Height: height as f32,
        MinDepth: 0.0,
        MaxDepth: 1.0,
    };
    unsafe {
        ctx.RSSetViewports(Some(&[vp]));
    }
}

fn create_bgra_rt_srv(
    device: &ID3D11Device,
    width: u32,
    height: u32,
) -> Result<(ID3D11Texture2D, ID3D11RenderTargetView, ID3D11ShaderResourceView)> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
        CPUAccessFlags: 0,
        MiscFlags: D3D11_RESOURCE_MISC_FLAG(0).0 as u32,
    };
    let mut tex: Option<ID3D11Texture2D> = None;
    unsafe {
        device
            .CreateTexture2D(&desc, None, Some(&mut tex))
            .context("CreateTexture2D BGRA RT")?;
    }
    let tex = tex.ok_or_else(|| anyhow!("null BGRA RT texture"))?;

    let rtv_desc = D3D11_RENDER_TARGET_VIEW_DESC {
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        ViewDimension: D3D11_RTV_DIMENSION_TEXTURE2D,
        Anonymous: D3D11_RENDER_TARGET_VIEW_DESC_0 {
            Texture2D: D3D11_TEX2D_RTV { MipSlice: 0 },
        },
    };
    let mut rtv: Option<ID3D11RenderTargetView> = None;
    unsafe {
        device
            .CreateRenderTargetView(&tex, Some(&rtv_desc), Some(&mut rtv))
            .context("CreateRenderTargetView BGRA")?;
    }
    let rtv = rtv.ok_or_else(|| anyhow!("null BGRA RTV"))?;

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
            .context("CreateShaderResourceView BGRA")?;
    }
    let srv = srv.ok_or_else(|| anyhow!("null BGRA SRV"))?;

    Ok((tex, rtv, srv))
}

fn create_r_rt(
    device: &ID3D11Device,
    format: windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT,
    width: u32,
    height: u32,
) -> Result<(ID3D11Texture2D, ID3D11RenderTargetView)> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: format,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: D3D11_BIND_RENDER_TARGET.0 as u32,
        CPUAccessFlags: 0,
        MiscFlags: 0,
    };
    let mut tex: Option<ID3D11Texture2D> = None;
    unsafe {
        device
            .CreateTexture2D(&desc, None, Some(&mut tex))
            .context("CreateTexture2D R RT")?;
    }
    let tex = tex.ok_or_else(|| anyhow!("null R RT texture"))?;

    let rtv_desc = D3D11_RENDER_TARGET_VIEW_DESC {
        Format: format,
        ViewDimension: D3D11_RTV_DIMENSION_TEXTURE2D,
        Anonymous: D3D11_RENDER_TARGET_VIEW_DESC_0 {
            Texture2D: D3D11_TEX2D_RTV { MipSlice: 0 },
        },
    };
    let mut rtv: Option<ID3D11RenderTargetView> = None;
    unsafe {
        device
            .CreateRenderTargetView(&tex, Some(&rtv_desc), Some(&mut rtv))
            .context("CreateRenderTargetView R")?;
    }
    let rtv = rtv.ok_or_else(|| anyhow!("null R RTV"))?;

    Ok((tex, rtv))
}

fn create_staging(
    device: &ID3D11Device,
    format: windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT,
    width: u32,
    height: u32,
) -> Result<ID3D11Texture2D> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: format,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Usage: D3D11_USAGE_STAGING,
        BindFlags: 0,
        CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
        MiscFlags: 0,
    };
    let mut tex: Option<ID3D11Texture2D> = None;
    unsafe {
        device
            .CreateTexture2D(&desc, None, Some(&mut tex))
            .context("CreateTexture2D staging")?;
    }
    tex.ok_or_else(|| anyhow!("null staging texture"))
}

fn create_linear_clamp_sampler(device: &ID3D11Device) -> Result<ID3D11SamplerState> {
    let desc = D3D11_SAMPLER_DESC {
        Filter: D3D11_FILTER_MIN_MAG_MIP_LINEAR,
        AddressU: D3D11_TEXTURE_ADDRESS_CLAMP,
        AddressV: D3D11_TEXTURE_ADDRESS_CLAMP,
        AddressW: D3D11_TEXTURE_ADDRESS_CLAMP,
        MipLODBias: 0.0,
        MaxAnisotropy: 1,
        ComparisonFunc: D3D11_COMPARISON_NEVER,
        BorderColor: [0.0; 4],
        MinLOD: 0.0,
        MaxLOD: 0.0,
    };
    let mut sampler: Option<ID3D11SamplerState> = None;
    unsafe {
        device
            .CreateSamplerState(&desc, Some(&mut sampler))
            .context("CreateSamplerState")?;
    }
    sampler.ok_or_else(|| anyhow!("null sampler"))
}

fn create_composite_cbuffer(device: &ID3D11Device) -> Result<ID3D11Buffer> {
    let initial = CompositeParams {
        has_overlay: 0,
        _pad: [0; 3],
    };
    // 16-byte-aligned per D3D11 cbuffer rules; CompositeParams is exactly 16 bytes.
    let byte_width = std::mem::size_of::<CompositeParams>() as u32;
    let desc = D3D11_BUFFER_DESC {
        ByteWidth: byte_width,
        Usage: D3D11_USAGE_DYNAMIC,
        BindFlags: D3D11_BIND_CONSTANT_BUFFER.0 as u32,
        CPUAccessFlags: D3D11_CPU_ACCESS_WRITE.0 as u32,
        MiscFlags: 0,
        StructureByteStride: 0,
    };
    let init = D3D11_SUBRESOURCE_DATA {
        pSysMem: &initial as *const _ as *const std::ffi::c_void,
        SysMemPitch: 0,
        SysMemSlicePitch: 0,
    };
    let mut buffer: Option<ID3D11Buffer> = None;
    unsafe {
        device
            .CreateBuffer(&desc, Some(&init), Some(&mut buffer))
            .context("CreateBuffer composite cbuffer")?;
    }
    buffer.ok_or_else(|| anyhow!("null composite cbuffer"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::Foundation::HMODULE;
    use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_WARP, D3D_FEATURE_LEVEL_11_0};
    use windows::Win32::Graphics::Direct3D11::{
        D3D11CreateDevice, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_SDK_VERSION,
    };

    fn warp_device() -> ID3D11Device {
        let mut device: Option<ID3D11Device> = None;
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
                None,
            )
            .expect("WARP device");
        }
        device.expect("null WARP device")
    }

    #[test]
    fn compositor_constructs_on_warp() {
        let device = warp_device();
        let comp = Compositor::new(&device, 64, 64).expect("Compositor::new");
        assert_eq!(comp.output_dimensions(), (64, 64));
    }

    #[test]
    fn compositor_rejects_odd_dimensions() {
        let device = warp_device();
        assert!(Compositor::new(&device, 63, 64).is_err());
        assert!(Compositor::new(&device, 64, 63).is_err());
    }

    /// Build a BGRA texture filled with a constant (b, g, r, 255) and
    /// return it along with an SRV. WARP-safe — `D3D11_USAGE_DEFAULT`
    /// with `UpdateSubresource` covers the write.
    fn solid_bgra_texture(
        device: &ID3D11Device,
        width: u32,
        height: u32,
        b: u8,
        g: u8,
        r: u8,
    ) -> (ID3D11Texture2D, ID3D11ShaderResourceView) {
        let pixels: Vec<u8> = (0..(width * height))
            .flat_map(|_| [b, g, r, 255])
            .collect();

        let desc = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        let init = D3D11_SUBRESOURCE_DATA {
            pSysMem: pixels.as_ptr() as *const _,
            SysMemPitch: width * 4,
            SysMemSlicePitch: 0,
        };
        let mut tex: Option<ID3D11Texture2D> = None;
        unsafe {
            device
                .CreateTexture2D(&desc, Some(&init), Some(&mut tex))
                .expect("solid BGRA texture");
        }
        let tex = tex.expect("null solid BGRA texture");

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
                .expect("solid BGRA SRV");
        }
        (tex, srv.expect("null solid BGRA SRV"))
    }

    /// Compare GPU and CPU NV12 bytes with a per-byte tolerance. The CPU
    /// path uses (×256) integer coefficients; HLSL runs the same integers
    /// in fp32 normalized space, so single-LSB rounding mismatches are
    /// expected. ±3 keeps the test signal-bearing — the failure mode we
    /// care about (a transposed coefficient or wrong offset) blows past
    /// this by orders of magnitude.
    fn assert_nv12_parity(gpu: &[u8], cpu: &[u8], y_len: usize, label: &str) {
        assert_eq!(gpu.len(), cpu.len(), "{label}: NV12 byte length mismatch");
        for i in 0..y_len {
            let diff = (gpu[i] as i32 - cpu[i] as i32).abs();
            assert!(diff <= 3, "{label} Y[{i}] GPU={} CPU={} diff={}", gpu[i], cpu[i], diff);
        }
        for i in y_len..gpu.len() {
            let diff = (gpu[i] as i32 - cpu[i] as i32).abs();
            assert!(diff <= 3, "{label} UV[{i}] GPU={} CPU={} diff={}", gpu[i], cpu[i], diff);
        }
    }

    /// End-to-end render check on WARP: push a solid-red 16×16 BGRA
    /// source through the compositor and verify the resulting NV12 bytes
    /// match what `convert::bgra_to_nv12` produces on the same input.
    ///
    /// WARP uses the reference rasterizer so any difference here means
    /// the HLSL ports of the BT.709 math diverge from the integer path —
    /// which would fail the pixel-parity A/B.
    #[test]
    fn compositor_solid_red_matches_cpu() {
        let device = warp_device();
        let comp = Compositor::new(&device, 16, 16).expect("Compositor::new");

        let (_tex, srv) = solid_bgra_texture(&device, 16, 16, 0, 0, 255);
        comp.composite_and_convert(&srv, None).expect("composite");
        let gpu_nv12 = comp.map_nv12().expect("map nv12");

        let mut cpu_src = Vec::with_capacity(16 * 16 * 4);
        for _ in 0..(16 * 16) {
            cpu_src.extend_from_slice(&[0, 0, 255, 255]);
        }
        let mut cpu_nv12 = vec![0u8; crate::convert::nv12_byte_len(16, 16)];
        crate::convert::bgra_to_nv12(&cpu_src, 16, 16, &mut cpu_nv12);

        assert_nv12_parity(&gpu_nv12, &cpu_nv12, 16 * 16, "red");
    }

    /// Sweep solid colors across the BT.709 luma+chroma space. Each
    /// channel gets exercised independently plus a few mixes — catches
    /// HLSL coefficient transpositions or sign flips that solid-red
    /// alone would miss (red happens to put the largest weight on Cr).
    #[test]
    fn compositor_solid_colors_match_cpu() {
        let device = warp_device();
        let comp = Compositor::new(&device, 16, 16).expect("Compositor::new");

        let cases: &[(&str, u8, u8, u8)] = &[
            ("black",     0,   0,   0),
            ("white",   255, 255, 255),
            ("blue",    255,   0,   0),
            ("green",     0, 255,   0),
            ("gray",    128, 128, 128),
            ("magenta", 255,   0, 255),
            ("yellow",    0, 255, 255),
        ];
        for (label, b, g, r) in cases.iter().copied() {
            let (_tex, srv) = solid_bgra_texture(&device, 16, 16, b, g, r);
            comp.composite_and_convert(&srv, None).expect("composite");
            let gpu_nv12 = comp.map_nv12().expect("map nv12");

            let mut cpu_src = Vec::with_capacity(16 * 16 * 4);
            for _ in 0..(16 * 16) {
                cpu_src.extend_from_slice(&[b, g, r, 255]);
            }
            let mut cpu_nv12 = vec![0u8; crate::convert::nv12_byte_len(16, 16)];
            crate::convert::bgra_to_nv12(&cpu_src, 16, 16, &mut cpu_nv12);

            assert_nv12_parity(&gpu_nv12, &cpu_nv12, 16 * 16, label);
        }
    }

    /// Overlay path: a fully-opaque blue overlay over a solid-red capture
    /// must equal a solid-blue input on the CPU side. Verifies the
    /// PS_COMPOSITE branch and the straight-alpha "over" math match the
    /// CPU `overlay::composite` function at α=255.
    #[test]
    fn compositor_opaque_overlay_replaces_capture() {
        let device = warp_device();
        let comp = Compositor::new(&device, 16, 16).expect("Compositor::new");

        let (_cap_tex, cap_srv) = solid_bgra_texture(&device, 16, 16, 0, 0, 255); // red
        let (_ov_tex, ov_srv) = solid_bgra_texture(&device, 16, 16, 255, 0, 0);   // blue, fully opaque (α=255 baked in by helper)
        comp.composite_and_convert(&cap_srv, Some(&ov_srv)).expect("composite");
        let gpu_nv12 = comp.map_nv12().expect("map nv12");

        // CPU truth: a solid blue input. The overlay::composite "over"
        // math at α=255 must collapse to "ignore capture, take overlay."
        let mut cpu_src = Vec::with_capacity(16 * 16 * 4);
        for _ in 0..(16 * 16) {
            cpu_src.extend_from_slice(&[255, 0, 0, 255]);
        }
        let mut cpu_nv12 = vec![0u8; crate::convert::nv12_byte_len(16, 16)];
        crate::convert::bgra_to_nv12(&cpu_src, 16, 16, &mut cpu_nv12);

        assert_nv12_parity(&gpu_nv12, &cpu_nv12, 16 * 16, "opaque-blue-over-red");
    }

    /// Overlay path with α=0: must be a no-op. The composited output
    /// should match the capture as if no overlay were present.
    #[test]
    fn compositor_transparent_overlay_is_noop() {
        let device = warp_device();
        let comp = Compositor::new(&device, 16, 16).expect("Compositor::new");

        let (_cap_tex, cap_srv) = solid_bgra_texture(&device, 16, 16, 0, 255, 0); // green capture
        // Build a fully-transparent overlay manually — solid_bgra_texture
        // forces α=255, so we need a custom helper here.
        let (_ov_tex, ov_srv) = bgra_texture_with_alpha(&device, 16, 16, 0, 0, 255, 0);

        comp.composite_and_convert(&cap_srv, Some(&ov_srv)).expect("composite with α=0 overlay");
        let gpu_nv12 = comp.map_nv12().expect("map nv12");

        let mut cpu_src = Vec::with_capacity(16 * 16 * 4);
        for _ in 0..(16 * 16) {
            cpu_src.extend_from_slice(&[0, 255, 0, 255]);
        }
        let mut cpu_nv12 = vec![0u8; crate::convert::nv12_byte_len(16, 16)];
        crate::convert::bgra_to_nv12(&cpu_src, 16, 16, &mut cpu_nv12);

        assert_nv12_parity(&gpu_nv12, &cpu_nv12, 16 * 16, "transparent-overlay");
    }

    fn bgra_texture_with_alpha(
        device: &ID3D11Device,
        width: u32,
        height: u32,
        b: u8,
        g: u8,
        r: u8,
        a: u8,
    ) -> (ID3D11Texture2D, ID3D11ShaderResourceView) {
        let pixels: Vec<u8> = (0..(width * height))
            .flat_map(|_| [b, g, r, a])
            .collect();
        let desc = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        let init = D3D11_SUBRESOURCE_DATA {
            pSysMem: pixels.as_ptr() as *const _,
            SysMemPitch: width * 4,
            SysMemSlicePitch: 0,
        };
        let mut tex: Option<ID3D11Texture2D> = None;
        unsafe {
            device
                .CreateTexture2D(&desc, Some(&init), Some(&mut tex))
                .expect("alpha BGRA texture");
        }
        let tex = tex.expect("null alpha BGRA texture");
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
                .expect("alpha BGRA SRV");
        }
        (tex, srv.expect("null alpha BGRA SRV"))
    }
}
