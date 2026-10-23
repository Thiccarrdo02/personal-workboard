// Apply the saved theme before first paint to avoid a flash.
try {
  var savedPrefs = JSON.parse(localStorage.getItem('personal-workboard-prefs') || '{}');
  if (savedPrefs.theme === 'light' || savedPrefs.theme === 'dark') document.documentElement.dataset.theme = savedPrefs.theme;
} catch (e) {}
