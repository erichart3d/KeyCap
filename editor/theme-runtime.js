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

  const DEFAULT_THEME = {
    __name: 'Keycap',
    defaults: {
      fontWeight: 700,
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
      letterSpacing: 1.5,
      fontSize: 22,
      geometry: defaultGeometry('keycap'),
      material: defaultMaterial('keycap'),
      pattern: defaultPattern(),
      effects: defaultEffects('keycap'),
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
      letterSpacing: 2,
      fontSize: 16,
      geometry: defaultGeometry('caption'),
      material: defaultMaterial('caption'),
      pattern: defaultPattern(),
      effects: defaultEffects('caption'),
      adornments: defaultAdornments(),
      motion: defaultMotion('glitch'),
      glow: { enabled: false, color: '#c8c1b5', spread: 12, opacity: 0.18 },
      shadow: { enabled: false, surfaceOpacity: 1, dropOpacity: 0, layers: [] },
    },
  };

  function normalizeDefaults(defaults) {
    const motion = deepMerge(defaultMotion(defaults?.fade || 'glitch'), defaults?.motion || {});
    return {
      ...defaults,
      fontWeight: clamp(defaults?.fontWeight, 100, 900, 700),
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
      scale: clamp(base.scale, 0.25, 6, 1),
      rotation: clamp(base.rotation, 0, 360, 0),
    };
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

  function normalizeSection(section, kind, defaults) {
    const geometry = deepMerge(defaultGeometry(kind), section?.geometry || {});
    const material = deepMerge(defaultMaterial(kind), section?.material || {});
    const pattern = normalizePattern(section?.pattern, section?.texture);
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
    const adornments = Array.isArray(section?.adornments) ? section.adornments.map((item) => deepClone(item)) : defaultAdornments();
    const motion = deepMerge(defaultMotion(defaults.motion?.enter || defaults.fade || 'glitch'), section?.motion || {});

    const fill = deepClone(section?.fill || material.fill);
    const outline = deepMerge(material.outline, section?.outline || {});
    const shadow = section?.shadow && Array.isArray(section.shadow.layers)
      ? deepMerge({ enabled: true, surfaceOpacity: 1, dropOpacity: 0, layers: [] }, section.shadow)
      : deriveShadowFromEffects(effects, section?.shadow);
    const glow = section?.glow
      ? deepMerge({ enabled: false, color: getFillRepresentativeColor(fill), spread: 16, opacity: 0 }, section.glow)
      : deriveGlowFromEffects(effects, outline.color || getFillRepresentativeColor(fill));

    return {
      ...section,
      geometry,
      material: { ...material, fill, outline },
      pattern,
      effects,
      adornments,
      motion,
      textColor: section?.textColor || '#ffffff',
      textShadow: section?.textShadow || 'none',
      letterSpacing: Number(section?.letterSpacing ?? (kind === 'caption' ? 2 : 1.5)),
      fontSize: Number(section?.fontSize ?? (kind === 'caption' ? 16 : 22)),
      textAlign: section?.textAlign || geometry.textAlign,
      shape: geometry.shape,
      cornerRadius: geometry.cornerRadius,
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
      opacity: clamp(material.surfaceOpacity ?? section?.opacity, 0, 1, 1),
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
      'speech-pill': 'polygon(12% 0%, 100% 0%, 100% 100%, 22% 100%, 12% 116%, 16% 100%, 0% 100%, 0% 12%)',
      'double-plate': 'polygon(4% 0%, 100% 0%, 100% 88%, 96% 100%, 0% 100%, 0% 12%)',
    };
    return { borderRadius: shape === 'speech-pill' ? '18px' : '0', clipPath: map[shape] || 'none' };
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

    if (preset === 'glass') {
      layers.push(
        'linear-gradient(180deg, rgba(255,255,255,0.44) 0%, rgba(255,255,255,0.16) 36%, rgba(255,255,255,0.08) 37%, rgba(255,255,255,0.02) 100%)',
        getFillCss({ type: 'linear', angle: 180, stops: [{ color: lighter, position: 0 }, { color: fillColor, position: 60 }, { color: darker, position: 100 }] })
      );
    } else if (preset === 'plastic') {
      layers.push(
        'linear-gradient(180deg, rgba(255,255,255,0.36) 0%, rgba(255,255,255,0.06) 44%, transparent 45%)',
        getFillCss({ type: 'linear', angle: 180, stops: [{ color: lighter, position: 0 }, { color: fillColor, position: 58 }, { color: darker, position: 100 }] })
      );
    } else if (preset === 'chrome') {
      layers.push(
        `linear-gradient(180deg, ${brightest} 0%, ${darker} 12%, ${brightest} 28%, ${darkest} 46%, ${lighter} 64%, ${fillColor} 82%, ${brightest} 100%)`
      );
    } else if (preset === 'matte') {
      layers.push(
        `linear-gradient(180deg, ${lighter} 0%, ${fillColor} 34%, ${darker} 100%)`
      );
    } else if (preset === 'paper' || preset === 'chalk') {
      layers.push(
        `linear-gradient(180deg, ${mixHex(fillColor, '#ffffff', 0.1)} 0%, ${fillColor} 70%, ${mixHex(fillColor, '#000000', 0.08)} 100%)`
      );
    } else if (preset === 'pixel') {
      layers.push(
        `repeating-linear-gradient(180deg, ${lighter} 0 3px, ${fillColor} 3px 6px, ${darker} 6px 9px, ${fillColor} 9px 12px)`
      );
    } else if (preset === 'mechanical') {
      layers.push(
        `linear-gradient(180deg, ${brightest} 0%, ${lighter} 20%, ${fillColor} 70%, ${darker} 100%)`
      );
    } else {
      layers.push(getFillCss(fill));
    }

    return { layers, sizes, positions };
  }

  function getPatternCss(pattern) {
    const type = pattern?.type || 'none';
    if (type === 'none') return { layers: [], sizes: [], positions: [] };
    const color = cssColorWithOpacity(pattern.color || '#000000', clamp(pattern.opacity, 0, 1, 0.18));
    const soft = cssColorWithOpacity(pattern.color || '#000000', clamp(pattern.opacity, 0, 1, 0.18) * 0.5);
    const scale = clamp(pattern.scale, 0.25, 6, 1);
    const density = clamp(pattern.density, 1, 40, 3);
    const angle = clamp(pattern.rotation, 0, 360, 0);
    const step = Math.max(2, Math.round(density * 4 * scale));

    if (type === 'scanlines') {
      return {
        layers: [`repeating-linear-gradient(${angle}deg, transparent 0 ${Math.max(1, step - 1)}px, ${color} ${Math.max(1, step - 1)}px ${step}px)`],
        sizes: ['auto'],
        positions: ['0 0'],
      };
    }
    if (type === 'dots') {
      const dot = Math.max(4, step);
      return {
        layers: [`radial-gradient(circle at center, ${color} 0 24%, transparent 26% 100%)`],
        sizes: [`${dot}px ${dot}px`],
        positions: ['0 0'],
      };
    }
    if (type === 'halftone') {
      const half = Math.max(6, Math.round(step * 1.3));
      return {
        layers: [`radial-gradient(circle at center, ${color} 0 18%, transparent 20% 100%)`],
        sizes: [`${half}px ${half}px`],
        positions: ['0 0'],
      };
    }
    if (type === 'gradient') {
      return {
        layers: [`linear-gradient(${angle}deg, transparent 0%, ${soft} 45%, ${color} 100%)`],
        sizes: ['auto'],
        positions: ['0 0'],
      };
    }
    if (type === 'stripes') {
      return {
        layers: [`repeating-linear-gradient(${angle || 45}deg, transparent 0 ${step}px, ${color} ${step}px ${step * 2}px)`],
        sizes: ['auto'],
        positions: ['0 0'],
      };
    }
    if (type === 'checker') {
      const size = Math.max(8, step * 2);
      return {
        layers: [
          `linear-gradient(45deg, ${soft} 25%, transparent 25%, transparent 75%, ${soft} 75%)`,
          `linear-gradient(45deg, ${soft} 25%, transparent 25%, transparent 75%, ${soft} 75%)`,
        ],
        sizes: [`${size}px ${size}px`, `${size}px ${size}px`],
        positions: [`0 0`, `${size / 2}px ${size / 2}px`],
      };
    }
    if (type === 'grid' || type === 'blueprint') {
      const major = Math.max(16, step * 2.5);
      return {
        layers: [
          `linear-gradient(${color} 1px, transparent 1px)`,
          `linear-gradient(90deg, ${color} 1px, transparent 1px)`,
          `linear-gradient(${cssColorWithOpacity(pattern.color || '#000000', clamp(pattern.opacity, 0, 1, 0.12))} 1px, transparent 1px)`,
          `linear-gradient(90deg, ${cssColorWithOpacity(pattern.color || '#000000', clamp(pattern.opacity, 0, 1, 0.12))} 1px, transparent 1px)`,
        ],
        sizes: [`${step}px ${step}px`, `${step}px ${step}px`, `${major}px ${major}px`, `${major}px ${major}px`],
        positions: ['0 0', '0 0', '0 0', '0 0'],
      };
    }
    if (type === 'grain' || type === 'paper-grain') {
      const grain = Math.max(18, step * 2);
      return {
        layers: [
          `radial-gradient(circle at 18% 24%, ${soft} 0 12%, transparent 13%)`,
          `radial-gradient(circle at 74% 48%, ${color} 0 10%, transparent 11%)`,
          `radial-gradient(circle at 42% 78%, ${soft} 0 12%, transparent 13%)`,
        ],
        sizes: [`${grain}px ${grain}px`, `${grain * 1.2}px ${grain * 1.2}px`, `${grain * 0.9}px ${grain * 0.9}px`],
        positions: ['0 0', '0 0', '0 0'],
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
      };
    }
    return { layers: [], sizes: [], positions: [] };
  }

  function getAdornmentCss(adornments) {
    const layers = [];
    const sizes = [];
    const positions = [];
    const active = Array.isArray(adornments) ? adornments.filter((item) => item && item.type && item.type !== 'none') : [];
    active.forEach((item) => {
      const color = cssColorWithOpacity(item.color || '#ffffff', clamp(item.opacity, 0, 1, 0.45));
      const size = clamp(item.size, 4, 32, 10);
      if (item.type === 'corner-brackets') {
        layers.push(
          `linear-gradient(${color}, ${color})`,
          `linear-gradient(${color}, ${color})`,
          `linear-gradient(${color}, ${color})`,
          `linear-gradient(${color}, ${color})`
        );
        sizes.push(`${size}px 2px`, `2px ${size}px`, `${size}px 2px`, `2px ${size}px`);
        positions.push(`left top`, `left top`, `right bottom`, `right bottom`);
      } else if (item.type === 'underline') {
        layers.push(`linear-gradient(${color}, ${color})`);
        sizes.push(`calc(100% - ${size}px) 2px`);
        positions.push(`center calc(100% - 2px)`);
      } else if (item.type === 'side-tabs') {
        layers.push(`linear-gradient(${color}, ${color})`, `linear-gradient(${color}, ${color})`);
        sizes.push(`${size}px 34%`, `${size}px 34%`);
        positions.push(`left center`, `right center`);
      } else if (item.type === 'chevrons') {
        layers.push(
          `linear-gradient(135deg, transparent 45%, ${color} 46% 54%, transparent 55%)`,
          `linear-gradient(225deg, transparent 45%, ${color} 46% 54%, transparent 55%)`
        );
        sizes.push(`${size}px ${size}px`, `${size}px ${size}px`);
        positions.push(`8px center`, `calc(100% - 8px) center`);
      } else if (item.type === 'badge-dot') {
        layers.push(`radial-gradient(circle at center, ${color} 0 55%, transparent 56%)`);
        sizes.push(`${size}px ${size}px`);
        positions.push(`calc(100% - ${Math.round(size * 0.6)}px) ${Math.round(size * 0.4)}px`);
      } else if (item.type === 'signal-ticks') {
        layers.push(`repeating-linear-gradient(90deg, ${color} 0 2px, transparent 2px 6px)`);
        sizes.push(`calc(100% - ${size}px) 2px`);
        positions.push(`center ${Math.round(size * 0.6)}px`);
      }
    });
    return { layers, sizes, positions };
  }

  function getSpecialEffectCss(effects) {
    const layers = [];
    const sizes = [];
    const positions = [];
    effects.forEach((effect) => {
      if (effect.type === 'reflection') {
        const alpha = clamp(effect.opacity, 0, 1, 0.22);
        layers.push(`linear-gradient(${clamp(effect.angle, 0, 360, 180)}deg, rgba(255,255,255,${alpha}) 0%, rgba(255,255,255,0) 45%)`);
        sizes.push('auto');
        positions.push('0 0');
      } else if (effect.type === 'sheen') {
        const alpha = clamp(effect.opacity, 0, 1, 0.16);
        layers.push(`linear-gradient(${clamp(effect.angle, 0, 360, 115)}deg, transparent 25%, rgba(255,255,255,${alpha}) 48%, transparent 72%)`);
        sizes.push(`${clamp(effect.width, 40, 220, 120)}% 100%`);
        positions.push('-30% 0');
      } else if (effect.type === 'inner-glow') {
        layers.push(`radial-gradient(circle at center, ${cssColorWithOpacity(effect.color || '#ffffff', clamp(effect.opacity, 0, 1, 0.2))} 0%, transparent ${clamp(effect.spread, 12, 120, 40)}%)`);
        sizes.push('auto');
        positions.push('center center');
      }
    });
    return { layers, sizes, positions };
  }

  function getElementCss(element, defaults) {
    const shape = getShapeCss(element.geometry);
    const anchor = getAnchorCss(element.textAlign || element.geometry?.textAlign);
    const shadow = getShadowCss(element);
    const glow = getGlowCss(element);
    const material = materialLayerBundle(element);
    const pattern = getPatternCss(element.pattern);
    const adornments = getAdornmentCss(element.adornments);
    const specialEffects = getSpecialEffectCss(element.effects || []);
    const outline = element.outline || {};
    const outlineWidth = outline.enabled ? clamp(outline.width, 0, 16, 0) : 0;
    const outerBackground = outlineWidth ? (outline.color || '#000000') : getFillCss(element.fill);
    const backgroundLayers = [...specialEffects.layers, ...pattern.layers, ...material.layers];
    const backgroundSizes = [...specialEffects.sizes, ...pattern.sizes, ...material.sizes];
    const backgroundPositions = [...specialEffects.positions, ...pattern.positions, ...material.positions];
    const beforeLayers = [...adornments.layers, outerBackground];
    const beforeSizes = [...adornments.sizes, 'auto'];
    const beforePositions = [...adornments.positions, '0 0'];

    return {
      color: element.textColor || '#ffffff',
      textShadow: element.textShadow || 'none',
      letterSpacing: `${Number(element.letterSpacing ?? 2)}px`,
      fontSize: `${Number(element.fontSize ?? 18)}px`,
      fontWeight: Number(defaults.fontWeight ?? 700),
      textAlign: anchor.textAlign,
      alignItems: anchor.alignItems,
      justifyContent: anchor.justifyContent,
      padding: `${Number(element.paddingY ?? element.geometry?.paddingY ?? 8)}px ${Number(element.paddingX ?? element.geometry?.paddingX ?? 16)}px`,
      opacity: '1',
      fillOpacity: String(clamp(element.opacity ?? element.material?.surfaceOpacity, 0, 1, 1)),
      fillBackground: backgroundLayers.join(', ') || getFillCss(element.fill),
      fillBackgroundSize: backgroundSizes.join(', '),
      fillBackgroundPosition: backgroundPositions.join(', '),
      fillInset: `${outlineWidth}px`,
      borderRadius: shape.borderRadius,
      clipPath: shape.clipPath,
      outerBackground: beforeLayers.join(', '),
      outerBackgroundSize: beforeSizes.join(', '),
      outerBackgroundPosition: beforePositions.join(', '),
      surfaceShadow: shadow.surfaceShadow,
      dropShadow: shadow.dropShadow,
      glowShadow: glow,
    };
  }

  function compileCssBlock(selector, style) {
    return `${selector}{background:transparent;color:${style.color};text-shadow:${style.textShadow};letter-spacing:${style.letterSpacing};font-size:${style.fontSize};font-weight:${style.fontWeight};text-align:${style.textAlign};display:inline-flex;align-items:${style.alignItems};justify-content:${style.justifyContent};padding:${style.padding};opacity:${style.opacity};border:none;border-radius:${style.borderRadius};clip-path:${style.clipPath};box-shadow:none;filter:${style.dropShadow};z-index:0;}`;
  }

  function compileOuterBlock(selector, style) {
    const size = style.outerBackgroundSize ? `background-size:${style.outerBackgroundSize};` : '';
    const position = style.outerBackgroundPosition ? `background-position:${style.outerBackgroundPosition};background-repeat:no-repeat;` : '';
    return `${selector}::before{content:'';display:block;position:absolute;inset:0;background:${style.outerBackground};${size}${position}border-radius:${style.borderRadius};clip-path:${style.clipPath};box-shadow:${style.glowShadow};pointer-events:none;z-index:-2;}`;
  }

  function compileInnerBlock(selector, style) {
    const size = style.fillBackgroundSize ? `background-size:${style.fillBackgroundSize};` : '';
    const position = style.fillBackgroundPosition ? `background-position:${style.fillBackgroundPosition};background-repeat:repeat,no-repeat;` : '';
    return `${selector}::after{content:'';display:block;position:absolute;inset:${style.fillInset};background:${style.fillBackground};opacity:${style.fillOpacity};border-radius:${style.borderRadius};clip-path:${style.clipPath};box-shadow:${style.surfaceShadow};pointer-events:none;${size}${position}z-index:-1;}`;
  }

  function compileThemeCss(theme, selectors) {
    const resolved = resolveTheme(theme);
    const keycapStyle = getElementCss(resolved.keycap, resolved.defaults);
    const captionStyle = getElementCss(resolved.caption, resolved.defaults);
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
  }

  function getThemeName(theme) {
    return (theme && theme.__name) || 'Custom';
  }

  function serializeSection(section, kind) {
    const resolved = normalizeSection(section, kind, normalizeDefaults(DEFAULT_THEME.defaults));
    return {
      textColor: resolved.textColor,
      textShadow: resolved.textShadow,
      letterSpacing: resolved.letterSpacing,
      fontSize: resolved.fontSize,
      geometry: deepClone(resolved.geometry),
      material: deepClone(resolved.material),
      pattern: deepClone(resolved.pattern),
      effects: deepClone(resolved.effects),
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
      background: keycap.outerBackground,
      border: 'none',
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
    getThemeName,
    createEditableTheme,
    applyBuilderValue,
    getBuilderValue,
    getThemePreviewChipStyle,
    getFillRepresentativeColor,
    getInheritedDefaults,
  };
})(window);
