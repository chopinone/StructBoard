/* Durable per-field outbox. Input persists now; only networking is debounced. */
(function (root) {
  'use strict';
  function create(options) {
    options = options || {};
    const storage = options.storage;
    const storageKey = options.storageKey || 'structboard.notesPending';
    const request = options.fetch || root.fetch.bind(root);
    const later = options.setTimeout || setTimeout, cancel = options.clearTimeout || clearTimeout;
    const requestTimeout = options.requestTimeout == null ? 10000 : options.requestTimeout;
    const queues = new Map();
    let storageError = '', hasLocalSnapshot = false;
    const isObject = function (value) { return !!value && typeof value === 'object' && !Array.isArray(value); };
    function queue(pid) {
      if (!queues.has(pid)) queues.set(pid, { fields: new Map(), timer: 0, error: '', attempts: 0, running: null });
      return queues.get(pid);
    }
    function snapshot() {
      const result = Object.create(null);
      queues.forEach(function (q, pid) {
        if (!q.fields.size) return;
        const patch = Object.create(null);
        q.fields.forEach(function (item, key) { patch[key] = item.value; });
        result[pid] = patch;
      });
      return JSON.parse(JSON.stringify(result));
    }
    function persist() {
      try {
        storage.setItem(storageKey, JSON.stringify(snapshot()));
        storageError = '';
        hasLocalSnapshot = true;
      } catch (error) { storageError = error.message || String(error); }
      return !storageError;
    }
    function status(pid, key) {
      const q = queues.get(pid), pending = !!(q && q.fields.has(key));
      return { state: storageError || (pending && q.error) ? 'error' : pending ? 'saving' : 'saved',
        error: (pending && q.error) || storageError, localError: storageError };
    }
    function notify(pid, keys) {
      if (options.onChange) options.onChange(pid, keys);
    }
    function schedule(pid, delay) {
      const q = queue(pid);
      cancel(q.timer);
      q.timer = later(function () { q.timer = 0; flush(pid); }, delay);
    }
    function put(pid, patch, delay) {
      if (!pid || !isObject(patch)) return false;
      const q = queue(pid), keys = Object.keys(patch);
      if (!keys.length) return !storageError;
      keys.forEach(function (key) { q.fields.set(key, { value: patch[key] }); });
      q.error = '';
      const saved = persist();
      notify(pid, keys);
      schedule(pid, delay == null ? 320 : delay);
      return saved;
    }
    async function post(pid, patch) {
      const controller = typeof root.AbortController === 'function' ? new root.AbortController() : null;
      let timeout = 0;
      try {
        return await Promise.race([
          Promise.resolve().then(async function () {
            const response = await request('/api/notes', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: pid, patch: patch }),
              ...(controller ? { signal: controller.signal } : {}),
            });
            const data = await response.json();
            if (!response.ok || !data || !data.ok) throw Error((data && data.error) || '便签写入失败（HTTP ' + response.status + '）');
            return data;
          }),
          new Promise(function (_, reject) {
            timeout = later(function () {
              reject(Error('便签写入超时，请检查本地服务'));
              if (controller) controller.abort();
            }, requestTimeout);
          }),
        ]);
      } finally { cancel(timeout); }
    }
    async function send(pid) {
      const q = queue(pid);
      cancel(q.timer); q.timer = 0;
      if (!q.fields.size) return;
      const batch = new Map(q.fields), patch = Object.create(null), keys = Array.from(batch.keys());
      batch.forEach(function (item, key) { patch[key] = item.value; });
      q.error = '';
      persist(); // Retry a failed local write as well as the network request.
      notify(pid, keys);
      try {
        await post(pid, patch);
        batch.forEach(function (item, key) { if (q.fields.get(key) === item) q.fields.delete(key); });
        q.error = ''; q.attempts = 0;
        persist(); // Write {} too: an ACKed outbox must outrank older workspace snapshots.
      } catch (error) {
        q.error = error.message || String(error);
        q.attempts++;
      } finally {
        notify(pid, keys);
        // A newer input may already own the one debounce timer. Do not shorten it.
        if (q.fields.size && !q.timer) schedule(pid, q.error ? Math.min(30000, 1000 * Math.pow(2, Math.min(q.attempts, 5))) : 0);
      }
    }
    function flush(pid) {
      if (!pid) return Promise.all(Array.from(queues.keys()).map(function (id) { return flush(id); }));
      const q = queues.get(pid);
      if (!q) return Promise.resolve();
      cancel(q.timer); q.timer = 0;
      // One request per document; repeated blur/leave events do not stack requests.
      if (q.running) return q.running;
      if (!q.fields.size) {
        if (storageError) { persist(); notify(pid, []); }
        return Promise.resolve();
      }
      const next = Promise.resolve().then(function () { return send(pid); });
      q.running = next;
      const done = function () { if (q.running === next) q.running = null; };
      next.then(done, done);
      return next;
    }
    function restore(saved) {
      if (!isObject(saved)) return;
      Object.keys(saved).forEach(function (pid) {
        const patch = saved[pid];
        if (!isObject(patch)) return;
        const q = queue(pid);
        Object.keys(patch).forEach(function (key) {
          if (!q.fields.has(key)) q.fields.set(key, { value: patch[key] });
        });
        if (q.fields.size) schedule(pid, 0);
      });
      persist();
    }
    function restoreFallback(saved) {
      // Presence, not pending-count, decides authority. Even a durable {} is newer.
      if (hasLocalSnapshot) return false;
      restore(saved);
      return true;
    }
    function pending(pid, key) { const q = queues.get(pid); return !!(q && q.fields.has(key)); }
    function applyPending(pid, values) {
      const result = Object.assign({}, values || {}), q = queues.get(pid);
      if (q) q.fields.forEach(function (item, key) { result[key] = item.value; });
      return result;
    }
    try {
      const raw = storage.getItem(storageKey);
      hasLocalSnapshot = raw !== null;
      if (hasLocalSnapshot) {
        const saved = JSON.parse(raw);
        if (!isObject(saved)) throw Error('本机便签队列格式无效');
        restore(saved);
      }
    } catch (error) { storageError = error.message || String(error); hasLocalSnapshot = true; }
    return { put: put, flush: flush, status: status, pending: pending, snapshot: snapshot, restore: restore,
      restoreFallback: restoreFallback, applyPending: applyPending,
      get storageError() { return storageError; }, get hasLocalSnapshot() { return hasLocalSnapshot; } };
  }
  const api = { create: create };
  root.SB_NOTES_SYNC = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window === 'undefined' ? globalThis : window);
