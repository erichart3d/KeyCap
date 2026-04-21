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

  function normalizeHex(hex, fallback) {
    const raw = String(hex || '').trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{6}$/.test(raw)) return `#${raw.toLowerCase()}`;
    if (/^[0-9a-fA-F]{3}$/.test(raw)) return `#${raw.split('').map((char) => char + char).join('').toLowerCase()}`;
    return fallback;
  }

  function mixHex(a, b, ratio) {
    const left = normalizeHex(a, '#000000');
    const right = normalizeHex(b, '#000000');
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
    return `rgba(${red}, ${green}, ${blue}, ${Math.max(0, Math.min(1, Number(opacity) || 0))})`;
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

  function resolveTheme(theme) {
    return deepMerge(DEFAULT_THEME, theme || {});
  }

  function getFillCss(fill) {
    if (typeof fill === 'string') return fill;
    if (!fill || typeof fill !== 'object') return getFillCss(DEFAULT_THEME.keycap.fill);
    if (fill.type === 'solid') return fill.color || '#000000';
    const angle = Number(fill.angle);
    if (Array.isArray(fill.stops) && fill.stops.length) {
      const stops = fill.stops.map((stop) => `${stop.color} ${stop.position}%`).join(', ');
      return `linear-gradient(${Number.isFinite(angle) ? angle : 180}deg, ${stops})`;
    }
    const from = fill.color || '#000000';
    const to = fill.gradientTo || from;
    return `linear-gradient(${Number.isFinite(angle) ? angle : 180}deg, ${from}, ${to})`;
  }

  function getFillRepresentativeColor(fill) {
    if (typeof fill === 'string') return fill;
    if (!fill || typeof fill !== 'object') return '#000000';
    if (fill.color) return fill.color;
    if (Array.isArray(fill.stops) && fill.stops.length) return fill.stops[0].color;
    return '#000000';
  }

  function getShapeCss(element) {
    const shape = element.shape || 'rounded';
    if (shape === 'square') return { borderRadius: '0', clipPath: 'none' };
    if (shape === 'rounded') return { borderRadius: `${Number(element.cornerRadius) || 6}px`, clipPath: 'none' };
    if (shape === 'pill' || shape === 'oval') return { borderRadius: '999px', clipPath: 'none' };
    if (shape === 'rhombus') return { borderRadius: '0', clipPath: 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)' };
    if (shape === 'hex') return { borderRadius: '0', clipPath: 'polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)' };
    if (shape === 'octagon') return { borderRadius: '0', clipPath: 'polygon(30% 0%, 70% 0%, 100% 30%, 100% 70%, 70% 100%, 30% 100%, 0% 70%, 0% 30%)' };
    return { borderRadius: `${Number(element.cornerRadius) || 6}px`, clipPath: 'none' };
  }

  function getShadowCss(element) {
    const shadow = element.shadow || {};
    const layers = Array.isArray(shadow.layers) ? shadow.layers : [];
    const surfaceOpacity = Math.max(0, Math.min(1, Number(shadow.surfaceOpacity ?? 1) || 0));
    const dropOpacity = Math.max(0, Math.min(1, Number(shadow.dropOpacity ?? 1) || 0));
    const dropEnabled = shadow.dropEnabled !== undefined
      ? !!shadow.dropEnabled
      : dropOpacity > 0;
    if ((!shadow.enabled && !layers.length) || (!surfaceOpacity && !dropOpacity)) {
      return { surfaceShadow: 'none', dropShadow: 'none' };
    }

    const insetLayers = layers.filter((layer) => !!layer.inset);
    const outerLayers = layers.filter((layer) => !layer.inset);
    const surfaceShadow = insetLayers.length ? insetLayers.map((layer) => {
      const inset = layer.inset ? 'inset ' : '';
      const x = Number(layer.x) || 0;
      const y = Number(layer.y) || 0;
      const blur = Number(layer.blur) || 0;
      const spread = Number(layer.spread) || 0;
      return `${inset}${x}px ${y}px ${blur}px ${spread}px ${cssColorWithOpacity(layer.color || '#000000', surfaceOpacity)}`;
    }).join(', ') : 'none';
    const dropShadow = (dropEnabled && dropOpacity > 0 && outerLayers.length) ? outerLayers.map((layer) => {
      const x = Number(layer.x) || 0;
      const y = Number(layer.y) || 0;
      const blur = Number(layer.blur) || 0;
      return `drop-shadow(${x}px ${y}px ${blur}px ${cssColorWithOpacity(layer.color || '#000000', dropOpacity)})`;
    }).join(' ') : 'none';

    return {
      surfaceShadow,
      dropShadow,
    };
  }

  function getGlowCss(element) {
    const glow = element.glow || {};
    const opacity = Math.max(0, Math.min(1, Number(glow.opacity ?? 0) || 0));
    const enabled = glow.enabled !== undefined ? !!glow.enabled : opacity > 0;
    if (!enabled || opacity <= 0) return 'none';
    const spread = Math.max(0, Number(glow.spread) || 0);
    const color = glow.color || getFillRepresentativeColor(element.fill) || '#ffffff';
    return `0 0 ${spread}px ${cssColorWithOpacity(color, opacity)}`;
  }

  function getAnchorCss(anchor) {
    const value = String(anchor || 'center-center').toLowerCase();
    if (value === 'left') return { alignItems: 'center', justifyContent: 'flex-start', textAlign: 'left' };
    if (value === 'right') return { alignItems: 'center', justifyContent: 'flex-end', textAlign: 'right' };
    if (value === 'center') return { alignItems: 'center', justifyContent: 'center', textAlign: 'center' };
    const [verticalRaw, horizontalRaw] = value.includes('-') ? value.split('-') : ['center', 'center'];
    const vertical = verticalRaw === 'middle' ? 'center' : verticalRaw;
    const horizontal = horizontalRaw || 'center';
    return {
      alignItems: vertical === 'top' ? 'flex-start' : vertical === 'bottom' ? 'flex-end' : 'center',
      justifyContent: horizontal === 'left' ? 'flex-start' : horizontal === 'right' ? 'flex-end' : 'center',
      textAlign: horizontal === 'left' ? 'left' : horizontal === 'right' ? 'right' : 'center',
    };
  }

  function getTextureCss(texture) {
    if (!texture || texture.type === 'none') {
      return { display: 'none', background: 'none', opacity: 0 };
    }
    const density = Math.max(2, Number(texture.density) || 3);
    const alphaColor = cssColorWithOpacity(texture.color || '#000000', texture.opacity);

    if (texture.type === 'scanlines') {
      return {
        display: 'block',
        background: `repeating-linear-gradient(0deg, transparent 0 ${Math.max(1, density - 1)}px, ${alphaColor} ${Math.max(1, density - 1)}px ${density}px)`,
        opacity: 1,
      };
    }
    if (texture.type === 'dots') {
      return {
        display: 'block',
        background: `radial-gradient(circle at center, ${alphaColor} 0 28%, transparent 30% 100%)`,
        backgroundSize: `${density * 2}px ${density * 2}px`,
        opacity: 1,
      };
    }
    if (texture.type === 'halftone') {
      return {
        display: 'block',
        background: `radial-gradient(circle at center, ${alphaColor} 0 24%, transparent 26% 100%)`,
        backgroundSize: `${density * 1.5}px ${density * 1.5}px`,
        opacity: 1,
      };
    }
    if (texture.type === 'gradient') {
      return {
        display: 'block',
        background: `linear-gradient(180deg, transparent 0%, ${alphaColor} 100%)`,
        opacity: 1,
      };
    }
    return { display: 'none', background: 'none', opacity: 0 };
  }

  function getElementCss(element, defaults = DEFAULT_THEME.defaults) {
    const shape = getShapeCss(element);
    const shadow = getShadowCss(element);
    const outline = element.outline || {};
    const texture = getTextureCss(element.texture);
    const anchor = getAnchorCss(element.textAlign);
    const outlineWidth = outline.enabled ? Math.max(0, Number(outline.width) || 0) : 0;
    const outerBackground = outlineWidth ? (outline.color || '#000000') : getFillCss(element.fill);
    return {
      background: outerBackground,
      color: element.textColor || '#ffffff',
      textShadow: element.textShadow || 'none',
      letterSpacing: `${Number(element.letterSpacing ?? 2)}px`,
      fontSize: `${Number(element.fontSize ?? 18)}px`,
      fontWeight: Number(element.textWeight ?? defaults.fontWeight ?? 700),
      textAlign: anchor.textAlign,
      alignItems: anchor.alignItems,
      justifyContent: anchor.justifyContent,
      padding: `${Number(element.paddingY ?? 8)}px ${Number(element.paddingX ?? 16)}px`,
      opacity: '1',
      fillOpacity: String(Math.max(0, Math.min(1, Number(element.opacity ?? 1) || 0))),
      fillBackground: getFillCss(element.fill),
      fillInset: `${outlineWidth}px`,
      borderRadius: shape.borderRadius,
      clipPath: shape.clipPath,
      glowShadow: getGlowCss(element),
      surfaceShadow: shadow.surfaceShadow,
      dropShadow: shadow.dropShadow,
      texture,
    };
  }

  function compileCssBlock(selector, style) {
    return `${selector}{background:transparent;color:${style.color};text-shadow:${style.textShadow};letter-spacing:${style.letterSpacing};font-size:${style.fontSize};font-weight:${style.fontWeight};text-align:${style.textAlign};display:inline-flex;align-items:${style.alignItems};justify-content:${style.justifyContent};padding:${style.padding};opacity:${style.opacity};border:none;border-radius:${style.borderRadius};clip-path:${style.clipPath};box-shadow:none;filter:${style.dropShadow};z-index:0;}`;
  }

  function compileOuterBlock(selector, style) {
    return `${selector}::before{content:'';display:block;position:absolute;inset:0;background:${style.background};border-radius:${style.borderRadius};clip-path:${style.clipPath};box-shadow:${style.glowShadow};pointer-events:none;z-index:-2;}`;
  }

  function compileInnerBlock(selector, style) {
    const texture = style.texture;
    const background = texture.display === 'none'
      ? style.fillBackground
      : `${texture.background}, ${style.fillBackground}`;
    const backgroundSize = texture.display === 'none'
      ? ''
      : `background-size:${texture.backgroundSize ? `${texture.backgroundSize}, auto` : 'auto, auto'};`;
    return `${selector}::after{content:'';display:block;position:absolute;inset:${style.fillInset};background:${background};opacity:${style.fillOpacity};border-radius:${style.borderRadius};clip-path:${style.clipPath};box-shadow:${style.surfaceShadow};pointer-events:none;${backgroundSize}z-index:-1;}`;
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

  function createEditableTheme(theme) {
    return deepMerge(DEFAULT_THEME, theme || {});
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
      background: keycap.background,
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
      keycapTextureColor: resolved.keycap.texture?.color || '#000000',
      keycapShadowColor: resolved.keycap.shadow?.layers?.find((layer) => !layer.inset)?.color || '#00000000',
      captionFillColor: getFillRepresentativeColor(resolved.caption.fill),
      captionTextColor: resolved.caption.textColor,
      captionOutlineColor: resolved.caption.outline?.enabled ? resolved.caption.outline.color : '#00000000',
      captionTextureColor: resolved.caption.texture?.color || '#000000',
      captionShadowColor: resolved.caption.shadow?.layers?.find((layer) => !layer.inset)?.color || '#00000000',
    };
  }

  global.ThemeRuntime = {
    DEFAULT_THEME,
    deepMerge,
    deepClone,
    mixHex,
    resolveTheme,
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
