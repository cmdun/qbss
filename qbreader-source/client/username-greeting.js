(function () {
  const name = (window.localStorage.getItem('multiplayer-username') || '').trim();
  const home = document.getElementById('home-greeting');
  const stats = document.getElementById('stats-greeting');
  if (home) { home.textContent = name ? `Welcome to QBSS, ${name}` : 'Welcome to QBSS'; }
  if (stats) { stats.textContent = name ? `Welcome back, ${name}. Your practice history and performance are stored on this device.` : 'Your practice history and performance, stored on this device.'; }
})();
