'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { version: APP_VERSION } = require('../package.json');
const {
  loadConfig, saveConfig, mergeKnown, withResolvedTheme, themeManager, packManager,
  KEYMAP_DIR, PRESETS_DIR, BACKGROUNDS_DIR,
} = require('./config');
const { KeymapManager, sanitizeSlug } = require('./keymaps');
const { PresetManager, sanitizeSlug: sanitizePresetSlug } = require('./presets');
const { sanitizeSlug: sanitizeThemeSlug } = require('./themes');
const { sanitizeId: sanitizePackSlug } = require('./pack-schema');
const { KeyboardHook } = require('./keyboard');

const KEYMAP_POLL_MS = 1000;
const IMG_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const IS_DEV_RUNTIME = !!process.defaultApp
  || /node(?:\.exe)?$/i.test(process.execPath)
  || /electron(?:\.exe)?$/i.test(process.execPath);

class AppRuntime extends EventEmitter {
  constructor() {
    super();
    this.config = loadConfig();
    this.keymaps = new KeymapManager(KEYMAP_DIR);
    this.presets = new PresetManager(PRESETS_DIR);
    this.hook = new KeyboardHook({ keymaps: this.keymaps, onlyAnnotated: true });
    this.keymapWatcher = null;
    this.started = false;
    this.updaterState = { phase: 'idle', devMode: IS_DEV_RUNTIME };
    this.updateInstaller = null;
    this.debugUpdateTimers = [];

    this.hook.on('key', ({ label, description }) => {
      this.emit('key', { label, description });
    });
    this.keymaps.onActiveChange = () => {
      this.emit('status', this.getStatus(false));
    };
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.keymaps.reloadIfChanged();
    this.keymaps.updateActive();
    this.keymapWatcher = setInterval(() => {
      this.keymaps.reloadIfChanged();
      this.keymaps.updateActive();
    }, KEYMAP_POLL_MS);
    this.hook.start();
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    if (this.keymapWatcher) {
      clearInterval(this.keymapWatcher);
      this.keymapWatcher = null;
    }
    this.clearDebugUpdateTimers();
    this.hook.stop();
  }

  getStatus(serverRunning) {
    return {
      running: !!serverRunning,
      version: APP_VERSION,
      mode: 'all',
      onlyAnnotated: true,
      focusedExe: this.keymaps.activeExe,
      activeProfile: this.keymaps.activeProfile?.name ?? null,
      overlayUrl: 'http://127.0.0.1:8765/',
    };
  }

  getConfig() {
    return withResolvedTheme(this.config);
  }

  updateConfig(incoming) {
    mergeKnown(this.config, incoming);
    saveConfig(this.config);
    const cfg = this.getConfig();
    this.emit('config', cfg);
    return cfg;
  }

  listKeymaps() {
    this.keymaps.reloadIfChanged();
    return { profiles: this.keymaps.asList() };
  }

  saveKeymap(slug, data) {
    const clean = sanitizeSlug(slug);
    if (!clean) throw new Error('bad slug');
    const file = this.keymaps.writeProfile(clean, data || {});
    this.keymaps.reloadIfChanged();
    this.emit('status', this.getStatus(false));
    return { ok: true, file: path.basename(file) };
  }

  deleteKeymap(slug) {
    const clean = sanitizeSlug(slug);
    if (!clean) throw new Error('bad slug');
    const ok = this.keymaps.deleteProfile(clean);
    this.keymaps.reloadIfChanged();
    this.emit('status', this.getStatus(false));
    return { ok };
  }

  listPresets() {
    return { presets: this.presets.list() };
  }

  readPreset(slug) {
    const clean = sanitizePresetSlug(slug);
    if (!clean) throw new Error('bad slug');
    return this.presets.read(clean);
  }

  savePreset(slug, body) {
    const clean = sanitizePresetSlug(slug);
    if (!clean) throw new Error('bad slug');
    if (this.presets.isBuiltin(clean)) throw new Error('built-in presets are read-only');
    const name = (body?.name || clean).toString();
    const cfg = body?.config && typeof body.config === 'object' ? body.config : {};
    this.presets.write(clean, name, cfg);
    return { ok: true, slug: clean, name };
  }

  deletePreset(slug) {
    const clean = sanitizePresetSlug(slug);
    if (!clean) throw new Error('bad slug');
    if (this.presets.isBuiltin(clean)) throw new Error('built-in presets are read-only');
    return { ok: this.presets.delete(clean) };
  }

  listThemes() {
    return {
      themes: themeManager.list().map((entry) => {
        const theme = themeManager.read(entry.slug);
        // Themes belong to a pack via __basePack. Legacy themes (no __basePack)
        // default to "default" — the no-composition pack that holds pure
        // keycap+caption styling.
        const basePack = (theme && typeof theme === 'object' && theme.__basePack) || 'default';
        return { ...entry, basePack, theme };
      }),
    };
  }

  readTheme(slug) {
    const clean = sanitizeThemeSlug(slug);
    if (!clean) throw new Error('bad slug');
    const theme = themeManager.read(clean);
    if (!theme) return null;
    const meta = themeManager.list().find((entry) => entry.slug === clean) || {
      slug: clean,
      name: theme.__name || clean,
      source: 'custom',
      readOnly: false,
    };
    const basePack = (theme && typeof theme === 'object' && theme.__basePack) || 'default';
    return { ...meta, basePack, theme };
  }

  saveTheme(slug, body) {
    const clean = sanitizeThemeSlug(slug);
    if (!clean) throw new Error('bad slug');
    const name = (body?.name || clean).toString();
    const theme = body?.theme && typeof body.theme === 'object' ? body.theme : {};
    // Persist the basePack binding so themes always know which pack they belong
    // to. Default to "default" if caller didn't specify (back-compat for
    // existing client code that saves bare themes).
    if (body && body.basePack) {
      theme.__basePack = String(body.basePack);
    } else if (!theme.__basePack) {
      theme.__basePack = 'default';
    }
    themeManager.write(clean, name, theme);
    return { ok: true, slug: clean, name, basePack: theme.__basePack };
  }

  deleteTheme(slug) {
    const clean = sanitizeThemeSlug(slug);
    if (!clean) throw new Error('bad slug');
    if (themeManager.isBuiltin(clean)) throw new Error('built-in themes are read-only');
    const ok = themeManager.delete(clean);
    if (ok && this.config.theme === clean) {
      this.config.theme = 'keycap';
      this.config.themeData = null;
      saveConfig(this.config);
      this.emit('config', this.getConfig());
    }
    return { ok };
  }

  listPacks() {
    return { packs: packManager.list() };
  }

  readPack(slug) {
    const clean = sanitizePackSlug(slug);
    if (!clean) throw new Error('bad slug');
    return packManager.read(clean);
  }

  savePack(slug, body) {
    const clean = sanitizePackSlug(slug);
    if (!clean) throw new Error('bad slug');
    if (packManager.isBuiltin(clean)) throw new Error('built-in packs are read-only');
    const file = packManager.write(clean, body || {});
    return { ok: true, slug: clean, file: path.basename(path.dirname(file)) };
  }

  deletePack(slug) {
    const clean = sanitizePackSlug(slug);
    if (!clean) throw new Error('bad slug');
    if (packManager.isBuiltin(clean)) throw new Error('built-in packs are read-only');
    const ok = packManager.delete(clean);
    if (ok && this.config.pack === clean) {
      this.config.pack = null;
      this.config.packData = null;
      saveConfig(this.config);
      this.emit('config', this.getConfig());
    }
    return { ok };
  }

  resolvePackAssetPath(slug, assetName) {
    return packManager.resolveAssetPath(slug, assetName);
  }

  listBackgrounds() {
    const backgrounds = [];
    if (fs.existsSync(BACKGROUNDS_DIR)) {
      for (const f of fs.readdirSync(BACKGROUNDS_DIR).sort()) {
        const ext = path.extname(f).toLowerCase();
        if (!IMG_EXTS.has(ext)) continue;
        backgrounds.push({
          name: path.basename(f, ext),
          file: f,
          url: pathToFileURL(path.join(BACKGROUNDS_DIR, f)).href,
        });
      }
    }
    return { backgrounds };
  }

  emitTestKey(label, description) {
    this.emit('key', { label, description: description || null });
    return { ok: true };
  }

  getUpdateStatus() {
    return { ...this.updaterState };
  }

  setUpdateStatus(payload) {
    this.updaterState = { ...this.updaterState, ...payload, type: 'updater' };
    this.emit('updater', this.getUpdateStatus());
    return this.getUpdateStatus();
  }

  setUpdateInstaller(fn) {
    this.updateInstaller = typeof fn === 'function' ? fn : null;
  }

  runUpdateInstaller() {
    if (typeof this.updateInstaller !== 'function') throw new Error('updater not ready');
    setTimeout(() => this.updateInstaller(), 200);
    return { ok: true };
  }

  clearDebugUpdateTimers() {
    for (const timer of this.debugUpdateTimers) clearTimeout(timer);
    this.debugUpdateTimers = [];
  }

  runDebugUpdateSequence() {
    if (!IS_DEV_RUNTIME) throw new Error('not found');
    this.clearDebugUpdateTimers();
    const steps = [
      { delay: 0, payload: { phase: 'checking' } },
      { delay: 700, payload: { phase: 'available', version: '9.9.1-dev' } },
      { delay: 1200, payload: { phase: 'downloading', version: '9.9.1-dev', pct: 8 } },
      { delay: 1700, payload: { phase: 'downloading', version: '9.9.1-dev', pct: 34 } },
      { delay: 2200, payload: { phase: 'downloading', version: '9.9.1-dev', pct: 61 } },
      { delay: 2700, payload: { phase: 'downloading', version: '9.9.1-dev', pct: 87 } },
      { delay: 3200, payload: { phase: 'ready', version: '9.9.1-dev', pct: 100 } },
    ];
    for (const step of steps) {
      this.debugUpdateTimers.push(setTimeout(() => {
        this.setUpdateStatus(step.payload);
      }, step.delay));
    }
    return { ok: true };
  }
}

module.exports = new AppRuntime();
