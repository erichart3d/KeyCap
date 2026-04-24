//! Minimal WGC capture: start on the primary monitor, count callbacks for
//! 5 seconds. No IPC, no encoder, no throttle.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use windows_capture::{
    capture::{Context, GraphicsCaptureApiHandler},
    frame::Frame as WcFrame,
    graphics_capture_api::InternalCaptureControl,
    monitor::Monitor,
    settings::{
        ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
        MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
    },
};

struct Flags {
    counter: Arc<AtomicU64>,
}

struct Handler {
    counter: Arc<AtomicU64>,
    start: Instant,
}

impl GraphicsCaptureApiHandler for Handler {
    type Flags = Flags;
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Self {
            counter: ctx.flags.counter,
            start: Instant::now(),
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut WcFrame<'_>,
        _c: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        let n = self.counter.fetch_add(1, Ordering::Relaxed) + 1;
        let w = frame.width();
        let h = frame.height();
        let elapsed = self.start.elapsed().as_millis();
        eprintln!("[wgc_raw] frame #{n} {w}x{h} at {elapsed}ms");
        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        eprintln!("[wgc_raw] on_closed");
        Ok(())
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let monitor = Monitor::primary()?;
    let name = monitor.device_name()?;
    let w = monitor.width()?;
    let h = monitor.height()?;
    eprintln!("[wgc_raw] capturing {name} {w}x{h}");

    let counter = Arc::new(AtomicU64::new(0));
    let flags = Flags {
        counter: counter.clone(),
    };

    let settings = Settings::new(
        monitor,
        CursorCaptureSettings::WithCursor,
        DrawBorderSettings::WithoutBorder,
        SecondaryWindowSettings::Default,
        MinimumUpdateIntervalSettings::Custom(Duration::from_millis(16)),
        DirtyRegionSettings::Default,
        ColorFormat::Bgra8,
        flags,
    );

    let control = Handler::start_free_threaded(settings)?;
    // Wiggle the cursor in a separate thread to force compositor presents.
    let stop_wiggle = Arc::new(AtomicU64::new(0));
    let sw = stop_wiggle.clone();
    let wiggle = std::thread::spawn(move || {
        use std::mem::MaybeUninit;
        use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, SetCursorPos};
        while sw.load(Ordering::Relaxed) == 0 {
            let mut p = unsafe {
                let mut pt = MaybeUninit::zeroed();
                let _ = GetCursorPos(pt.as_mut_ptr());
                pt.assume_init()
            };
            unsafe { let _ = SetCursorPos(p.x + 1, p.y); }
            std::thread::sleep(Duration::from_millis(20));
            unsafe { let _ = SetCursorPos(p.x, p.y); }
            std::thread::sleep(Duration::from_millis(20));
        }
    });
    for sec in 1..=10 {
        std::thread::sleep(Duration::from_secs(1));
        eprintln!("[wgc_raw] after {sec}s: {} frames", counter.load(Ordering::Relaxed));
    }
    stop_wiggle.store(1, Ordering::Relaxed);
    let _ = wiggle.join();
    let total = counter.load(Ordering::Relaxed);
    eprintln!("[wgc_raw] total frames in 5s: {total}");
    let _ = control.stop();
    Ok(())
}
