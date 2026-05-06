import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const defaultDest = path.join(repoRoot, 'vendor', 'obs-studio');

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (!raw.startsWith('--')) continue;
    const eq = raw.indexOf('=');
    if (eq !== -1) {
      out[raw.slice(2, eq)] = raw.slice(eq + 1);
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      out[raw.slice(2)] = next;
      index += 1;
    } else {
      out[raw.slice(2)] = true;
    }
  }
  return out;
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch (_) {
    return false;
  }
}

function unique(values) {
  const seen = new Set();
  const out = [];
  for (const value of values.filter(Boolean)) {
    const resolved = path.resolve(String(value));
    const key = resolved.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(resolved);
    }
  }
  return out;
}

function sourceCandidates(explicit) {
  return unique([
    explicit,
    process.env.OBS_STUDIO_ROOT,
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'obs-studio'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'obs-studio'),
  ]);
}

async function resolveObsRoot(explicit) {
  const candidates = sourceCandidates(explicit);
  for (const candidate of candidates) {
    if (await exists(path.join(candidate, 'bin', '64bit', 'obs64.exe'))) {
      return candidate;
    }
  }
  throw new Error(`OBS Studio was not found. Checked:\n${candidates.map((item) => `  - ${item}`).join('\n')}`);
}

async function copyRuntime({ source, dest, clean }) {
  const pieces = ['bin', 'data', 'obs-plugins'];
  if (clean) {
    await fs.rm(dest, { recursive: true, force: true });
  }
  await fs.mkdir(dest, { recursive: true });
  for (const piece of pieces) {
    const from = path.join(source, piece);
    if (!(await exists(from))) {
      throw new Error(`OBS ${piece} directory is missing at ${from}`);
    }
    await fs.cp(from, path.join(dest, piece), {
      recursive: true,
      force: true,
      dereference: true,
    });
  }
  await fs.writeFile(
    path.join(dest, 'KEYCAP_OBS_RUNTIME.json'),
    `${JSON.stringify({
      stagedAt: new Date().toISOString(),
      source,
      note: 'Local packaging test copy. Do not commit this directory. Include OBS GPL notices and source offer before distributing.',
    }, null, 2)}\n`,
    'utf8',
  );
}

const args = parseArgs(process.argv.slice(2));
const source = await resolveObsRoot(args.source);
const dest = path.resolve(String(args.dest || defaultDest));
const clean = args.clean !== false && args.clean !== 'false';

await copyRuntime({ source, dest, clean });

console.log(JSON.stringify({
  ok: true,
  source,
  dest,
  obsExe: path.join(dest, 'bin', '64bit', 'obs64.exe'),
}, null, 2));
