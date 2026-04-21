const API_BASE = (location.origin && location.origin.startsWith('http'))
  ? location.origin : 'http://127.0.0.1:8765';

const DRAFT_KEY = 'keycap-theme-creator-draft';
const channel = new BroadcastChannel('keycap-theme-library');

function qs(sel, root = document) { return root.querySelector(sel); }
function qsa(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

async function api(method, path, body) {
  try {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(API_BASE + path, opts);
    if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
    const ct = res.headers.get('content-type') || '';
    return ct.includes('json') ? await res.json() : await res.text();
  } catch (err) {
    console.warn('theme creator api', method, path, err);
    return null;
  }
}

function slugifyName(value) {
  return (value || '').trim().toLowerCase()
    .replace(/[^a-z0-9\-_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function loadInitialTheme() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return ThemeRuntime.resolveTheme(ThemeRuntime.DEFAULT_THEME);
    localStorage.removeItem(DRAFT_KEY);
    return ThemeRuntime.resolveTheme(JSON.parse(raw));
  } catch (_) {
    return ThemeRuntime.resolveTheme(ThemeRuntime.DEFAULT_THEME);
  }
}

const state = {
  theme: loadInitialTheme(),
  section: 'keycap',
};

function applyPreview() {
  ThemeRuntime.applyThemeCss(
    qs('#theme-creator-css'),
    state.theme,
    { keycap: '.keycap-el', caption: '.key-caption' },
  );
}

function syncSectionTabs() {
  qsa('#sectionTabs button').forEach((button) => {
    button.classList.toggle('on', button.dataset.section === state.section);
  });
  qsa('.section-panel').forEach((panel) => {
    panel.classList.toggle('on', panel.dataset.sectionPanel === state.section);
  });
}

function syncForm() {
  ['keycap', 'caption'].forEach((section) => {
    const block = state.theme[section];
    const shadow = block.shadow?.layers?.[0] || { x: 0, y: 0, blur: 0, color: '#000000' };
    qs(`#${section}-shape`).value = block.shape || 'rounded';
    qs(`#${section}-radius`).value = Number(block.cornerRadius ?? 0);
    qs(`#${section}-fill`).value = ThemeRuntime.getFillRepresentativeColor(block.fill);
    qs(`#${section}-text`).value = block.textColor || '#000000';
    qs(`#${section}-outline-width`).value = Number(block.outline?.width ?? 0);
    qs(`#${section}-outline-color`).value = block.outline?.color || '#000000';
    qs(`#${section}-texture-type`).value = block.texture?.type || 'none';
    qs(`#${section}-texture-color`).value = block.texture?.color || '#000000';
    qs(`#${section}-texture-opacity`).value = Number(block.texture?.opacity ?? 0);
    qs(`#${section}-shadow-x`).value = Number(shadow.x ?? 0);
    qs(`#${section}-shadow-y`).value = Number(shadow.y ?? 0);
    qs(`#${section}-shadow-blur`).value = Number(shadow.blur ?? 0);
    qs(`#${section}-shadow-color`).value = shadow.color || '#000000';
    qsa(`#${section}-toggles button`).forEach((button) => {
      const enabled = button.dataset.key === 'outline'
        ? !!block.outline?.enabled
        : !!block.shadow?.enabled;
      button.classList.toggle('on', enabled);
      button.textContent = button.dataset.key === 'outline'
        ? `Outline ${enabled ? 'On' : 'Off'}`
        : `Shadow ${enabled ? 'On' : 'Off'}`;
    });
  });
  syncSectionTabs();
  applyPreview();
}

function ensureShadowLayer(block) {
  if (!block.shadow.layers?.length) {
    block.shadow.layers = [{ x: 5, y: 5, blur: 0, spread: 0, color: '#000000' }];
  }
}

function updateTheme(section, mutator) {
  const next = ThemeRuntime.createEditableTheme(state.theme);
  mutator(next[section]);
  state.theme = next;
  syncForm();
}

function wireSection(section) {
  qs(`#${section}-shape`).onchange = (e) => updateTheme(section, (block) => {
    block.shape = e.target.value;
  });
  qs(`#${section}-radius`).oninput = (e) => updateTheme(section, (block) => {
    block.cornerRadius = +e.target.value;
  });
  qs(`#${section}-fill`).oninput = (e) => updateTheme(section, (block) => {
    block.fill = { type: 'solid', color: e.target.value };
  });
  qs(`#${section}-text`).oninput = (e) => updateTheme(section, (block) => {
    block.textColor = e.target.value;
  });
  qs(`#${section}-outline-width`).oninput = (e) => updateTheme(section, (block) => {
    block.outline.width = +e.target.value;
    block.outline.enabled = (+e.target.value) > 0;
  });
  qs(`#${section}-outline-color`).oninput = (e) => updateTheme(section, (block) => {
    block.outline.color = e.target.value;
  });
  qs(`#${section}-texture-type`).onchange = (e) => updateTheme(section, (block) => {
    block.texture.type = e.target.value;
  });
  qs(`#${section}-texture-color`).oninput = (e) => updateTheme(section, (block) => {
    block.texture.color = e.target.value;
  });
  qs(`#${section}-texture-opacity`).oninput = (e) => updateTheme(section, (block) => {
    block.texture.opacity = +e.target.value;
  });
  qs(`#${section}-shadow-x`).oninput = (e) => updateTheme(section, (block) => {
    ensureShadowLayer(block);
    block.shadow.layers[0].x = +e.target.value;
  });
  qs(`#${section}-shadow-y`).oninput = (e) => updateTheme(section, (block) => {
    ensureShadowLayer(block);
    block.shadow.layers[0].y = +e.target.value;
  });
  qs(`#${section}-shadow-blur`).oninput = (e) => updateTheme(section, (block) => {
    ensureShadowLayer(block);
    block.shadow.layers[0].blur = +e.target.value;
  });
  qs(`#${section}-shadow-color`).oninput = (e) => updateTheme(section, (block) => {
    ensureShadowLayer(block);
    block.shadow.layers[0].color = e.target.value;
  });
  qsa(`#${section}-toggles button`).forEach((button) => {
    button.onclick = () => updateTheme(section, (block) => {
      if (button.dataset.key === 'outline') {
        block.outline.enabled = !block.outline.enabled;
      } else {
        block.shadow.enabled = !block.shadow.enabled;
        ensureShadowLayer(block);
      }
    });
  });
}

async function saveTheme() {
  const name = prompt('Name this theme:');
  if (!name) return;
  const slug = slugifyName(name);
  if (!slug) return;
  const res = await api('PUT', '/api/themes/' + encodeURIComponent(slug), {
    name,
    theme: ThemeRuntime.createEditableTheme(state.theme),
  });
  if (!res) return;
  channel.postMessage({ type: 'theme-saved', slug });
  window.close();
}

function wire() {
  qsa('#sectionTabs button').forEach((button) => {
    button.onclick = () => {
      state.section = button.dataset.section;
      syncSectionTabs();
    };
  });
  wireSection('keycap');
  wireSection('caption');
  qs('#cancelBtn').onclick = () => window.close();
  qs('#saveBtn').onclick = saveTheme;
}

wire();
syncForm();
