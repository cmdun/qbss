(function () {
  const key = 'qbreader-theme-profile-v1';
  const roleMap = { background: 'base00', panel: 'base01', selection: 'base02', border: 'base03', muted: 'base04', text: 'base05', strong: 'base07', danger: 'base08', warning: 'base09', highlight: 'base0A', success: 'base0B', info: 'base0C', accent: 'base0D', purple: 'base0E', brown: 'base0F' };
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
  function systemTheme () {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'night' : 'light';
  }
  function applySelection (selected = localStorage.getItem('color-theme') || 'auto') {
    const selection = ['auto', 'light', 'night', 'custom'].includes(selected) ? selected : 'auto';
    if (selection === 'custom' && apply(stored())) { return; }
    clear();
    root.setAttribute('data-bs-theme', ['light', 'night'].includes(selection) ? selection : systemTheme());
  }
  window.qbTheme = { key, roleMap, apply, clear, stored, hasStored: () => Boolean(stored()), applyStored: () => apply(stored()), systemTheme, applySelection };
  applySelection();
  const systemPreference = window.matchMedia?.('(prefers-color-scheme: dark)');
  systemPreference?.addEventListener?.('change', () => {
    if ((localStorage.getItem('color-theme') || 'auto') === 'auto') { applySelection(); }
  });
})();
