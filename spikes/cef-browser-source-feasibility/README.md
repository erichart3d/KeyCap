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
Use `--diagnostic-mode=real|static|empty|transform|opacity|filter|real-no-captions|real-no-metrics|real-no-expire|simple-keys|pooled-keys` to isolate browser cadence causes:

- `real`: use the real `addKey` path.
- `static`: use the real `addKey` path with key animations disabled.
- `empty`: keep the overlay empty to measure idle paints.
- `transform`, `opacity`, `filter`: inject one synthetic keycap with a continuous simple CSS animation.
- `real-no-captions`: use the real `addKey` path with captions disabled.
- `real-no-metrics`: use the real `addKey` path with `ThemeRuntime.syncThemeMetrics` replaced by a no-op.
- `real-no-expire`: use the real `addKey` path with a long lifetime and high `maxKeys` so fade-out/removal pressure is avoided during the run.
- `simple-keys`: replace `addKey` with minimal key/caption DOM that keeps the normal `.key`, `.keycap`, and `.caption` classes.
- `pooled-keys`: pre-create four key slots and update/restart them instead of appending/removing key nodes.

Outputs are written to `native/recorder/target/cef-browser-source-feasibility/<timestamp>/report.json` unless `--output` is supplied.

Treat a run as invalid if `actualSurface.matchesTarget` is false. The important numbers are `paint.avgMs`, `paint.p95Ms`, `paint.maxMs`, `paint.gapsOverBudget`, and `keyLatencyToPaint.p95Ms`.

Initial result: the probe validates true 1080p and 4K CEF surfaces, and `--transport=shared-texture` does produce accelerated D3D11-backed callbacks. CPU paint is not viable for the final recorder. Shared textures remove the CPU BGRA transport problem, and `--validate-d3d11` confirms the handles can be opened and copied into recorder-owned D3D11 textures. The CEF handles must be opened with D3D11.1 `OpenSharedResource1`; legacy `OpenSharedResource` returns `E_INVALIDARG` for these NT handles.

Cadence diagnostics show simple synthetic compositor animations are much closer to 60 fps than the real key overlay path at both 1080p60 and 4K60. Real `fade` averages about 20 ms per paint, and real `crt-smear` has p95 gaps around 68-69 ms. Synthetic transform/opacity/filter modes average about 16.5 ms with p95 around 27-30 ms. That points to the real overlay DOM/key lifecycle/theme animation path as the next optimization target, not resolution, D3D11 handle ingestion, or GPU copy cost.

Overlay path profiling narrows that further. `ThemeRuntime.syncThemeMetrics` is most of the JavaScript time inside `addKey`, but it is not the paint cadence limiter: replacing it with a no-op drops `addKey` from roughly 1.8 ms to 0.14 ms without moving paint cadence off roughly 20 ms. A minimal `simple-keys` replacement is also still roughly 20 ms, and avoiding fade-out/removal pressure does not materially change the result. A naive pooled-slot path is worse because hide/show plus forced animation restart introduces larger CEF paint gaps. The next production-oriented experiment should compare against OBS/libobs browser-source behavior or a different browser animation delivery model rather than only trimming `addKey` JavaScript.
