(function initThemeRuntime(global) {
  function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function deepMerge(base, incoming) {
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
      return incoming === undefined ? deepClone(base) : deepClone(incoming);
    }
    const output = Array.isArray(base) ? [...base] : { ...(base || {}) };
    Object.entries(incoming).forEach(([key, value]) => {
      const current = output[key];
      if (value && typeof value === 'object' && !Array.isArray(value) && current && typeof current === 'object' && !Array.isArray(current)) {
        output[key] = deepMerge(current, value);
      } else if (Array.isArray(value)) {
        output[key] = value.map((item) => deepClone(item));
      } else {
        output[key] = value;
      }
    });
    return output;
  }

  function clamp(value, min, max, fallback = min) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.max(min, Math.min(max, numeric));
  }

  function normalizeHex(hex, fallback = '#000000') {
    const raw = String(hex || '').trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{6}$/.test(raw)) return `#${raw.toLowerCase()}`;
    if (/^[0-9a-fA-F]{3}$/.test(raw)) return `#${raw.split('').map((char) => char + char).join('').toLowerCase()}`;
    const rgb = String(hex || '').trim().match(/^rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (rgb) {
      return `#${rgb.slice(1, 4).map((part) => clamp(part, 0, 255, 0).toString(16).padStart(2, '0')).join('')}`;
    }
    return fallback;
  }

  function mixHex(a, b, ratio = 0.5) {
    const left = normalizeHex(a, '#000000');
    const right = normalizeHex(b, '#000000');
    const t = clamp(ratio, 0, 1, 0.5);
    const mix = (start, end) => Math.round(start + ((end - start) * t));
    const lr = parseInt(left.slice(1, 3), 16);
    const lg = parseInt(left.slice(3, 5), 16);
    const lb = parseInt(left.slice(5, 7), 16);
    const rr = parseInt(right.slice(1, 3), 16);
    const rg = parseInt(right.slice(3, 5), 16);
    const rb = parseInt(right.slice(5, 7), 16);
    return `#${[mix(lr, rr), mix(lg, rg), mix(lb, rb)].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
  }

  function cssColorWithOpacity(color, opacity) {
    const normalized = normalizeHex(color, null);
    if (!normalized) {
      if (typeof color === 'string' && color.trim()) return color;
      return `rgba(0, 0, 0, ${opacity})`;
    }
    const raw = normalized.slice(1);
    const red = parseInt(raw.slice(0, 2), 16);
    const green = parseInt(raw.slice(2, 4), 16);
    const blue = parseInt(raw.slice(4, 6), 16);
    return `rgba(${red}, ${green}, ${blue}, ${clamp(opacity, 0, 1, 0)})`;
  }

  function ensureStops(fill, fallback = '#000000') {
    if (Array.isArray(fill?.stops) && fill.stops.length) {
      return fill.stops.map((stop, index) => ({
        color: stop.color || fallback,
        position: clamp(stop.position, 0, 100, index === 0 ? 0 : 100),
      }));
    }
    return [{ color: fill?.color || fallback, position: 0 }, { color: fill?.gradientTo || fill?.color || fallback, position: 100 }];
  }

  function getFillCss(fill) {
    if (typeof fill === 'string') return fill;
    if (!fill || typeof fill !== 'object') return '#000000';
    if (fill.type === 'solid') return fill.color || '#000000';
    const stops = ensureStops(fill, '#000000');
    const angle = clamp(fill.angle, 0, 360, 180);
    return `linear-gradient(${angle}deg, ${stops.map((stop) => `${stop.color} ${stop.position}%`).join(', ')})`;
  }

  function getFillRepresentativeColor(fill) {
    if (typeof fill === 'string') return fill;
    if (!fill || typeof fill !== 'object') return '#000000';
    if (fill.color) return fill.color;
    if (Array.isArray(fill.stops) && fill.stops.length) return fill.stops[0].color;
    return '#000000';
  }

  function defaultGeometry(kind) {
    return {
      shape: 'rounded',
      cornerRadius: kind === 'caption' ? 4 : 8,
      skewX: 0,
      paddingX: kind === 'caption' ? 8 : 16,
      paddingY: kind === 'caption' ? 2 : 8,
      textAlign: 'center-center',
      edgeTreatment: kind === 'caption' ? 'flat' : 'bevel',
    };
  }

  function defaultMaterial(kind) {
    return {
      preset: kind === 'caption' ? 'flat' : 'mechanical',
      fill: kind === 'caption'
        ? { type: 'solid', color: '#f5f3ec' }
        : {
          type: 'linear',
          angle: 180,
          stops: [
            { color: '#f5f3ec', position: 0 },
            { color: '#d6d2c6', position: 85 },
            { color: '#bcb7a8', position: 100 },
          ],
        },
      outline: { enabled: true, width: 1, color: 'rgba(0, 0, 0, 0.25)' },
      surfaceOpacity: 1,
    };
  }

  function defaultPattern() {
    return {
      type: 'none',
      color: '#000000',
      opacity: 0.18,
      density: 3,
      scale: 1,
      rotation: 0,
      gradientTo: '#000000',
    };
  }

  function defaultMotion(enter = 'glitch') {
    const reduced = ['slam', 'overshoot', 'glitch-burst', 'crt-smear', 'split-in', 'scan-in', 'flash-cut'].includes(enter)
      ? 'fade'
      : enter;
    return { enter, emphasis: 'none', exit: enter, reduced, speed: 1 };
  }

  function defaultAdornments() {
    return [];
  }

  function defaultTextEffect() {
    return {
      preset: 'none',
      intensity: 0.6,
    };
  }

  function defaultEffects(kind) {
    return kind === 'caption'
      ? [
        { type: 'stroke', color: 'rgba(0, 0, 0, 0.25)', width: 1, opacity: 1 },
      ]
      : [
        { type: 'stroke', color: 'rgba(0, 0, 0, 0.25)', width: 1, opacity: 1 },
        { type: 'bevel', opacity: 0.95, depth: 1 },
        { type: 'directional-shadow', color: '#000000', opacity: 0.32, x: 0, y: 4, blur: 6 },
      ];
  }

  function defaultFx() {
    return {
      enabled: false,
      preset: 'none',
      intensity: 'medium',
      speed: 1,
      colorMode: 'outline',
      colors: [],
    };
  }

  const FX_MIN_COLORS = 3;
  const FX_MAX_COLORS = 5;
  const TEXT_EFFECT_PRESETS = ['none', 'shadow', 'glow', 'outline', 'chromatic', 'retro'];

  const DEFAULT_THEME = {
    __name: 'Keycap',
    defaults: {
      fontWeight: 700,
      fontFamily: "'Menlo', 'Consolas', monospace",
      keycapScale: 1,
      captionScale: 1,
      captionPosition: 'above',
      fade: 'glitch',
      animationSpeed: 1,
      motion: defaultMotion('glitch'),
    },
    keycap: {
      textColor: '#222222',
      textShadow: 'none',
      textEffect: defaultTextEffect(),
      letterSpacing: 1.5,
      fontSize: 22,
      geometry: defaultGeometry('keycap'),
      material: defaultMaterial('keycap'),
      pattern: defaultPattern(),
      effects: defaultEffects('keycap'),
      fx: defaultFx(),
      adornments: defaultAdornments(),
      motion: defaultMotion('glitch'),
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
    },
    caption: {
      textColor: '#222222',
      textShadow: 'none',
      textEffect: defaultTextEffect(),
      letterSpacing: 2,
      fontSize: 16,
      geometry: defaultGeometry('caption'),
      material: defaultMaterial('caption'),
      pattern: defaultPattern(),
      effects: defaultEffects('caption'),
      fx: defaultFx(),
      adornments: defaultAdornments(),
      motion: defaultMotion('glitch'),
      glow: { enabled: false, color: '#c8c1b5', spread: 12, opacity: 0.18 },
      shadow: { enabled: false, surfaceOpacity: 1, dropOpacity: 0, layers: [] },
    },
  };

  function inferTextEffectFromLegacy(textShadow) {
    const raw = String(textShadow || '').trim();
    if (!raw || raw === 'none') return defaultTextEffect();
    const normalized = raw.toLowerCase();
    if (normalized.includes('-2px 0') && normalized.includes('2px 0')) {
      return { preset: 'chromatic', intensity: 0.85 };
    }
    if (normalized.includes('0 0') && normalized.includes('2px 2px 0')) {
      return { preset: 'retro', intensity: 0.75 };
    }
    if (normalized.includes('0 0')) {
      return { preset: 'glow', intensity: 0.65 };
    }
    return { preset: 'shadow', intensity: 0.5 };
  }

  function normalizeTextEffect(effect, legacyTextShadow) {
    const fallback = inferTextEffectFromLegacy(legacyTextShadow);
    const next = {
      ...defaultTextEffect(),
      ...fallback,
      ...((effect && typeof effect === 'object' && !Array.isArray(effect)) ? effect : {}),
    };
    next.preset = TEXT_EFFECT_PRESETS.includes(next.preset) ? next.preset : fallback.preset;
    next.intensity = clamp(next.intensity, 0, 1, fallback.intensity);
    return next;
  }

  function getTextEffectAccent(section) {
    const outline = normalizeHex(section?.outline?.color || section?.material?.outline?.color || '#7dd3fc', '#7dd3fc');
    const fill = normalizeHex(getFillRepresentativeColor(section?.fill || section?.material?.fill), '#1f2937');
    const pattern = normalizeHex(section?.pattern?.color || section?.texture?.color || mixHex(outline, '#ff4fd8', 0.78), outline);
    const glow = normalizeHex(section?.glow?.color || mixHex(outline, '#ffffff', 0.45), outline);
    const text = normalizeHex(section?.textColor || '#ffffff', '#ffffff');
    return {
      outline,
      fill,
      pattern,
      glow,
      text,
      secondary: mixHex(pattern, '#ff2ea6', 0.82),
    };
  }

  function buildTextShadowFromEffect(section, textEffect, fallbackTextShadow) {
    const effect = normalizeTextEffect(textEffect, fallbackTextShadow);
    if (effect.preset === 'none') return 'none';

    const accent = getTextEffectAccent(section);
    const t = clamp(effect.intensity, 0, 1, 0.6);
    if (effect.preset === 'shadow') {
      const offset = Math.max(1, Math.round(1 + (t * 4)));
      const blur = Math.round(t * 8);
      const alpha = (0.2 + (t * 0.45)).toFixed(3);
      return `${offset}px ${offset}px ${blur}px rgba(0, 0, 0, ${alpha})`;
    }
    if (effect.preset === 'glow') {
      const blurA = Math.round(3 + (t * 8));
      const blurB = Math.round(8 + (t * 16));
      const blurC = Math.round(16 + (t * 22));
      return `0 0 ${blurA}px ${cssColorWithOpacity(accent.text, 0.85)}, 0 0 ${blurB}px ${cssColorWithOpacity(accent.glow, 0.56 + (t * 0.22))}, 0 0 ${blurC}px ${cssColorWithOpacity(accent.outline, 0.18 + (t * 0.16))}`;
    }
    if (effect.preset === 'outline') {
      const spread = Math.max(1, Math.round(1 + (t * 2)));
      const color = cssColorWithOpacity(accent.outline, 0.82);
      return [
        `${spread}px 0 0 ${color}`,
        `-${spread}px 0 0 ${color}`,
        `0 ${spread}px 0 ${color}`,
        `0 -${spread}px 0 ${color}`,
      ].join(', ');
    }
    if (effect.preset === 'chromatic') {
      const split = Math.max(1, Math.round(1 + (t * 2)));
      const left = mixHex(accent.outline, '#4ef3ff', 0.35);
      const right = accent.secondary;
      return `0 0 1px ${cssColorWithOpacity(accent.text, 0.7)}, -${split}px 0 0 ${left}, ${split}px 0 0 ${right}`;
    }
    if (effect.preset === 'retro') {
      const split = Math.max(1, Math.round(1 + (t * 2)));
      const blur = Math.round(4 + (t * 6));
      return `0 0 ${blur}px ${cssColorWithOpacity(accent.outline, 0.68 + (t * 0.18))}, -${split}px 0 0 ${accent.outline}, ${split}px ${split}px 0 ${accent.secondary}`;
    }
    return fallbackTextShadow && fallbackTextShadow !== 'none' ? fallbackTextShadow : 'none';
  }

  function normalizeDefaults(defaults) {
    const motion = deepMerge(defaultMotion(defaults?.fade || 'glitch'), defaults?.motion || {});
    return {
      ...defaults,
      fontWeight: clamp(defaults?.fontWeight, 100, 900, 700),
      fontFamily: defaults?.fontFamily || "'Menlo', 'Consolas', monospace",
      keycapScale: clamp(defaults?.keycapScale, 0.3, 4, 1),
      captionScale: clamp(defaults?.captionScale, 0.3, 5, 1),
      captionPosition: defaults?.captionPosition === 'below' ? 'below' : 'above',
      fade: motion.enter || defaults?.fade || 'glitch',
      animationSpeed: clamp(motion.speed ?? defaults?.animationSpeed, 0.2, 3, 1),
      motion,
    };
  }

  function normalizePattern(pattern, texture) {
    const base = deepMerge(defaultPattern(), pattern || {});
    if (base.type === 'none' && texture && texture.type && texture.type !== 'none') {
      base.type = texture.type;
      base.color = texture.color || base.color;
      base.opacity = clamp(texture.opacity, 0, 1, base.opacity);
      base.density = clamp(texture.density, 1, 32, base.density);
      base.gradientTo = texture.gradientTo || base.gradientTo;
    }
    return {
      ...base,
      opacity: clamp(base.opacity, 0, 1, 0),
      density: clamp(base.density, 1, 40, 3),
      scale: clamp(base.scale, 0.05, 6, 1),
      rotation: clamp(base.rotation, 0, 360, 0),
    };
  }

  function normalizeFx(fx) {
    const next = deepMerge(defaultFx(), fx || {});
    next.preset = ['none', 'neon-pulse', 'rgb-chase', 'rgb-breathe', 'comic-electric', 'triangle-orbit', 'power-charge'].includes(next.preset) ? next.preset : 'none';
    next.intensity = ['low', 'medium', 'high'].includes(next.intensity) ? next.intensity : 'medium';
    next.speed = clamp(next.speed, 0.4, 2.4, 1);
    next.colorMode = ['outline', 'palette', 'custom'].includes(next.colorMode) ? next.colorMode : 'outline';
    next.colors = Array.isArray(next.colors)
      ? next.colors.slice(0, FX_MAX_COLORS).map((color) => normalizeHex(color, '#ffffff'))
      : [];
    while (next.colors.length < FX_MIN_COLORS) next.colors.push(next.colors[next.colors.length - 1] || '#ffffff');
    next.enabled = next.preset !== 'none' && (fx?.enabled !== undefined ? !!fx.enabled : true);
    if (next.preset === 'none') next.enabled = false;
    return next;
  }

  function getFxOutlineBehavior(fx) {
    const normalized = normalizeFx(fx);
    if (!normalized.enabled || normalized.preset === 'none') return 'keep';
    if (['neon-pulse', 'rgb-chase', 'rgb-breathe', 'power-charge'].includes(normalized.preset)) return 'replace';
    if (normalized.preset === 'comic-electric') return 'augment';
    return 'keep';
  }

  function effectFromLegacyGlow(glow) {
    if (!glow || glow.enabled === false || !glow.opacity) return [];
    return [{
      type: 'outer-glow',
      color: glow.color || '#ffffff',
      opacity: clamp(glow.opacity, 0, 1, 0.3),
      spread: clamp(glow.spread, 0, 100, 16),
    }];
  }

  function effectsFromLegacyShadow(shadow) {
    const layers = Array.isArray(shadow?.layers) ? shadow.layers : [];
    const surfaceOpacity = clamp(shadow?.surfaceOpacity, 0, 1, 1);
    const dropOpacity = clamp(shadow?.dropOpacity, 0, 1, layers.some((layer) => !layer.inset) ? 1 : 0);
    const effects = [];

    const insetLayers = layers.filter((layer) => layer.inset);
    if (insetLayers.length) {
      effects.push({
        type: 'legacy-surface',
        opacity: surfaceOpacity,
        layers: insetLayers.map((layer) => ({
          inset: true,
          x: Number(layer.x) || 0,
          y: Number(layer.y) || 0,
          blur: Number(layer.blur) || 0,
          spread: Number(layer.spread) || 0,
          color: layer.color || '#000000',
        })),
      });
    }

    layers.filter((layer) => !layer.inset).forEach((layer) => {
      effects.push({
        type: (Math.abs(Number(layer.x) || 0) > 1 || Math.abs(Number(layer.y) || 0) > 1) ? 'directional-shadow' : 'ambient-shadow',
        color: layer.color || '#000000',
        opacity: dropOpacity,
        x: Number(layer.x) || 0,
        y: Number(layer.y) || 0,
        blur: Number(layer.blur) || 0,
        spread: Number(layer.spread) || 0,
      });
    });
    return effects;
  }

  function deriveEffectsFromEdgeTreatment(geometry = {}, kind = 'keycap') {
    const edge = geometry.edgeTreatment || 'flat';
    if (edge === 'bevel') return [{ type: 'bevel', opacity: kind === 'caption' ? 0.5 : 0.72, depth: kind === 'caption' ? 1 : 2 }];
    if (edge === 'emboss') return [{ type: 'emboss', opacity: kind === 'caption' ? 0.5 : 0.72, depth: kind === 'caption' ? 1 : 2 }];
    if (edge === 'rim') return [{ type: 'rim-light', color: '#ffffff', opacity: kind === 'caption' ? 0.26 : 0.38, width: kind === 'caption' ? 1 : 2 }];
    if (edge === 'inset') return [{ type: 'inner-stroke', color: '#000000', opacity: kind === 'caption' ? 0.18 : 0.22, width: 1 }];
    return [];
  }

  function deriveGlowFromEffects(effects, fallbackColor) {
    const glow = effects.find((effect) => effect.type === 'outer-glow' || effect.type === 'halo');
    if (!glow) return { enabled: false, color: fallbackColor, spread: 0, opacity: 0 };
    return {
      enabled: true,
      color: glow.color || fallbackColor,
      spread: clamp(glow.spread, 0, 100, 16),
      opacity: clamp(glow.opacity, 0, 1, 0.3),
    };
  }

  function deriveShadowFromEffects(effects, legacyShadow = {}) {
    const surfaceLayers = [];
    const outerLayers = [];
    let surfaceOpacity = clamp(legacyShadow.surfaceOpacity, 0, 1, 1);
    let dropOpacity = clamp(legacyShadow.dropOpacity, 0, 1, 0);

    effects.forEach((effect) => {
      if (effect.type === 'legacy-surface' && Array.isArray(effect.layers)) {
        surfaceOpacity = clamp(effect.opacity, 0, 1, surfaceOpacity);
        effect.layers.forEach((layer) => surfaceLayers.push(deepClone(layer)));
      } else if (effect.type === 'inner-glow') {
        surfaceLayers.push({
          inset: true,
          x: 0,
          y: 0,
          blur: clamp(effect.spread, 0, 120, 12),
          spread: 0,
          color: cssColorWithOpacity(effect.color || '#ffffff', clamp(effect.opacity, 0, 1, 0.25)),
        });
      } else if (effect.type === 'inner-stroke' || effect.type === 'rim-light') {
        surfaceLayers.push({
          inset: true,
          x: 0,
          y: 0,
          blur: 0,
          spread: clamp(effect.width, 0, 16, 1),
          color: cssColorWithOpacity(effect.color || '#ffffff', clamp(effect.opacity, 0, 1, 0.5)),
        });
      } else if (effect.type === 'bevel' || effect.type === 'emboss') {
        const depth = clamp(effect.depth, 0, 12, 2);
        const opacity = clamp(effect.opacity, 0, 1, 0.6);
        surfaceLayers.push(
          { inset: true, x: 0, y: depth, blur: 0, spread: 0, color: cssColorWithOpacity('#000000', opacity * 0.18) },
          { inset: true, x: 0, y: -depth, blur: 0, spread: 0, color: cssColorWithOpacity('#ffffff', opacity * 0.32) },
        );
      } else if (effect.type === 'ambient-shadow' || effect.type === 'directional-shadow') {
        dropOpacity = Math.max(dropOpacity, clamp(effect.opacity, 0, 1, 0.2));
        outerLayers.push({
          x: Number(effect.x) || 0,
          y: Number(effect.y) || 0,
          blur: clamp(effect.blur, 0, 120, 8),
          spread: clamp(effect.spread, -32, 64, 0),
          color: effect.color || '#000000',
        });
      }
    });

    return {
      enabled: surfaceLayers.length > 0 || outerLayers.length > 0,
      surfaceOpacity,
      dropOpacity,
      dropEnabled: outerLayers.length > 0 && dropOpacity > 0,
      layers: [...surfaceLayers, ...outerLayers],
    };
  }

  function hasStructuredSection(section) {
    if (!section || typeof section !== 'object' || Array.isArray(section)) return false;
    return ['geometry', 'material', 'pattern', 'effects', 'fx', 'adornments', 'motion', 'textEffect'].some((key) => key in section);
  }

  function normalizeSection(section, kind, defaults) {
    const structured = hasStructuredSection(section);
    const geometry = deepMerge(defaultGeometry(kind), section?.geometry || {});
    const material = deepMerge(defaultMaterial(kind), section?.material || {});
    const pattern = normalizePattern(section?.pattern, section?.texture);
    const fx = normalizeFx(section?.fx);
    const textEffect = normalizeTextEffect(section?.textEffect, section?.textShadow);
    const rawEffects = Array.isArray(section?.effects) && section.effects.length
      ? section.effects.map((effect) => deepClone(effect))
      : [
        ...effectFromLegacyGlow(section?.glow),
        ...effectsFromLegacyShadow(section?.shadow),
      ];
    const effects = rawEffects.length ? rawEffects : deepClone(defaultEffects(kind));
    if (!effects.some((effect) => ['bevel', 'emboss', 'rim-light', 'inner-stroke'].includes(effect?.type))) {
      effects.push(...deriveEffectsFromEdgeTreatment(geometry, kind));
    }
    const adornments = [];
    const motion = deepMerge(defaultMotion(defaults.motion?.enter || defaults.fade || 'glitch'), section?.motion || {});

    const fill = deepClone(structured ? (material.fill || section?.fill) : (section?.fill || material.fill));
    const outline = structured
      ? deepClone(material.outline || section?.outline || defaultMaterial(kind).outline)
      : deepMerge(material.outline, section?.outline || {});
    const shadow = structured
      ? deriveShadowFromEffects(effects, section?.shadow)
      : (section?.shadow && Array.isArray(section.shadow.layers)
        ? deepMerge({ enabled: true, surfaceOpacity: 1, dropOpacity: 0, layers: [] }, section.shadow)
        : deriveShadowFromEffects(effects, section?.shadow));
    const glow = structured
      ? deriveGlowFromEffects(effects, outline.color || getFillRepresentativeColor(fill))
      : (section?.glow
        ? deepMerge({ enabled: false, color: getFillRepresentativeColor(fill), spread: 16, opacity: 0 }, section.glow)
        : deriveGlowFromEffects(effects, outline.color || getFillRepresentativeColor(fill)));

    return {
      ...section,
      geometry,
      material: { ...material, fill, outline },
      pattern,
      effects,
      fx,
      textEffect,
      adornments,
      motion,
      textColor: section?.textColor || '#ffffff',
      textShadow: buildTextShadowFromEffect({ ...section, fill, outline, pattern, glow }, textEffect, section?.textShadow),
      letterSpacing: Number(section?.letterSpacing ?? (kind === 'caption' ? 2 : 1.5)),
      fontSize: Number(section?.fontSize ?? (kind === 'caption' ? 16 : 22)),
      textAlign: section?.textAlign || geometry.textAlign,
      shape: geometry.shape,
      cornerRadius: geometry.cornerRadius,
      skewX: geometry.skewX,
      paddingX: geometry.paddingX,
      paddingY: geometry.paddingY,
      fill,
      outline,
      texture: {
        type: pattern.type,
        color: pattern.color,
        opacity: pattern.opacity,
        density: pattern.density,
        gradientTo: pattern.gradientTo || pattern.color,
      },
      opacity: clamp(structured ? material.surfaceOpacity : (material.surfaceOpacity ?? section?.opacity), 0, 1, 1),
      glow,
      shadow,
    };
  }

  function resolveTheme(theme) {
    const merged = deepMerge(DEFAULT_THEME, theme || {});
    merged.defaults = normalizeDefaults(merged.defaults);
    merged.keycap = normalizeSection(merged.keycap, 'keycap', merged.defaults);
    merged.caption = normalizeSection(merged.caption, 'caption', merged.defaults);
    return merged;
  }

  function getShapeCss(geometry) {
    const shape = geometry?.shape || 'rounded';
    const radius = `${clamp(geometry?.cornerRadius, 0, 999, 6)}px`;
    if (shape === 'square') return { borderRadius: '0', clipPath: 'none' };
    if (shape === 'rounded') return { borderRadius: radius, clipPath: 'none' };
    if (shape === 'pill' || shape === 'oval') return { borderRadius: '999px', clipPath: 'none' };
    const map = {
      rhombus: 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)',
      hex: 'polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)',
      octagon: 'polygon(30% 0%, 70% 0%, 100% 30%, 100% 70%, 70% 100%, 30% 100%, 0% 70%, 0% 30%)',
      chamfer: 'polygon(8% 0%, 92% 0%, 100% 8%, 100% 92%, 92% 100%, 8% 100%, 0% 92%, 0% 8%)',
      'notched-rect': 'polygon(0% 0%, 100% 0%, 100% 72%, 92% 100%, 0% 100%)',
      ticket: 'polygon(0% 0%, 100% 0%, 100% 28%, 94% 36%, 94% 64%, 100% 72%, 100% 100%, 0% 100%, 0% 72%, 6% 64%, 6% 36%, 0% 28%)',
      flag: 'polygon(0% 0%, 86% 0%, 100% 50%, 86% 100%, 0% 100%, 8% 50%)',
      tab: 'polygon(0% 12%, 14% 0%, 100% 0%, 100% 100%, 0% 100%)',
      banner: 'polygon(0% 0%, 100% 0%, 94% 50%, 100% 100%, 0% 100%, 6% 50%)',
      brace: 'polygon(0% 8%, 10% 0%, 90% 0%, 100% 8%, 94% 50%, 100% 92%, 90% 100%, 10% 100%, 0% 92%, 6% 50%)',
      'speech-pill': 'polygon(10% 0%, 100% 0%, 100% 76%, 46% 76%, 34% 100%, 38% 76%, 0% 76%, 0% 14%)',
      'double-plate': 'polygon(4% 0%, 100% 0%, 100% 88%, 96% 100%, 0% 100%, 0% 12%)',
    };
    return { borderRadius: shape === 'speech-pill' ? '18px' : '0', clipPath: map[shape] || 'none' };
  }

  function getShapeSkewAngle(geometry) {
    const shape = geometry?.shape || 'rounded';
    if (!['square', 'rounded'].includes(shape)) return '0deg';
    return `${clamp(geometry?.skewX, -30, 30, 0)}deg`;
  }

  function pctAdd(value, inset) {
    return inset > 0 ? `calc(${value}% + ${inset}px)` : `${value}%`;
  }

  function pctSub(value, inset) {
    return inset > 0 ? `calc(${value}% - ${inset}px)` : `${value}%`;
  }

  function getInnerShapeCss(geometry, inset) {
    const outer = getShapeCss(geometry);
    const shape = geometry?.shape || 'rounded';
    const amount = Math.max(0, Number(inset) || 0);
    if (amount <= 0) return outer;

    if (shape === 'square') return { borderRadius: '0', clipPath: `inset(${amount}px)` };
    if (shape === 'rounded') {
      const radius = Math.max(0, clamp(geometry?.cornerRadius, 0, 999, 6) - amount);
      return { borderRadius: `${radius}px`, clipPath: `inset(${amount}px round ${radius}px)` };
    }
    if (shape === 'pill' || shape === 'oval') return { borderRadius: '999px', clipPath: `inset(${amount}px round 999px)` };

    const polygonMap = {
      rhombus: `polygon(50% ${amount}px, calc(100% - ${amount}px) 50%, 50% calc(100% - ${amount}px), ${amount}px 50%)`,
      hex: `polygon(${pctAdd(25, amount)} ${amount}px, ${pctSub(75, amount)} ${amount}px, calc(100% - ${amount}px) 50%, ${pctSub(75, amount)} calc(100% - ${amount}px), ${pctAdd(25, amount)} calc(100% - ${amount}px), ${amount}px 50%)`,
      octagon: `polygon(${pctAdd(30, amount)} ${amount}px, ${pctSub(70, amount)} ${amount}px, calc(100% - ${amount}px) ${pctAdd(30, amount)}, calc(100% - ${amount}px) ${pctSub(70, amount)}, ${pctSub(70, amount)} calc(100% - ${amount}px), ${pctAdd(30, amount)} calc(100% - ${amount}px), ${amount}px ${pctSub(70, amount)}, ${amount}px ${pctAdd(30, amount)})`,
      chamfer: `polygon(${pctAdd(8, amount)} ${amount}px, ${pctSub(92, amount)} ${amount}px, calc(100% - ${amount}px) ${pctAdd(8, amount)}, calc(100% - ${amount}px) ${pctSub(92, amount)}, ${pctSub(92, amount)} calc(100% - ${amount}px), ${pctAdd(8, amount)} calc(100% - ${amount}px), ${amount}px ${pctSub(92, amount)}, ${amount}px ${pctAdd(8, amount)})`,
      'notched-rect': `polygon(${amount}px ${amount}px, calc(100% - ${amount}px) ${amount}px, calc(100% - ${amount}px) ${pctSub(72, amount)}, ${pctSub(92, amount)} calc(100% - ${amount}px), ${amount}px calc(100% - ${amount}px))`,
      ticket: `polygon(${amount}px ${amount}px, calc(100% - ${amount}px) ${amount}px, calc(100% - ${amount}px) ${pctSub(28, amount)}, ${pctSub(94, amount)} ${pctAdd(36, amount)}, ${pctSub(94, amount)} ${pctSub(64, amount)}, calc(100% - ${amount}px) ${pctAdd(72, amount)}, calc(100% - ${amount}px) calc(100% - ${amount}px), ${amount}px calc(100% - ${amount}px), ${amount}px ${pctAdd(72, amount)}, ${pctAdd(6, amount)} ${pctSub(64, amount)}, ${pctAdd(6, amount)} ${pctAdd(36, amount)}, ${amount}px ${pctSub(28, amount)})`,
      flag: `polygon(${amount}px ${amount}px, ${pctSub(86, amount)} ${amount}px, calc(100% - ${amount}px) 50%, ${pctSub(86, amount)} calc(100% - ${amount}px), ${amount}px calc(100% - ${amount}px), ${pctAdd(8, amount)} 50%)`,
      tab: `polygon(${amount}px ${pctAdd(12, amount)}, ${pctAdd(14, amount)} ${amount}px, calc(100% - ${amount}px) ${amount}px, calc(100% - ${amount}px) calc(100% - ${amount}px), ${amount}px calc(100% - ${amount}px))`,
      banner: `polygon(${amount}px ${amount}px, calc(100% - ${amount}px) ${amount}px, ${pctSub(94, amount)} 50%, calc(100% - ${amount}px) calc(100% - ${amount}px), ${amount}px calc(100% - ${amount}px), ${pctAdd(6, amount)} 50%)`,
      brace: `polygon(${amount}px ${pctAdd(8, amount)}, ${pctAdd(10, amount)} ${amount}px, ${pctSub(90, amount)} ${amount}px, calc(100% - ${amount}px) ${pctAdd(8, amount)}, ${pctSub(94, amount)} 50%, calc(100% - ${amount}px) ${pctSub(92, amount)}, ${pctSub(90, amount)} calc(100% - ${amount}px), ${pctAdd(10, amount)} calc(100% - ${amount}px), ${amount}px ${pctSub(92, amount)}, ${pctAdd(6, amount)} 50%)`,
      'speech-pill': `polygon(${pctAdd(10, amount)} ${amount}px, calc(100% - ${amount}px) ${amount}px, calc(100% - ${amount}px) ${pctSub(76, amount)}, ${pctSub(46, amount)} ${pctSub(76, amount)}, ${pctAdd(34, amount)} calc(100% - ${amount}px), ${pctAdd(38, amount)} ${pctSub(76, amount)}, ${amount}px ${pctSub(76, amount)}, ${amount}px ${pctAdd(14, amount)})`,
      'double-plate': `polygon(${pctAdd(4, amount)} ${amount}px, calc(100% - ${amount}px) ${amount}px, calc(100% - ${amount}px) ${pctSub(88, amount)}, ${pctSub(96, amount)} calc(100% - ${amount}px), ${amount}px calc(100% - ${amount}px), ${amount}px ${pctAdd(12, amount)})`,
    };

    return {
      borderRadius: outer.borderRadius,
      clipPath: polygonMap[shape] || outer.clipPath,
    };
  }

  function getPolygonShapePoints(shape) {
    const map = {
      rhombus: [
        { x: 0.5, y: 0 },
        { x: 1, y: 0.5 },
        { x: 0.5, y: 1 },
        { x: 0, y: 0.5 },
      ],
      hex: [
        { x: 0.25, y: 0 },
        { x: 0.75, y: 0 },
        { x: 1, y: 0.5 },
        { x: 0.75, y: 1 },
        { x: 0.25, y: 1 },
        { x: 0, y: 0.5 },
      ],
      octagon: [
        { x: 0.3, y: 0 },
        { x: 0.7, y: 0 },
        { x: 1, y: 0.3 },
        { x: 1, y: 0.7 },
        { x: 0.7, y: 1 },
        { x: 0.3, y: 1 },
        { x: 0, y: 0.7 },
        { x: 0, y: 0.3 },
      ],
      chamfer: [
        { x: 0.08, y: 0 },
        { x: 0.92, y: 0 },
        { x: 1, y: 0.08 },
        { x: 1, y: 0.92 },
        { x: 0.92, y: 1 },
        { x: 0.08, y: 1 },
        { x: 0, y: 0.92 },
        { x: 0, y: 0.08 },
      ],
      'notched-rect': [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 0.72 },
        { x: 0.92, y: 1 },
        { x: 0, y: 1 },
      ],
      ticket: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 0.28 },
        { x: 0.94, y: 0.36 },
        { x: 0.94, y: 0.64 },
        { x: 1, y: 0.72 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
        { x: 0, y: 0.72 },
        { x: 0.06, y: 0.64 },
        { x: 0.06, y: 0.36 },
        { x: 0, y: 0.28 },
      ],
      flag: [
        { x: 0, y: 0 },
        { x: 0.86, y: 0 },
        { x: 1, y: 0.5 },
        { x: 0.86, y: 1 },
        { x: 0, y: 1 },
        { x: 0.08, y: 0.5 },
      ],
      tab: [
        { x: 0, y: 0.12 },
        { x: 0.14, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ],
      banner: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 0.94, y: 0.5 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
        { x: 0.06, y: 0.5 },
      ],
      brace: [
        { x: 0, y: 0.08 },
        { x: 0.1, y: 0 },
        { x: 0.9, y: 0 },
        { x: 1, y: 0.08 },
        { x: 0.94, y: 0.5 },
        { x: 1, y: 0.92 },
        { x: 0.9, y: 1 },
        { x: 0.1, y: 1 },
        { x: 0, y: 0.92 },
        { x: 0.06, y: 0.5 },
      ],
      'speech-pill': [
        { x: 0.1, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 0.76 },
        { x: 0.46, y: 0.76 },
        { x: 0.34, y: 1 },
        { x: 0.38, y: 0.76 },
        { x: 0, y: 0.76 },
        { x: 0, y: 0.14 },
      ],
      'double-plate': [
        { x: 0.04, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 0.88 },
        { x: 0.96, y: 1 },
        { x: 0, y: 1 },
        { x: 0, y: 0.12 },
      ],
    };
    return map[shape] ? map[shape].map((point) => ({ ...point })) : null;
  }

  function isSupportedFxShape(shape) {
    if (shape === 'speech-pill') return false;
    if (['square', 'rounded', 'pill', 'oval'].includes(shape)) return true;
    return !!getPolygonShapePoints(shape);
  }

  function buildRoundedRectPath(left, top, width, height, radius) {
    const right = left + width;
    const bottom = top + height;
    const nextRadius = clamp(radius, 0, Math.min(width, height) / 2, 0);
    if (nextRadius <= 0) {
      return `M ${Number(left.toFixed(3))} ${Number(top.toFixed(3))} H ${Number(right.toFixed(3))} V ${Number(bottom.toFixed(3))} H ${Number(left.toFixed(3))} Z`;
    }
    return [
      `M ${Number((left + nextRadius).toFixed(3))} ${Number(top.toFixed(3))}`,
      `H ${Number((right - nextRadius).toFixed(3))}`,
      `Q ${Number(right.toFixed(3))} ${Number(top.toFixed(3))} ${Number(right.toFixed(3))} ${Number((top + nextRadius).toFixed(3))}`,
      `V ${Number((bottom - nextRadius).toFixed(3))}`,
      `Q ${Number(right.toFixed(3))} ${Number(bottom.toFixed(3))} ${Number((right - nextRadius).toFixed(3))} ${Number(bottom.toFixed(3))}`,
      `H ${Number((left + nextRadius).toFixed(3))}`,
      `Q ${Number(left.toFixed(3))} ${Number(bottom.toFixed(3))} ${Number(left.toFixed(3))} ${Number((bottom - nextRadius).toFixed(3))}`,
      `V ${Number((top + nextRadius).toFixed(3))}`,
      `Q ${Number(left.toFixed(3))} ${Number(top.toFixed(3))} ${Number((left + nextRadius).toFixed(3))} ${Number(top.toFixed(3))}`,
      'Z',
    ].join(' ');
  }

  function buildSvgPathFromPoints(points) {
    if (!Array.isArray(points) || points.length < 3) return null;
    return points.map((point, index) => {
      const x = Number(point.x.toFixed(3));
      const y = Number(point.y.toFixed(3));
      return `${index === 0 ? 'M' : 'L'} ${x} ${y}`;
    }).join(' ') + ' Z';
  }

  function buildKeycapSvgPath(geometry, width, height, pad = 0) {
    const shape = geometry?.shape || 'rounded';
    if (!isSupportedFxShape(shape)) return null;
    const boundsWidth = Math.max(0, Number(width) || 0);
    const boundsHeight = Math.max(0, Number(height) || 0);
    const offset = Math.max(0, Number(pad) || 0);
    if (!boundsWidth || !boundsHeight) return null;
    if (shape === 'square') return buildRoundedRectPath(offset, offset, boundsWidth, boundsHeight, 0);
    if (shape === 'rounded') return buildRoundedRectPath(offset, offset, boundsWidth, boundsHeight, clamp(geometry?.cornerRadius, 0, Math.min(boundsWidth, boundsHeight) / 2, 6));
    if (shape === 'pill' || shape === 'oval') return buildRoundedRectPath(offset, offset, boundsWidth, boundsHeight, Math.min(boundsWidth, boundsHeight) / 2);
    const polygonPoints = getPolygonShapePoints(shape);
    if (!polygonPoints) return null;
    return buildSvgPathFromPoints(polygonPoints.map((point) => ({
      x: offset + (point.x * boundsWidth),
      y: offset + (point.y * boundsHeight),
    })));
  }

  function polygonArea(points) {
    let area = 0;
    for (let index = 0; index < points.length; index += 1) {
      const current = points[index];
      const next = points[(index + 1) % points.length];
      area += (current.x * next.y) - (next.x * current.y);
    }
    return area / 2;
  }

  function isConvexPolygon(points) {
    if (!Array.isArray(points) || points.length < 3) return false;
    let sign = 0;
    for (let index = 0; index < points.length; index += 1) {
      const prev = points[(index + points.length - 1) % points.length];
      const current = points[index];
      const next = points[(index + 1) % points.length];
      const cross = ((current.x - prev.x) * (next.y - current.y)) - ((current.y - prev.y) * (next.x - current.x));
      if (Math.abs(cross) < 1e-6) continue;
      const currentSign = Math.sign(cross);
      if (!sign) {
        sign = currentSign;
      } else if (sign !== currentSign) {
        return false;
      }
    }
    return true;
  }

  function intersectLines(first, second) {
    const x1 = first.a.x;
    const y1 = first.a.y;
    const x2 = first.b.x;
    const y2 = first.b.y;
    const x3 = second.a.x;
    const y3 = second.a.y;
    const x4 = second.b.x;
    const y4 = second.b.y;
    const denominator = ((x1 - x2) * (y3 - y4)) - ((y1 - y2) * (x3 - x4));
    if (Math.abs(denominator) < 1e-6) return null;
    const determinant1 = (x1 * y2) - (y1 * x2);
    const determinant2 = (x3 * y4) - (y3 * x4);
    return {
      x: ((determinant1 * (x3 - x4)) - ((x1 - x2) * determinant2)) / denominator,
      y: ((determinant1 * (y3 - y4)) - ((y1 - y2) * determinant2)) / denominator,
    };
  }

  function getInsetEdge(point, next, inset, orientation) {
    const dx = next.x - point.x;
    const dy = next.y - point.y;
    const length = Math.hypot(dx, dy);
    if (!length) return null;
    const normal = orientation === 'cw'
      ? { x: dy / length, y: -dx / length }
      : { x: -dy / length, y: dx / length };
    return {
      a: { x: point.x + (normal.x * inset), y: point.y + (normal.y * inset) },
      b: { x: next.x + (normal.x * inset), y: next.y + (normal.y * inset) },
    };
  }

  function pointInsideHalfPlane(point, edge, orientation) {
    const cross = ((edge.b.x - edge.a.x) * (point.y - edge.a.y)) - ((edge.b.y - edge.a.y) * (point.x - edge.a.x));
    return orientation === 'cw' ? cross <= 0.01 : cross >= -0.01;
  }

  function clipPolygonAgainstHalfPlane(points, edge, orientation) {
    const clipped = [];
    for (let index = 0; index < points.length; index += 1) {
      const current = points[index];
      const next = points[(index + 1) % points.length];
      const currentInside = pointInsideHalfPlane(current, edge, orientation);
      const nextInside = pointInsideHalfPlane(next, edge, orientation);
      if (currentInside && nextInside) {
        clipped.push(next);
      } else if (currentInside && !nextInside) {
        const intersection = intersectLines({ a: current, b: next }, edge);
        if (intersection) clipped.push(intersection);
      } else if (!currentInside && nextInside) {
        const intersection = intersectLines({ a: current, b: next }, edge);
        if (intersection) clipped.push(intersection);
        clipped.push(next);
      }
    }
    return clipped;
  }

  function simplifyPolygon(points) {
    const simplified = [];
    points.forEach((point) => {
      const last = simplified[simplified.length - 1];
      if (!last || Math.hypot(point.x - last.x, point.y - last.y) > 0.05) {
        simplified.push(point);
      }
    });
    if (simplified.length > 1) {
      const first = simplified[0];
      const last = simplified[simplified.length - 1];
      if (Math.hypot(first.x - last.x, first.y - last.y) <= 0.05) simplified.pop();
    }
    return simplified;
  }

  function insetPolygon(points, inset) {
    if (!Array.isArray(points) || points.length < 3 || inset <= 0) return null;
    const orientation = polygonArea(points) < 0 ? 'cw' : 'ccw';
    const offsetEdges = points.map((point, index) => {
      const next = points[(index + 1) % points.length];
      return getInsetEdge(point, next, inset, orientation);
    });
    if (offsetEdges.some((edge) => !edge)) return null;
    const insetPoints = [];
    for (let index = 0; index < offsetEdges.length; index += 1) {
      const previousEdge = offsetEdges[(index + offsetEdges.length - 1) % offsetEdges.length];
      const currentEdge = offsetEdges[index];
      const intersection = intersectLines(previousEdge, currentEdge);
      if (!intersection || !Number.isFinite(intersection.x) || !Number.isFinite(intersection.y)) {
        return null;
      }
      insetPoints.push(intersection);
    }
    return insetPoints;
  }

  function insetPolygonByClipping(points, inset) {
    if (!Array.isArray(points) || points.length < 3 || inset <= 0) return null;
    const orientation = polygonArea(points) < 0 ? 'cw' : 'ccw';
    let clipped = points.map((point) => ({ ...point }));
    for (let index = 0; index < points.length; index += 1) {
      const edge = getInsetEdge(points[index], points[(index + 1) % points.length], inset, orientation);
      if (!edge) return null;
      clipped = clipPolygonAgainstHalfPlane(clipped, edge, orientation);
      clipped = simplifyPolygon(clipped);
      if (clipped.length < 3) return null;
    }
    return simplifyPolygon(clipped);
  }

  function formatPolygonClipPath(points) {
    return `polygon(${points.map((point) => `${Math.max(-2000, Math.min(4000, Number(point.x.toFixed(3))))}px ${Math.max(-2000, Math.min(4000, Number(point.y.toFixed(3))))}px`).join(', ')})`;
  }

  function getSpeechPillMetrics(width, height, inset = 0) {
    const boundsWidth = Math.max(0, Number(width) || 0);
    const boundsHeight = Math.max(0, Number(height) || 0);
    const amount = Math.max(0, Number(inset) || 0);
    if (boundsWidth <= (amount * 2) + 12 || boundsHeight <= (amount * 2) + 12) return null;

    const left = amount;
    const top = amount;
    const right = boundsWidth - amount;
    const bottom = boundsHeight - amount;
    const bubbleWidth = Math.max(20, right - left);
    const availableHeight = Math.max(20, bottom - top);
    const tailDepth = clamp(
      availableHeight * (amount > 0 ? 0.18 : 0.24),
      amount > 0 ? 2 : 6,
      amount > 0 ? 6 : 14,
    );
    const bubbleBottom = bottom - tailDepth;
    const bubbleHeight = Math.max(18, bubbleBottom - top);
    const radius = Math.max(6, Math.min(18, bubbleHeight * 0.46, bubbleWidth * 0.18));
    const rawTailWidth = bubbleWidth * (amount > 0 ? 0.14 : 0.18);
    const tailWidth = clamp(rawTailWidth, 10, 24, 14);
    const tailBaseLeft = left + Math.max(radius * 1.1, bubbleWidth * 0.28);
    const safeTailBaseLeft = Math.max(left + radius + 5, Math.min(tailBaseLeft, right - radius - tailWidth - 8));
    const safeTailBaseRight = safeTailBaseLeft + tailWidth;
    const tailTipX = safeTailBaseLeft + (tailWidth * 0.32);
    const tailTipY = bottom;
    if (bubbleBottom <= top + radius + 2) return null;

    return {
      left,
      top,
      right,
      bubbleBottom,
      radius,
      tailBaseLeft: safeTailBaseLeft,
      tailBaseRight: safeTailBaseRight,
      tailTipX,
      tailTipY,
    };
  }

  function buildSpeechPillClipPath(width, height, inset = 0) {
    const metrics = getSpeechPillMetrics(width, height, inset);
    if (!metrics) return null;
    const {
      left,
      top,
      right,
      bubbleBottom,
      radius,
      tailBaseLeft,
      tailBaseRight,
      tailTipX,
      tailTipY,
    } = metrics;

    return `path("M ${Number((left + radius).toFixed(3))} ${Number(top.toFixed(3))} H ${Number((right - radius).toFixed(3))} Q ${Number(right.toFixed(3))} ${Number(top.toFixed(3))} ${Number(right.toFixed(3))} ${Number((top + radius).toFixed(3))} V ${Number((bubbleBottom - radius).toFixed(3))} Q ${Number(right.toFixed(3))} ${Number(bubbleBottom.toFixed(3))} ${Number((right - radius).toFixed(3))} ${Number(bubbleBottom.toFixed(3))} H ${Number(tailBaseRight.toFixed(3))} L ${Number(tailTipX.toFixed(3))} ${Number(tailTipY.toFixed(3))} L ${Number(tailBaseLeft.toFixed(3))} ${Number(bubbleBottom.toFixed(3))} H ${Number((left + radius).toFixed(3))} Q ${Number(left.toFixed(3))} ${Number(bubbleBottom.toFixed(3))} ${Number(left.toFixed(3))} ${Number((bubbleBottom - radius).toFixed(3))} V ${Number((top + radius).toFixed(3))} Q ${Number(left.toFixed(3))} ${Number(top.toFixed(3))} ${Number((left + radius).toFixed(3))} ${Number(top.toFixed(3))} Z")`;
  }

  function getBespokeInsetPolygon(shape, width, height, inset) {
    const boundsWidth = Math.max(0, Number(width) || 0);
    const boundsHeight = Math.max(0, Number(height) || 0);
    const amount = Math.max(0, Number(inset) || 0);
    if (!boundsWidth || !boundsHeight || !amount) return null;
    const w = boundsWidth;
    const h = boundsHeight;
    const x = (ratio) => Number(((w * ratio) + amount).toFixed(3));
    const xr = (ratio) => Number(((w * ratio) - amount).toFixed(3));
    const y = (ratio) => Number(((h * ratio) + amount).toFixed(3));
    const yb = (ratio) => Number(((h * ratio) - amount).toFixed(3));
    const px = Number(amount.toFixed(3));
    const py = Number(amount.toFixed(3));
    const right = Number((w - amount).toFixed(3));
    const bottom = Number((h - amount).toFixed(3));

    const pointsByShape = {
      'notched-rect': [
        { x: px, y: py },
        { x: right, y: py },
        { x: right, y: yb(0.72) },
        { x: xr(0.92), y: bottom },
        { x: px, y: bottom },
      ],
      ticket: [
        { x: px, y: py },
        { x: right, y: py },
        { x: right, y: yb(0.28) },
        { x: xr(0.94), y: y(0.36) },
        { x: xr(0.94), y: yb(0.64) },
        { x: right, y: y(0.72) },
        { x: right, y: bottom },
        { x: px, y: bottom },
        { x: px, y: y(0.72) },
        { x: x(0.06), y: yb(0.64) },
        { x: x(0.06), y: y(0.36) },
        { x: px, y: yb(0.28) },
      ],
      flag: [
        { x: px, y: py },
        { x: xr(0.86), y: py },
        { x: right, y: Number((h * 0.5).toFixed(3)) },
        { x: xr(0.86), y: bottom },
        { x: px, y: bottom },
        { x: x(0.08), y: Number((h * 0.5).toFixed(3)) },
      ],
      tab: [
        { x: px, y: y(0.12) },
        { x: x(0.14), y: py },
        { x: right, y: py },
        { x: right, y: bottom },
        { x: px, y: bottom },
      ],
      banner: [
        { x: px, y: py },
        { x: right, y: py },
        { x: xr(0.94), y: Number((h * 0.5).toFixed(3)) },
        { x: right, y: bottom },
        { x: px, y: bottom },
        { x: x(0.06), y: Number((h * 0.5).toFixed(3)) },
      ],
      brace: [
        { x: px, y: y(0.08) },
        { x: x(0.10), y: py },
        { x: xr(0.90), y: py },
        { x: right, y: y(0.08) },
        { x: xr(0.94), y: Number((h * 0.5).toFixed(3)) },
        { x: right, y: yb(0.92) },
        { x: xr(0.90), y: bottom },
        { x: x(0.10), y: bottom },
        { x: px, y: yb(0.92) },
        { x: x(0.06), y: Number((h * 0.5).toFixed(3)) },
      ],
      'double-plate': [
        { x: x(0.04), y: py },
        { x: right, y: py },
        { x: right, y: yb(0.88) },
        { x: xr(0.96), y: bottom },
        { x: px, y: bottom },
        { x: px, y: y(0.12) },
      ],
    };

    const points = pointsByShape[shape];
    return Array.isArray(points) ? points : null;
  }

  function getDynamicInnerShapeCss(geometry, inset, width, height) {
    const shape = geometry?.shape || 'rounded';
    const amount = Math.max(0, Number(inset) || 0);
    const boundsWidth = Math.max(0, Number(width) || 0);
    const boundsHeight = Math.max(0, Number(height) || 0);
    if (amount <= 0 || boundsWidth <= 0 || boundsHeight <= 0) return null;
    if (shape === 'speech-pill') {
      const innerSpeechPath = buildSpeechPillClipPath(boundsWidth, boundsHeight, amount);
      return innerSpeechPath
        ? { borderRadius: '0', clipPath: innerSpeechPath }
        : null;
    }
    const bespokeInsetPoints = getBespokeInsetPolygon(shape, boundsWidth, boundsHeight, amount);
    if (bespokeInsetPoints?.length >= 3) {
      return {
        borderRadius: '0',
        clipPath: formatPolygonClipPath(bespokeInsetPoints),
      };
    }
    const polygonPoints = getPolygonShapePoints(shape);
    if (!polygonPoints) return null;
    const actualPoints = polygonPoints.map((point) => ({
      x: point.x * boundsWidth,
      y: point.y * boundsHeight,
    }));
    const originalArea = polygonArea(actualPoints);
    const convex = isConvexPolygon(actualPoints);
    const maxInset = Math.max(0.75, Math.min(boundsWidth, boundsHeight) * 0.32);
    let attempt = Math.min(amount, maxInset);

    while (attempt >= 0.5) {
      let insetPoints = convex ? insetPolygon(actualPoints, attempt) : insetPolygonByClipping(actualPoints, attempt);
      if ((!insetPoints || insetPoints.length < 3) && convex) {
        insetPoints = insetPolygonByClipping(actualPoints, attempt);
      }
      if (insetPoints && insetPoints.length >= 3) {
        const insetArea = polygonArea(insetPoints);
        if (Number.isFinite(insetArea) && Math.abs(insetArea) >= 1 && Math.sign(originalArea) === Math.sign(insetArea)) {
          return {
            borderRadius: '0',
            clipPath: formatPolygonClipPath(insetPoints),
          };
        }
      }
      attempt = Number((attempt * 0.84).toFixed(3));
    }

    return null;
  }

  function getAnchorCss(anchor) {
    const value = String(anchor || 'center-center').toLowerCase();
    const [verticalRaw, horizontalRaw] = value.includes('-') ? value.split('-') : ['center', 'center'];
    const vertical = verticalRaw === 'middle' ? 'center' : verticalRaw;
    const horizontal = horizontalRaw || 'center';
    return {
      alignItems: vertical === 'top' ? 'flex-start' : vertical === 'bottom' ? 'flex-end' : 'center',
      justifyContent: horizontal === 'left' ? 'flex-start' : horizontal === 'right' ? 'flex-end' : 'center',
      textAlign: horizontal === 'left' ? 'left' : horizontal === 'right' ? 'right' : 'center',
    };
  }

  function getAnchorPadding(anchor, paddingX, paddingY) {
    const value = String(anchor || 'center-center').toLowerCase();
    const [verticalRaw, horizontalRaw] = value.includes('-') ? value.split('-') : ['center', 'center'];
    const vertical = verticalRaw === 'middle' ? 'center' : verticalRaw;
    const horizontal = horizontalRaw || 'center';
    const baseX = Math.max(0, Number(paddingX) || 0);
    const baseY = Math.max(0, Number(paddingY) || 0);
    const minHorizontal = baseX * 0.3;
    const minVertical = baseY * 0.3;
    const totalHorizontal = baseX * 2;
    const totalVertical = baseY * 2;
    const left = horizontal === 'left'
      ? minHorizontal
      : horizontal === 'right'
        ? totalHorizontal - minHorizontal
        : baseX;
    const right = totalHorizontal - left;
    const top = vertical === 'top'
      ? minVertical
      : vertical === 'bottom'
        ? totalVertical - minVertical
        : baseY;
    const bottom = totalVertical - top;
    return {
      top: Number(top.toFixed(3)),
      right: Number(right.toFixed(3)),
      bottom: Number(bottom.toFixed(3)),
      left: Number(left.toFixed(3)),
    };
  }

  function getShadowCss(element) {
    const shadow = element.shadow || {};
    const layers = Array.isArray(shadow.layers) ? shadow.layers : [];
    const surfaceOpacity = clamp(shadow.surfaceOpacity, 0, 1, 1);
    const dropOpacity = clamp(shadow.dropOpacity, 0, 1, 0);
    const dropEnabled = shadow.dropEnabled !== undefined ? !!shadow.dropEnabled : dropOpacity > 0;
    const insetLayers = layers.filter((layer) => !!layer.inset);
    const outerLayers = layers.filter((layer) => !layer.inset);

    const surfaceShadow = insetLayers.length
      ? insetLayers.map((layer) => {
        const x = Number(layer.x) || 0;
        const y = Number(layer.y) || 0;
        const blur = Number(layer.blur) || 0;
        const spread = Number(layer.spread) || 0;
        return `inset ${x}px ${y}px ${blur}px ${spread}px ${cssColorWithOpacity(layer.color || '#000000', surfaceOpacity)}`;
      }).join(', ')
      : 'none';

    const dropShadow = dropEnabled && dropOpacity > 0 && outerLayers.length
      ? outerLayers.map((layer) => {
        const x = Number(layer.x) || 0;
        const y = Number(layer.y) || 0;
        const blur = Number(layer.blur) || 0;
        return `drop-shadow(${x}px ${y}px ${blur}px ${cssColorWithOpacity(layer.color || '#000000', dropOpacity)})`;
      }).join(' ')
      : 'none';

    return { surfaceShadow, dropShadow };
  }

  function getGlowCss(element) {
    const glow = element.glow || {};
    const opacity = clamp(glow.opacity, 0, 1, 0);
    const enabled = glow.enabled !== undefined ? !!glow.enabled : opacity > 0;
    if (!enabled || opacity <= 0) return 'none';
    return `0 0 ${clamp(glow.spread, 0, 120, 16)}px ${cssColorWithOpacity(glow.color || getFillRepresentativeColor(element.fill), opacity)}`;
  }

  function expandRadius(radius, amount) {
    if (!amount) return radius;
    if (radius === '0') return '0';
    if (radius === '999px') return radius;
    const match = /^(-?\d+(?:\.\d+)?)px$/.exec(String(radius || '0'));
    if (!match) return radius;
    return `${Math.max(0, Number(match[1]) + amount)}px`;
  }

  function materialLayerBundle(element) {
    const fill = element.fill || element.material?.fill || { type: 'solid', color: '#ffffff' };
    const preset = element.material?.preset || 'flat';
    const fillColor = normalizeHex(getFillRepresentativeColor(fill), '#ffffff');
    const darker = mixHex(fillColor, '#000000', 0.18);
    const darkest = mixHex(fillColor, '#000000', 0.36);
    const lighter = mixHex(fillColor, '#ffffff', 0.36);
    const brightest = mixHex(fillColor, '#ffffff', 0.72);
    const layers = [];
    const sizes = [];
    const positions = [];
    const repeats = [];
    const pushLayer = (layer, repeat = 'no-repeat', size = 'auto', position = '0 0') => {
      layers.push(layer);
      sizes.push(size);
      positions.push(position);
      repeats.push(repeat);
    };

    if (preset === 'glass') {
      pushLayer(
        `linear-gradient(180deg,
          ${brightest} 0%,
          ${mixHex(fillColor, '#ffffff', 0.64)} 8%,
          ${mixHex(fillColor, '#ffffff', 0.28)} 10%,
          ${mixHex(fillColor, '#ffffff', 0.44)} 24%,
          ${mixHex(fillColor, '#ffffff', 0.14)} 46%,
          ${fillColor} 64%,
          ${mixHex(fillColor, '#000000', 0.24)} 82%,
          ${darkest} 100%)`
      );
    } else if (preset === 'plastic') {
      pushLayer(
        `linear-gradient(180deg,
          ${mixHex(fillColor, '#ffffff', 0.58)} 0%,
          ${mixHex(fillColor, '#ffffff', 0.34)} 14%,
          ${mixHex(fillColor, '#ffffff', 0.18)} 34%,
          ${fillColor} 56%,
          ${mixHex(fillColor, '#000000', 0.12)} 76%,
          ${darker} 90%,
          ${darkest} 100%)`
      );
    } else if (preset === 'chrome') {
      pushLayer(
        `linear-gradient(180deg, ${brightest} 0%, ${darker} 12%, ${brightest} 28%, ${darkest} 46%, ${lighter} 64%, ${fillColor} 82%, ${brightest} 100%)`
      );
    } else if (preset === 'matte') {
      pushLayer(
        `linear-gradient(180deg, ${lighter} 0%, ${fillColor} 34%, ${darker} 100%)`
      );
    } else if (preset === 'paper') {
      pushLayer(
        `linear-gradient(180deg,
          ${mixHex(fillColor, '#fdfbf7', 0.26)} 0%,
          ${mixHex(fillColor, '#f4ead8', 0.18)} 18%,
          ${mixHex(fillColor, '#efe3cf', 0.1)} 52%,
          ${fillColor} 76%,
          ${mixHex(fillColor, '#a58e6d', 0.12)} 100%)`
      );
    } else if (preset === 'chalk') {
      pushLayer(
        `linear-gradient(180deg,
          ${mixHex(fillColor, '#f7f7f2', 0.34)} 0%,
          ${mixHex(fillColor, '#eceee8', 0.22)} 24%,
          ${mixHex(fillColor, '#d8ddd8', 0.12)} 54%,
          ${fillColor} 78%,
          ${mixHex(fillColor, '#65727c', 0.1)} 100%)`
      );
    } else if (preset === 'pixel') {
      pushLayer(
        `repeating-linear-gradient(180deg, ${lighter} 0 3px, ${fillColor} 3px 6px, ${darker} 6px 9px, ${fillColor} 9px 12px)`
      );
    } else if (preset === 'mechanical') {
      pushLayer(
        `linear-gradient(180deg, ${brightest} 0%, ${lighter} 20%, ${fillColor} 70%, ${darker} 100%)`
      );
    } else {
      pushLayer(getFillCss(fill));
    }

    return { layers, sizes, positions, repeats };
  }

  function getPatternCss(pattern) {
    const type = pattern?.type || 'none';
    if (type === 'none') return { layers: [], sizes: [], positions: [], repeats: [] };
    const color = cssColorWithOpacity(pattern.color || '#000000', clamp(pattern.opacity, 0, 1, 0.18));
    const soft = cssColorWithOpacity(pattern.color || '#000000', clamp(pattern.opacity, 0, 1, 0.18) * 0.5);
    const scale = clamp(pattern.scale, 0.05, 6, 1);
    const density = clamp(pattern.density, 1, 40, 3);
    const angle = clamp(pattern.rotation, 0, 360, 0);
    const step = Math.max(0.75, Number((density * 3.6 * scale).toFixed(2)));

    if (type === 'scanlines') {
      const lineWidth = Math.max(0.35, Number((step * 0.28).toFixed(2)));
      const gapStart = Math.max(0, Number((step - lineWidth).toFixed(2)));
      return {
        layers: [`repeating-linear-gradient(${angle}deg, transparent 0 ${gapStart}px, ${color} ${gapStart}px ${step}px)`],
        sizes: ['auto'],
        positions: ['0 0'],
        repeats: ['no-repeat'],
      };
    }
    if (type === 'dots') {
      const dot = Math.max(3, step);
      return {
        layers: [`radial-gradient(circle at center, ${color} 0 24%, transparent 26% 100%)`],
        sizes: [`${dot}px ${dot}px`],
        positions: ['0 0'],
        repeats: ['repeat'],
      };
    }
    if (type === 'halftone') {
      const half = Math.max(4, Number((step * 1.3).toFixed(2)));
      return {
        layers: [`radial-gradient(circle at center, ${color} 0 18%, transparent 20% 100%)`],
        sizes: [`${half}px ${half}px`],
        positions: ['0 0'],
        repeats: ['repeat'],
      };
    }
    if (type === 'gradient') {
      return {
        layers: [`linear-gradient(${angle}deg, transparent 0%, ${soft} 45%, ${color} 100%)`],
        sizes: ['auto'],
        positions: ['0 0'],
        repeats: ['no-repeat'],
      };
    }
    if (type === 'stripes') {
      return {
        layers: [`repeating-linear-gradient(${angle || 45}deg, transparent 0 ${step}px, ${color} ${step}px ${step * 2}px)`],
        sizes: ['auto'],
        positions: ['0 0'],
        repeats: ['no-repeat'],
      };
    }
    if (type === 'checker') {
      const size = Math.max(5, Number((step * 2).toFixed(2)));
      return {
        layers: [
          `linear-gradient(${angle || 45}deg, ${soft} 25%, transparent 25%, transparent 75%, ${soft} 75%)`,
          `linear-gradient(${angle || 45}deg, ${soft} 25%, transparent 25%, transparent 75%, ${soft} 75%)`,
        ],
        sizes: [`${size}px ${size}px`, `${size}px ${size}px`],
        positions: [`0 0`, `${size / 2}px ${size / 2}px`],
        repeats: ['repeat', 'repeat'],
      };
    }
    if (type === 'grid' || type === 'blueprint') {
      const major = Math.max(10, Number((step * 2.5).toFixed(2)));
      return {
        layers: [
          `linear-gradient(${angle}deg, ${color} 1px, transparent 1px)`,
          `linear-gradient(${(angle + 90) % 360}deg, ${color} 1px, transparent 1px)`,
          `linear-gradient(${angle}deg, ${cssColorWithOpacity(pattern.color || '#000000', clamp(pattern.opacity, 0, 1, 0.12))} 1px, transparent 1px)`,
          `linear-gradient(${(angle + 90) % 360}deg, ${cssColorWithOpacity(pattern.color || '#000000', clamp(pattern.opacity, 0, 1, 0.12))} 1px, transparent 1px)`,
        ],
        sizes: [`${step}px ${step}px`, `${step}px ${step}px`, `${major}px ${major}px`, `${major}px ${major}px`],
        positions: ['0 0', '0 0', '0 0', '0 0'],
        repeats: ['repeat', 'repeat', 'repeat', 'repeat'],
      };
    }
    if (type === 'grain' || type === 'paper-grain') {
      const grain = Math.max(10, Number((step * 2).toFixed(2)));
      return {
        layers: [
          `radial-gradient(circle at 18% 24%, ${soft} 0 12%, transparent 13%)`,
          `radial-gradient(circle at 74% 48%, ${color} 0 10%, transparent 11%)`,
          `radial-gradient(circle at 42% 78%, ${soft} 0 12%, transparent 13%)`,
        ],
        sizes: [`${grain}px ${grain}px`, `${grain * 1.2}px ${grain * 1.2}px`, `${grain * 0.9}px ${grain * 0.9}px`],
        positions: ['0 0', '0 0', '0 0'],
        repeats: ['repeat', 'repeat', 'repeat'],
      };
    }
    if (type === 'dither') {
      const size = Math.max(6, step);
      return {
        layers: [
          `radial-gradient(circle at 25% 25%, ${color} 0 16%, transparent 17%)`,
          `radial-gradient(circle at 75% 75%, ${soft} 0 16%, transparent 17%)`,
        ],
        sizes: [`${size}px ${size}px`, `${size}px ${size}px`],
        positions: ['0 0', `${size / 2}px ${size / 2}px`],
        repeats: ['repeat', 'repeat'],
      };
    }
    if (type === 'contour') {
      return {
        layers: [
          `repeating-radial-gradient(circle at 20% 20%, transparent 0 ${step}px, ${soft} ${step}px ${step + 1}px)`,
          `repeating-radial-gradient(circle at 80% 70%, transparent 0 ${step * 1.3}px, ${color} ${step * 1.3}px ${step * 1.3 + 1}px)`,
        ],
        sizes: ['auto', 'auto'],
        positions: ['0 0', '0 0'],
        repeats: ['no-repeat', 'no-repeat'],
      };
    }
    return { layers: [], sizes: [], positions: [], repeats: [] };
  }

  function getAdornmentCss(adornments) {
    return { layers: [], sizes: [], positions: [], repeats: [] };
  }

  function getSpecialEffectCss(effects) {
    const layers = [];
    const sizes = [];
    const positions = [];
    const repeats = [];
    effects.forEach((effect) => {
      if (effect.type === 'reflection') {
        const alpha = clamp(effect.opacity, 0, 1, 0.22);
        layers.push(`linear-gradient(${clamp(effect.angle, 0, 360, 180)}deg, rgba(255,255,255,${alpha}) 0%, rgba(255,255,255,0) 45%)`);
        sizes.push('auto');
        positions.push('0 0');
        repeats.push('no-repeat');
      } else if (effect.type === 'sheen') {
        const alpha = clamp(effect.opacity, 0, 1, 0.16);
        layers.push(`linear-gradient(${clamp(effect.angle, 0, 360, 115)}deg, transparent 25%, rgba(255,255,255,${alpha}) 48%, transparent 72%)`);
        sizes.push(`${clamp(effect.width, 40, 220, 120)}% 100%`);
        positions.push('-30% 0');
        repeats.push('no-repeat');
      } else if (effect.type === 'inner-glow') {
        layers.push(`radial-gradient(circle at center, ${cssColorWithOpacity(effect.color || '#ffffff', clamp(effect.opacity, 0, 1, 0.2))} 0%, transparent ${clamp(effect.spread, 12, 120, 40)}%)`);
        sizes.push('auto');
        positions.push('center center');
        repeats.push('no-repeat');
      }
    });
    return { layers, sizes, positions, repeats };
  }

  function getElementCss(element, defaults, kind = 'keycap') {
    const shape = getShapeCss(element.geometry);
    const anchor = getAnchorCss(element.textAlign || element.geometry?.textAlign);
    const anchorPadding = getAnchorPadding(
      element.textAlign || element.geometry?.textAlign,
      Number(element.paddingX ?? element.geometry?.paddingX ?? 16),
      Number(element.paddingY ?? element.geometry?.paddingY ?? 8),
    );
    const shadow = getShadowCss(element);
    const glow = getGlowCss(element);
    const material = materialLayerBundle(element);
    const pattern = getPatternCss(element.pattern);
    const adornments = getAdornmentCss(element.adornments);
    const specialEffects = getSpecialEffectCss(element.effects || []);
    const outline = element.outline || {};
    const outlineBehavior = getFxOutlineBehavior(element.fx);
    const actualOutlineWidth = outline.enabled ? clamp(outline.width, 0, 16, 0) : 0;
    const renderOutlineWidth = outlineBehavior === 'replace' ? 0 : actualOutlineWidth;
    const outerBackground = renderOutlineWidth > 0 ? (outline.color || '#000000') : 'transparent';
    const backgroundLayers = [...specialEffects.layers, ...adornments.layers, ...pattern.layers, ...material.layers];
    const backgroundSizes = [...specialEffects.sizes, ...adornments.sizes, ...pattern.sizes, ...material.sizes];
    const backgroundPositions = [...specialEffects.positions, ...adornments.positions, ...pattern.positions, ...material.positions];
    const backgroundRepeats = [...specialEffects.repeats, ...adornments.repeats, ...pattern.repeats, ...material.repeats];
    const beforeLayers = [outerBackground];
    const beforeSizes = ['auto'];
    const beforePositions = ['0 0'];
    const beforeRepeats = ['no-repeat'];
    const innerShape = getInnerShapeCss(element.geometry, renderOutlineWidth);
    const textScale = kind === 'caption'
      ? clamp(defaults.captionScale, 0.3, 5, 1)
      : clamp(defaults.keycapScale, 0.3, 4, 1);
    const baseFontSize = Number(element.fontSize ?? 18);

    return {
      skewAngle: getShapeSkewAngle(element.geometry),
      color: element.textColor || '#ffffff',
      textShadow: element.textShadow || 'none',
      letterSpacing: `${Number(element.letterSpacing ?? 2)}px`,
      fontSize: `${Number((baseFontSize * textScale).toFixed(3))}px`,
      fontWeight: Number(defaults.fontWeight ?? 700),
      fontFamily: defaults.fontFamily || "'Menlo', 'Consolas', monospace",
      textAlign: anchor.textAlign,
      alignItems: anchor.alignItems,
      justifyContent: anchor.justifyContent,
      paddingTop: `${anchorPadding.top}px`,
      paddingRight: `${anchorPadding.right}px`,
      paddingBottom: `${anchorPadding.bottom}px`,
      paddingLeft: `${anchorPadding.left}px`,
      opacity: '1',
      fillOpacity: String(clamp(element.opacity ?? element.material?.surfaceOpacity, 0, 1, 1)),
      fillBackground: backgroundLayers.join(', ') || getFillCss(element.fill),
      fillBackgroundLayers: backgroundLayers,
      fillBackgroundSize: backgroundSizes.join(', '),
      fillBackgroundPosition: backgroundPositions.join(', '),
      fillBackgroundRepeat: backgroundRepeats.join(', '),
      fillInset: '0px',
      fillClipPath: innerShape.clipPath,
      fillBorderRadius: innerShape.borderRadius,
      outlineWidth: `${renderOutlineWidth}px`,
      outlineColor: outline.color || '#000000',
      outerOpacity: String(clamp(element.opacity ?? element.material?.surfaceOpacity, 0, 1, 1)),
      borderRadius: shape.borderRadius,
      clipPath: shape.clipPath,
      outerBackground: beforeLayers.join(', '),
      outerBackgroundSize: beforeSizes.join(', '),
      outerBackgroundPosition: beforePositions.join(', '),
      outerBackgroundRepeat: beforeRepeats.join(', '),
      surfaceShadow: shadow.surfaceShadow,
      dropShadow: shadow.dropShadow,
      outerGlowShadow: renderOutlineWidth > 0 ? glow : 'none',
      glowShadow: renderOutlineWidth > 0 ? 'none' : glow,
    };
  }

  function compileCssBlock(selector, style) {
    return `${selector}{--theme-skew-angle:${style.skewAngle};background:transparent;color:${style.color};text-shadow:${style.textShadow};letter-spacing:${style.letterSpacing};font-size:${style.fontSize};font-weight:${style.fontWeight};font-family:${style.fontFamily};text-align:${style.textAlign};display:inline-flex;align-items:${style.alignItems};justify-content:${style.justifyContent};padding-top:${style.paddingTop};padding-right:${style.paddingRight};padding-bottom:${style.paddingBottom};padding-left:${style.paddingLeft};opacity:${style.opacity};border:none;border-radius:${style.borderRadius};box-shadow:none;filter:${style.dropShadow};z-index:0;overflow:visible;}`;
  }

  function compileOuterBlock(selector, style) {
    const size = style.outerBackgroundSize ? `background-size:${style.outerBackgroundSize};` : '';
    const position = style.outerBackgroundPosition ? `background-position:${style.outerBackgroundPosition};background-repeat:${style.outerBackgroundRepeat || 'no-repeat'};` : '';
    const boxShadow = style.outerGlowShadow && style.outerGlowShadow !== 'none' ? `box-shadow:${style.outerGlowShadow};` : 'box-shadow:none;';
    return `${selector}::before{content:'';display:block !important;position:absolute;inset:0;background:${style.outerBackground};opacity:${style.outerOpacity};${size}${position}border-radius:var(--theme-border-radius, ${style.borderRadius});clip-path:var(--theme-clip-path, ${style.clipPath});${boxShadow}pointer-events:none;z-index:-2;transform:skewX(var(--theme-skew-angle, 0deg));transform-origin:center;}`;
  }

  function compileInnerBlock(selector, style) {
    const size = style.fillBackgroundSize ? `background-size:${style.fillBackgroundSize};` : '';
    const position = style.fillBackgroundPosition ? `background-position:${style.fillBackgroundPosition};background-repeat:${style.fillBackgroundRepeat || 'no-repeat'};` : '';
    const boxShadow = [style.surfaceShadow, style.glowShadow].filter((value) => value && value !== 'none').join(', ') || 'none';
    const fillRadius = style.fillBorderRadius || style.borderRadius;
    const fillClipPath = style.fillClipPath || style.clipPath;
    return `${selector}::after{content:'';display:block !important;position:absolute;inset:${style.fillInset};background:${style.fillBackground};opacity:${style.fillOpacity};border:none;border-radius:var(--theme-fill-border-radius, ${fillRadius});clip-path:var(--theme-fill-clip-path, ${fillClipPath});box-shadow:${boxShadow};pointer-events:none;${size}${position}z-index:-1;transform:skewX(var(--theme-skew-angle, 0deg));transform-origin:center;}`;
  }

  function compileThemeCss(theme, selectors) {
    const resolved = resolveTheme(theme);
    const keycapStyle = getElementCss(resolved.keycap, resolved.defaults, 'keycap');
    const captionStyle = getElementCss(resolved.caption, resolved.defaults, 'caption');
    return [
      compileCssBlock(selectors.keycap, keycapStyle),
      compileOuterBlock(selectors.keycap, keycapStyle),
      compileInnerBlock(selectors.keycap, keycapStyle),
      compileCssBlock(selectors.caption, captionStyle),
      compileOuterBlock(selectors.caption, captionStyle),
      compileInnerBlock(selectors.caption, captionStyle),
    ].join('\n');
  }

  function applyThemeCss(styleElement, theme, selectors) {
    if (!styleElement) return;
    styleElement.textContent = compileThemeCss(theme, selectors);
    syncThemeMetrics(theme, selectors);
  }

  function getScopedNodes(root, selector) {
    if (!selector) return [];
    const scope = root && typeof root.querySelectorAll === 'function' ? root : document;
    const nodes = Array.from(scope.querySelectorAll(selector));
    if (scope !== document && typeof scope.matches === 'function' && scope.matches(selector)) {
      nodes.unshift(scope);
    }
    return nodes;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';

  function createSvgNode(tag, attrs = {}) {
    const node = document.createElementNS(SVG_NS, tag);
    Object.entries(attrs).forEach(([key, value]) => {
      if (value === undefined || value === null) return;
      node.setAttribute(key, String(value));
    });
    return node;
  }

  let fxIdCounter = 0;

  function nextFxId(prefix = 'fx') {
    fxIdCounter += 1;
    return `theme-${prefix}-${fxIdCounter}`;
  }

  function prefersReducedMotion() {
    try {
      return !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (_error) {
      return false;
    }
  }

  function getFxIntensityScale(intensity) {
    if (intensity === 'high') return 1.3;
    if (intensity === 'low') return 0.82;
    return 1;
  }

  function getFxColors(section, fx) {
    const outline = normalizeHex(section?.outline?.color || section?.material?.outline?.color || '#4ef3ff', '#4ef3ff');
    const pattern = normalizeHex(section?.pattern?.color || section?.texture?.color || mixHex(outline, '#7dd3fc', 0.45), outline);
    const glow = normalizeHex(section?.glow?.color || mixHex(outline, '#ffffff', 0.24), outline);
    const custom = Array.isArray(fx?.colors)
      ? fx.colors.filter(Boolean).map((color) => normalizeHex(color, outline))
      : [];

    if (fx?.colorMode === 'custom' && custom.length) {
      while (custom.length < FX_MIN_COLORS) custom.push(custom[custom.length - 1] || outline);
      return custom.slice(0, FX_MAX_COLORS);
    }

    if (fx?.preset === 'neon-pulse') {
      if (fx?.colorMode === 'palette') return [outline, pattern, glow];
      return [outline, mixHex(outline, '#ffffff', 0.35), glow];
    }

    if (fx?.colorMode === 'palette') return [outline, pattern, glow];

    return [
      mixHex(outline, '#ff4fd8', 0.58),
      mixHex(outline, '#4ef3ff', 0.24),
      mixHex(outline, '#a9ff52', 0.5),
    ];
  }

  function removeKeycapFxLayer(node) {
    if (!node) return;
    Array.from(node.children || []).forEach((child) => {
      if (child.classList && child.classList.contains('theme-keycap-fx-layer')) child.remove();
    });
  }

  function getOrCreateKeycapFxLayer(node) {
    if (!node) return null;
    const existing = Array.from(node.children || []).find((child) => child.classList && child.classList.contains('theme-keycap-fx-layer'));
    if (existing) return existing;
    const svg = createSvgNode('svg', {
      'aria-hidden': 'true',
      focusable: 'false',
    });
    svg.classList.add('theme-keycap-fx-layer');
    node.insertBefore(svg, node.firstChild || null);
    return svg;
  }

  function appendFxPath(parent, className, attributes) {
    const path = createSvgNode('path', {
      fill: 'none',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      ...attributes,
    });
    className.split(' ').filter(Boolean).forEach((name) => path.classList.add(name));
    parent.appendChild(path);
    return path;
  }

  function appendFxPolygon(parent, className, points, attributes = {}) {
    const polygon = createSvgNode('polygon', {
      points: points.map((point) => `${Number(point.x.toFixed(3))},${Number(point.y.toFixed(3))}`).join(' '),
      ...attributes,
    });
    className.split(' ').filter(Boolean).forEach((name) => polygon.classList.add(name));
    parent.appendChild(polygon);
    return polygon;
  }

  function appendGradientStop(gradient, offset, color, opacity = 1) {
    gradient.appendChild(createSvgNode('stop', {
      offset: `${offset}%`,
      'stop-color': color,
      'stop-opacity': opacity,
    }));
  }

  function getRgbRingGradientStops(colors) {
    const palette = Array.isArray(colors) && colors.length ? colors : ['#ffffff', '#ffffff', '#ffffff'];
    const count = palette.length;
    const stops = [];
    for (let index = 0; index < count; index += 1) {
      const current = palette[index];
      const next = palette[(index + 1) % count];
      const segment = 100 / count;
      const start = index * segment;
      stops.push([Number(start.toFixed(3)), current]);
      stops.push([Number((start + (segment * 0.24)).toFixed(3)), mixHex(current, next, 0.16)]);
      stops.push([Number((start + (segment * 0.46)).toFixed(3)), mixHex(current, next, 0.38)]);
      stops.push([Number((start + (segment * 0.68)).toFixed(3)), mixHex(current, next, 0.62)]);
      stops.push([Number((start + (segment * 0.88)).toFixed(3)), mixHex(current, next, 0.82)]);
    }
    stops.push([100, palette[0]]);
    return stops;
  }

  function createFxGradient(svg, prefix, colors, width, height, speed, { reduced = false, clockwise = true, style = 'default' } = {}) {
    const defs = svg.querySelector('defs') || createSvgNode('defs');
    if (!defs.parentNode) svg.appendChild(defs);
    const gradientId = nextFxId(prefix);
    const centerX = Number((width / 2).toFixed(3));
    const centerY = Number((height / 2).toFixed(3));
    const span = Math.max(width, height);
    const gradient = createSvgNode('linearGradient', {
      id: gradientId,
      gradientUnits: 'userSpaceOnUse',
      x1: Number((centerX - (span * 0.72)).toFixed(3)),
      y1: Number((centerY - (span * 0.24)).toFixed(3)),
      x2: Number((centerX + (span * 0.72)).toFixed(3)),
      y2: Number((centerY + (span * 0.24)).toFixed(3)),
    });
    const palette = Array.isArray(colors) && colors.length ? colors : ['#ffffff', '#ffffff', '#ffffff'];
    const stops = style === 'rgb-ring'
      ? getRgbRingGradientStops(palette)
      : (() => {
        const nextStops = [];
        const count = palette.length;
        for (let index = 0; index < count; index += 1) {
          const current = palette[index];
          const nextColor = palette[(index + 1) % count];
          const start = (index / count) * 100;
          const middle = start + (50 / count);
          nextStops.push([Number(start.toFixed(3)), current]);
          nextStops.push([Number(middle.toFixed(3)), mixHex(current, nextColor, 0.5)]);
        }
        nextStops.push([100, palette[0]]);
        return nextStops;
      })();
    stops.forEach(([offset, color]) => appendGradientStop(gradient, offset, color, 1));
    if (!reduced) {
      gradient.appendChild(createSvgNode('animateTransform', {
        attributeName: 'gradientTransform',
        type: 'rotate',
        from: `0 ${centerX} ${centerY}`,
        to: `${clockwise ? 360 : -360} ${centerX} ${centerY}`,
        dur: `${((style === 'rgb-ring' ? 2.15 : 2.8) / speed).toFixed(2)}s`,
        repeatCount: 'indefinite',
      }));
    }
    defs.appendChild(gradient);
    return `url(#${gradientId})`;
  }

  function getFxStrokeBase(section) {
    const outlineWidth = section?.outline?.enabled
      ? clamp(section?.outline?.width, 0, 16, 0)
      : clamp(section?.material?.outline?.width, 0, 16, 0);
    return Math.max(1.2, 1 + (outlineWidth * 0.82));
  }

  function buildNeonPulseFx(svg, pathData, colors, intensityScale, speed, strokeBase) {
    const duration = (2.9 / speed).toFixed(2);
    const strokeWidth = (strokeBase * (1 + (0.22 * intensityScale))).toFixed(2);
    const haloWidth = (strokeBase * (2.8 + (0.85 * intensityScale))).toFixed(2);
    const accentWidth = Math.max(0.95, strokeBase * 0.56).toFixed(2);
    appendFxPath(svg, 'theme-keycap-fx-halo theme-keycap-fx-neon-halo', {
      d: pathData,
      stroke: colors[0],
      'stroke-width': haloWidth,
      opacity: 0.52,
      style: `filter:blur(${Math.max(2.4, strokeBase * (1.5 + (0.55 * intensityScale))).toFixed(2)}px);animation-duration:${duration}s;`,
    });
    appendFxPath(svg, 'theme-keycap-fx-halo theme-keycap-fx-neon-halo theme-keycap-fx-neon-accent', {
      d: pathData,
      stroke: colors[1],
      'stroke-width': (Number(haloWidth) * 0.72).toFixed(2),
      opacity: 0.24,
      style: `filter:blur(${Math.max(1.8, strokeBase * (1.05 + (0.4 * intensityScale))).toFixed(2)}px);animation-duration:${(2.2 / speed).toFixed(2)}s;animation-delay:-0.8s;`,
    });
    appendFxPath(svg, 'theme-keycap-fx-stroke theme-keycap-fx-neon-stroke', {
      d: pathData,
      stroke: colors[0],
      'stroke-width': strokeWidth,
      opacity: 0.95,
      style: `animation-duration:${duration}s;`,
    });
    appendFxPath(svg, 'theme-keycap-fx-stroke theme-keycap-fx-neon-trace', {
      d: pathData,
      stroke: colors[1],
      'stroke-width': accentWidth,
      opacity: 0.65,
      style: `animation-duration:${(2.4 / speed).toFixed(2)}s;animation-delay:-1.05s;`,
    });
  }

  function buildRgbChaseFx(svg, pathData, colors, intensityScale, speed, viewWidth, viewHeight, strokeBase) {
    const reduced = prefersReducedMotion();
    const strokeWidth = (strokeBase * (0.96 + (0.14 * intensityScale))).toFixed(2);
    const haloWidth = (strokeBase * (2.55 + (0.7 * intensityScale))).toFixed(2);
    const ringStroke = createFxGradient(svg, 'rgb-ring', colors, viewWidth, viewHeight, speed, { reduced, clockwise: true, style: 'rgb-ring' });
    const haloStroke = createFxGradient(
      svg,
      'rgb-halo',
      [
        mixHex(colors[0], colors[1], 0.42),
        mixHex(colors[1], colors[2], 0.42),
        mixHex(colors[2], colors[0], 0.42),
      ],
      viewWidth,
      viewHeight,
      speed * 0.8,
      { reduced, clockwise: false, style: 'rgb-ring' },
    );
    appendFxPath(svg, 'theme-keycap-fx-halo theme-keycap-fx-rgb-halo', {
      d: pathData,
      stroke: haloStroke,
      'stroke-width': haloWidth,
      opacity: 0.38,
      style: `filter:blur(${Math.max(2.1, strokeBase * (1.25 + (0.42 * intensityScale))).toFixed(2)}px);animation-duration:${(2.85 / speed).toFixed(2)}s;`,
    });
    appendFxPath(svg, 'theme-keycap-fx-stroke theme-keycap-fx-rgb-base', {
      d: pathData,
      stroke: mixHex(mixHex(colors[0], colors[1], 0.5), colors[2], 0.28),
      'stroke-width': strokeWidth,
      opacity: 0.18,
    });
    appendFxPath(svg, 'theme-keycap-fx-rgb-ring', {
      d: pathData,
      stroke: ringStroke,
      'stroke-width': strokeWidth,
      opacity: 0.97,
    });
  }

  function buildRgbBreatheFx(svg, pathData, colors, intensityScale, speed, strokeBase) {
    const duration = (3.8 / speed).toFixed(2);
    const strokeWidth = (strokeBase * (0.88 + (0.12 * intensityScale))).toFixed(2);
    appendFxPath(svg, 'theme-keycap-fx-halo theme-keycap-fx-breathe-halo', {
      d: pathData,
      stroke: mixHex(colors[0], colors[1], 0.5),
      'stroke-width': (strokeBase * (2.5 + (0.78 * intensityScale))).toFixed(2),
      opacity: 0.24,
      style: `filter:blur(${Math.max(1.8, strokeBase * (1.1 + (0.3 * intensityScale))).toFixed(2)}px);animation-duration:${duration}s;`,
    });
    colors.forEach((color, index) => {
      appendFxPath(svg, `theme-keycap-fx-breathe theme-keycap-fx-breathe-${index + 1}`, {
        d: pathData,
        stroke: color,
        'stroke-width': strokeWidth,
        opacity: index === Math.floor(colors.length / 2) ? 0.72 : 0.48,
        style: `animation-duration:${duration}s;animation-delay:${(-0.9 * index).toFixed(2)}s;`,
      });
    });
  }

  function buildComicElectricFx(svg, pathData, colors, intensityScale, speed, strokeBase) {
    appendFxPath(svg, 'theme-keycap-fx-halo theme-keycap-fx-comic-halo', {
      d: pathData,
      stroke: mixHex(colors[0], colors[1], 0.42),
      'stroke-width': (strokeBase * (2.45 + (0.8 * intensityScale))).toFixed(2),
      opacity: 0.34,
      style: `filter:blur(${Math.max(1.8, strokeBase * (0.95 + (0.34 * intensityScale))).toFixed(2)}px);animation-duration:${(2.5 / speed).toFixed(2)}s;`,
    });
    appendFxPath(svg, 'theme-keycap-fx-stroke theme-keycap-fx-comic-zap', {
      d: pathData,
      stroke: colors[1],
      'stroke-width': (strokeBase * (0.92 + (0.22 * intensityScale))).toFixed(2),
      opacity: 0.92,
      'pathLength': 100,
      'stroke-linecap': 'butt',
      'stroke-dasharray': `8 5 4 7 11 6 5 10`,
      style: `animation-duration:${(1.65 / speed).toFixed(2)}s;`,
    });
    appendFxPath(svg, 'theme-keycap-fx-stroke theme-keycap-fx-comic-arc', {
      d: pathData,
      stroke: colors[2],
      'stroke-width': Math.max(0.9, strokeBase * (0.52 + (0.1 * intensityScale))).toFixed(2),
      opacity: 0.62,
      'pathLength': 100,
      'stroke-linecap': 'square',
      'stroke-dasharray': `3 11 2 15 6 10`,
      style: `filter:blur(0.25px);animation-duration:${(2.3 / speed).toFixed(2)}s;animation-delay:-0.6s;`,
    });
  }

  function trianglePoints(cx, cy, size, rotation = 0) {
    const radians = (Math.PI / 180) * rotation;
    return [0, 120, 240].map((deg) => {
      const angle = radians + ((Math.PI / 180) * deg);
      return {
        x: cx + (Math.cos(angle) * size),
        y: cy + (Math.sin(angle) * size),
      };
    });
  }

  function buildTriangleOrbitFx(svg, pathData, colors, intensityScale, speed, viewWidth, viewHeight, strokeBase) {
    const reduced = prefersReducedMotion();
    const centerX = viewWidth / 2;
    const centerY = viewHeight / 2;
    const size = 4 + (3.2 * intensityScale);
    appendFxPath(svg, 'theme-keycap-fx-halo theme-keycap-fx-triangle-halo', {
      d: pathData,
      stroke: mixHex(colors[0], colors[1], 0.5),
      'stroke-width': (strokeBase * (2.15 + (0.72 * intensityScale))).toFixed(2),
      opacity: 0.22,
      style: `filter:blur(${Math.max(1.6, strokeBase * (0.85 + (0.24 * intensityScale))).toFixed(2)}px);animation-duration:${(3.6 / speed).toFixed(2)}s;`,
    });
    appendFxPath(svg, 'theme-keycap-fx-stroke theme-keycap-fx-triangle-ring', {
      d: pathData,
      stroke: colors[1],
      'stroke-width': (strokeBase * (0.7 + (0.08 * intensityScale))).toFixed(2),
      opacity: 0.42,
    });
    const orbit = createSvgNode('g', {
      class: 'theme-keycap-fx-triangle-orbit',
      style: `animation-duration:${(4.8 / speed).toFixed(2)}s;`,
    });
    if (!reduced) {
      orbit.appendChild(createSvgNode('animateTransform', {
        attributeName: 'transform',
        type: 'rotate',
        from: `0 ${Number(centerX.toFixed(3))} ${Number(centerY.toFixed(3))}`,
        to: `360 ${Number(centerX.toFixed(3))} ${Number(centerY.toFixed(3))}`,
        dur: `${(4.8 / speed).toFixed(2)}s`,
        repeatCount: 'indefinite',
      }));
    }
    appendFxPolygon(orbit, 'theme-keycap-fx-triangle theme-keycap-fx-triangle-1', trianglePoints(centerX, Math.max(size + 2, centerY - (viewHeight * 0.46)), size, -90), {
      fill: colors[0],
      opacity: 0.88,
    });
    appendFxPolygon(orbit, 'theme-keycap-fx-triangle theme-keycap-fx-triangle-2', trianglePoints(Math.min(viewWidth - size - 2, centerX + (viewWidth * 0.38)), centerY - (viewHeight * 0.08), size * 0.88, 18), {
      fill: colors[1],
      opacity: 0.74,
    });
    appendFxPolygon(orbit, 'theme-keycap-fx-triangle theme-keycap-fx-triangle-3', trianglePoints(Math.max(size + 2, centerX - (viewWidth * 0.28)), Math.min(viewHeight - size - 2, centerY + (viewHeight * 0.36)), size * 0.82, 198), {
      fill: colors[2],
      opacity: 0.68,
    });
    svg.appendChild(orbit);
  }

  function buildPowerChargeFx(svg, pathData, colors, intensityScale, speed, viewWidth, viewHeight, strokeBase) {
    const reduced = prefersReducedMotion();
    const ringStroke = createFxGradient(svg, 'power-ring', [colors[0], colors[1], colors[2]], viewWidth, viewHeight, speed * 0.92, {
      reduced,
      clockwise: true,
      style: 'rgb-ring',
    });
    appendFxPath(svg, 'theme-keycap-fx-halo theme-keycap-fx-power-halo', {
      d: pathData,
      stroke: ringStroke,
      'stroke-width': (strokeBase * (2.9 + (0.86 * intensityScale))).toFixed(2),
      opacity: 0.28,
      style: `filter:blur(${Math.max(2, strokeBase * (1 + (0.34 * intensityScale))).toFixed(2)}px);animation-duration:${(2.4 / speed).toFixed(2)}s;`,
    });
    appendFxPath(svg, 'theme-keycap-fx-stroke theme-keycap-fx-power-ring', {
      d: pathData,
      stroke: ringStroke,
      'stroke-width': (strokeBase * (0.98 + (0.12 * intensityScale))).toFixed(2),
      opacity: 0.96,
      style: `animation-duration:${(1.95 / speed).toFixed(2)}s;`,
    });
    appendFxPath(svg, 'theme-keycap-fx-stroke theme-keycap-fx-power-charge', {
      d: pathData,
      stroke: '#ffffff',
      'stroke-width': Math.max(0.9, strokeBase * (0.58 + (0.08 * intensityScale))).toFixed(2),
      opacity: 0.56,
      'pathLength': 100,
      'stroke-dasharray': `${(18 + (6 * intensityScale)).toFixed(2)} ${(82 - (6 * intensityScale)).toFixed(2)}`,
      style: reduced ? 'filter:blur(0.3px);' : `filter:blur(0.3px);animation-duration:${(1.55 / speed).toFixed(2)}s;`,
    });
  }

  function syncKeycapFxNode(section, node) {
    if (!node) return;
    const fx = normalizeFx(section?.fx);
    const shape = section?.geometry?.shape || 'rounded';
    if (!fx.enabled || !isSupportedFxShape(shape)) {
      removeKeycapFxLayer(node);
      return;
    }

    const width = node.offsetWidth || node.clientWidth || 0;
    const height = node.offsetHeight || node.clientHeight || 0;
    if (!width || !height) {
      removeKeycapFxLayer(node);
      return;
    }

    const intensityScale = getFxIntensityScale(fx.intensity);
    const strokeBase = getFxStrokeBase(section);
    const colors = getFxColors(section, fx);
    const padBase = fx.preset === 'triangle-orbit'
      ? 20
      : fx.preset === 'comic-electric'
        ? 16
        : fx.preset === 'power-charge'
          ? 14
          : fx.preset === 'neon-pulse'
            ? 16
            : 12;
    const pad = Math.ceil((padBase * intensityScale) + (strokeBase * 2.2));
    const pathData = buildKeycapSvgPath(section?.geometry, width, height, pad);
    if (!pathData) {
      removeKeycapFxLayer(node);
      return;
    }

    const svg = getOrCreateKeycapFxLayer(node);
    const viewWidth = width + (pad * 2);
    const viewHeight = height + (pad * 2);
    svg.setAttribute('class', `theme-keycap-fx-layer theme-keycap-fx-layer--${fx.preset}`);
    svg.setAttribute('viewBox', `0 0 ${viewWidth} ${viewHeight}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.style.setProperty('--theme-fx-pad', `${pad}px`);
    svg.replaceChildren();

    if (fx.preset === 'neon-pulse') {
      buildNeonPulseFx(svg, pathData, colors, intensityScale, fx.speed, strokeBase);
    } else if (fx.preset === 'rgb-chase') {
      buildRgbChaseFx(svg, pathData, colors, intensityScale, fx.speed, viewWidth, viewHeight, strokeBase);
    } else if (fx.preset === 'rgb-breathe') {
      buildRgbBreatheFx(svg, pathData, colors, intensityScale, fx.speed, strokeBase);
    } else if (fx.preset === 'comic-electric') {
      buildComicElectricFx(svg, pathData, colors, intensityScale, fx.speed, strokeBase);
    } else if (fx.preset === 'triangle-orbit') {
      buildTriangleOrbitFx(svg, pathData, colors, intensityScale, fx.speed, viewWidth, viewHeight, strokeBase);
    } else if (fx.preset === 'power-charge') {
      buildPowerChargeFx(svg, pathData, colors, intensityScale, fx.speed, viewWidth, viewHeight, strokeBase);
    } else {
      removeKeycapFxLayer(node);
    }
  }

  function syncSectionFx(section, selector, root) {
    getScopedNodes(root, selector).forEach((node) => {
      syncKeycapFxNode(section, node);
    });
  }

  function syncSectionMetrics(section, selector, root) {
    const actualOutlineWidth = section?.outline?.enabled ? clamp(section.outline?.width, 0, 16, 0) : 0;
    const outlineBehavior = getFxOutlineBehavior(section?.fx);
    const outlineWidth = outlineBehavior === 'replace' ? 0 : actualOutlineWidth;
    getScopedNodes(root, selector).forEach((node) => {
      if (!node || !node.style) return;
      node.setAttribute('data-theme-runtime', 'true');
      node.style.removeProperty('--theme-clip-path');
      node.style.removeProperty('--theme-border-radius');
      node.style.removeProperty('--theme-fill-clip-path');
      node.style.removeProperty('--theme-fill-border-radius');
      if ((section?.geometry?.shape || 'rounded') === 'speech-pill') {
        const outerSpeechPath = buildSpeechPillClipPath(node.offsetWidth || 0, node.offsetHeight || 0, 0);
        const innerSpeechPath = buildSpeechPillClipPath(node.offsetWidth || 0, node.offsetHeight || 0, outlineWidth);
        if (outerSpeechPath) {
          node.style.setProperty('--theme-clip-path', outerSpeechPath);
          node.style.setProperty('--theme-border-radius', '0px');
        }
        if (innerSpeechPath) {
          node.style.setProperty('--theme-fill-clip-path', innerSpeechPath);
          node.style.setProperty('--theme-fill-border-radius', '0px');
        }
        return;
      }
      if (!outlineWidth) return;
      const width = node.offsetWidth || 0;
      const height = node.offsetHeight || 0;
      const dynamicShape = getDynamicInnerShapeCss(section.geometry, outlineWidth, width, height);
      if (!dynamicShape) return;
      node.style.setProperty('--theme-fill-clip-path', dynamicShape.clipPath);
      if (dynamicShape.borderRadius) node.style.setProperty('--theme-fill-border-radius', dynamicShape.borderRadius);
    });
  }

  function syncThemeMetrics(theme, selectors, root = document) {
    if (!selectors) return;
    const resolved = resolveTheme(theme);
    if (selectors.keycap) syncSectionMetrics(resolved.keycap, selectors.keycap, root);
    if (selectors.caption) syncSectionMetrics(resolved.caption, selectors.caption, root);
    if (selectors.keycap) syncSectionFx(resolved.keycap, selectors.keycap, root);
    if (selectors.caption) syncSectionFx(resolved.caption, selectors.caption, root);
  }

  function getThemeName(theme) {
    return (theme && theme.__name) || 'Custom';
  }

  function serializeSection(section, kind) {
    const resolved = normalizeSection(section, kind, normalizeDefaults(DEFAULT_THEME.defaults));
    return {
      textColor: resolved.textColor,
      textShadow: resolved.textShadow,
      textEffect: deepClone(resolved.textEffect),
      letterSpacing: resolved.letterSpacing,
      fontSize: resolved.fontSize,
      geometry: deepClone(resolved.geometry),
      material: deepClone(resolved.material),
      pattern: deepClone(resolved.pattern),
      effects: deepClone(resolved.effects),
      fx: deepClone(resolved.fx),
      adornments: deepClone(resolved.adornments),
      motion: deepClone(resolved.motion),
    };
  }

  function serializeTheme(theme) {
    const resolved = resolveTheme(theme);
    return {
      __name: resolved.__name || 'Custom',
      defaults: {
        fontWeight: resolved.defaults.fontWeight,
        fontFamily: resolved.defaults.fontFamily,
        keycapScale: resolved.defaults.keycapScale,
        captionScale: resolved.defaults.captionScale,
        captionPosition: resolved.defaults.captionPosition,
        fade: resolved.defaults.motion.enter,
        animationSpeed: resolved.defaults.motion.speed,
        motion: deepClone(resolved.defaults.motion),
      },
      keycap: serializeSection(resolved.keycap, 'keycap'),
      caption: serializeSection(resolved.caption, 'caption'),
    };
  }

  function createEditableTheme(theme) {
    return resolveTheme(theme);
  }

  function applyBuilderValue(theme, section, path, value) {
    const next = createEditableTheme(theme);
    let cursor = next[section];
    for (let index = 0; index < path.length - 1; index += 1) {
      const key = path[index];
      if (!cursor[key] || typeof cursor[key] !== 'object') cursor[key] = {};
      cursor = cursor[key];
    }
    cursor[path[path.length - 1]] = value;
    return next;
  }

  function getBuilderValue(theme, section, path) {
    let cursor = resolveTheme(theme)[section];
    for (const key of path) {
      if (!cursor || typeof cursor !== 'object') return undefined;
      cursor = cursor[key];
    }
    return cursor;
  }

  function getThemePreviewChipStyle(theme) {
    const resolved = resolveTheme(theme);
    const keycap = getElementCss(resolved.keycap, resolved.defaults);
    return {
      background: keycap.fillBackground,
      border: keycap.outlineWidth && keycap.outlineWidth !== '0px' ? `1px solid ${keycap.outlineColor}` : 'none',
      borderRadius: keycap.borderRadius,
      clipPath: keycap.clipPath,
      boxShadow: [keycap.glowShadow, keycap.surfaceShadow].filter((value) => value && value !== 'none').join(', ') || 'none',
      filter: keycap.dropShadow,
      color: keycap.color,
      textShadow: keycap.textShadow,
      letterSpacing: keycap.letterSpacing,
    };
  }

  function getInheritedDefaults(theme) {
    const resolved = resolveTheme(theme);
    return {
      keycapFillColor: getFillRepresentativeColor(resolved.keycap.fill),
      keycapTextColor: resolved.keycap.textColor,
      keycapOutlineColor: resolved.keycap.outline?.color || '#00000000',
      keycapTextureColor: resolved.keycap.pattern?.color || '#000000',
      keycapShadowColor: resolved.keycap.shadow?.layers?.find((layer) => !layer.inset)?.color || resolved.keycap.glow?.color || '#00000000',
      captionFillColor: getFillRepresentativeColor(resolved.caption.fill),
      captionTextColor: resolved.caption.textColor,
      captionOutlineColor: resolved.caption.outline?.color || '#00000000',
      captionTextureColor: resolved.caption.pattern?.color || '#000000',
      captionShadowColor: resolved.caption.shadow?.layers?.find((layer) => !layer.inset)?.color || resolved.caption.glow?.color || '#00000000',
    };
  }

  global.ThemeRuntime = {
    DEFAULT_THEME,
    deepMerge,
    deepClone,
    mixHex,
    resolveTheme,
    serializeTheme,
    compileThemeCss,
    applyThemeCss,
    syncThemeMetrics,
    isSupportedFxShape,
    getThemeName,
    createEditableTheme,
    applyBuilderValue,
    getBuilderValue,
    getThemePreviewChipStyle,
    getFillRepresentativeColor,
    getInheritedDefaults,
  };
})(window);
