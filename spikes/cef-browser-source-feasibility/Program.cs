using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using CefSharp;
using CefSharp.OffScreen;

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
        RecordPaint);
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
        if (now >= nextKeyAt)
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

    SurfaceSize lastPaintSize;
    List<double> paintCopy;
    List<double> latencyCopy;
    List<RectSnapshot> rectCopy;
    lock (paintLock)
    {
        paintCopy = [.. paintTimes];
        latencyCopy = [.. keyLatencies];
        rectCopy = [.. dirtyRects];
        lastPaintSize = paintSizes.LastOrDefault() ?? new SurfaceSize(0, 0);
    }

    var rafTimes = JsonSerializer.Deserialize<List<double>>(rafJson, jsonOptions) ?? [];
    var viewport = JsonSerializer.Deserialize<ViewportInfo>(viewportJson, jsonOptions) ?? new ViewportInfo();
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
            overlayUrl,
            ownedServer is null ? "existing-or-provided" : "started"),
        ActualSurface: new ActualSurface(
            viewport,
            lastPaintSize,
            lastPaintSize.Width == options.Width && lastPaintSize.Height == options.Height),
        KeysSent: keyCount,
        Paint: SummarizeDeltas(paintCopy, options.FrameBudgetMs),
        PaintFrameKinds: new PaintFrameKinds(cpuPaintFrames, acceleratedPaintFrames),
        Raf: SummarizeDeltas(rafTimes, options.FrameBudgetMs),
        KeyLatencyToPaint: SummarizeValues(latencyCopy),
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
    double? AnimationSpeed,
    int? Lifetime,
    int? MaxKeys)
{
    public double FrameBudgetMs => 1000.0 / Fps;
    public bool UseSharedTexture => string.Equals(Transport, "shared-texture", StringComparison.OrdinalIgnoreCase);
    public bool UseExternalBeginFrame => string.Equals(BeginFrame, "external", StringComparison.OrdinalIgnoreCase);

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
    }
}

sealed record KeyMarker(double SentAtMs);
sealed record SurfaceSize(int Width, int Height);
sealed record RectSnapshot(int X, int Y, int Width, int Height);
sealed record ViewportInfo(int InnerWidth = 0, int InnerHeight = 0, int OuterWidth = 0, int OuterHeight = 0, double DevicePixelRatio = 0);
sealed class ProbeRenderHandler(
    ChromiumWebBrowser browser,
    int targetWidth,
    int targetHeight,
    Func<double> nowMs,
    Action<double, int, int, RectSnapshot, bool> onPaint) : DefaultRenderHandler(browser)
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
        onPaint(
            nowMs(),
            targetWidth,
            targetHeight,
            new RectSnapshot(dirtyRect.X, dirtyRect.Y, dirtyRect.Width, dirtyRect.Height),
            true);
    }
}

sealed record TargetInfo(int Width, int Height, int Fps, double FrameBudgetMs, int DurationMs, int KeyIntervalMs, string? Fade, string Transport, string BeginFrame, string OverlayUrl, string ServerMode);
sealed record ActualSurface(ViewportInfo Viewport, SurfaceSize LastPaint, bool MatchesTarget);
sealed record DeltaSummary(int Frames, int Deltas, double AvgMs, double P95Ms, double MaxMs, int GapsOverBudget);
sealed record PaintFrameKinds(int Cpu, int Accelerated);
sealed record ValueSummary(int Samples, double AvgMs, double P95Ms, double MaxMs);
sealed record ArtifactInfo(string Report);
sealed record ProbeReport(
    TargetInfo Target,
    ActualSurface ActualSurface,
    int KeysSent,
    DeltaSummary Paint,
    PaintFrameKinds PaintFrameKinds,
    DeltaSummary Raf,
    ValueSummary KeyLatencyToPaint,
    int PendingKeysWithoutPaint,
    IReadOnlyList<RectSnapshot> FirstDirtyRects,
    ArtifactInfo Artifacts);
