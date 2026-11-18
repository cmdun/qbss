/**
 * This file is run at the start of every page.
 * Because it must be run immmediately, it **cannot** defer and cannot be a module.
 */

function isTouchDevice () {
  if ('ontouchstart' in window) return true;

  // eslint-disable-next-line no-undef
  return window.DocumentTouch && document instanceof DocumentTouch;
}

const tooltipTriggerList = [].slice.call(document.querySelectorAll('[data-bs-toggle="tooltip"]'));
for (const tooltipTriggerEl of tooltipTriggerList) {
  if (isTouchDevice()) continue;

  // eslint-disable-next-line no-new
  new bootstrap.Tooltip(tooltipTriggerEl);
}

// mostly copied from https://getbootstrap.com/docs/5.3/customize/color-modes/#javascript

const getStoredTheme = () => window.localStorage.getItem('color-theme');
const setStoredTheme = theme => window.localStorage.setItem('color-theme', theme);
const getPreferredTheme = () => {
  const storedTheme = getStoredTheme();
  if (storedTheme === 'dark') { return 'night'; }
  if (storedTheme) { return storedTheme; }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'night' : 'light';
};

const setTheme = theme => {
  window.qbTheme.applySelection(theme === 'dark' ? 'night' : theme);
};

setTheme(getPreferredTheme());

const showActiveTheme = (theme, focus = false) => {
  const activeThemeIcon = document.querySelector('.theme-icon-active i');
  const btnToActive = document.querySelector(`[data-bs-theme-value="${theme}"]`);
  if (!btnToActive || !activeThemeIcon) { return; }
  const svgClassOfActiveBtn = Array.from(btnToActive.querySelector('i').classList).filter(cls => cls.startsWith('bi-'))[0];

  document.querySelectorAll('[data-bs-theme-value]').forEach(element => {
    element.classList.remove('active');
    element.querySelector('.bi-check2').classList.add('d-none');
  });

  btnToActive.classList.add('active');
  btnToActive.querySelector('.bi-check2').classList.remove('d-none');
  activeThemeIcon.className = 'bi ' + svgClassOfActiveBtn;

  if (focus) {
    document.querySelector('#bd-theme').focus();
  }
};

window.addEventListener('DOMContentLoaded', () => {
  showActiveTheme(getPreferredTheme());

  document.querySelectorAll('[data-bs-theme-value]')
    .forEach(toggle => {
      toggle.addEventListener('click', () => {
        const theme = toggle.getAttribute('data-bs-theme-value');
        if (theme === 'custom' && !window.qbTheme.hasStored()) {
          window.location.href = '/settings/#appearance';
          return;
        }
        setStoredTheme(theme);
        setTheme(theme);
        showActiveTheme(theme, true);
      });
    });
}, { once: true });

window.addEventListener('storage', event => {
  if (event.key === 'color-theme' || event.key === 'qbreader-theme-profile-v1') {
    setTheme(getPreferredTheme());
    showActiveTheme(getPreferredTheme());
  }
});
window.addEventListener('qb-theme-changed', () => showActiveTheme(getPreferredTheme()));
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (!getStoredTheme() || getStoredTheme() === 'auto') { setTheme('auto'); }
});
