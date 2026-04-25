//! FFI bindings for NVENC (NVIDIA Video Codec SDK).
//!
//! Generated at build time by `build.rs` running `bindgen` against the
//! vendored `nvEncodeAPI.h` (FFmpeg's `nv-codec-headers` mirror, NVIDIA
//! permissively-licensed). The generated file lives in `OUT_DIR` and
//! is included verbatim here.
//!
//! Do not hand-edit. Update the vendored header and rebuild instead.

#![allow(dead_code, non_snake_case, non_camel_case_types, non_upper_case_globals)]
#![cfg(windows)]

include!(concat!(env!("OUT_DIR"), "/nvenc_bindings.rs"));
