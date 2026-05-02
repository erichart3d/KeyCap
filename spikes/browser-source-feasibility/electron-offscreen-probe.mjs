#!/usr/bin/env node

import { app, BrowserWindow } from 'electron';
import { once } from 'node:events';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const serverModule = require('../../server/index.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');

app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

function parseArgs(argv) {
  const parsed = {};
  for (const raw of argv) {
    if (!raw || raw === '--') continue;
    const item = raw.startsWith('--') ? raw.slice(2) : raw;
    const eq = item.indexOf('=');
    if (eq < 0) {
      parsed[item] = true;
    } else {
      parsed[item.slice(0, eq)] = item.slice(eq + 1);
    }
  }
  return parsed;
}

const args = parseArgs(process.argv.slice(2));
const width = Math.max(320, Number(args.width) || 1920);
const height = Math.max(180, Number(args.height) || 1080);
const fps = Math.max(1, Math.min(120, Number(args.fps) || 60));
const durationMs = Math.max(1000, Math.round((Number(args.duration) || 6) * 1000));
const keyIntervalMs = Math.max(50, Number(args['key-interval']) || 350);
const frameBudgetMs = 1000 / fps;
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const outputDir = resolve(
  String(args.output || join(repoRoot, 'native', 'recorder', 'target', 'browser-source-feasibility', timestamp)),
);

const keySequence = [
  ['CTRL + S', 'Save'],
  ['SHIFT', 'Dash'],
  ['A', 'Move Left'],
  ['D', 'Move Right'],
  ['SPACE', 'Jump'],
  ['CTRL + Z', 'Undo'],
  ['ALT + TAB', 'Switch'],
  ['ESC', 'Cancel'],
];

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function percentile(values, pct) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  return sorted[index];
}

function summarizeDeltas(times, budgetMs) {
  const deltas = [];
  for (let i = 1; i < times.length; i += 1) {
    deltas.push(times[i] - times[i - 1]);
  }
  const sum = deltas.reduce((total, value) => total + value, 0);
  return {
    frames: times.length,
    deltas: deltas.length,
    avgMs: deltas.length ? sum / deltas.length : 0,
    p95Ms: percentile(deltas, 95),
    maxMs: deltas.length ? Math.max(...deltas) : 0,
    gapsOverBudget: deltas.filter((value) => value > budgetMs * 1.5).length,
  };
}

function summarizeValues(values) {
  const sum = values.reduce((total, value) => total + value, 0);
  return {
    samples: values.length,
    avgMs: values.length ? sum / values.length : 0,
    p95Ms: percentile(values, 95),
    maxMs: values.length ? Math.max(...values) : 0,
  };
}

async function resolveOverlayUrl() {
  if (args['overlay-url']) {
    return { url: String(args['overlay-url']), ownsServer: false, serverMode: 'provided' };
  }

  try {
    await serverModule.start();
    return { url: serverModule.getOverlayUrl(), ownsServer: true, serverMode: 'started' };
  } catch (err) {
    if (err?.code === 'EADDRINUSE') {
      return { url: serverModule.getOverlayUrl(), ownsServer: false, serverMode: 'existing-port' };
    }
    throw err;
  }
}

async function injectProbe(win) {
  await win.webContents.executeJavaScript(`
    (() => {
      window.__keycapProbe = { rafTimes: [], startedAt: performance.now() };
      const tick = (time) => {
        window.__keycapProbe.rafTimes.push(time);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return true;
    })();
  `, true);

  const config = {};
  if (args.fade) config.fade = String(args.fade);
  if (args['animation-speed']) config.animationSpeed = Number(args['animation-speed']);
  if (args.lifetime) config.lifetime = Number(args.lifetime);
  if (args['max-keys']) config.maxKeys = Number(args['max-keys']);
  if (Object.keys(config).length) {
    await win.webContents.executeJavaScript(`window.applyConfig(${JSON.stringify(config)})`, true);
  }
}

async function sendKey(win, label, description) {
  await win.webContents.executeJavaScript(
    `window.addKey(${JSON.stringify(label)}, ${JSON.stringify(description)})`,
    true,
  );
}

async function main() {
  mkdirSync(outputDir, { recursive: true });
  await app.whenReady();

  const overlay = await resolveOverlayUrl();
  const win = new BrowserWindow({
    width,
    height,
    useContentSize: true,
    enableLargerThanScreen: true,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      offscreen: true,
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.webContents.setFrameRate(fps);
  win.setContentSize(width, height);

  const paintTimes = [];
  const paintDirtyRects = [];
  const keyLatencies = [];
  const pendingKeys = [];
  let lastPaintAt = 0;

  win.webContents.on('paint', (_event, dirty) => {
    const now = performance.now();
    lastPaintAt = now;
    paintTimes.push(now);
    paintDirtyRects.push({
      x: dirty.x,
      y: dirty.y,
      width: dirty.width,
      height: dirty.height,
    });
    while (pendingKeys.length) {
      const key = pendingKeys.shift();
      keyLatencies.push(now - key.sentAt);
    }
  });

  win.loadURL(overlay.url);
  await once(win.webContents, 'did-finish-load');
  await injectProbe(win);

  const startAt = performance.now();
  const deadline = startAt + durationMs;
  let nextKeyAt = startAt + 250;
  let keyCount = 0;

  while (performance.now() < deadline) {
    const now = performance.now();
    if (now >= nextKeyAt) {
      const [label, description] = keySequence[keyCount % keySequence.length];
      pendingKeys.push({ label, sentAt: now });
      await sendKey(win, label, description);
      keyCount += 1;
      nextKeyAt += keyIntervalMs;
    }
    await sleep(5);
  }

  await sleep(Math.min(500, frameBudgetMs * 4));
  const rafTimes = await win.webContents.executeJavaScript('window.__keycapProbe?.rafTimes || []', true);
  const viewport = await win.webContents.executeJavaScript(`({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
    devicePixelRatio: window.devicePixelRatio,
  })`, true);
  const snapshot = await win.webContents.capturePage({ x: 0, y: 0, width, height });
  const snapshotSize = snapshot.getSize();

  const report = {
    target: {
      width,
      height,
      fps,
      frameBudgetMs,
      durationMs,
      keyIntervalMs,
      overlayUrl: overlay.url,
      serverMode: overlay.serverMode,
    },
    actualSurface: {
      viewport,
      snapshot: snapshotSize,
      matchesTarget: snapshotSize.width === width && snapshotSize.height === height,
    },
    keysSent: keyCount,
    paint: summarizeDeltas(paintTimes, frameBudgetMs),
    raf: summarizeDeltas(rafTimes, frameBudgetMs),
    keyLatencyToPaint: summarizeValues(keyLatencies),
    pendingKeysWithoutPaint: pendingKeys.length,
    lastPaintAgeMs: lastPaintAt ? performance.now() - lastPaintAt : null,
    firstDirtyRects: paintDirtyRects.slice(0, 10),
    artifacts: {
      report: join(outputDir, 'report.json'),
      snapshot: join(outputDir, 'snapshot.png'),
    },
  };

  writeFileSync(join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(join(outputDir, 'snapshot.png'), snapshot.toPNG());

  console.log(JSON.stringify(report, null, 2));

  win.destroy();
  if (overlay.ownsServer) {
    await serverModule.stop({ stopRuntime: true });
  }
  app.quit();

  if (!paintTimes.length) {
    process.exitCode = 1;
  }
}

main().catch(async (err) => {
  console.error('[browser-source-probe] FAIL', err);
  try {
    await serverModule.stop({ stopRuntime: true });
  } catch {}
  app.quit();
  process.exitCode = 1;
});

