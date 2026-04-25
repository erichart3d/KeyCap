//! Desktop Duplication API (DXGI) capture backend.
//!
//! DDA reads the final framebuffer through `IDXGIOutputDuplication`, which
//! bypasses the DWM composition-present hook that WGC depends on. This is
//! what works on HDR/VRR OLED ultrawides (e.g. Samsung Odyssey G95SC)
//! where WGC's `Direct3D11CaptureFramePool` stalls after the first frame.
//!
//! Two-phase startup (Bite 1.5):
//!
//! 1. `prepare_dda_capture(display_id)` — caller thread creates the D3D11
//!    device, the IDXGIOutputDuplication, and the staging texture. Returns
//!    a `DdaPrepared` that exposes `device` + `context` + dims so the
//!    composite thread can build a `SessionCompositor` on the same
//!    device/context Arc as the capture loop. The DDA loop has not been
//!    spawned yet at this point.
//! 2. `start_dda_loop(prepared, fps, want_gpu_emit, capture_pool, on_frame)`
//!    — moves the prepared state into a spawned capture thread and starts
//!    pumping frames. If `want_gpu_emit` is true and `capture_pool` is
//!    `Some`, every captured frame is `CopyResource`-d into a pool texture
//!    (under the shared context lock) and emitted as `FramePayload::Gpu`.
//!    Otherwise it Maps the staging texture and emits `FramePayload::Cpu`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use anyhow::{anyhow, Context as _, Result};
use parking_lot::Mutex;
use windows::core::{Interface, PCWSTR};
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_UNKNOWN, D3D_FEATURE_LEVEL_11_0};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
    D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAP_READ,
    D3D11_MAPPED_SUBRESOURCE, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC,
    D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIFactory1, IDXGIOutput1, IDXGIOutputDuplication, IDXGIResource,
    DXGI_ERROR_ACCESS_LOST, DXGI_ERROR_WAIT_TIMEOUT, DXGI_OUTDUPL_FRAME_INFO,
};

use super::frame::{make_gpu_frame, BufferPool, Frame};
use super::gpu_pool::GpuTexturePool;

/// Caller-thread output of `prepare_dda_capture`. Owns the D3D11 device
/// and the duplication state; the composite thread can clone the device
/// + context Arc to build a `SessionCompositor` before the capture loop
/// has even started spinning.
pub struct DdaPrepared {
    pub device: ID3D11Device,
    pub context: Arc<Mutex<ID3D11DeviceContext>>,
    pub width: u32,
    pub height: u32,
    state: DdaState,
    device_name: String,
}

impl DdaPrepared {
    pub fn dimensions(&self) -> (u32, u32) {
        (self.width, self.height)
    }
}

pub struct DdaHandle {
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
    /// Shared with the composite thread so the GPU compositor can sample
    /// pool textures the capture loop just wrote, without cross-device
    /// keyed-mutex plumbing.
    device: ID3D11Device,
    /// Shared immediate context — the composite thread takes the same
    /// `Arc<Mutex<...>>`. D3D11 requires single-threaded access to the
    /// immediate context, which the mutex enforces.
    context: Arc<Mutex<ID3D11DeviceContext>>,
}

impl DdaHandle {
    pub fn stop(mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(h) = self.join.take() {
            let _ = h.join();
        }
    }

    /// Borrow the D3D11 device the DDA loop is using.
    pub fn device(&self) -> &ID3D11Device {
        &self.device
    }

    /// Clone the shared immediate-context `Arc`. The composite thread
    /// holds an equal-class clone and the two threads coordinate via the
    /// mutex inside.
    pub fn context(&self) -> Arc<Mutex<ID3D11DeviceContext>> {
        Arc::clone(&self.context)
    }
}

impl Drop for DdaHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(h) = self.join.take() {
            let _ = h.join();
        }
    }
}

/// Phase 1: caller-thread init. Creates the D3D11 device, the
/// `IDXGIOutputDuplication`, and the staging texture. Cheap enough that
/// any error here is reported synchronously to `Session::start` instead
/// of dying on a worker thread.
pub fn prepare_dda_capture(device_name: &str) -> Result<DdaPrepared> {
    let state = DdaState::init(device_name).context("initialize DXGI desktop duplication")?;
    let device = state.device.clone();
    let context = Arc::clone(&state.context);
    let width = state.width;
    let height = state.height;
    Ok(DdaPrepared {
        device,
        context,
        width,
        height,
        state,
        device_name: device_name.to_string(),
    })
}

/// Phase 2: spawn the capture thread. `capture_pool`, when present and
/// `gpu_emit_active` is true, drives the GPU emit branch — every captured
/// frame is copied into a pooled BGRA texture (under the shared context
/// lock) and emitted as `FramePayload::Gpu`. Otherwise the loop falls
/// back to `Map`-the-staging emit on the CPU path.
///
/// `gpu_emit_active` is shared with the composite thread. The composite
/// thread flips it to `false` if the GPU compositor times out or errors
/// mid-session — DDA reads it on its next iteration and switches over to
/// CPU emit, letting the recording continue gracefully on the CPU path
/// instead of getting stuck dup-writing the last good frame.
pub fn start_dda_loop(
    prepared: DdaPrepared,
    fps: u32,
    gpu_emit_active: Arc<AtomicBool>,
    capture_pool: Option<Arc<GpuTexturePool>>,
    on_frame: Box<dyn FnMut(Frame) + Send + 'static>,
) -> Result<DdaHandle> {
    let want_gpu_emit = gpu_emit_active.load(Ordering::Relaxed);
    if want_gpu_emit && capture_pool.is_none() {
        tracing::warn!(
            "DDA GPU emit requested without a capture pool — falling back to CPU emit"
        );
        gpu_emit_active.store(false, Ordering::Relaxed);
    }
    if want_gpu_emit && capture_pool.is_some() {
        tracing::info!(
            width = prepared.width,
            height = prepared.height,
            "DDA emitting GPU frames (FramePayload::Gpu) via pooled BGRA textures"
        );
    }

    let stop = Arc::new(AtomicBool::new(false));
    let stop_thread = Arc::clone(&stop);
    let on_frame = Arc::new(Mutex::new(on_frame));
    let fps = fps.max(1);

    let device = prepared.device.clone();
    let context = Arc::clone(&prepared.context);
    let device_name = prepared.device_name.clone();
    let state = prepared.state;

    let join = std::thread::Builder::new()
        .name("keycap-dda".into())
        .spawn(move || {
            if let Err(err) = run_capture_loop(
                state,
                &device_name,
                fps,
                gpu_emit_active,
                capture_pool,
                &stop_thread,
                &on_frame,
            ) {
                tracing::error!(?err, "dda capture loop exited with error");
            }
        })
        .context("spawn dda capture thread")?;

    Ok(DdaHandle {
        stop,
        join: Some(join),
        device,
        context,
    })
}

fn run_capture_loop(
    mut state: DdaState,
    device_name: &str,
    fps: u32,
    gpu_emit_active: Arc<AtomicBool>,
    capture_pool: Option<Arc<GpuTexturePool>>,
    stop: &AtomicBool,
    on_frame: &Arc<Mutex<Box<dyn FnMut(Frame) + Send + 'static>>>,
) -> Result<()> {
    let pool = BufferPool::new(4);
    let frame_interval = Duration::from_secs_f64(1.0 / f64::from(fps));
    // Timeout caps the idle re-emit rate (we only re-emit from staging
    // when AcquireNextFrame times out). Half the frame interval keeps
    // idle cadence matching `fps` without burning CPU on active scenes,
    // where AcquireNextFrame returns as soon as a new frame arrives.
    let acquire_timeout_ms: u32 = ((frame_interval.as_millis() as u32) / 2).max(2);

    // No deadline pacing at the DDA layer. The encoder thread is the
    // single source of wallclock truth — it ticks at exactly `fps` per
    // wallclock second, `try_recv`-drains to the newest queued frame,
    // and duplicates the last frame when the channel is empty. If we
    // pace here too, any early-arriving frame (±sub-ms jitter on the
    // display refresh) gets skipped and is then overwritten in the
    // staging texture by the next DDA frame before the encoder can
    // see it — so ~10–15 frames/s end up lost as dup-fills downstream.
    // Emit every DDA frame; the encoder handles rate matching.
    let mut needs_reinit = false;
    // Track the last emit mode we logged so we can announce a switch
    // (typically GPU → CPU on a mid-session compositor failure) exactly
    // once per transition rather than spamming every frame.
    let mut last_logged_gpu_emit = gpu_emit_active.load(Ordering::Relaxed);

    while !stop.load(Ordering::Relaxed) {
        if needs_reinit {
            tracing::info!("reinitializing dda duplication after access loss");
            match state.reinit_duplication(device_name) {
                Ok(()) => {
                    needs_reinit = false;
                }
                Err(err) => {
                    tracing::warn!(?err, "dda reinit failed; retrying");
                    std::thread::sleep(Duration::from_millis(200));
                    continue;
                }
            }
        }

        let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
        let mut resource: Option<IDXGIResource> = None;
        let hr = unsafe {
            state
                .duplication
                .AcquireNextFrame(acquire_timeout_ms, &mut info, &mut resource)
        };
        match hr {
            Ok(()) => {}
            Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => {
                // Idle desktop — no new frame arrived within the
                // timeout. No need to re-emit; the encoder thread will
                // hold the timeline by duplicating its last composited
                // frame. Just loop and try again.
                continue;
            }
            Err(e) if e.code() == DXGI_ERROR_ACCESS_LOST => {
                needs_reinit = true;
                continue;
            }
            Err(e) => {
                tracing::warn!(error = %e, "AcquireNextFrame failed; reinitializing");
                needs_reinit = true;
                continue;
            }
        }

        let resource = match resource {
            Some(r) => r,
            None => {
                let _ = unsafe { state.duplication.ReleaseFrame() };
                continue;
            }
        };

        let tex: ID3D11Texture2D = match resource.cast() {
            Ok(t) => t,
            Err(err) => {
                tracing::warn!(?err, "frame resource is not a texture");
                let _ = unsafe { state.duplication.ReleaseFrame() };
                continue;
            }
        };

        // Read the active emit mode each iteration. The composite thread
        // flips this to false on a GPU compositor failure so the rest of
        // the recording continues on the CPU path.
        let gpu_emit_now = gpu_emit_active.load(Ordering::Relaxed) && capture_pool.is_some();
        if gpu_emit_now != last_logged_gpu_emit {
            tracing::info!(
                from = if last_logged_gpu_emit { "gpu" } else { "cpu" },
                to = if gpu_emit_now { "gpu" } else { "cpu" },
                "DDA emit mode switched"
            );
            last_logged_gpu_emit = gpu_emit_now;
        }

        if gpu_emit_now {
            let pool = capture_pool.as_ref().expect("gpu_emit_now implies pool");
            match emit_gpu(&state, pool, &tex) {
                Ok(frame) => {
                    let _ = unsafe { state.duplication.ReleaseFrame() };
                    let mut cb = on_frame.lock();
                    (cb)(frame);
                }
                Err(err) => {
                    tracing::warn!(?err, "GPU emit failed; releasing frame and retrying");
                    let _ = unsafe { state.duplication.ReleaseFrame() };
                }
            }
        } else {
            // CPU path: copy desktop texture into our staging texture
            // under the lock, then Map outside the lock.
            {
                let ctx = state.context.lock();
                unsafe {
                    ctx.CopyResource(&state.staging, &tex);
                }
                // Lock dropped at end of scope.
            }
            let _ = unsafe { state.duplication.ReleaseFrame() };
            emit_from_staging(&state, &pool, on_frame);
        }
    }

    Ok(())
}

/// GPU emit: acquire a pool texture, copy the source into it under the
/// context lock, and emit a `FramePayload::Gpu` frame. The fence value
/// on the resulting `GpuFrame` is `0` because Plan A serializes DDA and
/// composite work on the same `ID3D11DeviceContext` — D3D11's automatic
/// resource state tracking on a single context inserts the
/// "draw-after-copy" barrier on the GPU side, so the composite thread
/// doesn't need to wait on a CPU-visible fence here. The field is kept
/// for forward compat in case Bite 2 moves to cross-device sharing.
fn emit_gpu(
    state: &DdaState,
    pool: &Arc<GpuTexturePool>,
    src: &ID3D11Texture2D,
) -> Result<Frame> {
    let handle = pool.acquire().context("acquire pool texture")?;
    {
        let ctx = state.context.lock();
        unsafe {
            ctx.CopyResource(handle.texture(), src);
        }
        // Lock released here. CopyResource is a CPU-side command record
        // (driver queues GPU work async) — under typical 4K loads this
        // section is well under 100 µs.
    }
    Ok(make_gpu_frame(state.width, state.height, handle, 0))
}

fn emit_from_staging(
    state: &DdaState,
    pool: &Arc<BufferPool>,
    on_frame: &Arc<Mutex<Box<dyn FnMut(Frame) + Send + 'static>>>,
) {
    let width = state.width;
    let height = state.height;
    let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
    let map_result = {
        let ctx = state.context.lock();
        unsafe {
            ctx.Map(&state.staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
        }
    };
    if let Err(err) = map_result {
        tracing::warn!(error = %err, "Map staging failed");
        return;
    }

    let row_pitch = mapped.RowPitch as usize;
    let row_bytes = (width as usize) * 4;
    let needed = row_bytes * (height as usize);
    let mut data = pool.acquire(needed);
    data.resize(needed, 0);

    // DDA staging textures can have padded rows (stride != width * 4).
    // Copy row-by-row into a tight buffer for ffmpeg.
    unsafe {
        let src = mapped.pData as *const u8;
        let dst = data.as_mut_ptr();
        if row_pitch == row_bytes {
            std::ptr::copy_nonoverlapping(src, dst, needed);
        } else {
            for y in 0..(height as usize) {
                let src_row = src.add(y * row_pitch);
                let dst_row = dst.add(y * row_bytes);
                std::ptr::copy_nonoverlapping(src_row, dst_row, row_bytes);
            }
        }
        let ctx = state.context.lock();
        ctx.Unmap(&state.staging, 0);
    }

    let frame = pool.make_frame(width, height, data);
    let mut cb = on_frame.lock();
    (cb)(frame);
}

struct DdaState {
    device: ID3D11Device,
    context: Arc<Mutex<ID3D11DeviceContext>>,
    duplication: IDXGIOutputDuplication,
    staging: ID3D11Texture2D,
    width: u32,
    height: u32,
}

impl DdaState {
    fn init(device_name: &str) -> Result<Self> {
        unsafe {
            let factory: IDXGIFactory1 =
                CreateDXGIFactory1().context("CreateDXGIFactory1")?;

            // Walk adapters → outputs, match the GDI DeviceName.
            let mut found = None;
            let mut adapter_idx = 0u32;
            'outer: loop {
                let adapter = match factory.EnumAdapters1(adapter_idx) {
                    Ok(a) => a,
                    Err(_) => break,
                };
                adapter_idx += 1;

                let mut output_idx = 0u32;
                loop {
                    let output = match adapter.EnumOutputs(output_idx) {
                        Ok(o) => o,
                        Err(_) => break,
                    };
                    output_idx += 1;
                    let desc = match output.GetDesc() {
                        Ok(d) => d,
                        Err(_) => continue,
                    };
                    let name = pcwstr_to_string(PCWSTR(desc.DeviceName.as_ptr()));
                    if name.eq_ignore_ascii_case(device_name) {
                        found = Some((adapter, output, desc));
                        break 'outer;
                    }
                }
            }

            let (adapter, output, desc) = found
                .ok_or_else(|| anyhow!("no DXGI output matches device {}", device_name))?;

            let output1: IDXGIOutput1 = output.cast().context("QI IDXGIOutput1")?;

            let mut device: Option<ID3D11Device> = None;
            let mut context: Option<ID3D11DeviceContext> = None;
            let mut feature_level = D3D_FEATURE_LEVEL_11_0;
            let levels = [D3D_FEATURE_LEVEL_11_0];
            D3D11CreateDevice(
                &adapter,
                D3D_DRIVER_TYPE_UNKNOWN,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                Some(&levels),
                D3D11_SDK_VERSION,
                Some(&mut device),
                Some(&mut feature_level),
                Some(&mut context),
            )
            .context("D3D11CreateDevice")?;
            let device = device.ok_or_else(|| anyhow!("null D3D11 device"))?;
            let context = context.ok_or_else(|| anyhow!("null D3D11 context"))?;

            let duplication = output1
                .DuplicateOutput(&device)
                .context("IDXGIOutput1::DuplicateOutput")?;

            let rect = desc.DesktopCoordinates;
            let width = (rect.right - rect.left).max(2) as u32;
            let height = (rect.bottom - rect.top).max(2) as u32;

            let staging_desc = D3D11_TEXTURE2D_DESC {
                Width: width,
                Height: height,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                SampleDesc: DXGI_SAMPLE_DESC {
                    Count: 1,
                    Quality: 0,
                },
                Usage: D3D11_USAGE_STAGING,
                BindFlags: 0,
                CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                MiscFlags: 0,
            };
            let mut staging: Option<ID3D11Texture2D> = None;
            device
                .CreateTexture2D(&staging_desc, None, Some(&mut staging))
                .context("CreateTexture2D staging")?;
            let staging = staging.ok_or_else(|| anyhow!("null staging texture"))?;

            Ok(DdaState {
                device,
                context: Arc::new(Mutex::new(context)),
                duplication,
                staging,
                width,
                height,
            })
        }
    }

    /// Re-acquire the `IDXGIOutputDuplication` after an access-lost
    /// event. Reuses the existing device + context + staging — only
    /// duplication state is replaced.
    fn reinit_duplication(&mut self, device_name: &str) -> Result<()> {
        unsafe {
            let factory: IDXGIFactory1 =
                CreateDXGIFactory1().context("CreateDXGIFactory1 (reinit)")?;

            let mut found = None;
            let mut adapter_idx = 0u32;
            'outer: loop {
                let adapter = match factory.EnumAdapters1(adapter_idx) {
                    Ok(a) => a,
                    Err(_) => break,
                };
                adapter_idx += 1;
                let mut output_idx = 0u32;
                loop {
                    let output = match adapter.EnumOutputs(output_idx) {
                        Ok(o) => o,
                        Err(_) => break,
                    };
                    output_idx += 1;
                    let desc = match output.GetDesc() {
                        Ok(d) => d,
                        Err(_) => continue,
                    };
                    let name = pcwstr_to_string(PCWSTR(desc.DeviceName.as_ptr()));
                    if name.eq_ignore_ascii_case(device_name) {
                        found = Some(output);
                        break 'outer;
                    }
                }
            }
            let output = found.ok_or_else(|| {
                anyhow!("no DXGI output matches device {} (reinit)", device_name)
            })?;
            let output1: IDXGIOutput1 = output.cast().context("QI IDXGIOutput1 (reinit)")?;
            let duplication = output1
                .DuplicateOutput(&self.device)
                .context("DuplicateOutput (reinit)")?;
            self.duplication = duplication;
            Ok(())
        }
    }
}

fn pcwstr_to_string(s: PCWSTR) -> String {
    if s.0.is_null() {
        return String::new();
    }
    unsafe {
        let mut len = 0;
        while *s.0.add(len) != 0 {
            len += 1;
        }
        let slice = std::slice::from_raw_parts(s.0, len);
        String::from_utf16_lossy(slice)
    }
}
