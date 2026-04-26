/**
 * Aesthetic Pack schema — version 1.
 *
 * Packs are the top-level visual identity primitive. They wrap an existing
 * theme as `keycapTheme` and add an optional `composition` block describing
 * how caption + keycap render together — fused into one card with a header
 * region and decorative frame, or kept as separate elements with optional
 * per-key or row-level chrome.
 *
 * Bare themes (no `schemaVersion`, has `keycap` at top level) migrate on read
 * via `wrapThemeAsPack` — disk files are not rewritten.
 */
'use strict';

const SCHEMA_VERSION = 1;

const COMPOSITION_MODES = ['separate', 'card'];
const FRAME_SCOPES = ['none', 'per-key', 'row'];
const ANCHOR_VALUES = ['tl', 'tr', 'bl', 'br', 'left', 'right', 'top', 'bottom', 'center'];

// Parameter control types — each maps to a UI widget the editor knows how to
// render. New types can be added without touching pack files; old packs keep
// working because unknown types fall back to a JSON text input.
const PARAMETER_TYPES = [
  'color',         // hex/rgba color picker
  'gradient',      // linear gradient editor (angle + stops)
  'number',        // numeric input with min/max/step
  'slider',        // range slider with min/max/step
  'text',          // freeform text (e.g. caption font name)
  'select',        // dropdown with discrete options
  'toggle',        // boolean
  'shape',         // keycap shape selector (square, rounded, pill, etc.)
  'font',          // font-family picker
  'shadow',        // shadow editor (x, y, blur, spread, color)
  'fill',          // generic fill editor (solid or gradient)
  'json',          // raw JSON fallback for advanced/custom shapes
];

// Standard parameter ID namespace — packs that share these IDs share their
// meaning. Any pack can override a standard parameter's label/default; the
// `appliesTo` JSON path is what determines what the value writes to.
const STANDARD_PARAMETER_PREFIX = 'std.';

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function deepClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function sanitizeId(value) {
  return (value || '').trim().toLowerCase()
    .split('').map((c) => /[a-z0-9\-_]/.test(c) ? c : '-').join('')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Detect a bare theme payload — one missing the pack envelope but holding the
 * familiar keycap/caption sections. Used to migrate-on-read so disk files stay
 * pristine until the editor saves.
 */
function isBareTheme(value) {
  if (!isObject(value)) return false;
  if ('schemaVersion' in value) return false;
  if (!isObject(value.keycap) && !isObject(value.caption)) return false;
  return true;
}

function isPack(value) {
  return isObject(value) && value.schemaVersion === SCHEMA_VERSION && isObject(value.keycapTheme);
}

/**
 * Wrap a legacy theme object in a pack envelope. Caller owns the `theme`
 * payload — we deep-clone it so subsequent edits don't mutate the source.
 */
function wrapThemeAsPack(name, slug, theme, extras = {}) {
  const id = sanitizeId(slug) || 'theme';
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    name: name || (theme && theme.__name) || id,
    author: extras.author || 'built-in',
    version: extras.version || '1.0.0',
    description: extras.description || '',
    typography: null,
    motion: null,
    keycapTheme: deepClone(theme) || {},
    composition: null,
    parameters: null,
    hides: null,
    assets: extras.assets || null,
    __source: extras.source || 'theme-wrap',
  };
}

/**
 * Validate a pack object. Returns { ok, errors[] } — never throws. Errors are
 * structured `{ path, message }`. Only structural checks here; renderers are
 * tolerant of missing optional fields.
 */
function validatePack(pack) {
  const errors = [];
  const push = (path, message) => errors.push({ path, message });

  if (!isObject(pack)) {
    return { ok: false, errors: [{ path: '', message: 'pack must be an object' }] };
  }
  if (pack.schemaVersion !== SCHEMA_VERSION) {
    push('schemaVersion', `expected ${SCHEMA_VERSION}`);
  }
  if (!pack.id || typeof pack.id !== 'string') {
    push('id', 'required string');
  } else if (sanitizeId(pack.id) !== pack.id) {
    push('id', 'must be lowercase alphanumeric with dashes only');
  }
  if (!isObject(pack.keycapTheme)) {
    push('keycapTheme', 'required object');
  }
  if (pack.composition !== null && pack.composition !== undefined) {
    validateComposition(pack.composition, push);
  }
  if (pack.typography !== null && pack.typography !== undefined && !isObject(pack.typography)) {
    push('typography', 'must be object or null');
  }
  if (pack.motion !== null && pack.motion !== undefined && !isObject(pack.motion)) {
    push('motion', 'must be object or null');
  }
  if (pack.assets !== null && pack.assets !== undefined && !isObject(pack.assets)) {
    push('assets', 'must be object or null');
  }
  if (pack.published !== undefined && typeof pack.published !== 'boolean') {
    push('published', 'must be boolean');
  }
  if (pack.parameters !== null && pack.parameters !== undefined) {
    validateParameters(pack.parameters, push);
  }
  if (pack.hides !== null && pack.hides !== undefined) {
    if (!Array.isArray(pack.hides)) {
      push('hides', 'must be array of parameter ids');
    } else {
      pack.hides.forEach((id, i) => {
        if (typeof id !== 'string' || !id) push(`hides[${i}]`, 'must be non-empty string');
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

function validateParameters(parameters, push) {
  if (!Array.isArray(parameters)) { push('parameters', 'must be array'); return; }
  const seenIds = new Set();
  parameters.forEach((p, i) => {
    const root = `parameters[${i}]`;
    if (!isObject(p)) { push(root, 'must be object'); return; }
    if (!p.id || typeof p.id !== 'string') { push(`${root}.id`, 'required string'); }
    else if (seenIds.has(p.id)) { push(`${root}.id`, `duplicate id "${p.id}"`); }
    else seenIds.add(p.id);
    if (!p.label || typeof p.label !== 'string') { push(`${root}.label`, 'required string'); }
    if (!p.type || typeof p.type !== 'string') { push(`${root}.type`, 'required string'); }
    if (p.appliesTo !== undefined && p.appliesTo !== null) {
      if (typeof p.appliesTo === 'string') {
        // single path
      } else if (Array.isArray(p.appliesTo)) {
        // multiple paths — value writes to each
        p.appliesTo.forEach((path, j) => {
          if (typeof path !== 'string') push(`${root}.appliesTo[${j}]`, 'must be string');
        });
      } else {
        push(`${root}.appliesTo`, 'must be string or array of strings');
      }
    }
    if (p.section !== undefined && p.section !== null) {
      // section can be a string (legacy/free-form label) OR an object
      // { tab: 'keycap'|'caption', group: 'Color'|'Shape'|... } — the latter
      // slots the parameter into an existing creator section.
      if (typeof p.section === 'string') {
        // ok — free-form label
      } else if (isObject(p.section)) {
        if (p.section.tab && typeof p.section.tab !== 'string') {
          push(`${root}.section.tab`, 'must be string');
        }
        if (p.section.group && typeof p.section.group !== 'string') {
          push(`${root}.section.group`, 'must be string');
        }
      } else {
        push(`${root}.section`, 'must be string or { tab, group } object');
      }
    }
  });
}

function validateComposition(composition, push) {
  if (!isObject(composition)) { push('composition', 'must be object'); return; }
  if (composition.mode !== undefined && !COMPOSITION_MODES.includes(composition.mode)) {
    push('composition.mode', `must be one of ${COMPOSITION_MODES.join('|')}`);
  }
  if (composition.frameScope !== undefined && !FRAME_SCOPES.includes(composition.frameScope)) {
    push('composition.frameScope', `must be one of ${FRAME_SCOPES.join('|')}`);
  }
  if (composition.frame !== undefined && composition.frame !== null) {
    validateFrame(composition.frame, 'composition.frame', push);
  }
  // mode=card requires a frame, since the caption goes into its header.
  if (composition.mode === 'card' && !isObject(composition.frame)) {
    push('composition.frame', 'required when composition.mode is "card"');
  }
}

function validateFrame(frame, root, push) {
  if (!isObject(frame)) { push(root, 'must be object'); return; }
  if (frame.padding !== undefined && frame.padding !== null && !isObject(frame.padding)) {
    push(`${root}.padding`, 'must be object or null');
  }
  if (frame.fill !== undefined && frame.fill !== null && typeof frame.fill !== 'string' && !isObject(frame.fill)) {
    push(`${root}.fill`, 'must be string, object, or null');
  }
  if (frame.border !== undefined && frame.border !== null && !isObject(frame.border)) {
    push(`${root}.border`, 'must be object or null');
  }
  if (frame.header !== undefined && frame.header !== null) {
    if (!isObject(frame.header)) {
      push(`${root}.header`, 'must be object or null');
    } else if (frame.header.buttons !== undefined && !Array.isArray(frame.header.buttons)) {
      push(`${root}.header.buttons`, 'must be array');
    }
  }
  if (frame.decor !== undefined && frame.decor !== null) {
    if (!Array.isArray(frame.decor)) {
      push(`${root}.decor`, 'must be array or null');
    } else {
      frame.decor.forEach((item, index) => {
        if (!isObject(item)) {
          push(`${root}.decor[${index}]`, 'must be object');
        } else if (item.anchor && !ANCHOR_VALUES.includes(item.anchor)) {
          push(`${root}.decor[${index}].anchor`, `must be one of ${ANCHOR_VALUES.join('|')}`);
        }
      });
    }
  }
}

function collectAssetReferences(pack) {
  const refs = new Set();
  const composition = pack && pack.composition;
  if (!isObject(composition)) return [];
  const frame = composition.frame;
  if (isObject(frame)) {
    if (Array.isArray(frame.decor)) {
      frame.decor.forEach((d) => d.asset && refs.add(d.asset));
    }
    if (frame.header && frame.header.iconAsset) refs.add(frame.header.iconAsset);
  }
  return [...refs];
}

function validateAssetReferences(pack) {
  const refs = collectAssetReferences(pack);
  const map = isObject(pack.assets) ? pack.assets : {};
  const missing = refs.filter((name) => !(name in map));
  return { ok: missing.length === 0, missing };
}

function createEmptyPack(theme) {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: 'empty',
    name: 'Empty',
    author: 'built-in',
    version: '1.0.0',
    description: '',
    typography: null,
    motion: null,
    keycapTheme: theme || {},
    composition: null,
    assets: null,
    __source: 'empty',
  };
}

module.exports = {
  SCHEMA_VERSION,
  COMPOSITION_MODES,
  FRAME_SCOPES,
  ANCHOR_VALUES,
  PARAMETER_TYPES,
  STANDARD_PARAMETER_PREFIX,
  sanitizeId,
  isPack,
  isBareTheme,
  wrapThemeAsPack,
  validatePack,
  validateAssetReferences,
  collectAssetReferences,
  createEmptyPack,
};
