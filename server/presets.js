/**
 * Named preset store — each preset is a full config snapshot saved as
 * `presets/<slug>.json` with a `__name` meta field.
 */
const fs   = require('fs');
const path = require('path');

function sanitizeSlug(s) {
  return (s || '').trim().toLowerCase()
    .split('').map(c => /[a-z0-9\-_]/.test(c) ? c : '-').join('')
    .replace(/-+/g, '-').replace(/^-|-$/g, '');
}

class PresetManager {
  constructor(directory) {
    this.directory = directory;
  }

  _ensureDir() {
    fs.mkdirSync(this.directory, { recursive: true });
  }

  list() {
    if (!fs.existsSync(this.directory)) return [];
    return fs.readdirSync(this.directory)
      .filter(f => f.endsWith('.json'))
      .sort()
      .map(f => {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(this.directory, f), 'utf8'));
          return { slug: f.replace(/\.json$/, ''), name: data.__name || f.replace(/\.json$/, '') };
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean);
  }

  read(slug) {
    const file = path.join(this.directory, `${slug}.json`);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {
      return null;
    }
  }

  write(slug, name, config) {
    this._ensureDir();
    const file = path.join(this.directory, `${slug}.json`);
    const payload = { __name: name || slug, ...config };
    delete payload.__slug;
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
    return file;
  }

  delete(slug) {
    const file = path.join(this.directory, `${slug}.json`);
    if (fs.existsSync(file)) { fs.unlinkSync(file); return true; }
    return false;
  }
}

module.exports = { PresetManager, sanitizeSlug };
