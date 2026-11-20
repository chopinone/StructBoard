/* Step-note editing and canonical local edits, independent of the overview DOM. */
(function (root) {
  'use strict';
  function stateText(state) {
    const kind = (state && state.state) || 'saved';
    if (state && state.localError) return state.pipelineSaved
      ? '管线已保存 · 本机保存失败，请重试' : '本机保存失败 · 请保持窗口打开并重试';
    if (kind === 'error') return '未能写入管线 · 草稿已留在本机';
    if (kind === 'saving') return '正在写入管线…';
    if (kind === 'local') return '已保存在本机';
    return '已保存 · 本机与管线';
  }
  function createStore(options) {
    options = options || {};
    const storage = options.storage, storageKey = options.storageKey || 'structboard.stepEdits';
    const all = Object.create(null);
    let error = '';
    const isObject = function (value) { return !!value && typeof value === 'object' && !Array.isArray(value); };
    const valid = function (key, value) { return isObject(value) && (!options.validate || options.validate(key, value)); };
    try {
      const saved = JSON.parse(storage.getItem(storageKey) || '{}');
      if (!isObject(saved)) throw Error('本机便签编辑格式无效');
      Object.keys(saved).forEach(function (key) { if (valid(key, saved[key])) all[key] = Object.assign({}, saved[key]); });
    } catch (e) { error = e.message || String(e); }
    function persist() {
      try { storage.setItem(storageKey, JSON.stringify(all)); error = ''; }
      catch (e) { error = e.message || String(e); }
      return !error;
    }
    function save(key, patch) {
      if (!key || !isObject(patch)) return false;
      const value = Object.assign({}, all[key] || {}, patch);
      if (!valid(key, value)) return false;
      // Memory is canonical even if storage is full. Rebuilding cannot reread stale text.
      all[key] = value;
      return persist();
    }
    function restore(saved) {
      if (!isObject(saved)) return false;
      let changed = false;
      Object.keys(saved).forEach(function (key) {
        if (!valid(key, saved[key])) return;
        const current = all[key] || (all[key] = {});
        // Folder drafts are complete records: a current empty value or tombstone
        // must not inherit fields from an older workspace snapshot.
        if (options.atomic && Object.keys(current).length) return;
        Object.keys(saved[key]).forEach(function (field) {
          if (Object.prototype.hasOwnProperty.call(current, field)) return;
          current[field] = saved[key][field]; changed = true;
        });
      });
      if (changed) persist();
      return changed;
    }
    return { load: function () { return all; }, save: save, restore: restore, persist: persist,
      get error() { return error; } };
  }
  function createFolderStore(options) {
    options = options || {};
    const storage = options.storage, identityKey = options.identityKey || 'structboard.workspaceId';
    let workspaceId = '', identityError = '';
    const makeId = options.makeId || function () {
      return root.crypto && root.crypto.randomUUID ? root.crypto.randomUUID()
        : 'workspace-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    };
    try { workspaceId = storage.getItem(identityKey) || ''; }
    catch (failure) { identityError = failure.message || String(failure); }
    function keyOf(workspace, step, folder) { return JSON.stringify([workspace, step, folder]); }
    function valid(key, value) {
      return value.version === 1 && typeof value.workspaceId === 'string' && !!value.workspaceId
        && typeof value.stepKey === 'string' && !!value.stepKey
        && typeof value.folderId === 'string' && !!value.folderId
        && typeof value.note === 'string' && typeof value.deleted === 'boolean'
        && Number.isFinite(value.updatedAt)
        && key === keyOf(value.workspaceId, value.stepKey, value.folderId);
    }
    const store = createStore({ storage: storage, storageKey: options.storageKey || 'structboard.folderEdits',
      validate: valid, atomic: true });
    function persistIdentity() {
      if (!workspaceId) return true;
      try { storage.setItem(identityKey, workspaceId); identityError = ''; }
      catch (failure) { identityError = failure.message || String(failure); }
      return !identityError;
    }
    function identity() {
      if (!workspaceId) { workspaceId = makeId(); persistIdentity(); }
      return workspaceId;
    }
    function find(step, folder) { return workspaceId ? store.load()[keyOf(workspaceId, step, folder)] || null : null; }
    function save(step, folder, text, deleted) {
      if (!step || !folder) return false;
      const workspace = identity();
      const ok = store.save(keyOf(workspace, step, folder), { version: 1, workspaceId: workspace,
        stepKey: step, folderId: folder, note: String(text == null ? '' : text), deleted: !!deleted,
        updatedAt: Date.now() });
      const identitySaved = persistIdentity();
      return ok && identitySaved;
    }
    function restore(saved, savedWorkspaceId) {
      // A new workspace identity is authoritative even if it has no note records yet.
      if (!workspaceId && typeof savedWorkspaceId === 'string' && savedWorkspaceId) {
        workspaceId = savedWorkspaceId; persistIdentity();
      }
      return store.restore(saved);
    }
    function snapshot() {
      const result = Object.create(null);
      Object.keys(store.load()).forEach(function (key) {
        const value = store.load()[key];
        if (value.workspaceId === workspaceId) result[key] = Object.assign({}, value);
      });
      return result;
    }
    function persist() { const ok = store.persist(); return persistIdentity() && ok; }
    function reset() { workspaceId = makeId(); return persistIdentity(); }
    return { find: find, save: save, restore: restore, snapshot: snapshot, persist: persist, reset: reset,
      activateWorkspace: function (id) {
        if (typeof id !== 'string' || !id || id.length > 200) throw Error('文件夹工作区标识无效');
        workspaceId = id; return persistIdentity();
      },
      get workspaceId() { return identity(); }, get error() { return identityError || store.error; } };
  }
  function create(options) {
    const area = options.area, stateLabel = options.stateLabel, retryBtn = options.retryBtn;
    const noteBtn = options.noteBtn, hooks = options.hooks || {};
    const getNode = options.node || function () { return null; };
    const getKey = options.key || function () { return ''; };
    let edited = false, lastValue = area.value;
    function currentValue() {
      const node = getNode();
      return node ? (node.note || '') : area.value;
    }
    function paint() {
      const state = hooks.state ? hooks.state(getKey()) : null;
      if (stateLabel) {
        stateLabel.textContent = stateText(state);
        stateLabel.dataset.state = (state && state.state) || 'saved';
        stateLabel.title = (state && (state.error || state.localError)) || '输入即写本机与待同步队列；管线目录写入失败会自动重试';
      }
      if (retryBtn) retryBtn.hidden = !(state && state.state === 'error' && !!hooks.retry);
      return state;
    }
    function commit() {
      if (!edited) { paint(); return false; }
      edited = false;
      // The input already saved the value. Blur/unmount only expedites networking;
      // never save a potentially replaced section node or an untouched empty box.
      if (hooks.flush) hooks.flush(getKey());
      paint();
      return true;
    }
    area.addEventListener('input', function () {
      const value = area.value, node = getNode();
      const previous = node ? (node.note || '') : lastValue;
      if (node) node.note = value;
      if (noteBtn) noteBtn.classList.toggle('has-note', !!value.trim());
      if (value !== previous) {
        lastValue = value; edited = true;
        const save = hooks.draft || hooks.save;
        if (save) save(getKey(), value);
      }
      paint(); // Local failures and saving state must be visible on this keystroke.
    });
    area.addEventListener('blur', commit);
    area.addEventListener('change', commit);
    if (retryBtn) retryBtn.addEventListener('click', function (event) {
      if (event && event.stopPropagation) event.stopPropagation();
      if (hooks.retry) hooks.retry(getKey());
      paint();
    });
    return { paint: paint, commit: commit, hasPending: function () { return edited; },
      get value() { return currentValue(); } };
  }
  root.SB_NOTE_EDIT = { create: create, createStore: createStore, createFolderStore: createFolderStore, stateText: stateText };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.SB_NOTE_EDIT;
})(typeof window === 'undefined' ? globalThis : window);
