'use strict';
// Run: node tools/test_pane_runtime.js
// Exercise the actual pane runtime and pane-bound app functions with controllable async gates.
const assert = require('node:assert/strict');
const fs = require('./app_source.cjs');
const path = require('node:path');
const vm = require('node:vm');
const R = require('../pane_runtime.js');
const app = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const tests = [];
function test(name, work) { tests.push({ name, work }); }
function gate() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
const turn = () => new Promise(resolve => setImmediate(resolve));
const paneKeys = ['mode', 'theme', 'repr', 'referenceId', 'aligned', 'syncCamera', 'page', 'filter',
  'listNav', 'gridStack', 'gridFromOverview', 'overviewReturn', 'gridPinned', 'overlayViewer',
  'overlayRefs', 'gridViewers', 'gridCells', 'lastCamera', 'gridHoldPlace', 'gridLoadErrors',
  'cols', 'rows', 'gridBusy', 'overlaySkipped', 'gridNodes', 'gridParentPage', 'gridDrill'];
function pane(initial = {}, index = 0) {
  return R.createPane(Object.assign({ mode: 'grid', theme: 'per-structure', repr: 'cartoon',
    referenceId: 'ref', aligned: false, syncCamera: true, page: 0 }, initial), paneKeys,
  { index, prefix: index ? 'p2-' : '' });
}
function viewer(name) {
  return { name, disposed: 0, dispose() { this.disposed++; } };
}
function source(name) {
  const match = app.match(new RegExp('^  (?:async )?function ' + name + '\\([^\\n]*\\) \\{[\\s\\S]*?^  \\}', 'm'));
  assert(match, 'Missing app function ' + name);
  return match[0];
}
function appHarness() {
  const shared = { entries: [], metrics: { primary: 'score', higher: true, range: { min: 0, max: 1 } } };
  const panes = [pane(), pane({ theme: 'chain-id' }, 1)];
  const frames = new Map(); let frameSeq = 0;
  const context = vm.createContext({
    PANE_RUNTIME: R, panes, rawS: shared, activePane: 0, scopedPane: null,
    paneAt(value) { return value && value.pane ? value.pane : value && value.runtime ? value : panes[typeof value === 'number' ? value : context.activePane]; },
    paneContext(value) { return R.stateFor(context.paneAt(value), shared, paneKeys); },
    isDarkTheme() { return false; },
    contentFingerprint(text) { return String(text); },
    METRICS: { colorScale(value) { return value * 100; } },
    ALIGN: { compute(ref, mov) { return { rmsd: ref.marker + mov.marker, n: 4, mode: 'ca', marker: ref.marker }; },
      toAlignedPdb(mov, transform) { return 'aligned:' + transform.marker + ':' + mov.marker; } },
    ensureEntryLoaded: async function () {},
    sleep: async function () {},
    requestAnimationFrame(callback) { const id = ++frameSeq; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    performance: { now() { return 1000; } }, console,
  });
  const names = ['paneRenderConfig', 'renderConfigAlive', 'requireRenderConfig', 'alignedRecord',
    'renderMetricColor', 'activeData', 'activeFormat', 'structuresOf', 'refKey', 'waitForNewStructure',
    'loadEntryInto', 'applyTheme', 'allViewers', 'cameraSnapshot', 'cameraFingerprint',
    'applyCameraSnapshot', 'broadcastCamera', 'attachCameraSync', 'syncAllCameras'];
  vm.runInContext(names.map(source).join('\n') + '\nglobalThis.api = { ' + names.join(',') + ' };', context);
  return { context, shared, panes, api: context.api,
    flushFrames() { const callbacks = Array.from(frames.values()); frames.clear(); callbacks.forEach(callback => callback()); } };
}

test('copied pane navigation is deep and Viewer resources are fresh', async function () {
  const old = pane({ listNav: { stepKey: 'a', nested: { path: ['root'] } },
    gridStack: [{ id: 'folder', page: 2 }], gridFromOverview: { depth: 2 },
    overviewReturn: { drillStack: [{ id: 'step' }], selection: ['a'] }, gridPinned: ['a'], gridHoldPlace: true });
  old.view.overlayViewer = viewer('overlay'); old.view.overlayRefs.push({ id: 'a' });
  old.view.gridCells.push({ viewer: viewer('grid') }); old.view.gridViewers.push(old.view.gridCells[0]);
  const fresh = R.createPane(old.view, paneKeys, { index: 1, prefix: 'p2-' });
  fresh.view.listNav.nested.path.push('child'); fresh.view.gridStack[0].page = 7;
  fresh.view.overviewReturn.drillStack[0].id = 'other'; fresh.view.gridPinned.push('b');
  assert.deepEqual(old.view.listNav.nested.path, ['root']);
  assert.equal(old.view.gridStack[0].page, 2);
  assert.equal(old.view.overviewReturn.drillStack[0].id, 'step');
  assert.deepEqual(old.view.gridPinned, ['a']);
  assert.equal(fresh.view.overlayViewer, null);
  assert.deepEqual(fresh.view.gridCells, []); assert.deepEqual(fresh.view.gridViewers, []);
  assert.deepEqual(fresh.view.overlayRefs, []); assert.equal(fresh.view.lastCamera, null);
  assert.notEqual(old.id, fresh.id); assert.notEqual(old.runtime, fresh.runtime);
  await R.disposePane(old); await R.disposePane(fresh);
});

test('queued job retains pane context while focus and another queue change', async function () {
  const shared = { entries: [{ id: 'shared' }] }, left = pane(), right = pane({ page: 8 }, 1);
  const leftS = R.stateFor(left, shared, paneKeys), rightS = R.stateFor(right, shared, paneKeys);
  const started = gate(), resume = gate(); let focus = left;
  const ticket = R.begin(left, 'grid');
  const task = R.enqueue(left, 'grid', async function () {
    started.resolve(); await resume.promise;
    if (R.current(left, ticket)) { leftS.page = 3; leftS.gridLoadErrors.push({ entryId: 'left' }); }
  }, ticket);
  await started.promise; focus = right;
  const other = R.enqueue(right, 'grid', async function () { rightS.page = 9; }, R.begin(right, 'grid'));
  await other; resume.resolve(); await task;
  assert.equal(focus, right); assert.equal(leftS.page, 3); assert.equal(rightS.page, 9);
  assert.deepEqual(rightS.gridLoadErrors, []); assert.equal(leftS.entries, rightS.entries);
  await Promise.all([R.disposePane(left), R.disposePane(right)]);
});

test('same-pane queue serializes mutations and rejects a stale generation', async function () {
  const p = pane(), started = gate(), finish = gate(), events = [];
  const oldTicket = R.begin(p, 'grid');
  const old = R.enqueue(p, 'grid', async function () {
    events.push('load-start'); started.resolve(); await finish.promise;
    if (R.current(p, oldTicket)) events.push('old-publish'); events.push('load-end');
  }, oldTicket);
  await started.promise;
  const fresh = R.enqueue(p, 'grid', async function () { events.push('new-start'); }, R.begin(p, 'grid'));
  await turn(); assert.deepEqual(events, ['load-start']);
  finish.resolve(); await Promise.all([old, fresh]);
  assert.deepEqual(events, ['load-start', 'load-end', 'new-start']);
  await R.disposePane(p);
});

test('close invalidates immediately and reopen cannot receive old load publication', async function () {
  const old = pane({}, 1), loaded = viewer('loaded'), started = gate(), finish = gate(), destroyed = gate();
  let cleanup = 0, controls = 0, destroyCalls = 0, published = 0;
  R.own(old, loaded); old.view.gridCells.push({ viewer: loaded });
  old.runtime.controls = { dispose() { controls++; } };
  R.addCleanup(old, function () { cleanup++; });
  old.overview = { destroy() { destroyCalls++; return destroyed.promise; } };
  const ticket = R.begin(old, 'grid');
  const task = R.enqueue(old, 'grid', async function () {
    started.resolve(); await finish.promise;
    if (R.current(old, ticket)) { old.view.gridViewers.push({ viewer: loaded }); published++; }
  }, ticket);
  await started.promise;
  const closing = R.disposePane(old), reopened = pane({}, 1);
  assert(old.disposed); assert.equal(R.current(old, ticket), false);
  assert.equal(cleanup, 1); assert.equal(controls, 1); assert.equal(destroyCalls, 1);
  assert.equal(loaded.disposed, 0, 'load must return before Viewer disposal');
  assert.notEqual(old.id, reopened.id); assert.notEqual(old.runtime, reopened.runtime);
  finish.resolve(); await task; await turn();
  assert.equal(loaded.disposed, 0, 'overview destroy also participates in teardown');
  destroyed.resolve(); await closing; await R.disposePane(old);
  assert.equal(loaded.disposed, 1); assert.equal(controls, 1); assert.equal(published, 0);
  assert.deepEqual(reopened.view.gridViewers, []);
  await R.disposePane(reopened);
});

test('pending create is single-flight and releases only the old pane Viewer', async function () {
  const old = pane({}, 1), creation = gate(), started = gate(), stale = viewer('stale');
  let calls = 0, published = 0;
  const create = function () { calls++; started.resolve(); return creation.promise; };
  const a = R.ensureResource(old, 'overlay', create, function (v) { old.view.overlayViewer = v; published++; });
  const b = R.ensureResource(old, 'overlay', create);
  assert.equal(a, b); await started.promise;
  const closing = R.disposePane(old), fresh = pane({}, 1), current = viewer('current');
  await R.ensureResource(fresh, 'overlay', async function () { return current; }, function (v) { fresh.view.overlayViewer = v; });
  creation.resolve(stale); assert.equal(await a, null); await closing;
  assert.equal(calls, 1); assert.equal(published, 0); assert.equal(stale.disposed, 1);
  assert.equal(fresh.view.overlayViewer, current); assert.equal(current.disposed, 0);
  assert.throws(function () { R.own(fresh, stale); }, /another pane/);
  await R.disposePane(fresh); assert.equal(current.disposed, 1);
});

test('dispose releases the whole hidden grid pool, overlay, and no other owner', async function () {
  const left = pane(), right = pane({}, 1), visible = viewer('visible'), hidden = viewer('hidden'), overlay = viewer('overlay'), foreign = viewer('foreign');
  R.own(left, visible); R.own(left, hidden); R.own(left, overlay); R.own(right, foreign);
  left.view.gridCells = [{ viewer: visible }, { viewer: hidden }];
  left.view.gridViewers = [{ viewer: visible }]; left.view.overlayViewer = overlay;
  assert.throws(function () { R.own(left, foreign); }, /another pane/);
  await R.disposePane(left);
  for (const v of [visible, hidden, overlay]) assert.equal(v.disposed, 1);
  assert.equal(foreign.disposed, 0); R.release(right, visible); assert.equal(visible.disposed, 1);
  await R.disposePane(right); assert.equal(foreign.disposed, 1);
});

test('alignment cache follows pane, reference identity, and content versions', async function () {
  const left = pane(), right = pane({}, 1), entry = { id: 'a', data: 'raw', parsed: {} }, ref = { id: 'r', data: 'ref', parsed: {} };
  let calls = 0;
  const compute = function () { return { data: 'aligned-' + (++calls) }; };
  const one = R.alignmentFor(left, entry, ref, compute);
  assert.equal(R.alignmentFor(left, entry, ref, compute), one); assert.equal(calls, 1);
  assert.notEqual(R.alignmentFor(right, entry, ref, compute), one); assert.equal(calls, 2);
  entry.data = 'raw2'; R.alignmentFor(left, entry, ref, compute); assert.equal(calls, 3);
  ref.parsed = {}; R.alignmentFor(left, entry, ref, compute); assert.equal(calls, 4);
  ref.contentVersion = 2; R.alignmentFor(left, entry, ref, compute); assert.equal(calls, 5);
  assert.equal(entry.data, 'raw2'); assert.equal(entry.alignedData, undefined);
  await Promise.all([R.disposePane(left), R.disposePane(right)]);
});

test('actual loadEntryInto and applyTheme keep pane/config after deferred focus switch', async function () {
  const h = appHarness(), left = h.panes[0], right = h.panes[1], started = gate(), resume = gate();
  const entry = { id: 'model', name: 'Model', data: 'original', format: 'pdb', parsed: { marker: 2 }, color: 0x123456 };
  const ref = { id: 'ref', data: 'reference', parsed: { marker: 1 } }; h.shared.entries = [ref, entry];
  const refs = [], loads = [], themes = [];
  h.context.ensureEntryLoaded = async function (e) { if (e === entry) { started.resolve(); await resume.promise; } };
  const v = { plugin: { managers: { structure: { hierarchy: { current: { structures: refs } }, component: {
    async updateRepresentationsTheme(components, theme) { themes.push(theme.color); },
  } } } },
  async loadStructureFromData(data) { loads.push(data); refs.push({ cell: { transform: { ref: String(refs.length) } }, components: [{}] }); } };
  const config = h.api.paneRenderConfig(left), task = h.api.loadEntryInto(v, entry, config);
  await started.promise; h.context.activePane = 1; right.view.aligned = true; resume.resolve();
  const loaded = await task; await h.api.applyTheme(v, [{ id: entry.id, ref: loaded, color: entry.color }], config);
  assert.deepEqual(loads, ['original']); assert.deepEqual(themes, ['uniform']);
  left.view.aligned = true; const aligned = h.api.paneRenderConfig(left);
  assert.equal(h.api.activeData(entry, aligned), 'aligned:1:2');
  assert.equal(h.api.activeData(entry, h.api.paneRenderConfig(Object.assign(right, { view: Object.assign(right.view, { aligned: false }) }))), 'original');
  assert.equal(entry.alignedData, undefined);
  await Promise.all(h.panes.map(R.disposePane));
});

test('actual camera subscriptions keep owner pane across focus and stop on disposal', async function () {
  const h = appHarness(), p = h.panes[0]; p.view.mode = 'grid';
  function cameraViewer(name) {
    const listeners = new Set(), state = { snapshot: { position: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0], radius: 2 } }, applied = [];
    const cam = { getSnapshot() { return state.snapshot; }, setState(value) { applied.push(value); },
      changed: { subscribe(fn) { listeners.add(fn); return { unsubscribe() { listeners.delete(fn); } }; } } };
    return { name, state, applied, listeners, plugin: { canvas3d: { camera: cam } }, dispose() {}, emit() { listeners.forEach(fn => fn()); } };
  }
  const a = cameraViewer('a'), b = cameraViewer('b');
  R.own(p, a); R.own(p, b);
  p.view.gridCells = [a, b].map(function (v, i) { return { viewer: v, ref: {}, entryId: String(i), loadedEntryId: String(i), box: { style: { display: '' } } }; });
  p.view.gridViewers = p.view.gridCells;
  h.api.attachCameraSync(a, p); a.emit(); h.context.activePane = 1;
  a.state.snapshot = { position: [1, 2, 12], target: [0, 0, 0], up: [0, 1, 0], radius: 3 }; a.emit();
  h.flushFrames(); assert.equal(b.applied.length, 1); assert.equal(p.view.lastCamera.radius, 3);
  assert.equal(h.panes[1].view.lastCamera, null);
  await R.disposePane(p); assert.equal(a.listeners.size, 0);
  a.emit(); h.flushFrames(); assert.equal(b.applied.length, 1);
  await R.disposePane(h.panes[1]);
});

test('unregistered legacy pool resources also wait for a returning load', async function () {
  const p = pane(), v = viewer('legacy-hidden'), started = gate(), finish = gate();
  p.view.gridCells = [{ viewer: v }];
  const load = R.enqueue(p, 'grid', async function () { started.resolve(); await finish.promise; });
  await started.promise; const done = R.disposePane(p);
  assert.equal(v.disposed, 0); finish.resolve(); await load; await done; assert.equal(v.disposed, 1);
});

test('failed creation retries and asynchronous resource teardown is awaited', async function () {
  const p = pane(), disposal = gate(), v = viewer('async');
  await assert.rejects(R.ensureResource(p, 'overlay', async function () { throw Error('create failed'); }), /create failed/);
  assert.equal(p.runtime.creating.size, 0);
  await R.ensureResource(p, 'overlay', async function () { return v; });
  R.own(p, v, function () { v.disposed++; return disposal.promise; });
  let finished = false; const done = R.disposePane(p).then(function () { finished = true; });
  await turn(); assert.equal(v.disposed, 1); assert.equal(finished, false);
  disposal.resolve(); await done; assert.equal(finished, true);
});

test('actual loadEntryInto refuses a stale pane after a deferred read', async function () {
  const h = appHarness(), started = gate(), resume = gate(), old = h.panes[1];
  const entry = { id: 'model', name: 'Model', data: 'raw', format: 'pdb' }; let loads = 0;
  h.context.ensureEntryLoaded = async function () { started.resolve(); await resume.promise; };
  const v = { async loadStructureFromData() { loads++; } };
  const load = h.api.loadEntryInto(v, entry, h.api.paneRenderConfig(old));
  await started.promise; await R.disposePane(old); h.panes[1] = pane({}, 1); resume.resolve();
  await assert.rejects(load, /cancelled/); assert.equal(loads, 0);
  await Promise.all(h.panes.map(R.disposePane));
});

function gridHarness() {
  const h = appHarness(), nodes = new Map(), publications = [], creates = [];
  h.panes.forEach(function (p) { p.view.cols = 1; p.view.rows = 1; p.view.gridBusy = false; });
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, { className: '', hidden: false, disabled: false, style: {},
      setAttribute(name, value) { this[name] = value; } });
    return nodes.get(id);
  }
  const emptyCell = () => ({ viewer: null, loadedEntryId: null, ref: null, node: null,
    box: { style: { display: '' } }, container: { style: {} }, message: {}, audit: {}, folderNote: {} });
  Object.assign(h.context, {
    withPaneSync(p, fn) {
      const previous = h.context.scopedPane; h.context.scopedPane = p;
      try { return fn(); } finally { h.context.scopedPane = previous; }
    },
    paneAt(value) { return value && value.pane ? value.pane : value && value.runtime ? value : h.panes[typeof value === 'number' ? value : h.context.activePane]; },
    paneContext(value) { return R.stateFor(h.context.paneAt(value), h.shared, paneKeys); },
    paneElement(p, id) { return node(p.id + ':' + id); },
    updateGridGeometry() {}, arrangeGridCells() {},
    gridLayer() { return { nodes: h.shared.entries.map(entry => ({ kind: 'entry', entry })), folder: null }; },
    pageSize() { return 1; },
    ensureGridCells(n) { const p = h.context.scopedPane; while (p.view.gridCells.length < n) p.view.gridCells.push(emptyCell()); },
    LINEAGE: { summarize(entries) { return entries; }, countText(entries) { return String(entries.length); } },
    refreshGridHeaders() {}, refreshBadge() {}, updateGridAudit() {}, status() {},
    setTimeout() { return 0; }, canvasBg() { return '#ffffff'; }, attachCameraSync() {},
    clearViewer: async function () {},
    applyTheme: async function () {}, applyExtraRepresentation: async function () {}, resetCamera: async function () {},
    syncAllCameras(force, p) { publications.push(p.id); },
    gridNodeEntry(n) { return n.entry; },
    createViewer: async function () {
      const v = viewer('grid-' + creates.length);
      v.plugin = { animationLoop: { start() {}, stop() {} }, canvas3d: { setProps() {} } };
      v.handleResize = function () {}; creates.push(v); return v;
    },
  });
  vm.runInContext(source('rebuildGrid') + '\n' + source('rebuildGridInPane') + '\nglobalThis.rebuild = rebuildGrid;', h.context);
  h.context.loadEntryInto = async function (v, entry) { return { id: entry.id, components: [] }; };
  h.shared.entries = [{ id: 'model', name: 'Model', color: 1 }];
  return Object.assign(h, { publications, creates });
}

test('actual grid rebuild publishes to its captured pane after deferred load/focus switch', async function () {
  const h = gridHarness(), p = h.panes[0], started = gate(), finish = gate();
  h.context.loadEntryInto = async function () { started.resolve(); await finish.promise; return { components: [] }; };
  const task = h.context.rebuild(p); await started.promise; h.context.activePane = 1; finish.resolve(); await task;
  assert.equal(p.view.gridViewers.length, 1); assert.equal(h.panes[1].view.gridViewers.length, 0);
  assert.deepEqual(h.publications, [p.id]); assert.equal(p.view.gridBusy, false);
  await Promise.all(h.panes.map(R.disposePane)); assert.equal(h.creates[0].disposed, 1);
});

test('actual grid close/reopen during Viewer creation disposes only the retired create', async function () {
  const h = gridHarness(), old = h.panes[1], started = gate(), finish = gate(), stale = viewer('old-create');
  h.context.createViewer = async function () { started.resolve(); await finish.promise; return stale; };
  const task = h.context.rebuild(old); await started.promise;
  const closing = R.disposePane(old), fresh = pane({}, 1); h.panes[1] = fresh;
  finish.resolve(); await task; await closing;
  assert.equal(stale.disposed, 1); assert.deepEqual(fresh.view.gridCells, []);
  assert.deepEqual(fresh.view.gridViewers, []); assert.deepEqual(h.publications, []);
  await Promise.all(h.panes.map(R.disposePane));
});

test('actual grid close/reopen waits for old load and publishes no refs into fresh pane', async function () {
  const h = gridHarness(), old = h.panes[1], started = gate(), finish = gate();
  h.context.loadEntryInto = async function () { started.resolve(); await finish.promise; return { components: [] }; };
  const task = h.context.rebuild(old); await started.promise;
  const oldViewer = old.view.gridCells[0].viewer, closing = R.disposePane(old), fresh = pane({}, 1); h.panes[1] = fresh;
  assert.equal(oldViewer.disposed, 0); finish.resolve(); await task; await closing;
  assert.equal(oldViewer.disposed, 1); assert.deepEqual(fresh.view.gridViewers, []);
  assert.deepEqual(h.publications, []); await Promise.all(h.panes.map(R.disposePane));
});

(async function () {
  for (const item of tests) { await item.work(); console.log('ok - ' + item.name); }
  console.log('pane runtime ok (' + tests.length + ' behavior tests)');
})().catch(function (error) { console.error(error); process.exitCode = 1; });
