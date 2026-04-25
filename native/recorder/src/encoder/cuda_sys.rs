//! Hand-written FFI for the CUDA Driver API + D3D11 interop.
//!
//! We dynamically load `nvcuda.dll` (ships with every NVIDIA driver,
//! same as `nvEncodeAPI64.dll`) and grab function pointers via
//! `GetProcAddress`. No CUDA toolkit install required — the headers
//! we'd otherwise pull from `cuda.h` and `cudaD3D11.h` are only ~13
//! functions that we declare by hand here.
//!
//! The CUDA Driver API is intentionally small and ABI-stable across
//! driver versions; NVIDIA documents these signatures in the CUDA
//! Driver API reference and OBS uses the same pattern (vendored
//! cuda-helpers.h, dynamic load).

#![cfg(windows)]
#![allow(dead_code, non_camel_case_types, non_snake_case, non_upper_case_globals)]

use std::ffi::c_void;

// ─── Result codes ────────────────────────────────────────────────────

/// CUDA Driver API return code. 0 = success; non-zero = error.
/// We treat it as a bare `i32` and only special-case `CUDA_SUCCESS`.
pub type CUresult = i32;
pub const CUDA_SUCCESS: CUresult = 0;

// ─── Opaque handle types ─────────────────────────────────────────────

/// Device ordinal. Just an integer index into `cuDeviceGetCount`.
pub type CUdevice = i32;
/// Opaque CUDA context.
pub type CUcontext = *mut c_void;
/// Opaque graphics-resource handle returned by
/// `cuGraphicsD3D11RegisterResource`. Persists across map/unmap.
pub type CUgraphicsResource = *mut c_void;
/// Opaque CUDA array (multi-dimensional memory). What
/// `cuGraphicsSubResourceGetMappedArray` returns; what NVENC consumes
/// when initialized with the CUDA device type.
pub type CUarray = *mut c_void;
/// Opaque CUDA stream. We pass `null` (the default stream) for sync
/// operations.
pub type CUstream = *mut c_void;

// ─── Flags ───────────────────────────────────────────────────────────

/// `cuCtxCreate` flag for "yield to other threads while waiting for
/// the GPU" — sane default for an interactive recorder.
pub const CU_CTX_SCHED_AUTO: u32 = 0x00;

/// `cuGraphicsD3D11RegisterResource` flag for "this resource will be
/// used as input to encode operations." Tells the driver which
/// internal mapping path to use.
pub const CU_GRAPHICS_REGISTER_FLAGS_NONE: u32 = 0x00;

// ─── Function-pointer typedefs ───────────────────────────────────────
//
// Calling convention on Windows x64 is the same for `__stdcall` and
// `__cdecl`, so `extern "system"` and `extern "C"` produce identical
// code. We use `extern "system"` to mirror NVENC's typedefs.

pub type cuInit_t = unsafe extern "system" fn(flags: u32) -> CUresult;
pub type cuDeviceGetCount_t = unsafe extern "system" fn(count: *mut i32) -> CUresult;
pub type cuDeviceGet_t =
    unsafe extern "system" fn(device: *mut CUdevice, ordinal: i32) -> CUresult;
pub type cuCtxCreate_v2_t = unsafe extern "system" fn(
    pctx: *mut CUcontext,
    flags: u32,
    dev: CUdevice,
) -> CUresult;
pub type cuCtxDestroy_v2_t = unsafe extern "system" fn(ctx: CUcontext) -> CUresult;
pub type cuCtxPushCurrent_v2_t = unsafe extern "system" fn(ctx: CUcontext) -> CUresult;
pub type cuCtxPopCurrent_v2_t =
    unsafe extern "system" fn(pctx: *mut CUcontext) -> CUresult;

/// D3D11 → CUDA device lookup. Returns the CUDA device ordinal that
/// corresponds to the same physical GPU as a given D3D11 adapter.
pub type cuD3D11GetDevice_t = unsafe extern "system" fn(
    device: *mut CUdevice,
    pAdapter: *mut c_void, // IDXGIAdapter*
) -> CUresult;

pub type cuGraphicsD3D11RegisterResource_t = unsafe extern "system" fn(
    pCudaResource: *mut CUgraphicsResource,
    pD3DResource: *mut c_void, // ID3D11Resource*
    Flags: u32,
) -> CUresult;

pub type cuGraphicsUnregisterResource_t =
    unsafe extern "system" fn(resource: CUgraphicsResource) -> CUresult;

pub type cuGraphicsMapResources_t = unsafe extern "system" fn(
    count: u32,
    resources: *mut CUgraphicsResource,
    hStream: CUstream,
) -> CUresult;

pub type cuGraphicsUnmapResources_t = unsafe extern "system" fn(
    count: u32,
    resources: *mut CUgraphicsResource,
    hStream: CUstream,
) -> CUresult;

pub type cuGraphicsSubResourceGetMappedArray_t = unsafe extern "system" fn(
    pArray: *mut CUarray,
    resource: CUgraphicsResource,
    arrayIndex: u32,
    mipLevel: u32,
) -> CUresult;

// ─── Loaded function table ───────────────────────────────────────────

/// Snapshot of the CUDA Driver API entry points we use, populated
/// once at session start by `load()`. Holding this struct keeps the
/// DLL alive and the function pointers valid for the whole process
/// lifetime.
pub struct CudaApi {
    pub cuInit: cuInit_t,
    pub cuDeviceGetCount: cuDeviceGetCount_t,
    pub cuDeviceGet: cuDeviceGet_t,
    pub cuCtxCreate_v2: cuCtxCreate_v2_t,
    pub cuCtxDestroy_v2: cuCtxDestroy_v2_t,
    pub cuCtxPushCurrent_v2: cuCtxPushCurrent_v2_t,
    pub cuCtxPopCurrent_v2: cuCtxPopCurrent_v2_t,
    pub cuD3D11GetDevice: cuD3D11GetDevice_t,
    pub cuGraphicsD3D11RegisterResource: cuGraphicsD3D11RegisterResource_t,
    pub cuGraphicsUnregisterResource: cuGraphicsUnregisterResource_t,
    pub cuGraphicsMapResources: cuGraphicsMapResources_t,
    pub cuGraphicsUnmapResources: cuGraphicsUnmapResources_t,
    pub cuGraphicsSubResourceGetMappedArray: cuGraphicsSubResourceGetMappedArray_t,
}

impl CudaApi {
    /// Load `nvcuda.dll` from the system search path and resolve all
    /// the entry points we need. Fails if the driver isn't NVIDIA or
    /// is too old to expose any of them.
    /// Convert a CUDA result code to a context-bearing `Result<()>`.
    /// Used to keep call sites clean — every CUDA call returns
    /// `CUresult` and we want to bail with a useful tag.
    pub fn check(&self, sym: &'static str, st: CUresult) -> anyhow::Result<()> {
        if st == CUDA_SUCCESS {
            Ok(())
        } else {
            Err(anyhow::anyhow!("{sym} failed: CUDA result {st}"))
        }
    }

    pub fn load() -> anyhow::Result<Self> {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};

        let name: Vec<u16> = OsStr::new("nvcuda.dll")
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let module = unsafe { LoadLibraryW(windows::core::PCWSTR(name.as_ptr())) }
            .map_err(|e| anyhow::anyhow!("LoadLibraryW(nvcuda.dll) failed: {e}"))?;
        if module.is_invalid() {
            anyhow::bail!("LoadLibraryW(nvcuda.dll) returned invalid handle");
        }

        // Versioned symbols: most CUDA Driver API entry points have a
        // `_v2` suffix in the DLL exports because the API has been
        // ABI-bumped. The unversioned aliases in the SDK headers
        // resolve to these via `#define`.
        let resolve = |sym: &str| -> anyhow::Result<*mut c_void> {
            let cstr = std::ffi::CString::new(sym)?;
            let proc = unsafe {
                GetProcAddress(module, windows::core::PCSTR(cstr.as_ptr() as *const u8))
            };
            proc.map(|p| p as *mut c_void)
                .ok_or_else(|| anyhow::anyhow!("nvcuda.dll missing export `{sym}`"))
        };

        unsafe {
            Ok(Self {
                cuInit: std::mem::transmute(resolve("cuInit")?),
                cuDeviceGetCount: std::mem::transmute(resolve("cuDeviceGetCount")?),
                cuDeviceGet: std::mem::transmute(resolve("cuDeviceGet")?),
                cuCtxCreate_v2: std::mem::transmute(resolve("cuCtxCreate_v2")?),
                cuCtxDestroy_v2: std::mem::transmute(resolve("cuCtxDestroy_v2")?),
                cuCtxPushCurrent_v2: std::mem::transmute(resolve("cuCtxPushCurrent_v2")?),
                cuCtxPopCurrent_v2: std::mem::transmute(resolve("cuCtxPopCurrent_v2")?),
                cuD3D11GetDevice: std::mem::transmute(resolve("cuD3D11GetDevice")?),
                cuGraphicsD3D11RegisterResource: std::mem::transmute(resolve(
                    "cuGraphicsD3D11RegisterResource",
                )?),
                cuGraphicsUnregisterResource: std::mem::transmute(resolve(
                    "cuGraphicsUnregisterResource",
                )?),
                cuGraphicsMapResources: std::mem::transmute(resolve("cuGraphicsMapResources")?),
                cuGraphicsUnmapResources: std::mem::transmute(resolve(
                    "cuGraphicsUnmapResources",
                )?),
                cuGraphicsSubResourceGetMappedArray: std::mem::transmute(resolve(
                    "cuGraphicsSubResourceGetMappedArray",
                )?),
            })
        }
    }
}

// ─── CudaSession ─────────────────────────────────────────────────────

/// Owns a loaded CUDA API + a CUDA context bound to the GPU that
/// matches a given D3D11 adapter. Created at session start if the
/// NVENC SDK + CUDA path is selected; the encoder later passes
/// `context` to `nvEncOpenEncodeSessionEx` with
/// `deviceType = NV_ENC_DEVICE_TYPE_CUDA`.
pub struct CudaSession {
    pub api: CudaApi,
    pub context: CUcontext,
    pub device: CUdevice,
}

impl CudaSession {
    /// Initialize CUDA, look up the CUDA device that matches the
    /// given DXGI adapter, and create a context on it. The DXGI
    /// adapter is queried from the compositor's D3D11 device so the
    /// CUDA context lands on the same physical GPU — required for
    /// `cuGraphicsD3D11RegisterResource` to succeed.
    pub fn new_for_d3d11_adapter(
        adapter: &windows::Win32::Graphics::Dxgi::IDXGIAdapter,
    ) -> anyhow::Result<Self> {
        use windows::core::Interface as _;

        let api = CudaApi::load()?;

        // cuInit must be called before any other CUDA function. The
        // flags argument is reserved and must be 0.
        let st = unsafe { (api.cuInit)(0) };
        api.check("cuInit", st)?;

        // Look up the CUDA device ordinal corresponding to this DXGI
        // adapter. The adapter pointer crosses the COM boundary as
        // a raw `*mut c_void`.
        let mut device: CUdevice = -1;
        let st = unsafe {
            (api.cuD3D11GetDevice)(&mut device, adapter.as_raw() as *mut c_void)
        };
        api.check("cuD3D11GetDevice", st)?;

        // Create a context with the auto-yield scheduling flag — sane
        // default for an interactive recorder where we share the GPU
        // with the compositor and the user's foreground apps.
        let mut context: CUcontext = std::ptr::null_mut();
        let st = unsafe {
            (api.cuCtxCreate_v2)(&mut context, CU_CTX_SCHED_AUTO, device)
        };
        api.check("cuCtxCreate_v2", st)?;

        // `cuCtxCreate` makes the new context the *current* context
        // for this thread. We push/pop it explicitly per encode call,
        // so pop it here to leave the thread in a clean state.
        let mut popped: CUcontext = std::ptr::null_mut();
        let st = unsafe { (api.cuCtxPopCurrent_v2)(&mut popped) };
        api.check("cuCtxPopCurrent_v2 (after init)", st)?;

        Ok(Self {
            api,
            context,
            device,
        })
    }
}

impl Drop for CudaSession {
    fn drop(&mut self) {
        if !self.context.is_null() {
            unsafe {
                let _ = (self.api.cuCtxDestroy_v2)(self.context);
            }
            self.context = std::ptr::null_mut();
        }
    }
}

// SAFETY: CudaSession holds a CUcontext (raw pointer) and a function
// table of plain extern "system" function pointers. The CUDA Driver
// API is documented as thread-safe for context-aware calls (any
// thread can push/pop a context). We only ever access this struct
// from the writer thread we move it into.
unsafe impl Send for CudaSession {}
