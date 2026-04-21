/**
 * Theme storage and legacy theme migration helpers.
 * Built-in themes are read-only; user-authored themes live in `customThemes/`.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CUSTOM_THEMES_DIR = path.join(ROOT, 'customThemes');

function sanitizeSlug(value) {
  return (value || '').trim().toLowerCase()
    .split('').map((char) => /[a-z0-9\-_]/.test(char) ? char : '-').join('')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepMerge(base, incoming) {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return incoming === undefined ? deepClone(base) : deepClone(incoming);
  }
  const output = Array.isArray(base) ? [...base] : { ...(base || {}) };
  for (const [key, value] of Object.entries(incoming)) {
    const current = output[key];
    if (value && typeof value === 'object' && !Array.isArray(value) && current && typeof current === 'object' && !Array.isArray(current)) {
      output[key] = deepMerge(current, value);
    } else if (Array.isArray(value)) {
      output[key] = value.map((item) => deepClone(item));
    } else {
      output[key] = value;
    }
  }
  return output;
}

function normalizeHex(hex, fallback = '#000000') {
  const raw = String(hex || '').trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{6}$/.test(raw)) return `#${raw.toLowerCase()}`;
  if (/^[0-9a-fA-F]{3}$/.test(raw)) return `#${raw.split('').map((c) => c + c).join('').toLowerCase()}`;
  return fallback;
}

function mixHex(a, b, ratio = 0.5) {
  const left = normalizeHex(a);
  const right = normalizeHex(b);
  const t = Math.max(0, Math.min(1, Number(ratio) || 0));
  const mix = (start, end) => Math.round(start + (end - start) * t);
  const lr = parseInt(left.slice(1, 3), 16);
  const lg = parseInt(left.slice(3, 5), 16);
  const lb = parseInt(left.slice(5, 7), 16);
  const rr = parseInt(right.slice(1, 3), 16);
  const rg = parseInt(right.slice(3, 5), 16);
  const rb = parseInt(right.slice(5, 7), 16);
  return `#${[mix(lr, rr), mix(lg, rg), mix(lb, rb)].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

const DEFAULT_THEME = {
  __name: 'Keycap',
  defaults: {
    fontWeight: 700,
    keycapScale: 1,
    captionScale: 1,
    captionPosition: 'above',
    fade: 'glitch',
    animationSpeed: 1,
  },
  keycap: {
    fill: {
      type: 'linear',
      angle: 180,
      stops: [
        { color: '#f5f3ec', position: 0 },
        { color: '#d6d2c6', position: 85 },
        { color: '#bcb7a8', position: 100 },
      ],
    },
    textColor: '#222222',
    textShadow: 'none',
    letterSpacing: 1.5,
    fontSize: 22,
    paddingX: 16,
    paddingY: 8,
    textAlign: 'center-center',
    shape: 'rounded',
    cornerRadius: 8,
    outline: { enabled: true, width: 1, color: 'rgba(0, 0, 0, 0.25)' },
    glow: { enabled: false, color: '#7a766b', spread: 18, opacity: 0.35 },
    shadow: {
      enabled: true,
      surfaceOpacity: 1,
      dropOpacity: 1,
      layers: [
        { inset: true, x: 0, y: 1, blur: 0, spread: 0, color: 'rgba(255, 255, 255, 0.85)' },
        { inset: true, x: 0, y: -2, blur: 0, spread: 0, color: 'rgba(0, 0, 0, 0.12)' },
        { x: 0, y: 4, blur: 6, spread: 0, color: 'rgba(0, 0, 0, 0.35)' },
        { x: 0, y: 1, blur: 0, spread: 0, color: 'rgba(0, 0, 0, 0.2)' },
      ],
    },
    texture: { type: 'none', color: '#000000', opacity: 0.22, density: 3, gradientTo: '#000000' },
    opacity: 1,
  },
  caption: {
    fill: { type: 'solid', color: '#f5f3ec' },
    textColor: '#222222',
    textShadow: 'none',
    letterSpacing: 2,
    fontSize: 16,
    paddingX: 8,
    paddingY: 2,
    textAlign: 'center-center',
    shape: 'rounded',
    cornerRadius: 4,
    outline: { enabled: true, width: 1, color: 'rgba(0, 0, 0, 0.25)' },
    glow: { enabled: false, color: '#c8c1b5', spread: 12, opacity: 0.18 },
    shadow: { enabled: false, surfaceOpacity: 1, dropOpacity: 0, layers: [] },
    texture: { type: 'none', color: '#000000', opacity: 0.16, density: 3, gradientTo: '#000000' },
    opacity: 1,
  },
};

function baseTheme(name, keycap, caption, extra = {}) {
  return deepMerge(DEFAULT_THEME, { __name: name, keycap, caption, ...extra });
}

function vhsTheme(name, bg, border, glow, scanlines) {
  return baseTheme(
    name,
    {
      fill: { type: 'solid', color: bg },
      textColor: '#ffffff',
      textShadow: `-2px 0 ${border}, 2px 0 ${bg}`,
      letterSpacing: 2,
      shape: 'square',
      outline: { enabled: true, width: 3, color: border },
      glow: { enabled: true, color: glow, spread: 18, opacity: 0.55 },
      shadow: { enabled: true, layers: [{ x: 5, y: 5, blur: 0, spread: 0, color: glow }] },
      texture: { type: scanlines ? 'scanlines' : 'none', color: '#000000', opacity: 0.22, density: 3, gradientTo: '#000000' },
      opacity: 0.92,
    },
    {
      fill: { type: 'solid', color: 'rgba(20, 0, 30, 0.55)' },
      textColor: border,
      textShadow: `0 0 6px ${border}, 2px 2px 0 ${bg}`,
      letterSpacing: 2,
      shape: 'square',
      outline: { enabled: true, width: 2, color: glow },
      glow: { enabled: false, color: glow, spread: 12, opacity: 0.2 },
      shadow: { enabled: false, layers: [] },
      texture: { type: 'none', color: '#000000', opacity: 0.16, density: 3, gradientTo: '#000000' },
    },
  );
}

function modernTheme(name, bg, border, glow) {
  return baseTheme(
    name,
    {
      fill: { type: 'solid', color: bg },
      textColor: '#ffffff',
      textShadow: 'none',
      letterSpacing: 1.5,
      shape: 'rounded',
      cornerRadius: 6,
      outline: { enabled: true, width: 2, color: border },
      glow: { enabled: false, color: glow, spread: 18, opacity: 0.25 },
      shadow: {
        enabled: true,
        layers: [
          { x: 0, y: 4, blur: 16, spread: 0, color: 'rgba(0, 0, 0, 0.5)' },
          { inset: true, x: 0, y: 1, blur: 0, spread: 0, color: 'rgba(255, 255, 255, 0.08)' },
        ],
      },
      texture: { type: 'none', color: '#000000', opacity: 0, density: 3, gradientTo: '#000000' },
      opacity: 1,
    },
    {
      fill: { type: 'solid', color: 'rgba(20, 0, 30, 0.55)' },
      textColor: border,
      textShadow: 'none',
      letterSpacing: 2,
      shape: 'rounded',
      cornerRadius: 4,
      outline: { enabled: true, width: 1, color: glow },
      glow: { enabled: false, color: glow, spread: 12, opacity: 0.18 },
      shadow: { enabled: false, layers: [] },
      texture: { type: 'none', color: '#000000', opacity: 0, density: 3, gradientTo: '#000000' },
    },
  );
}

function sleekTheme(name, bg, border, captionBorder = 'transparent') {
  return baseTheme(
    name,
    {
      fill: { type: 'solid', color: bg },
      textColor: '#ffffff',
      textShadow: 'none',
      letterSpacing: 1.5,
      shape: 'pill',
      outline: { enabled: true, width: 1, color: 'rgba(255, 255, 255, 0.12)' },
      glow: { enabled: false, color: border, spread: 16, opacity: 0.18 },
      shadow: { enabled: false, layers: [] },
      texture: { type: 'none', color: '#000000', opacity: 0, density: 3, gradientTo: '#000000' },
      opacity: 0.88,
    },
    {
      fill: { type: 'solid', color: bg },
      textColor: border,
      textShadow: 'none',
      letterSpacing: 2,
      shape: 'pill',
      outline: { enabled: captionBorder !== 'transparent', width: 1, color: captionBorder },
      glow: { enabled: false, color: captionBorder === 'transparent' ? border : captionBorder, spread: 10, opacity: 0.14 },
      shadow: { enabled: false, layers: [] },
      texture: { type: 'none', color: '#000000', opacity: 0, density: 3, gradientTo: '#000000' },
      opacity: 0.92,
    },
  );
}

function mechanicalTheme(name, bg, border, glow) {
  const fillTop = mixHex(bg, '#ffffff', 0.72);
  const fillMid = mixHex(bg, '#ffffff', 0.38);
  const fillBottom = mixHex(bg, '#000000', 0.18);
  const edge = mixHex(border || bg, '#000000', 0.2);
  return baseTheme(
    name,
    {
      fill: {
        type: 'linear',
        angle: 180,
        stops: [
          { color: fillTop, position: 0 },
          { color: fillMid, position: 85 },
          { color: fillBottom, position: 100 },
        ],
      },
      textColor: '#222222',
      textShadow: 'none',
      letterSpacing: 1.5,
      shape: 'rounded',
      cornerRadius: 8,
      outline: { enabled: true, width: 1, color: edge },
      glow: { enabled: false, color: glow, spread: 18, opacity: 0.25 },
      shadow: {
        enabled: true,
        layers: [
          { inset: true, x: 0, y: 1, blur: 0, spread: 0, color: 'rgba(255, 255, 255, 0.85)' },
          { inset: true, x: 0, y: -2, blur: 0, spread: 0, color: 'rgba(0, 0, 0, 0.12)' },
          { x: 0, y: 4, blur: 6, spread: 0, color: 'rgba(0, 0, 0, 0.35)' },
          { x: 0, y: 1, blur: 0, spread: 0, color: 'rgba(0, 0, 0, 0.2)' },
        ],
      },
      texture: { type: 'none', color: '#000000', opacity: 0, density: 3, gradientTo: '#000000' },
      opacity: 1,
    },
    {
      fill: { type: 'solid', color: fillTop },
      textColor: '#222222',
      textShadow: 'none',
      letterSpacing: 2,
      shape: 'rounded',
      cornerRadius: 4,
      outline: { enabled: true, width: 1, color: edge },
      glow: { enabled: false, color: glow, spread: 12, opacity: 0.16 },
      shadow: { enabled: false, layers: [] },
      texture: { type: 'none', color: '#000000', opacity: 0, density: 3, gradientTo: '#000000' },
    },
    {
      accents: { glow },
    },
  );
}

const BUILTIN_THEMES = [
  { slug: 'keycap', name: 'Keycap', theme: mechanicalTheme('Keycap', '#e8e6df', '#c4c1b6', '#7a766b') },
  { slug: 'vhs', name: 'VHS', theme: vhsTheme('VHS', '#ff2e9a', '#00f0ff', '#b967ff', true) },
  { slug: 'terminal', name: 'Terminal', theme: vhsTheme('Terminal', '#001a00', '#39ff14', '#39ff14', true) },
  { slug: 'neon', name: 'Neon', theme: vhsTheme('Neon', '#ff007a', '#c6ff00', '#00e5ff', false) },
  { slug: 'chunky', name: 'Chunky', theme: vhsTheme('Chunky', '#000000', '#ffe066', '#ff5a1f', false) },
  { slug: 'amber', name: 'Amber', theme: vhsTheme('Amber', '#1a0d00', '#ffb300', '#ff6d00', true) },
  { slug: 'synthwave', name: 'Synthwave', theme: vhsTheme('Synthwave', '#1a0030', '#ff2e9a', '#9400ff', true) },
  { slug: 'studio', name: 'Studio', theme: modernTheme('Studio', '#1a1a2e', '#4facfe', '#00f2fe') },
  { slug: 'carbon', name: 'Carbon', theme: modernTheme('Carbon', '#18181b', '#a1a1aa', '#52525b') },
  { slug: 'coral', name: 'Coral', theme: modernTheme('Coral', '#1a0a0a', '#ff6b6b', '#ff8e53') },
  { slug: 'ghost', name: 'Ghost', theme: sleekTheme('Ghost', '#f0f0f0', '#d0d0d0', '#d0d0d0') },
  { slug: 'midnight', name: 'Midnight', theme: sleekTheme('Midnight', '#0f172a', '#334155', '#334155') },
  { slug: 'smoke', name: 'Smoke', theme: sleekTheme('Smoke', '#2a2a2a', '#5a5a5a', '#5a5a5a') },
  { slug: 'minimal', name: 'Minimal', theme: modernTheme('Minimal', '#111111', '#ffffff', '#444444') },
];

const BUILTIN_THEME_MAP = BUILTIN_THEMES.reduce((acc, entry) => {
  acc[entry.slug] = entry;
  return acc;
}, {});

class ThemeManager {
  constructor(directory) {
    this.directory = directory;
  }

  _ensureDir() {
    fs.mkdirSync(this.directory, { recursive: true });
  }

  listCustom() {
    if (!fs.existsSync(this.directory)) return [];
    return fs.readdirSync(this.directory)
      .filter((file) => file.endsWith('.json'))
      .sort()
      .map((file) => {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(this.directory, file), 'utf8'));
          return {
            slug: file.replace(/\.json$/, ''),
            name: data.__name || file.replace(/\.json$/, ''),
            source: 'custom',
            readOnly: false,
          };
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean);
  }

  list() {
    const builtins = BUILTIN_THEMES.map((entry) => ({
      slug: entry.slug,
      name: entry.name,
      source: 'builtin',
      readOnly: true,
    }));
    return [...builtins, ...this.listCustom()];
  }

  readCustom(slug) {
    const file = path.join(this.directory, `${slug}.json`);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {
      return null;
    }
  }

  read(slug) {
    if (BUILTIN_THEME_MAP[slug]) return deepClone(BUILTIN_THEME_MAP[slug].theme);
    return this.readCustom(slug);
  }

  write(slug, name, theme) {
    this._ensureDir();
    const file = path.join(this.directory, `${slug}.json`);
    const payload = deepMerge(DEFAULT_THEME, { __name: name || slug, ...(theme || {}) });
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
    return file;
  }

  delete(slug) {
    if (BUILTIN_THEME_MAP[slug]) return false;
    const file = path.join(this.directory, `${slug}.json`);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      return true;
    }
    return false;
  }

  isBuiltin(slug) {
    return !!BUILTIN_THEME_MAP[slug];
  }
}

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasLegacyThemeFields(config) {
  if (!config || typeof config !== 'object') return false;
  const legacyKeys = [
    'bg', 'border', 'glow', 'scanlines', 'buttonStyle',
    'keycapShape', 'captionShape',
    'keycapTextColor', 'captionTextColor', 'captionBgColor', 'captionBorderColor',
  ];
  return legacyKeys.some((key) => key in config);
}

function applyLegacyShape(baseShape, override, roundedRadius, pillShape) {
  if (override === 'square') return { shape: 'square', cornerRadius: 0 };
  if (override === 'round') return { shape: pillShape, cornerRadius: 999 };
  return { shape: baseShape, cornerRadius: roundedRadius };
}

function buildLegacyTheme(config) {
  const bg = config.bg || '#ff2e9a';
  const border = config.border || '#00f0ff';
  const glow = config.glow || '#b967ff';
  const style = config.buttonStyle || 'vhs';
  const scanlines = !!config.scanlines;

  let theme = null;
  if (style === 'keycap') theme = mechanicalTheme('Migrated Keycap', bg, border, glow);
  else if (style === 'modern') theme = modernTheme('Migrated Modern', bg, border, glow);
  else if (style === 'sleek') theme = sleekTheme('Migrated Sleek', bg, border, config.captionBorderColor || border);
  else theme = vhsTheme('Migrated VHS', bg, border, glow, scanlines);

  const keyShape = applyLegacyShape(theme.keycap.shape, config.keycapShape, theme.keycap.cornerRadius, 'pill');
  const capShape = applyLegacyShape(theme.caption.shape, config.captionShape, theme.caption.cornerRadius, 'pill');

  theme.keycap.shape = keyShape.shape;
  theme.keycap.cornerRadius = keyShape.cornerRadius;
  theme.caption.shape = capShape.shape;
  theme.caption.cornerRadius = capShape.cornerRadius;

  if (config.keycapTextColor) theme.keycap.textColor = config.keycapTextColor;
  if (config.captionTextColor) theme.caption.textColor = config.captionTextColor;
  if (config.captionBgColor) theme.caption.fill = { type: 'solid', color: config.captionBgColor };
  if (config.captionBorderColor) {
    theme.caption.outline = {
      enabled: true,
      width: Math.max(1, Number(theme.caption.outline?.width) || 1),
      color: config.captionBorderColor,
    };
  }
  if (style !== 'vhs' && !scanlines) {
    theme.keycap.texture.type = 'none';
  }

  return theme;
}

function resolveTheme(theme) {
  return deepMerge(DEFAULT_THEME, theme || {});
}

function resolveConfigTheme(config, themeManager = new ThemeManager(CUSTOM_THEMES_DIR)) {
  if (isObject(config?.themeData)) {
    return resolveTheme(config.themeData);
  }
  const slug = sanitizeSlug(config?.theme || '');
  if (slug) {
    const existing = themeManager.read(slug);
    if (existing) return resolveTheme(existing);
  }
  if (hasLegacyThemeFields(config)) {
    return resolveTheme(buildLegacyTheme(config));
  }
  return resolveTheme(BUILTIN_THEME_MAP.keycap.theme);
}

function migrateLegacyConfig(config, themeManager = new ThemeManager(CUSTOM_THEMES_DIR)) {
  const next = { ...(config || {}) };
  if (next.themeData || !hasLegacyThemeFields(next)) {
    return { changed: false, config: next };
  }

  const theme = buildLegacyTheme(next);
  const baseSlug = sanitizeSlug(`migrated-${next.theme || 'theme'}`) || 'migrated-theme';
  let slug = baseSlug;
  let suffix = 2;
  while (themeManager.isBuiltin(slug) || themeManager.readCustom(slug)) {
    slug = `${baseSlug}-${suffix}`;
    suffix += 1;
  }

  themeManager.write(slug, theme.__name || 'Migrated Theme', theme);

  delete next.bg;
  delete next.border;
  delete next.glow;
  delete next.scanlines;
  delete next.buttonStyle;
  delete next.keycapShape;
  delete next.captionShape;
  delete next.keycapTextColor;
  delete next.captionTextColor;
  delete next.captionBgColor;
  delete next.captionBorderColor;

  next.theme = slug;
  next.themeData = null;

  return { changed: true, config: next };
}

module.exports = {
  CUSTOM_THEMES_DIR,
  DEFAULT_THEME,
  BUILTIN_THEMES,
  ThemeManager,
  sanitizeSlug,
  resolveTheme,
  resolveConfigTheme,
  migrateLegacyConfig,
};
