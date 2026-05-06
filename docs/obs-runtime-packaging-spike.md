# OBS Runtime Packaging Spike

## Goal

Prove KeyCap can run the OBS recorder engine from a private packaged runtime instead of relying on the user's installed OBS Studio.

This is a packaging spike, not a shipping policy. The runtime copied by the staging script is local-only and ignored by git.

## Local Staging

Stage a local OBS install into the ignored runtime folder:

```powershell
npm run obs:stage-runtime
```

Optional explicit source:

```powershell
npm run obs:stage-runtime -- --source "C:\Program Files\obs-studio"
```

The script copies only the runtime directories the sidecar needs:

- `bin`
- `data`
- `obs-plugins`

Destination:

```text
vendor/obs-studio
```

That folder is ignored by git and should never be committed.

## Runtime Selection

The app searches for OBS in this order by default:

1. Packaged runtime locations such as `resources\obs-studio`, app-root `obs-studio`, and app-root `vendor\obs-studio`.
2. Installed OBS locations such as `OBS_STUDIO_ROOT` and `C:\Program Files\obs-studio`.

To prove the packaged runtime is actually being used, force bundled-only mode:

```powershell
$env:KEYCAP_OBS_RUNTIME_MODE='bundled'
```

In this mode, system OBS paths are ignored. A successful OBS-engine recording means KeyCap is using the staged/bundled runtime path.

Bundled-only mode also defaults the recorder engine preference to OBS unless `KEYCAP_RECORDER_BACKEND` or `KEYCAP_NATIVE_RECORDER` explicitly chooses another backend.

To force installed/system OBS only:

```powershell
$env:KEYCAP_OBS_RUNTIME_MODE='system'
```

## Validation

1. Stage OBS:

   ```powershell
   npm run obs:stage-runtime
   ```

2. Rebuild the unpacked app:

   ```powershell
   $env:CSC_IDENTITY_AUTO_DISCOVERY='false'
   npx electron-builder --win dir
   ```

3. Launch with bundled-only runtime search:

   ```powershell
   cd dist\win-unpacked
   $env:KEYCAP_OBS_RUNTIME_MODE='bundled'
   .\KeyCap.exe
   ```

4. Choose `OBS engine` in Recording setup.
5. Record a short 4K60 sample.
6. Confirm the engine status points at the staged packaged runtime, not `C:\Program Files\obs-studio`.

## Compliance Notes

OBS Studio is GPLv2-or-later. Before distributing any KeyCap build that includes OBS binaries, we need a release checklist that includes:

- Ship OBS license and copyright notices.
- Provide source access for the exact OBS version included.
- Provide source access for any OBS modifications if we ever modify it.
- Avoid implying OBS Project endorsement.
- Keep KeyCap branding separate from OBS branding.
- Document that OBS components are included as a third-party runtime.

The safer production shape is to bundle an unmodified OBS runtime as a separate recorder engine process and control it over local IPC/websocket. Directly linking `libobs` into KeyCap or modifying OBS internals needs a more careful legal and source-distribution review.
