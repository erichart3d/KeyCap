//! A pool-allocated BGRA frame passed from capture threads to the encoder.
//!
//! Re-using buffers across frames avoids allocating ~8 MiB per 1080p frame.

use std::sync::Arc;

use parking_lot::Mutex;

/// One BGRA frame. Row-major, tight packed (stride = width * 4).
pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
    #[allow(dead_code)]
    pub captured_at: std::time::Instant,
    pool: Option<Arc<BufferPool>>,
}

impl Frame {
    pub fn byte_len(&self) -> usize {
        self.data.len()
    }

    /// Steal the BGRA buffer and disarm the pool-recycle on Drop. Use this
    /// when the buffer is going to be handed further down the pipeline (e.g.
    /// into the ffmpeg write channel) — otherwise Drop would recycle an
    /// emptied `Vec` back into the pool, which is wasted bookkeeping, and
    /// the downstream stage would have to allocate its own 33 MiB/frame at
    /// 4K. Saves a full-frame copy + a 33 MiB zero-init per fresh frame on
    /// the composite hot path.
    pub fn into_buffer(mut self) -> Vec<u8> {
        let _ = self.pool.take();
        std::mem::take(&mut self.data)
    }
}

impl Drop for Frame {
    fn drop(&mut self) {
        if let Some(pool) = self.pool.take() {
            let data = std::mem::take(&mut self.data);
            pool.recycle(data);
        }
    }
}

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
            data,
            captured_at: std::time::Instant::now(),
            pool: Some(Arc::clone(self)),
        }
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
        drop(frame);
        let buf = pool.acquire(32);
        assert!(buf.capacity() >= 32);
    }
}
