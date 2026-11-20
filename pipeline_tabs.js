/* Framework-independent tab catalog. Vue owns the DOM through a small mount adapter. */
(function (root) {
  'use strict';
  function create(options) {
    options = options || {};
    const storage = options.storage;
    const storageKey = String(options.key || 'structboard.pipelineTabs.main');
    let items = [], activeId = '', hasSavedCatalog = false;
    const listeners = new Set(), views = new Map();
    let snapshot;
    function publish() {
      snapshot = Object.freeze({ version: 1, activeId: activeId,
        items: Object.freeze(items.map(item => Object.freeze({ id: item.id, name: item.name }))) });
      listeners.forEach(fn => fn(snapshot));
    }

    function persist() {
      try { storage.setItem(storageKey, JSON.stringify({ version: 1, items: items, activeId: activeId })); }
      catch (_) { /* Keep the in-memory list when browser storage is unavailable. */ }
      publish();
    }
    try {
      const saved = JSON.parse(storage.getItem(storageKey) || 'null');
      if (saved && saved.version === 1 && Array.isArray(saved.items)) {
        hasSavedCatalog = true;
        const seen = new Set();
        items = saved.items.filter(function (item) {
          if (!item || typeof item.id !== 'string' || !item.id || typeof item.name !== 'string' || seen.has(item.id)) return false;
          seen.add(item.id); return true;
        }).map(function (item) { return { id: item.id, name: item.name.slice(0, 200) }; });
        activeId = items.some(function (item) { return item.id === saved.activeId; }) ? saved.activeId : (items[0] && items[0].id) || '';
      }
    } catch (_) { items = []; activeId = ''; hasSavedCatalog = false; }

    publish();
    function get(id) { const item = items.find(function (item) { return item.id === id; }); return item ? { ...item } : null; }
    function add(item, activate) {
      if (!item || typeof item.id !== 'string' || !item.id || typeof item.name !== 'string' || !item.name.trim()) return null;
      let current = items.find(row => row.id === item.id);
      if (current) current.name = item.name.trim().slice(0, 200);
      else { current = { id: item.id, name: item.name.trim().slice(0, 200) }; items.push(current); }
      if (activate !== false) activeId = current.id;
      persist(); return get(current.id);
    }
    function activate(id) {
      if (!get(id)) return false;
      activeId = id; persist(); return true;
    }
    function remove(id) {
      const index = items.findIndex(function (item) { return item.id === id; });
      if (index < 0) return null;
      const wasActive = activeId === id;
      items.splice(index, 1);
      if (wasActive) activeId = items[Math.min(index, items.length - 1)]?.id || '';
      persist(); return { wasActive: wasActive, nextId: activeId };
    }
    function move(id, beforeId) {
      const from = items.findIndex(function (item) { return item.id === id; });
      if (from < 0 || id === beforeId) return false;
      const item = items.splice(from, 1)[0];
      const to = beforeId ? items.findIndex(function (row) { return row.id === beforeId; }) : items.length;
      items.splice(to < 0 ? items.length : to, 0, item);
      persist(); return true;
    }
    function render(container, handlers) {
      let view = views.get(container);
      if (!view) {
        const mount = options.mountView || (root.SB_UI && root.SB_UI.mountPipelineTabs);
        if (!mount) throw Error('Vue UI bundle is missing; run npm run build:ui');
        view = mount(container, api, handlers || {}); views.set(container, view);
        container.hidden = false;
      } else view.update(handlers || {});
    }
    const api = { get: get, add: add, activate: activate, remove: remove, move: move, render: render,
      restore: function (value) {
        if (!value || !Array.isArray(value.items) || value.items.some(item => !item || typeof item.id !== 'string' || !item.id || typeof item.name !== 'string') ||
            new Set(value.items.map(item => item.id)).size !== value.items.length) throw Error('Invalid tab snapshot');
        items = value.items.map(item => ({ id: item.id, name: item.name }));
        activeId = items.some(item => item.id === value.activeId) ? value.activeId : (items[0]?.id || '');
        persist();
      },
      getSnapshot: function () { return snapshot; },
      get hasSavedCatalog() { return hasSavedCatalog; },
      subscribe: function (fn) { listeners.add(fn); return function () { listeners.delete(fn); }; },
      destroy: function () { views.forEach(view => view.dispose()); views.clear(); listeners.clear(); },
      get activeId() { return activeId; },
      get items() { return items.map(function (item) { return { id: item.id, name: item.name }; }); } };
    return api;
  }

  root.SB_PIPELINE_TABS = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.SB_PIPELINE_TABS;
})(typeof window === 'undefined' ? globalThis : window);
