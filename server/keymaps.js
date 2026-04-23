/**
 * KeymapManager — loads JSON profiles from keymaps/, picks the one matching
 * the currently-focused exe, hot-reloads on file change.
 * Ports overlay_server.py's KeymapManager class.
 */
const fs   = require('fs');
const path = require('path');
const { foregroundExe } = require('./win32');

function sanitizeSlug(s) {
  return (s || '').trim().toLowerCase()
    .split('').map(c => /[a-z0-9\-_]/.test(c) ? c : '_').join('');
}

function normalizeComboKey(combo) {
  return String(combo || '').toLowerCase().replace(/\s+/g, '');
}

function normalizeKeyEntry(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return {
      description: value.description == null ? '' : String(value.description),
      enabled: value.enabled !== false,
    };
  }
  return {
    description: value == null ? '' : String(value),
    enabled: true,
  };
}

function normalizeKeyMap(keys) {
  const normalized = {};
  for (const [combo, value] of Object.entries(keys || {})) {
    const normalizedCombo = normalizeComboKey(combo);
    if (!normalizedCombo) continue;
    normalized[normalizedCombo] = normalizeKeyEntry(value);
  }
  return normalized;
}

function serializeKeyMap(keys) {
  const payload = {};
  for (const [combo, entry] of Object.entries(normalizeKeyMap(keys))) {
    payload[combo] = {
      description: entry.description,
      enabled: entry.enabled !== false,
    };
  }
  return payload;
}

class KeymapManager {
  constructor(directory) {
    this.directory      = directory;
    this.profiles       = [];     // [{name, match:[exe,...], keys:{...}, file}]
    this.lastSignature  = '';
    this.activeProfile  = null;
    this.activeExe      = null;
    this.onActiveChange = null;   // callback(profile, exe)
  }

  _signature() {
    try {
      if (!fs.statSync(this.directory).isDirectory()) return '';
    } catch (_) { return ''; }
    const entries = fs.readdirSync(this.directory)
      .filter(f => f.endsWith('.json'))
      .sort()
      .map(f => {
        try {
          const st = fs.statSync(path.join(this.directory, f));
          return `${f}:${st.mtimeMs}`;
        } catch (_) { return ''; }
      });
    return entries.join('|');
  }

  reloadIfChanged() {
    const sig = this._signature();
    if (sig === this.lastSignature) return false;
    this.lastSignature = sig;
    this.profiles = [];

    let files = [];
    try {
      files = fs.readdirSync(this.directory).filter(f => f.endsWith('.json')).sort();
    } catch (_) {
      console.log(`  [keymaps]    no directory at ${this.directory} — running without profiles`);
      return true;
    }

    for (const file of files) {
      const full = path.join(this.directory, file);
      let data;
      try {
        data = JSON.parse(fs.readFileSync(full, 'utf8'));
      } catch (err) {
        console.log(`  [keymaps]    skipped ${file}: ${err.message}`);
        continue;
      }
      const name  = data.name || file.replace(/\.json$/, '');
      let match   = data.match || [];
      if (typeof match === 'string') match = [match];
      match = match.map(m => m.toLowerCase());
      const keys = normalizeKeyMap(data.keys || {});
      this.profiles.push({ name, match, keys, file });
    }

    const names = this.profiles.map(p => p.name).join(', ') || '(none)';
    console.log(`  [keymaps]    loaded ${this.profiles.length} profile(s): ${names}`);

    // Force re-evaluation against the new profile list
    this.activeProfile = null;
    this.activeExe     = null;
    return true;
  }

  updateActive() {
    const exe = foregroundExe();
    if (exe === this.activeExe && this.activeProfile !== null) return;
    if (exe !== this.activeExe) this.activeExe = exe;

    let chosen = null;
    if (exe) {
      for (const p of this.profiles) {
        if (p.match.includes(exe)) { chosen = p; break; }
      }
    }
    if (chosen !== this.activeProfile) {
      this.activeProfile = chosen;
      if (chosen) {
        console.log(`  [profile]    -> ${chosen.name}  (${exe})`);
      } else {
        console.log(`  [profile]    -> (none)  (${exe || 'unknown'})`);
      }
      if (this.onActiveChange) this.onActiveChange(chosen, exe);
    }
  }

  describe(comboKey) {
    if (!this.activeProfile) return null;
    const entry = this.activeProfile.keys[normalizeComboKey(comboKey)];
    if (!entry || entry.enabled === false) return null;
    return entry.description || null;
  }

  writeProfile(slug, data) {
    fs.mkdirSync(this.directory, { recursive: true });
    const file = path.join(this.directory, `${slug}.json`);
    const payload = {
      name:  data.name  || slug,
      match: data.match || [],
      keys:  serializeKeyMap(data.keys || {}),
    };
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
    return file;
  }

  deleteProfile(slug) {
    const file = path.join(this.directory, `${slug}.json`);
    if (fs.existsSync(file)) { fs.unlinkSync(file); return true; }
    return false;
  }

  asList() {
    return this.profiles.map(p => ({
      slug:   p.file.replace(/\.json$/, ''),
      name:   p.name,
      match:  p.match,
      keys:   serializeKeyMap(p.keys),
      active: p === this.activeProfile,
    }));
  }
}

module.exports = { KeymapManager, sanitizeSlug };
