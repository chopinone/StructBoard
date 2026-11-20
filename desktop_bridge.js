/* Desktop-only transport; browser workflow remains available. */
(function () {
  'use strict';
  // This script runs in both the shell and the pipeline iframe. Suppress only
  // the browser default action: custom contextmenu handlers still receive it,
  // and text-editing fields retain their native copy/paste menu.
  document.addEventListener('contextmenu', function (event) {
    const target = event.target && event.target.nodeType === 1 ? event.target : event.target && event.target.parentElement;
    const field = target && target.closest ? target.closest('input, textarea, [contenteditable]') : null;
    const textTypes = /^(text|search|url|tel|email|password|number)$/;
    const editable = field && !field.disabled &&
      (field.tagName === 'TEXTAREA' || (field.tagName === 'INPUT' && textTypes.test(field.type || 'text')) || field.isContentEditable);
    if (!editable) event.preventDefault();
  }, true);
  let config = window.__SB_DESKTOP__;
  if (!config && window.parent !== window) {
    try { config = window.parent.__SB_DESKTOP__; } catch (_) { /* separate origin */ }
  }
  if (!config) return;
  window.__SB_DESKTOP__ = config;
  const originalFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (!url.pathname.startsWith('/api/') || url.origin !== location.origin) return originalFetch(input, init);
    const headers = new Headers(init && init.headers || (input instanceof Request ? input.headers : undefined));
    headers.set('X-StructBoard-Token', config.token);
    return originalFetch(config.apiBase + url.pathname + url.search, {...init, headers}).catch(async error => {
      try {
        if (!(await window.__SB_DESKTOP_INVOKE__('desktop_status'))) {
          throw new Error('本地数据服务已退出，请重新打开 StructBoard 恢复。');
        }
      } catch (statusError) { if (statusError.message) throw statusError; }
      throw error;
    });
  };
  const invoke = function (command, args) {
    const api = window.__TAURI__ || window.parent.__TAURI__;
    return api.core.invoke(command, args);
  };
  window.__SB_DESKTOP_INVOKE__ = invoke;
  try {
    if (!navigator.clipboard) Object.defineProperty(navigator, 'clipboard', {value: {}, configurable: true});
    Object.defineProperty(navigator.clipboard, 'writeText', {value: text => invoke('desktop_copy', {text}), configurable: true});
  } catch (_) { /* existing browser fallback remains available */ }
  function markDesktop() {
    document.documentElement.dataset.desktop = 'tauri';
    document.title = 'StructBoard';
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', markDesktop, { once: true });
  else markDesktop();
})();
