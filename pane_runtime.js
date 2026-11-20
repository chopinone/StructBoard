/* Stable pane identities, serialized jobs, and pane-owned Viewer lifetimes. */
(function (global, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else global.SB_PANE_RUNTIME = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  let paneSeq = 0, contentSeq = 0;
  const owners = new WeakMap(), versions = new WeakMap(), released = new WeakSet();
  const resourceKeys = new Set(['overlayViewer', 'overlayRefs', 'gridViewers', 'gridCells',
    'gridNodes', 'gridLoadErrors', 'overviewStats', 'lastCamera', 'gridBusy', 'overlaySkipped']);

  function copy(value, seen) {
    if (!value || typeof value !== 'object') return value;
    seen = seen || new Map();
    if (seen.has(value)) return seen.get(value);
    if (value instanceof Set) return new Set(Array.from(value, function (v) { return copy(v, seen); }));
    if (value instanceof Map) return new Map(Array.from(value, function (v) { return [copy(v[0], seen), copy(v[1], seen)]; }));
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) return value;
    const out = Array.isArray(value) ? [] : {};
    seen.set(value, out);
    Object.keys(value).forEach(function (key) { out[key] = copy(value[key], seen); });
    return out;
  }

  function createPane(initial, keys, options) {
    initial = initial || {}; options = options || {};
    const view = {};
    (keys || Object.keys(initial)).forEach(function (key) {
      if (!resourceKeys.has(key)) view[key] = copy(initial[key]);
    });
    Object.assign(view, {
      overlayViewer: null, overlayRefs: [], gridViewers: [], gridCells: [], gridNodes: [],
      gridLoadErrors: [], gridBusy: false, overviewStats: null, lastCamera: null, overlaySkipped: 0,
    });
    const defaults = { gridStack: [], gridPinned: [], gridHoldPlace: false, gridRecommend: null,
      overviewReturn: null, soloFrom: null, lineageReferenceId: null, listNav: null,
      listLimit: 60, listReset: false, listedCount: 0, trashOpen: false,
      trashReturnMode: 'overview', trashReturnPlace: null };
    Object.keys(defaults).forEach(function (key) {
      if (view[key] === undefined) view[key] = copy(defaults[key]);
    });
    // A copied navigation position must not copy an open trash view or a pending layout hold.
    view.trashOpen = false;
    return {
      id: 'pane-' + (++paneSeq), index: options.index == null ? 0 : options.index,
      prefix: options.prefix || '', view: view, disposed: false, life: 1,
      overview: null, el: null, scrollTop: options.scrollTop || 0,
      runtime: { queues: Object.create(null), tokens: Object.create(null), pending: new Set(),
        creating: new Map(), handles: new Map(), resources: new Map(), cleanups: new Set(),
        alignment: new Map(), alignBusy: false, context: null, resizeRaf: 0,
        camera: { syncing: false, raf: 0, pending: null, lastUserAt: 0 }, disposePromise: null },
    };
  }

  function alive(pane) { return !!pane && !pane.disposed; }
  function capture(pane, channel) {
    return { pane: pane, life: pane.life, channel: channel || '', token: pane.runtime.tokens[channel || ''] || 0 };
  }
  function current(pane, ticket) {
    return alive(pane) && (!ticket || (ticket.pane === pane && ticket.life === pane.life &&
      ticket.token === (pane.runtime.tokens[ticket.channel] || 0)));
  }
  function invalidate(pane, channel) {
    if (!pane) return;
    pane.runtime.tokens[channel || ''] = (pane.runtime.tokens[channel || ''] || 0) + 1;
  }
  function begin(pane, channel) { invalidate(pane, channel); return capture(pane, channel); }

  function stateFor(pane, shared, keys) {
    const scoped = keys instanceof Set ? keys : new Set(keys);
    return new Proxy(shared, {
      get: function (target, key) { return scoped.has(key) ? pane.view[key] : target[key]; },
      set: function (target, key, value) {
        if (scoped.has(key)) pane.view[key] = value; else target[key] = value;
        return true;
      },
      has: function (target, key) { return scoped.has(key) || key in target; },
    });
  }

  function track(pane, promise) {
    const task = Promise.resolve(promise);
    pane.runtime.pending.add(task);
    task.then(function () { pane.runtime.pending.delete(task); }, function () { pane.runtime.pending.delete(task); });
    return task;
  }
  function enqueue(pane, channel, work, ticket) {
    if (!alive(pane)) return Promise.resolve();
    const previous = pane.runtime.queues[channel] || Promise.resolve();
    const task = previous.catch(function () {}).then(function () {
      if (!current(pane, ticket)) return;
      return work(ticket || capture(pane, channel));
    });
    pane.runtime.queues[channel] = task;
    return track(pane, task);
  }

  function release(pane, resource) {
    if (!resource) return;
    const owner = owners.get(resource);
    if (owner && owner !== pane) return;
    const dispose = pane.runtime.resources.get(resource);
    pane.runtime.resources.delete(resource);
    for (const [key, value] of pane.runtime.handles) if (value === resource) pane.runtime.handles.delete(key);
    if (released.has(resource)) return;
    released.add(resource);
    try { return dispose ? dispose(resource) : resource.dispose && resource.dispose(); } catch (_) { /* release remaining resources */ }
  }
  function own(pane, resource, dispose) {
    if (!resource) return resource;
    const owner = owners.get(resource);
    if (owner && owner !== pane) throw Error('Viewer already belongs to another pane');
    owners.set(resource, pane);
    pane.runtime.resources.set(resource, dispose || function (value) { return value.dispose && value.dispose(); });
    if (!alive(pane)) {
      const done = release(pane, resource);
      if (done && typeof done.then === 'function') track(pane, Promise.resolve(done).catch(function () {}));
    }
    return resource;
  }
  function ensureResource(pane, key, create, publish) {
    if (!alive(pane)) return Promise.resolve(null);
    if (pane.runtime.handles.has(key)) return Promise.resolve(pane.runtime.handles.get(key));
    if (pane.runtime.creating.has(key)) return pane.runtime.creating.get(key);
    const life = pane.life;
    const task = Promise.resolve().then(function () {
      if (!alive(pane) || pane.life !== life) return null;
      return create();
    }).then(function (resource) {
      if (!resource) return null;
      own(pane, resource);
      if (!alive(pane) || pane.life !== life) { release(pane, resource); return null; }
      pane.runtime.handles.set(key, resource);
      if (publish) publish(resource);
      return resource;
    }).finally(function () {
      if (pane.runtime.creating.get(key) === task) pane.runtime.creating.delete(key);
    });
    pane.runtime.creating.set(key, task);
    return track(pane, task);
  }
  function addCleanup(pane, callback) {
    if (!alive(pane)) { callback(); return function () {}; }
    pane.runtime.cleanups.add(callback);
    return function () { pane.runtime.cleanups.delete(callback); };
  }

  function contentVersion(entry) {
    if (!entry) return 0;
    let hit = versions.get(entry);
    if (!hit || hit.data !== entry.data || hit.parsed !== entry.parsed || hit.format !== entry.format ||
      hit.url !== entry.url || hit.explicit !== entry.contentVersion) {
      hit = { data: entry.data, parsed: entry.parsed, format: entry.format, url: entry.url,
        explicit: entry.contentVersion, version: ++contentSeq };
      versions.set(entry, hit);
    }
    return hit.version;
  }
  function alignmentFor(pane, entry, reference, compute) {
    if (!alive(pane) || !entry || !reference || entry === reference || entry.id === reference.id) return null;
    const key = [reference.id, contentVersion(reference), contentVersion(entry)].join('|');
    const hit = pane.runtime.alignment.get(entry);
    if (hit && hit.key === key) return hit.value;
    const value = compute(entry, reference);
    pane.runtime.alignment.set(entry, { key: key, value: value });
    return value;
  }

  function disposePane(pane) {
    if (!pane) return Promise.resolve();
    if (pane.runtime.disposePromise) return pane.runtime.disposePromise;
    // Invalidate before awaiting anything: the same slot can be reopened immediately.
    pane.disposed = true; pane.life++;
    const controls = pane.runtime.controls;
    try { if (controls && controls.dispose) controls.dispose(); } catch (_) {}
    pane.runtime.cleanups.forEach(function (callback) { try { callback(); } catch (_) {} });
    pane.runtime.cleanups.clear();
    const viewers = new Set([pane.view.overlayViewer]);
    (pane.view.gridCells || []).forEach(function (cell) { viewers.add(cell.viewer); });
    (pane.view.gridViewers || []).forEach(function (cell) { viewers.add(cell.viewer); });
    viewers.forEach(function (viewer) {
      if (viewer && !owners.has(viewer)) {
        owners.set(viewer, pane);
        pane.runtime.resources.set(viewer, function (value) { return value.dispose && value.dispose(); });
      }
    });
    let overviewDone;
    try { overviewDone = pane.overview && pane.overview.destroy && pane.overview.destroy(); }
    catch (_) { /* finish Viewer disposal even if overview teardown failed */ }
    if (overviewDone) track(pane, Promise.resolve(overviewDone).catch(function () {}));
    pane.runtime.disposePromise = (async function () {
      // Creates and queued clear/load work may still be returning. Never dispose beneath them.
      while (pane.runtime.pending.size) await Promise.allSettled(Array.from(pane.runtime.pending));
      await Promise.allSettled(Array.from(pane.runtime.resources.keys(), function (viewer) { return release(pane, viewer); }));
      pane.runtime.handles.clear(); pane.runtime.creating.clear(); pane.runtime.alignment.clear();
      for(const cell of pane.view.gridCells || []) if(cell.box && cell.box.__disposeView)cell.box.__disposeView();
      pane.view.overlayViewer = null; pane.view.overlayRefs = [];
      pane.view.gridCells = []; pane.view.gridViewers = []; pane.view.gridNodes = [];
      pane.view.gridBusy = false; pane.view.lastCamera = null; pane.overview = null; pane.el = null;
    })();
    return pane.runtime.disposePromise;
  }

  return { createPane: createPane, copy: copy, stateFor: stateFor, alive: alive, capture: capture,
    current: current, invalidate: invalidate, begin: begin, track: track, enqueue: enqueue,
    own: own, release: release, ensureResource: ensureResource, addCleanup: addCleanup,
    contentVersion: contentVersion, alignmentFor: alignmentFor, disposePane: disposePane };
});
