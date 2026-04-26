//! Minimal WGC capture of the foreground window to rule out a
//! monitor-specific issue.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use windows_capture::{
    capture::{Context, GraphicsCaptureApiHandler},
    frame::Frame as WcFrame,
    graphics_capture_api::InternalCaptureControl,
    settings::{
        ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
        MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
    },
    window::Window,
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
        Ok(Self { counter: ctx.flags.counter, start: Instant::now() })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut WcFrame<'_>,
        _c: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        let n = self.counter.fetch_add(1, Ordering::Relaxed) + 1;
        eprintln!("[wgc_window] frame #{n} {}x{} at {}ms", frame.width(), frame.height(), self.start.elapsed().as_millis());
        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        eprintln!("[wgc_window] on_closed");
        Ok(())
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let windows = Window::enumerate()?;
    let window = windows
        .into_iter()
        .find(|w| w.title().ok().map(|t| !t.is_empty()).unwrap_or(false))
        .ok_or("no named window")?;
    eprintln!("[wgc_window] capturing '{}'", window.title().unwrap_or_default());

    let counter = Arc::new(AtomicU64::new(0));
    let flags = Flags { counter: counter.clone() };

    let settings = Settings::new(
        window,
        CursorCaptureSettings::Default,
        DrawBorderSettings::Default,
        SecondaryWindowSettings::Default,
        MinimumUpdateIntervalSettings::Custom(Duration::from_millis(16)),
        DirtyRegionSettings::Default,
        ColorFormat::Bgra8,
        flags,
    );

    let control = Handler::start_free_threaded(settings)?;
    for sec in 1..=5 {
        std::thread::sleep(Duration::from_secs(1));
        eprintln!("[wgc_window] after {sec}s: {} frames", counter.load(Ordering::Relaxed));
    }
    let _ = control.stop();
    Ok(())
}
