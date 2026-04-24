//! A capture frame handed from the capture backend to the composite thread.
//!
//! Two payload shapes:
//!
//! - **CPU BGRA** — pool-allocated tight-packed buffer (legacy path; used
//!   today and retained as M3-Bite1 fallback when the GPU compositor can't
//!   be initialized).
//! - **GPU texture** — an `ID3D11Texture2D` handle owned by a pool, plus a
//!   fence value the composite thread waits on before sampling. This skips
//!   the staging `Map` on capture and keeps the frame on the GPU until the
//!   compositor renders + converts to NV12. Only populated when the DDA
//!   backend is in GPU mode; platform-gated behind `#[cfg(windows)]`.
//!
//! The CPU `BufferPool` reuses byte buffers across frames so we don't
//! allocate ~8 MiB per 1080p frame. The GPU pool lives in `gpu_pool.rs` —
//! it recycles whole textures.
//!
//! Both payloads share `width`/`height` because the composite thread needs
//! those regardless of payload shape (for viewports, dup-frame bookkeeping,
//! and resize decisions).

use std::sync::Arc;

use parking_lot::Mutex;

#[cfg(windows)]
use crate::capture::gpu_pool::GpuTextureHandle;

/// Payload carried inside a `Frame`. See module docs.
pub enum FramePayload {
    /// Tight-packed BGRA, `width * height * 4` bytes.
    Cpu(Vec<u8>),
    /// GPU BGRA texture with a fence value. See `GpuFrame`.
    #[cfg(windows)]
    Gpu(GpuFrame),
}

/// A GPU-resident BGRA frame. `texture` is `D3D11_USAGE_DEFAULT`, pool-
/// managed; dropping `GpuFrame` recycles it back to the pool. `fence_value`
/// is the value the capture queue signaled after `CopyResource` completed —
/// the composite thread should `Wait` on the same fence at or above this
/// value before binding the texture as an SRV.
#[cfg(windows)]
#[allow(dead_code)] // fields read by composite-thread GPU branch landing in a later bite step
pub struct GpuFrame {
    pub texture: GpuTextureHandle,
    pub fence_value: u64,
}

/// One capture frame. `width`/`height` are the capture resolution (not the
/// encoder output resolution — the composite thread handles any resize).
pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub payload: FramePayload,
    #[allow(dead_code)]
    pub captured_at: std::time::Instant,
    // Only present for CPU payloads; GPU payloads own their recycling via
    // `GpuTextureHandle::Drop`.
    cpu_pool: Option<Arc<BufferPool>>,
}

impl Frame {
    /// True if this frame is a CPU BGRA buffer.
    #[allow(dead_code)] // consumed by composite-thread payload branch landing in a later bite step
    pub fn is_cpu(&self) -> bool {
        matches!(self.payload, FramePayload::Cpu(_))
    }

    /// True if this frame is a GPU texture handle.
    #[cfg(windows)]
    #[allow(dead_code)]
    pub fn is_gpu(&self) -> bool {
        matches!(self.payload, FramePayload::Gpu(_))
    }

    /// Byte length of the CPU buffer, or zero for GPU frames. Used by
    /// bookkeeping only.
    #[allow(dead_code)]
    pub fn byte_len(&self) -> usize {
        match &self.payload {
            FramePayload::Cpu(v) => v.len(),
            #[cfg(windows)]
            FramePayload::Gpu(_) => 0,
        }
    }

    /// Borrow the CPU BGRA buffer. Panics for GPU payloads — callers must
    /// check `is_cpu()` first or match on the payload.
    pub fn cpu_data(&self) -> &[u8] {
        match &self.payload {
            FramePayload::Cpu(v) => v,
            #[cfg(windows)]
            FramePayload::Gpu(_) => {
                panic!("cpu_data() on a GPU-payload frame")
            }
        }
    }

    /// Steal the CPU BGRA buffer and disarm the pool-recycle on Drop. Use
    /// this when the buffer is going to be handed further down the pipeline
    /// (e.g. into the ffmpeg write channel) — otherwise Drop would recycle
    /// an emptied `Vec` back into the pool, which is wasted bookkeeping,
    /// and the downstream stage would have to allocate its own 33 MiB/frame
    /// at 4K.
    ///
    /// Panics for GPU payloads.
    pub fn into_buffer(mut self) -> Vec<u8> {
        // Disarm pool recycle first so Drop is a no-op on the empty Vec.
        let _ = self.cpu_pool.take();
        match std::mem::replace(&mut self.payload, FramePayload::Cpu(Vec::new())) {
            FramePayload::Cpu(v) => v,
            #[cfg(windows)]
            FramePayload::Gpu(_) => {
                panic!("into_buffer() on a GPU-payload frame")
            }
        }
    }

    /// Steal the GPU frame. Symmetric to `into_buffer`. Panics on CPU.
    #[cfg(windows)]
    #[allow(dead_code)] // called by composite-thread GPU branch landing in a later bite step
    pub fn into_gpu(mut self) -> GpuFrame {
        let _ = self.cpu_pool.take();
        match std::mem::replace(&mut self.payload, FramePayload::Cpu(Vec::new())) {
            FramePayload::Gpu(g) => g,
            FramePayload::Cpu(_) => panic!("into_gpu() on a CPU-payload frame"),
        }
    }
}

impl Drop for Frame {
    fn drop(&mut self) {
        // Recycle the CPU buffer back to its pool if one is attached. GPU
        // textures recycle themselves via GpuTextureHandle::Drop, so the
        // Gpu arm here is a no-op.
        if let Some(pool) = self.cpu_pool.take() {
            if let FramePayload::Cpu(data) = std::mem::replace(
                &mut self.payload,
                FramePayload::Cpu(Vec::new()),
            ) {
                pool.recycle(data);
            }
        }
    }
}

/// Pool of `Vec<u8>` buffers sized for BGRA capture frames.
pub struct BufferPool {
    free: Mutex<Vec<Vec<u8>>>,
    capacity: usize,
}

impl BufferPool {
    pub fn new(capacity: usize) -> Arc<Self> {
        Arc::new(Self {
            free: Mutex::new(Vec::with_capacity(capacity)),
            capacity,
        })
    }

    pub fn acquire(&self, min_len: usize) -> Vec<u8> {
        let mut guard = self.free.lock();
        while let Some(mut buf) = guard.pop() {
            if buf.capacity() >= min_len {
                buf.clear();
                return buf;
            }
        }
        Vec::with_capacity(min_len)
    }

    fn recycle(&self, mut buf: Vec<u8>) {
        let mut guard = self.free.lock();
        if guard.len() < self.capacity {
            buf.clear();
            guard.push(buf);
        }
    }

    pub fn make_frame(
        self: &Arc<Self>,
        width: u32,
        height: u32,
        data: Vec<u8>,
    ) -> Frame {
        Frame {
            width,
            height,
            payload: FramePayload::Cpu(data),
            captured_at: std::time::Instant::now(),
            cpu_pool: Some(Arc::clone(self)),
        }
    }
}

/// Wrap an already-captured GPU texture + fence value as a `Frame`. Called
/// by the DDA backend on its GPU path. The texture handle carries its own
/// recycling; the resulting `Frame` has no CPU pool attached.
#[cfg(windows)]
#[allow(dead_code)] // emitted by DDA GPU path landing later in Bite 1
pub fn make_gpu_frame(
    width: u32,
    height: u32,
    texture: GpuTextureHandle,
    fence_value: u64,
) -> Frame {
    Frame {
        width,
        height,
        payload: FramePayload::Gpu(GpuFrame {
            texture,
            fence_value,
        }),
        captured_at: std::time::Instant::now(),
        cpu_pool: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pool_recycles_buffers() {
        let pool = BufferPool::new(2);
        let frame = {
            let mut buf = pool.acquire(64);
            buf.resize(64, 0xAA);
            pool.make_frame(4, 4, buf)
        };
        assert_eq!(frame.byte_len(), 64);
        assert!(frame.is_cpu());
        drop(frame);
        let buf = pool.acquire(32);
        assert!(buf.capacity() >= 32);
    }

    #[test]
    fn into_buffer_disarms_recycle() {
        let pool = BufferPool::new(2);
        let mut buf = pool.acquire(16);
        buf.resize(16, 1);
        let frame = pool.make_frame(2, 2, buf);
        let taken = frame.into_buffer();
        assert_eq!(taken.len(), 16);
        // Pool had no chance to recycle — acquiring should yield a fresh
        // zero-len buffer (capacity may be any).
        let reacquired = pool.acquire(8);
        assert_eq!(reacquired.len(), 0);
    }
}
