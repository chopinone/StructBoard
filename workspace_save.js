/* Versioned workspace snapshots; the session store owns the transaction queue. */
(function (root) {
  'use strict';
  function create(options) {
    const store = options.store, snapshot = options.snapshot;
    const later = options.setTimeout || setTimeout, cancel = options.clearTimeout || clearTimeout;
    const now = options.now || Date.now;
    const normalDelay = options.normalDelay == null ? 600 : options.normalDelay;
    const quietDelay = options.quietDelay == null ? 2500 : options.quietDelay;
    const maxWait = options.maxWait == null ? 3000 : options.maxWait;
    const successMs = options.successMs == null ? 2000 : options.successMs;
    const maxRetries = options.maxRetries == null ? 2 : options.maxRetries;
    let version = 0, committedVersion = 0, visibleVersion = 0, epoch = 0;
    let timer = 0, idleTimer = 0, deadline = Infinity, dirtySince = null, inFlight = null;
    let error = '', state = 'idle', attempts = 0;
    function paint(next, message) {
      state = next;
      if (options.onState) options.onState(next, message || '');
    }
    function stopIdle() { cancel(idleTimer); idleTimer = 0; }
    function saved() {
      stopIdle(); paint('saved');
      const currentEpoch = epoch;
      idleTimer = later(function () {
        idleTimer = 0;
        if (epoch === currentEpoch && state === 'saved') paint('idle');
      }, successMs);
    }
    function report(failure) {
      const message = failure && failure.message ? failure.message : String(failure);
      const changed = error !== message;
      error = message; stopIdle(); paint('error', error);
      if (changed && options.onError) options.onError(message);
    }
    function arm() {
      cancel(timer); timer = 0;
      if (inFlight || deadline === Infinity || version <= committedVersion) return;
      timer = later(function () { timer = 0; run(); }, Math.max(0, deadline - now()));
    }
    function schedule(settings) {
      const quiet = !!(settings && settings.quiet), time = now();
      version++;
      if (dirtySince === null) dirtySince = time;
      // A quiet edit can join a normal save, but can never move its deadline.
      deadline = Math.min(deadline, time + (quiet ? quietDelay : normalDelay), dirtySince + maxWait);
      if (attempts > maxRetries) attempts = 0;
      if (!quiet) {
        visibleVersion = version; stopIdle();
        // Keep a real failure visible until a transaction actually succeeds.
        if (!error) paint('saving');
      }
      arm();
      return version;
    }
    function run() {
      if (inFlight) return inFlight;
      if (version <= committedVersion) return Promise.resolve(true);
      cancel(timer); timer = 0; deadline = Infinity; dirtySince = null;
      const batchVersion = version, batchEpoch = epoch;
      const task = Promise.resolve().then(async function () {
        // clear() may have invalidated this microtask before it took a snapshot.
        if (batchEpoch !== epoch) return false;
        try {
          const value = snapshot();
          if (options.empty && options.empty(value)) await store.clear();
          else await store.save(value);
          if (batchEpoch !== epoch) return false;
          committedVersion = Math.max(committedVersion, batchVersion);
          const hadError = !!error || !!(options.hasError && options.hasError());
          error = ''; attempts = 0;
          if (options.onCommit) options.onCommit(value, batchVersion);
          if (visibleVersion > committedVersion) {
            stopIdle(); paint('saving');
          } else if (visibleVersion || hadError || state === 'saving' || state === 'error') {
            visibleVersion = 0; saved();
          }
          return true;
        } catch (failure) {
          if (batchEpoch !== epoch) return false;
          attempts++; report(failure);
          if (attempts <= maxRetries) {
            const retryAt = now() + Math.min(8000, 1000 * Math.pow(2, attempts - 1));
            deadline = Math.min(deadline, retryAt);
          }
          return false;
        }
      });
      inFlight = task;
      const done = function () {
        if (inFlight !== task) return;
        inFlight = null;
        arm();
      };
      task.then(done, done);
      return task;
    }
    async function flush() {
      // Include edits received during the active transaction. Stop on failure:
      // the bounded retry timer remains responsible for subsequent attempts.
      const currentEpoch = epoch;
      while (currentEpoch === epoch) {
        if (inFlight) {
          const accepted = await inFlight;
          if (!accepted || currentEpoch !== epoch) return false;
        } else if (version > committedVersion) {
          if (!await run()) return false;
        } else return true;
      }
      return false;
    }
    function persistImport(value, before, check) {
      if (inFlight || version > committedVersion) throw Error('工作区有新的编辑，请重试导入');
      const startingVersion = version, startingEpoch = epoch;
      const write = store.save(value, { beforeImport: before, check: function () {
        check();
        if (startingVersion !== version || startingEpoch !== epoch) throw Error('工作区有新的编辑，请重试导入');
      } });
      const task = write.then(function () { return true; }, function () { return false; });
      inFlight = task;
      task.then(function () { if (inFlight === task) { inFlight = null; arm(); } });
      return write;
    }
    function clear() {
      epoch++; version++; visibleVersion = 0; attempts = 0;
      cancel(timer); timer = 0; deadline = Infinity; dirtySince = null; stopIdle();
      const clearEpoch = epoch, clearVersion = version;
      // Enqueue immediately, behind any save already owned by session_store.
      // Its stale completion cannot publish success, errors, or last-session metadata.
      let pending;
      try { pending = Promise.resolve(store.clear()); }
      catch (failure) { pending = Promise.reject(failure); }
      const task = pending.then(function () {
        if (clearEpoch !== epoch) return false;
        committedVersion = Math.max(committedVersion, clearVersion);
        error = '';
        if (visibleVersion > committedVersion) paint('saving');
        else paint('idle');
        return true;
      }, function (failure) {
        if (clearEpoch === epoch) report(failure);
        return false;
      });
      inFlight = task;
      const done = function () { if (inFlight === task) { inFlight = null; arm(); } };
      task.then(done, done);
      return task;
    }
    return { schedule: schedule, flush: flush, clear: clear, persistImport: persistImport,
      get version() { return version; }, get committedVersion() { return committedVersion; },
      get visibleDebt() { return visibleVersion > committedVersion; },
      get deadline() { return deadline; }, get inFlight() { return inFlight; },
      get epoch() { return epoch; }, get state() { return state; }, get error() { return error; } };
  }
  const api = { create: create };
  root.SB_WORKSPACE_SAVE = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window === 'undefined' ? globalThis : window);
