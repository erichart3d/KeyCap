# CEF Browser Source Feasibility Probe

This spike measures whether a CEF-backed offscreen browser can deliver the real KeyCap overlay at the cadences the recorder needs. It uses CefSharp OffScreen so we can test CEF `Paint` timing quickly without integrating CEF into the Rust recorder yet.

Run:

```powershell
npm run spike:cef-source -- --width=1920 --height=1080 --fps=60 --duration=6
```

Target runs:

```powershell
npm run spike:cef-source -- --width=1920 --height=1080 --fps=30 --duration=6 --output=native/recorder/target/cef-browser-source-feasibility/1080p30
npm run spike:cef-source -- --width=1920 --height=1080 --fps=60 --duration=6 --output=native/recorder/target/cef-browser-source-feasibility/1080p60
npm run spike:cef-source -- --width=3840 --height=2160 --fps=30 --duration=6 --output=native/recorder/target/cef-browser-source-feasibility/4k30
npm run spike:cef-source -- --width=3840 --height=2160 --fps=60 --duration=6 --output=native/recorder/target/cef-browser-source-feasibility/4k60
```

Use `--fade=crt-smear`, `--animation-speed=1`, `--lifetime=3000`, or `--max-keys=4` to test specific overlay animation settings.
Use `--transport=shared-texture` to receive CEF accelerated paint callbacks backed by D3D11 shared handles.
Use `--begin-frame=external` with shared textures to have the probe request Chromium frames on the target recorder clock.
Use `--validate-d3d11` with shared textures to open each CEF shared handle with D3D11.1 `OpenSharedResource1`, copy it into a probe-owned texture, and report `d3d11Validation` open/copy counts and timings.

Outputs are written to `native/recorder/target/cef-browser-source-feasibility/<timestamp>/report.json` unless `--output` is supplied.

Treat a run as invalid if `actualSurface.matchesTarget` is false. The important numbers are `paint.avgMs`, `paint.p95Ms`, `paint.maxMs`, `paint.gapsOverBudget`, and `keyLatencyToPaint.p95Ms`.

Initial result: the probe validates true 1080p and 4K CEF surfaces, and `--transport=shared-texture` does produce accelerated D3D11-backed callbacks. CPU paint is not viable for the final recorder. Shared textures remove the CPU BGRA transport problem, and `--validate-d3d11` confirms the handles can be opened and copied into recorder-owned D3D11 textures. The CEF handles must be opened with D3D11.1 `OpenSharedResource1`; legacy `OpenSharedResource` returns `E_INVALIDARG` for these NT handles. Full-size `crt-smear` still averages around 20 ms with long p95/max paint gaps, so the remaining risk is Chromium/CEF paint cadence rather than D3D11 texture ingestion. `--begin-frame=external` was less stable in this harness, so the next useful spike is either direct OBS/libobs browser-source reuse or deeper CEF/browser animation tuning.
