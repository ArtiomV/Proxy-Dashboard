'use strict';

// Apply persisted theme (matches admin/client portal storage key)
(function applyStoredTheme() {
  try {
    const stored = localStorage.getItem('theme');
    if (stored === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    }
  } catch (_) { /* ignore */ }
})();

function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('theme', next); } catch (_) { /* ignore */ }
}

function goBack() {
  if (history.length > 1) {
    history.back();
  } else {
    location.href = '/admin';
  }
}

document.addEventListener('DOMContentLoaded', function () {
  const themeBtn = document.querySelector('.changelog-header .theme-toggle');
  if (themeBtn) themeBtn.addEventListener('click', toggleTheme);
  const backBtn = document.querySelector('.changelog-header a.back');
  if (backBtn) {
    backBtn.addEventListener('click', function (e) {
      e.preventDefault();
      goBack();
    });
  }
});
