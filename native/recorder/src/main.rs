//! KeyCap native recorder sidecar.
//!
//! Runs as a subprocess of the Electron main process. Speaks JSON-over-
//! stdio for control messages and emits status events on stdout.

mod capture;
mod encoder;
mod ipc;
mod session;

use std::io::{self, BufRead};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;

use crate::capture::DisplayInfo;
use crate::encoder::Encoder;
use crate::ipc::{RequestEnvelope, StatusPayload, Writer};
use crate::session::{Session, StartParams};

const BACKEND: &str = "rust-sidecar";
const TRANSPORT: &str = "stdio";

struct State {
    writer: Arc<Writer>,
    ffmpeg_path: PathBuf,
    default_output_dir: PathBuf,
    encoder_availability: Mutex<Option<Vec<Encoder>>>,
    displays: Mutex<Vec<DisplayInfo>>,
    session: Mutex<Option<Session>>,
    last_output_path: Mutex<String>,
    last_error: Mutex<String>,
}

impl State {
    fn new(writer: Arc<Writer>) -> Self {
        let ffmpeg_path = default_ffmpeg_path();
        let default_output_dir = session::default_output_dir();
        Self {
            writer,
            ffmpeg_path,
            default_output_dir,
            encoder_availability: Mutex::new(None),
            displays: Mutex::new(Vec::new()),
            session: Mutex::new(None),
            last_output_path: Mutex::new(String::new()),
            last_error: Mutex::new(String::new()),
        }
    }

    fn set_error(&self, message: impl Into<String>) {
        let msg = message.into();
        tracing::warn!(msg = %msg, "recorder error");
        *self.last_error.lock() = msg;
    }

    fn clear_error(&self) {
        self.last_error.lock().clear();
    }

    fn ensure_encoders(&self) -> Vec<Encoder> {
        {
            let guard = self.encoder_availability.lock();
            if let Some(list) = guard.as_ref() {
                return list.clone();
            }
        }
        let mut available = Vec::new();
        for candidate in encoder::DEFAULT_PRIORITY {
            if encoder::probe(&self.ffmpeg_path, candidate) {
                available.push(candidate);
                tracing::info!(encoder = %candidate, "encoder ok");
            } else {
                tracing::info!(encoder = %candidate, "encoder unavailable");
            }
        }
        if available.is_empty() {
            self.set_error(
                "no working H.264 encoder found — check ffmpeg bundle",
            );
        }
        *self.encoder_availability.lock() = Some(available.clone());
        available
    }

    fn refresh_displays(&self) -> Result<Vec<DisplayInfo>> {
        let list = capture::enumerate_displays()?;
        *self.displays.lock() = list.clone();
        Ok(list)
    }

    fn status_payload(&self) -> StatusPayload {
        let session = self.session.lock();
        let (state, output, encoder_used, stats) = if let Some(session) = session.as_ref() {
            let stats = session.snapshot_stats();
            (
                "recording".to_string(),
                session.output_path().to_string_lossy().into_owned(),
                session.encoder_used().label().to_string(),
                Some(stats),
            )
        } else {
            (
                "idle".to_string(),
                self.last_output_path.lock().clone(),
                String::new(),
                None,
            )
        };
        drop(session);

        let sources = self.displays.lock().len();
        StatusPayload {
            backend: BACKEND.into(),
            transport: TRANSPORT.into(),
            ready: true,
            version: env!("CARGO_PKG_VERSION").into(),
            sourceCount: sources,
            recordingState: state,
            outputPath: output,
            encoderUsed: encoder_used,
            elapsedMs: stats.as_ref().map(|s| s.elapsed_ms).unwrap_or(0),
            framesCaptured: stats.as_ref().map(|s| s.frames_captured).unwrap_or(0),
            framesEncoded: stats.as_ref().map(|s| s.frames_encoded).unwrap_or(0),
            framesDropped: stats.as_ref().map(|s| s.frames_dropped).unwrap_or(0),
            pipeMiBPerSec: stats.as_ref().map(|s| s.pipe_mib_per_sec).unwrap_or(0.0),
            lastError: self.last_error.lock().clone(),
        }
    }

    fn emit_status(&self) {
        let payload = self.status_payload();
        self.writer.emit_status(&payload);
    }
}

fn default_ffmpeg_path() -> PathBuf {
    // Ship alongside the sidecar binary at `bin/ffmpeg.exe` (or look one
    // directory up during development where this is `native/recorder/bin`).
    let exe = std::env::current_exe().ok();
    let candidates = [
        exe.as_deref()
            .and_then(Path::parent)
            .map(|p| p.join("ffmpeg.exe")),
        exe.as_deref()
            .and_then(Path::parent)
            .and_then(Path::parent)
            .map(|p| p.join("bin").join("ffmpeg.exe")),
        Some(PathBuf::from("native/recorder/bin/ffmpeg.exe")),
    ];
    for candidate in candidates.into_iter().flatten() {
        if candidate.exists() {
            return candidate;
        }
    }
    PathBuf::from("ffmpeg.exe")
}

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let writer = Arc::new(Writer::new());
    let state = Arc::new(State::new(Arc::clone(&writer)));

    // Initial status ping so the Node side sees "ready".
    state.emit_status();

    // Ticker thread: while a session is active, emit a status event every
    // 500 ms so the UI can render live fps / frames / throughput without
    // polling get_status.
    let shutdown = Arc::new(AtomicBool::new(false));
    let tick_state = Arc::clone(&state);
    let tick_shutdown = Arc::clone(&shutdown);
    let ticker = std::thread::Builder::new()
        .name("keycap-status-tick".into())
        .spawn(move || {
            while !tick_shutdown.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(500));
                if tick_shutdown.load(Ordering::Relaxed) {
                    break;
                }
                if tick_state.session.lock().is_some() {
                    tick_state.emit_status();
                }
            }
        })
        .expect("spawn status ticker");

    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(line) => line,
            Err(err) => {
                state.set_error(format!("stdin read failed: {err}"));
                state.emit_status();
                continue;
            }
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let request: RequestEnvelope = match serde_json::from_str(trimmed) {
            Ok(req) => req,
            Err(err) => {
                state.set_error(format!("invalid request: {err}"));
                state.emit_status();
                continue;
            }
        };

        if request.kind != "request" {
            continue;
        }

        let should_break = dispatch(&state, request);
        state.emit_status();
        if should_break {
            break;
        }
    }

    // Clean up any in-flight recording on shutdown.
    let session = state.session.lock().take();
    if let Some(session) = session {
        let _ = session.stop();
    }

    // Join the status ticker before exit so it doesn't outlive stdout.
    shutdown.store(true, Ordering::Relaxed);
    let _ = ticker.join();

    Ok(())
}

fn dispatch(state: &Arc<State>, request: RequestEnvelope) -> bool {
    match request.method.as_str() {
        "handshake" => {
            handle_handshake(state, request.id);
            false
        }
        "list_sources" => {
            handle_list_sources(state, request.id);
            false
        }
        "start_recording" => {
            handle_start_recording(state, request.id, request.params);
            false
        }
        "stop_recording" => {
            handle_stop_recording(state, request.id);
            false
        }
        "get_status" => {
            handle_get_status(state, request.id);
            false
        }
        "shutdown" => {
            state
                .writer
                .reply_ok(request.id, &serde_json::json!({ "ok": true }));
            true
        }
        other => {
            state
                .writer
                .reply_err(request.id, &format!("unknown method: {other}"));
            false
        }
    }
}

#[derive(Debug, Serialize)]
struct HandshakeReply<'a> {
    ok: bool,
    backend: &'a str,
    transport: &'a str,
    version: &'a str,
}

fn handle_handshake(state: &Arc<State>, id: u64) {
    // Probe encoders and enumerate displays eagerly so the first real
    // request is quick.
    let encoders = state.ensure_encoders();
    match state.refresh_displays() {
        Ok(_) => state.clear_error(),
        Err(err) => state.set_error(err.to_string()),
    }
    tracing::info!(encoder_count = encoders.len(), "handshake complete");

    state.writer.reply_ok(
        id,
        &HandshakeReply {
            ok: true,
            backend: BACKEND,
            transport: TRANSPORT,
            version: env!("CARGO_PKG_VERSION"),
        },
    );
}

#[derive(Debug, Serialize)]
struct SourceListReply {
    sources: Vec<DisplayInfo>,
}

fn handle_list_sources(state: &Arc<State>, id: u64) {
    match state.refresh_displays() {
        Ok(displays) => {
            state.clear_error();
            state.writer.reply_ok(id, &SourceListReply { sources: displays });
        }
        Err(err) => {
            state.set_error(err.to_string());
            state.writer.reply_err(id, &err.to_string());
        }
    }
}

fn handle_start_recording(state: &Arc<State>, id: u64, params: Option<Value>) {
    let params_value = params.unwrap_or(Value::Null);
    let parsed: std::result::Result<StartParams, _> = serde_json::from_value(params_value);
    let params = match parsed {
        Ok(p) => p,
        Err(err) => {
            let msg = format!("invalid start_recording params: {err}");
            state.set_error(msg.clone());
            state.writer.reply_err(id, &msg);
            return;
        }
    };

    {
        let guard = state.session.lock();
        if guard.is_some() {
            state.writer.reply_err(id, "recording already in progress");
            return;
        }
    }

    // Refresh displays so we don't try to open a stale handle.
    if let Err(err) = state.refresh_displays() {
        let msg = err.to_string();
        state.set_error(msg.clone());
        state.writer.reply_err(id, &msg);
        return;
    }

    let available = state.ensure_encoders();
    if available.is_empty() {
        state.writer.reply_err(id, "no h264 encoder available");
        return;
    }

    let displays = state.displays.lock().clone();
    match Session::start(
        &state.ffmpeg_path,
        &displays,
        params,
        &available,
        &state.default_output_dir,
    ) {
        Ok(session) => {
            state.clear_error();
            let reply = session::StartResult {
                ok: true,
                outputPath: session.output_path().to_string_lossy().into_owned(),
                encoderUsed: session.encoder_used().label().to_string(),
                width: session.width(),
                height: session.height(),
                fps: session.fps(),
                bitrateKbps: 0, // populated once we track it explicitly
            };
            *state.last_output_path.lock() = reply.outputPath.clone();
            state.writer.reply_ok(id, &reply);
            *state.session.lock() = Some(session);
        }
        Err(err) => {
            let msg = err.to_string();
            state.set_error(msg.clone());
            state.writer.reply_err(id, &msg);
        }
    }
}

fn handle_stop_recording(state: &Arc<State>, id: u64) {
    let session = state.session.lock().take();
    let Some(session) = session else {
        state.writer.reply_ok(
            id,
            &serde_json::json!({
                "ok": true,
                "outputPath": "",
                "framesCaptured": 0,
                "framesEncoded": 0,
                "framesDropped": 0,
                "durationMs": 0,
                "encoderUsed": "",
            }),
        );
        return;
    };
    match session.stop() {
        Ok(result) => {
            *state.last_output_path.lock() = result.outputPath.clone();
            state.clear_error();
            state.writer.reply_ok(id, &result);
        }
        Err(err) => {
            let msg = err.to_string();
            state.set_error(msg.clone());
            state.writer.reply_err(id, &msg);
        }
    }
}

fn handle_get_status(state: &Arc<State>, id: u64) {
    let payload = state.status_payload();
    state.writer.reply_ok(id, &payload);
}

// Silence unused warnings on platforms where certain helpers aren't wired up.
#[allow(dead_code)]
fn _unused_is_fine(_: &anyhow::Error) {}
