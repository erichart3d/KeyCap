using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;
using CefSharp;
using CefSharp.OffScreen;
using Vortice.Direct3D;
using Vortice.Direct3D11;

var keySequence = new (string Label, string Description)[]
{
    ("CTRL + S", "Save"),
    ("SHIFT", "Dash"),
    ("A", "Move Left"),
    ("D", "Move Right"),
    ("SPACE", "Jump"),
    ("CTRL + Z", "Undo"),
    ("ALT + TAB", "Switch"),
    ("ESC", "Cancel"),
};

var jsonOptions = new JsonSerializerOptions
{
    PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    PropertyNameCaseInsensitive = true,
    WriteIndented = true,
};

var options = Options.Parse(args);
Directory.CreateDirectory(options.OutputDir);

if (options.ValidateD3D11 && !options.UseSharedTexture)
{
    throw new InvalidOperationException("--validate-d3d11 requires --transport=shared-texture");
}

Process? ownedServer = null;
var overlayUrl = options.OverlayUrl;

try
{
    if (!await IsReachableAsync(overlayUrl))
    {
        ownedServer = StartKeyCapServer(options.RepoRoot);
        await WaitForServerAsync(overlayUrl, TimeSpan.FromSeconds(12));
    }

    var settings = new CefSettings
    {
        WindowlessRenderingEnabled = true,
        CachePath = Path.Combine(options.OutputDir, "cef-cache"),
        LogFile = Path.Combine(options.OutputDir, "cef.log"),
        LogSeverity = LogSeverity.Warning,
    };
    settings.CefCommandLineArgs["disable-background-timer-throttling"] = "1";
    settings.CefCommandLineArgs["disable-renderer-backgrounding"] = "1";
    settings.CefCommandLineArgs["disable-backgrounding-occluded-windows"] = "1";
    settings.CefCommandLineArgs["autoplay-policy"] = "no-user-gesture-required";

    if (!Cef.Initialize(settings, performDependencyCheck: true, browserProcessHandler: null))
    {
        throw new InvalidOperationException("Cef.Initialize returned false");
    }

    var browserSettings = new BrowserSettings
    {
        WindowlessFrameRate = Math.Clamp(options.Fps, 1, 60),
        BackgroundColor = 0x00000000,
    };

    using var browser = new ChromiumWebBrowser(
        overlayUrl,
        browserSettings,
        requestContext: null,
        automaticallyCreateBrowser: false,
        onAfterBrowserCreated: null,
        useLegacyRenderHandler: !options.UseSharedTexture)
    {
        Size = new System.Drawing.Size(options.Width, options.Height),
    };

    var stopwatch = Stopwatch.StartNew();
    var paintTimes = new List<double>();
    var dirtyRects = new List<RectSnapshot>();
    var paintSizes = new ConcurrentBag<SurfaceSize>();
    var pendingKeys = new ConcurrentQueue<KeyMarker>();
    var keyLatencies = new List<double>();
    var cpuPaintFrames = 0;
    var acceleratedPaintFrames = 0;
    var paintLock = new object();
    using var d3d11Validator = options.ValidateD3D11 ? D3D11SharedTextureValidator.Create() : null;

    void RecordPaint(double now, int width, int height, RectSnapshot dirtyRect, bool accelerated)
    {
        lock (paintLock)
        {
            paintTimes.Add(now);
            paintSizes.Add(new SurfaceSize(width, height));
            if (accelerated) acceleratedPaintFrames++;
            else cpuPaintFrames++;
            if (dirtyRects.Count < 10)
            {
                dirtyRects.Add(dirtyRect);
            }
            while (pendingKeys.TryDequeue(out var marker))
            {
                keyLatencies.Add(now - marker.SentAtMs);
            }
        }
    }

    var renderHandler = new ProbeRenderHandler(
        browser,
        options.Width,
        options.Height,
        () => stopwatch.Elapsed.TotalMilliseconds,
        RecordPaint,
        d3d11Validator);
    browser.RenderHandler = renderHandler;

    var windowInfo = CefSharp.Core.ObjectFactory.CreateWindowInfo();
    windowInfo.SetAsWindowless(IntPtr.Zero);
    windowInfo.Width = options.Width;
    windowInfo.Height = options.Height;
    windowInfo.SharedTextureEnabled = options.UseSharedTexture;
    windowInfo.ExternalBeginFrameEnabled = options.UseExternalBeginFrame;
    browser.CreateBrowser(windowInfo, browserSettings);

    await WaitForInitialLoadAsync(browser, TimeSpan.FromSeconds(20));
    browser.Size = new System.Drawing.Size(options.Width, options.Height);
    browser.GetBrowserHost().WasResized();

    await WaitForJavaScriptConditionAsync(
        browser,
        "typeof window.addKey === 'function' && !!document.getElementById('overlay')",
        TimeSpan.FromSeconds(8));

    await EvaluateAsync(browser, """
        (() => {
          window.__keycapProbe = { rafTimes: [], startedAt: performance.now() };
          const tick = (time) => {
            window.__keycapProbe.rafTimes.push(time);
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
          return true;
        })()
        """);

    var configOverride = options.GetConfigOverride();
    if (configOverride.Count > 0)
    {
        await EvaluateAsync(browser, $"window.applyConfig({JsonSerializer.Serialize(configOverride, jsonOptions)})");
    }
    await InstallDiagnosticModeAsync(browser, options.DiagnosticMode);

    var startedAt = stopwatch.Elapsed.TotalMilliseconds;
    var deadline = startedAt + options.DurationMs;
    var nextKeyAt = startedAt + 250;
    var nextBeginFrameAt = startedAt;
    var keyCount = 0;

    while (stopwatch.Elapsed.TotalMilliseconds < deadline)
    {
        var now = stopwatch.Elapsed.TotalMilliseconds;
        if (options.UseExternalBeginFrame && now >= nextBeginFrameAt)
        {
            browser.GetBrowserHost().SendExternalBeginFrame();
            nextBeginFrameAt += options.FrameBudgetMs;
        }
        if (options.ShouldInjectKeys && now >= nextKeyAt)
        {
            var key = keySequence[keyCount % keySequence.Length];
            pendingKeys.Enqueue(new KeyMarker(now));
            await EvaluateAsync(browser, $"window.addKey({JsonSerializer.Serialize(key.Label)}, {JsonSerializer.Serialize(key.Description)})");
            keyCount++;
            nextKeyAt += options.KeyIntervalMs;
        }
        await Task.Delay(5);
    }

    await Task.Delay(Math.Min(500, (int)Math.Ceiling(options.FrameBudgetMs * 4)));

    var viewportJson = await EvaluateStringAsync(browser, """
        JSON.stringify({
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          outerWidth: window.outerWidth,
          outerHeight: window.outerHeight,
          devicePixelRatio: window.devicePixelRatio
        })
        """);
    var rafJson = await EvaluateStringAsync(browser, "JSON.stringify(window.__keycapProbe?.rafTimes || [])");
    var pageStatsJson = await EvaluateStringAsync(browser, """
        JSON.stringify({
          diagnosticMode: window.__keycapProbe?.diagnosticMode || 'real',
          overlayChildren: document.getElementById('overlay')?.children.length || 0,
          keyChildren: document.querySelectorAll('#overlay > .key').length,
          syntheticElements: document.querySelectorAll('.__keycap-probe-synthetic').length,
          profile: window.__keycapProbe?.profile || {}
        })
        """);

    SurfaceSize lastPaintSize;
    List<double> paintCopy;
    List<double> latencyCopy;
    List<RectSnapshot> rectCopy;
    int cpuPaintFramesCopy;
    int acceleratedPaintFramesCopy;
    lock (paintLock)
    {
        paintCopy = [.. paintTimes];
        latencyCopy = [.. keyLatencies];
        rectCopy = [.. dirtyRects];
        lastPaintSize = paintSizes.LastOrDefault() ?? new SurfaceSize(0, 0);
        cpuPaintFramesCopy = cpuPaintFrames;
        acceleratedPaintFramesCopy = acceleratedPaintFrames;
    }

    var rafTimes = JsonSerializer.Deserialize<List<double>>(rafJson, jsonOptions) ?? [];
    var viewport = JsonSerializer.Deserialize<ViewportInfo>(viewportJson, jsonOptions) ?? new ViewportInfo();
    var pageStats = JsonSerializer.Deserialize<PageStats>(pageStatsJson, jsonOptions) ?? new PageStats();
    var report = new ProbeReport(
        Target: new TargetInfo(
            options.Width,
            options.Height,
            options.Fps,
            options.FrameBudgetMs,
            options.DurationMs,
            options.KeyIntervalMs,
            options.Fade,
            options.Transport,
            options.BeginFrame,
            options.ValidateD3D11,
            options.DiagnosticMode,
            overlayUrl,
            ownedServer is null ? "existing-or-provided" : "started"),
        ActualSurface: new ActualSurface(
            viewport,
            lastPaintSize,
            lastPaintSize.Width == options.Width && lastPaintSize.Height == options.Height),
        KeysSent: keyCount,
        Paint: SummarizeDeltas(paintCopy, options.FrameBudgetMs),
        PaintFrameKinds: new PaintFrameKinds(cpuPaintFramesCopy, acceleratedPaintFramesCopy),
        Raf: SummarizeDeltas(rafTimes, options.FrameBudgetMs),
        KeyLatencyToPaint: SummarizeValues(latencyCopy),
        D3D11Validation: d3d11Validator?.Snapshot(),
        PageStats: pageStats,
        PendingKeysWithoutPaint: pendingKeys.Count,
        FirstDirtyRects: rectCopy,
        Artifacts: new ArtifactInfo(Path.Combine(options.OutputDir, "report.json")));

    var reportJson = JsonSerializer.Serialize(report, jsonOptions);
    await File.WriteAllTextAsync(Path.Combine(options.OutputDir, "report.json"), reportJson + Environment.NewLine);
    Console.WriteLine(reportJson);
}
finally
{
    try
    {
        Cef.Shutdown();
    }
    catch
    {
        // Best-effort cleanup for a diagnostic spike.
    }

    if (ownedServer is not null)
    {
        try
        {
            if (!ownedServer.HasExited) ownedServer.Kill(entireProcessTree: true);
        }
        catch
        {
            // Best-effort cleanup for a diagnostic spike.
        }
    }
}

static async Task<bool> IsReachableAsync(string url)
{
    using var client = new HttpClient { Timeout = TimeSpan.FromMilliseconds(800) };
    try
    {
        using var response = await client.GetAsync(url);
        return response.IsSuccessStatusCode;
    }
    catch
    {
        return false;
    }
}

static Process StartKeyCapServer(string repoRoot)
{
    var startInfo = new ProcessStartInfo
    {
        FileName = "node",
        Arguments = "server/index.js",
        WorkingDirectory = repoRoot,
        UseShellExecute = false,
        RedirectStandardOutput = true,
        RedirectStandardError = true,
        CreateNoWindow = true,
    };
    var process = Process.Start(startInfo) ?? throw new InvalidOperationException("failed to start node server");
    process.OutputDataReceived += (_, e) => { if (!string.IsNullOrWhiteSpace(e.Data)) Console.Error.WriteLine($"[server] {e.Data}"); };
    process.ErrorDataReceived += (_, e) => { if (!string.IsNullOrWhiteSpace(e.Data)) Console.Error.WriteLine($"[server] {e.Data}"); };
    process.BeginOutputReadLine();
    process.BeginErrorReadLine();
    return process;
}

static async Task WaitForServerAsync(string url, TimeSpan timeout)
{
    var started = Stopwatch.StartNew();
    while (started.Elapsed < timeout)
    {
        if (await IsReachableAsync(url)) return;
        await Task.Delay(150);
    }
    throw new TimeoutException($"server did not become reachable: {url}");
}

static Task WaitForInitialLoadAsync(ChromiumWebBrowser browser, TimeSpan timeout)
{
    var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    EventHandler<LoadingStateChangedEventArgs>? handler = null;
    handler = (_, eventArgs) =>
    {
        if (!eventArgs.IsLoading)
        {
            browser.LoadingStateChanged -= handler;
            completion.TrySetResult();
        }
    };
    browser.LoadingStateChanged += handler;
    return completion.Task.WaitAsync(timeout);
}

static async Task WaitForJavaScriptConditionAsync(ChromiumWebBrowser browser, string condition, TimeSpan timeout)
{
    var started = Stopwatch.StartNew();
    while (started.Elapsed < timeout)
    {
        var response = await browser.EvaluateScriptAsync($"Boolean({condition})");
        if (response.Success && response.Result is bool value && value) return;
        await Task.Delay(50);
    }
    throw new TimeoutException($"condition was not met: {condition}");
}

static async Task EvaluateAsync(ChromiumWebBrowser browser, string script)
{
    var response = await browser.EvaluateScriptAsync(script);
    if (!response.Success)
    {
        throw new InvalidOperationException(response.Message ?? $"script failed: {script}");
    }
}

static async Task<string> EvaluateStringAsync(ChromiumWebBrowser browser, string script)
{
    var response = await browser.EvaluateScriptAsync(script);
    if (!response.Success)
    {
        throw new InvalidOperationException(response.Message ?? $"script failed: {script}");
    }
    return Convert.ToString(response.Result, CultureInfo.InvariantCulture) ?? "";
}

static Task InstallDiagnosticModeAsync(ChromiumWebBrowser browser, string mode)
{
    var modeJson = JsonSerializer.Serialize(mode);
    return EvaluateAsync(browser, $$"""
        (() => {
          const mode = {{modeJson}};
          window.__keycapProbe = window.__keycapProbe || {};
          window.__keycapProbe.diagnosticMode = mode;

          document.body.classList.remove(
            '__keycap-probe-static',
            '__keycap-probe-empty',
            '__keycap-probe-transform',
            '__keycap-probe-opacity',
            '__keycap-probe-filter',
            '__keycap-probe-real-no-captions',
            '__keycap-probe-real-no-metrics',
            '__keycap-probe-real-no-expire',
            '__keycap-probe-simple-keys',
            '__keycap-probe-pooled-keys'
          );
          document.body.classList.add(`__keycap-probe-${mode}`);

          const ensureMetric = (name) => {
            const profile = window.__keycapProbe.profile ||= {};
            return profile[name] ||= { calls: 0, totalMs: 0, maxMs: 0 };
          };
          const measure = (name, callback) => {
            const started = performance.now();
            try {
              return callback();
            } finally {
              const elapsed = performance.now() - started;
              const metric = ensureMetric(name);
              metric.calls += 1;
              metric.totalMs += elapsed;
              metric.maxMs = Math.max(metric.maxMs, elapsed);
            }
          };

          if (!window.__keycapProbe.originalAddKey && typeof window.addKey === 'function') {
            window.__keycapProbe.originalAddKey = window.addKey;
          }
          if (!window.__keycapProbe.originalSyncThemeMetrics && window.ThemeRuntime?.syncThemeMetrics) {
            window.__keycapProbe.originalSyncThemeMetrics = window.ThemeRuntime.syncThemeMetrics.bind(window.ThemeRuntime);
          }
          if (!window.__keycapProbe.originalBuildPackCardElement && window.ThemeRuntime?.buildPackCardElement) {
            window.__keycapProbe.originalBuildPackCardElement = window.ThemeRuntime.buildPackCardElement.bind(window.ThemeRuntime);
          }

          if (window.ThemeRuntime?.syncThemeMetrics && window.__keycapProbe.originalSyncThemeMetrics) {
            window.ThemeRuntime.syncThemeMetrics = (...args) => measure('syncThemeMetrics', () => window.__keycapProbe.originalSyncThemeMetrics(...args));
          }
          if (window.ThemeRuntime?.buildPackCardElement && window.__keycapProbe.originalBuildPackCardElement) {
            window.ThemeRuntime.buildPackCardElement = (...args) => measure('buildPackCardElement', () => window.__keycapProbe.originalBuildPackCardElement(...args));
          }

          let style = document.getElementById('__keycap-probe-diagnostic-css');
          if (!style) {
            style = document.createElement('style');
            style.id = '__keycap-probe-diagnostic-css';
            document.head.appendChild(style);
          }
          style.textContent = `
            body.__keycap-probe-static .key,
            body.__keycap-probe-static .key.fading,
            body.__keycap-probe-empty .key,
            body.__keycap-probe-empty .key.fading {
              animation: none !important;
              transition: none !important;
              transform: none !important;
              filter: none !important;
              clip-path: none !important;
            }
            .__keycap-probe-synthetic {
              will-change: transform, opacity, filter;
              animation-duration: 900ms !important;
              animation-iteration-count: infinite !important;
              animation-direction: alternate !important;
              animation-timing-function: linear !important;
            }
            body.__keycap-probe-transform .__keycap-probe-synthetic {
              animation-name: keycapProbeTransform !important;
            }
            body.__keycap-probe-opacity .__keycap-probe-synthetic {
              animation-name: keycapProbeOpacity !important;
            }
            body.__keycap-probe-filter .__keycap-probe-synthetic {
              animation-name: keycapProbeFilter !important;
            }
            @keyframes keycapProbeTransform {
              from { transform: translate3d(-28px, 0, 0); }
              to { transform: translate3d(28px, 0, 0); }
            }
            @keyframes keycapProbeOpacity {
              from { opacity: 0.25; }
              to { opacity: 1; }
            }
            @keyframes keycapProbeFilter {
              from { filter: blur(0) brightness(1); }
              to { filter: blur(8px) brightness(1.5); }
            }
          `;

          const overlay = document.getElementById('overlay');
          if (!overlay) return false;

          if (mode === 'empty') {
            overlay.querySelectorAll(':scope > .key').forEach((node) => node.remove());
            return true;
          }

          if (mode === 'real-no-captions' && typeof window.applyConfig === 'function') {
            window.applyConfig({ showCaptions: false });
          }

          if (mode === 'real-no-metrics' && window.ThemeRuntime?.syncThemeMetrics) {
            window.ThemeRuntime.syncThemeMetrics = () => {
              const metric = ensureMetric('syncThemeMetricsNoop');
              metric.calls += 1;
            };
          }

          if (mode === 'real-no-expire' && typeof window.applyConfig === 'function') {
            window.applyConfig({ lifetime: 60000, maxKeys: 64 });
          }

          if (mode === 'simple-keys') {
            window.addKey = (label, description) => measure('addKey', () => {
              const keys = Array.from(overlay.querySelectorAll(':scope > .key'));
              while (keys.length >= 4) keys.shift()?.remove();
              const wrap = document.createElement('div');
              wrap.className = description ? 'key annotated' : 'key';
              const keycap = document.createElement('div');
              keycap.className = 'keycap';
              keycap.textContent = label;
              if (description) {
                const caption = document.createElement('div');
                caption.className = 'caption';
                caption.textContent = description;
                wrap.appendChild(caption);
              }
              wrap.appendChild(keycap);
              overlay.appendChild(wrap);
              setTimeout(() => {
                wrap.classList.add('fading');
                setTimeout(() => wrap.remove(), 500);
              }, 2200);
            });
            return true;
          }

          if (mode === 'pooled-keys') {
            overlay.querySelectorAll(':scope > .key').forEach((node) => node.remove());
            const slots = [];
            for (let index = 0; index < 4; index += 1) {
              const wrap = document.createElement('div');
              wrap.className = 'key annotated __keycap-probe-pooled-slot';
              wrap.style.display = 'none';
              const caption = document.createElement('div');
              caption.className = 'caption';
              const keycap = document.createElement('div');
              keycap.className = 'keycap';
              wrap.appendChild(caption);
              wrap.appendChild(keycap);
              overlay.appendChild(wrap);
              slots.push({ wrap, caption, keycap, timers: [] });
            }
            let nextSlot = 0;
            window.addKey = (label, description) => measure('addKey', () => {
              const slot = slots[nextSlot % slots.length];
              nextSlot += 1;
              slot.timers.forEach((timer) => clearTimeout(timer));
              slot.timers = [];
              slot.keycap.textContent = label;
              slot.caption.textContent = description || '';
              slot.caption.style.display = description ? '' : 'none';
              slot.wrap.style.display = '';
              slot.wrap.className = description
                ? 'key annotated __keycap-probe-pooled-slot'
                : 'key __keycap-probe-pooled-slot';
              void slot.wrap.offsetWidth;
              slot.timers.push(setTimeout(() => {
                slot.wrap.classList.add('fading');
                slot.timers.push(setTimeout(() => {
                  slot.wrap.style.display = 'none';
                  slot.wrap.classList.remove('fading');
                }, 500));
              }, 2200));
            });
            return true;
          }

          if (window.__keycapProbe.originalAddKey && (mode.startsWith('real') || mode === 'static')) {
            window.addKey = (...args) => measure('addKey', () => window.__keycapProbe.originalAddKey(...args));
          }

          if (mode === 'transform' || mode === 'opacity' || mode === 'filter') {
            overlay.querySelectorAll(':scope > .key').forEach((node) => node.remove());
            const wrap = document.createElement('div');
            wrap.className = 'key annotated __keycap-probe-synthetic';
            const caption = document.createElement('div');
            caption.className = 'caption';
            caption.textContent = mode.toUpperCase();
            const keycap = document.createElement('div');
            keycap.className = 'keycap';
            keycap.textContent = 'PROBE';
            wrap.appendChild(caption);
            wrap.appendChild(keycap);
            overlay.appendChild(wrap);
            if (window.ThemeRuntime?.syncThemeMetrics) {
              window.ThemeRuntime.syncThemeMetrics(
                window.CFG?.resolvedTheme || window.ThemeRuntime.DEFAULT_THEME,
                { keycap: '.keycap', caption: '.caption' },
                wrap
              );
            }
          }

          return true;
        })()
        """);
}

static DeltaSummary SummarizeDeltas(IReadOnlyList<double> times, double budgetMs)
{
    var deltas = new List<double>();
    for (var i = 1; i < times.Count; i++)
    {
        deltas.Add(times[i] - times[i - 1]);
    }
    var avg = deltas.Count == 0 ? 0 : deltas.Average();
    return new DeltaSummary(
        Frames: times.Count,
        Deltas: deltas.Count,
        AvgMs: avg,
        P95Ms: Percentile(deltas, 95),
        MaxMs: deltas.Count == 0 ? 0 : deltas.Max(),
        GapsOverBudget: deltas.Count(value => value > budgetMs * 1.5));
}

static ValueSummary SummarizeValues(IReadOnlyList<double> values)
{
    return new ValueSummary(
        Samples: values.Count,
        AvgMs: values.Count == 0 ? 0 : values.Average(),
        P95Ms: Percentile(values, 95),
        MaxMs: values.Count == 0 ? 0 : values.Max());
}

static double Percentile(IReadOnlyList<double> values, int percentile)
{
    if (values.Count == 0) return 0;
    var sorted = values.Order().ToArray();
    var index = Math.Clamp((int)Math.Ceiling(percentile / 100.0 * sorted.Length) - 1, 0, sorted.Length - 1);
    return sorted[index];
}

sealed record Options(
    int Width,
    int Height,
    int Fps,
    int DurationMs,
    int KeyIntervalMs,
    string? Fade,
    string Transport,
    string BeginFrame,
    string OverlayUrl,
    string OutputDir,
    string RepoRoot,
    bool ValidateD3D11,
    string DiagnosticMode,
    double? AnimationSpeed,
    int? Lifetime,
    int? MaxKeys)
{
    public double FrameBudgetMs => 1000.0 / Fps;
    public bool UseSharedTexture => string.Equals(Transport, "shared-texture", StringComparison.OrdinalIgnoreCase);
    public bool UseExternalBeginFrame => string.Equals(BeginFrame, "external", StringComparison.OrdinalIgnoreCase);
    public bool ShouldInjectKeys => DiagnosticMode is "real" or "static" or "real-no-captions" or "real-no-metrics" or "real-no-expire" or "simple-keys" or "pooled-keys";

    public Dictionary<string, object> GetConfigOverride()
    {
        var config = new Dictionary<string, object>();
        if (!string.IsNullOrWhiteSpace(Fade)) config["fade"] = Fade;
        if (AnimationSpeed.HasValue) config["animationSpeed"] = AnimationSpeed.Value;
        if (Lifetime.HasValue) config["lifetime"] = Lifetime.Value;
        if (MaxKeys.HasValue) config["maxKeys"] = MaxKeys.Value;
        return config;
    }

    public static Options Parse(string[] args)
    {
        var parsed = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var raw in args)
        {
            if (string.IsNullOrWhiteSpace(raw) || raw == "--") continue;
            var text = raw.StartsWith("--", StringComparison.Ordinal) ? raw[2..] : raw;
            var index = text.IndexOf('=');
            if (index < 0)
            {
                parsed[text] = "true";
            }
            else
            {
                parsed[text[..index]] = text[(index + 1)..];
            }
        }

        var repoRoot = Path.GetFullPath(Get("repo-root", Directory.GetCurrentDirectory()));
        var width = Math.Max(320, GetInt("width", 1920));
        var height = Math.Max(180, GetInt("height", 1080));
        var fps = Math.Clamp(GetInt("fps", 60), 1, 60);
        var durationMs = Math.Max(1000, (int)Math.Round(GetDouble("duration", 6) * 1000));
        var keyIntervalMs = Math.Max(50, GetInt("key-interval", 350));
        var fade = GetOptional("fade");
        var transport = Get("transport", "cpu");
        var beginFrame = Get("begin-frame", GetBool("external-begin-frame", false) ? "external" : "internal");
        var animationSpeed = GetOptionalDouble("animation-speed");
        var lifetime = GetOptionalInt("lifetime");
        var maxKeys = GetOptionalInt("max-keys");
        var validateD3D11 = GetBool("validate-d3d11", false);
        var diagnosticMode = NormalizeDiagnosticMode(Get("diagnostic-mode", "real"));
        var overlayUrl = Get("overlay-url", "http://127.0.0.1:8765/");
        var timestamp = DateTime.UtcNow.ToString("yyyy-MM-ddTHH-mm-ss-fffZ", CultureInfo.InvariantCulture);
        var outputDir = Path.GetFullPath(Get(
            "output",
            Path.Combine(repoRoot, "native", "recorder", "target", "cef-browser-source-feasibility", timestamp)));

        return new Options(
            width,
            height,
            fps,
            durationMs,
            keyIntervalMs,
            fade,
            transport,
            beginFrame,
            overlayUrl,
            outputDir,
            repoRoot,
            validateD3D11,
            diagnosticMode,
            animationSpeed,
            lifetime,
            maxKeys);

        string Get(string name, string fallback) => parsed.TryGetValue(name, out var value) ? value : fallback;

        string? GetOptional(string name) => parsed.TryGetValue(name, out var value) ? value : null;

        bool GetBool(string name, bool fallback) =>
            parsed.TryGetValue(name, out var value)
                ? value is "true" or "1" or "yes"
                : fallback;

        int GetInt(string name, int fallback) =>
            parsed.TryGetValue(name, out var value) && int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var result)
                ? result
                : fallback;

        int? GetOptionalInt(string name) =>
            parsed.TryGetValue(name, out var value) && int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var result)
                ? result
                : null;

        double GetDouble(string name, double fallback) =>
            parsed.TryGetValue(name, out var value) && double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out var result)
                ? result
                : fallback;

        double? GetOptionalDouble(string name) =>
            parsed.TryGetValue(name, out var value) && double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out var result)
                ? result
                : null;

        static string NormalizeDiagnosticMode(string value)
        {
            var mode = value.Trim().ToLowerInvariant();
            if (mode is "real" or "static" or "empty" or "transform" or "opacity" or "filter" or "real-no-captions" or "real-no-metrics" or "real-no-expire" or "simple-keys" or "pooled-keys")
            {
                return mode;
            }
            throw new ArgumentException($"unknown --diagnostic-mode={value}. Expected real, static, empty, transform, opacity, filter, real-no-captions, real-no-metrics, real-no-expire, simple-keys, or pooled-keys.");
        }
    }
}

sealed record KeyMarker(double SentAtMs);
sealed record SurfaceSize(int Width, int Height);
sealed record RectSnapshot(int X, int Y, int Width, int Height);
sealed record ViewportInfo(int InnerWidth = 0, int InnerHeight = 0, int OuterWidth = 0, int OuterHeight = 0, double DevicePixelRatio = 0);
sealed record PageStats(string DiagnosticMode = "real", int OverlayChildren = 0, int KeyChildren = 0, int SyntheticElements = 0, Dictionary<string, ProfileMetric>? Profile = null);
sealed record ProfileMetric(int Calls = 0, double TotalMs = 0, double MaxMs = 0);
sealed class ProbeRenderHandler(
    ChromiumWebBrowser browser,
    int targetWidth,
    int targetHeight,
    Func<double> nowMs,
    Action<double, int, int, RectSnapshot, bool> onPaint,
    D3D11SharedTextureValidator? d3d11Validator) : DefaultRenderHandler(browser)
{
    public override void OnPaint(PaintElementType type, CefSharp.Structs.Rect dirtyRect, IntPtr buffer, int width, int height)
    {
        if (type != PaintElementType.View) return;
        onPaint(
            nowMs(),
            width,
            height,
            new RectSnapshot(dirtyRect.X, dirtyRect.Y, dirtyRect.Width, dirtyRect.Height),
            false);
    }

    public override void OnAcceleratedPaint(PaintElementType type, CefSharp.Structs.Rect dirtyRect, AcceleratedPaintInfo acceleratedPaintInfo)
    {
        if (type != PaintElementType.View) return;
        var now = nowMs();
        d3d11Validator?.Validate(acceleratedPaintInfo);
        onPaint(
            now,
            targetWidth,
            targetHeight,
            new RectSnapshot(dirtyRect.X, dirtyRect.Y, dirtyRect.Width, dirtyRect.Height),
            true);
    }
}

sealed class D3D11SharedTextureValidator : IDisposable
{
    private readonly object gate = new();
    private readonly ID3D11Device device;
    private readonly ID3D11Device1? device1;
    private readonly ID3D11DeviceContext context;
    private readonly FeatureLevel featureLevel;
    private readonly HashSet<IntPtr> handles = [];
    private readonly List<double> validationTimes = [];
    private ID3D11Texture2D? copyTarget;
    private Texture2DDescription? copyTargetDescription;
    private int frames;
    private int opened;
    private int copied;
    private int failed;
    private int copyTargetRecreates;
    private string? firstError;
    private D3D11TextureSnapshot? lastTexture;

    private D3D11SharedTextureValidator(ID3D11Device device, ID3D11Device1? device1, ID3D11DeviceContext context, FeatureLevel featureLevel)
    {
        this.device = device;
        this.device1 = device1;
        this.context = context;
        this.featureLevel = featureLevel;
    }

    public static D3D11SharedTextureValidator Create()
    {
        var featureLevels = new[]
        {
            FeatureLevel.Level_11_1,
            FeatureLevel.Level_11_0,
            FeatureLevel.Level_10_1,
            FeatureLevel.Level_10_0,
        };

        var device = D3D11.D3D11CreateDevice(
            DriverType.Hardware,
            DeviceCreationFlags.BgraSupport,
            featureLevels);
        var device1 = device.QueryInterfaceOrNull<ID3D11Device1>();
        var context = device.ImmediateContext;
        var featureLevel = device.FeatureLevel;

        return new D3D11SharedTextureValidator(device, device1, context, featureLevel);
    }

    public void Validate(AcceleratedPaintInfo paintInfo)
    {
        var elapsed = Stopwatch.StartNew();
        lock (gate)
        {
            frames++;
            try
            {
                var handle = paintInfo.SharedTextureHandle;
                if (handle == IntPtr.Zero)
                {
                    throw new InvalidOperationException("CEF returned a null shared texture handle");
                }

                handles.Add(handle);

                using var sharedTexture = OpenSharedTexture(handle);
                var description = sharedTexture.Description;
                opened++;
                lastTexture = new D3D11TextureSnapshot(
                    (int)description.Width,
                    (int)description.Height,
                    description.Format.ToString(),
                    paintInfo.Format.ToString());

                EnsureCopyTarget(description);
                context.CopyResource(copyTarget!, sharedTexture);
                context.Flush();
                copied++;
            }
            catch (Exception ex)
            {
                failed++;
                firstError ??= $"{ex.GetType().Name}: {ex.Message}";
            }
            finally
            {
                validationTimes.Add(elapsed.Elapsed.TotalMilliseconds);
            }
        }
    }

    public D3D11ValidationSummary Snapshot()
    {
        lock (gate)
        {
            return new D3D11ValidationSummary(
                true,
                featureLevel.ToString(),
                frames,
                opened,
                copied,
                failed,
                handles.Count,
                copyTargetRecreates,
                firstError,
                lastTexture,
                Summarize(validationTimes));
        }
    }

    public void Dispose()
    {
        copyTarget?.Dispose();
        device1?.Dispose();
        context.Dispose();
        device.Dispose();
    }

    private ID3D11Texture2D OpenSharedTexture(IntPtr handle)
    {
        if (device1 is not null)
        {
            return device1.OpenSharedResource1<ID3D11Texture2D>(handle);
        }

        return device.OpenSharedResource<ID3D11Texture2D>(handle);
    }

    private void EnsureCopyTarget(Texture2DDescription sourceDescription)
    {
        if (copyTarget is not null &&
            copyTargetDescription is { } current &&
            current.Width == sourceDescription.Width &&
            current.Height == sourceDescription.Height &&
            current.Format == sourceDescription.Format &&
            current.SampleDescription.Count == sourceDescription.SampleDescription.Count &&
            current.SampleDescription.Quality == sourceDescription.SampleDescription.Quality)
        {
            return;
        }

        copyTarget?.Dispose();
        var copyDescription = sourceDescription;
        copyDescription.Usage = ResourceUsage.Default;
        copyDescription.BindFlags = BindFlags.ShaderResource;
        copyDescription.CPUAccessFlags = CpuAccessFlags.None;
        copyDescription.MiscFlags = ResourceOptionFlags.None;
        copyTarget = device.CreateTexture2D(copyDescription);
        copyTargetDescription = copyDescription;
        copyTargetRecreates++;
    }

    private static ValueSummary Summarize(IReadOnlyList<double> values)
    {
        return new ValueSummary(
            values.Count,
            values.Count == 0 ? 0 : values.Average(),
            Percentile(values, 95),
            values.Count == 0 ? 0 : values.Max());
    }

    private static double Percentile(IReadOnlyList<double> values, int percentile)
    {
        if (values.Count == 0) return 0;
        var sorted = values.Order().ToArray();
        var index = Math.Clamp((int)Math.Ceiling(percentile / 100.0 * sorted.Length) - 1, 0, sorted.Length - 1);
        return sorted[index];
    }
}

sealed record TargetInfo(int Width, int Height, int Fps, double FrameBudgetMs, int DurationMs, int KeyIntervalMs, string? Fade, string Transport, string BeginFrame, bool ValidateD3D11, string DiagnosticMode, string OverlayUrl, string ServerMode);
sealed record ActualSurface(ViewportInfo Viewport, SurfaceSize LastPaint, bool MatchesTarget);
sealed record DeltaSummary(int Frames, int Deltas, double AvgMs, double P95Ms, double MaxMs, int GapsOverBudget);
sealed record PaintFrameKinds(int Cpu, int Accelerated);
sealed record ValueSummary(int Samples, double AvgMs, double P95Ms, double MaxMs);
sealed record D3D11TextureSnapshot(int Width, int Height, string DxgiFormat, string CefFormat);
sealed record D3D11ValidationSummary(bool Enabled, string FeatureLevel, int Frames, int Opened, int Copied, int Failed, int UniqueHandles, int CopyTargetRecreates, string? FirstError, D3D11TextureSnapshot? LastTexture, ValueSummary ValidateAndCopyMs);
sealed record ArtifactInfo(string Report);
sealed record ProbeReport(
    TargetInfo Target,
    ActualSurface ActualSurface,
    int KeysSent,
    DeltaSummary Paint,
    PaintFrameKinds PaintFrameKinds,
    DeltaSummary Raf,
    ValueSummary KeyLatencyToPaint,
    [property: JsonPropertyName("d3d11Validation")]
    D3D11ValidationSummary? D3D11Validation,
    PageStats PageStats,
    int PendingKeysWithoutPaint,
    IReadOnlyList<RectSnapshot> FirstDirtyRects,
    ArtifactInfo Artifacts);
