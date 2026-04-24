//! JSON-over-stdio envelope codec for the sidecar.
//!
//! Control messages (request/response) are line-delimited JSON on
//! stdin/stdout. Status events are emitted asynchronously as
//! `{ type: "event", event: "status", payload: {...} }`.

use std::io::{self, Write};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Deserialize)]
pub struct RequestEnvelope {
    #[serde(rename = "type")]
    pub kind: String,
    pub id: u64,
    pub method: String,
    #[serde(default)]
    pub params: Option<Value>,
}

#[derive(Debug, Serialize)]
struct ErrorPayload<'a> {
    message: &'a str,
}

#[derive(Debug, Serialize)]
struct ResponseEnvelope<'a, T: Serialize> {
    #[serde(rename = "type")]
    kind: &'static str,
    id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<&'a T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ErrorPayload<'a>>,
}

#[derive(Debug, Serialize)]
struct EventEnvelope<T: Serialize> {
    #[serde(rename = "type")]
    kind: &'static str,
    event: &'static str,
    payload: T,
}

#[allow(non_snake_case)]
#[derive(Debug, Serialize, Default, Clone)]
pub struct StatusPayload {
    pub backend: String,
    pub transport: String,
    pub ready: bool,
    pub version: String,
    pub sourceCount: usize,
    pub recordingState: String,
    pub outputPath: String,
    pub encoderUsed: String,
    pub compositeMode: String,
    pub elapsedMs: u64,
    pub framesCaptured: u64,
    pub framesEncoded: u64,
    pub framesDropped: u64,
    pub pipeMiBPerSec: f64,
    pub lastError: String,
}

/// Thread-safe stdout writer. Serializes one JSON doc per line.
pub struct Writer {
    inner: Mutex<io::Stdout>,
}

impl Writer {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(io::stdout()),
        }
    }

    fn emit<T: Serialize>(&self, value: &T) -> io::Result<()> {
        let mut guard = self.inner.lock();
        serde_json::to_writer(&mut *guard, value)?;
        guard.write_all(b"\n")?;
        guard.flush()
    }

    pub fn reply_ok<T: Serialize>(&self, id: u64, result: &T) {
        let envelope = ResponseEnvelope {
            kind: "response",
            id,
            result: Some(result),
            error: None,
        };
        if let Err(err) = self.emit(&envelope) {
            eprintln!("stdout write failed: {err}");
        }
    }

    pub fn reply_err(&self, id: u64, message: &str) {
        let envelope: ResponseEnvelope<'_, Value> = ResponseEnvelope {
            kind: "response",
            id,
            result: None,
            error: Some(ErrorPayload { message }),
        };
        if let Err(err) = self.emit(&envelope) {
            eprintln!("stdout write failed: {err}");
        }
    }

    pub fn emit_status(&self, payload: &StatusPayload) {
        let envelope = EventEnvelope {
            kind: "event",
            event: "status",
            payload,
        };
        if let Err(err) = self.emit(&envelope) {
            eprintln!("stdout write failed: {err}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_request_envelope() {
        let raw = r#"{"type":"request","id":7,"method":"list_sources","params":{"kind":"display"}}"#;
        let parsed: RequestEnvelope = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.kind, "request");
        assert_eq!(parsed.id, 7);
        assert_eq!(parsed.method, "list_sources");
        assert!(parsed.params.is_some());
    }

    #[test]
    fn parses_request_without_params() {
        let raw = r#"{"type":"request","id":1,"method":"handshake"}"#;
        let parsed: RequestEnvelope = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.method, "handshake");
        assert!(parsed.params.is_none());
    }

    #[test]
    fn serializes_status_payload() {
        let mut s = StatusPayload::default();
        s.backend = "rust-sidecar".to_string();
        s.ready = true;
        s.recordingState = "idle".to_string();
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains(r#""backend":"rust-sidecar""#));
        assert!(json.contains(r#""ready":true"#));
        assert!(json.contains(r#""recordingState":"idle""#));
        // Node side expects camelCase field names — make sure serde didn't
        // rename them.
        assert!(json.contains(r#""sourceCount":0"#));
        assert!(json.contains(r#""framesDropped":0"#));
    }
}
