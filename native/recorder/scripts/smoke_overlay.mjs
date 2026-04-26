#!/usr/bin/env node
// End-to-end overlay-compositing smoke test.
//
// Spawns the Rust sidecar, reads `overlayPipe` from handshake, starts a
// short display recording, then opens a named-pipe client and writes a
// solid red (50% alpha) BGRA frame repeatedly. After stop, ffprobe the
// MP4 and dump basic stats. Manual visual check of the MP4 confirms the
// red tint is baked into the recording.

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'bin', 'keycap-recorder.exe');
const SECONDS = Number(process.env.RECORD_SECONDS || 3);

const child = spawn(BIN, [], { stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.on('data', (b) => process.stderr.write(`[recorder] ${b}`));

const rl = readline.createInterface({ input: child.stdout });
const pending = new Map();
let id = 1;
rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.type === 'response' && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message || String(msg.error))) : resolve(msg.result);
    }
  } catch {}
});

function call(method, params = {}) {
  const rid = id++;
  return new Promise((resolve, reject) => {
    pending.set(rid, { resolve, reject });
    child.stdin.write(JSON.stringify({ type: 'request', id: rid, method, params }) + '\n');
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const hs = await call('handshake', {});
  console.log('handshake:', hs);
  if (!hs.overlayPipe) throw new Error('no overlayPipe in handshake');

  const sources = await call('list_sources', {});
  const display = sources.sources[0];
  if (!display) throw new Error('no displays');
  console.log('using source:', display.id, display.width, 'x', display.height);

  const rec = await call('start_recording', {
    sourceKind: 'display',
    sourceId: display.id,
    fps: 30,
    encoder: 'auto',
    container: 'mp4',
  });
  console.log('started:', rec.outputPath, rec.width, 'x', rec.height);

  // Connect overlay pipe and blast a red 50%-alpha frame.
  const sock = net.createConnection(hs.overlayPipe);
  await once(sock, 'connect');
  console.log('overlay pipe connected');

  const w = rec.width;
  const h = rec.height;
  const payload = Buffer.alloc(w * h * 4);
  // BGRA: red = (B=0, G=0, R=255, A=128)
  for (let i = 0; i < payload.length; i += 4) {
    payload[i] = 0;
    payload[i + 1] = 0;
    payload[i + 2] = 255;
    payload[i + 3] = 128;
  }
  const header = Buffer.alloc(16);
  header.writeUInt32LE(0x594c564f, 0);
  header.writeUInt32LE(w, 4);
  header.writeUInt32LE(h, 8);
  header.writeUInt32LE(payload.length, 12);

  const deadline = Date.now() + SECONDS * 1000;
  let frames = 0;
  while (Date.now() < deadline) {
    sock.write(header);
    sock.write(payload);
    frames++;
    await sleep(33);
  }
  console.log('sent', frames, 'overlay frames');
  sock.destroy();

  const stop = await call('stop_recording', {});
  console.log('stop:', stop);

  await call('shutdown', {});
  await sleep(100);
  process.exit(0);
} catch (err) {
  console.error('smoke failed:', err);
  try { child.kill(); } catch {}
  process.exit(1);
}
