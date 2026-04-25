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
//!
//! ## Threading discipline (Bite 1.5)
//!
//! The compositor shares its `ID3D11DeviceContext` with the DDA capture
//! thread via an `Arc<Mutex<...>>`. To keep the lock-hold short and to
//! bound the readback time, work is split into two phases:
//!
//! 1. **Submit phase** — under the lock, record all three draws + the two
//!    `CopyResource` calls into the staging textures, then `Flush()` to
//!    kick the GPU. The lock drops at the end of this scope.
//! 2. **Readback phase** — without the lock held, poll
//!    `Map(D3D11_MAP_FLAG_DO_NOT_WAIT)` on each staging. Each poll
//!    re-acquires the lock just long enough to call `Map`; if the GPU
//!    isn't ready yet, the call returns `DXGI_ERROR_WAS_STILL_DRAWING`,
//!    we sleep `MAP_POLL_INTERVAL`, and try again. Total wait is bounded
//!    by `MAP_READBACK_TIMEOUT`; on timeout we read
//!    `GetDeviceRemovedReason` and return an error so the session disables
//!    the GPU path instead of hanging the composite thread (which would
//!    hang `Session::stop()` because it joins on this thread).
//!
//! Earlier revisions of this file tried two other patterns:
//!
//! - **Single blocking `Map(READ)` under the lock** — simplest, but `Map`
//!   has no timeout, so a wedged GPU (TDR / hung shader / driver bug)
//!   stalled the composite thread forever and `Session::stop()` blocked
//!   waiting on it. Reproduced at 4K on real NVIDIA hardware.
//! - **Fence + `SetEventOnCompletion` wait off-context** — the wait
//!   itself doesn't need the context, but on at least one NVIDIA driver
//!   path `Map(READ)` returned `E_OUTOFMEMORY` when the staging copy was
//!   queued from one lock-acquire and `Map`-ed from a different one,
//!   apparently because some flushed-state tracking didn't carry over.
//!
//! Polled-`DO_NOT_WAIT` Map sidesteps both: the staging copy and the
//! `Map` happen in the same call sequence, but the wait between them is
//! bounded and lock-friendly.

#![cfg(windows)]
#![allow(dead_code)] // wired into the composite thread in a later bite step

use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context as _, Result};
use parking_lot::Mutex;
use windows::Win32::Graphics::Direct3D::{
    D3D11_SRV_DIMENSION_TEXTURE2D, D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST,
};
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Buffer, ID3D11Device, ID3D11DeviceContext, ID3D11PixelShader, ID3D11RenderTargetView,
    ID3D11Resource, ID3D11SamplerState, ID3D11ShaderResourceView, ID3D11Texture2D,
    ID3D11VertexShader, D3D11_BIND_CONSTANT_BUFFER, D3D11_BIND_RENDER_TARGET,
    D3D11_BIND_SHADER_RESOURCE, D3D11_BUFFER_DESC, D3D11_COMPARISON_NEVER, D3D11_CPU_ACCESS_READ,
    D3D11_CPU_ACCESS_WRITE, D3D11_FILTER_MIN_MAG_MIP_LINEAR, D3D11_MAP_FLAG_DO_NOT_WAIT,
    D3D11_MAP_READ, D3D11_MAP_WRITE_DISCARD, D3D11_MAPPED_SUBRESOURCE,
    D3D11_RENDER_TARGET_VIEW_DESC, D3D11_RENDER_TARGET_VIEW_DESC_0, D3D11_RESOURCE_MISC_FLAG,
    D3D11_RTV_DIMENSION_TEXTURE2D, D3D11_SAMPLER_DESC, D3D11_SHADER_RESOURCE_VIEW_DESC,
    D3D11_SHADER_RESOURCE_VIEW_DESC_0, D3D11_SUBRESOURCE_DATA, D3D11_TEX2D_RTV, D3D11_TEX2D_SRV,
    D3D11_TEXTURE2D_DESC, D3D11_TEXTURE_ADDRESS_CLAMP, D3D11_USAGE_DEFAULT, D3D11_USAGE_DYNAMIC,
    D3D11_USAGE_STAGING, D3D11_VIEWPORT,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_R8G8_UNORM, DXGI_FORMAT_R8_UNORM, DXGI_SAMPLE_DESC,
};
use windows::Win32::Graphics::Dxgi::DXGI_ERROR_WAS_STILL_DRAWING;
use windows::core::Interface;

/// Maximum time we'll wait for `Map(D3D11_MAP_READ)` on the NV12 stagings
/// before giving up and disabling the GPU path. Steady-state at 4K60 a
/// healthy NVIDIA driver completes the readback in 3–5 ms, but the very
/// first frame after session start triggers driver-side pipeline-state
/// compilation that can stall `Flush` / first `Map(READ)` for
/// 500–1500 ms on real hardware. We pick a generous 2 s ceiling so the
/// once-per-session compile never trips the bound, while still catching
/// real hangs (TDR, hung shader on another process, driver bug) — which
/// would otherwise block `Session::stop()` indefinitely because the
/// composite thread never returns from `Map`.
const MAP_READBACK_TIMEOUT: Duration = Duration::from_millis(2000);
/// Sleep between non-blocking Map polls. 1 ms is a tradeoff between
/// responsiveness (lower keeps Map latency tight on the happy path) and
/// CPU burn (higher is friendlier when the GPU genuinely needs longer).
const MAP_POLL_INTERVAL: Duration = Duration::from_millis(1);

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
/// overlay uploads live in `gpu::bgra_upload`. It also does NOT own the
/// `ID3D11DeviceContext` exclusively; the DDA capture thread holds the
/// other Arc reference and the two threads coordinate through the mutex.
pub struct Compositor {
    device: ID3D11Device,
    context: Arc<Mutex<ID3D11DeviceContext>>,

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
    /// `device` and `context` are shared with the DDA capture thread —
    /// the compositor takes one `Arc` clone of each. The mutex enforces
    /// single-threaded access to the immediate context per D3D11's API
    /// threading rules.
    ///
    /// `out_width` / `out_height` must be even (NV12 chroma subsampling).
    pub fn new(
        device: &ID3D11Device,
        context: Arc<Mutex<ID3D11DeviceContext>>,
        out_width: u32,
        out_height: u32,
    ) -> Result<Self> {
        if out_width % 2 != 0 || out_height % 2 != 0 {
            return Err(anyhow!(
                "compositor output dims must be even (got {out_width}x{out_height})"
            ));
        }

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

    /// Run the three passes and read back tight NV12 bytes. `capture_srv`
    /// is an SRV over the capture texture (any BGRA format sampleable as
    /// float4). `overlay_srv` is optional — when `None`, the composite
    /// pass uses only the capture.
    ///
    /// Holds the shared context lock across submit + Flush, then drops it
    /// and polls `Map(D3D11_MAP_FLAG_DO_NOT_WAIT)` with a short sleep
    /// between attempts. This keeps DDA's CopyResource interleaved during
    /// the GPU readback wait and — critically — bounds the wait so a
    /// wedged GPU surfaces as an error instead of an infinite hang in the
    /// composite thread (which would hang `Session::stop()` too).
    pub fn composite_and_convert_to_nv12(
        &self,
        capture_srv: &ID3D11ShaderResourceView,
        overlay_srv: Option<&ID3D11ShaderResourceView>,
    ) -> Result<Vec<u8>> {
        let w = self.out_width as usize;
        let h = self.out_height as usize;
        let y_bytes = w * h;
        let uv_bytes = w * h / 2;
        let total = y_bytes + uv_bytes;
        let mut out = Vec::with_capacity(total);
        #[allow(clippy::uninit_vec)]
        unsafe {
            out.set_len(total);
        }

        // ── Phase 1: submit + Flush under the lock ─────────────────────
        // Records all three passes + the staging copies, then Flush kicks
        // them to the GPU. The lock is released at the end of this scope
        // so the DDA thread can run its own CopyResource while the GPU
        // chews on our work.
        {
            let ctx = self.context.lock();
            unsafe {
                // Upload the composite params cbuffer.
                let params = CompositeParams {
                    has_overlay: if overlay_srv.is_some() { 1 } else { 0 },
                    _pad: [0; 3],
                };
                let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
                ctx.Map(&self.composite_cbuf, 0, D3D11_MAP_WRITE_DISCARD, 0, Some(&mut mapped))
                    .context("Map composite cbuffer")?;
                std::ptr::copy_nonoverlapping(
                    &params as *const _ as *const u8,
                    mapped.pData as *mut u8,
                    std::mem::size_of::<CompositeParams>(),
                );
                ctx.Unmap(&self.composite_cbuf, 0);

                // Shared pipeline state.
                ctx.IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
                ctx.IASetInputLayout(None);
                ctx.VSSetShader(&self.vs, None);
                let samplers = [Some(self.sampler.clone())];
                ctx.PSSetSamplers(0, Some(&samplers));

                // ── Pass 1: composite ───────────────────────────────────
                let rtvs: [Option<ID3D11RenderTargetView>; 1] =
                    [Some(self.intermediate_rtv.clone())];
                ctx.OMSetRenderTargets(Some(&rtvs), None);

                let srvs: [Option<ID3D11ShaderResourceView>; 2] = [
                    Some(capture_srv.clone()),
                    overlay_srv.cloned(),
                ];
                ctx.PSSetShaderResources(0, Some(&srvs));

                let cbufs = [Some(self.composite_cbuf.clone())];
                ctx.PSSetConstantBuffers(0, Some(&cbufs));

                ctx.PSSetShader(&self.ps_composite, None);
                set_viewport(&ctx, self.out_width, self.out_height);
                ctx.Draw(3, 0);

                // Unbind intermediate RT before using it as SRV.
                let no_rtv: [Option<ID3D11RenderTargetView>; 1] = [None];
                ctx.OMSetRenderTargets(Some(&no_rtv), None);

                // ── Pass 2: Y ──────────────────────────────────────────
                let rtvs: [Option<ID3D11RenderTargetView>; 1] = [Some(self.y_rtv.clone())];
                ctx.OMSetRenderTargets(Some(&rtvs), None);
                let srvs: [Option<ID3D11ShaderResourceView>; 2] =
                    [Some(self.intermediate_srv.clone()), None];
                ctx.PSSetShaderResources(0, Some(&srvs));
                ctx.PSSetShader(&self.ps_y, None);
                set_viewport(&ctx, self.out_width, self.out_height);
                ctx.Draw(3, 0);

                ctx.OMSetRenderTargets(Some(&no_rtv), None);

                // ── Pass 3: UV (half-res) ──────────────────────────────
                let rtvs: [Option<ID3D11RenderTargetView>; 1] = [Some(self.uv_rtv.clone())];
                ctx.OMSetRenderTargets(Some(&rtvs), None);
                let srvs: [Option<ID3D11ShaderResourceView>; 2] =
                    [Some(self.intermediate_srv.clone()), None];
                ctx.PSSetShaderResources(0, Some(&srvs));
                ctx.PSSetShader(&self.ps_uv, None);
                set_viewport(&ctx, self.out_width / 2, self.out_height / 2);
                ctx.Draw(3, 0);

                ctx.OMSetRenderTargets(Some(&no_rtv), None);

                // Copy RT → staging for CPU readback.
                ctx.CopyResource(&self.y_staging, &self.y_rt);
                ctx.CopyResource(&self.uv_staging, &self.uv_rt);

                // Submit the queued draws + copies to the GPU.
                ctx.Flush();
            }
        }

        // ── Phase 2: poll-Map both stagings off the lock ───────────────
        // Map(DO_NOT_WAIT) returns immediately with `WAS_STILL_DRAWING`
        // until the GPU has the data ready. Sleep + retry; on overall
        // timeout, check device-removed reason and bail.
        let y_resource: ID3D11Resource =
            self.y_staging.cast().context("cast Y staging to ID3D11Resource")?;
        let uv_resource: ID3D11Resource =
            self.uv_staging.cast().context("cast UV staging to ID3D11Resource")?;

        // Y plane.
        unsafe {
            self.read_staging_into(
                &y_resource,
                out.as_mut_ptr(),
                w,
                h,
                w, // tight Y row stride = width
                "Y staging",
            )?;
        }

        // UV plane.
        unsafe {
            let uv_row_bytes = w; // (w/2 R8G8 pairs) × 2 bytes = w
            let uv_rows = h / 2;
            self.read_staging_into(
                &uv_resource,
                out.as_mut_ptr().add(y_bytes),
                w,
                uv_rows,
                uv_row_bytes,
                "UV staging",
            )?;
        }

        Ok(out)
    }

    /// Map a staging texture with `D3D11_MAP_FLAG_DO_NOT_WAIT`, polling
    /// until ready or `MAP_READBACK_TIMEOUT` elapses. Each lock-acquire
    /// is brief so the DDA thread can interleave its own work.
    ///
    /// On success, copies `rows × tight_row_bytes` bytes (handling the
    /// staging row-pitch padding) into `dst`.
    ///
    /// `dst` must point to a writable allocation of at least
    /// `rows * tight_row_bytes` bytes; the caller owns lifetime.
    /// `tight_row_bytes` and `_w` are passed for parity with the previous
    /// inline copy (`_w` is unused but kept for clarity at the call site).
    unsafe fn read_staging_into(
        &self,
        resource: &ID3D11Resource,
        dst: *mut u8,
        _w: usize,
        rows: usize,
        tight_row_bytes: usize,
        what: &'static str,
    ) -> Result<()> {
        let start = Instant::now();
        let flags = D3D11_MAP_FLAG_DO_NOT_WAIT.0 as u32;
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();

        loop {
            let attempt = {
                let ctx = self.context.lock();
                ctx.Map(resource, 0, D3D11_MAP_READ, flags, Some(&mut mapped))
            };
            match attempt {
                Ok(()) => break,
                Err(e) if e.code() == DXGI_ERROR_WAS_STILL_DRAWING => {
                    if start.elapsed() > MAP_READBACK_TIMEOUT {
                        // Most likely a TDR or hung GPU. Surface device-
                        // removed reason if any so the operator log makes
                        // the failure mode obvious.
                        let dev_removed = self.device.GetDeviceRemovedReason();
                        return Err(anyhow!(
                            "Map {what} timed out after {:?} (device removed: {:?})",
                            start.elapsed(),
                            dev_removed
                        ));
                    }
                    std::thread::sleep(MAP_POLL_INTERVAL);
                }
                Err(e) => {
                    return Err(anyhow!("Map {what} failed: {e}"));
                }
            }
        }

        let row_pitch = mapped.RowPitch as usize;
        let src = mapped.pData as *const u8;
        if row_pitch == tight_row_bytes {
            std::ptr::copy_nonoverlapping(src, dst, rows * tight_row_bytes);
        } else {
            for y in 0..rows {
                let s = src.add(y * row_pitch);
                let d = dst.add(y * tight_row_bytes);
                std::ptr::copy_nonoverlapping(s, d, tight_row_bytes);
            }
        }
        {
            let ctx = self.context.lock();
            ctx.Unmap(resource, 0);
        }
        Ok(())
    }

    /// Run the three passes into the planar RTVs of an `Nv12Slot` and
    /// `Flush`. Zero CPU readback — the caller (the MF encoder backend)
    /// hands `slot.texture` directly to `MFCreateDXGISurfaceBuffer` and
    /// queues an `IMFSample` for the encoder.
    ///
    /// Mirror of [`Self::composite_and_convert_to_nv12`] without the
    /// staging-copy + Map phase. The shaders are byte-identical: Pass 1
    /// composites capture+overlay into `intermediate_rt`, Pass 2 writes
    /// BT.709 limited-range Y into `slot.y_rtv` (the NV12 texture's Y
    /// plane), Pass 3 writes (Cb, Cr) into `slot.uv_rtv` (the NV12
    /// texture's UV plane at half resolution).
    ///
    /// Holds the shared context lock only for the submit + Flush — same
    /// as the existing path's Phase 1 — and returns immediately. There
    /// is no `Map(WAS_STILL_DRAWING)` poll on this path because there
    /// is no readback to wait for; whatever GPU contention exists, our
    /// composite thread no longer blocks on it.
    pub fn composite_into_nv12_slot(
        &self,
        capture_srv: &ID3D11ShaderResourceView,
        overlay_srv: Option<&ID3D11ShaderResourceView>,
        slot: &crate::gpu::nv12_ring::Nv12Slot,
    ) -> Result<()> {
        // Producer half of the keyed-mutex handoff. Acquire with key=0:
        // blocks if the encoder MFT is still holding the slot from a
        // previous frame (which is the desired backpressure when the
        // ring wraps). The texture's initial state is "released with
        // key=0", so the very first acquire is non-blocking.
        //
        // After we Flush, ReleaseSync(1) hands the slot to the
        // consumer. The MF encoder MFT (auto via IMFDXGIBuffer) will
        // AcquireSync(1) before reading and ReleaseSync(0) when done.
        //
        // 5-second timeout is a paranoia bound: at ring depth 16 and
        // 30+ fps we should never wait more than ~16 frames worth
        // (~530 ms) for the encoder to release a slot. Anything past
        // 5 s means the encoder is wedged and we should surface an
        // error rather than block the composite thread forever.
        // Cross-device acquire: ~5–10 ms steady-state on real hardware
        // (the sync primitive crosses the kernel boundary). Only warn
        // if this runs catastrophically long, indicating the encoder
        // is genuinely stuck rather than just doing its job.
        let acquire_start = Instant::now();
        unsafe {
            slot.keyed_mutex
                .AcquireSync(0, 5_000)
                .context("IDXGIKeyedMutex::AcquireSync(0) before composite")?;
        }
        let acquire_ms = acquire_start.elapsed().as_secs_f64() * 1000.0;
        if acquire_ms > 100.0 {
            tracing::warn!(
                acquire_ms,
                "Nv12Slot AcquireSync(0) took >100ms — encoder is back-pressuring composite"
            );
        }
        let ctx = self.context.lock();
        unsafe {
            // Upload the composite params cbuffer.
            let params = CompositeParams {
                has_overlay: if overlay_srv.is_some() { 1 } else { 0 },
                _pad: [0; 3],
            };
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            ctx.Map(&self.composite_cbuf, 0, D3D11_MAP_WRITE_DISCARD, 0, Some(&mut mapped))
                .context("Map composite cbuffer")?;
            std::ptr::copy_nonoverlapping(
                &params as *const _ as *const u8,
                mapped.pData as *mut u8,
                std::mem::size_of::<CompositeParams>(),
            );
            ctx.Unmap(&self.composite_cbuf, 0);

            // Shared pipeline state.
            ctx.IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
            ctx.IASetInputLayout(None);
            ctx.VSSetShader(&self.vs, None);
            let samplers = [Some(self.sampler.clone())];
            ctx.PSSetSamplers(0, Some(&samplers));

            // ── Pass 1: composite into intermediate ─────────────────────
            let rtvs: [Option<ID3D11RenderTargetView>; 1] =
                [Some(self.intermediate_rtv.clone())];
            ctx.OMSetRenderTargets(Some(&rtvs), None);

            let srvs: [Option<ID3D11ShaderResourceView>; 2] =
                [Some(capture_srv.clone()), overlay_srv.cloned()];
            ctx.PSSetShaderResources(0, Some(&srvs));

            let cbufs = [Some(self.composite_cbuf.clone())];
            ctx.PSSetConstantBuffers(0, Some(&cbufs));

            ctx.PSSetShader(&self.ps_composite, None);
            set_viewport(&ctx, self.out_width, self.out_height);
            ctx.Draw(3, 0);

            // Unbind intermediate RT before sampling it.
            let no_rtv: [Option<ID3D11RenderTargetView>; 1] = [None];
            ctx.OMSetRenderTargets(Some(&no_rtv), None);

            // ── Pass 2: Y into slot's Y plane ──────────────────────────
            let rtvs: [Option<ID3D11RenderTargetView>; 1] = [Some(slot.y_rtv.clone())];
            ctx.OMSetRenderTargets(Some(&rtvs), None);
            let srvs: [Option<ID3D11ShaderResourceView>; 2] =
                [Some(self.intermediate_srv.clone()), None];
            ctx.PSSetShaderResources(0, Some(&srvs));
            ctx.PSSetShader(&self.ps_y, None);
            set_viewport(&ctx, self.out_width, self.out_height);
            ctx.Draw(3, 0);

            ctx.OMSetRenderTargets(Some(&no_rtv), None);

            // ── Pass 3: UV into slot's UV plane (half-res) ─────────────
            let rtvs: [Option<ID3D11RenderTargetView>; 1] = [Some(slot.uv_rtv.clone())];
            ctx.OMSetRenderTargets(Some(&rtvs), None);
            let srvs: [Option<ID3D11ShaderResourceView>; 2] =
                [Some(self.intermediate_srv.clone()), None];
            ctx.PSSetShaderResources(0, Some(&srvs));
            ctx.PSSetShader(&self.ps_uv, None);
            set_viewport(&ctx, self.out_width / 2, self.out_height / 2);
            ctx.Draw(3, 0);

            ctx.OMSetRenderTargets(Some(&no_rtv), None);

            // Submit. Unlike the readback path, we don't wait — the MF
            // encoder will pick the texture up via IMFSample whenever
            // it gets GPU time.
            ctx.Flush();
        }
        // Hand the slot off to the encoder. ReleaseSync(1) signals
        // "ready to read" — the encoder MFT's AcquireSync(1) will
        // unblock once this completes on the GPU. After the encoder is
        // done, it will ReleaseSync(0), which is what our next
        // AcquireSync(0) will wait on.
        unsafe {
            slot.keyed_mutex
                .ReleaseSync(1)
                .context("IDXGIKeyedMutex::ReleaseSync(1) after composite")?;
        }
        Ok(())
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
        let device = device.expect("null WARP device");
        let context = context.expect("null WARP context");
        (device, Arc::new(Mutex::new(context)))
    }

    #[test]
    fn compositor_constructs_on_warp() {
        let (device, ctx) = warp_device_and_context();
        let comp = Compositor::new(&device, ctx, 64, 64).expect("Compositor::new");
        assert_eq!(comp.output_dimensions(), (64, 64));
    }

    #[test]
    fn compositor_rejects_odd_dimensions() {
        let (device, ctx) = warp_device_and_context();
        assert!(Compositor::new(&device, Arc::clone(&ctx), 63, 64).is_err());
        assert!(Compositor::new(&device, ctx, 64, 63).is_err());
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
        let (device, ctx) = warp_device_and_context();
        let comp = Compositor::new(&device, ctx, 16, 16).expect("Compositor::new");

        let (_tex, srv) = solid_bgra_texture(&device, 16, 16, 0, 0, 255);
        let gpu_nv12 = comp
            .composite_and_convert_to_nv12(&srv, None)
            .expect("composite");

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
        let (device, ctx) = warp_device_and_context();
        let comp = Compositor::new(&device, ctx, 16, 16).expect("Compositor::new");

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
            let gpu_nv12 = comp
                .composite_and_convert_to_nv12(&srv, None)
                .expect("composite");

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
        let (device, ctx) = warp_device_and_context();
        let comp = Compositor::new(&device, ctx, 16, 16).expect("Compositor::new");

        let (_cap_tex, cap_srv) = solid_bgra_texture(&device, 16, 16, 0, 0, 255); // red
        let (_ov_tex, ov_srv) = solid_bgra_texture(&device, 16, 16, 255, 0, 0);   // blue, fully opaque (α=255 baked in by helper)
        let gpu_nv12 = comp
            .composite_and_convert_to_nv12(&cap_srv, Some(&ov_srv))
            .expect("composite");

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
        let (device, ctx) = warp_device_and_context();
        let comp = Compositor::new(&device, ctx, 16, 16).expect("Compositor::new");

        let (_cap_tex, cap_srv) = solid_bgra_texture(&device, 16, 16, 0, 255, 0); // green capture
        // Build a fully-transparent overlay manually — solid_bgra_texture
        // forces α=255, so we need a custom helper here.
        let (_ov_tex, ov_srv) = bgra_texture_with_alpha(&device, 16, 16, 0, 0, 255, 0);

        let gpu_nv12 = comp
            .composite_and_convert_to_nv12(&cap_srv, Some(&ov_srv))
            .expect("composite with α=0 overlay");

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

    /// Smoke test for the zero-copy path: build an Nv12Ring on WARP,
    /// run a composite into one of its slots, and verify the call
    /// completes without erroring.
    ///
    /// We deliberately don't validate pixel values here — the BT.709 math
    /// runs through the same `ps_y` and `ps_uv` shaders that the
    /// readback-path tests above already exercise to ±3 LSB parity. What
    /// this test checks that the others can't is that the planar RTV
    /// bind (PlaneSlice 0 for Y, PlaneSlice 1 for UV) and the
    /// `Flush`-without-Map flow run end-to-end without WARP rejecting
    /// the bind or hanging on the missing readback. Real-pixel
    /// validation against an MF-encoded MP4 happens in the Bite 2
    /// integration smoke on real hardware.
    #[test]
    fn compositor_into_nv12_slot_runs_on_warp() {
        let (device, ctx) = warp_device_and_context();
        let comp = match Compositor::new(&device, ctx, 64, 64) {
            Ok(c) => c,
            Err(err) => {
                eprintln!("Compositor::new failed on WARP ({err}); skipping");
                return;
            }
        };
        let mut ring = match crate::gpu::nv12_ring::Nv12Ring::new(&device, 64, 64, 2) {
            Ok(r) => r,
            Err(err) => {
                // WARP variants without D3D 11.3 planar RTVs hit this.
                // Production code reaches the planar path only after the
                // GPU support probe says yes, so a WARP-skip is fine.
                eprintln!("Nv12Ring unavailable on this WARP ({err}); skipping");
                return;
            }
        };

        let (_cap_tex, cap_srv) = solid_bgra_texture(&device, 64, 64, 0, 0, 255);

        let first_ptr: *const crate::gpu::nv12_ring::Nv12Slot = {
            let slot = ring.acquire();
            let p = slot as *const _;
            comp.composite_into_nv12_slot(&cap_srv, None, slot)
                .expect("composite_into_nv12_slot");
            p
        };

        // Ring rotation: the next acquire must hand back a different slot.
        let next = ring.acquire();
        assert!(
            !std::ptr::eq(first_ptr, next as *const _),
            "ring should rotate to a different slot"
        );
    }
}
