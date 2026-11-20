'use strict';
const assert = require('node:assert/strict');
const fs = require('./app_source.cjs');
const path = require('node:path');
const vm = require('node:vm');
const { harness, nodes } = require('./test_overview_queue.js');

const section = (key, index) => ({ kind: 'section', id: key, stepKey: key, title: key, index });
const stepNodes = (key, count) => nodes(count).map((n, i) => ({ ...n,
  entry: { ...n.entry, id: key + '-' + i, stepKey: key } }));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function largeStepIdleAndScroll() {
  const h = harness(), api = h.create();
  api.refresh(nodes(1000), true);
  await h.clock.idle('initial visible demand');
  assert.equal(api.stats.generated, 2);
  const loads = h.calls.loads.length, reads = h.indexedDB.reads.length;
  const callbacks = h.clock.executed;
  await h.clock.advance(60000);
  assert.equal(h.calls.loads.length, loads);
  assert.equal(h.clock.executed, callbacks, 'idle large step kept traversing');
  for (const top of [20000, 30000, 40000]) {
    h.scroll.scrollTop = top; h.scroll.dispatch('scroll');
    await h.clock.advance(100);
    assert.equal(h.calls.loads.length, loads, 'cover loaded during scroll');
    assert.equal(h.indexedDB.reads.length, reads, 'disk recall started during scroll');
  }
  await h.clock.idle('latest viewport');
  assert(h.calls.loads.length > loads);
  assert(h.calls.loads.slice(loads).every(id => Number(id.split('-')[1]) > 300), 'old view jobs survived');
  h.assertHealthy(api); api.destroy(); await h.clock.idle('cleanup');
}

async function switchToSmallStep() {
  const gate = deferred();
  const h = harness({ loadGate: entry => entry.id.startsWith('large-') ? gate.promise : undefined });
  const api = h.create(), small = stepNodes('small', 6);
  api.refresh([section('large', 1), ...stepNodes('large', 1000), section('small', 2), ...small,
    section('unvisited', 3), ...stepNodes('unvisited', 6)], true);
  await h.clock.until(() => h.calls.loads.length === 1, 'large in flight');
  assert(api.scrollToStep('small'));
  h.scroll.dispatch('scroll'); gate.resolve();
  await h.clock.idle('small step completion');
  assert.deepEqual([...h.calls.captures].sort(), small.map(n => n.entry.id).sort());
  assert.equal(h.calls.loads.filter(id => id.startsWith('large-')).length, 1);
  assert(!h.calls.loads.some(id => id.startsWith('unvisited-')), 'unseen small step was preloaded');
  assert.equal(h.scroll.scrollTop > 10000, true);
  h.assertHealthy(api); api.destroy(); await h.clock.idle('cleanup');
}

async function bothSizesVisible() {
  const h = harness(), api = h.create();
  api.refresh([section('small', 1), ...stepNodes('small', 6), section('large', 2), ...stepNodes('large', 1000)], true);
  // Last row of the small step and first row of the large one are visible together.
  assert(api.scrollToStep('large'));
  h.scroll.scrollTop -= 160; h.scroll.clientHeight = 450; h.scroll.dispatch('scroll');
  await h.clock.idle('mixed sizes');
  const firstLarge = h.calls.captures.findIndex(id => id.startsWith('large-'));
  assert(firstLarge > 0);
  assert(h.calls.captures.slice(0, firstLarge).every(id => id.startsWith('small-')));
  assert.equal(h.calls.captures.filter(id => id.startsWith('small-')).length, 6);
  assert(h.calls.captures.filter(id => id.startsWith('large-')).length < 10);
  h.assertHealthy(api); api.destroy(); await h.clock.idle('cleanup');
}

async function recycledCardIdentity() {
  const h = harness(), stars = [], opened = [];
  const api = h.create({ onStar: entry => stars.push(entry.id), onOpen: entry => opened.push(entry.id) });
  h.ids.get('btnOverviewPause').onclick();
  api.refresh(nodes(1000), true);
  const oldBoxes = new Set(h.layer.children);
  h.scroll.scrollTop = 40000; h.scroll.dispatch('scroll');
  await h.clock.idle('recycled viewport');
  const reused = h.layer.children.find(box => oldBoxes.has(box));
  assert(reused, 'scroll failed to reuse a card');
  const id = reused.dataset.entryId;
  assert(Number(id.split('-')[1]) > 300);
  reused.querySelector('.cell-actions').children.find(e => e.classList.contains('star')).onclick({ stopPropagation() {} });
  reused.querySelector('.cell-open-3d').dispatch('click');
  assert.deepEqual(stars, [id]); assert.deepEqual(opened, [id]);
  assert(h.layer.children.length < 20);
  api.destroy(); await h.clock.idle('cleanup'); assert.equal(h.urls.size, 0);
}

async function staleLoadCannotEnterMolstar() {
  const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
  const fn = source.slice(source.indexOf('  async function loadEntryInto('), source.indexOf('  async function applyTheme('));
  const gate = deferred(); let current = true, loads = 0;
  const context = vm.createContext({ DOMException, paneRenderConfig: x => x, requireRenderConfig() {},
    ensureEntryLoaded: () => gate.promise, structuresOf: () => [], refKey: x => x,
    alignedRecord: () => null, waitForNewStructure: async () => ({}), rawS: { entries: [] } });
  vm.runInContext(fn, context);
  const result = context.loadEntryInto({ loadStructureFromData: async () => { loads++; } },
    { id: 'old', name: 'old.pdb', data: 'x', format: 'pdb' }, { aligned: false }, () => current);
  current = false; gate.resolve();
  await assert.rejects(result, error => error.name === 'AbortError');
  assert.equal(loads, 0, 'old fetch completion started expensive 3D loading');
}

(async () => {
  const tests = [largeStepIdleAndScroll, switchToSmallStep, bothSizesVisible, recycledCardIdentity, staleLoadCannotEnterMolstar];
  for (const test of tests) { await test(); console.log('PASS ' + test.name); }
  console.log(tests.length + '/'+ tests.length + ' demand scheduling checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
