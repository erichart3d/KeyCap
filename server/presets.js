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

const BUILTIN_PRESETS = [
  { slug: 'terminal', name: 'Built-in - Terminal', config: { theme: 'terminal', themeData: null } },
  { slug: 'neon', name: 'Built-in - Neon', config: { theme: 'neon', themeData: null } },
  { slug: 'chunky', name: 'Built-in - Chunky', config: { theme: 'chunky', themeData: null } },
  { slug: 'amber', name: 'Built-in - Amber', config: { theme: 'amber', themeData: null } },
  { slug: 'synthwave', name: 'Built-in - Synthwave', config: { theme: 'synthwave', themeData: null } },
  { slug: 'carbon', name: 'Built-in - Carbon', config: { theme: 'carbon', themeData: null } },
  { slug: 'coral', name: 'Built-in - Coral', config: { theme: 'coral', themeData: null } },
  { slug: 'midnight', name: 'Built-in - Midnight', config: { theme: 'midnight', themeData: null } },
  { slug: 'smoke', name: 'Built-in - Smoke', config: { theme: 'smoke', themeData: null } },
  { slug: 'minimal', name: 'Built-in - Minimal', config: { theme: 'minimal', themeData: null } },
  // Pack-flavored presets — each loads a flagship Aesthetic Pack alongside its
  // recommended layout/animation defaults.
  { slug: 'pack-win95',        name: 'Pack - Windows 95',  config: { pack: 'win95',        packData: null, fade: 'fade',    animationSpeed: 1 } },
  { slug: 'pack-neo-tokyo',    name: 'Pack - Neo-Tokyo',   config: { pack: 'neo-tokyo',    packData: null, fade: 'glitch',  animationSpeed: 1 } },
  { slug: 'pack-magic-forest', name: 'Pack - Magic Forest', config: { pack: 'magic-forest', packData: null, fade: 'soften',  animationSpeed: 1 } },
];

const BUILTIN_PRESET_MAP = BUILTIN_PRESETS.reduce((acc, preset) => {
  acc[preset.slug] = preset;
  return acc;
}, {});

class PresetManager {
  constructor(directory) {
    this.directory = directory;
  }

  _ensureDir() {
    fs.mkdirSync(this.directory, { recursive: true });
  }

  list() {
    const custom = !fs.existsSync(this.directory) ? [] : fs.readdirSync(this.directory)
      .filter(f => f.endsWith('.json'))
      .sort()
      .map(f => {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(this.directory, f), 'utf8'));
          return {
            slug: f.replace(/\.json$/, ''),
            name: data.__name || f.replace(/\.json$/, ''),
            source: 'custom',
            readOnly: false,
          };
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean);
    const builtins = BUILTIN_PRESETS.map((preset) => ({
      slug: preset.slug,
      name: preset.name,
      source: 'builtin',
      readOnly: true,
    }));
    return [...builtins, ...custom];
  }

  read(slug) {
    if (BUILTIN_PRESET_MAP[slug]) {
      const preset = BUILTIN_PRESET_MAP[slug];
      return { __name: preset.name.replace(/^Built-in - /, ''), ...preset.config };
    }
    const file = path.join(this.directory, `${slug}.json`);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {
      return null;
    }
  }

  write(slug, name, config) {
    if (BUILTIN_PRESET_MAP[slug]) throw new Error('built-in presets are read-only');
    this._ensureDir();
    const file = path.join(this.directory, `${slug}.json`);
    const payload = { __name: name || slug, ...config };
    delete payload.__slug;
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
    return file;
  }

  delete(slug) {
    if (BUILTIN_PRESET_MAP[slug]) return false;
    const file = path.join(this.directory, `${slug}.json`);
    if (fs.existsSync(file)) { fs.unlinkSync(file); return true; }
    return false;
  }

  isBuiltin(slug) {
    return !!BUILTIN_PRESET_MAP[slug];
  }
}

module.exports = { PresetManager, sanitizeSlug, BUILTIN_PRESETS };
