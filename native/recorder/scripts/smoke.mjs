#!/usr/bin/env node
// Smoke test for the Rust sidecar. Spawns the binary, runs handshake +
// list_sources + a short start_recording + stop_recording, then ffprobes
// the output to confirm the file is playable.
//
// Usage: node scripts/smoke.mjs [--record-seconds=3] [--encoder=auto]

import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, existsSync, statSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);
const BIN = join(ROOT, 'bin', process.platform === 'win32' ? 'keycap-recorder.exe' : 'keycap-recorder');
const FFPROBE = join(ROOT, 'bin', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);
const RECORD_SECONDS = Number(args['record-seconds']) || 3;
const ENCODER = args.encoder || 'auto';

if (!existsSync(BIN)) {
  console.error(`[smoke] binary not found: ${BIN}`);
  process.exit(1);
}

const outDir = mkdtempSync(join(tmpdir(), 'keycap-smoke-'));
const outPath = join(outDir, 'smoke.mp4');

console.log(`[smoke] binary: ${BIN}`);
console.log(`[smoke] output: ${outPath}`);
console.log(`[smoke] encoder: ${ENCODER}, record seconds: ${RECORD_SECONDS}`);

const child = spawn(BIN, [], { stdio: ['pipe', 'pipe', 'inherit'] });

let nextId = 1;
const pending = new Map();
let lastStatus = null;
let buffered = '';

child.stdout.on('data', (chunk) => {
  buffered += String(chunk);
  let idx;
  while ((idx = buffered.indexOf('\n')) >= 0) {
    const line = buffered.slice(0, idx).trim();
    buffered = buffered.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { console.error('[smoke] bad json:', line); continue; }
    if (msg.type === 'response') {
      const pend = pending.get(msg.id);
      if (pend) {
        pending.delete(msg.id);
        if (msg.error) pend.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else pend.resolve(msg.result);
      }
    } else if (msg.type === 'event' && msg.event === 'status') {
      lastStatus = msg.payload;
    }
  }
});

function call(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const line = JSON.stringify({ type: 'request', id, method, params }) + '\n';
    child.stdin.write(line);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startMouseWiggle() {
  if (process.platform !== 'win32') return () => {};
  const ps = spawn('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    "Add-Type -AssemblyName System.Windows.Forms; while ($true) { $p = [System.Windows.Forms.Cursor]::Position; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(($p.X + 1), $p.Y); Start-Sleep -Milliseconds 33; [System.Windows.Forms.Cursor]::Position = $p; Start-Sleep -Milliseconds 33 }",
  ], { windowsHide: true, stdio: 'ignore' });
  return () => { try { ps.kill(); } catch {} };
}

async function main() {
  console.log('[smoke] handshake...');
  const hs = await call('handshake');
  console.log('[smoke] handshake:', hs);

  console.log('[smoke] list_sources...');
  const list = await call('list_sources');
  const displays = list.sources || [];
  console.log(`[smoke] ${displays.length} display(s):`);
  for (const d of displays) console.log(`  - ${d.name} ${d.width}x${d.height} id=${d.id} primary=${d.isPrimaryDisplay}`);
  if (!displays.length) throw new Error('no displays returned');

  const target = displays.find((d) => d.isPrimaryDisplay) || displays[0];

  console.log(`[smoke] start_recording on ${target.id}...`);
  const started = await call('start_recording', {
    sourceKind: 'display',
    sourceId: target.id,
    fps: 30,
    container: 'mp4',
    encoder: ENCODER,
    outputDir: outDir,
  });
  console.log('[smoke] started:', started);

  console.log(`[smoke] recording for ${RECORD_SECONDS}s (wiggling mouse to force WGC presents)...`);
  // WGC delivers frames on GPU-present events, so an idle desktop may emit
  // almost no frames. Wiggle the cursor to keep the compositor busy.
  const stopWiggle = startMouseWiggle();
  await sleep(RECORD_SECONDS * 1000);
  stopWiggle();

  console.log('[smoke] get_status...');
  const status = await call('get_status');
  console.log('[smoke] status:', status);

  console.log('[smoke] stop_recording...');
  const stopped = await call('stop_recording');
  console.log('[smoke] stopped:', stopped);

  console.log('[smoke] shutdown...');
  await call('shutdown');
  await once(child, 'exit');

  const finalPath = stopped.outputPath || started.outputPath;
  if (!finalPath || !existsSync(finalPath)) throw new Error(`output missing: ${finalPath}`);
  const size = statSync(finalPath).size;
  console.log(`[smoke] output ${finalPath} (${size} bytes)`);
  if (size < 1024) throw new Error('output too small');

  if (existsSync(FFPROBE)) {
    console.log('[smoke] ffprobe...');
    const probe = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_name,width,height,r_frame_rate,nb_frames', '-of', 'default=nw=1', finalPath], { encoding: 'utf8' });
    if (probe.status !== 0) throw new Error(`ffprobe failed: ${probe.stderr}`);
    console.log(probe.stdout.trim());
  } else {
    console.log('[smoke] ffprobe.exe not found — skipping validation');
  }

  console.log('[smoke] ok — cleaning up');
  try { unlinkSync(finalPath); } catch {}
  try { rmSync(outDir, { recursive: true, force: true }); } catch {}
}

main().catch((err) => {
  console.error('[smoke] FAIL', err);
  try { child.kill(); } catch {}
  process.exit(1);
});
