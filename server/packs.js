/**
 * Aesthetic Pack storage and resolution.
 *
 * Built-in packs ship as directories under <APP_ROOT>/packs/<id>/{pack.json,assets/}.
 * User-authored packs live under <DATA_ROOT>/customPacks/<id>/.
 * Legacy themes auto-migrate on read via wrapThemeAsPack — no destructive disk rewrites.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const {
  SCHEMA_VERSION,
  sanitizeId,
  isPack,
  isBareTheme,
  wrapThemeAsPack,
  validatePack,
  validateAssetReferences,
  createEmptyPack,
} = require('./pack-schema');

function deepClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function safeReadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function listSubdirs(root) {
  if (!fs.existsSync(root)) return [];
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (_) {
    return [];
  }
}

class PackManager {
  /**
   * @param {object} opts
   * @param {string} opts.builtinDir - absolute path to <APP_ROOT>/packs
   * @param {string} opts.customDir - absolute path to <DATA_ROOT>/customPacks
   * @param {object} opts.themeManager - ThemeManager instance for the keycapTheme slice
   */
  constructor(opts = {}) {
    this.builtinDir = opts.builtinDir;
    this.customDir = opts.customDir;
    this.themeManager = opts.themeManager;
  }

  _ensureCustomDir() {
    if (this.customDir) fs.mkdirSync(this.customDir, { recursive: true });
  }

  _readPackFile(dir, slug) {
    if (!dir) return null;
    const file = path.join(dir, slug, 'pack.json');
    if (!fs.existsSync(file)) return null;
    const data = safeReadJson(file);
    if (!data) return null;
    if (!data.id) data.id = slug;
    return data;
  }

  _listDir(dir, source) {
    return listSubdirs(dir)
      .map((name) => {
        const file = path.join(dir, name, 'pack.json');
        if (!fs.existsSync(file)) return null;
        const data = safeReadJson(file) || {};
        return {
          slug: data.id || name,
          name: data.name || data.id || name,
          source,
          readOnly: source === 'builtin',
          description: data.description || '',
          version: data.version || '1.0.0',
          // Default to true when unset so legacy packs don't disappear from
          // the picker. Explicit `false` hides a pack from the create-theme
          // flow while still letting saved themes that reference it resolve.
          published: data.published !== false,
        };
      })
      .filter(Boolean);
  }

  /**
   * List true packs (built-in + custom). Legacy themes are NOT included here —
   * they live as themes under the `default` pack and surface through
   * ThemeManager / `/api/themes`.
   */
  list() {
    const packs = [];
    const seen = new Set();
    const push = (entry) => {
      if (seen.has(entry.slug)) return;
      seen.add(entry.slug);
      packs.push(entry);
    };

    this._listDir(this.builtinDir, 'builtin').forEach(push);
    this._listDir(this.customDir, 'custom').forEach(push);
    return packs;
  }

  /**
   * Read a pack by slug. Returns the pack envelope (validated, asset map
   * resolved to URL paths) or null. Legacy themes are wrapped on read.
   */
  read(slug) {
    const clean = sanitizeId(slug);
    if (!clean) return null;

    let pack = this._readPackFile(this.builtinDir, clean);
    let source = 'builtin';
    if (!pack) {
      pack = this._readPackFile(this.customDir, clean);
      source = 'custom';
    }

    if (pack && isPack(pack)) {
      pack.__source = source;
      pack.__assetBaseUrl = `/packs/${clean}/assets/`;
      return pack;
    }

    if (pack && isBareTheme(pack)) {
      const wrapped = wrapThemeAsPack(pack.__name || clean, clean, pack, { source });
      wrapped.__assetBaseUrl = `/packs/${clean}/assets/`;
      return wrapped;
    }

    if (this.themeManager) {
      const theme = this.themeManager.read(clean);
      if (theme) {
        const themeMeta = this.themeManager.list().find((entry) => entry.slug === clean);
        const wrapped = wrapThemeAsPack(theme.__name || themeMeta?.name || clean, clean, theme, {
          source: themeMeta?.source === 'builtin' ? 'theme-builtin' : 'theme-custom',
        });
        // Legacy themes have no assets dir; URL omitted on purpose.
        return wrapped;
      }
    }

    return null;
  }

  /**
   * Write a pack to disk. Built-ins (pack-shaped) are read-only; theme-builtins
   * round-trip through ThemeManager.writeBuiltin which respects its own ACLs.
   */
  write(slug, payload) {
    const clean = sanitizeId(slug);
    if (!clean) throw new Error('bad slug');
    const validation = validatePack(payload);
    if (!validation.ok) {
      const summary = validation.errors.map((e) => `${e.path || '<root>'}: ${e.message}`).join('; ');
      throw new Error(`invalid pack: ${summary}`);
    }
    if (this.isBuiltin(clean)) {
      throw new Error('built-in packs are read-only');
    }
    this._ensureCustomDir();
    const dir = path.join(this.customDir, clean);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'pack.json');
    const stripped = deepClone(payload);
    delete stripped.__source;
    delete stripped.__assetBaseUrl;
    stripped.id = clean;
    stripped.schemaVersion = SCHEMA_VERSION;
    fs.writeFileSync(file, JSON.stringify(stripped, null, 2), 'utf8');
    return file;
  }

  delete(slug) {
    const clean = sanitizeId(slug);
    if (!clean) return false;
    if (this.isBuiltin(clean)) return false;
    if (!this.customDir) return false;
    const dir = path.join(this.customDir, clean);
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }

  isBuiltin(slug) {
    if (!this.builtinDir) return false;
    return fs.existsSync(path.join(this.builtinDir, slug, 'pack.json'));
  }

  /**
   * Resolve the absolute path to a pack asset on disk. Returns null if the
   * asset is outside the pack directory (path-traversal protection).
   */
  resolveAssetPath(slug, assetName) {
    const clean = sanitizeId(slug);
    if (!clean || !assetName) return null;
    const safe = String(assetName).replace(/^\/+/, '');
    if (safe.includes('..') || path.isAbsolute(safe)) return null;
    const candidates = [];
    if (this.builtinDir) candidates.push(path.join(this.builtinDir, clean, 'assets', safe));
    if (this.customDir) candidates.push(path.join(this.customDir, clean, 'assets', safe));
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }
}

/**
 * Resolve the pack referenced by a config payload. Mirrors `resolveConfigTheme`:
 * `packData` (inline) > `pack` slug + theme parameterValues > legacy theme
 * fallback. Returns a fully validated pack object, or an empty pack wrapping
 * the resolved theme.
 *
 * When the config references a saved theme that carries `__parameterValues`,
 * those values are applied to the pack template here so the overlay always
 * sees a fully-resolved pack regardless of whether the editor snapshotted
 * packData. This is the resolution path for "user picks a saved Win95 theme
 * → runtime restores their customized title bar colors / window outline."
 */
function resolveConfigPack(config, packManager, fallbackTheme, themeManager) {
  if (config && typeof config.packData === 'object' && config.packData) {
    const inline = deepClone(config.packData);
    if (isPack(inline)) return inline;
    if (isBareTheme(inline)) return wrapThemeAsPack(inline.__name, 'inline', inline, { source: 'inline' });
  }
  const slug = sanitizeId(config?.pack || '');
  if (slug && packManager) {
    const pack = packManager.read(slug);
    if (pack) {
      // Look up the active theme and apply its saved parameterValues to the
      // pack template (if any). Theme.__parameterValues is the persisted form
      // of "user customized these knobs while editing under this pack."
      const themeSlug = config?.theme;
      if (themeSlug && themeManager) {
        const theme = themeManager.read(themeSlug);
        const values = theme && theme.__parameterValues;
        if (values && typeof values === 'object') {
          applyParameterValuesToPack(pack, values);
        }
      }
      return pack;
    }
  }
  return createEmptyPack(fallbackTheme || (config && config.resolvedTheme) || {});
}

/**
 * Walk pack.parameters[] and write each parameter's value at its appliesTo
 * paths. Mutates the pack in place. The string-path walker matches the
 * editor's writeAtPath so server and client resolve to identical results.
 */
function applyParameterValuesToPack(pack, values) {
  if (!pack || !Array.isArray(pack.parameters) || !values) return;
  pack.parameters.forEach((p) => {
    if (!(p.id in values)) return;
    const targets = Array.isArray(p.appliesTo) ? p.appliesTo : (p.appliesTo ? [p.appliesTo] : []);
    targets.forEach((path) => writeAtPath(pack, path, values[p.id]));
  });
}

function writeAtPath(obj, path, value) {
  const parts = String(path).match(/[^.\[\]]+|\[\d+\]/g) || [];
  let cursor = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const seg = parts[i];
    const isIdx = /^\[\d+\]$/.test(seg);
    const key = isIdx ? Number(seg.slice(1, -1)) : seg;
    if (cursor[key] === undefined || cursor[key] === null) {
      const nextSeg = parts[i + 1];
      cursor[key] = /^\[\d+\]$/.test(nextSeg) ? [] : {};
    }
    cursor = cursor[key];
  }
  const lastSeg = parts[parts.length - 1];
  const lastKey = /^\[\d+\]$/.test(lastSeg) ? Number(lastSeg.slice(1, -1)) : lastSeg;
  cursor[lastKey] = value;
}

module.exports = {
  PackManager,
  resolveConfigPack,
  validatePack,
  validateAssetReferences,
  isPack,
  isBareTheme,
  wrapThemeAsPack,
};
