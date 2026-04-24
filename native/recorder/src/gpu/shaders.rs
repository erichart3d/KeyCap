//! HLSL shader sources + `D3DCompile` wrappers for the GPU compositor.
//!
//! Three pixel shaders + one vertex shader:
//!
//! - `VS_MAIN` — fullscreen triangle from `SV_VertexID` (no VB/IB).
//! - `PS_COMPOSITE` — samples capture BGRA and optionally an overlay
//!   BGRA (straight-alpha), returns composited BGRA.
//! - `PS_Y` — samples BGRA, outputs single-channel BT.709 limited-range
//!   luma into an R8 render target.
//! - `PS_UV` — samples BGRA, 2×2 box-averages + converts, outputs
//!   (Cb, Cr) into an R8G8 render target at half resolution.
//!
//! The BT.709 coefficients are a literal port of the fixed-point math in
//! `convert::bgra_to_nv12` (see `convert.rs:78-96`). Any drift between
//! CPU and GPU paths blows the pixel-parity A/B test so keep these two
//! in lockstep.

#![cfg(windows)]
#![allow(dead_code)] // shaders are consumed by the Compositor constructor below

use anyhow::{anyhow, Context as _, Result};
use windows::core::{s, PCSTR};
use windows::Win32::Graphics::Direct3D::Fxc::{D3DCompile, D3DCOMPILE_OPTIMIZATION_LEVEL3};
use windows::Win32::Graphics::Direct3D::ID3DBlob;

/// Fullscreen triangle generated from `SV_VertexID` — saves the input
/// layout + vertex buffer bind + index buffer bind.
pub const VS_MAIN: &str = r#"
struct VSOut {
    float4 pos : SV_Position;
    float2 uv  : TEXCOORD0;
};

VSOut vs_main(uint id : SV_VertexID) {
    VSOut o;
    o.uv  = float2(float((id << 1) & 2), float(id & 2));
    o.pos = float4(o.uv * float2(2.0, -2.0) + float2(-1.0, 1.0), 0.0, 1.0);
    return o;
}
"#;

/// Composite the overlay over the capture. Overlay uses straight alpha
/// (the OverlayFrame ring delivers premultiplied=false BGRA from the
/// Electron OSR window), so we do a standard "over" composite. Premultiply
/// at sample time to match `overlay::composite` on the CPU path.
///
/// When `has_overlay == 0`, the shader short-circuits to just the capture
/// sample; the overlay SRV can be left null in that case.
pub const PS_COMPOSITE: &str = r#"
Texture2D<float4> capture_tex : register(t0);
Texture2D<float4> overlay_tex : register(t1);
SamplerState      samp        : register(s0);

cbuffer Params : register(b0) {
    uint has_overlay;
    uint3 _pad;
};

float4 ps_composite(float4 pos : SV_Position, float2 uv : TEXCOORD0) : SV_Target {
    float4 cap = capture_tex.Sample(samp, uv);
    if (has_overlay != 0) {
        float4 ov = overlay_tex.Sample(samp, uv);
        // Straight-alpha over: result.rgb = ov.rgb*ov.a + cap.rgb*(1-ov.a)
        float3 rgb = ov.rgb * ov.a + cap.rgb * (1.0 - ov.a);
        return float4(rgb, 1.0);
    }
    return float4(cap.rgb, 1.0);
}
"#;

/// BGRA → BT.709 limited-range Y, written into an R8 render target.
/// Coefficients are the float form of `convert.rs:78-84` (`(47, 157, 16) / 256`
/// applied to 0..255 inputs → `/256` applied to 0..1 inputs), with the
/// same `+16/255` black-pedestal offset.
pub const PS_Y: &str = r#"
Texture2D<float4> src  : register(t0);
SamplerState      samp : register(s0);

float4 ps_y(float4 pos : SV_Position, float2 uv : TEXCOORD0) : SV_Target {
    float3 rgb = src.Sample(samp, uv).rgb;
    float y = 16.0/255.0 + (47.0 * rgb.r + 157.0 * rgb.g + 16.0 * rgb.b) / 256.0;
    return float4(y, 0.0, 0.0, 1.0);
}
"#;

/// BGRA → BT.709 limited-range (Cb, Cr), written into an R8G8 render
/// target at half horizontal and vertical resolution. The shader samples
/// 2×2 BGRA texels and averages before converting, matching the CPU
/// path's chroma box filter (`convert.rs:92-96`). Coefficients are the
/// float form of `(−26, −86, 112) / 256` for Cb and `(112, −102, −10) / 256`
/// for Cr — same integers convert.rs uses, divided for the float path.
pub const PS_UV: &str = r#"
Texture2D<float4> src  : register(t0);
SamplerState      samp : register(s0);

float4 ps_uv(float4 pos : SV_Position, float2 uv : TEXCOORD0) : SV_Target {
    // GetDimensions gives full BGRA source dims. The UV RT is half the
    // size in each axis, so texture coords `uv` already map to a 2×2 box
    // in source. Offset by half a source texel to land on the 4 centers.
    float2 sdim;
    src.GetDimensions(sdim.x, sdim.y);
    float2 off = 0.5 / sdim;

    float3 s00 = src.Sample(samp, uv + float2(-off.x, -off.y)).rgb;
    float3 s01 = src.Sample(samp, uv + float2( off.x, -off.y)).rgb;
    float3 s10 = src.Sample(samp, uv + float2(-off.x,  off.y)).rgb;
    float3 s11 = src.Sample(samp, uv + float2( off.x,  off.y)).rgb;
    float3 rgb = (s00 + s01 + s10 + s11) * 0.25;

    float cb = 128.0/255.0 + (-26.0 * rgb.r - 86.0 * rgb.g + 112.0 * rgb.b) / 256.0;
    float cr = 128.0/255.0 + (112.0 * rgb.r - 102.0 * rgb.g -  10.0 * rgb.b) / 256.0;
    return float4(cb, cr, 0.0, 1.0);
}
"#;

pub struct CompiledShader {
    pub blob: ID3DBlob,
}

impl CompiledShader {
    pub fn bytecode(&self) -> &[u8] {
        unsafe {
            let ptr = self.blob.GetBufferPointer() as *const u8;
            let len = self.blob.GetBufferSize();
            std::slice::from_raw_parts(ptr, len)
        }
    }
}

/// Compile an HLSL shader source. `entry` is the function name inside the
/// source, `target` is the SM profile like `vs_5_0` / `ps_5_0`.
pub fn compile(source: &str, entry: PCSTR, target: PCSTR, name: &str) -> Result<CompiledShader> {
    let mut blob: Option<ID3DBlob> = None;
    let mut errors: Option<ID3DBlob> = None;

    let src_bytes = source.as_bytes();
    let src_ptr = src_bytes.as_ptr() as *const std::ffi::c_void;
    let src_len = src_bytes.len();

    // Flags: maximum optimization. We compile once at session start so the
    // ~50–150 ms `fxc` cost is invisible.
    let flags = D3DCOMPILE_OPTIMIZATION_LEVEL3;

    let hr = unsafe {
        D3DCompile(
            src_ptr,
            src_len,
            PCSTR::null(),
            None,
            None,
            entry,
            target,
            flags,
            0,
            &mut blob,
            Some(&mut errors),
        )
    };

    if let Err(e) = hr {
        let msg = errors
            .as_ref()
            .map(|b| unsafe {
                let p = b.GetBufferPointer() as *const u8;
                let len = b.GetBufferSize();
                let slice = std::slice::from_raw_parts(p, len);
                String::from_utf8_lossy(slice).into_owned()
            })
            .unwrap_or_else(|| format!("{e}"));
        return Err(anyhow!("D3DCompile({name}): {msg}"));
    }

    let blob = blob.ok_or_else(|| anyhow!("D3DCompile({name}) returned null blob"))?;
    Ok(CompiledShader { blob })
}

pub fn compile_vs_main() -> Result<CompiledShader> {
    compile(VS_MAIN, s!("vs_main"), s!("vs_5_0"), "VS_MAIN").context("compile VS_MAIN")
}

pub fn compile_ps_composite() -> Result<CompiledShader> {
    compile(PS_COMPOSITE, s!("ps_composite"), s!("ps_5_0"), "PS_COMPOSITE")
        .context("compile PS_COMPOSITE")
}

pub fn compile_ps_y() -> Result<CompiledShader> {
    compile(PS_Y, s!("ps_y"), s!("ps_5_0"), "PS_Y").context("compile PS_Y")
}

pub fn compile_ps_uv() -> Result<CompiledShader> {
    compile(PS_UV, s!("ps_uv"), s!("ps_5_0"), "PS_UV").context("compile PS_UV")
}

#[cfg(test)]
mod tests {
    use super::*;

    // Shader compilation runs on the CPU side — no device required. If
    // these succeed we know the HLSL parses and the fxc library loads;
    // pipeline-state creation (which needs a device) is unit-tested in
    // `compositor::tests`.
    #[test]
    fn vs_main_compiles() {
        compile_vs_main().expect("VS_MAIN should compile");
    }

    #[test]
    fn ps_composite_compiles() {
        compile_ps_composite().expect("PS_COMPOSITE should compile");
    }

    #[test]
    fn ps_y_compiles() {
        compile_ps_y().expect("PS_Y should compile");
    }

    #[test]
    fn ps_uv_compiles() {
        compile_ps_uv().expect("PS_UV should compile");
    }
}
