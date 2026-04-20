use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{self, BufRead, Write};

#[derive(Debug, Deserialize)]
struct RequestEnvelope {
    #[serde(rename = "type")]
    kind: String,
    id: u64,
    method: String,
    #[allow(dead_code)]
    params: Option<Value>,
}

#[derive(Debug, Serialize)]
struct ErrorPayload {
    message: String,
}

#[derive(Debug, Serialize)]
struct ResponseEnvelope<T: Serialize> {
    #[serde(rename = "type")]
    kind: &'static str,
    id: u64,
    result: Option<T>,
    error: Option<ErrorPayload>,
}

#[derive(Debug, Serialize)]
struct EventEnvelope<T: Serialize> {
    #[serde(rename = "type")]
    kind: &'static str,
    event: &'static str,
    payload: T,
}

#[derive(Debug, Serialize)]
struct StatusPayload<'a> {
    backend: &'a str,
    transport: &'a str,
    ready: bool,
    version: &'a str,
    sourceCount: usize,
    lastError: &'a str,
}

#[derive(Debug, Serialize)]
struct HandshakePayload<'a> {
    ok: bool,
    backend: &'a str,
    transport: &'a str,
    version: &'a str,
}

#[derive(Debug, Serialize)]
struct SourceListPayload {
    sources: Vec<Value>,
}

fn write_json<T: Serialize>(value: &T) -> io::Result<()> {
    let mut stdout = io::stdout().lock();
    serde_json::to_writer(&mut stdout, value)?;
    stdout.write_all(b"\n")?;
    stdout.flush()
}

fn emit_status(source_count: usize, last_error: &str) -> io::Result<()> {
    write_json(&EventEnvelope {
        kind: "event",
        event: "status",
        payload: StatusPayload {
            backend: "rust-sidecar",
            transport: "stdio",
            ready: true,
            version: env!("CARGO_PKG_VERSION"),
            sourceCount: source_count,
            lastError: last_error,
        },
    })
}

fn main() -> io::Result<()> {
    emit_status(0, "")?;

    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(line) => line,
            Err(err) => {
                emit_status(0, &err.to_string())?;
                continue;
            }
        };
        if line.trim().is_empty() {
            continue;
        }

        let request: RequestEnvelope = match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(err) => {
                emit_status(0, &err.to_string())?;
                continue;
            }
        };

        if request.kind != "request" {
            continue;
        }

        match request.method.as_str() {
            "handshake" => {
                let response = ResponseEnvelope {
                    kind: "response",
                    id: request.id,
                    result: Some(HandshakePayload {
                        ok: true,
                        backend: "rust-sidecar",
                        transport: "stdio",
                        version: env!("CARGO_PKG_VERSION"),
                    }),
                    error: None,
                };
                write_json(&response)?;
            }
            "list_sources" => {
                // Milestone 1 scaffold only. Real Windows Graphics Capture
                // enumeration lands in the next native implementation pass.
                let response = ResponseEnvelope {
                    kind: "response",
                    id: request.id,
                    result: Some(SourceListPayload { sources: vec![] }),
                    error: None,
                };
                write_json(&response)?;
            }
            "shutdown" => {
                let response: ResponseEnvelope<Value> = ResponseEnvelope {
                    kind: "response",
                    id: request.id,
                    result: Some(serde_json::json!({ "ok": true })),
                    error: None,
                };
                write_json(&response)?;
                break;
            }
            other => {
                let response: ResponseEnvelope<Value> = ResponseEnvelope {
                    kind: "response",
                    id: request.id,
                    result: None,
                    error: Some(ErrorPayload {
                        message: format!("unknown method: {other}"),
                    }),
                };
                write_json(&response)?;
            }
        }
    }

    Ok(())
}
