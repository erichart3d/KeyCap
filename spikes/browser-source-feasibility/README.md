# Browser Source Feasibility Probe

This spike measures whether the real KeyCap overlay page can paint smoothly when driven as an offscreen browser source. It does not change production recorder behavior.

Run:

```powershell
npm run spike:browser-source -- --width=1920 --height=1080 --fps=60 --duration=6
```

Useful variants:

```powershell
npm run spike:browser-source -- --width=3840 --height=2160 --fps=60 --duration=8 --key-interval=350
npm run spike:browser-source -- --width=1920 --height=1080 --fps=60 --duration=8 --fade=crt-smear
npm run spike:browser-source -- --overlay-url=http://127.0.0.1:8765/ --duration=6
```

Outputs are written to `native/recorder/target/browser-source-feasibility/<timestamp>/`:

- `report.json`: paint cadence, rAF cadence, key-to-paint latency, long paint gaps.
- `snapshot.png`: one transparent overlay snapshot near the end of the run.

The important numbers are `paint.gapsOverBudget`, `paint.p95Ms`, `paint.maxMs`, and `keyLatencyToPaint.p95Ms`. For 60 fps, repeated paint gaps above 25 ms are likely to show up as sluggish overlay animation.

The report also includes `actualSurface`. Treat a result as invalid if `actualSurface.matchesTarget` is false; Electron may otherwise constrain a hidden offscreen window to the desktop work area instead of the requested recording resolution.

