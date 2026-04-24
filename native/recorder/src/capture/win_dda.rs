//! Desktop Duplication API (DXGI) capture backend.
//!
//! DDA reads the final framebuffer through `IDXGIOutputDuplication`, which
//! bypasses the DWM composition-present hook that WGC depends on. This is
//! what works on HDR/VRR OLED ultrawides (e.g. Samsung Odyssey G95SC)
//! where WGC's `Direct3D11CaptureFramePool` stalls after the first frame.
//!
//! Entry point: `start_dda_capture(device_name, fps, on_frame)`.

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

use super::frame::{BufferPool, Frame};

pub struct DdaHandle {
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
    /// Shared with the composite thread so the GPU compositor can create
    /// shaders, textures, and fences on the same device the capture loop
    /// writes frames on. `None` for failed sessions where the probe device
    /// never came up, though in practice we return `Err` before building
    /// `DdaHandle` in that case.
    device: ID3D11Device,
}

impl DdaHandle {
    pub fn stop(mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(h) = self.join.take() {
            let _ = h.join();
        }
    }

    /// Borrow the D3D11 device the DDA loop is using. The composite thread
    /// shares this device for the GPU compositor path so capture output
    /// textures and compositor shader resources stay on the same GPU queue,
    /// skipping the cross-device `IDXGIKeyedMutex` dance.
    #[allow(dead_code)] // consumed by composite-thread GPU branch landing in a later bite step
    pub fn device(&self) -> &ID3D11Device {
        &self.device
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

/// Start a DDA capture thread for the given monitor. `device_name` is the
/// GDI-style `\\.\DISPLAY1` string — matched against `IDXGIOutput::GetDesc`.
///
/// `want_gpu_emit` signals that the composite thread will consume
/// `FramePayload::Gpu` frames instead of CPU BGRA. Bite 1 scaffolding: the
/// parameter is plumbed but the GPU emit path itself lands in the next
/// bite step — for now DDA always emits CPU frames regardless.
pub fn start_dda_capture(
    device_name: &str,
    fps: u32,
    want_gpu_emit: bool,
    on_frame: Box<dyn FnMut(Frame) + Send + 'static>,
) -> Result<DdaHandle> {
    if want_gpu_emit {
        tracing::info!("DDA GPU emit requested; scaffolding in place, still emitting CPU frames");
    }
    let stop = Arc::new(AtomicBool::new(false));
    let stop_thread = Arc::clone(&stop);
    let device_name_owned = device_name.to_string();
    let on_frame = Arc::new(Mutex::new(on_frame));
    let fps = fps.max(1);

    // Probe once on the caller's thread so start_capture returns errors
    // synchronously instead of silently dying on the capture thread. The
    // probe's device is the one we hand back to the composite thread — that
    // way the compositor and the capture loop share a single D3D11 device
    // without threading ownership through channels. The capture thread will
    // re-init its own state (using the same adapter) when it starts; the two
    // devices render to independent textures, so no sharing is required
    // *for CPU emit*. GPU emit will route through the probe device's pool
    // in the next bite step.
    let probe = DdaState::init(&device_name_owned)
        .context("initialize DXGI desktop duplication")?;
    let shared_device = probe.device.clone();
    drop(probe);

    let join = std::thread::Builder::new()
        .name("keycap-dda".into())
        .spawn(move || {
            if let Err(err) = run_capture_loop(&device_name_owned, fps, &stop_thread, &on_frame) {
                tracing::error!(?err, "dda capture loop exited with error");
            }
        })
        .context("spawn dda capture thread")?;

    Ok(DdaHandle {
        stop,
        join: Some(join),
        device: shared_device,
    })
}

fn run_capture_loop(
    device_name: &str,
    fps: u32,
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

    let mut state = DdaState::init(device_name).context("dda init")?;
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

    while !stop.load(Ordering::Relaxed) {
        if needs_reinit {
            tracing::info!("reinitializing dda duplication after access loss");
            match DdaState::init(device_name) {
                Ok(next) => {
                    state = next;
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

        unsafe {
            state.context.CopyResource(&state.staging, &tex);
        }
        state.has_staging_content = true;
        let _ = unsafe { state.duplication.ReleaseFrame() };

        // Emit unconditionally. If capture rate exceeds target fps
        // (e.g. 120Hz display, 60 fps target), the encoder's try_recv
        // drain will naturally keep the newest frame per tick.
        emit_from_staging(&state, &pool, &on_frame);
    }

    Ok(())
}

fn emit_from_staging(
    state: &DdaState,
    pool: &Arc<BufferPool>,
    on_frame: &Arc<Mutex<Box<dyn FnMut(Frame) + Send + 'static>>>,
) {
    let width = state.width;
    let height = state.height;
    let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
    let hr = unsafe {
        state
            .context
            .Map(&state.staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
    };
    if let Err(err) = hr {
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
        state.context.Unmap(&state.staging, 0);
    }

    let frame = pool.make_frame(width, height, data);
    let mut cb = on_frame.lock();
    (cb)(frame);
}

struct DdaState {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    duplication: IDXGIOutputDuplication,
    staging: ID3D11Texture2D,
    width: u32,
    height: u32,
    has_staging_content: bool,
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
                context,
                duplication,
                staging,
                width,
                height,
                has_staging_content: false,
            })
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
