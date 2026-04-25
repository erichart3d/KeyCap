// Build script for the keycap-recorder sidecar.
//
// On Windows, we run `bindgen` against the vendored NVENC SDK header
// (`vendor/nv-codec-headers/nvEncodeAPI.h`, sourced from FFmpeg's
// `nv-codec-headers` mirror under NVIDIA's permissive license). The
// generated bindings are written to `$OUT_DIR/nvenc_bindings.rs`, then
// pulled in by `src/encoder/nvenc_sys.rs` via `include!`.
//
// We don't link against `nvEncodeAPI.lib` — the runtime DLL
// (`nvEncodeAPI64.dll`, shipped with every NVIDIA driver) is loaded
// dynamically with `LoadLibraryW` + `GetProcAddress`. That keeps the
// build self-contained: developers just need LLVM/libclang for
// bindgen, not the full NVIDIA Video Codec SDK install.
//
// On non-Windows builds, this script is a no-op — the recorder doesn't
// have a non-Windows native path yet.

#[cfg(windows)]
fn main() {
    use std::env;
    use std::path::PathBuf;

    let manifest_dir = env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR set by cargo");
    let header = PathBuf::from(&manifest_dir)
        .join("vendor")
        .join("nv-codec-headers")
        .join("nvEncodeAPI.h");

    println!("cargo:rerun-if-changed={}", header.display());
    println!("cargo:rerun-if-changed=build.rs");

    // Allow LIBCLANG_PATH override for the most common case (LLVM
    // installed but not on PATH). Bindgen reads this internally.
    if env::var("LIBCLANG_PATH").is_err() {
        // Best-effort default for the standard Windows LLVM install.
        let default_llvm = r"C:\Program Files\LLVM\bin";
        if PathBuf::from(default_llvm).join("libclang.dll").exists() {
            println!("cargo:rustc-env=LIBCLANG_PATH={}", default_llvm);
            // Set for the bindgen run too.
            env::set_var("LIBCLANG_PATH", default_llvm);
        }
    }

    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR set by cargo"));
    let bindings_path = out_dir.join("nvenc_bindings.rs");

    let bindings = bindgen::Builder::default()
        .header(header.to_string_lossy().as_ref())
        // Allowlist what we actually use, so the generated file stays
        // focused — the full NVENC header pulls in dozens of types.
        .allowlist_type("NV_ENCODE_API_FUNCTION_LIST")
        .allowlist_type("NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS")
        .allowlist_type("NV_ENC_INITIALIZE_PARAMS")
        .allowlist_type("NV_ENC_CONFIG")
        .allowlist_type("NV_ENC_CONFIG_H264")
        .allowlist_type("NV_ENC_CONFIG_H264_VUI_PARAMETERS")
        .allowlist_type("NV_ENC_PRESET_CONFIG")
        .allowlist_type("NV_ENC_RC_PARAMS")
        .allowlist_type("NV_ENC_QP")
        .allowlist_type("NV_ENC_REGISTER_RESOURCE")
        .allowlist_type("NV_ENC_MAP_INPUT_RESOURCE")
        .allowlist_type("NV_ENC_CREATE_BITSTREAM_BUFFER")
        .allowlist_type("NV_ENC_PIC_PARAMS")
        .allowlist_type("NV_ENC_LOCK_BITSTREAM")
        .allowlist_type("NV_ENC_BUFFER_FORMAT")
        .allowlist_type("NV_ENC_DEVICE_TYPE")
        .allowlist_type("NV_ENC_INPUT_RESOURCE_TYPE")
        .allowlist_type("NV_ENC_PIC_STRUCT")
        .allowlist_type("NV_ENC_PIC_TYPE")
        .allowlist_type("NV_ENC_PIC_FLAGS")
        .allowlist_type("NV_ENC_PARAMS_RC_MODE")
        .allowlist_type("NV_ENC_TUNING_INFO")
        .allowlist_type("NVENCSTATUS")
        .allowlist_type("GUID")
        .allowlist_var("NV_ENC_.*_VER")
        .allowlist_var("NV_ENCODE_API_FUNCTION_LIST_VER")
        .allowlist_var("NVENCAPI_VERSION")
        .allowlist_var("NVENCAPI_MAJOR_VERSION")
        .allowlist_var("NVENCAPI_MINOR_VERSION")
        .allowlist_var("NV_ENC_CODEC_H264_GUID")
        .allowlist_var("NV_ENC_PRESET_.*_GUID")
        .allowlist_var("NV_ENC_H264_PROFILE_.*_GUID")
        // Bindgen's default Rust enum representation uses real `enum`s
        // which are unsound for FFI when the C side may pass values
        // outside the declared variants (which NVENC enums sometimes
        // do for "reserved" slots). Force them to plain consts inside
        // a wrapping module instead.
        .default_enum_style(bindgen::EnumVariation::ModuleConsts)
        // Drop windows.h hangers-on; we don't need them in the FFI
        // surface and they bring noise.
        .blocklist_type("HINSTANCE__")
        .blocklist_type("HWND__")
        .blocklist_type("HBITMAP__")
        .blocklist_type("HMENU__")
        .blocklist_type("HBRUSH__")
        .blocklist_type("HICON__")
        .blocklist_type("HCURSOR__")
        .blocklist_type("HRGN__")
        .blocklist_type("HMONITOR__")
        .blocklist_type("HPALETTE__")
        // Use core::ffi for primitive C types.
        .use_core()
        // Don't generate layout tests — they require running the
        // compiler against the C side which we don't ship.
        .layout_tests(false)
        // Suppress derive(Debug) on huge reserved-byte arrays — they
        // bloat the generated file and we don't print these at runtime.
        .derive_debug(false)
        .derive_copy(true)
        .derive_default(true)
        // Bindgen-emitted bindings include a lot of trailing reserved
        // arrays; without the size cap, large arrays (e.g. `[u8; 4096]`)
        // skip Default unless we say so explicitly.
        .generate_comments(false)
        .clang_arg("-x")
        .clang_arg("c")
        // Windows.h hides behind macros — guard the header against the
        // incompatible bits.
        .clang_arg("-D_WIN32")
        .clang_arg("-DNVENCAPI=__stdcall")
        .generate()
        .expect("bindgen: failed to generate NVENC bindings — is libclang installed?");

    bindings
        .write_to_file(&bindings_path)
        .expect("bindgen: failed to write bindings");
}

#[cfg(not(windows))]
fn main() {
    // No-op on non-Windows.
}
