(function () {
  const key = 'qbreader-theme-profile-v1';
  const roleMap = { background: 'base00', panel: 'base01', selection: 'base02', border: 'base03', muted: 'base04', text: 'base05', strong: 'base07', danger: 'base08', warning: 'base09', highlight: 'base0A', success: 'base0B', info: 'base0C', accent: 'base0D', purple: 'base0E', brown: 'base0F' };
  const presets = {
    nord: { name: 'Nord', palette: ['2e3440', '3b4252', '434c5e', '4c566a', 'd8dee9', 'e5e9f0', 'eceff4', 'ffffff', 'bf616a', 'd08770', 'ebcb8b', 'a3be8c', '88c0d0', '81a1c1', 'b48ead', '8fbcbb'] },
    solarized: { name: 'Solarized Light', palette: ['fdf6e3', 'eee8d5', 'e8e0cc', '93a1a1', '657b83', '586e75', '073642', '002b36', 'dc322f', 'cb4b16', 'b58900', '859900', '2aa198', '268bd2', '6c71c4', 'd33682'] }
  };
  const props = [];
  const root = document.documentElement;
  const validColor = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
  function clear () {
    root.removeAttribute('data-qb-theme');
    props.splice(0).forEach(name => root.style.removeProperty(name));
  }
  function set (name, value) {
    root.style.setProperty(name, value);
    props.push(name);
  }
  function rgb (color) { return [1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16)).join(', '); }
  function luminance (color) {
    const components = [1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return components[0] * 0.2126 + components[1] * 0.7152 + components[2] * 0.0722;
  }
  function foreground (background) { return luminance(background) > 0.179 ? '#000000' : '#ffffff'; }
  function apply (profile) {
    if (!profile || !profile.palette || Object.values(roleMap).some(name => !validColor(profile.palette[name]))) { return false; }
    clear();
    const roles = {};
    for (const [role, paletteKey] of Object.entries(roleMap)) {
      roles[role] = validColor(profile.roles?.[role]) ? profile.roles[role] : profile.palette[paletteKey];
      set(`--qb-${role}`, roles[role]);
      set(`--qb-${role}-rgb`, rgb(roles[role]));
    }
    for (const role of ['accent', 'danger', 'warning', 'success', 'info', 'muted', 'purple', 'highlight']) { set(`--qb-on-${role}`, foreground(roles[role])); }
    const night = luminance(roles.background) < 0.35;
    set('color-scheme', night ? 'dark' : 'light');
    root.setAttribute('data-bs-theme', night ? 'night' : 'light');
    root.setAttribute('data-qb-theme', 'custom');
    return true;
  }
  function stored () { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } }
  function createPreset (id) {
    const selected = presets[id];
    if (!selected) { return null; }
    return { version: 1, name: selected.name, palette: Object.fromEntries(selected.palette.map((color, index) => [`base${index.toString(16).toUpperCase().padStart(2, '0')}`, `#${color}`])), roles: {} };
  }
  function systemTheme () {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'night' : 'light';
  }
  function applySelection (selected = localStorage.getItem('color-theme') || 'auto') {
    const selection = ['auto', 'light', 'night', 'custom', ...Object.keys(presets)].includes(selected) ? selected : 'auto';
    if (presets[selection] && apply(createPreset(selection))) { return; }
    if (selection === 'custom' && apply(stored())) { return; }
    // Older versions stored built-in palettes as "custom" profiles. If one
    // cannot be read, recover the named preset from the stored profile name.
    if (selection === 'custom') {
      const name = String(stored()?.name || '').toLowerCase();
      const legacyPreset = name.includes('nord') ? 'nord' : name.includes('solarized') ? 'solarized' : null;
      if (legacyPreset && apply(createPreset(legacyPreset))) { return; }
    }
    clear();
    root.setAttribute('data-bs-theme', ['light', 'night'].includes(selection) ? selection : systemTheme());
  }
  window.qbTheme = { key, roleMap, presets, createPreset, apply, clear, stored, hasStored: () => Boolean(stored()), applyStored: () => apply(stored()), systemTheme, applySelection };
  applySelection();
  const systemPreference = window.matchMedia?.('(prefers-color-scheme: dark)');
  systemPreference?.addEventListener?.('change', () => {
    if ((localStorage.getItem('color-theme') || 'auto') === 'auto') { applySelection(); }
  });
})();
