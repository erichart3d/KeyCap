#!/usr/bin/env node
// Compare two aligned video clips with VMAF / PSNR / SSIM.
//
// Typical flow: record the same scene with OBS and KeyCap back-to-back,
// manually trim both clips to the same start frame + duration, then:
//
//   node scripts/bench-vmaf.mjs --reference=obs.mp4 --test=keycap.mp4
//
// Alignment helper (ffmpeg re-encode to exact frame count):
//   ffmpeg -ss 00:00:01.5 -i input.mp4 -t 10 -c:v libx264 -crf 18 aligned.mp4
//
// The reference is treated as "ground truth". VMAF compares the test
// against the reference — 100 = perceptually identical. Anything ≥ 85
// is broadcast-grade; ≥ 93 is visually indistinguishable for most
// content.

import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);
const FFMPEG = join(ROOT, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);

const REFERENCE = args.reference;
const TEST = args.test;

if (!REFERENCE || !TEST) {
  console.error('Usage: node scripts/bench-vmaf.mjs --reference=<path> --test=<path>');
  process.exit(1);
}
for (const p of [REFERENCE, TEST, FFMPEG]) {
  if (!existsSync(p)) {
    console.error(`not found: ${p}`);
    process.exit(1);
  }
}

function probe(path) {
  // ffmpeg -i prints stream info on stderr, then exits with status 1
  // because no output file was given. That's fine — we just need the
  // banner. Parse width/height/fps/codec/duration/bitrate from it.
  const res = spawnSync(FFMPEG, ['-hide_banner', '-i', path], { encoding: 'utf8' });
  const text = (res.stderr || '') + (res.stdout || '');

  const durM = text.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
  const durationSec = durM
    ? Number(durM[1]) * 3600 + Number(durM[2]) * 60 + Number(durM[3])
    : 0;
  const formatBitrateM = text.match(/bitrate:\s*(\d+)\s*kb\/s/);
  const formatBitrateKbps = formatBitrateM ? Number(formatBitrateM[1]) : null;

  // Video stream line: "Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 3840x2160 [SAR 1:1 DAR 16:9], 20000 kb/s, 60 fps, 60 tbr, 15360 tbn"
  const vLine = text.split('\n').find((ln) => /Stream #.*Video:/.test(ln)) || '';
  const codecM = vLine.match(/Video:\s*(\w+)/);
  const sizeM = vLine.match(/(\d{2,5})x(\d{2,5})/);
  const fpsM = vLine.match(/([\d.]+)\s*fps/);
  const streamBitrateM = vLine.match(/(\d+)\s*kb\/s/);

  const fileSize = statSync(path).size;

  return {
    path,
    width: sizeM ? Number(sizeM[1]) : 0,
    height: sizeM ? Number(sizeM[2]) : 0,
    fps: fpsM ? Number(fpsM[1]) : 0,
    codec: codecM ? codecM[1] : 'unknown',
    streamBitrateKbps: streamBitrateM ? Number(streamBitrateM[1]) : null,
    formatBitrateKbps,
    durationSec,
    sizeMiB: fileSize / 1048576,
  };
}

function fmt(n, digits = 2) {
  return typeof n === 'number' && isFinite(n) ? n.toFixed(digits) : String(n);
}

console.log('=== probing ===');
const ref = probe(REFERENCE);
const test = probe(TEST);

for (const [label, info] of [['reference', ref], ['test     ', test]]) {
  console.log(
    `${label}  ${info.width}x${info.height} @ ${fmt(info.fps)}fps  ${info.codec}  ` +
    `dur=${fmt(info.durationSec)}s  ` +
    `bitrate=${info.streamBitrateKbps ?? info.formatBitrateKbps ?? '?'}kbps  ` +
    `size=${fmt(info.sizeMiB)}MiB`
  );
}

if (ref.width !== test.width || ref.height !== test.height) {
  console.log(`\n[warn] resolution mismatch (${ref.width}x${ref.height} vs ${test.width}x${test.height}) — test will be scaled to reference`);
}
if (Math.abs(ref.fps - test.fps) > 0.5) {
  console.log(`[warn] framerate mismatch (${fmt(ref.fps)} vs ${fmt(test.fps)}) — test will be resampled`);
}
if (Math.abs(ref.durationSec - test.durationSec) > 0.5) {
  console.log(`[warn] duration mismatch (${fmt(ref.durationSec)}s vs ${fmt(test.durationSec)}s) — only the overlapping region is scored`);
}

// libvmaf + psnr + ssim in a single pass. Scale test stream to match
// reference resolution; set test as first input (distorted) and reference
// as second (ground truth) — that's the order libvmaf expects.
console.log('\n=== running libvmaf ===');
const filter =
  `[0:v]scale=${ref.width}:${ref.height}:flags=bicubic,fps=${ref.fps},settb=AVTB[distorted];` +
  `[1:v]fps=${ref.fps},settb=AVTB[ref];` +
  `[distorted][ref]libvmaf=feature='name=psnr|name=float_ssim':log_path=-:log_fmt=json`;

const run = spawnSync(
  FFMPEG,
  [
    '-hide_banner',
    '-i', TEST,
    '-i', REFERENCE,
    '-lavfi', filter,
    '-f', 'null', '-',
  ],
  { encoding: 'utf8' }
);

if (run.status !== 0) {
  console.error(run.stderr);
  process.exit(1);
}

// libvmaf writes its JSON to stdout (log_path=-), mixed with progress lines
// that ffmpeg prints to stderr. Extract the trailing JSON object.
const stdout = run.stdout || '';
const jsonStart = stdout.indexOf('{');
let parsed = null;
if (jsonStart >= 0) {
  try {
    parsed = JSON.parse(stdout.slice(jsonStart));
  } catch {}
}

// Fallback: parse the `VMAF score: X` line ffmpeg prints on its own.
const stderr = run.stderr || '';
const vmafLine = stderr.match(/VMAF score:\s*([\d.]+)/);
const psnrLine = stderr.match(/PSNR[\s\S]*?average:\s*([\d.]+)/i);
const ssimLine = stderr.match(/SSIM[\s\S]*?All:\s*([\d.]+)/i);

const pooled = parsed?.pooled_metrics || {};
const vmaf = pooled.vmaf?.mean ?? (vmafLine ? Number(vmafLine[1]) : null);
const psnrY = pooled.psnr_y?.mean ?? pooled.psnr?.mean ?? (psnrLine ? Number(psnrLine[1]) : null);
const ssim = pooled.float_ssim?.mean ?? pooled.ssim?.mean ?? (ssimLine ? Number(ssimLine[1]) : null);

console.log('\n=== results ===');
console.log(`VMAF : ${fmt(vmaf)}   (higher is better, 100 = identical; 85+ broadcast, 93+ visually indistinguishable)`);
console.log(`PSNR : ${fmt(psnrY)} dB  (higher is better)`);
console.log(`SSIM : ${fmt(ssim, 4)}   (0..1, higher is better)`);

const refKbps = ref.streamBitrateKbps ?? ref.formatBitrateKbps ?? 0;
const testKbps = test.streamBitrateKbps ?? test.formatBitrateKbps ?? 0;
if (refKbps && testKbps) {
  const ratio = testKbps / refKbps;
  console.log(`\nBitrate: test=${testKbps}kbps  reference=${refKbps}kbps  (test is ${fmt(ratio, 2)}× reference)`);
}

if (vmaf == null) {
  console.log('\n[warn] could not parse VMAF score — full ffmpeg stderr:');
  console.log(stderr);
  process.exit(2);
}
