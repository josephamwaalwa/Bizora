(function () {
  var STORAGE_KEY = 'bizora_theme_preference_v1';
  try {
    var isDesktopTauri =
      typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
    var stored = isDesktopTauri ? null : localStorage.getItem(STORAGE_KEY);
    var mode = stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
    var prefersDark =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches;
    var isDark = mode === 'dark' || (mode === 'system' && prefersDark);
    var root = document.documentElement;
    if (isDark) {
      root.classList.add('dark');
      root.style.colorScheme = 'dark';
    } else {
      root.classList.remove('dark');
      root.style.colorScheme = 'light';
    }
  } catch {
    // Ignore storage access errors during early boot
  }
})();
